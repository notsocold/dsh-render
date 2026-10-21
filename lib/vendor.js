/**
 * Vendored browser assets and path safety.
 *
 * Mermaid and ECharts ship as static ESM/UMD files. The browser half loads
 * them from the authenticated `/api/dsh-render/vendor/*` URLs served by the
 * Host half. This module owns the version catalogue, the readiness probe, the
 * URL -> filesystem resolver, and the Content-Type table.
 *
 * @module dsh-render/lib/vendor
 */

import { statSync } from 'node:fs'
import { basename, extname, isAbsolute, join, resolve, sep } from 'node:path'

/** URL prefix below which vendored files are served. */
export const VENDOR_URL_PREFIX = '/api/dsh-render/vendor'

/** Vendored library versions (also reported by the state endpoint). */
export const VENDOR_VERSION = Object.freeze({
  mermaid: '12.2.0',
  echarts: '6.1.0',
})

/** File names exposed as the public browser entry points. */
export const VENDOR_ENTRY = Object.freeze({
  mermaid: 'dist/mermaid.esm.min.mjs',
  echarts: 'echarts.min.js',
})

/** Files whose presence marks a library as ready (relative to its vendor root). */
export const VENDOR_READY_FILE = Object.freeze({
  mermaid: join('dist', 'mermaid.esm.min.mjs'),
  echarts: 'echarts.min.js',
})

/** Extensions the vendor route is allowed to serve. */
const ALLOWED_EXTENSIONS = new Set(['.mjs', '.js', '.json', '.map', '.css'])

/** Extensionless files the vendor route is allowed to serve. */
const ALLOWED_BARE_NAMES = new Set(['VERSION', 'LICENSE'])

/** Exact Content-Type values promised to the browser. */
const CONTENT_TYPES = Object.freeze({
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
})

/** Libraries served below {@link VENDOR_URL_PREFIX}. */
const VENDOR_KEYS = ['mermaid', 'echarts']

/**
 * @param {unknown} pluginDir - candidate plugin root.
 * @returns {string} absolute plugin root.
 */
function requirePluginDir(pluginDir) {
  if (typeof pluginDir !== 'string' || pluginDir.trim() === '') {
    throw new TypeError('dsh-render: pluginDir must be a non-empty string')
  }
  return resolve(pluginDir)
}

/**
 * @param {string} file - candidate path.
 * @returns {boolean} whether it is a regular file.
 */
function isFile(file) {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

/**
 * Whitelist roots for the two vendored libraries.
 * @param {string} pluginDir - plugin package root.
 * @returns {{ mermaid: string, echarts: string }} absolute roots.
 */
export function vendorRoots(pluginDir) {
  const base = requirePluginDir(pluginDir)
  return {
    mermaid: join(base, 'vendor', 'mermaid'),
    echarts: join(base, 'vendor', 'echarts'),
  }
}

/**
 * Compute the startup vendor snapshot reported by the state endpoint.
 * `ready` reflects the file the plugin actually expects on disk.
 * @param {string} pluginDir - plugin package root.
 * @returns {Record<string, { version: string, ready: boolean, entry: string }>}
 */
export function vendorStatus(pluginDir) {
  const base = requirePluginDir(pluginDir)
  /** @type {Record<string, { version: string, ready: boolean, entry: string }>} */
  const status = {}
  for (const key of VENDOR_KEYS) {
    status[key] = {
      version: VENDOR_VERSION[key],
      ready: isFile(join(base, 'vendor', key, VENDOR_READY_FILE[key])),
      entry: `${VENDOR_URL_PREFIX}/${key}/${VENDOR_ENTRY[key]}`,
    }
  }
  return status
}

/**
 * Map a file path or extension to the Content-Type promised by the contract.
 * @param {string} filePath - path (`app.js`) or extension (`.js`).
 * @returns {string} Content-Type value.
 */
export function contentTypeFor(filePath) {
  const text = typeof filePath === 'string' ? filePath.toLowerCase() : ''
  const direct = text.startsWith('.') && !text.includes('/') && !text.includes('\\')
  const extension = direct ? text : extname(text)
  return CONTENT_TYPES[extension] ?? 'application/octet-stream'
}

/**
 * Resolve one URL path (relative to a whitelist root) to a safe file path.
 *
 * The input may still be percent-encoded; it is decoded exactly once here.
 * Absolute paths, `..` segments, backslashes, NUL bytes, and every extension
 * outside the allowlist are rejected. The caller is still responsible for
 * checking that the resolved path is a regular file (directory requests 404).
 *
 * @param {string} root - whitelist root directory.
 * @param {string} relativeUrlPath - URL path relative to the root.
 * @returns {{ absolutePath: string, contentType: string } | null}
 */
export function resolveVendorPath(root, relativeUrlPath) {
  if (typeof root !== 'string' || root === '' || typeof relativeUrlPath !== 'string') return null
  const rootPath = resolve(root)

  // Query strings and fragments are not part of the file path.
  const queryIndex = relativeUrlPath.search(/[?#]/)
  const raw = queryIndex === -1 ? relativeUrlPath : relativeUrlPath.slice(0, queryIndex)
  if (raw === '') return null

  let decoded
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return null
  }
  if (decoded === '') return null
  if (decoded.includes('\0')) return null
  if (decoded.includes('\\')) return null
  if (decoded.startsWith('/') || isAbsolute(decoded)) return null
  if (/^[A-Za-z]:/.test(decoded)) return null

  const segments = decoded.split('/')
  if (segments.some(segment => segment === '..')) return null

  const absolutePath = resolve(rootPath, decoded)
  const rootPrefix = rootPath.endsWith(sep) ? rootPath : `${rootPath}${sep}`
  if (absolutePath !== rootPath && !absolutePath.startsWith(rootPrefix)) return null

  const name = basename(absolutePath)
  const extension = extname(name).toLowerCase()
  if (!ALLOWED_EXTENSIONS.has(extension) && !ALLOWED_BARE_NAMES.has(name)) return null

  return { absolutePath, contentType: contentTypeFor(name) }
}
