/**
 * Host-half tests for dsh-render.
 *
 * Everything runs against temporary directories: no real `$DSH_HOME`, no
 * network, and no vendor files are written inside the plugin package.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import * as hostPlugin from '../index.js'
import { promptText, installPromptSection } from '../lib/prompt.js'
import { apiRoutes, createVendorWebRoute } from '../lib/routes.js'
import {
  SettingsStore,
  defaultSettings,
  normalizeSettings,
} from '../lib/settings.js'
import {
  VENDOR_VERSION,
  contentTypeFor,
  resolveVendorPath,
  vendorRoots,
  vendorStatus,
} from '../lib/vendor.js'

/** Plugin package root, used by the index and sync-vendor tests. */
const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * @returns {Promise<string>} a fresh temporary directory.
 */
async function tempDir() {
  return mkdtemp(join(tmpdir(), 'dsh-render-test-'))
}

/**
 * Minimal ServerResponse recorder for the vendor prefix route.
 * @returns {{ record: Record<string, any>, writeHead: Function, end: Function, destroy: Function }}
 */
function responseRecorder() {
  const record = {
    status: 0,
    headers: /** @type {Record<string, string>} */ ({}),
    body: undefined,
    headersSent: false,
    destroyed: false,
  }
  return {
    record,
    writeHead(status, headers) {
      record.status = status
      record.headers = { ...(headers ?? {}) }
      record.headersSent = true
      return this
    },
    end(body) {
      record.body = body
      return this
    },
    destroy() {
      record.destroyed = true
    },
  }
}

/**
 * @param {{ method?: string, url: string }} request - minimal node request.
 * @returns {{ method: string, url: string, headers: Record<string, string> }}
 */
function nodeRequest(request) {
  return { method: 'GET', headers: {}, ...request }
}

test('index.js imports cleanly and exposes the Host plugin shape', () => {
  assert.equal(hostPlugin.name, 'dsh-render')
  assert.equal(typeof hostPlugin.apply, 'function')
})

test('defaultSettings exposes the documented complete shape', () => {
  assert.deepEqual(defaultSettings(), {
    version: 1,
    mermaid: { enabled: true, theme: 'auto', debounceMs: 500, maxSourceChars: 200000 },
    echarts: { enabled: true },
    csv: { enabled: true },
    detection: { heuristic: true, extraKeywords: [] },
    prompt: { enabled: false },
    appearance: {
      table: 'claude',
      inlineCode: 'claude',
      codeBlock: 'claude',
      codeFont: 'inherit',
      customCodeFont: '',
      codeFontSize: 0,
      codeLineHeight: 0,
      codeLigatures: false,
      collapseUserMessages: true,
      userMessageMaxHeight: 360,
      lightBackground: '#FCFCFB',
      inlineCodeColor: 'blue',
      customInlineCodeColor: '#8E2626',
    },
    typography: {
      textFontFamily: '',
      textFontSize: 0,
      codeFontSize: 0,
      terminalFontSize: 0,
    },
    uiScale: 1,
  })

  const first = defaultSettings()
  first.mermaid.enabled = false
  assert.equal(defaultSettings().mermaid.enabled, true)
})

test('normalizeSettings deep-merges known fields and drops unknown ones', () => {
  const settings = normalizeSettings({
    mermaid: { theme: 'dark', unknownNested: true },
    echarts: { enabled: false },
    detection: { extraKeywords: [' Sankey ', 'Sankey', ''] },
    prompt: { enabled: true },
    unknownRoot: 'drop me',
  })

  assert.deepEqual(settings, {
    version: 1,
    mermaid: { enabled: true, theme: 'dark', debounceMs: 500, maxSourceChars: 200000 },
    echarts: { enabled: false },
    csv: { enabled: true },
    detection: { heuristic: true, extraKeywords: ['Sankey'] },
    prompt: { enabled: true },
    appearance: {
      table: 'claude',
      inlineCode: 'claude',
      codeBlock: 'claude',
      codeFont: 'inherit',
      customCodeFont: '',
      codeFontSize: 0,
      codeLineHeight: 0,
      codeLigatures: false,
      collapseUserMessages: true,
      userMessageMaxHeight: 360,
      lightBackground: '#FCFCFB',
      inlineCodeColor: 'blue',
      customInlineCodeColor: '#8E2626',
    },
    typography: {
      textFontFamily: '',
      textFontSize: 0,
      codeFontSize: 0,
      terminalFontSize: 0,
    },
    uiScale: 1,
  })
})

