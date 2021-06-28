const got = require(`got`)
const _ = require(`lodash`)
const urlJoin = require(`url-join`)
import HttpAgent from "agentkeepalive"
// const http2wrapper = require(`http2-wrapper`)

const { HttpsAgent } = HttpAgent

const { setOptions, getOptions } = require(`./plugin-options`)

const {
  nodeFromData,
  downloadFile,
  isFileNode,
  createNodeIdWithVersion,
} = require(`./normalize`)
const { handleReferences, handleWebhookUpdate } = require(`./utils`)

const agent = {
  http: new HttpAgent(),
  https: new HttpsAgent(),
  // http2: new http2wrapper.Agent(),
}

let lastReport = 0
const REPORT_EVERY_N = 1000
async function worker([url, options]) {
  const result = await got(url, {
    agent,
    cache: false,
    // request: http2wrapper.auto,
    // http2: true,
    ...options,
  })
  const remainingRequests = requestQueue.length()
  if (Math.abs(lastReport - remainingRequests) >= REPORT_EVERY_N) {
    console.log(`Fetching: ${url} (${remainingRequests} requests remaining)`)
    lastReport = remainingRequests
  }
  return result
}

const requestQueue = require(`fastq`).promise(worker, 20)
const asyncPool = require(`tiny-async-pool`)
const bodyParser = require(`body-parser`)

function gracefullyRethrow(activity, error) {
  // activity.panicOnBuild was implemented at some point in gatsby@2
  // but plugin can still be used with older version of gatsby core
  // so need to do some checking here
  if (activity.panicOnBuild) {
    activity.panicOnBuild(error)
  }

  activity.end()

  if (!activity.panicOnBuild) {
    throw error
  }
}

exports.onPreBootstrap = (_, pluginOptions) => {
  setOptions(pluginOptions)
}

