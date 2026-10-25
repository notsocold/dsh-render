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

test('fitTransform centers and scales content inside the viewport', () => {
  const fitted = helpers.fitTransform(400, 200, 1000, 600)
  assert.ok(Math.abs(fitted.scale - 2.35) < 1e-9, 'scale uses the limiting axis')
  assert.ok(Math.abs(fitted.x - 30) < 1e-9, 'content is horizontally centered')
  assert.ok(Math.abs(fitted.y - 65) < 1e-9, 'content is vertically centered')
})

test('fitTransform guards empty sizes and clampZoom bounds external scales', () => {
  assert.deepEqual({ ...helpers.fitTransform(0, 200, 1000, 600) }, { scale: 1, x: 0, y: 0 })
  assert.equal(helpers.clampZoom(0.001), 0.02)
  assert.equal(helpers.clampZoom(999), 20)
  assert.equal(helpers.clampZoom(Number.NaN), 1)
})

test('zoomAt keeps the pointer anchor fixed', () => {
  const next = helpers.zoomAt({ scale: 1, x: 100, y: 50 }, 2, 300, 200)
  assert.equal(next.scale, 2)
  assert.equal(next.x, -100)
  assert.equal(next.y, -100)
  assert.equal((300 - next.x) / next.scale, 200, 'anchor X stays over the same content point')
  assert.equal((200 - next.y) / next.scale, 150, 'anchor Y stays over the same content point')
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
  assert.match(css, /table-layout:fixed !important/)
  assert.match(css, /box-sizing:border-box !important/)
  assert.match(css, /overflow-wrap:anywhere/)
  assert.match(css, /div:has\(> table\) \{ width:100% !important; max-width:100% !important; \}/)
  assert.match(css, /width:var\(--dsh-chat-content-width, 100%\) !important/)
  assert.match(css, /margin-left:0 !important; padding-left:0 !important; overflow-x:hidden !important/)
  assert.match(css, /\.md-table-wide \{ width:100% !important; max-width:100% !important; margin-left:0 !important; padding-left:0 !important; overflow-x:hidden !important; padding-bottom:0 !important; \}/)
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
  assert.doesNotMatch(plain, /--dsw-alias-link/)
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

test('typographyCss emits body variable overrides for the General page', () => {
  const settings = helpers.mergeSettings({
    typography: { textFontFamily: '"My UI", sans-serif', textFontSize: 18, codeFontSize: 0, terminalFontSize: 14 },
  }, helpers.defaultSettings())
  const css = helpers.typographyCss(settings)
  assert.match(css, /^body \{/)
  assert.match(css, /--dsh-font-family-text:"My UI", sans-serif !important;/)
  assert.match(css, /--dsh-content-font-size:18px !important;/)
  assert.doesNotMatch(css, /--dsh-code-font-size/)
  assert.match(css, /--dsh-terminal-font-size:14px !important;/)
  assert.equal(helpers.typographyCss(helpers.defaultSettings()), '')
  assert.equal(helpers.clampTypographySize(5, 10, 22), 10)
  assert.equal(helpers.clampTypographySize(0, 10, 22), 0)
  assert.equal(helpers.clampTypographySize(99, 10, 22), 22)
})

test('zoomCss emits a body zoom rule and clamps the scale', () => {
  assert.equal(helpers.zoomCss(helpers.defaultSettings()), '')
  const zoomed = helpers.mergeSettings({ uiScale: 1.15 }, helpers.defaultSettings())
  assert.equal(helpers.zoomCss(zoomed), 'body { zoom: 1.15; }')
  assert.equal(helpers.clampUiScale(2), 1.3)
  assert.equal(helpers.clampUiScale(0.5), 0.8)
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