test('normalizeSettings merges a patch over a partial base document', () => {
  const base = normalizeSettings({
    mermaid: { theme: 'light', debounceMs: 900 },
    prompt: { enabled: true },
  })
  const merged = normalizeSettings({ mermaid: { enabled: false }, csv: { enabled: false } }, base)

  assert.equal(merged.mermaid.enabled, false)
  assert.equal(merged.mermaid.theme, 'light')
  assert.equal(merged.mermaid.debounceMs, 900)
  assert.equal(merged.mermaid.maxSourceChars, 200000)
  assert.equal(merged.csv.enabled, false)
  assert.equal(merged.prompt.enabled, true)

  // Invalid values in the base are ignored rather than propagated.
  const invalidBase = normalizeSettings({}, {
    mermaid: { theme: 'neon', debounceMs: 'fast', maxSourceChars: -1 },
    echarts: { enabled: 'yes' },
  })
  assert.equal(invalidBase.mermaid.theme, 'auto')
  assert.equal(invalidBase.mermaid.debounceMs, 500)
  assert.equal(invalidBase.mermaid.maxSourceChars, 2000)
  assert.equal(invalidBase.echarts.enabled, true)
})

test('normalizeSettings clamps bounded values and validates types', () => {
  assert.equal(normalizeSettings({ mermaid: { debounceMs: 10 } }).mermaid.debounceMs, 200)
  assert.equal(normalizeSettings({ mermaid: { debounceMs: 99999 } }).mermaid.debounceMs, 3000)
  assert.equal(normalizeSettings({ mermaid: { debounceMs: 750.6 } }).mermaid.debounceMs, 751)
  assert.equal(normalizeSettings({ mermaid: { debounceMs: 'fast' } }).mermaid.debounceMs, 500)
  assert.equal(normalizeSettings({ mermaid: { debounceMs: Number.NaN } }).mermaid.debounceMs, 500)

  assert.equal(normalizeSettings({ mermaid: { theme: 'DARK' } }).mermaid.theme, 'auto')
  assert.equal(normalizeSettings({ mermaid: { theme: 'light' } }).mermaid.theme, 'light')
  assert.equal(normalizeSettings({ mermaid: { enabled: 'yes' } }).mermaid.enabled, true)
  assert.equal(normalizeSettings({ prompt: { enabled: 1 } }).prompt.enabled, false)

  assert.equal(normalizeSettings({ mermaid: { maxSourceChars: 12345 } }).mermaid.maxSourceChars, 12345)
  assert.equal(normalizeSettings({ mermaid: { maxSourceChars: 10 } }).mermaid.maxSourceChars, 2000)
  assert.equal(normalizeSettings({ mermaid: { maxSourceChars: 0 } }).mermaid.maxSourceChars, 2000)
  assert.equal(normalizeSettings({ mermaid: { maxSourceChars: 12.5 } }).mermaid.maxSourceChars, 2000)
  assert.equal(normalizeSettings({ mermaid: { maxSourceChars: 9999999 } }).mermaid.maxSourceChars, 2000000)
  assert.equal(normalizeSettings({ mermaid: { maxSourceChars: '100' } }).mermaid.maxSourceChars, 200000)

  assert.equal(normalizeSettings({ version: 99 }).version, 1)
})

test('normalizeSettings validates the Markdown appearance group', () => {
  const settings = normalizeSettings({
    appearance: {
      table: 'dsh',
      inlineCode: 'unknown',
      codeBlock: 'minimal',
      codeFont: 'fira',
      customCodeFont: ' "X"; {} ',
      codeFontSize: 99,
      codeLineHeight: 0.2,
      codeLigatures: true,
      unknown: 'drop',
    },
  })
  assert.equal(settings.appearance.table, 'dsh')
  assert.equal(settings.appearance.inlineCode, 'claude', 'an invalid choice keeps the default')
  assert.equal(settings.appearance.codeBlock, 'minimal')
  assert.equal(settings.appearance.codeFont, 'fira')
  assert.equal(settings.appearance.customCodeFont, '"X"', 'CSS-breaking punctuation is stripped')
  assert.equal(settings.appearance.codeFontSize, 20)
  assert.equal(settings.appearance.codeLineHeight, 1.4)
  assert.equal(settings.appearance.codeLigatures, true)
  assert.equal('unknown' in settings.appearance, false)

  const legacy = normalizeSettings({ appearance: { inlineCode: 'brand' } })
  assert.equal(legacy.appearance.inlineCode, 'claude', 'the legacy brand value maps to the Claude chip')

  const zero = normalizeSettings({ appearance: { codeFontSize: 0, codeLineHeight: 0 } })
  assert.equal(zero.appearance.codeFontSize, 0, '0 keeps the DSH appearance baseline')
  assert.equal(zero.appearance.codeLineHeight, 0)
})

test('normalizeSettings validates the General typography group', () => {
  const settings = normalizeSettings({
    typography: {
      textFontFamily: ' "X"; {} ',
      textFontSize: 99,
      codeFontSize: 5,
      terminalFontSize: 999,
      unknown: 'drop',
    },
  })
  assert.equal(settings.typography.textFontFamily, '"X"', 'CSS-breaking punctuation is stripped')
  assert.equal(settings.typography.textFontSize, 22)
  assert.equal(settings.typography.codeFontSize, 10)
  assert.equal(settings.typography.terminalFontSize, 20)
  assert.equal('unknown' in settings.typography, false)

  const zero = normalizeSettings({ typography: { textFontSize: 0, codeFontSize: 0, terminalFontSize: 0 } })
  assert.equal(zero.typography.textFontSize, 0, '0 keeps the native value')
  assert.equal(zero.typography.codeFontSize, 0)
  assert.equal(zero.typography.terminalFontSize, 0)
})