exports.sourceNodes = async (
  {
    actions,
    store,
    cache,
    createNodeId,
    createContentDigest,
    getCache,
    getNode,
    getNodes,
    parentSpan,
    reporter,
    webhookBody,
  },
  pluginOptions
) => {
  const {
    baseUrl,
    apiBase = `jsonapi`,
    basicAuth = {},
    filters,
    headers = {},
    params = {},
    concurrentFileRequests = 20,
    concurrentAPIRequests = 20,
    disallowedLinkTypes = [
      `self`,
      `describedby`,
      `contact_message--feedback`,
      `contact_message--personal`,
    ],
    skipFileDownloads = false,
    fastBuilds = false,
    entityReferenceRevisions = [],
    languageConfig = {
      defaultLanguage: `und`,
      enabledLanguages: [`und`],
      translatableEntities: [],
    },
    useAuthOn = [],
  } = pluginOptions
  const { createNode, setPluginStatus, touchNode } = actions

  // Update the concurrency limit from the plugin options
  requestQueue.concurrency = concurrentAPIRequests

  if (typeof basicAuth.username === 'string' && typeof basicAuth.password === 'string') {
    headers['Authorization'] = `Basic ${Buffer.from(`${basicAuth.username}:${basicAuth.password}`).toString('base64')}`
  }

  if (webhookBody && Object.keys(webhookBody).length) {
    const changesActivity = reporter.activityTimer(
      `loading Drupal content changes`,
      {
        parentSpan,
      }
    )
    changesActivity.start()

    try {
      const { secret, action, id, data } = webhookBody
      if (pluginOptions.secret && pluginOptions.secret !== secret) {
        reporter.warn(
          `The secret in this request did not match your plugin options secret.`
        )
        changesActivity.end()
        return
      }
      if (action === `delete`) {
        actions.deleteNode(getNode(createNodeId(id)))
        reporter.log(`Deleted node: ${id}`)
        changesActivity.end()
        return
      }

      let nodesToUpdate = data
      if (!Array.isArray(data)) {
        nodesToUpdate = [data]
      }

      for (const nodeToUpdate of nodesToUpdate) {
        await handleWebhookUpdate(
          {
            nodeToUpdate,
            actions,
            cache,
            createNodeId,
            createContentDigest,
            getCache,
            getNode,
            reporter,
            store,
            languageConfig,
          },
          pluginOptions
        )
      }
    } catch (e) {
      gracefullyRethrow(changesActivity, e)
      return
    }
    changesActivity.end()
    return
  }

  if (fastBuilds) {
    const lastFetched =
      store.getState().status.plugins?.[`gatsby-source-drupal`]?.lastFetched ??
      0

    const drupalFetchIncrementalActivity = reporter.activityTimer(
      `Fetch incremental changes from Drupal`
    )
    let requireFullRebuild = false

    drupalFetchIncrementalActivity.start()

    try {
      // Hit fastbuilds endpoint with the lastFetched date.
      const res = await requestQueue.push([
        urlJoin(baseUrl, `gatsby-fastbuilds/sync/`, lastFetched.toString()),
        {
          headers,
          searchParams: params,
          responseType: `json`,
        },
      ])

      // Fastbuilds returns a -1 if:
      // - the timestamp has expired
      // - if old fastbuild logs were purged
      // - it's been a really long time since you synced so you just do a full fetch.
      if (res.body.status === -1) {
        // The incremental data is expired or this is the first fetch.
        reporter.info(`Unable to pull incremental data changes from Drupal`)
        setPluginStatus({ lastFetched: res.body.timestamp })
        requireFullRebuild = true
      } else {
        // Touch nodes so they are not garbage collected by Gatsby.
        getNodes().forEach(node => {
          if (node.internal.owner === `gatsby-source-drupal`) {
            touchNode(node)
          }
        })

        // Process sync data from Drupal.
        const nodesToSync = res.body.entities
        for (const nodeSyncData of nodesToSync) {
          if (nodeSyncData.action === `delete`) {
            actions.deleteNode(
              getNode(
                createNodeId(
                  createNodeIdWithVersion(
                    nodeSyncData.id,
                    nodeSyncData.type,
                    getOptions().languageConfig
                      ? nodeSyncData.attributes.langcode
                      : `und`,
                    nodeSyncData.attributes?.drupal_internal__revision_id,
                    entityReferenceRevisions
                  )
                )
              )
            )
          } else {
            // The data could be a single Drupal entity or an array of Drupal
            // entities to update.
            let nodesToUpdate = nodeSyncData.data
            if (!Array.isArray(nodeSyncData.data)) {
              nodesToUpdate = [nodeSyncData.data]
            }

            for (const nodeToUpdate of nodesToUpdate) {
              await handleWebhookUpdate(
                {
                  nodeToUpdate,
                  actions,
                  cache,
                  createNodeId,
                  createContentDigest,
                  getCache,
                  getNode,
                  reporter,
                  store,
                  languageConfig,
                },
                pluginOptions
              )
            }
          }
        }

        setPluginStatus({ lastFetched: res.body.timestamp })
      }
    } catch (e) {
      gracefullyRethrow(drupalFetchIncrementalActivity, e)
      return
    }

    drupalFetchIncrementalActivity.end()

    if (!requireFullRebuild) {
      return
    }
  }

  const drupalFetchActivity = reporter.activityTimer(
    `Fetch all data from Drupal`
  )

  // Fetch articles.
  reporter.info(`Starting to fetch all data from Drupal`)

  drupalFetchActivity.start()

  const listResponse = await requestQueue.push([
    urlJoin(baseUrl, 'gatsby/content-list'),
    {
      headers,
    }
  ])
  const listResponseBody = JSON.parse(listResponse.body)
    
  const requestPromises = []
  for (let entityTypeAndBundle in listResponseBody) {
    if (disallowedLinkTypes.indexOf(entityTypeAndBundle) !== -1) continue
    const isTranslatable = languageConfig.translatableEntities.indexOf(entityTypeAndBundle) !== -1
    const shouldUseAuth = useAuthOn.indexOf(entityTypeAndBundle) !== -1
    const [entityType, entityBundle] = entityTypeAndBundle.split('--')

    for (let entityUuid of listResponseBody[entityTypeAndBundle]) {
      requestPromises.push(
        requestQueue.push([
          urlJoin(baseUrl, apiBase, `/${entityType}/${entityBundle}/${entityUuid}`),
          {
            headers: shouldUseAuth ? headers : undefined,
          }
        ]).then(response => JSON.parse(response.body).data).catch(() => {})
      )

      if (isTranslatable) {
        for (let language of languageConfig.enabledLanguages) {
          if (language !== languageConfig.defaultLanguage) {
            requestPromises.push(
              requestQueue.push([
                urlJoin(baseUrl, language, apiBase, `/${entityType}/${entityBundle}/${entityUuid}`),
                {
                  headers: shouldUseAuth ? headers : undefined
                }
              ]).then(response => JSON.parse(response.body).data).catch(() => {})
            )
          }
        }
      }
    }
  }

  const allData = await Promise.all(requestPromises)

  drupalFetchActivity.end()

  const nodes = new Map()

  // first pass - create basic nodes
  _.each(allData, datum => {
    if (!datum) return
    const node = nodeFromData(datum, createNodeId, entityReferenceRevisions)
    nodes.set(node.id, node)
  })

  // second pass - handle relationships and back references
  nodes.forEach(node => {
    handleReferences(node, {
      getNode: nodes.get.bind(nodes),
      createNodeId,
      entityReferenceRevisions,
    })
  })

  if (skipFileDownloads) {
    reporter.info(`Skipping remote file download from Drupal`)
  } else {
    reporter.info(`Downloading remote files from Drupal`)

    // Download all files (await for each pool to complete to fix concurrency issues)
    const fileNodes = [...nodes.values()].filter(isFileNode)

    if (fileNodes.length) {
      const downloadingFilesActivity = reporter.activityTimer(
        `Remote file download`
      )
      downloadingFilesActivity.start()
      try {
        await asyncPool(concurrentFileRequests, fileNodes, async node => {
          await downloadFile(
            {
              node,
              store,
              cache,
              createNode,
              createNodeId,
              getCache,
              reporter,
            },
            pluginOptions
          )
        })
      } catch (e) {
        gracefullyRethrow(downloadingFilesActivity, e)
        return
      }
      downloadingFilesActivity.end()
    }
  }

  // Create each node
  for (const node of nodes.values()) {
    node.internal.contentDigest = createContentDigest(node)
    createNode(node)
  }

  return
}

