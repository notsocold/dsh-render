/**
 * Authenticated HTTP surface of the dsh-render Host half.
 *
 * - The settings document and actions are exact Fetch routes registered on
 *   `ctx.connection.fetch`, so they live inside the same authenticated `/api`
 *   fence as every other browser API.
 * - Vendored Mermaid/ECharts assets need a whole URL subtree. Connection's
 *   exact Fetch routes cannot match a subtree, so the vendor route is a
 *   `webServer` prefix route whose handler performs the same
 *   `ctx.connection.requestRejection` check before any filesystem access.
 *
 * @module dsh-render/lib/routes
 */

import { readFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { errorMessage, isMissing } from './settings.js'
import {
  VENDOR_ENTRY,
  VENDOR_URL_PREFIX,
  VENDOR_VERSION,
  resolveVendorPath,
  vendorStatus,
} from './vendor.js'

/** Shared path prefix of every dsh-render route. */
export const API_PREFIX = '/api/dsh-render'

/** Prefix below which vendored assets are served. */
export const VENDOR_PREFIX = VENDOR_URL_PREFIX

/** Long-lived cache policy for versioned vendor files. */
const VENDOR_CACHE_CONTROL = 'public, max-age=31536000, immutable'

/** Headers every JSON response carries. */
const JSON_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
})

/** Known error codes mapped to HTTP statuses. */
const STATUS_BY_CODE = Object.freeze({
  'invalid-request': 400,
  'not-found': 404,
  'io-error': 500,
  internal: 500,
})

/**
 * @param {unknown} value - candidate object.
 * @returns {value is Record<string, any>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param {unknown} value - success payload.
 * @returns {Response}
 */
export function okResponse(value) {
  return Response.json({ ok: true, value }, { headers: JSON_HEADERS })
}

/**
 * Build one JSON failure envelope.
 * @param {string} code - stable error code.
 * @param {string} message - readable reason.
 * @param {number} [status] - HTTP status.
 * @returns {Response}
 */
export function errorResponse(code, message, status = 500) {
  return Response.json(
    { ok: false, error: { code, message } },
    { status, headers: JSON_HEADERS },
  )
}

/**
 * Convert an arbitrary thrown value to the API failure envelope.
 * @param {unknown} error - thrown value.
 * @returns {Response}
 */
export function failureResponse(error) {
  const rawCode = /** @type {{ code?: unknown }} */ (error)?.code
  const code = typeof rawCode === 'string' && rawCode in STATUS_BY_CODE ? rawCode : 'internal'
  return errorResponse(code, errorMessage(error), STATUS_BY_CODE[code])
}

/**
 * Fallback vendor snapshot for a caller that did not precompute one.
 * @param {unknown} vendorRoots - whitelist roots.
 * @returns {Record<string, { version: string, ready: boolean, entry: string }>}
 */
function fallbackVendor(vendorRoots) {
  if (isRecord(vendorRoots) && typeof vendorRoots.mermaid === 'string') {
    try {
      return vendorStatus(dirname(dirname(resolve(vendorRoots.mermaid))))
    } catch {
      // Fall through to a conservative not-ready snapshot.
    }
  }
  return {
    mermaid: {
      version: VENDOR_VERSION.mermaid,
      ready: false,
      entry: `${VENDOR_URL_PREFIX}/mermaid/${VENDOR_ENTRY.mermaid}`,
    },
    echarts: {
      version: VENDOR_VERSION.echarts,
      ready: false,
      entry: `${VENDOR_URL_PREFIX}/echarts/${VENDOR_ENTRY.echarts}`,
    },
  }
}

/**
 * Build the exact Fetch routes used by the settings page.
 * @param {{
 *   settingsStore: import('./settings.js').SettingsStore,
 *   vendorRoots?: Record<string, string>,
 *   vendor?: Record<string, any>,
 *   logger?: { warn?: (message: string) => void },
 * }} options - settings store, roots, and startup vendor snapshot.
 * @returns {Record<string, any>[]} ConnectionFetchRoute values.
 */