test('normalizeSettings clamps the whole-interface scale', () => {
  assert.equal(normalizeSettings({ uiScale: 2 }).uiScale, 1.3)
  assert.equal(normalizeSettings({ uiScale: 0.5 }).uiScale, 0.8)
  assert.equal(normalizeSettings({ uiScale: 1.15 }).uiScale, 1.15)
  assert.equal(normalizeSettings({ uiScale: 'large' }).uiScale, 1)
})

test('normalizeSettings trims, dedupes, drops over-long, and caps extraKeywords', () => {
  const many = Array.from({ length: 60 }, (_, index) => `keyword-${index}`)
  const exactly64 = 'y'.repeat(64)
  const tooLong = 'x'.repeat(65)
  const keywords = normalizeSettings({
    detection: { extraKeywords: ['  alpha  ', 'alpha', '', 42, exactly64, tooLong, ...many] },
  }).detection.extraKeywords

  assert.equal(keywords.length, 50)
  assert.equal(keywords[0], 'alpha')
  assert.equal(keywords.filter(keyword => keyword === 'alpha').length, 1)
  assert.equal(keywords[1], exactly64)
  assert.ok(!keywords.includes(tooLong), 'over-long keywords are dropped')
  assert.ok(keywords.includes('keyword-0'))
  assert.ok(!keywords.includes('keyword-50'))
})

