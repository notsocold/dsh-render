/**
 * Browser-half pure-function tests.
 *
 * The browser bundle is a closed lazy factory, so the test loads it in a VM
 * with a fake module loader and React, then reads the opt-in test exports the
 * factory publishes when `__DSH_RENDER_TEST__` is set. No DOM is involved.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

const sandbox = {
  window: { __ModuleLoader__: { load(registration) { sandbox.__registration = registration } } },
  console,
  __DSH_RENDER_TEST__: true,
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox)

const fakeReact = {
  createElement: () => null,
  useCallback: fn => fn,
  useEffect: () => {},
  useMemo: factory => factory(),
  useRef: () => ({ current: null }),
  useState: value => [value, () => {}],
}
const plugin = sandbox.__registration.factory(specifier => {
  if (specifier === 'react') return fakeReact
  throw new Error('unexpected module: ' + specifier)
})
const helpers = vm.runInContext('__DSH_RENDER_TEST_EXPORTS__', sandbox)

test('plugin exposes slots/locale injection and an apply function', () => {
  assert.deepEqual([...plugin.inject], ['slots', 'locale'])
  assert.equal(typeof plugin.apply, 'function')
})

test('mergeSettings deep-merges and clamps', () => {
  const defaults = helpers.defaultSettings()
  assert.equal(defaults.mermaid.enabled, true)
  const merged = helpers.mergeSettings({
    mermaid: { enabled: false, theme: 'purple', debounceMs: 10, maxSourceChars: 10 },
    detection: { heuristic: false, extraKeywords: ['  init  ', 'init', '', 'x'.repeat(80), 42] },
    unknown: { kept: true },
  }, defaults)
  assert.equal(merged.mermaid.enabled, false)
  assert.equal(merged.mermaid.theme, 'auto', 'illegal theme falls back to the base value')
  assert.equal(merged.mermaid.debounceMs, 200, 'debounce clamped to the minimum')
  assert.equal(merged.mermaid.maxSourceChars, 2000, 'source length clamped to the minimum')
  assert.equal(merged.detection.heuristic, false)
  assert.deepEqual([...merged.detection.extraKeywords], ['init'], 'too-long and duplicate keywords are dropped')
  assert.equal('unknown' in merged, false)
  assert.equal(merged.echarts.enabled, true)
})

test('firstMeaningfulLine skips frontmatter, comments, and blanks', () => {
  assert.equal(helpers.firstMeaningfulLine('\n\nflowchart TD\nA-->B'), 'flowchart TD')
  assert.equal(helpers.firstMeaningfulLine('%% note\n%% another\nsequenceDiagram\nA->>B: hi'), 'sequenceDiagram')
  assert.equal(helpers.firstMeaningfulLine('---\ntitle: demo\n---\ngraph LR\nA-->B'), 'graph LR')
  assert.equal(helpers.firstMeaningfulLine('   \n\n'), '')
})

test('detectFenceKind recognizes Mermaid, ECharts, and CSV', () => {
  assert.equal(helpers.detectFenceKind('flowchart TD\nA[Start] --> B[End]'), 'mermaid')
  assert.equal(helpers.detectFenceKind('mindmap\n  root((中心))\n    A'), 'mermaid')
  assert.equal(helpers.detectFenceKind('C4Context\n  title Demo'), 'mermaid')
  assert.equal(helpers.detectFenceKind('%%{init: {"theme":"dark"}}%%\nsequenceDiagram\nA->>B: hi'), 'mermaid')
  assert.equal(helpers.detectFenceKind(JSON.stringify({
    xAxis: { type: 'category', data: ['a', 'b'] },
    yAxis: { type: 'value' },
    series: [{ type: 'bar', data: [1, 2] }],
  })), 'echarts')
  assert.equal(helpers.detectFenceKind('option = {\n  "series": [{ "type": "line", "data": [1, 2, 3] }]\n}'), 'echarts')
  assert.equal(helpers.detectFenceKind('a,b\n1,2\n3,4'), 'csv')
})

test('detectFenceKind leaves ordinary code, plain JSON, and one-row text alone', () => {
  assert.equal(helpers.detectFenceKind('const x = 1\nconst y = 2'), null)
  assert.equal(helpers.detectFenceKind('{"name": "demo", "value": 3}'), null)
  assert.equal(helpers.detectFenceKind('single line only'), null)
  assert.equal(helpers.detectFenceKind('a,b,c\n1,2'), null, 'ragged columns are not CSV')
  assert.equal(helpers.detectFenceKind(''), null)
})

test('parseEchartsOption accepts bare JSON and assignment wrappers', () => {
  const bare = helpers.parseEchartsOption('{"series":[{"type":"pie","data":[]}]}')
  assert.equal(bare.series[0].type, 'pie')
  const wrapped = helpers.parseEchartsOption('const option = {"dataset":{"source":[]},"xAxis":{}};')
  assert.equal(Array.isArray(wrapped.dataset.source), true)
  assert.equal(helpers.parseEchartsOption('{"foo":1}'), null)
  assert.equal(helpers.parseEchartsOption('not json'), null)
})

test('splitCsvLine honors quotes and escaped quotes', () => {
  assert.deepEqual([...helpers.splitCsvLine('a,b,c')], ['a', 'b', 'c'])
  assert.deepEqual([...helpers.splitCsvLine('"a,b",c,"d""e"')], ['a,b', 'c', 'd"e'])
  assert.equal(helpers.splitCsvLine('"unterminated'), null)
  assert.deepEqual([...helpers.splitCsvLine('  x  , y ')][0], 'x')
})

test('parseCsv builds a rectangular table or rejects ragged input', () => {
  const table = helpers.parseCsv('name,count\n"alpha, one",12\nbeta,7')
  assert.deepEqual([...table.header], ['name', 'count'])
  assert.deepEqual([...table.rows[0]], ['alpha, one', '12'])
  assert.equal(helpers.parseCsv('a,b\n1,2,3'), null)
})

test('renderCsvTable escapes every cell', () => {
  const html = helpers.renderCsvTable({
    header: ['<script>', 'b'],
    rows: [['x&y', '"quoted"']],
  })
  assert.match(html, /&lt;script&gt;/)
  assert.match(html, /x&amp;y/)
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /&quot;quoted&quot;/)
})

test('clampZoom bounds the fullscreen viewer scale', () => {
  assert.equal(helpers.clampZoom(0.001), 0.02)
  assert.equal(helpers.clampZoom(999), 20)
  assert.equal(helpers.clampZoom(Number.NaN), 1)
})

test('mergeSettings normalizes the appearance group', () => {
  const merged = helpers.mergeSettings({
    appearance: {
      table: 'dsh',
      inlineCode: 'brand',
      codeBlock: 'minimal',
      codeFont: 'custom',
      customCodeFont: ' "Mono"; {} ',
      codeFontSize: 99,
      codeLineHeight: 0.2,
      codeLigatures: true,
      collapseUserMessages: false,
      userMessageMaxHeight: 9999,
    },
    typography: {
      textFontFamily: ' "UI"; {} ',
      textFontSize: 99,
      codeFontSize: 5,
      terminalFontSize: 999,
    },
    uiScale: 1.2,
  }, helpers.defaultSettings())
  assert.equal(merged.appearance.table, 'dsh')
  assert.equal(merged.appearance.inlineCode, 'claude', 'the legacy brand value maps to the Claude chip')
  assert.equal(merged.appearance.codeBlock, 'minimal')
  assert.equal(merged.appearance.codeFont, 'custom')
  assert.equal(merged.appearance.customCodeFont, '"Mono"')
  assert.equal(merged.appearance.codeFontSize, 20)
  assert.equal(merged.appearance.codeLineHeight, 1.4)
  assert.equal(merged.appearance.codeLigatures, true)
  assert.equal(merged.appearance.collapseUserMessages, false)
  assert.equal(merged.appearance.userMessageMaxHeight, 800)
  assert.equal(merged.typography.textFontFamily, '"UI"')
  assert.equal(merged.typography.textFontSize, 22)
  assert.equal(merged.typography.codeFontSize, 10)
  assert.equal(merged.typography.terminalFontSize, 20)
  assert.equal(merged.uiScale, 1.2)
})

test('appearanceCss scopes the Claude styles to Markdown regions', () => {
  const defaults = helpers.defaultSettings()
  const css = helpers.appearanceCss(defaults)
  assert.match(css, /\[data-chat-flow\], \[data-document-markdown\]/)
  assert.match(css, /\.md-code-block \{ border:1px solid/)
  assert.match(css, /:is\(\[data-chat-flow\], \[data-document-markdown\]\) table/)
  assert.match(css, /background:rgba\(0,0,0,\.055\)/)
  assert.match(css, /font-weight:600/)
  assert.match(css, /font-weight:400/)
  assert.match(css, /text-decoration-line: underline !important; text-decoration-style: dotted !important/)
  assert.match(css, /class\*="fileMention"/)
  assert.match(css, /class\*="fileLink"/)
  assert.match(css, /text-decoration-thickness: 2px !important/)
  assert.match(css, /table-layout:fixed !important/)
  assert.match(css, /box-sizing:border-box !important/)
  assert.match(css, /div:has\(> table\) \{ width:100% !important; max-width:100% !important; \}/)
  assert.match(css, /width:var\(--dsh-chat-content-width, 100%\) !important/)
  assert.match(css, /margin-left:0 !important; padding-left:0 !important; overflow-x:hidden !important/)
  assert.match(css, /\.md-table-wide \{ width:100% !important; max-width:100% !important; margin-left:0 !important; padding-left:0 !important; overflow-x:hidden !important; padding-bottom:0 !important; \}/)
  assert.match(css, /overflow-wrap:anywhere/)
  assert.match(css, /--dsw-alias-link/)
  assert.match(css, /border:1px solid var\(--dsw-alias-border-l2/)
  assert.match(css, /table \{ border-collapse:separate; border-spacing:0; border:1px solid var\(--dsw-alias-border-l2/)
  assert.match(css, /th \{ background:rgba\(0,0,0,\.05\)/)
  assert.match(css, /color:var\(--dsw-alias-label-primary, #1c1d20\)/)
  assert.match(css, /font-size:var\(--dsh-content-font-size, 14px\)/)
  assert.match(css, /--dshrender-user-max-height: 360px/)
  assert.doesNotMatch(css, /tbody tr:hover/)
  assert.match(css, /table \{ border-collapse:separate; border-spacing:0; border:1px solid/)
  const plain = helpers.appearanceCss(helpers.mergeSettings({
    appearance: { inlineCode: 'dsh', table: 'dsh', codeBlock: 'dsh' },
  }, defaults))
  assert.doesNotMatch(plain, /:not\(pre\) > code \{ color:color-mix/)
  assert.match(plain, /text-decoration-style: dotted !important/)
  assert.doesNotMatch(plain, /background:rgba\(0,0,0,\.055\)/)
  assert.doesNotMatch(plain, /\.md-code-block \{ border/)
})

test('appearanceCss applies code font overrides and custom stacks', () => {
  const custom = helpers.mergeSettings({
    appearance: {
      codeFont: 'custom',
      customCodeFont: '"My Mono", monospace',
      codeFontSize: 15,
      codeLineHeight: 1.7,
      codeLigatures: true,
    },
  }, helpers.defaultSettings())
  const css = helpers.appearanceCss(custom)
  assert.match(css, /font-family:"My Mono", monospace;/)
  assert.match(css, /font-size:15px;/)
  assert.match(css, /line-height:1.7;/)
  assert.match(css, /font-variant-ligatures:normal;/)
})

test('clampUiScale keeps the reserved uiScale field in range', () => {
  assert.equal(helpers.clampUiScale(2), 1.3)
  assert.equal(helpers.clampUiScale(0.5), 0.8)
  const merged = helpers.mergeSettings({ uiScale: 1.15 }, helpers.defaultSettings())
  assert.equal(merged.uiScale, 1.15)
})

test('shouldCollapseUserMessage only folds bubbles taller than the threshold', () => {
  assert.equal(helpers.shouldCollapseUserMessage(400, 360), true)
  assert.equal(helpers.shouldCollapseUserMessage(380, 360), false)
  assert.equal(helpers.shouldCollapseUserMessage(100, 9999), false)
  assert.equal(helpers.clampUserMessageMaxHeight(10), 160)
  assert.equal(helpers.clampUserMessageMaxHeight(9999), 800)
})

test('hashString is stable and distinguishes content', () => {
  assert.equal(helpers.hashString('flowchart TD\nA-->B'), helpers.hashString('flowchart TD\nA-->B'))
  assert.notEqual(helpers.hashString('a'), helpers.hashString('b'))
})

test('detectFenceKind uses the banner language and rejects assignment-like heads', () => {
  // A Python fence whose first line starts with a Mermaid keyword must stay code.
  assert.equal(helpers.detectFenceKind('graph = nx.Graph()\nfor n in g: pass', 'python'), null)
  assert.equal(helpers.detectFenceKind('pie = 3.14\nprint(pie)', 'python'), null)
  assert.equal(helpers.detectFenceKind('graph = nx.Graph()\nfor n in g: pass'), null)
  assert.equal(helpers.detectFenceKind('pie = 3.14\nprint(pie)'), null)
  // The same head is a diagram when no code language is declared.
  assert.equal(helpers.detectFenceKind('flowchart TD\nA-->B', 'mermaid'), 'mermaid')
  // JSON/CSV/echarts fences still go through the structural detectors.
  assert.equal(helpers.detectFenceKind('{"xAxis":{},"series":[]}', 'json'), 'echarts')
  assert.equal(helpers.detectFenceKind('a,b\n1,2\n3,4', 'csv'), 'csv')
})

test('detectFenceKind prefers structured CSV over the Mermaid head heuristic', () => {
  assert.equal(helpers.detectFenceKind('graph,score\nA,1\nB,2'), 'csv')
  assert.equal(helpers.detectFenceKind('graph,score\nA,1\nB,2'), 'csv')
  assert.equal(helpers.detectFenceKind('pie,value\nA,3\nB,4'), 'csv')
  assert.equal(helpers.detectFenceKind('flowchart TD\nA-->B\nB-->C'), 'mermaid')
})

test('parseKeywordLines trims, dedupes, drops over-long lines, and caps the list', () => {
  assert.deepEqual(
    [...helpers.parseKeywordLines('  init  \n\ninit\n' + 'x'.repeat(80) + '\n foo ')],
    ['init', 'foo'],
  )
  assert.equal(helpers.parseKeywordLines('').length, 0)
  const many = Array.from({ length: 60 }, (_, index) => 'k' + index).join('\n')
  assert.equal(helpers.parseKeywordLines(many).length, 50)
})

test('normalizeLightBackground canonicalizes hex colors', () => {
  assert.equal(helpers.normalizeLightBackground('#f6f5f1'), '#F6F5F1')
  assert.equal(helpers.normalizeLightBackground('FFF'), '#FFFFFF')
  assert.equal(helpers.normalizeLightBackground(' #abc '), '#AABBCC')
  assert.equal(helpers.normalizeLightBackground('#F6F5F1'), '#F6F5F1')
  assert.equal(helpers.normalizeLightBackground('red'), '')
  assert.equal(helpers.normalizeLightBackground('#GGGGGG'), '')
  assert.equal(helpers.normalizeLightBackground(''), '')
  assert.equal(helpers.normalizeLightBackground(42), '')
  assert.equal(helpers.normalizeLightBackground(null), '')
})

test('mergeSettings normalizes the light-theme background color', () => {
  assert.equal(helpers.defaultSettings().appearance.lightBackground, '#FCFCFB')
  const merged = helpers.mergeSettings({ appearance: { lightBackground: '#efede6' } }, helpers.defaultSettings())
  assert.equal(merged.appearance.lightBackground, '#EFEDE6')
  const cleared = helpers.mergeSettings({ appearance: { lightBackground: '' } }, helpers.defaultSettings())
  assert.equal(cleared.appearance.lightBackground, '', 'an empty value disables the override')
  const invalid = helpers.mergeSettings({ appearance: { lightBackground: 'nope' } }, helpers.defaultSettings())
  assert.equal(invalid.appearance.lightBackground, '')
  const typed = helpers.mergeSettings({ appearance: { lightBackground: 42 } }, helpers.defaultSettings())
  assert.equal(typed.appearance.lightBackground, '#FCFCFB', 'non-string keeps the base value')
})

test('buildLightThemeOverrides stacks warm light surfaces and stock dark values', () => {
  const overrides = helpers.buildLightThemeOverrides('#FCFCFB')
  assert.ok(overrides !== null)
  assert.equal(overrides['--dsw-alias-bg-base'].light, '#FCFCFB')
  assert.equal(overrides['--dsw-alias-bg-layer-1'].light, '#FCFCFB')
  assert.equal(overrides['--dsw-specific-sidebar-fill'].light, '#F6F6F5', 'sidebar sits six channels below the base')
  assert.equal(overrides['--dsw-alias-markdown-code-block'].light, '#F6F6F5')
  assert.equal(overrides['--dsw-alias-markdown-inline-code'].light, '#F7F7F6', 'inline code sits five channels below')
  assert.equal(overrides['--dsw-alias-bg-overlay'].light, '#E6E6E5', 'overlay sits twenty-two channels below')
  assert.match(overrides['--dsw-alias-bg-base'].dark, /^var\(--dsw-static-neutral-bluish-950, rgb\(21, 21, 23\)\)$/)
  assert.match(overrides['--dsw-alias-bg-layer-2'].dark, /^var\(--dsw-static-neutral-bluish-850, rgb\(44, 44, 46\)\)$/)

  // Every alias token carries both palette modes; the light value is a
  // readable shade (channel floor) so a user pick cannot kill label contrast.
  for (const [token, value] of Object.entries(overrides)) {
    assert.match(token, /^--dsw-(alias|specific)-/)
    assert.match(value.light, /^#[0-9A-F]{6}$/)
    assert.match(value.dark, /^var\(--dsw-static-/)
    const channels = [0, 2, 4].map(index => Number.parseInt(value.light.slice(1 + index, 3 + index), 16))
    for (const channel of channels) assert.ok(channel >= 200, token + ' stays readable: ' + value.light)
  }

  assert.equal(helpers.buildLightThemeOverrides(''), null, 'empty disables the layer')
  assert.equal(helpers.buildLightThemeOverrides('red'), null)
})

test('buildLightThemeOverrides floors near-black picks to a readable surface', () => {
  const overrides = helpers.buildLightThemeOverrides('#000000')
  assert.equal(overrides['--dsw-alias-bg-base'].light, '#C8C8C8')
  assert.equal(overrides['--dsw-alias-bg-overlay'].light, '#C8C8C8', 'derived shades never go below the floor')
  const white = helpers.buildLightThemeOverrides('#FFFFFF')
  assert.equal(white['--dsw-alias-bg-base'].light, '#FFFFFF')
  assert.equal(white['--dsw-specific-sidebar-fill'].light, '#F9F9F9')
})

/**
 * Load the browser bundle in a throwaway VM with a minimal browser/Сordis
 * harness and run `apply(ctx)` once. The fake theme service records every
 * override layer so tests can assert the wiring, not just the pure helpers.
 * @param {Record<string, any>} hostSettings - settings the fake Host returns.
 * @returns {{ overrides: object[], registered: string[] }}
 */