// This is maintained for legacy reasons and will eventually be removed.
exports.onCreateDevServer = (
  {
    app,
    createNodeId,
    getNode,
    actions,
    store,
    cache,
    createContentDigest,
    getCache,
    reporter,
  },
  pluginOptions
) => {
  app.use(
    `/___updatePreview/`,
    bodyParser.text({
      type: `application/json`,
    }),
    async (req, res) => {
      console.warn(
        `The ___updatePreview callback is now deprecated and will be removed in the future. Please use the __refresh callback instead.`
      )
      if (!_.isEmpty(req.body)) {
        const requestBody = JSON.parse(JSON.parse(req.body))
        const { secret, action, id } = requestBody
        if (pluginOptions.secret && pluginOptions.secret !== secret) {
          return reporter.warn(
            `The secret in this request did not match your plugin options secret.`
          )
        }
        if (action === `delete`) {
          actions.deleteNode(getNode(createNodeId(id)))
          return reporter.log(`Deleted node: ${id}`)
        }
        const nodeToUpdate = JSON.parse(JSON.parse(req.body)).data
        return await handleWebhookUpdate(
          {
            nodeToUpdate,
            actions,
            cache,
            createNodeId,
            createContentDigest,
            getCache,
            getNode,
            reporter,
            store,
          },
          pluginOptions
        )
      } else {
        res.status(400).send(`Received body was empty!`)
        return reporter.log(`Received body was empty!`)
      }
    }
  )
}

exports.pluginOptionsSchema = ({ Joi }) =>
  Joi.object({
    baseUrl: Joi.string()
      .required()
      .description(`The URL to root of your Drupal instance`),
    apiBase: Joi.string().description(
      `The path to the root of the JSONAPI — defaults to "jsonapi"`
    ),
    basicAuth: Joi.object({
      username: Joi.string().required(),
      password: Joi.string().required(),
    }).description(`Enables basicAuth`),
    filters: Joi.object().description(
      `Pass filters to the JSON API for specific collections`
    ),
    headers: Joi.object().description(
      `Set request headers for requests to the JSON API`
    ),
    params: Joi.object().description(`Append optional GET params to requests`),
    concurrentFileRequests: Joi.number().integer().default(20).min(1),
    concurrentAPIRequests: Joi.number().integer().default(20).min(1),
    disallowedLinkTypes: Joi.array().items(Joi.string()),
    skipFileDownloads: Joi.boolean(),
    fastBuilds: Joi.boolean(),
    entityReferenceRevisions: Joi.array().items(Joi.string()),
    secret: Joi.string().description(
      `an optional secret token for added security shared between your Drupal instance and Gatsby preview`
    ),
    languageConfig: Joi.object({
      defaultLanguage: Joi.string().required(),
      enabledLanguages: Joi.array().items(Joi.string()).required(),
      translatableEntities: Joi.array().items(Joi.string()).required(),
    }),
  })
