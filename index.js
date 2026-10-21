/**
 * dsh-render Host plugin.
 *
 * Responsibilities:
 * 1. Own the persistent Render settings document
 *    (`$DSH_HOME/dsh-render/settings.json`).
 * 2. Serve the authenticated `/api/dsh-render/state` and
 *    `/api/dsh-render/action` Fetch routes used by the browser half.
 * 3. Serve the vendored Mermaid/ECharts assets below
 *    `/api/dsh-render/vendor/*` behind the same browser authentication.
 * 4. Optionally inject a dynamic system-prompt section that teaches the model
 *    to prefer the supported diagram/chart/table fences.
 *
 * No Harness package is imported: the Host half talks to the runtime only
 * through the Cordis context and to the browser half only through HTTP.
 *
 * @module @local/dsh-render
 */

import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installPromptSection } from './lib/prompt.js'
import { apiRoutes, createVendorWebRoute } from './lib/routes.js'
import { SettingsStore } from './lib/settings.js'
import { vendorRoots, vendorStatus } from './lib/vendor.js'

/** Cordis plugin name. */
export const name = 'dsh-render'

/**
 * Host plugin entry.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 */
export async function apply(ctx) {
  const logger = ctx.logger
  const settingsStore = new SettingsStore({ logger })
  await settingsStore.load()

  const pluginDir = dirname(fileURLToPath(import.meta.url))
  const roots = vendorRoots(pluginDir)
  const vendor = vendorStatus(pluginDir)

  // Optional model guidance. The provider is dynamic, so the on/off setting
  // takes effect on the next prompt assembly without re-registering anything.
  ctx.inject(['systemPrompt'], (scoped) => {
    scoped.effect(
      () => installPromptSection(scoped, settingsStore),
      'dsh-render: prompt section',
    )
  })

  // Settings API. Headless profiles without Connection simply skip this
  // contribution instead of failing the plugin load.
  ctx.inject(['connection'], (scoped) => {
    scoped.effect(async () => {
      const routes = apiRoutes({ settingsStore, vendorRoots: roots, vendor, logger })
      const disposers = []
      try {
        for (const route of routes) {
          disposers.push(await scoped.connection.fetch.register(route))
        }
      } catch (error) {
        await Promise.allSettled(disposers.map(dispose => dispose()))
        throw error
      }
      return async () => {
        for (const dispose of disposers.reverse()) {
          try {
            await dispose()
          } catch {
            // Host teardown is best-effort.
          }
        }
      }
    }, 'dsh-render: http routes')
  })

  // Vendored assets need a URL subtree. Connection Fetch routes match exact
  // paths only, so this prefix route performs the same trust/authentication
  // fence through requestRejection before serving a whitelisted file.
  ctx.inject(['connection', 'webServer'], (scoped) => {
    scoped.effect(
      () => scoped.webServer.register(createVendorWebRoute({
        vendorRoots: roots,
        logger,
        authorize: (request, response) => {
          const rejection = scoped.connection.requestRejection(request)
          if (rejection === undefined) return true
          response.writeHead(rejection, { 'cache-control': 'no-store' })
          response.end(rejection === 401 ? 'unauthorized' : 'forbidden')
          return false
        },
      })),
      'dsh-render: vendor assets',
    )
  })

  logger?.info?.(
    `dsh-render: settings at ${settingsStore.settingsPath}; `
    + `mermaid ready=${String(vendor.mermaid.ready)}, echarts ready=${String(vendor.echarts.ready)}`,
  )
}