function runApply(hostSettings) {
  const layers = []
  const registered = []
  const element = () => ({
    id: '',
    textContent: '',
    className: '',
    style: {},
    setAttribute() {},
    removeAttribute() {},
    appendChild() {},
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  })
  const sandbox = {
    window: {
      __ModuleLoader__: { load(registration) { sandbox.__registration = registration } },
      localStorage: { getItem: () => null, setItem: () => {} },
      addEventListener() {},
      removeEventListener() {},
    },
    document: {
      body: {
        ...element(),
        hasAttribute: () => false,
      },
      documentElement: { hasAttribute: () => false },
      head: { appendChild() {} },
      createElement: () => element(),
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {},
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    HTMLElement: class {},
    Element: class {},
    Node: class {},
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval() {},
    fetch: async () => ({
      ok: true,
      json: async () => ({ ok: true, value: { settings: hostSettings, vendor: {} } }),
    }),
    __DSH_RENDER_TEST__: true,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  const react = {
    createElement: () => null,
    useCallback: fn => fn,
    useEffect: () => {},
    useMemo: factory => factory(),
    useRef: () => ({ current: null }),
    useState: value => [value, () => {}],
  }
  const plugin = sandbox.__registration.factory(specifier => {
    if (specifier === 'react') return react
    throw new Error('unexpected module: ' + specifier)
  })
  const ctx = {
    locale: { bind: () => key => key, register: () => () => {} },
    effect(fn) {
      fn()
      return () => {}
    },
    slots: {
      inject(name, callback) {
        registered.push(name)
        callback()
      },
      register() {
        return () => {}
      },
    },
    inject(dependencies, callback) {
      if (!dependencies.includes('theme')) return
      callback({
        theme: {
          overrideTokens(layerSource, tokens) {
            const layer = { layerSource, tokens, disposed: false }
            layers.push(layer)
            return () => {
              layer.disposed = true
            }
          },
        },
        effect(fn) {
          fn()
          return () => {}
        },
      })
    },
    logger: { warn() {} },
  }
  plugin.apply(ctx)
  return { layers, registered }
}

test('apply stacks the light theme override through ctx.theme', async () => {
  const { layers, registered } = runApply({
    mermaid: { enabled: false },
    appearance: { lightBackground: '#EFEDE6' },
  })
  // Let the fake /state response settle: the startup layer lands immediately,
  // the accepted Host value restacks it right after.
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(layers.length >= 2, 'theme layer is stacked on startup and after /state')
  const layer = layers.at(-1)
  assert.equal(layer.layerSource, 'dsh-render')
  assert.equal(layer.tokens['--dsw-alias-bg-base'].light, '#EFEDE6')
  assert.equal(layer.tokens['--dsw-alias-bg-base'].dark, 'var(--dsw-static-neutral-bluish-950, rgb(21, 21, 23))')
  assert.equal(Object.keys(layer.tokens).length, helpers.LIGHT_THEME_TOKENS.length)
  // The row is contributed to the General section, the page to settings.
  assert.ok(registered.includes('settings.general.item'))
  assert.ok(registered.includes('settings.section'))
})

test('apply with an empty lightBackground keeps the stock palette', async () => {
  const { layers } = runApply({
    mermaid: { enabled: false },
    appearance: { lightBackground: '' },
  })
  await new Promise(resolve => setTimeout(resolve, 20))
  // The startup default is stacked first; the empty Host value only disposes
  // it (an empty value never stacks a layer), leaving the stock palette.
  assert.equal(layers.length, 1)
  assert.equal(layers[0].disposed, true)
})

test('apply keeps the local color when the running Host predates the setting', async () => {
  // An older Host normalizer drops unknown fields, so its document carries no
  // lightBackground key at all. The forward-compatible merge keeps the local
  // value instead of snapping back to the recommended color.
  const { layers } = runApply({ mermaid: { enabled: false } })
  await new Promise(resolve => setTimeout(resolve, 20))
  const last = layers.at(-1)
  assert.equal(last.tokens['--dsw-alias-bg-base'].light, '#FCFCFB')
  assert.equal(last.tokens['--dsw-specific-sidebar-fill'].light, '#F6F6F5')
})