test('resolveVendorPath resolves normal, nested, and encoded paths', async () => {
  const root = await tempDir()
  try {
    const base = join(root, 'mermaid')
    const direct = resolveVendorPath(base, 'mermaid.esm.min.mjs')
    assert.deepEqual(direct, {
      absolutePath: join(resolve(base), 'mermaid.esm.min.mjs'),
      contentType: 'text/javascript; charset=utf-8',
    })

    const nested = resolveVendorPath(base, 'chunks/with%20space.mjs')
    assert.deepEqual(nested, {
      absolutePath: join(resolve(base), 'chunks', 'with space.mjs'),
      contentType: 'text/javascript; charset=utf-8',
    })

    assert.equal(resolveVendorPath(base, 'theme.css')?.contentType, 'text/css; charset=utf-8')
    assert.equal(resolveVendorPath(base, 'data.json')?.contentType, 'application/json; charset=utf-8')
    assert.equal(resolveVendorPath(base, 'bundle.js.map')?.contentType, 'application/json; charset=utf-8')
    assert.equal(resolveVendorPath(base, 'VERSION')?.contentType, 'application/octet-stream')
    assert.equal(resolveVendorPath(base, 'LICENSE')?.contentType, 'application/octet-stream')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('resolveVendorPath rejects traversal, absolute paths, and disallowed names', async () => {
  const root = await tempDir()
  try {
    const base = join(root, 'mermaid')
    const rejected = [
      '../secret.js',
      '..%2fsecret.js',
      '%2e%2e/%2e%2e/etc/passwd.js',
      'a/../../b.js',
      '/etc/passwd',
      'C:/Windows/system.ini',
      'C:\\Windows\\system.ini',
      '..\\secret.js',
      'chunks\\evil.js',
      '%5c..%5csecret.js',
      'bad\0.js',
      'bad%00.js',
      'index.html',
      'archive.exe',
      'no-extension',
      'LICENSE.md',
      '%E0%A4%A.js',
      '',
      '.',
    ]
    for (const candidate of rejected) {
      assert.equal(resolveVendorPath(base, candidate), null, `expected null for ${JSON.stringify(candidate)}`)
    }
    assert.equal(resolveVendorPath(base, undefined), null)
    assert.equal(resolveVendorPath('', 'app.js'), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('contentTypeFor maps every promised extension', () => {
  assert.equal(contentTypeFor('app.mjs'), 'text/javascript; charset=utf-8')
  assert.equal(contentTypeFor('app.js'), 'text/javascript; charset=utf-8')
  assert.equal(contentTypeFor('app.JSON'), 'application/json; charset=utf-8')
  assert.equal(contentTypeFor('app.js.map'), 'application/json; charset=utf-8')
  assert.equal(contentTypeFor('app.css'), 'text/css; charset=utf-8')
  assert.equal(contentTypeFor('.mjs'), 'text/javascript; charset=utf-8')
  assert.equal(contentTypeFor('VERSION'), 'application/octet-stream')
  assert.equal(contentTypeFor('image.png'), 'application/octet-stream')
  assert.equal(contentTypeFor(undefined), 'application/octet-stream')
})

test('vendorStatus reports readiness from the expected vendor files', async () => {
  const pluginDir = await tempDir()
  try {
    const before = vendorStatus(pluginDir)
    assert.deepEqual(Object.keys(before), ['mermaid', 'echarts'])
    assert.deepEqual(before.mermaid, {
      version: VENDOR_VERSION.mermaid,
      ready: false,
      entry: '/api/dsh-render/vendor/mermaid/dist/mermaid.esm.min.mjs',
    })
    assert.deepEqual(before.echarts, {
      version: VENDOR_VERSION.echarts,
      ready: false,
      entry: '/api/dsh-render/vendor/echarts/echarts.min.js',
    })

    await mkdir(join(pluginDir, 'vendor', 'mermaid', 'dist'), { recursive: true })
    await writeFile(join(pluginDir, 'vendor', 'mermaid', 'dist', 'mermaid.esm.min.mjs'), 'export {}\n')
    await mkdir(join(pluginDir, 'vendor', 'echarts'), { recursive: true })
    await writeFile(join(pluginDir, 'vendor', 'echarts', 'echarts.min.js'), '/* echarts */\n')

    const after = vendorStatus(pluginDir)
    assert.equal(after.mermaid.ready, true)
    assert.equal(after.echarts.ready, true)
    assert.equal(after.mermaid.version, '12.2.0')
    assert.equal(after.echarts.version, '6.1.0')
  } finally {
    await rm(pluginDir, { recursive: true, force: true })
  }
})

test('SettingsStore defaults, persists atomically, and resets', async () => {
  const home = await tempDir()
  try {
    const store = new SettingsStore({ home })
    const initial = await store.load()
    assert.deepEqual(initial, defaultSettings())
    assert.equal(existsSync(store.settingsPath), false)

    const saved = await store.set({
      mermaid: { theme: 'dark' },
      detection: { extraKeywords: [' x ', 'x', ' y '] },
    })
    assert.equal(saved.mermaid.theme, 'dark')
    assert.equal(saved.mermaid.debounceMs, 500)
    assert.deepEqual(saved.detection.extraKeywords, ['x', 'y'])
    assert.equal(existsSync(store.settingsPath), true)

    const onDisk = JSON.parse(await readFile(store.settingsPath, 'utf8'))
    assert.deepEqual(onDisk, saved)
    const leftovers = (await readdir(store.root)).filter(name => name.endsWith('.tmp'))
    assert.deepEqual(leftovers, [])

    // get() returns a detached copy.
    const copy = store.get()
    copy.mermaid.enabled = false
    assert.equal(store.get().mermaid.enabled, true)

    const reloaded = new SettingsStore({ home })
    assert.deepEqual(await reloaded.load(), saved)

    const reset = await reloaded.reset()
    assert.deepEqual(reset, defaultSettings())
    assert.deepEqual(JSON.parse(await readFile(reloaded.settingsPath, 'utf8')), defaultSettings())
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('SettingsStore preserves a corrupt file and falls back to defaults', async () => {
  const home = await tempDir()
  try {
    const broken = new SettingsStore({ home })
    await mkdir(broken.root, { recursive: true })
    const corruptBody = '{"version":1,"mermaid":'
    await writeFile(broken.settingsPath, corruptBody, 'utf8')

    const messages = []
    const store = new SettingsStore({ home, logger: { warn: message => messages.push(message) } })
    assert.deepEqual(await store.load(), defaultSettings())

    const entries = await readdir(store.root)
    const backup = entries.find(name => name.startsWith('settings.json.bak-'))
    assert.ok(backup, 'a settings.json.bak-<ts> backup should exist')
    assert.equal(await readFile(join(store.root, backup), 'utf8'), corruptBody)
    assert.ok(messages.some(message => message.includes('preserved corrupt settings')))

    // The first save recreates the live file from the defaults.
    await store.save()
    assert.deepEqual(JSON.parse(await readFile(store.settingsPath, 'utf8')), defaultSettings())
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('SettingsStore serializes concurrent mutations in submission order', async () => {
  const home = await tempDir()
  try {
    const store = new SettingsStore({ home })
    await store.load()

    const [first, second] = await Promise.all([
      store.set({ mermaid: { theme: 'dark' } }),
      store.set({ csv: { enabled: false } }),
    ])
    assert.equal(first.mermaid.theme, 'dark')
    assert.equal(first.csv.enabled, true)
    assert.equal(second.mermaid.theme, 'dark', 'the second patch merges over the first write')
    assert.equal(second.csv.enabled, false)

    const final = store.get()
    assert.equal(final.mermaid.theme, 'dark')
    assert.equal(final.csv.enabled, false)
    assert.deepEqual(JSON.parse(await readFile(store.settingsPath, 'utf8')), final)

    // reset() shares the queue: it runs after the set() submitted before it.
    const [, reset] = await Promise.all([
      store.set({ mermaid: { theme: 'light' } }),
      store.reset(),
    ])
    assert.deepEqual(reset, defaultSettings())
    assert.deepEqual(store.get(), defaultSettings())
    assert.deepEqual(JSON.parse(await readFile(store.settingsPath, 'utf8')), defaultSettings())
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('SettingsStore falls back to defaults when the document cannot be read', async () => {
  const home = await tempDir()
  try {
    const messages = []
    const store = new SettingsStore({ home, logger: { warn: message => messages.push(message) } })

    // A directory at the settings path produces a non-ENOENT read error on
    // every supported platform: load() must degrade instead of taking the
    // whole Host plugin down.
    await mkdir(store.settingsPath, { recursive: true })
    assert.deepEqual(await store.load(), defaultSettings())
    assert.equal(store.loaded, true)
    assert.ok(messages.some(message => message.includes('cannot read')))

    // Writes must still surface io-error and keep the in-memory document.
    await assert.rejects(
      store.set({ mermaid: { theme: 'dark' } }),
      error => error?.code === 'io-error',
    )
    assert.deepEqual(store.get(), defaultSettings(), 'a failed write leaves memory untouched')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('apiRoutes returns the documented state document', async () => {
  const home = await tempDir()
  try {
    const store = new SettingsStore({ home })
    await store.load()
    const vendor = {
      mermaid: { version: '12.2.0', ready: true, entry: '/api/dsh-render/vendor/mermaid/mermaid.esm.min.mjs' },
      echarts: { version: '6.1.0', ready: false, entry: '/api/dsh-render/vendor/echarts/echarts.min.js' },
    }
    const routes = apiRoutes({
      settingsStore: store,
      vendorRoots: vendorRoots('/nonexistent-plugin'),
      vendor,
    })

    assert.deepEqual(routes.map(route => route.path), [
      '/api/dsh-render/state',
      '/api/dsh-render/action',
    ])
    assert.deepEqual(routes[0].methods, ['GET'])
    assert.deepEqual(routes[1].methods, ['POST'])
    assert.equal(routes[0].requestBody, 'buffered')
    assert.equal(routes[1].requestBody, 'buffered')

    const response = await routes[0].fetch(
      new Request('http://host/api/dsh-render/state?sessionId=session-1'),
    )
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await response.json(), {
      ok: true,
      value: { settings: defaultSettings(), vendor },
    })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('action route merges settings, resets, and rejects invalid requests', async () => {
  const home = await tempDir()
  try {
    const store = new SettingsStore({ home })
    await store.load()
    const route = apiRoutes({
      settingsStore: store,
      vendorRoots: vendorRoots('/nonexistent-plugin'),
      vendor: {},
    }).find(candidate => candidate.path === '/api/dsh-render/action')
    assert.ok(route)

    /** @param {unknown} body - JSON body. */
    const post = body => route.fetch(new Request('http://host/api/dsh-render/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }))

    const merged = await post({ settings: { mermaid: { theme: 'dark' } } })
    assert.equal(merged.status, 200)
    assert.equal(merged.headers.get('cache-control'), 'no-store')
    const mergedBody = await merged.json()
    assert.equal(mergedBody.ok, true)
    assert.equal(mergedBody.value.settings.mermaid.theme, 'dark')
    assert.equal(mergedBody.value.settings.mermaid.debounceMs, 500)

    const invalidTheme = await post({ settings: { mermaid: { theme: 'neon' } } })
    assert.equal(invalidTheme.status, 200)
    // An invalid value is ignored: the previously saved theme stays in place.
    assert.equal((await invalidTheme.json()).value.settings.mermaid.theme, 'dark')

    const reset = await post({ action: 'reset' })
    assert.equal(reset.status, 200)
    assert.deepEqual((await reset.json()).value.settings, defaultSettings())

    const badCases = [
      {},
      { action: 'unknown' },
      { settings: null },
      { settings: [], action: 'reset' },
      { settings: {}, action: 'reset' },
    ]
    for (const body of badCases) {
      const response = await post(body)
      assert.equal(response.status, 400, JSON.stringify(body))
      assert.equal(response.headers.get('cache-control'), 'no-store')
      const payload = await response.json()
      assert.equal(payload.ok, false)
      assert.equal(payload.error.code, 'invalid-request')
      assert.equal(typeof payload.error.message, 'string')
    }

    const malformed = await post('{not json')
    assert.equal(malformed.status, 400)
    assert.equal((await malformed.json()).error.code, 'invalid-request')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('vendor web route serves whitelisted files with the entry/chunk cache policy', async () => {
  const pluginDir = await tempDir()
  try {
    const mermaidDist = join(pluginDir, 'vendor', 'mermaid', 'dist')
    await mkdir(mermaidDist, { recursive: true })
    await writeFile(join(mermaidDist, 'mermaid.esm.min.mjs'), 'export const mermaid = true\n')
    await mkdir(join(mermaidDist, 'chunks'), { recursive: true })
    await writeFile(join(mermaidDist, 'chunks', 'chunk-1.mjs'), 'export const chunk = 1\n')
    await mkdir(join(mermaidDist, 'dir.js'), { recursive: true })
    await mkdir(join(pluginDir, 'vendor', 'echarts'), { recursive: true })
    await writeFile(join(pluginDir, 'vendor', 'echarts', 'echarts.min.js'), '/* echarts */\n')

    const route = createVendorWebRoute({
      vendorRoots: vendorRoots(pluginDir),
      authorize: () => true,
      logger: { warn() {} },
    })
    assert.equal(route.kind, 'prefix')
    assert.equal(route.path, '/api/dsh-render/vendor')

    const entry = responseRecorder()
    await route.handler(
      nodeRequest({ url: '/api/dsh-render/vendor/mermaid/dist/mermaid.esm.min.mjs' }),
      entry,
    )
    assert.equal(entry.record.status, 200)
    assert.equal(entry.record.headers['content-type'], 'text/javascript; charset=utf-8')
    assert.equal(entry.record.headers['cache-control'], 'private, no-cache')
    assert.equal(String(entry.record.body), 'export const mermaid = true\n')

    // The browser may also ask for the entry without the retained `dist/`
    // segment; the route falls back to the same file and cache policy.
    const flatEntry = responseRecorder()
    await route.handler(
      nodeRequest({ url: '/api/dsh-render/vendor/mermaid/mermaid.esm.min.mjs' }),
      flatEntry,
    )
    assert.equal(flatEntry.record.status, 200)
    assert.equal(flatEntry.record.headers['cache-control'], 'private, no-cache')
    assert.equal(String(flatEntry.record.body), 'export const mermaid = true\n')

    // Nested chunks resolve through the retained `dist/` layout.
    const chunk = responseRecorder()
    await route.handler(
      nodeRequest({ url: '/api/dsh-render/vendor/mermaid/dist/chunks/chunk-1.mjs' }),
      chunk,
    )
    assert.equal(chunk.record.status, 200)
    assert.equal(chunk.record.headers['cache-control'], 'private, max-age=31536000, immutable')
    assert.equal(String(chunk.record.body), 'export const chunk = 1\n')

    const flatChunk = responseRecorder()
    await route.handler(
      nodeRequest({ url: '/api/dsh-render/vendor/mermaid/chunks/chunk-1.mjs' }),
      flatChunk,
    )
    assert.equal(flatChunk.record.status, 200)
    assert.equal(flatChunk.record.headers['cache-control'], 'private, max-age=31536000, immutable')
    assert.equal(String(flatChunk.record.body), 'export const chunk = 1\n')

    const echarts = responseRecorder()
    await route.handler(
      nodeRequest({ url: '/api/dsh-render/vendor/echarts/echarts.min.js' }),
      echarts,
    )
    assert.equal(echarts.record.status, 200)
    assert.equal(echarts.record.headers['content-type'], 'text/javascript; charset=utf-8')
    assert.equal(echarts.record.headers['cache-control'], 'private, no-cache')
    assert.equal(String(echarts.record.body), '/* echarts */\n')

    const missing = [
      '/api/dsh-render/vendor/mermaid/index.html',
      '/api/dsh-render/vendor/mermaid/dist/missing.mjs',
      '/api/dsh-render/vendor/mermaid/dist/dir.js',
      '/api/dsh-render/vendor/mermaid/',
      '/api/dsh-render/vendor/unknown/file.js',
      '/api/dsh-render/vendor/mermaid',
    ]
    for (const url of missing) {
      const response = responseRecorder()
      await route.handler(nodeRequest({ url }), response)
      assert.equal(response.record.status, 404, url)
    }

    const traversal = responseRecorder()
    await route.handler(
      nodeRequest({ url: '/api/dsh-render/vendor/mermaid/..%2f..%2fsettings.json' }),
      traversal,
    )
    assert.equal(traversal.record.status, 404)

    const methodNotAllowed = responseRecorder()
    await route.handler(
      nodeRequest({ method: 'POST', url: '/api/dsh-render/vendor/echarts/echarts.min.js' }),
      methodNotAllowed,
    )
    assert.equal(methodNotAllowed.record.status, 405)
    assert.equal(methodNotAllowed.record.headers.allow, 'GET')

    const denyingRoute = createVendorWebRoute({
      vendorRoots: vendorRoots(pluginDir),
      authorize: (_request, response) => {
        response.writeHead(401, { 'cache-control': 'no-store' })
        response.end('unauthorized')
        return false
      },
      logger: { warn() {} },
    })
    const denied = responseRecorder()
    await denyingRoute.handler(
      nodeRequest({ url: '/api/dsh-render/vendor/echarts/echarts.min.js' }),
      denied,
    )
    assert.equal(denied.record.status, 401)
    assert.equal(denied.record.body, 'unauthorized')
  } finally {
    await rm(pluginDir, { recursive: true, force: true })
  }
})

test('vendor web route revalidates entries but caches non-entry files immutably', async () => {
  const pluginDir = await tempDir()
  try {
    const mermaidDist = join(pluginDir, 'vendor', 'mermaid', 'dist')
    await mkdir(join(mermaidDist, 'chunks'), { recursive: true })
    await writeFile(join(mermaidDist, 'mermaid.esm.min.mjs'), 'export const mermaid = true\n')
    await writeFile(join(mermaidDist, 'chunks', 'chunk-1.mjs'), 'export const chunk = 1\n')
    await mkdir(join(pluginDir, 'vendor', 'echarts'), { recursive: true })
    await writeFile(join(pluginDir, 'vendor', 'echarts', 'echarts.min.js'), '/* echarts */\n')

    const route = createVendorWebRoute({
      vendorRoots: vendorRoots(pluginDir),
      authorize: () => true,
      logger: { warn() {} },
    })
    /** @param {string} url - vendor URL. */
    const get = async url => {
      const response = responseRecorder()
      await route.handler(nodeRequest({ url }), response)
      return response.record
    }

    const entries = [
      ['canonical mermaid entry', await get('/api/dsh-render/vendor/mermaid/dist/mermaid.esm.min.mjs')],
      ['flat mermaid entry', await get('/api/dsh-render/vendor/mermaid/mermaid.esm.min.mjs')],
      ['echarts entry', await get('/api/dsh-render/vendor/echarts/echarts.min.js')],
    ]
    for (const [label, record] of entries) {
      assert.equal(record.status, 200, label)
      assert.equal(record.headers['cache-control'], 'private, no-cache', label)
    }

    const chunks = [
      ['canonical chunk', await get('/api/dsh-render/vendor/mermaid/dist/chunks/chunk-1.mjs')],
      ['flat chunk', await get('/api/dsh-render/vendor/mermaid/chunks/chunk-1.mjs')],
    ]
    for (const [label, record] of chunks) {
      assert.equal(record.status, 200, label)
      assert.equal(
        record.headers['cache-control'],
        'private, max-age=31536000, immutable',
        label,
      )
    }
  } finally {
    await rm(pluginDir, { recursive: true, force: true })
  }
})

test('vendor web route applies 401/403 authorization before method or filesystem', async () => {
  const pluginDir = await tempDir()
  try {
    // No vendor tree is created: a rejected request must answer before any
    // stat/read, and authorization must win over the non-GET 405 branch.
    for (const status of [401, 403]) {
      const body = status === 401 ? 'unauthorized' : 'forbidden'
      const route = createVendorWebRoute({
        vendorRoots: vendorRoots(pluginDir),
        authorize: (_request, response) => {
          response.writeHead(status, { 'cache-control': 'no-store' })
          response.end(body)
          return false
        },
        logger: { warn() {} },
      })
      const response = responseRecorder()
      await route.handler(
        nodeRequest({ method: 'POST', url: '/api/dsh-render/vendor/echarts/echarts.min.js' }),
        response,
      )
      assert.equal(response.record.status, status)
      assert.equal(response.record.headers['cache-control'], 'no-store')
      assert.equal(String(response.record.body), body)
    }
  } finally {
    await rm(pluginDir, { recursive: true, force: true })
  }
})

test('vendor web route rejects unknown paths, directories, and non-GET methods', async () => {
  const pluginDir = await tempDir()
  try {
    const mermaidDist = join(pluginDir, 'vendor', 'mermaid', 'dist')
    await mkdir(join(mermaidDist, 'dir.js'), { recursive: true })
    await writeFile(join(mermaidDist, 'mermaid.esm.min.mjs'), 'export const mermaid = true\n')

    const route = createVendorWebRoute({
      vendorRoots: vendorRoots(pluginDir),
      authorize: () => true,
      logger: { warn() {} },
    })
    /** @param {string} method - HTTP method. @param {string} url - request URL. */
    const request = async (method, url) => {
      const response = responseRecorder()
      await route.handler(nodeRequest({ method, url }), response)
      return response.record
    }

    assert.equal((await request('GET', '/api/dsh-render/vendor/mermaid/missing.mjs')).status, 404)
    assert.equal((await request('GET', '/api/dsh-render/vendor/unknown/file.js')).status, 404)
    assert.equal((await request('GET', '/api/dsh-render/vendor/mermaid/dist/dir.js')).status, 404)
    assert.equal((await request('GET', '/api/dsh-render/vendor/mermaid')).status, 404)

    const notAllowed = await request('POST', '/api/dsh-render/vendor/echarts/echarts.min.js')
    assert.equal(notAllowed.status, 405)
    assert.equal(notAllowed.headers.allow, 'GET')
  } finally {
    await rm(pluginDir, { recursive: true, force: true })
  }
})

test('sync-vendor self-check enforces https and pinned sha512 integrity', () => {
  const scriptPath = join(PLUGIN_ROOT, 'scripts', 'sync-vendor.mjs')
  const source = readFileSync(scriptPath, 'utf8')
  assert.ok(
    source.includes('sha512-w7nr/SFrLO7BaVTs3dQTvYSV6nYSBj0Yy9DjBhsIJtAcHqRzXSq4Pg32ujHZ/AdWsAMNEvvhbm5dt9E2tOiHzw=='),
    'mermaid@12.2.0 integrity is pinned',
  )
  assert.ok(
    source.includes('sha512-q0yaFPggC9FUdsWH4blavRWFmxdrIodbkoKNAjJudAI6CA9gNPxHtV2RcZNEepZVlk4yvBYkOkbk6HIVpIyHZA=='),
    'echarts@6.1.0 integrity is pinned',
  )
  assert.ok(source.includes('manifest.name !== spec.name'), 'package name is checked')
  assert.ok(source.includes("createHash('sha512')"), 'downloads are hashed with sha512')
  assert.ok(source.includes("protocol !== 'https:'"), 'registry transport is enforced')

  const ok = spawnSync(process.execPath, [scriptPath, '--self-check'], {
    encoding: 'utf8',
    env: { ...process.env, NPM_REGISTRY: 'https://registry.npmjs.org' },
  })
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stdout, /self-check OK/)

  const insecure = spawnSync(process.execPath, [scriptPath, '--self-check'], {
    encoding: 'utf8',
    env: { ...process.env, NPM_REGISTRY: 'http://registry.npmjs.org' },
  })
  assert.notEqual(insecure.status, 0)
  assert.match(insecure.stderr, /https:/)
})

test('prompt section is dynamic and emits nothing while disabled', () => {
  assert.equal(promptText(defaultSettings()), '')

  const enabled = normalizeSettings({ prompt: { enabled: true } })
  const text = promptText(enabled)
  assert.match(text, /`mermaid`/)
  assert.match(text, /`echarts`/)
  assert.match(text, /`csv`/)
  assert.match(text, /fence info string/)

  /** @type {Record<string, any> | undefined} */
  let registered
  const ctx = {
    systemPrompt: {
      section(section) {
        registered = section
        return () => {}
      },
    },
  }
  const settingsStore = { settings: defaultSettings() }
  const dispose = installPromptSection(ctx, settingsStore)
  assert.equal(typeof dispose, 'function')
  assert.ok(registered)
  assert.equal(registered.name, 'dsh-render: fence formats')
  assert.equal(registered.order, 450)
  assert.equal(registered.text({}), '')

  settingsStore.settings = enabled
  assert.match(registered.text({}), /`mermaid`/)
  assert.match(registered.text({}), /`echarts`/)
  assert.match(registered.text({}), /`csv`/)

  settingsStore.settings = defaultSettings()
  assert.equal(registered.text({}), '')
})

test('normalizeSettings normalizes the light-theme background color', () => {
  assert.equal(
    normalizeSettings({ appearance: { lightBackground: '#f6f5f1' } }).appearance.lightBackground,
    '#F6F5F1',
  )
  assert.equal(
    normalizeSettings({ appearance: { lightBackground: ' #FFF ' } }).appearance.lightBackground,
    '#FFFFFF',
  )
  assert.equal(
    normalizeSettings({ appearance: { lightBackground: 'red' } }).appearance.lightBackground,
    '',
    'invalid colors disable the override instead of keeping a broken value',
  )
  assert.equal(
    normalizeSettings({ appearance: { lightBackground: '' } }).appearance.lightBackground,
    '',
  )
  assert.equal(
    normalizeSettings({ appearance: { lightBackground: 42 } }).appearance.lightBackground,
    '#FCFCFB',
    'non-string values keep the base value',
  )
  const base = normalizeSettings({ appearance: { lightBackground: '#EFEDE6' } })
  assert.equal(
    normalizeSettings({ appearance: { table: 'dsh' } }, base).appearance.lightBackground,
    '#EFEDE6',
    'a patch that omits the field keeps the previous value',
  )
})

test('normalizeSettings validates the inline-code text color', () => {
  assert.equal(normalizeSettings({ appearance: { inlineCodeColor: 'red' } }).appearance.inlineCodeColor, 'red')
  assert.equal(normalizeSettings({ appearance: { inlineCodeColor: 'inherit' } }).appearance.inlineCodeColor, 'inherit')
  assert.equal(normalizeSettings({ appearance: { inlineCodeColor: 'purple' } }).appearance.inlineCodeColor, 'blue')
  assert.equal(
    normalizeSettings({ appearance: { customInlineCodeColor: '#abc' } }).appearance.customInlineCodeColor,
    '#AABBCC',
  )
  assert.equal(
    normalizeSettings({ appearance: { customInlineCodeColor: 'nope' } }).appearance.customInlineCodeColor,
    '',
  )
  assert.equal(normalizeSettings({}).appearance.customInlineCodeColor, '#8E2626')
  assert.equal(normalizeSettings({}).appearance.inlineCodeColor, 'blue')
})
