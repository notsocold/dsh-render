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

test('hashString is stable and distinguishes content', () => {
  assert.equal(helpers.hashString('flowchart TD\nA-->B'), helpers.hashString('flowchart TD\nA-->B'))
  assert.notEqual(helpers.hashString('a'), helpers.hashString('b'))
})
