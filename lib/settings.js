/**
 * Persistent settings for the dsh-render plugin.
 *
 * The document lives at `$DSH_HOME/dsh-render/settings.json` and is written
 * atomically (same-directory temp file + rename). A corrupt file is preserved
 * beside the new one instead of taking the plugin down. Normalization is
 * deliberately strict: unknown fields are dropped, invalid values keep the
 * previous value, and bounded numbers are clamped.
 *
 * @module dsh-render/lib/settings
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Current settings document schema version. */
export const SETTINGS_VERSION = 1

/** Directory name below `$DSH_HOME` owned by this plugin. */
export const PLUGIN_DIR_NAME = 'dsh-render'

/** Accepted Mermaid themes. */
export const MERMAID_THEMES = Object.freeze(['auto', 'light', 'dark'])

/** `mermaid.debounceMs` bounds (inclusive). */
export const DEBOUNCE_BOUNDS = Object.freeze({ min: 200, max: 3000 })

/** `mermaid.maxSourceChars` bounds (inclusive). */
export const MAX_SOURCE_CHARS_BOUNDS = Object.freeze({ min: 2000, max: 2000000 })

/** `detection.extraKeywords` bounds. */
export const EXTRA_KEYWORD_LIMITS = Object.freeze({ maxItems: 50, maxLength: 64 })

/** Markdown appearance choices for tables, inline code, and code blocks. */
export const APPEARANCE_CHOICES = Object.freeze({
  table: ['claude', 'dsh'],
  inlineCode: ['claude', 'dsh'],
  inlineCodeColor: ['inherit', 'blue', 'red', 'custom'],
  codeBlock: ['claude', 'minimal', 'dsh'],
  codeFont: ['inherit', 'system', 'jetbrains', 'fira', 'cascadia', 'sfmono', 'consolas', 'menlo', 'custom'],
})

/** Inline-code text color picked from the image sample (its chip background is already the Claude chip). */
export const INLINE_CODE_IMAGE_COLOR = '#8E2626'

/** Bounds for the plugin-owned Markdown code appearance overrides. */
export const CODE_APPEARANCE_BOUNDS = Object.freeze({
  fontSize: { min: 12, max: 20 },
  lineHeight: { min: 1.4, max: 1.9 },
  customFontMaxLength: 200,
})

/** Bounds for the long user-message collapse height. */
export const USER_MESSAGE_BOUNDS = Object.freeze({
  minHeight: 160,
  maxHeight: 800,
  defaultHeight: 360,
})

/** Bounds for the General-page typography overrides; 0 keeps the native value. */
export const TYPOGRAPHY_BOUNDS = Object.freeze({
  textFontSize: { min: 10, max: 22 },
  codeFontSize: { min: 10, max: 16 },
  terminalFontSize: { min: 10, max: 20 },
})

/** Bounds for the whole-interface zoom override (1 = 100%). */
export const UI_SCALE_BOUNDS = Object.freeze({ min: 0.8, max: 1.3, default: 1 })

/**
 * Default light-theme surface color. The browser half stacks this over the
 * active theme's alias tokens through `ctx.theme.overrideTokens`, turning the
 * stock pure-white light palette into a warm off-white that is easier on the
 * eyes. The empty string disables the override and keeps the stock palette.
 */
export const LIGHT_BACKGROUND_DEFAULT = '#FCFCFB'

/**
 * Normalize one light-theme background color. Accepts `#RGB` / `#RRGGBB`
 * (leading `#` optional) and returns the canonical upper-case `#RRGGBB`;
 * anything else maps to `''`, which keeps the stock light palette.
 * @param {unknown} value - raw color value.
 * @returns {string} canonical color or `''`.
 */
export function normalizeLightBackground(value) {
  if (typeof value !== 'string') return ''
  const match = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(value.trim())
  if (match === null) return ''
  let hex = match[1]
  if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2]
  return `#${hex.toUpperCase()}`
}

/**
 * Fresh default settings. The shape is part of the browser contract and must
 * not change without a schema version bump.
 * @returns {Record<string, any>}
 */
export function defaultSettings() {
  return {
    version: SETTINGS_VERSION,
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
      lightBackground: LIGHT_BACKGROUND_DEFAULT,
      inlineCodeColor: 'blue',
      customInlineCodeColor: INLINE_CODE_IMAGE_COLOR,
    },
    typography: {
      textFontFamily: '',
      textFontSize: 0,
      codeFontSize: 0,
      terminalFontSize: 0,
    },
    uiScale: 1,
  }
}

/**
 * @param {unknown} value - candidate object.
 * @returns {value is Record<string, any>}
 */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Expand a leading `~` or `~/` against the current user's home directory.
 * @param {string} value - path text.
 * @returns {string} expanded path.
 */
