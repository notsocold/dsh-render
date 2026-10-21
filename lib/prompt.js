/**
 * Optional model-facing guidance for the supported render fences.
 *
 * The section is registered as a dynamic provider: every prompt assembly
 * re-reads the live settings document, so toggling the setting from the Render
 * settings page takes effect on the next turn without reloading the plugin.
 * While `settings.prompt.enabled` is false the provider returns an empty
 * string, which contributes nothing to the system prompt.
 *
 * @module dsh-render/lib/prompt
 */

/** System-prompt section name (also the label shown by the prompt registry). */
export const PROMPT_SECTION = 'dsh-render: fence formats'

/** Section order: after reusable guidance, before the plan policy. */
export const PROMPT_ORDER = 450

/**
 * @param {unknown} settings - live settings document.
 * @returns {string} section text, or an empty string when disabled.
 */
export function promptText(settings) {
  const enabled = /** @type {{ prompt?: { enabled?: unknown } } | undefined} */ (settings)?.prompt?.enabled
  if (enabled !== true) return ''
  return [
    '## Rich rendering fences',
    'This deployment renders three kinds of fenced blocks in the conversation.',
    'Use the matching fence when the content is complete and valid for that renderer:',
    '- `mermaid`: diagrams (flowchart, sequence, class, state, ER, gantt, pie).',
    '- `echarts`: interactive charts; the body is a JSON ECharts option object.',
    '- `csv`: tabular data; the first row is the header row.',
    'Write the fence info string exactly as mermaid, echarts, or csv.',
    'Keep ordinary source code and every other language in their normal code fences.',
    'Do not emit a render fence for partial content or for code the user asked to see as code.',
  ].join('\n')
}

/**
 * Register the dynamic prompt section on a context that exposes
 * `systemPrompt`. Failures are contained so an optional prompt feature can
 * never prevent the Host half from loading.
 * @param {any} ctx - Cordis context with a `systemPrompt` service.
 * @param {{ settings?: Record<string, any>, get?: () => Record<string, any> }} settingsStore - live settings source.
 * @returns {() => void} disposer for the registered section.
 */
export function installPromptSection(ctx, settingsStore) {
  const read = () => {
    try {
      // Prefer the live object: the dynamic provider runs on every assembly.
      if (settingsStore.settings !== undefined) return settingsStore.settings
      if (typeof settingsStore.get === 'function') return settingsStore.get()
      return undefined
    } catch {
      return undefined
    }
  }
  try {
    return ctx.systemPrompt.section({
      name: PROMPT_SECTION,
      order: PROMPT_ORDER,
      text: () => promptText(read()),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger?.warn?.(`dsh-render: cannot register prompt section: ${message}`)
    return () => {}
  }
}