export function apiRoutes(options) {
  const { settingsStore, vendorRoots, vendor, logger } = options
  if (settingsStore === undefined || settingsStore === null) {
    throw new TypeError('dsh-render: apiRoutes requires a settingsStore')
  }
  const vendorSnapshot = isRecord(vendor) ? vendor : fallbackVendor(vendorRoots)

  return [
    {
      path: `${API_PREFIX}/state`,
      methods: ['GET'],
      requestBody: 'buffered',
      async fetch() {
        try {
          return okResponse({ settings: settingsStore.get(), vendor: vendorSnapshot })
        } catch (error) {
          logger?.warn?.(`dsh-render: cannot read state: ${errorMessage(error)}`)
          return failureResponse(error)
        }
      },
    },
    {
      path: `${API_PREFIX}/action`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        let body
        try {
          body = await request.json()
        } catch {
          return errorResponse('invalid-request', 'request body must be a JSON object', 400)
        }
        if (!isRecord(body)) {
          return errorResponse('invalid-request', 'request body must be a JSON object', 400)
        }

        const hasSettings = Object.hasOwn(body, 'settings')
        const hasAction = Object.hasOwn(body, 'action')
        if (hasSettings && hasAction) {
          return errorResponse(
            'invalid-request',
            'request body must contain either "settings" or "action", not both',
            400,
          )
        }

        try {
          if (hasSettings) {
            if (!isRecord(body.settings)) {
              return errorResponse('invalid-request', '"settings" must be an object', 400)
            }
            const settings = await settingsStore.set(body.settings)
            return okResponse({ settings })
          }
          if (hasAction) {
            if (body.action !== 'reset') {
              return errorResponse(
                'invalid-request',
                `unknown action ${JSON.stringify(body.action)}`,
                400,
              )
            }
            const settings = await settingsStore.reset()
            return okResponse({ settings })
          }
          return errorResponse(
            'invalid-request',
            'request body must contain "settings" or {"action":"reset"}',
            400,
          )
        } catch (error) {
          logger?.warn?.(`dsh-render: settings action failed: ${errorMessage(error)}`)
          return failureResponse(error)
        }
      },
    },
  ]
}

/**
 * @param {import('node:http').ServerResponse} res - response to finish.
 * @param {number} status - HTTP status.
 * @param {string} text - plain-text body.
 * @param {Record<string, string>} [headers] - extra headers.
 * @returns {void}
 */
function plainResponse(res, status, text, headers = {}) {
  try {
    res.writeHead(status, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    })
    res.end(text)
  } catch {
    // The client may have disconnected while the file was being read.
  }
}

/**
 * @param {string} contentType - resolved Content-Type.
 * @param {number} size - body size in bytes.
 * @returns {Record<string, string>} response headers for one vendored file.
 */
function fileHeaders(contentType, size) {
  return {
    'content-type': contentType,
    'cache-control': VENDOR_CACHE_CONTROL,
    'content-length': String(size),
    'x-content-type-options': 'nosniff',
  }
}

/**
 * Build the authenticated prefix route for `/api/dsh-render/vendor/*`.
 *
 * `authorize` must return `false` after writing the rejection response; this
 * handler never touches the filesystem for an unauthorized request.
 *
 * @param {{
 *   vendorRoots: Record<string, string>,
 *   authorize: (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => boolean | Promise<boolean>,
 *   logger?: { warn?: (message: string) => void },
 * }} options - roots and authentication hook.
 * @returns {{ kind: 'prefix', path: string, handler: (request: any, response: any) => Promise<void> }}
 */
export function createVendorWebRoute(options) {
  const { vendorRoots, authorize, logger } = options
  if (!isRecord(vendorRoots)) throw new TypeError('dsh-render: vendorRoots must be an object')
  if (typeof authorize !== 'function') {
    throw new TypeError('dsh-render: createVendorWebRoute requires an authorize function')
  }

  return {
    kind: 'prefix',
    path: VENDOR_PREFIX,
    async handler(request, response) {
      try {
        const allowed = await authorize(request, response)
        if (allowed === false) return

        const method = request.method ?? 'GET'
        if (method !== 'GET') {
          plainResponse(response, 405, 'method not allowed', { allow: 'GET' })
          return
        }

        const url = new URL(request.url ?? '/', 'http://dsh-render.invalid')
        const suffix = url.pathname.slice(VENDOR_PREFIX.length)
        if (!suffix.startsWith('/')) {
          plainResponse(response, 404, 'not found')
          return
        }
        const relative = suffix.slice(1)
        const separator = relative.indexOf('/')
        const library = separator === -1 ? relative : relative.slice(0, separator)
        const filePart = separator === -1 ? '' : relative.slice(separator + 1)
        const root = vendorRoots[library]
        if (typeof root !== 'string' || filePart === '') {
          plainResponse(response, 404, 'not found')
          return
        }

        /** @type {{ absolutePath: string, contentType: string }[]} */
        const candidates = []
        const direct = resolveVendorPath(root, filePart)
        if (direct !== null) {
          candidates.push(direct)
          // Some vendor layouts keep the package's `dist/` directory intact.
          if (!filePart.startsWith('dist/')) {
            const nested = resolveVendorPath(root, `dist/${filePart}`)
            if (nested !== null) candidates.push(nested)
          }
        }

        for (const candidate of candidates) {
          let info
          try {
            info = await stat(candidate.absolutePath)
          } catch (error) {
            if (isMissing(error)) continue
            throw error
          }
          if (!info.isFile()) continue

          let body
          try {
            body = await readFile(candidate.absolutePath)
          } catch (error) {
            if (isMissing(error)) continue
            throw error
          }
          response.writeHead(200, fileHeaders(candidate.contentType, body.byteLength))
          response.end(body)
          return
        }

        plainResponse(response, 404, 'not found')
      } catch (error) {
        logger?.warn?.(`dsh-render: vendor request failed: ${errorMessage(error)}`)
        if (response.headersSent === true) {
          try {
            response.destroy?.()
          } catch {
            // Best-effort connection teardown.
          }
          return
        }
        plainResponse(response, 500, 'internal error')
      }
    },
  }
}