export function expandHome(value) {
  if (typeof value !== 'string') return ''
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

/**
 * Resolve the Harness home directory (explicit, `$DSH_HOME`, or `~/.dsh`).
 * @param {string} [explicit] - explicit override.
 * @returns {string} absolute path.
 */
export function resolveDshHome(explicit) {
  const explicitHome = typeof explicit === 'string' ? explicit.trim() : ''
  const envHome = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  const raw = explicitHome !== '' ? explicitHome : envHome !== '' ? envHome : join(homedir(), '.dsh')
  return resolve(expandHome(raw))
}

/**
 * Reduce an arbitrary thrown value to a bounded message.
 * @param {unknown} error - thrown value.
 * @returns {string}
 */
export function errorMessage(error) {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > 500 ? `${text.slice(0, 497)}...` : text
}

/**
 * Whether an fs error means "the path does not exist".
 * @param {unknown} error - caught fs error.
 * @returns {boolean}
 */
export function isMissing(error) {
  const code = /** @type {{ code?: unknown }} */ (error)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * Create a plugin error carrying a stable machine code.
 * @param {string} code - stable error code.
 * @param {string} message - readable reason.
 * @returns {Error & { code: string }}
 */
export function settingsError(code, message) {
  const error = new Error(message)
  const coded = /** @type {Error & { code: string }} */ (error)
  coded.code = code
  return coded
}

/**
 * Clean one incoming keyword list: trim, drop empties and over-long entries,
 * dedupe exactly, and bound the total count. Mirrors the Web half's
 * normalizer so a round trip never changes the saved list.
 * @param {unknown[]} value - raw keyword list.
 * @returns {string[]}
 */
function cleanKeywords(value) {
  const seen = new Set()
  const result = []
  for (const candidate of value) {
    if (typeof candidate !== 'string') continue
    const keyword = candidate.trim()
    if (keyword === '' || keyword.length > EXTRA_KEYWORD_LIMITS.maxLength || seen.has(keyword)) continue
    seen.add(keyword)
    result.push(keyword)
    if (result.length >= EXTRA_KEYWORD_LIMITS.maxItems) break
  }
  return result
}

/**
 * Clean one custom font stack: drop control characters and CSS-breaking
 * punctuation, then bound the length. The Web half applies the same rule.
 * @param {unknown} value - raw font stack.
 * @returns {string}
 */
export function cleanCustomFont(value) {
  if (typeof value !== 'string') return ''
  return value
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[;{}<>\\]/g, '')
    .trim()
    .slice(0, CODE_APPEARANCE_BOUNDS.customFontMaxLength)
}

/**
 * Copy every recognized field from `raw` onto `target`, validating types and
 * clamping bounded numbers. Unknown fields are ignored.
 * @param {Record<string, any>} target - settings document being built.
 * @param {unknown} raw - candidate partial document.
 * @returns {void}
 */
function applyKnownSettings(target, raw) {
  if (!isRecord(raw)) return

  if (isRecord(raw.mermaid)) {
    const mermaid = raw.mermaid
    if (typeof mermaid.enabled === 'boolean') target.mermaid.enabled = mermaid.enabled
    if (typeof mermaid.theme === 'string' && MERMAID_THEMES.includes(mermaid.theme)) {
      target.mermaid.theme = mermaid.theme
    }
    if (typeof mermaid.debounceMs === 'number' && Number.isFinite(mermaid.debounceMs)) {
      target.mermaid.debounceMs = Math.min(
        DEBOUNCE_BOUNDS.max,
        Math.max(DEBOUNCE_BOUNDS.min, Math.round(mermaid.debounceMs)),
      )
    }
    if (
      typeof mermaid.maxSourceChars === 'number'
      && Number.isFinite(mermaid.maxSourceChars)
    ) {
      target.mermaid.maxSourceChars = Math.min(
        MAX_SOURCE_CHARS_BOUNDS.max,
        Math.max(MAX_SOURCE_CHARS_BOUNDS.min, Math.round(mermaid.maxSourceChars)),
      )
    }
  }

  if (isRecord(raw.echarts) && typeof raw.echarts.enabled === 'boolean') {
    target.echarts.enabled = raw.echarts.enabled
  }

  if (isRecord(raw.csv) && typeof raw.csv.enabled === 'boolean') {
    target.csv.enabled = raw.csv.enabled
  }

  if (isRecord(raw.detection)) {
    if (typeof raw.detection.heuristic === 'boolean') {
      target.detection.heuristic = raw.detection.heuristic
    }
    if (Array.isArray(raw.detection.extraKeywords)) {
      target.detection.extraKeywords = cleanKeywords(raw.detection.extraKeywords)
    }
  }

  if (isRecord(raw.prompt) && typeof raw.prompt.enabled === 'boolean') {
    target.prompt.enabled = raw.prompt.enabled
  }

  if (isRecord(raw.appearance)) {
    const appearance = raw.appearance
    if (typeof appearance.table === 'string' && APPEARANCE_CHOICES.table.includes(appearance.table)) {
      target.appearance.table = appearance.table
    }
    if (appearance.inlineCode === 'brand') {
      // Legacy value from the first ink-pill iteration; the Claude grey chip
      // is the current default.
      target.appearance.inlineCode = 'claude'
    } else if (typeof appearance.inlineCode === 'string' && APPEARANCE_CHOICES.inlineCode.includes(appearance.inlineCode)) {
      target.appearance.inlineCode = appearance.inlineCode
    }
    if (typeof appearance.codeBlock === 'string' && APPEARANCE_CHOICES.codeBlock.includes(appearance.codeBlock)) {
      target.appearance.codeBlock = appearance.codeBlock
    }
    if (typeof appearance.codeFont === 'string' && APPEARANCE_CHOICES.codeFont.includes(appearance.codeFont)) {
      target.appearance.codeFont = appearance.codeFont
    }
    if (typeof appearance.customCodeFont === 'string') {
      target.appearance.customCodeFont = cleanCustomFont(appearance.customCodeFont)
    }
    if (typeof appearance.codeFontSize === 'number' && Number.isFinite(appearance.codeFontSize)) {
      const size = Math.round(appearance.codeFontSize)
      target.appearance.codeFontSize = size === 0
        ? 0
        : Math.min(CODE_APPEARANCE_BOUNDS.fontSize.max, Math.max(CODE_APPEARANCE_BOUNDS.fontSize.min, size))
    }
    if (typeof appearance.codeLineHeight === 'number' && Number.isFinite(appearance.codeLineHeight)) {
      const rounded = Math.round(appearance.codeLineHeight * 100) / 100
      target.appearance.codeLineHeight = rounded === 0
        ? 0
        : Math.min(
          CODE_APPEARANCE_BOUNDS.lineHeight.max,
          Math.max(CODE_APPEARANCE_BOUNDS.lineHeight.min, rounded),
        )
    }
    if (typeof appearance.codeLigatures === 'boolean') {
      target.appearance.codeLigatures = appearance.codeLigatures
    }
    if (typeof appearance.collapseUserMessages === 'boolean') {
      target.appearance.collapseUserMessages = appearance.collapseUserMessages
    }
    if (typeof appearance.userMessageMaxHeight === 'number' && Number.isFinite(appearance.userMessageMaxHeight)) {
      target.appearance.userMessageMaxHeight = Math.min(
        USER_MESSAGE_BOUNDS.maxHeight,
        Math.max(USER_MESSAGE_BOUNDS.minHeight, Math.round(appearance.userMessageMaxHeight)),
      )
    }
    if (typeof appearance.lightBackground === 'string') {
      target.appearance.lightBackground = normalizeLightBackground(appearance.lightBackground)
    }
    if (typeof appearance.inlineCodeColor === 'string'
      && APPEARANCE_CHOICES.inlineCodeColor.includes(appearance.inlineCodeColor)) {
      target.appearance.inlineCodeColor = appearance.inlineCodeColor
    }
    if (typeof appearance.customInlineCodeColor === 'string') {
      target.appearance.customInlineCodeColor = normalizeLightBackground(appearance.customInlineCodeColor)
    }
  }

  if (isRecord(raw.typography)) {
    if (typeof raw.typography.textFontFamily === 'string') {
      target.typography.textFontFamily = cleanCustomFont(raw.typography.textFontFamily)
    }
    for (const key of /** @type {const} */ (['textFontSize', 'codeFontSize', 'terminalFontSize'])) {
      const value = raw.typography[key]
      if (typeof value !== 'number' || !Number.isFinite(value)) continue
      const size = Math.round(value)
      const bounds = TYPOGRAPHY_BOUNDS[key]
      target.typography[key] = size === 0 ? 0 : Math.min(bounds.max, Math.max(bounds.min, size))
    }
  }

  if (typeof raw.uiScale === 'number' && Number.isFinite(raw.uiScale)) {
    const scale = Math.round(raw.uiScale * 100) / 100
    target.uiScale = Math.min(UI_SCALE_BOUNDS.max, Math.max(UI_SCALE_BOUNDS.min, scale))
  }
}

/**
 * Deep-merge a settings patch over a base document with type validation.
 * Arrays (the keyword list) are replaced, not concatenated.
 * @param {unknown} [patch] - partial settings document.
 * @param {unknown} [base] - previous full or partial settings document.
 * @returns {Record<string, any>} a fresh, complete settings document.
 */
export function normalizeSettings(patch = {}, base = defaultSettings()) {
  const result = defaultSettings()
  applyKnownSettings(result, base)
  applyKnownSettings(result, patch)
  result.version = SETTINGS_VERSION
  return result
}

/**
 * @param {Record<string, any>} settings - valid settings document.
 * @returns {Record<string, any>} detached copy.
 */
export function cloneSettings(settings) {
  return structuredClone(settings)
}

/**
 * Owns the on-disk settings document.
 */
export class SettingsStore {
  /**
   * Tail of the serialized mutation queue. Every set/reset/save appends to this
   * chain, so a patch always merges over the document published by the
   * previous write instead of the snapshot captured when it was called.
   * @type {Promise<void>}
   */
  #queue = Promise.resolve()

  /**
   * @param {{ home?: string, logger?: { warn?: (message: string) => void } }} [options]
   */
  constructor(options = {}) {
    /** @type {string} */
    this.home = resolveDshHome(options.home)
    /** @type {string} */
    this.root = join(this.home, PLUGIN_DIR_NAME)
    /** @type {string} */
    this.settingsPath = join(this.root, 'settings.json')
    /** @type {{ warn?: (message: string) => void } | undefined} */
    this.logger = options.logger
    /** @type {Record<string, any>} */
    this.settings = defaultSettings()
    /** @type {boolean} */
    this.loaded = false
  }

  /**
   * Load the settings document. A missing file means defaults; a corrupt file
   * is preserved as `settings.json.bak-<timestamp>` and replaced by defaults.
   * A read failure that is not "missing" degrades to defaults with a warning
   * instead of taking the whole Host plugin down; write failures still throw so
   * they stay observable.
   * @returns {Promise<Record<string, any>>} a detached copy of the settings.
   */
  async load() {
    await mkdir(this.root, { recursive: true })
    let raw
    try {
      raw = await readFile(this.settingsPath, 'utf8')
    } catch (error) {
      if (isMissing(error)) {
        this.settings = defaultSettings()
        this.loaded = true
        return this.get()
      }
      this.logger?.warn?.(
        `dsh-render: cannot read ${this.settingsPath}, using defaults: ${errorMessage(error)}`,
      )
      this.settings = defaultSettings()
      this.loaded = true
      return this.get()
    }

    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      const backupPath = `${this.settingsPath}.bak-${Date.now()}`
      try {
        await rename(this.settingsPath, backupPath)
        this.logger?.warn?.(`dsh-render: preserved corrupt settings at ${backupPath}`)
      } catch (error) {
        this.logger?.warn?.(`dsh-render: cannot preserve corrupt settings: ${errorMessage(error)}`)
      }
      this.settings = defaultSettings()
      this.loaded = true
      return this.get()
    }

    this.settings = normalizeSettings(parsed)
    this.loaded = true
    return this.get()
  }

  /**
   * @returns {Record<string, any>} detached copy of the live settings.
   */
  get() {
    return cloneSettings(this.settings)
  }

  /**
   * Run one mutation after every previously queued mutation has settled.
   * The queue tail swallows failures so one rejected write cannot wedge all
   * later saves; each caller still receives its own rejection.
   * @template T
   * @param {() => Promise<T>} task - mutation to run.
   * @returns {Promise<T>}
   */
  #enqueue(task) {
    const run = this.#queue.then(task)
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * Merge one validated patch, persist it, then publish it. The merge baseline
   * is read when the queued mutation runs, so concurrent patches compose in
   * submission order. A failed write leaves the previous in-memory document
   * untouched.
   * @param {Record<string, any>} patch - partial settings document.
   * @returns {Promise<Record<string, any>>} a detached copy of the new settings.
   */
  async set(patch) {
    if (!isRecord(patch)) throw settingsError('invalid-request', 'settings patch must be an object')
    return this.#enqueue(async () => {
      const next = normalizeSettings(patch, this.settings)
      await this.#write(next)
      this.settings = next
      return this.get()
    })
  }

  /**
   * Restore the defaults and persist them.
   * @returns {Promise<Record<string, any>>} a detached copy of the defaults.
   */
  async reset() {
    return this.#enqueue(async () => {
      const next = defaultSettings()
      await this.#write(next)
      this.settings = next
      return this.get()
    })
  }

  /**
   * Persist the current document (for callers that mutated it directly).
   * @returns {Promise<void>}
   */
  async save() {
    return this.#enqueue(() => this.#write(this.settings))
  }

  /**
   * Atomically write one settings document.
   * @param {Record<string, any>} settings - document to persist.
   * @returns {Promise<void>}
   */
  async #write(settings) {
    await mkdir(this.root, { recursive: true })
    const tmp = join(
      this.root,
      `.settings.json.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
    )
    const body = `${JSON.stringify(settings, null, 2)}\n`
    try {
      await writeFile(tmp, body, 'utf8')
      await rename(tmp, this.settingsPath)
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {})
      throw settingsError('io-error', `cannot write ${this.settingsPath}: ${errorMessage(error)}`)
    }
  }
}
