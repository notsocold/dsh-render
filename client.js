/**
 * dsh-render browser half: rich rendering for fenced code blocks in the DSH
 * Web page.
 *
 * The Host half serves vendored Mermaid (ESM with lazy diagram chunks) and
 * ECharts (UMD) over authenticated `/api/dsh-render/vendor/*` routes and owns
 * the Render settings document. This half is a build-free lazy CommonJS module
 * registered through `window.__ModuleLoader__.load()`: it observes Markdown
 * code blocks rendered by the harness, recognizes Mermaid / ECharts / CSV
 * fences by content, and replaces the code surface with a rendered surface
 * inside the same code card. React keeps owning the card lifecycle, so the
 * original source stays one click away and unmount removes the enhancement.
 *
 * No harness package is imported: React comes from the browser module table and
 * all data arrives over same-origin authenticated HTTP.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-render',
  factory(require) {
    'use strict'

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const NS = 'dsh-render'
    const API_STATE = '/api/dsh-render/state'
    const API_ACTION = '/api/dsh-render/action'
    const VENDOR_BASE = '/api/dsh-render/vendor'
    const MERMAID_ENTRY = VENDOR_BASE + '/mermaid/dist/mermaid.esm.min.mjs'
    const ECHARTS_ENTRY = VENDOR_BASE + '/echarts/echarts.min.js'

    const BLOCK_SELECTOR = '.md-code-block'
    const CONTENT_SELECTOR = '[data-code-block-content]'
    const SURFACE_SELECTOR = '[data-dsh-render-surface]'
    const SKIP_SELECTOR = '[data-dsh-render-skip]'
    const STYLE_ID = 'dsh-render-styles'
    const SETTINGS_ORDER = 31
    const MAX_CONCURRENT = 1
    const RENDER_TIMEOUT_MS = 20000
    const CACHE_LIMIT = 60

    /* ------------------------------ settings ------------------------------ */

    /** Default settings mirror `lib/settings.js`; used before `/state` answers. */
    function defaultSettings() {
      return {
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
     * Clean one custom font stack exactly like the Host normalizer does.
     * @param {unknown} value - raw font stack.
     * @returns {string}
     */
    function cleanCustomFont(value) {
      if (typeof value !== 'string') return ''
      return value
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .replace(/[;{}<>\\]/g, '')
        .trim()
        .slice(0, 200)
    }

    /**
     * Normalize a settings patch the same way the Host does, so a malformed
     * state response cannot break rendering.
     * @param {unknown} patch - partial settings.
     * @param {Record<string, any>} base - current settings.
     * @returns {Record<string, any>}
     */
    function mergeSettings(patch, base) {
      const next = {
        version: 1,
        mermaid: { ...base.mermaid },
        echarts: { ...base.echarts },
        csv: { ...base.csv },
        detection: { ...base.detection, extraKeywords: [...(base.detection?.extraKeywords ?? [])] },
        prompt: { ...base.prompt },
        appearance: {
          ...base.appearance,
          customCodeFont: base.appearance?.customCodeFont ?? '',
        },
        typography: { ...base.typography },
        uiScale: base.uiScale ?? 1,
      }
      if (!isRecord(patch)) return next
      if (isRecord(patch.mermaid)) {
        if (typeof patch.mermaid.enabled === 'boolean') next.mermaid.enabled = patch.mermaid.enabled
        if (patch.mermaid.theme === 'auto' || patch.mermaid.theme === 'light' || patch.mermaid.theme === 'dark') next.mermaid.theme = patch.mermaid.theme
        if (typeof patch.mermaid.debounceMs === 'number' && Number.isFinite(patch.mermaid.debounceMs)) {
          next.mermaid.debounceMs = Math.min(3000, Math.max(200, Math.round(patch.mermaid.debounceMs)))
        }
        if (typeof patch.mermaid.maxSourceChars === 'number' && Number.isFinite(patch.mermaid.maxSourceChars)) {
          next.mermaid.maxSourceChars = Math.min(2000000, Math.max(2000, Math.round(patch.mermaid.maxSourceChars)))
        }
      }
      if (isRecord(patch.echarts) && typeof patch.echarts.enabled === 'boolean') next.echarts.enabled = patch.echarts.enabled
      if (isRecord(patch.csv) && typeof patch.csv.enabled === 'boolean') next.csv.enabled = patch.csv.enabled
      if (isRecord(patch.detection)) {
        if (typeof patch.detection.heuristic === 'boolean') next.detection.heuristic = patch.detection.heuristic
        if (Array.isArray(patch.detection.extraKeywords)) {
          const seen = new Set()
          const keywords = []
          for (const raw of patch.detection.extraKeywords) {
            if (typeof raw !== 'string') continue
            const value = raw.trim()
            if (value === '' || value.length > 64 || seen.has(value)) continue
            seen.add(value)
            keywords.push(value)
            if (keywords.length >= 50) break
          }
          next.detection.extraKeywords = keywords
        }
      }
      if (isRecord(patch.prompt) && typeof patch.prompt.enabled === 'boolean') next.prompt.enabled = patch.prompt.enabled
      if (isRecord(patch.appearance)) {
        const appearance = patch.appearance
        if (appearance.table === 'claude' || appearance.table === 'dsh') next.appearance.table = appearance.table
        if (appearance.inlineCode === 'brand' || appearance.inlineCode === 'claude') next.appearance.inlineCode = 'claude'
        else if (appearance.inlineCode === 'dsh') next.appearance.inlineCode = 'dsh'
        if (appearance.codeBlock === 'claude' || appearance.codeBlock === 'minimal' || appearance.codeBlock === 'dsh') {
          next.appearance.codeBlock = appearance.codeBlock
        }
        if (typeof appearance.codeFont === 'string' && ['inherit', 'system', 'jetbrains', 'fira', 'cascadia', 'sfmono', 'consolas', 'menlo', 'custom'].includes(appearance.codeFont)) {
          next.appearance.codeFont = appearance.codeFont
        }
        if (typeof appearance.customCodeFont === 'string') {
          next.appearance.customCodeFont = cleanCustomFont(appearance.customCodeFont)
        }
        if (typeof appearance.codeFontSize === 'number' && Number.isFinite(appearance.codeFontSize)) {
          const size = Math.round(appearance.codeFontSize)
          next.appearance.codeFontSize = size === 0 ? 0 : Math.min(20, Math.max(12, size))
        }
        if (typeof appearance.codeLineHeight === 'number' && Number.isFinite(appearance.codeLineHeight)) {
          const rounded = Math.round(appearance.codeLineHeight * 100) / 100
          next.appearance.codeLineHeight = rounded === 0 ? 0 : Math.min(1.9, Math.max(1.4, rounded))
        }
        if (typeof appearance.codeLigatures === 'boolean') next.appearance.codeLigatures = appearance.codeLigatures
        if (typeof appearance.collapseUserMessages === 'boolean') next.appearance.collapseUserMessages = appearance.collapseUserMessages
        if (typeof appearance.userMessageMaxHeight === 'number' && Number.isFinite(appearance.userMessageMaxHeight)) {
          next.appearance.userMessageMaxHeight = Math.min(800, Math.max(160, Math.round(appearance.userMessageMaxHeight)))
        }
      }
      if (isRecord(patch.typography)) {
        if (typeof patch.typography.textFontFamily === 'string') {
          next.typography.textFontFamily = cleanCustomFont(patch.typography.textFontFamily)
        }
        for (const [key, min, max] of [['textFontSize', 10, 22], ['codeFontSize', 10, 16], ['terminalFontSize', 10, 20]]) {
          const value = patch.typography[key]
          if (typeof value !== 'number' || !Number.isFinite(value)) continue
          const size = Math.round(value)
          next.typography[key] = size === 0 ? 0 : Math.min(max, Math.max(min, size))
        }
      }
      if (typeof patch.uiScale === 'number' && Number.isFinite(patch.uiScale)) {
        next.uiScale = clampUiScale(patch.uiScale)
      }
      return next
    }

    const runtime = {
      settings: defaultSettings(),
      settingsLoaded: false,
      translate: key => key,
      surfaces: new Set(),
      observers: [],
      disposed: false,
    }

    /* ------------------------------ dictionaries ------------------------------ */

    const zh = {
      nav: '渲染',
      title: '渲染增强',
      intro: '把对话与文档预览中的围栏代码块渲染成 Mermaid 图、ECharts 图表或 CSV 表格。渲染在浏览器内完成，源码始终保留可切换查看。',
      sectionAppearance: 'Markdown 外观',
      appearanceHint: '这些样式只作用于聊天与文档预览中的 Markdown，不修改 DSH 源码。',
      sectionDiagrams: '图表',
      sectionTables: '表格',
      sectionDetection: '识别',
      sectionPrompt: '模型提示',
      mermaidEnabled: '启用 Mermaid 渲染',
      mermaidEnabledHint: '识别 flowchart、sequenceDiagram、classDiagram、stateDiagram、erDiagram、gantt、pie、mindmap、timeline、gitGraph 等围栏。',
      mermaidTheme: 'Mermaid 主题',
      mermaidThemeAuto: '跟随界面',
      mermaidThemeLight: '浅色',
      mermaidThemeDark: '深色',
      echartsEnabled: '启用 ECharts 图表',
      echartsEnabledHint: '识别内容为 ECharts option JSON 的代码块（包含 series、xAxis、dataset 等字段）。',
      csvEnabled: '启用 CSV 表格',
      csvEnabledHint: '识别两行以上、列数一致的逗号分隔文本。',
      debounce: '流式稳定延迟',
      debounceHint: '代码块文本停止变化后再渲染，避免流式输出时闪烁。',
      maxSource: '最大源码长度',
      maxSourceHint: '超过该字符数的代码块保持原样，避免超大图卡住页面。',
      heuristic: '内容启发式识别',
      heuristicHint: '依据首行图类型关键字与 JSON/CSV 结构识别；关闭后只渲染设置中明确列出的额外关键字。',
      extraKeywords: '额外 Mermaid 首行关键字',
      extraKeywordsHint: '每行一个，例如 `%%{init:` 或自定义图类型标识。',
      promptEnabled: '向模型注入渲染提示',
      promptEnabledHint: '在系统提示中加入一段说明，引导模型优先输出 mermaid / echarts / csv 围栏。',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      reset: '恢复默认',
      refresh: '重新读取',
      loading: '读取设置…',
      loadFailed: '读取设置失败',
      saveFailed: '保存失败',
      vendorReady: '可用',
      vendorMissing: '未找到',
      vendorLabel: '资源',
      mermaidVersion: 'Mermaid',
      echartsVersion: 'ECharts',
      unsaved: '有未保存的更改',
      rendering: '渲染中…',
      renderFailed: '渲染失败',
      retry: '重试',
      viewSource: '查看源码',
      viewDiagram: '查看图表',
      copy: '复制',
      copied: '已复制',
      downloadSvg: '下载 SVG',
      downloadPng: '下载 PNG',
      fullscreen: '全屏',
      close: '关闭',
      zoomIn: '放大',
      zoomOut: '缩小',
      zoomReset: '重置缩放',
      zoomFit: '适应屏幕',
      zoomHint: '滚轮缩放 · 拖拽平移 · 双击适应',
      sourceTooLarge: '源码过大，已保持代码块显示',
      moduleLoading: '图表组件加载中…',
      moduleFailed: '图表组件加载失败',
      mermaidLabel: 'Mermaid',
      echartsLabel: 'ECharts',
      csvLabel: 'CSV',
      chartHeight: '图表高度',
      chartHeightHint: 'ECharts 容器的像素高度。',
      tableStyle: '表格风格',
      tableStyleClaude: 'Claude 风格',
      tableStyleDsh: 'DSH 原生',
      inlineStyle: '行内代码',
      inlineStyleClaude: 'Claude 灰底蓝字描边',
      inlineStyleDsh: 'DSH 原生',
      codeBlockStyle: '代码块风格',
      codeBlockClaude: 'Claude 卡片',
      codeBlockMinimal: '极简边框',
      codeBlockDsh: 'DSH 原生',
      codeFont: '代码字体',
      codeFontInherit: '跟随 DSH 外观',
      codeFontSystem: '系统等宽',
      codeFontJetbrains: 'JetBrains Mono',
      codeFontFira: 'Fira Code',
      codeFontCascadia: 'Cascadia Code',
      codeFontSfmono: 'SF Mono',
      codeFontConsolas: 'Consolas',
      codeFontMenlo: 'Menlo',
      codeFontCustom: '自定义字体栈',
      customCodeFont: '自定义字体栈',
      customCodeFontHint: '例如 "My Font", ui-monospace, monospace',
      codeFontSize: '代码字号',
      codeFontSizeHint: '0 = 跟随 DSH 外观；12–20 覆盖',
      codeLineHeight: '代码行高',
      codeLineHeightHint: '0 = 跟随 DSH 外观；1.4–1.9 覆盖',
      codeLigatures: '启用代码连字',
      codeLigaturesHint: '需要字体本身支持连字（如 Fira Code）',
      collapseUserMessages: '长用户消息折叠',
      collapseUserMessagesHint: '超过阈值的用户消息默认折叠，点击「展开更多」查看全文；重渲染后恢复折叠。',
      userMessageMaxHeight: '折叠高度阈值',
      userMessageMaxHeightHint: '160–800px，默认 360px。',
      expandMore: '展开更多',
      showLess: '收起',
      typographyTitle: '字体与字号',
      typographyHint: '覆盖界面字体与会话/代码/终端字号；留空或 0 表示跟随「通用 → 外观」。',
      typographyFont: '界面字体',
      typographyFontPlaceholder: '留空跟随原生，例如 "PingFang SC", sans-serif',
      typographyTextSize: '会话字号（0 = 跟随）',
      typographyCodeSize: '代码字号（0 = 跟随）',
      typographyTerminalSize: '终端字号（0 = 跟随）',
      typographySizeHint: '0 表示跟随原生外观设置',
      typographyFollowNative: '跟随原生',
      typographySave: '保存',
      typographySaved: '已保存',
      typographySaveFailed: '保存失败',
      uiScaleTitle: '界面缩放',
      uiScaleHint: '整体放大/缩小整个 Web 界面（字体与控件）。100% 为默认；实验性设置，可能影响滚动或弹层定位，出现异常请重置 100%。',
      uiScaleSave: '应用',
      uiScaleReset: '重置 100%',
      uiScaleSaved: '已应用',
      uiScaleSaveFailed: '应用失败',
    }

    const en = {
      nav: 'Rendering',
      title: 'Rich rendering',
      intro: 'Render fenced code blocks from chat and document previews as Mermaid diagrams, ECharts charts, or CSV tables. Rendering happens in the browser and the original source stays one click away.',
      sectionAppearance: 'Markdown appearance',
      appearanceHint: 'These styles only affect Markdown in chat and document previews; DSH source stays untouched.',
      sectionDiagrams: 'Diagrams',
      sectionTables: 'Tables',
      sectionDetection: 'Detection',
      sectionPrompt: 'Model hint',
      mermaidEnabled: 'Enable Mermaid rendering',
      mermaidEnabledHint: 'Recognizes flowchart, sequenceDiagram, classDiagram, stateDiagram, erDiagram, gantt, pie, mindmap, timeline, gitGraph, and more.',
      mermaidTheme: 'Mermaid theme',
      mermaidThemeAuto: 'Follow interface',
      mermaidThemeLight: 'Light',
      mermaidThemeDark: 'Dark',
      echartsEnabled: 'Enable ECharts rendering',
      echartsEnabledHint: 'Recognizes code blocks whose content is an ECharts option JSON object (series, xAxis, dataset, and similar fields).',
      csvEnabled: 'Enable CSV tables',
      csvEnabledHint: 'Recognizes comma-separated text with at least two rows and a consistent column count.',
      debounce: 'Streaming settle delay',
      debounceHint: 'Wait for the code block text to stop changing before rendering, so streaming output does not flicker.',
      maxSource: 'Maximum source length',
      maxSourceHint: 'Blocks longer than this many characters stay as code, keeping very large diagrams from freezing the page.',
      heuristic: 'Content heuristic detection',
      heuristicHint: 'Recognize diagrams from the first-line diagram keyword and charts/tables from their structure. When off, only the extra keywords below are treated as Mermaid.',
      extraKeywords: 'Extra Mermaid first-line keywords',
      extraKeywordsHint: 'One per line, for example `%%{init:` or a custom diagram keyword.',
      promptEnabled: 'Inject a rendering hint into the model prompt',
      promptEnabledHint: 'Adds a short section that teaches the model to prefer mermaid / echarts / csv fences.',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      reset: 'Restore defaults',
      refresh: 'Reload',
      loading: 'Loading settings…',
      loadFailed: 'Could not load settings',
      saveFailed: 'Could not save settings',
      vendorReady: 'available',
      vendorMissing: 'missing',
      vendorLabel: 'Assets',
      mermaidVersion: 'Mermaid',
      echartsVersion: 'ECharts',
      unsaved: 'Unsaved changes',
      rendering: 'Rendering…',
      renderFailed: 'Rendering failed',
      retry: 'Retry',
      viewSource: 'View source',
      viewDiagram: 'View diagram',
      copy: 'Copy',
      copied: 'Copied',
      downloadSvg: 'Download SVG',
      downloadPng: 'Download PNG',
      fullscreen: 'Fullscreen',
      close: 'Close',
      zoomIn: 'Zoom in',
      zoomOut: 'Zoom out',
      zoomReset: 'Reset zoom',
      zoomFit: 'Fit to screen',
      zoomHint: 'Scroll to zoom · Drag to pan · Double-click to fit',
      sourceTooLarge: 'Source is too large; the code block stays as-is',
      moduleLoading: 'Loading diagram engine…',
      moduleFailed: 'Diagram engine failed to load',
      mermaidLabel: 'Mermaid',
      echartsLabel: 'ECharts',
      csvLabel: 'CSV',
      chartHeight: 'Chart height',
      chartHeightHint: 'Pixel height of the ECharts container.',
      tableStyle: 'Table style',
      tableStyleClaude: 'Claude style',
      tableStyleDsh: 'DSH native',
      inlineStyle: 'Inline code',
      inlineStyleClaude: 'Claude grey + blue ink + outline',
      inlineStyleDsh: 'DSH native',
      codeBlockStyle: 'Code block style',
      codeBlockClaude: 'Claude card',
      codeBlockMinimal: 'Minimal border',
      codeBlockDsh: 'DSH native',
      codeFont: 'Code font',
      codeFontInherit: 'Follow DSH appearance',
      codeFontSystem: 'System monospace',
      codeFontJetbrains: 'JetBrains Mono',
      codeFontFira: 'Fira Code',
      codeFontCascadia: 'Cascadia Code',
      codeFontSfmono: 'SF Mono',
      codeFontConsolas: 'Consolas',
      codeFontMenlo: 'Menlo',
      codeFontCustom: 'Custom font stack',
      customCodeFont: 'Custom font stack',
      customCodeFontHint: 'e.g. "My Font", ui-monospace, monospace',
      codeFontSize: 'Code font size',
      codeFontSizeHint: '0 = follow DSH appearance; 12–20 overrides',
      codeLineHeight: 'Code line height',
      codeLineHeightHint: '0 = follow DSH appearance; 1.4–1.9 overrides',
      codeLigatures: 'Enable code ligatures',
      codeLigaturesHint: 'Requires a font with ligatures (e.g. Fira Code)',
      collapseUserMessages: 'Collapse long user messages',
      collapseUserMessagesHint: 'User messages taller than the threshold start collapsed; use "Show more" to expand. Re-rendered messages collapse again.',
      userMessageMaxHeight: 'Collapse height',
      userMessageMaxHeightHint: '160–800 px, default 360 px.',
      expandMore: 'Show more',
      showLess: 'Show less',
      typographyTitle: 'Font and size',
      typographyHint: 'Override the interface font and the conversation/code/terminal sizes; empty or 0 keeps Settings → General → Appearance.',
      typographyFont: 'Interface font',
      typographyFontPlaceholder: 'Empty follows native, e.g. "PingFang SC", sans-serif',
      typographyTextSize: 'Conversation size (0 = native)',
      typographyCodeSize: 'Code size (0 = native)',
      typographyTerminalSize: 'Terminal size (0 = native)',
      typographySizeHint: '0 follows the native Appearance setting',
      typographyFollowNative: 'Follow native',
      typographySave: 'Save',
      typographySaved: 'Saved',
      typographySaveFailed: 'Save failed',
      uiScaleTitle: 'Interface scale',
      uiScaleHint: 'Zooms the whole Web interface (font and controls). 100% is default; experimental — scrolling or popover placement may be affected, reset to 100% if anything looks off.',
      uiScaleSave: 'Apply',
      uiScaleReset: 'Reset 100%',
      uiScaleSaved: 'Applied',
      uiScaleSaveFailed: 'Apply failed',
    }

    let dictionaries = { zh, en }

    /**
     * Bound translator for the current client locale.
     * @param {string} key - dictionary key.
     * @param {Record<string, unknown>} [params] - interpolation values.
     * @returns {string}
     */
    function translate(key, params) {
      let value
      try {
        value = runtime.translate(key, params)
      } catch {
        value = key
      }
      if (typeof value !== 'string' || value === '' || value === key) {
        const fallback = dictionaries.en[key] ?? dictionaries.zh[key]
        return typeof fallback === 'string' ? fallback : key
      }
      return value
    }

    /* ------------------------------ utilities ------------------------------ */

    /** @param {unknown} value - candidate. @returns {boolean} */
    function isRecord(value) {
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    }

    /**
     * FNV-1a 32-bit hash, rendered as base36.
     * @param {string} input - source text.
     * @returns {string}
     */
    function hashString(input) {
      let hash = 0x811c9dc5
      for (let index = 0; index < input.length; index += 1) {
        hash ^= input.charCodeAt(index)
        hash = Math.imul(hash, 0x01000193)
      }
      return (hash >>> 0).toString(36)
    }

    /** @param {string} value - text. @returns {string} */
    function escapeHtml(value) {
      return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;')
    }

    /** @param {number} ms - delay. @returns {Promise<void>} */
    function sleep(ms) {
      return new Promise(resolve => setTimeout(resolve, ms))
    }

    /**
     * Debounce with a cancelable handle.
     * @param {() => void} fn - target.
     * @param {number} ms - delay.
     * @returns {{ schedule: () => void, cancel: () => void }}
     */
    function debounce(fn, ms) {
      let timer = 0
      const cancel = () => {
        if (timer !== 0) {
          clearTimeout(timer)
          timer = 0
        }
      }
      return {
        schedule() {
          cancel()
          timer = setTimeout(() => {
            timer = 0
            fn()
          }, ms)
        },
        cancel,
      }
    }

    /** @param {string} name - CSS custom property. @param {string} fallback - fallback value. @returns {string} */
    function cssVar(name, fallback) {
      try {
        const value = getComputedStyle(document.body).getPropertyValue(name).trim()
        return value === '' ? fallback : value
      } catch {
        return fallback
      }
    }

    /** @returns {boolean} */
    function isDarkTheme() {
      try {
        return document.body.hasAttribute('data-ds-dark-theme')
          || document.documentElement.hasAttribute('data-ds-dark-theme')
      } catch {
        return false
      }
    }

    /**
     * Resolve the effective Mermaid theme from the setting and the live page.
     * @returns {'light' | 'dark'}
     */
    function resolveTheme() {
      const preference = runtime.settings.mermaid.theme
      if (preference === 'light' || preference === 'dark') return preference
      return isDarkTheme() ? 'dark' : 'light'
    }

    /**
     * Copy text with a legacy fallback.
     * @param {string} text - value to copy.
     * @returns {Promise<boolean>}
     */
    async function copyText(text) {
      try {
        if (navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch {
        // fall through to the legacy path
      }
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const ok = document.execCommand('copy')
        area.remove()
        return ok
      } catch {
        return false
      }
    }

    /**
     * Trigger a browser download for a Blob.
     * @param {Blob} blob - payload.
     * @param {string} filename - suggested name.
     */
    function downloadBlob(blob, filename) {
      try {
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = filename
        anchor.rel = 'noopener'
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
        setTimeout(() => URL.revokeObjectURL(url), 4000)
      } catch {
        // Download is best-effort.
      }
    }

    /** @param {string} text - plain text. @returns {string} */
    function textBlobUrl(text) {
      return URL.createObjectURL(new Blob([text], { type: 'image/svg+xml;charset=utf-8' }))
    }

    /** @param {unknown} value - thrown value. @returns {string} */
    function messageOf(value) {
      if (value instanceof Error) return value.message
      return String(value)
    }

    /** @param {number} ms - timeout. @param {string} label - error label. @returns {Promise<never>} */
    function timeoutReject(ms, label) {
      return sleep(ms).then(() => {
        throw new Error(label + ' timed out')
      })
    }

    /* ------------------------------ detection ------------------------------ */

    /** Mermaid diagram keywords accepted on the first meaningful line. */
    const MERMAID_KEYWORDS = [
      'graph', 'flowchart', 'flowchart-elk', 'sequenceDiagram', 'classDiagram', 'classDiagram-v2',
      'stateDiagram', 'stateDiagram-v2', 'erDiagram', 'journey', 'gantt', 'pie', 'quadrantChart',
      'requirementDiagram', 'gitGraph', 'C4Context', 'C4Container', 'C4Component', 'C4Dynamic',
      'C4Deployment', 'mindmap', 'timeline', 'zenuml', 'sankey-beta', 'xychart-beta', 'block-beta',
      'packet-beta', 'architecture-beta', 'kanban', 'radar-beta', 'treemap-beta',
    ]

    /** @type {RegExp} */
    let mermaidHeadPattern = buildMermaidPattern(MERMAID_KEYWORDS)

    /** @param {string[]} keywords - accepted head keywords. @returns {RegExp} */
    function buildMermaidPattern(keywords) {
      const escaped = keywords
        .filter(keyword => typeof keyword === 'string' && keyword.trim() !== '')
        .map(keyword => keyword.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .sort((left, right) => right.length - left.length)
      return new RegExp('^(?:' + escaped.join('|') + ')\\b')
    }

    /**
     * First meaningful line of a fenced block, skipping blank lines, `%%`
     * comments, and YAML frontmatter.
     * @param {string} source - block text.
     * @returns {string}
     */
    function firstMeaningfulLine(source) {
      const lines = source.replace(/\r\n?/g, '\n').split('\n')
      let index = 0
      while (index < lines.length && lines[index].trim() === '') index += 1
      if (index < lines.length && lines[index].trim() === '---') {
        index += 1
        while (index < lines.length && lines[index].trim() !== '---') index += 1
        if (index < lines.length) index += 1
      }
      while (index < lines.length) {
        const line = lines[index].trim()
        if (line === '' || line.startsWith('%%')) {
          index += 1
          continue
        }
        return line
      }
      return ''
    }

    /** @param {string} source - block text. @returns {boolean} */
    function isMermaidSource(source) {
      return mermaidHeadPattern.test(firstMeaningfulLine(source))
    }

    /** @param {string} keyword - extra keyword. @returns {boolean} */
    function matchesExtraKeyword(source, keyword) {
      const head = firstMeaningfulLine(source)
      return head.startsWith(keyword) || head.toLowerCase().startsWith(keyword.toLowerCase())
    }

    /**
     * Parse an ECharts option object from a fenced block.
     * @param {string} source - block text.
     * @returns {Record<string, any> | null}
     */
    function parseEchartsOption(source) {
      const text = source.trim()
      if (text === '') return null
      const attempts = []
      try {
        attempts.push(JSON.parse(text))
      } catch {
        // Not bare JSON (an assignment wrapper or comments).
      }
      const start = text.indexOf('{')
      const end = text.lastIndexOf('}')
      if (start !== -1 && end > start) {
        try {
          attempts.push(JSON.parse(text.slice(start, end + 1)))
        } catch {
          // Not JSON after trimming the wrapper either.
        }
      }
      for (const candidate of attempts) {
        if (isEchartsOption(candidate)) return candidate
      }
      return null
    }

    /** @param {unknown} value - parsed JSON. @returns {boolean} */
    function isEchartsOption(value) {
      if (!isRecord(value)) return false
      if (value.series !== undefined && (Array.isArray(value.series) || isRecord(value.series))) return true
      return ['xAxis', 'yAxis', 'dataset', 'geo', 'radar', 'polar', 'visualMap', 'dataZoom', 'timeline', 'calendar']
        .some(key => key in value)
    }

    /**
     * Split one CSV line, honoring double-quoted fields.
     * @param {string} line - raw line.
     * @returns {string[] | null}
     */
    function splitCsvLine(line) {
      const cells = []
      let cell = ''
      let quoted = false
      for (let index = 0; index < line.length; index += 1) {
        const char = line[index]
        if (quoted) {
          if (char === '"') {
            if (line[index + 1] === '"') {
              cell += '"'
              index += 1
            } else {
              quoted = false
            }
          } else {
            cell += char
          }
          continue
        }
        if (char === '"') {
          quoted = true
          continue
        }
        if (char === ',') {
          cells.push(cell.trim())
          cell = ''
          continue
        }
        cell += char
      }
      if (quoted) return null
      cells.push(cell.trim())
      return cells
    }

    /**
     * Heuristic CSV detection: at least two rows, consistent columns, and no
     * obvious code markers in the head.
     * @param {string} source - block text.
     * @returns {boolean}
     */
    function looksLikeCsv(source) {
      const text = source.replace(/\r\n?/g, '\n').trim()
      if (text === '' || text.length > 400000) return false
      const lines = text.split('\n').filter(line => line.trim() !== '')
      if (lines.length < 2 || lines.length > 5000) return false
      const headLine = lines[0].trim()
      if (headLine === '' || /^[[{<#]/.test(headLine)) return false
      const head = splitCsvLine(headLine)
      if (head === null || head.length < 2 || head.length > 40) return false
      for (const line of lines.slice(1, 4)) {
        const cells = splitCsvLine(line)
        if (cells === null || cells.length !== head.length) return false
      }
      const sample = lines.slice(0, 6).join('\n')
      if (/(?:=>|\bfunction\b|\bconst\b|\blet\b|\bvar\b|\breturn\b|<\/?[a-z][\w-]*\b|\bimport\b|\bclass\b)/.test(sample)) return false
      return true
    }

    /**
     * Parse CSV text into rows (limited).
     * @param {string} source - block text.
     * @returns {{ header: string[], rows: string[][] } | null}
     */
    function parseCsv(source) {
      const text = source.replace(/\r\n?/g, '\n').trim()
      if (text === '') return null
      const lines = text.split('\n').filter(line => line.trim() !== '')
      const header = splitCsvLine(lines[0])
      if (header === null) return null
      const rows = []
      for (const line of lines.slice(1)) {
        const cells = splitCsvLine(line)
        if (cells === null) return null
        if (cells.length !== header.length) return null
        rows.push(cells)
        if (rows.length >= 2000) break
      }
      return { header, rows }
    }

    /**
     * Classify one fenced block.
     * @param {string} source - block text.
     * @returns {'mermaid' | 'echarts' | 'csv' | null}
     */
    function detectFenceKind(source) {
      if (typeof source !== 'string' || source.trim() === '') return null
      const settings = runtime.settings
      if (settings.mermaid.enabled) {
        if (settings.detection.heuristic && isMermaidSource(source)) return 'mermaid'
        if (!settings.detection.heuristic) {
          for (const keyword of settings.detection.extraKeywords) {
            if (matchesExtraKeyword(source, keyword)) return 'mermaid'
          }
        } else {
          for (const keyword of settings.detection.extraKeywords) {
            if (matchesExtraKeyword(source, keyword)) return 'mermaid'
          }
        }
      }
      if (settings.echarts.enabled && parseEchartsOption(source) !== null) return 'echarts'
      if (settings.csv.enabled && looksLikeCsv(source)) return 'csv'
      return null
    }

    /* ------------------------------ vendor loading ------------------------------ */

    let mermaidModule = null
    let mermaidPromise = null
    let mermaidThemeKey = ''
    let echartsModule = null
    let echartsPromise = null
    const echartsThemes = new Set()

    /**
     * Load the vendored Mermaid ESM module on first use.
     * @returns {Promise<Record<string, any>>}
     */
    function loadMermaid() {
      if (mermaidModule !== null) return Promise.resolve(mermaidModule)
      if (mermaidPromise === null) {
        mermaidPromise = import(/* @vite-ignore */ MERMAID_ENTRY)
          .then(module => {
            const api = module.default ?? module
            if (api === null || typeof api !== 'object' || typeof api.initialize !== 'function' || typeof api.render !== 'function') {
              throw new Error('mermaid module shape is unexpected')
            }
            mermaidModule = api
            return api
          })
          .catch(cause => {
            mermaidPromise = null
            throw cause
          })
      }
      return mermaidPromise
    }

    /**
     * Load the vendored ECharts UMD bundle on first use.
     * @returns {Promise<Record<string, any>>}
     */
    function loadECharts() {
      if (echartsModule !== null) return Promise.resolve(echartsModule)
      if (echartsPromise === null) {
        echartsPromise = new Promise((resolve, reject) => {
          const existing = globalThis.echarts
          if (existing !== undefined && existing !== null) {
            echartsModule = existing
            resolve(existing)
            return
          }
          const script = document.createElement('script')
          script.src = ECHARTS_ENTRY
          script.async = true
          script.dataset.dshRenderScript = 'echarts'
          script.onload = () => {
            const loaded = globalThis.echarts
            if (loaded === undefined || loaded === null) {
              reject(new Error('echarts global is missing after load'))
              return
            }
            echartsModule = loaded
            resolve(loaded)
          }
          script.onerror = () => reject(new Error('echarts script failed to load'))
          document.head.appendChild(script)
        }).catch(cause => {
          echartsPromise = null
          throw cause
        })
      }
      return echartsPromise
    }

    /**
     * Theme variables handed to Mermaid so the diagram follows the DSH tokens.
     * @param {'light' | 'dark'} theme - resolved theme.
     * @returns {Record<string, string>}
     */
    function mermaidThemeVariables(theme) {
      const dark = theme === 'dark'
      return {
        background: 'transparent',
        primaryColor: cssVar('--dsw-alias-bg-layer-1', dark ? '#1f2023' : '#ffffff'),
        primaryTextColor: cssVar('--dsw-alias-label-primary', dark ? '#e8e8ec' : '#1c1d20'),
        primaryBorderColor: cssVar('--dsw-alias-border-l2', dark ? '#3c3d42' : '#d8d9dd'),
        lineColor: cssVar('--dsw-alias-label-tertiary', dark ? '#a2a3a8' : '#6b6c70'),
        secondaryColor: cssVar('--dsw-alias-bg-layer-2', dark ? '#2a2b30' : '#f4f4f6'),
        tertiaryColor: cssVar('--dsw-alias-bg-base', dark ? '#17181b' : '#fafafb'),
        secondaryTextColor: cssVar('--dsw-alias-label-secondary', dark ? '#c9cad0' : '#4a4b50'),
        tertiaryTextColor: cssVar('--dsw-alias-label-tertiary', dark ? '#a2a3a8' : '#6b6c70'),
        mainBkg: cssVar('--dsw-alias-bg-layer-1', dark ? '#1f2023' : '#ffffff'),
        nodeBorder: cssVar('--dsw-alias-border-l2', dark ? '#3c3d42' : '#d8d9dd'),
        clusterBkg: cssVar('--dsw-alias-bg-layer-2', dark ? '#2a2b30' : '#f4f4f6'),
        clusterBorder: cssVar('--dsw-alias-border-l1', dark ? '#303136' : '#e4e5e8'),
        edgeLabelBackground: cssVar('--dsw-alias-bg-base', dark ? '#17181b' : '#ffffff'),
        fontFamily: cssVar('--dsw-font-family', 'inherit'),
        fontSize: '13px',
        noteBkgColor: cssVar('--dsw-alias-bg-layer-2', dark ? '#2a2b30' : '#f4f4f6'),
        noteTextColor: cssVar('--dsw-alias-label-primary', dark ? '#e8e8ec' : '#1c1d20'),
        noteBorderColor: cssVar('--dsw-alias-border-l2', dark ? '#3c3d42' : '#d8d9dd'),
        errorBkgColor: cssVar('--dsw-alias-state-error-primary', '#d64545'),
        errorTextColor: cssVar('--dsw-alias-label-primary-foreground', '#ffffff'),
        pie1: '#4f8cff', pie2: '#2fb344', pie3: '#e6a23c', pie4: '#d64545',
        pie5: '#8e5cf7', pie6: '#20b8c4', pie7: '#f06fb0', pie8: '#8a8f99',
      }
    }

    /** @param {string} themeKey - theme id. @param {boolean} dark - dark flag. @returns {Record<string, any>} */
    function buildEchartsTheme(themeKey, dark) {
      const text = cssVar('--dsw-alias-label-primary', dark ? '#e8e8ec' : '#1c1d20')
      const textSecondary = cssVar('--dsw-alias-label-secondary', dark ? '#c9cad0' : '#4a4b50')
      const border = cssVar('--dsw-alias-border-l1', dark ? '#303136' : '#e4e5e8')
      const split = cssVar('--dsw-alias-border-l2', dark ? '#3c3d42' : '#d8d9dd')
      const panel = cssVar('--dsw-alias-bg-layer-1', dark ? '#1f2023' : '#ffffff')
      return {
        backgroundColor: 'transparent',
        textStyle: { color: text, fontFamily: cssVar('--dsw-font-family', 'inherit'), fontSize: 12 },
        title: { textStyle: { color: text }, subtextStyle: { color: textSecondary } },
        legend: { textStyle: { color: textSecondary } },
        tooltip: { backgroundColor: panel, borderColor: border, textStyle: { color: text } },
        color: ['#4f8cff', '#2fb344', '#e6a23c', '#d64545', '#8e5cf7', '#20b8c4', '#f06fb0', '#8a8f99'],
        categoryAxis: {
          axisLine: { show: true, lineStyle: { color: border } },
          axisTick: { show: true, lineStyle: { color: border } },
          axisLabel: { show: true, color: textSecondary },
          splitLine: { show: false, lineStyle: { color: split } },
        },
        valueAxis: {
          axisLine: { show: true, lineStyle: { color: border } },
          axisTick: { show: true, lineStyle: { color: border } },
          axisLabel: { show: true, color: textSecondary },
          splitLine: { show: true, lineStyle: { color: split, opacity: 0.5 } },
        },
        radar: { axisLine: { lineStyle: { color: border } }, splitLine: { lineStyle: { color: split } } },
      }
    }

    /**
     * Initialize Mermaid once per resolved theme.
     * @param {'light' | 'dark'} theme - resolved theme.
     * @returns {Promise<Record<string, any>>}
     */
    async function configureMermaid(theme) {
      const api = await loadMermaid()
      if (mermaidThemeKey === theme) return api
      api.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: theme === 'dark' ? 'dark' : 'default',
        htmlLabels: false,
        fontFamily: 'inherit',
        themeVariables: mermaidThemeVariables(theme),
        flowchart: { htmlLabels: false, useMaxWidth: true, curve: 'basis' },
        sequence: { useMaxWidth: true },
        gantt: { useMaxWidth: true },
        journey: { useMaxWidth: true },
        timeline: { useMaxWidth: true },
      })
      mermaidThemeKey = theme
      return api
    }

    /* ------------------------------ render cache ------------------------------ */

    /** @type {Map<string, string>} */
    const svgCache = new Map()

    /** @param {string} key - cache key. @returns {string | undefined} */
    function cacheGet(key) {
      const value = svgCache.get(key)
      if (value !== undefined) {
        svgCache.delete(key)
        svgCache.set(key, value)
      }
      return value
    }

    /** @param {string} key - cache key. @param {string} value - SVG. */
    function cacheSet(key, value) {
      svgCache.set(key, value)
      while (svgCache.size > CACHE_LIMIT) {
        const oldest = svgCache.keys().next().value
        if (oldest === undefined) break
        svgCache.delete(oldest)
      }
    }

    /* ------------------------------ render queue ------------------------------ */

    let activeRenders = 0
    const pendingRenders = []

    /**
     * Serialize diagram rendering so a page with many fences cannot saturate
     * the main thread.
     * @param {() => Promise<void>} task - work item.
     * @returns {Promise<void>}
     */
    function enqueueRender(task) {
      return new Promise((resolve, reject) => {
        pendingRenders.push({ task, resolve, reject })
        pumpRenders()
      })
    }

    function pumpRenders() {
      while (activeRenders < MAX_CONCURRENT && pendingRenders.length > 0) {
        const entry = pendingRenders.shift()
        if (entry === undefined) break
        activeRenders += 1
        Promise.resolve()
          .then(entry.task)
          .then(entry.resolve, entry.reject)
          .finally(() => {
            activeRenders -= 1
            pumpRenders()
          })
      }
    }

    /* ------------------------------ renderers ------------------------------ */

    let renderSequence = 0

    /**
     * Render Mermaid code into an SVG string.
     * @param {string} source - mermaid source.
     * @param {'light' | 'dark'} theme - resolved theme.
     * @returns {Promise<string>}
     */
    async function renderMermaidSvg(source, theme) {
      const cacheKey = 'm:' + hashString(theme + '\n' + source)
      const cached = cacheGet(cacheKey)
      if (cached !== undefined) return cached
      return enqueueRender(async () => {
        const api = await configureMermaid(theme)
        renderSequence += 1
        const id = 'dsh-render-mermaid-' + renderSequence
        let timer = 0
        try {
          const result = await Promise.race([
            api.render(id, source),
            timeoutReject(RENDER_TIMEOUT_MS, 'mermaid render').finally(() => { clearTimeout(timer) }),
          ])
          const svg = result?.svg
          if (typeof svg !== 'string' || svg.trim() === '') throw new Error('mermaid returned no SVG')
          cacheSet(cacheKey, svg)
          return svg
        } finally {
          try {
            const leftover = document.getElementById(id)
            if (leftover !== null) leftover.remove()
          } catch {
            // Cleanup is best-effort.
          }
          clearTimeout(timer)
        }
      })
    }

    /**
     * Render an ECharts option object into an SVG string.
     * @param {Record<string, any>} option - parsed option.
     * @param {'light' | 'dark'} theme - resolved theme.
     * @param {number} height - container height in pixels.
     * @returns {Promise<string>}
     */
    async function renderEchartsSvg(option, theme, height) {
      const cacheKey = 'e:' + hashString(theme + ':' + height + '\n' + JSON.stringify(option))
      const cached = cacheGet(cacheKey)
      if (cached !== undefined) return cached
      return enqueueRender(async () => {
        const echarts = await loadECharts()
        const themeName = 'dsh-render-' + theme
        if (!echartsThemes.has(themeName)) {
          echarts.registerTheme(themeName, buildEchartsTheme(themeName, theme === 'dark'))
          echartsThemes.add(themeName)
        }
        const host = document.createElement('div')
        host.style.width = '960px'
        host.style.height = height + 'px'
        host.style.position = 'absolute'
        host.style.left = '-100000px'
        host.style.top = '0'
        document.body.appendChild(host)
        let chart = null
        try {
          chart = echarts.init(host, themeName, { renderer: 'svg', width: 960, height })
          chart.setOption(option, true)
          const svg = chart.renderToSVGString()
          if (typeof svg !== 'string' || svg.trim() === '') throw new Error('echarts returned no SVG')
          cacheSet(cacheKey, svg)
          return svg
        } finally {
          try {
            chart?.dispose()
          } catch {
            // Disposal is best-effort.
          }
          host.remove()
        }
      })
    }

    /* ------------------------------ surface helpers ------------------------------ */

    /**
     * Current content text of a code block, or '' when the node is gone.
     * @param {HTMLElement} block - `.md-code-block` element.
     * @returns {string}
     */
    function blockSource(block) {
      const content = block.querySelector(CONTENT_SELECTOR)
      if (content === null) return ''
      return content.textContent ?? ''
    }

    /**
     * Find (or create) the render surface belonging to one code block.
     * @param {HTMLElement} block - `.md-code-block` element.
     * @param {'mermaid' | 'echarts' | 'csv'} kind - detected kind.
     * @returns {HTMLElement}
     */
    function ensureSurface(block, kind) {
      let surface = block.querySelector(SURFACE_SELECTOR)
      if (surface === null) {
        surface = document.createElement('div')
        surface.setAttribute('data-dsh-render-surface', kind)
        surface.className = 'dshrender-surface'
        const bar = document.createElement('div')
        bar.className = 'dshrender-bar'
        bar.innerHTML = [
          '<span class="dshrender-kind"></span>',
          '<span class="dshrender-status"></span>',
          '<span class="dshrender-spacer"></span>',
          '<span class="dshrender-actions">',
          '<button type="button" class="dshrender-btn" data-act="toggle-source"></button>',
          '<button type="button" class="dshrender-btn" data-act="copy"></button>',
          '<button type="button" class="dshrender-btn" data-act="download"></button>',
          '<button type="button" class="dshrender-btn" data-act="retry" style="display:none"></button>',
          '<button type="button" class="dshrender-btn" data-act="fullscreen"></button>',
          '</span>',
        ].join('')
        const body = document.createElement('div')
        body.className = 'dshrender-body'
        body.setAttribute('data-dsh-render-body', '')
        surface.appendChild(bar)
        surface.appendChild(body)
        surface.addEventListener('click', onSurfaceClick)
        block.appendChild(surface)
      }
      if (surface.getAttribute('data-dsh-render-surface') !== kind) {
        surface.setAttribute('data-dsh-render-surface', kind)
        const body = surface.querySelector('[data-dsh-render-body]')
        if (body !== null) body.textContent = ''
      }
      return surface
    }

    /** @param {HTMLElement} block - code block. @returns {HTMLElement | null} */
    function surfaceOf(block) {
      return block.querySelector(SURFACE_SELECTOR)
    }

    /** @param {HTMLElement} block - code block. @param {boolean} hidden - hide original source. */
    function setSourceHidden(block, hidden) {
      const content = block.querySelector(CONTENT_SELECTOR)
      if (content === null) return
      content.style.display = hidden ? 'none' : ''
    }

    /** @param {HTMLElement} block - code block. @returns {boolean} */
    function isSourceHidden(block) {
      const content = block.querySelector(CONTENT_SELECTOR)
      return content !== null && content.style.display === 'none'
    }

    /** @param {HTMLElement} surface - surface. @param {string} text - status copy. */
    function setStatus(surface, text) {
      const status = surface.querySelector('.dshrender-status')
      if (status !== null) status.textContent = text
    }

    /** @param {HTMLElement} surface - surface. @param {string} label - kind label. */
    function setKindLabel(surface, label) {
      const kind = surface.querySelector('.dshrender-kind')
      if (kind !== null) kind.textContent = label
    }

    /** @param {HTMLElement} surface - surface. @param {boolean} visible - visibility. */
    function setSourceButton(surface, visible) {
      const button = surface.querySelector('[data-act="toggle-source"]')
      if (button !== null) button.style.display = visible ? '' : 'none'
    }

    /** @param {HTMLElement} surface - surface. @param {boolean} visible - visibility. */
    function setRetryVisible(surface, visible) {
      const retry = surface.querySelector('[data-act="retry"]')
      if (retry instanceof HTMLElement) retry.style.display = visible ? '' : 'none'
    }

    /**
     * Mark one surface as successfully rendered.
     * @param {HTMLElement} surface - surface.
     * @param {Record<string, any>} state - per-block state.
     */
    function markSurfaceReady(surface, state) {
      surface.dataset.dshRenderReady = 'true'
      surface.dataset.dshRenderState = 'ready'
      state.errorHash = ''
      state.errorKind = ''
      state.errorTheme = ''
      setRetryVisible(surface, false)
      const download = surface.querySelector('[data-act="download"]')
      if (download instanceof HTMLElement) {
        const kind = surface.dataset.dshRenderKind
        download.style.display = kind === 'mermaid' || kind === 'echarts' ? '' : 'none'
      }
    }

    /**
     * Mark one surface as failed; the source stays visible and a retry button
     * appears.
     * @param {HTMLElement} surface - surface.
     * @param {Record<string, any>} state - per-block state.
     * @param {string} sourceHash - current source hash.
     * @param {string} kind - fence kind.
     * @param {string} theme - resolved theme.
     */
    function markSurfaceError(surface, state, sourceHash, kind, theme) {
      surface.dataset.dshRenderReady = 'false'
      surface.dataset.dshRenderState = 'error'
      state.errorHash = sourceHash
      state.errorKind = kind
      state.errorTheme = theme
      setRetryVisible(surface, true)
      const download = surface.querySelector('[data-act="download"]')
      if (download instanceof HTMLElement) download.style.display = 'none'
    }

    /**
     * Build the small action bar labels for one surface.
     * @param {HTMLElement} surface - surface.
     */
    function refreshSurfaceLabels(surface) {
      const toggle = surface.querySelector('[data-act="toggle-source"]')
      const copy = surface.querySelector('[data-act="copy"]')
      const download = surface.querySelector('[data-act="download"]')
      const retry = surface.querySelector('[data-act="retry"]')
      const fullscreen = surface.querySelector('[data-act="fullscreen"]')
      if (toggle !== null) toggle.textContent = translate('viewSource')
      if (copy !== null) copy.textContent = translate('copy')
      if (download !== null) download.textContent = translate('downloadSvg')
      if (retry !== null) retry.textContent = translate('retry')
      if (fullscreen !== null) fullscreen.textContent = translate('fullscreen')
    }

    /* ------------------------------ surface interaction ------------------------------ */

    /** @param {MouseEvent} event - click. */
    function onSurfaceClick(event) {
      const target = event.target
      if (!(target instanceof Element)) return
      const button = target.closest('button[data-act]')
      if (button === null) return
      const surface = button.closest(SURFACE_SELECTOR)
      if (!(surface instanceof HTMLElement)) return
      const block = surface.closest(BLOCK_SELECTOR)
      if (!(block instanceof HTMLElement)) return
      const act = button.getAttribute('data-act')
      event.preventDefault()
      event.stopPropagation()
      if (act === 'toggle-source') {
        // `showSource` is the state we are switching TO: showing the original
        // code hides the rendered body, and showing the diagram hides the code.
        const showSource = isSourceHidden(block)
        setSourceHidden(block, !showSource)
        const body = surface.querySelector('[data-dsh-render-body]')
        if (body instanceof HTMLElement) body.style.display = showSource ? 'none' : ''
        if (button instanceof HTMLElement) button.textContent = showSource ? translate('viewDiagram') : translate('viewSource')
        return
      }
      if (act === 'copy') {
        void copyText(blockSource(block)).then(ok => {
          if (ok && button instanceof HTMLElement) {
            const original = translate('copy')
            button.textContent = translate('copied')
            setTimeout(() => { if (button instanceof HTMLElement) button.textContent = original }, 1200)
          }
        })
        return
      }
      if (act === 'download') {
        const svg = surface.querySelector('[data-dsh-render-body] svg')
        if (svg instanceof SVGElement) {
          const markup = new XMLSerializer().serializeToString(svg)
          downloadBlob(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }), 'dsh-render-' + Date.now() + '.svg')
        }
        return
      }
      if (act === 'retry') {
        const state = blockState.get(block)
        if (state !== undefined) {
          state.errorHash = ''
          state.errorKind = ''
          state.errorTheme = ''
          state.hash = ''
        }
        blockState.delete(block)
        markBlock(block)
        return
      }
      if (act === 'fullscreen') {
        openFullscreen(surface)
      }
    }

    /**
     * Fullscreen overlay for one rendered surface.
     * @param {HTMLElement} surface - rendered surface.
     */
    /** Minimum and maximum viewer scale (1 = intrinsic SVG size). */
    const MIN_ZOOM = 0.02
    const MAX_ZOOM = 20

    /** @param {number} value - requested scale. @returns {number} */
    function clampZoom(value) {
      if (!Number.isFinite(value)) return 1
      return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value))
    }

    /**
     * Fit content inside a viewport with a small margin, centered.
     * @param {number} contentWidth - intrinsic content width.
     * @param {number} contentHeight - intrinsic content height.
     * @param {number} viewportWidth - available width.
     * @param {number} viewportHeight - available height.
     * @param {number} [margin] - fraction of the viewport used (default 0.94).
     * @returns {{ scale: number, x: number, y: number }}
     */
    function fitTransform(contentWidth, contentHeight, viewportWidth, viewportHeight, margin = 0.94) {
      if (!(contentWidth > 0) || !(contentHeight > 0) || !(viewportWidth > 0) || !(viewportHeight > 0)) {
        return { scale: 1, x: 0, y: 0 }
      }
      const scale = clampZoom(Math.min((viewportWidth * margin) / contentWidth, (viewportHeight * margin) / contentHeight))
      return {
        scale,
        x: (viewportWidth - contentWidth * scale) / 2,
        y: (viewportHeight - contentHeight * scale) / 2,
      }
    }

    /**
     * Zoom around one viewport anchor so the content point under it stays put.
     * @param {{ scale: number, x: number, y: number }} transform - current transform.
     * @param {number} nextScale - requested scale.
     * @param {number} pointerX - anchor X in viewport coordinates.
     * @param {number} pointerY - anchor Y in viewport coordinates.
     * @returns {{ scale: number, x: number, y: number }}
     */
    function zoomAt(transform, nextScale, pointerX, pointerY) {
      const scale = clampZoom(nextScale)
      const ratio = scale / transform.scale
      return {
        scale,
        x: pointerX - (pointerX - transform.x) * ratio,
        y: pointerY - (pointerY - transform.y) * ratio,
      }
    }

    /**
     * Intrinsic size of a rendered SVG, preferring its viewBox so mermaid's
     * percentage width does not collapse the viewer.
     * @param {SVGElement} svg - rendered SVG element.
     * @returns {{ width: number, height: number }}
     */
    function svgSize(svg) {
      try {
        const box = svg.viewBox?.baseVal
        if (box !== undefined && box.width > 0 && box.height > 0) return { width: box.width, height: box.height }
        const width = svg.width?.baseVal?.value
        const height = svg.height?.baseVal?.value
        if (typeof width === 'number' && width > 0 && typeof height === 'number' && height > 0) return { width, height }
        const rect = svg.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) return { width: rect.width, height: rect.height }
      } catch {
        // Fall through to a sane default.
      }
      return { width: 960, height: 540 }
    }

    /**
     * Build one viewer toolbar button.
     * @param {string} act - data-act value.
     * @param {string} text - visible label.
     * @param {string} label - accessible/tooltip label.
     * @returns {HTMLButtonElement}
     */
    function overlayButton(act, text, label) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'dshrender-overlay-btn'
      button.setAttribute('data-act', act)
      button.textContent = text
      button.setAttribute('aria-label', label)
      button.title = label
      return button
    }

    /** Cleanup of the currently open viewer, so reopening never leaks listeners. */
    let fullscreenCleanup = null

    /**
     * Fullscreen viewer for one rendered surface. The stage fills the viewport
     * and the cloned body is laid out at its intrinsic size inside a pan/zoom
     * canvas: initial fit-to-screen, wheel/button zoom around the pointer,
     * drag-to-pan, double-click to fit, and keyboard shortcuts.
     * @param {HTMLElement} surface - rendered surface.
     */
    function openFullscreen(surface) {
      if (fullscreenCleanup !== null) {
        try { fullscreenCleanup() } catch { /* teardown is best-effort */ }
      }
      document.querySelector('.dshrender-overlay')?.remove()
      const source = surface.querySelector('[data-dsh-render-body]')
      if (!(source instanceof HTMLElement)) return
      const sourceSvg = source.querySelector('svg')
      const kind = surface.getAttribute('data-dsh-render-kind') ?? 'mermaid'
      // CSV keeps the scrollable static view; every diagram (even a render
      // fallback without an <svg>) uses the zoomable fit/pan viewer.
      const svgIntrinsic = sourceSvg !== null ? svgSize(sourceSvg) : kind === 'csv' ? null : { width: 960, height: 540 }
      const sourceRect = (() => {
        try {
          const rect = sourceSvg?.getBoundingClientRect()
          return rect && rect.width > 0 && rect.height > 0 ? rect : null
        } catch {
          return null
        }
      })()
      const baseWidth = Math.max(1, Math.round(sourceRect?.width || (svgIntrinsic !== null ? svgIntrinsic.width : 960)))
      const baseHeight = Math.max(1, Math.round(sourceRect?.height || (svgIntrinsic !== null ? svgIntrinsic.height : 540)))

      const overlay = document.createElement('div')
      overlay.className = 'dshrender-overlay'
      overlay.tabIndex = -1

      const stage = document.createElement('div')
      stage.className = 'dshrender-overlay-stage'

      const bar = document.createElement('div')
      bar.className = 'dshrender-overlay-bar'
      const title = document.createElement('span')
      title.className = 'dshrender-overlay-title'
      title.textContent = translate(kind === 'mermaid' ? 'mermaidLabel' : kind === 'echarts' ? 'echartsLabel' : 'csvLabel') + ' · v9'
      const hint = document.createElement('span')
      hint.className = 'dshrender-overlay-hint'
      hint.textContent = translate('zoomHint')
      const actions = document.createElement('span')
      actions.className = 'dshrender-overlay-actions'

      const zoomOut = overlayButton('zoom-out', '−', translate('zoomOut'))
      const zoomValue = document.createElement('span')
      zoomValue.className = 'dshrender-overlay-zoom'
      zoomValue.textContent = '100%'
      const zoomIn = overlayButton('zoom-in', '+', translate('zoomIn'))
      const fitButton = overlayButton('zoom-fit', translate('zoomFit'), translate('zoomFit'))
      const resetButton = overlayButton('zoom-reset', translate('zoomReset'), translate('zoomReset'))
      const closeButton = overlayButton('close', translate('close'), translate('close'))
      actions.append(zoomOut, zoomValue, zoomIn, fitButton, resetButton, closeButton)
      bar.append(title, hint, actions)

      const viewport = document.createElement('div')
      viewport.className = 'dshrender-overlay-viewport'
      const canvas = document.createElement('div')
      canvas.className = 'dshrender-overlay-canvas'
      overlay.style.overflow = 'hidden'
      stage.style.height = 'calc(100vh - 48px)'
      stage.style.maxHeight = 'calc(100vh - 48px)'
      canvas.appendChild(source.cloneNode(true))
      viewport.appendChild(canvas)
      stage.append(bar, viewport)
      overlay.appendChild(stage)
      document.body.appendChild(overlay)
      const previousBodyOverflow = document.body.style.overflow
      document.body.style.overflow = 'hidden'

      if (svgIntrinsic === null) {
        // Tabular content: no meaningful zoom, keep the table scrollable.
        viewport.dataset.static = 'true'
        zoomOut.hidden = true
        zoomValue.hidden = true
        zoomIn.hidden = true
        fitButton.hidden = true
        resetButton.hidden = true
        hint.hidden = true
      } else {
        // Never edit the cloned diagram (no viewBox/overflow/attribute
        // changes). Render it at exactly the size it already has in the
        // message, then scale the whole canvas as one picture.
        const clone = canvas.querySelector('svg')
        if (clone !== null) {
          clone.style.width = baseWidth + 'px'
          clone.style.height = baseHeight + 'px'
          clone.style.maxWidth = 'none'
          clone.style.maxHeight = 'none'
          clone.style.display = 'block'
          clone.style.flex = 'none'
        }
        canvas.style.width = '100%'
        canvas.style.height = '100%'
        canvas.style.display = 'flex'
        canvas.style.alignItems = 'center'
        canvas.style.justifyContent = 'center'
        canvas.style.transformOrigin = 'center center'
        viewport.style.overflow = 'hidden'
      }

      const state = { scale: 1, x: 0, y: 0 }
      const apply = () => {
        if (svgIntrinsic !== null) {
          // Scale the whole canvas. The SVG keeps its original layout size, so
          // Mermaid's foreignObject HTML never reflows (which previously
          // produced inner scrollbars and clipped nodes while zooming).
          canvas.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.scale})`
        }
        zoomValue.textContent = Math.round(state.scale * 100) + '%'
      }
      const fitView = () => {
        if (svgIntrinsic === null) return
        const width = Math.max(1, canvas.clientWidth || viewport.clientWidth)
        const height = Math.max(1, canvas.clientHeight || viewport.clientHeight)
        const scale = Math.min(width / baseWidth, height / baseHeight)
        state.scale = clampZoom(scale)
        state.x = 0
        state.y = 0
        clampPan()
        apply()
      }
      const fit = fitView
      const reset = () => {
        if (svgIntrinsic === null) return
        const width = canvas.clientWidth || 1
        const height = canvas.clientHeight || 1
        state.scale = 1
        state.x = (width - baseWidth) / 2
        state.y = (height - baseHeight) / 2
        clampPan()
        apply()
      }
      const clampPan = () => {
        const width = canvas.clientWidth || 1
        const height = canvas.clientHeight || 1
        const overflowX = Math.max(0, (baseWidth * state.scale - width) / 2)
        const overflowY = Math.max(0, (baseHeight * state.scale - height) / 2)
        state.x = Math.min(overflowX, Math.max(-overflowX, state.x))
        state.y = Math.min(overflowY, Math.max(-overflowY, state.y))
      }
      const zoom = factor => {
        if (svgIntrinsic === null) return
        state.scale = clampZoom(state.scale * factor)
        clampPan()
        apply()
      }

      const onWheel = event => {
        if (svgIntrinsic === null) return
        event.preventDefault()
        const rect = viewport.getBoundingClientRect()
        zoom(Math.exp(-event.deltaY * 0.0015), event.clientX - rect.left, event.clientY - rect.top)
      }

      let drag = null
      const onPointerDown = event => {
        if (svgIntrinsic === null || event.button !== 0) return
        drag = { id: event.pointerId, startX: event.clientX, startY: event.clientY, x: state.x, y: state.y }
        viewport.dataset.dragging = 'true'
        try { viewport.setPointerCapture(event.pointerId) } catch { /* capture is best-effort */ }
      }
      const onPointerMove = event => {
        if (drag === null || event.pointerId !== drag.id) return
        state.x = drag.x + (event.clientX - drag.startX)
        state.y = drag.y + (event.clientY - drag.startY)
        clampPan()
        apply()
      }
      const onPointerUp = event => {
        if (drag === null || event.pointerId !== drag.id) return
        drag = null
        delete viewport.dataset.dragging
        try { viewport.releasePointerCapture(event.pointerId) } catch { /* best-effort */ }
      }

      const onKey = event => {
        if (event.key === 'Escape') {
          event.preventDefault()
          dismiss()
          return
        }
        if (svgIntrinsic === null) return
        if (event.key === '+' || event.key === '=') {
          event.preventDefault()
          zoom(1.25)
        } else if (event.key === '-') {
          event.preventDefault()
          zoom(1 / 1.25)
        } else if (event.key === '0' || event.key.toLowerCase() === 'f') {
          event.preventDefault()
          fit()
        } else if (event.key.toLowerCase() === 'r') {
          event.preventDefault()
          reset()
        }
      }
      const onResize = () => fit()

      const dismiss = () => {
        document.body.style.overflow = previousBodyOverflow
        resizeObserver?.disconnect()
        overlay.remove()
        document.removeEventListener('keydown', onKey, true)
        window.removeEventListener('resize', onResize)
        if (fullscreenCleanup === dismiss) fullscreenCleanup = null
      }

      const resizeObserver = typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => { if (svgIntrinsic !== null) fitView() })
        : null
      if (resizeObserver !== null) resizeObserver.observe(viewport)

      zoomOut.addEventListener('click', () => zoom(1 / 1.25))
      zoomIn.addEventListener('click', () => zoom(1.25))
      fitButton.addEventListener('click', fit)
      resetButton.addEventListener('click', reset)
      closeButton.addEventListener('click', dismiss)
      viewport.addEventListener('wheel', onWheel, { passive: false })
      viewport.addEventListener('pointerdown', onPointerDown)
      viewport.addEventListener('pointermove', onPointerMove)
      viewport.addEventListener('pointerup', onPointerUp)
      viewport.addEventListener('pointercancel', onPointerUp)
      viewport.addEventListener('dblclick', fit)
      overlay.addEventListener('click', event => {
        if (event.target === overlay) dismiss()
      })
      document.addEventListener('keydown', onKey, true)
      window.addEventListener('resize', onResize)
      fullscreenCleanup = dismiss
      overlay.focus()
      // The viewport has its final size only after the first layout pass;
      // fitting in the second frame also covers late flex relayout.
      requestAnimationFrame(() => {
        fitView()
        requestAnimationFrame(fitView)
      })
    }

    /* ------------------------------ enhancement engine ------------------------------ */

    /** @type {WeakMap<HTMLElement, { timer: number, token: number, theme: string, hash: string, kind: string }>} */
    const blockState = new WeakMap()

    /**
     * Render (or re-render) one block's surface.
     * @param {HTMLElement} block - `.md-code-block` element.
     */
    function enhanceBlock(block) {
      if (runtime.disposed) return
      if (!(block instanceof HTMLElement) || !block.isConnected) return
      if (block.hasAttribute('data-dsh-render-skip')) return
      const content = block.querySelector(CONTENT_SELECTOR)
      if (content === null) return
      const source = content.textContent ?? ''
      const existing = surfaceOf(block)
      const previous = blockState.get(block)
      const sourceHash = hashString(source)
      if (previous !== undefined && previous.hash === sourceHash && existing !== null) {
        const themeNow = previous.kind === 'mermaid' || previous.kind === 'echarts' ? resolveTheme() : 'light'
        if (existing.dataset.dshRenderState === 'ready' && previous.theme === themeNow) return
        if (existing.dataset.dshRenderState === 'error' && previous.errorHash === sourceHash) return
      }
      if (previous !== undefined && previous.kind === 'none' && previous.hash === sourceHash) return
      const kind = detectFenceKind(source)
      if (kind === null) {
        if (existing !== null) {
          existing.remove()
          setSourceHidden(block, false)
        }
        blockState.set(block, {
          timer: 0, token: 0, theme: '', hash: sourceHash, kind: 'none',
          errorHash: '', errorKind: '', errorTheme: '',
        })
        return
      }
      const surface = ensureSurface(block, kind)
      const state = previous ?? {
        timer: 0, token: 0, theme: '', hash: '', kind: '',
        errorHash: '', errorKind: '', errorTheme: '',
      }
      blockState.set(block, state)
      const theme = kind === 'mermaid' || kind === 'echarts' ? resolveTheme() : 'light'
      if (state.hash === sourceHash && state.theme === theme && state.kind === kind && surface.dataset.dshRenderState === 'ready') {
        return
      }
      state.hash = sourceHash
      state.theme = theme
      state.kind = kind
      state.token += 1
      const token = state.token
      setKindLabel(surface, translate(kind === 'mermaid' ? 'mermaidLabel' : kind === 'echarts' ? 'echartsLabel' : 'csvLabel'))
      refreshSurfaceLabels(surface)
      surface.dataset.dshRenderTheme = theme
      surface.dataset.dshRenderKind = kind
      surface.dataset.dshRenderReady = 'false'
      const body = surface.querySelector('[data-dsh-render-body]')
      if (!(body instanceof HTMLElement)) return
      if (typeof source.length === 'number' && kind === 'mermaid' && source.length > runtime.settings.mermaid.maxSourceChars) {
        setStatus(surface, translate('sourceTooLarge'))
        body.innerHTML = '<div class="dshrender-empty">' + escapeHtml(translate('sourceTooLarge')) + '</div>'
        setSourceHidden(block, false)
        return
      }
      setStatus(surface, translate('rendering'))
      if (body.childElementCount === 0) body.innerHTML = '<div class="dshrender-empty">' + escapeHtml(translate('rendering')) + '</div>'
      const delay = Math.max(200, Math.min(3000, runtime.settings.mermaid.debounceMs))
      if (state.timer !== 0) clearTimeout(state.timer)
      state.timer = setTimeout(() => {
        state.timer = 0
        void runRender(block, surface, body, source, kind, theme, token)
      }, delay)
    }

    /**
     * Execute one render and apply the result if the token is still current.
     * @param {HTMLElement} block - code block.
     * @param {HTMLElement} surface - surface element.
     * @param {HTMLElement} body - body element.
     * @param {string} source - block source.
     * @param {'mermaid' | 'echarts' | 'csv'} kind - kind.
     * @param {'light' | 'dark'} theme - theme.
     * @param {number} token - render token.
     */
    async function runRender(block, surface, body, source, kind, theme, token) {
      const state = blockState.get(block)
      if (state === undefined || state.token !== token || runtime.disposed || !block.isConnected) return
      const sourceHash = hashString(source)
      try {
        if (kind === 'mermaid') {
          const svg = await renderMermaidSvg(source, theme)
          if (state.token !== token || !block.isConnected) return
          body.innerHTML = svg
          setSourceHidden(block, true)
          body.style.display = ''
          markSurfaceReady(surface, state)
          setStatus(surface, '')
          setSourceButton(surface, true)
        } else if (kind === 'echarts') {
          const option = parseEchartsOption(source)
          if (option === null) throw new Error('invalid ECharts option')
          const height = runtime.settings.chartHeight ?? 360
          const svg = await renderEchartsSvg(option, theme, height)
          if (state.token !== token || !block.isConnected) return
          body.innerHTML = svg
          setSourceHidden(block, true)
          body.style.display = ''
          markSurfaceReady(surface, state)
          setStatus(surface, '')
          setSourceButton(surface, true)
        } else {
          const table = parseCsv(source)
          if (table === null) throw new Error('invalid CSV')
          if (state.token !== token || !block.isConnected) return
          body.innerHTML = renderCsvTable(table)
          setSourceHidden(block, true)
          body.style.display = ''
          markSurfaceReady(surface, state)
          setStatus(surface, '')
          setSourceButton(surface, true)
        }
      } catch (cause) {
        if (state.token !== token) return
        setStatus(surface, translate('renderFailed') + ': ' + messageOf(cause).slice(0, 240))
        body.innerHTML = '<div class="dshrender-empty">' + escapeHtml(translate('renderFailed')) + '</div>'
        body.style.display = ''
        markSurfaceError(surface, state, sourceHash, kind, theme)
        setSourceButton(surface, true)
        // Keep the source visible on failure.
        setSourceHidden(block, false)
      }
    }

    /** @param {{ header: string[], rows: string[][] }} table - parsed CSV. @returns {string} */
    function renderCsvTable(table) {
      const head = '<tr>' + table.header.map(cell => '<th>' + escapeHtml(cell) + '</th>').join('') + '</tr>'
      const rows = table.rows.map(row => '<tr>' + row.map(cell => '<td>' + escapeHtml(cell) + '</td>').join('') + '</tr>').join('')
      return '<div class="dshrender-tablewrap"><table class="dshrender-table"><thead>' + head + '</thead><tbody>' + rows + '</tbody></table></div>'
    }

    /**
     * Scan a root for code blocks that may need enhancement.
     * @param {ParentNode} root - subtree root.
     */
    function scanBlocks(root) {
      if (runtime.disposed) return
      if (root instanceof HTMLElement && root.matches(BLOCK_SELECTOR)) enhanceBlock(root)
      const blocks = root.querySelectorAll?.(BLOCK_SELECTOR)
      if (blocks === undefined) return
      for (const block of blocks) {
        if (block instanceof HTMLElement) enhanceBlock(block)
      }
    }

    /* ------------------------------ long user messages ------------------------------ */

    /**
     * Collapse one long user message when it exceeds the configured height.
     * @param {HTMLElement} node - `[data-chat-flow-kind="user"]` node.
     */
    function enhanceUserMessage(node) {
      if (runtime.disposed) return
      const bubble = node.querySelector('[data-message-bubble]')
      if (!(bubble instanceof HTMLElement)) return
      const appearance = runtime.settings.appearance ?? {}
      if (appearance.collapseUserMessages === false) {
        resetUserMessage(node)
        return
      }
      const state = bubble.dataset.dshrenderUserState
      if (state === 'collapsed' || state === 'expanded') return
      const maxHeight = clampUserMessageMaxHeight(appearance.userMessageMaxHeight)
      if (!shouldCollapseUserMessage(bubble.scrollHeight, maxHeight)) {
        bubble.dataset.dshrenderUserState = 'none'
        return
      }
      bubble.classList.add('dshrender-user-collapsed')
      bubble.dataset.dshrenderUserState = 'collapsed'
      let button = node.querySelector('.dshrender-user-toggle')
      if (button === null) {
        button = document.createElement('button')
        button.type = 'button'
        button.className = 'dshrender-user-toggle'
        bubble.after(button)
      }
      button.textContent = translate('expandMore')
      button.setAttribute('aria-expanded', 'false')
    }

    /** @param {HTMLElement} node - user message node. */
    function resetUserMessage(node) {
      const button = node.querySelector('.dshrender-user-toggle')
      if (button !== null) button.remove()
      const bubble = node.querySelector('[data-message-bubble]')
      if (bubble instanceof HTMLElement) {
        bubble.classList.remove('dshrender-user-collapsed')
        delete bubble.dataset.dshrenderUserState
      }
    }

    /** @param {ParentNode} [root] - scan root. */
    function scanUserMessages(root = document) {
      if (runtime.disposed) return
      const nodes = root.querySelectorAll?.('[data-chat-flow-kind="user"]')
      if (nodes === undefined) return
      for (const node of nodes) {
        if (node instanceof HTMLElement) {
          try { enhanceUserMessage(node) } catch { /* best-effort */ }
        }
      }
    }

    /** @param {ParentNode} [root] - reset root. */
    function resetUserMessages(root = document) {
      const nodes = root.querySelectorAll?.('[data-chat-flow-kind="user"]')
      if (nodes === undefined) return
      for (const node of nodes) {
        if (node instanceof HTMLElement) resetUserMessage(node)
      }
    }

    /** @param {MouseEvent} event - click on a collapse toggle. */
    function onUserMessageClick(event) {
      const target = event.target
      if (!(target instanceof Element)) return
      const button = target.closest('.dshrender-user-toggle')
      if (!(button instanceof HTMLElement)) return
      const node = button.closest('[data-chat-flow-kind="user"]')
      if (!(node instanceof HTMLElement)) return
      const bubble = node.querySelector('[data-message-bubble]')
      if (!(bubble instanceof HTMLElement)) return
      const collapsed = bubble.classList.toggle('dshrender-user-collapsed')
      bubble.dataset.dshrenderUserState = collapsed ? 'collapsed' : 'expanded'
      button.textContent = translate(collapsed ? 'expandMore' : 'showLess')
      button.setAttribute('aria-expanded', String(!collapsed))
    }

    let scanScheduled = false
    /** @type {Set<HTMLElement>} */
    const pendingBlocks = new Set()

    /** @param {HTMLElement} block - code block to revisit. */
    function markBlock(block) {
      pendingBlocks.add(block)
      scheduleScan()
    }

    function scheduleScan() {
      if (scanScheduled || runtime.disposed) return
      scanScheduled = true
      setTimeout(() => {
        scanScheduled = false
        if (runtime.disposed) return
        const blocks = [...pendingBlocks]
        pendingBlocks.clear()
        for (const block of blocks) {
          try {
            enhanceBlock(block)
          } catch (cause) {
            try {
              console.warn('dsh-render: block enhancement failed', cause)
            } catch {
              // Logging is best-effort.
            }
          }
        }
        scanUserMessages(document)
      }, 40)
    }

    /** @param {Node} node - DOM node. @returns {boolean} */
    function insideSurface(node) {
      let current = node
      while (current !== null) {
        if (current instanceof Element && current.hasAttribute('data-dsh-render-surface')) return true
        current = current.parentNode
      }
      return false
    }

    /** @param {Node} node - DOM node. @returns {HTMLElement | null} */
    function closestBlock(node) {
      let current = node
      while (current !== null) {
        if (current instanceof HTMLElement && current.matches(BLOCK_SELECTOR)) return current
        current = current.parentNode
      }
      return null
    }

    /**
     * Start observing the document for code blocks and theme changes.
     * @returns {() => void}
     */
    function startObserver() {
      if (typeof MutationObserver !== 'function') return () => {}
      const observer = new MutationObserver(mutations => {
        for (const mutation of mutations) {
          if (mutation.type === 'attributes') {
            if (mutation.attributeName === 'data-ds-dark-theme') handleThemeChange()
            continue
          }
          if (mutation.type === 'characterData') {
            const parent = mutation.target.parentNode
            if (parent instanceof Node && !insideSurface(mutation.target)) {
              const block = closestBlock(parent)
              if (block !== null) markBlock(block)
            }
            continue
          }
          if (mutation.type === 'childList') {
            for (const added of mutation.addedNodes) {
              if (!(added instanceof Element)) continue
              if (insideSurface(added)) continue
              if (added.matches(BLOCK_SELECTOR)) markBlock(added)
              const nested = added.querySelectorAll?.(BLOCK_SELECTOR)
              if (nested !== undefined) {
                for (const block of nested) {
                  if (block instanceof HTMLElement) markBlock(block)
                }
              }
              const block = closestBlock(added)
              if (block !== null) markBlock(block)
            }
            const block = closestBlock(mutation.target)
            if (block !== null && !insideSurface(mutation.target)) markBlock(block)
          }
        }
        scheduleScan()
      })
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['data-ds-dark-theme'],
      })
      runtime.observers.push(observer)
      return () => {
        observer.disconnect()
        runtime.observers = runtime.observers.filter(item => item !== observer)
      }
    }

    function handleThemeChange() {
      if (runtime.disposed) return
      svgCache.clear()
      mermaidThemeKey = ''
      for (const surface of document.querySelectorAll(SURFACE_SELECTOR)) {
        const block = surface.closest(BLOCK_SELECTOR)
        if (!(block instanceof HTMLElement)) continue
        const state = blockState.get(block)
        if (state !== undefined) {
          state.hash = ''
          state.errorHash = ''
          state.timer = 0
        }
        markBlock(block)
      }
    }

    /* ------------------------------ settings runtime ------------------------------ */

    /**
     * Apply a new settings snapshot: refresh labels, drop disabled surfaces, and
     * re-evaluate every code block on the page.
     * @param {Record<string, any>} next - normalized settings.
     */
    function applySettings(next) {
      runtime.settings = next
      for (const block of document.querySelectorAll(BLOCK_SELECTOR)) {
        if (!(block instanceof HTMLElement)) continue
        const state = blockState.get(block)
        if (state !== undefined) {
          state.hash = ''
          state.errorHash = ''
          state.timer = 0
        }
        markBlock(block)
      }
      scanBlocks(document)
      resetUserMessages()
      scanUserMessages(document)
      applyStyles(next)
    }

    /**
     * Fetch settings from the Host half. Failure keeps the defaults so the page
     * still renders.
     * @returns {Promise<Record<string, any>>}
     */
    async function fetchSettings() {
      try {
        const response = await fetch(API_STATE, { credentials: 'same-origin', headers: { accept: 'application/json' } })
        if (!response.ok) throw new Error('state request failed: ' + response.status)
        const payload = await response.json()
        if (payload?.ok !== true || !isRecord(payload.value)) throw new Error('state payload is malformed')
        runtime.settingsLoaded = true
        return mergeSettings(payload.value.settings, defaultSettings())
      } catch (cause) {
        try {
          console.warn('dsh-render: settings unavailable, using defaults: ' + messageOf(cause))
        } catch {
          // Logging is best-effort.
        }
        return defaultSettings()
      }
    }

    /* ------------------------------ styles ------------------------------ */

    /** Font stacks for every supported code-font choice (no webfonts). */
    const CODE_FONT_STACKS = {
      inherit: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)',
      system: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      jetbrains: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fira: '"Fira Code", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      cascadia: '"Cascadia Code", "Cascadia Mono", ui-monospace, Menlo, Consolas, monospace',
      sfmono: '"SF Mono", SFMono-Regular, Menlo, Consolas, monospace',
      consolas: 'Consolas, "Liberation Mono", Menlo, monospace',
      menlo: 'Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    }

    /** @param {unknown} value - raw collapse height. @returns {number} */
    function clampUserMessageMaxHeight(value) {
      const height = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 360
      return Math.min(800, Math.max(160, height))
    }

    /**
     * Whether one user bubble should start collapsed.
     * @param {number} scrollHeight - full bubble content height.
     * @param {number} maxHeight - configured limit.
     * @returns {boolean}
     */
    function shouldCollapseUserMessage(scrollHeight, maxHeight) {
      return typeof scrollHeight === 'number' && scrollHeight > clampUserMessageMaxHeight(maxHeight) + 24
    }

    /** @param {Record<string, any>} appearance - normalized appearance settings. @returns {string} */
    function codeFontStack(appearance) {
      if (appearance.codeFont === 'custom' && typeof appearance.customCodeFont === 'string' && appearance.customCodeFont.trim() !== '') {
        return appearance.customCodeFont.trim()
      }
      return CODE_FONT_STACKS[appearance.codeFont] ?? CODE_FONT_STACKS.inherit
    }

    /**
     * Build the Markdown appearance layer. Every selector is scoped to the
     * transcript or the document preview, so settings pages and plugin UI keep
     * their own typography.
     * @param {Record<string, any>} settings - normalized settings.
     * @returns {string}
     */
    function appearanceCss(settings) {
      const appearance = settings.appearance ?? {}
      const scopes = ':is([data-chat-flow], [data-document-markdown])'
      const font = codeFontStack(appearance)
      const declarations = ['font-family:' + font + ';']
      if (typeof appearance.codeFontSize === 'number' && appearance.codeFontSize > 0) {
        declarations.push('font-size:' + appearance.codeFontSize + 'px;')
      }
      if (typeof appearance.codeLineHeight === 'number' && appearance.codeLineHeight > 0) {
        declarations.push('line-height:' + appearance.codeLineHeight + ';')
      }
      declarations.push('font-variant-ligatures:' + (appearance.codeLigatures === true ? 'normal' : 'none') + ';')
      const maxHeight = clampUserMessageMaxHeight(appearance.userMessageMaxHeight)
      const rules = [
        ':root { --dshrender-user-max-height: ' + maxHeight + 'px; }',
        scopes + ' .md-code-block pre, ' + scopes + ' .md-code-block code, ' + scopes + ' :not(pre) > code { ' + declarations.join('') + ' }',
      ]
      if (appearance.inlineCode === 'claude') {
        rules.push(
          scopes + ' :not(pre) > code { color:color-mix(in srgb, var(--dsw-alias-link) 84%, #000 16%) !important; background:rgba(0,0,0,.055) !important; border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.38)) !important; border-radius:4px !important; padding:0.1em 0.35em !important; font-weight:400 !important; }',
          'body[data-ds-dark-theme] ' + scopes + ' :not(pre) > code { color:var(--dsw-alias-link) !important; background:rgba(255,255,255,.09) !important; }',
          scopes + ' pre code { color:inherit !important; background:transparent !important; border:0 !important; padding:0 !important; border-radius:0 !important; font-weight:inherit !important; }',
        )
      }
      if (appearance.codeBlock === 'claude' || appearance.codeBlock === 'minimal') {
        rules.push(
          '.md-code-block { border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.4)); border-radius:10px; box-sizing:border-box; }',
          '.md-code-block pre { border-bottom-left-radius:9px; border-bottom-right-radius:9px; }',
        )
        if (appearance.codeBlock === 'claude') {
          rules.push('.md-code-block [data-code-block-banner] { border-bottom:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.4)); }')
        }
      }
      if (appearance.table === 'claude') {
        const table = ':is([data-chat-flow], [data-document-markdown]) table'
        const tableScope = ':is([data-chat-flow], [data-document-markdown])'
        rules.push(
          // Wide tables keep the host's scroll wrapper, but force auto so the
          // wrapper never paints an empty scrollbar (the host's hover rule uses
          // `overflow-x: scroll`, which shows a bar even when the table fits).
          // The table's wrapper is a flex item in the message column; without an
          // explicit width it shrinks to the table's content, so `width:100%`
          // on the table resolves against a tiny box (one character per column).
          // Pin the wrapper to the conversation column first.
          tableScope + ' div:has(> table) { width:100% !important; max-width:100% !important; }',
          tableScope + ' .md-table-wide { width:100% !important; max-width:100% !important; margin-left:0 !important; padding-left:0 !important; overflow-x:hidden !important; padding-bottom:0 !important; }',
          // Fit every table to the conversation column. Fixed layout shares the
          // width equally across columns; cells wrap as much as they need. The
          // table never exceeds the column, and there is no horizontal scroll.
          table + ' { border-collapse:separate; border-spacing:0; border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.4)); border-radius:10px; font-size:var(--dsh-content-font-size, 14px); line-height:1.5; width:var(--dsh-chat-content-width, 100%) !important; max-width:100% !important; table-layout:fixed !important; box-sizing:border-box !important; }',
          table + ' th, ' + table + ' td { padding:8px 12px !important; border-bottom:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.4)) !important; vertical-align:top; font-size:var(--dsh-content-font-size, 14px) !important; line-height:1.5 !important; min-width:0 !important; max-width:none !important; white-space:normal !important; overflow-wrap:anywhere; word-break:break-word; }',
          // Long URLs / inline code inside cells may break anywhere as well.
          table + ' code { white-space:normal !important; overflow-wrap:anywhere; }',
          table + ' th { background:rgba(0,0,0,.05) !important; background:color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent) !important; color:var(--dsw-alias-label-primary, #1c1d20) !important; font-weight:600 !important; line-height:1.5 !important; border-bottom:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.4)) !important; }',
          'body[data-ds-dark-theme] ' + table + ' th { background:rgba(255,255,255,.07) !important; }',
          table + ' tbody tr:last-child td { border-bottom:0 !important; }',
          table + ' th:first-child { border-top-left-radius:10px; }',
          table + ' th:last-child { border-top-right-radius:10px; }',
          table + ' tbody tr:last-child td:first-child { border-bottom-left-radius:10px; }',
          table + ' tbody tr:last-child td:last-child { border-bottom-right-radius:10px; }',
          table + ' code { font-size:0.9em !important; }',
        )
      }
      return rules.join('\n')
    }

    /** @param {Record<string, any>} settings - settings snapshot. */
    function applyAppearance(settings) {
      let style = document.getElementById('dsh-render-appearance')
      if (style === null) {
        style = document.createElement('style')
        style.id = 'dsh-render-appearance'
        document.head.appendChild(style)
      }
      style.textContent = appearanceCss(settings)
    }

    /** @param {unknown} value - raw size. @param {number} min - minimum. @param {number} max - maximum. @returns {number} */
    function clampTypographySize(value, min, max) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 0
      const size = Math.round(value)
      return size === 0 ? 0 : Math.min(max, Math.max(min, size))
    }

    /**
     * General-page typography overrides. The variables are written on body with
     * !important so they win over the native presenter's inline values; an empty
     * string restores the native settings.
     * @param {Record<string, any>} settings - normalized settings.
     * @returns {string}
     */
    function typographyCss(settings) {
      const typography = settings.typography ?? {}
      const declarations = []
      const font = cleanCustomFont(typography.textFontFamily)
      if (font !== '') declarations.push('--dsh-font-family-text:' + font + ' !important;')
      const textSize = clampTypographySize(typography.textFontSize, 10, 22)
      if (textSize > 0) declarations.push('--dsh-content-font-size:' + textSize + 'px !important;')
      const codeSize = clampTypographySize(typography.codeFontSize, 10, 16)
      if (codeSize > 0) declarations.push('--dsh-code-font-size:' + codeSize + 'px !important;')
      const terminalSize = clampTypographySize(typography.terminalFontSize, 10, 20)
      if (terminalSize > 0) declarations.push('--dsh-terminal-font-size:' + terminalSize + 'px !important;')
      return declarations.length === 0 ? '' : 'body { ' + declarations.join('') + ' }'
    }

    /**
     * Whole-interface zoom bounds.
     * @param {unknown} value - raw scale.
     * @returns {number}
     */
    function clampUiScale(value) {
      const scale = typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) / 100 : 1
      return Math.min(1.3, Math.max(0.8, scale))
    }

    /**
     * Whole-interface zoom rule; 100% emits nothing so the native layout wins.
     * @param {Record<string, any>} settings - normalized settings.
     * @returns {string}
     */
    function zoomCss(settings) {
      const scale = clampUiScale(settings.uiScale)
      return scale === 1 ? '' : 'body { zoom: ' + scale + '; }'
    }

    /** @param {Record<string, any>} settings - normalized settings. */
    function applyUiZoom(settings) {
      let style = document.getElementById('dsh-render-zoom')
      if (style === null) {
        style = document.createElement('style')
        style.id = 'dsh-render-zoom'
        document.head.appendChild(style)
      }
      style.textContent = zoomCss(settings)
    }

    /** @param {Record<string, any>} settings - normalized settings. */
    function applyUiTypography(settings) {
      let style = document.getElementById('dsh-render-typography')
      if (style === null) {
        style = document.createElement('style')
        style.id = 'dsh-render-typography'
        document.head.appendChild(style)
      }
      style.textContent = typographyCss(settings)
    }

    /** @param {Record<string, any>} settings - settings snapshot. */
    function applyStyles(settings) {
      let style = document.getElementById(STYLE_ID)
      if (style === null) {
        style = document.createElement('style')
        style.id = STYLE_ID
        document.head.appendChild(style)
      }
      style.textContent = buildCss()
      applyAppearance(settings)
    }

    /** @returns {string} */
    function buildCss() {
      return [
        '.dshrender-surface{display:flex;flex-direction:column;gap:8px;margin:2px 0 8px;padding:10px 12px 12px;border:0.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1,#fff);}',
        '.dshrender-bar{display:flex;align-items:center;gap:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#888);}',
        '.dshrender-kind{font-weight:600;color:var(--dsw-alias-label-secondary,#555);}',
        '.dshrender-status{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:46%;}',
        '.dshrender-status:empty{display:none;}',
        '.dshrender-spacer{flex:1;}',
        '.dshrender-actions{display:flex;align-items:center;gap:4px;flex-wrap:wrap;}',
        '.dshrender-btn{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#555);font:inherit;font-size:12px;line-height:18px;padding:2px 6px;border-radius:var(--dsw-radius-xs,4px);cursor:pointer;}',
        '.dshrender-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#111);}',
        '.dshrender-body{display:flex;justify-content:center;overflow:auto;max-height:620px;padding:4px 0;}',
        '.dshrender-body svg{max-width:100%;height:auto;}',
        '.dshrender-empty{font-size:12px;color:var(--dsw-alias-label-tertiary,#888);padding:16px 8px;}',
        '.dshrender-tablewrap{width:100%;overflow:auto;max-height:560px;}',
        '.dshrender-table{border-collapse:collapse;font-size:12px;line-height:18px;min-width:50%;}',
        '.dshrender-table th,.dshrender-table td{border:0.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));padding:5px 10px;text-align:left;vertical-align:top;}',
        '.dshrender-table th{background:var(--dsw-alias-bg-layer-2,#f5f5f5);font-weight:600;position:sticky;top:0;}',
        ".dshrender-overlay{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.62);display:flex;align-items:center;justify-content:center;padding:24px;overflow:hidden;}",
        ".dshrender-overlay-stage{width:min(1500px,96vw);height:calc(100vh - 48px);display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1,#fff);border-radius:12px;box-shadow:0 16px 60px rgba(0,0,0,.4);overflow:hidden;}",
        ".dshrender-overlay-bar{display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:0.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#888);flex:none;}",
        ".dshrender-overlay-title{font-weight:600;color:var(--dsw-alias-label-secondary,#555);}",
        ".dshrender-overlay-hint{color:var(--dsw-alias-label-tertiary,#888);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
        ".dshrender-overlay-actions{margin-left:auto;display:flex;align-items:center;gap:4px;flex-wrap:wrap;}",
        ".dshrender-overlay-btn{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#555);font:inherit;font-size:12px;line-height:18px;padding:2px 8px;border-radius:var(--dsw-radius-xs,4px);cursor:pointer;}",
        ".dshrender-overlay-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#111);}",
        ".dshrender-overlay-zoom{min-width:44px;text-align:center;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#555);}",
        ".dshrender-overlay-viewport{position:relative;flex:1;min-height:0;overflow:hidden;cursor:grab;touch-action:none;background:var(--dsw-alias-bg-base,#fafafa);}",
        ".dshrender-overlay-viewport[data-dragging=\"true\"]{cursor:grabbing;}",
        ".dshrender-overlay-viewport[data-static=\"true\"]{overflow:auto;cursor:default;}",
        ".dshrender-overlay-canvas{position:absolute;left:0;top:0;transform-origin:0 0;}",
        ".dshrender-overlay-canvas svg{display:block;max-width:none;max-height:none;flex:none;}",
        ".dshrender-overlay-viewport[data-static=\"true\"] .dshrender-overlay-canvas{position:relative;padding:16px;}",
        ".dshrender-overlay-viewport[data-static=\"true\"] .dshrender-tablewrap{max-height:none;}",
        '.dshrender-settings{display:flex;flex-direction:column;gap:22px;max-width:760px;width:100%;}',
        '.dshrender-settings h2{margin:0;font-size:16px;line-height:24px;color:var(--dsw-alias-label-primary,#111);}',
        '.dshrender-settings p{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary,#888);}',
        '.dshrender-group{display:flex;flex-direction:column;gap:12px;padding:16px;border:0.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));border-radius:10px;}',
        '.dshrender-group h3{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#555);}',
        '.dshrender-row{display:flex;align-items:flex-start;gap:12px;justify-content:space-between;}',
        '.dshrender-row-copy{display:flex;flex-direction:column;gap:2px;min-width:0;}',
        '.dshrender-row-title{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,#111);}',
        '.dshrender-row-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#888);}',
        '.dshrender-control{flex:none;display:flex;align-items:center;gap:8px;}',
        '.dshrender-input,.dshrender-select,.dshrender-textarea{box-sizing:border-box;border:0.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.4));border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111);font:inherit;font-size:12px;padding:4px 8px;}',
        '.dshrender-textarea{width:100%;min-height:72px;resize:vertical;font-family:var(--dsw-font-family-mono,monospace);}',
        '.dshrender-actions-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
        '.dshrender-primary{border:0;border-radius:7px;padding:6px 14px;font:inherit;font-size:13px;cursor:pointer;background:var(--dsw-alias-button-primary-fill,#2f6fed);color:var(--dsw-alias-label-primary-foreground,#fff);}',
        '.dshrender-primary:disabled{opacity:.5;cursor:default;}',
        '.dshrender-secondary{border:0.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.4));border-radius:7px;padding:6px 14px;font:inherit;font-size:13px;cursor:pointer;background:transparent;color:var(--dsw-alias-label-primary,#111);}',
        '.dshrender-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#888);}',
        '.dshrender-note[data-kind="error"]{color:var(--dsw-alias-state-error-primary,#c0392b);}',
        '.dshrender-note[data-kind="success"]{color:var(--dsw-alias-state-success-primary,#2e7d32);}',
        '.dshrender-vendor{display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-tertiary,#888);}',
        '.dshrender-vendor code{font-family:var(--dsw-font-family-mono,monospace);}',
        '.dshrender-checkbox{width:15px;height:15px;accent-color:var(--dsw-alias-brand-primary,#2f6fed);}',
        '.dshrender-user-collapsed{max-height:var(--dshrender-user-max-height,360px);overflow:hidden;-webkit-mask-image:linear-gradient(to bottom,#000 calc(100% - 56px),transparent);mask-image:linear-gradient(to bottom,#000 calc(100% - 56px),transparent);}',
        '.dshrender-user-toggle{align-self:flex-end;display:inline-flex;align-items:center;margin:4px 0 0;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#555);font:inherit;font-size:12px;line-height:18px;padding:2px 8px;border-radius:var(--dsw-radius-xs,4px);cursor:pointer;}',
        '.dshrender-user-toggle:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#111);}',
        '.dshrender-general-typography{display:flex;flex-direction:column;gap:10px;padding:10px 0 14px;border-bottom:0.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));}',
        '.dshrender-typography-head{display:flex;flex-direction:column;gap:2px;}',
        '.dshrender-typography-grid{display:flex;flex-direction:column;gap:8px;}',
      ].join('\n')
    }

    /* ------------------------------ settings page ------------------------------ */

    /**
     * Persist one settings patch and apply it immediately.
     * @param {Record<string, any>} patch - partial settings.
     * @returns {Promise<Record<string, any>>} the normalized settings.
     */
    async function saveSettingsPatch(patch) {
      const response = await fetch(API_ACTION, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ settings: patch }),
      })
      if (!response.ok) throw new Error('HTTP ' + response.status)
      const payload = await response.json()
      if (payload?.ok !== true || !isRecord(payload.value)) throw new Error('malformed action response')
      const settings = mergeSettings(payload.value.settings, defaultSettings())
      runtime.settings = settings
      applyStyles(settings)
      return settings
    }

    /**
     * General settings page: interface font and the three font sizes. These
     * write the same CSS variables the native Appearance rows own; an empty
     * field or zero keeps the native value.
     * @returns {import('react').ReactNode}
     */
    function TypographyGeneralRows() {
      const [draft, setDraft] = useState(() => ({ ...runtime.settings.typography }))
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState('')
      useEffect(() => {
        let alive = true
        void fetch(API_STATE, { credentials: 'same-origin', headers: { accept: 'application/json' } })
          .then(response => response.json())
          .then(payload => {
            if (!alive || payload?.ok !== true || !isRecord(payload.value)) return
            const merged = mergeSettings(payload.value.settings, defaultSettings())
            runtime.settings = merged
            setDraft({ ...merged.typography })
          })
          .catch(() => { /* keep the current draft */ })
        return () => { alive = false }
      }, [])
      const patch = value => setDraft(current => ({ ...current, ...value }))
      const save = async reset => {
        setBusy(true)
        setNotice('')
        try {
          const typography = reset
            ? { textFontFamily: '', textFontSize: 0, codeFontSize: 0, terminalFontSize: 0 }
            : draft
          const settings = await saveSettingsPatch({ typography })
          setDraft({ ...settings.typography })
          setNotice(translate('typographySaved'))
        } catch (cause) {
          setNotice(translate('typographySaveFailed') + ': ' + messageOf(cause))
        } finally {
          setBusy(false)
        }
      }
      return h('div', { className: 'dshrender-general-typography' },
        h('div', { className: 'dshrender-typography-head' },
          h('span', { className: 'dshrender-row-title' }, translate('typographyTitle')),
          h('span', { className: 'dshrender-row-hint' }, translate('typographyHint'))),
        h('div', { className: 'dshrender-typography-grid' },
          settingRow(translate('typographyFont'), translate('typographyFontPlaceholder'),
            h('input', {
              className: 'dshrender-input', type: 'text', value: draft.textFontFamily,
              onChange: event => { patch({ textFontFamily: event.target.value }) },
            })),
          settingRow(translate('typographyTextSize'), translate('typographySizeHint'),
            h('input', {
              className: 'dshrender-input', type: 'number', min: 0, max: 22, step: 1, value: draft.textFontSize,
              onChange: event => { patch({ textFontSize: Number(event.target.value) || 0 }) },
            })),
          settingRow(translate('typographyCodeSize'), translate('typographySizeHint'),
            h('input', {
              className: 'dshrender-input', type: 'number', min: 0, max: 16, step: 1, value: draft.codeFontSize,
              onChange: event => { patch({ codeFontSize: Number(event.target.value) || 0 }) },
            })),
          settingRow(translate('typographyTerminalSize'), translate('typographySizeHint'),
            h('input', {
              className: 'dshrender-input', type: 'number', min: 0, max: 20, step: 1, value: draft.terminalFontSize,
              onChange: event => { patch({ terminalFontSize: Number(event.target.value) || 0 }) },
            }))),
        h('div', { className: 'dshrender-actions-row' },
          h('button', {
            type: 'button', className: 'dshrender-primary', disabled: busy,
            onClick: () => { void save(false) },
          }, busy ? translate('saving') : translate('typographySave')),
          h('button', {
            type: 'button', className: 'dshrender-secondary', disabled: busy,
            onClick: () => { void save(true) },
          }, translate('typographyFollowNative'))),
        notice === '' ? null : h('p', { className: 'dshrender-note' }, notice))
    }

    /**
     * General settings page: whole-interface zoom (font and controls).
     * @returns {import('react').ReactNode}
     */
    function UiScaleRows() {
      const [percent, setPercent] = useState(() => Math.round((runtime.settings.uiScale ?? 1) * 100))
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState('')
      useEffect(() => {
        let alive = true
        void fetch(API_STATE, { credentials: 'same-origin', headers: { accept: 'application/json' } })
          .then(response => response.json())
          .then(payload => {
            if (!alive || payload?.ok !== true || !isRecord(payload.value)) return
            const merged = mergeSettings(payload.value.settings, defaultSettings())
            runtime.settings = merged
            setPercent(Math.round((merged.uiScale ?? 1) * 100))
          })
          .catch(() => { /* keep the current value */ })
        return () => { alive = false }
      }, [])
      const save = async value => {
        setBusy(true)
        setNotice('')
        try {
          const settings = await saveSettingsPatch({ uiScale: value / 100 })
          setPercent(Math.round((settings.uiScale ?? 1) * 100))
          setNotice(translate('uiScaleSaved'))
        } catch (cause) {
          setNotice(translate('uiScaleSaveFailed') + ': ' + messageOf(cause))
        } finally {
          setBusy(false)
        }
      }
      return h('div', { className: 'dshrender-general-typography' },
        h('div', { className: 'dshrender-typography-head' },
          h('span', { className: 'dshrender-row-title' }, translate('uiScaleTitle')),
          h('span', { className: 'dshrender-row-hint' }, translate('uiScaleHint'))),
        h('div', { className: 'dshrender-actions-row' },
          h('input', {
            className: 'dshrender-input', type: 'number', min: 80, max: 130, step: 5, value: percent,
            onChange: event => { setPercent(Number(event.target.value) || 100) },
          }),
          h('span', { className: 'dshrender-row-hint' }, '%'),
          h('button', {
            type: 'button', className: 'dshrender-primary', disabled: busy,
            onClick: () => { void save(percent) },
          }, busy ? translate('saving') : translate('uiScaleSave')),
          h('button', {
            type: 'button', className: 'dshrender-secondary', disabled: busy,
            onClick: () => { void save(100) },
          }, translate('uiScaleReset'))),
        notice === '' ? null : h('p', { className: 'dshrender-note' }, notice))
    }

    /**
     * Settings → Rendering page.
     * @param {Record<string, any>} props - slot props.
     * @returns {import('react').ReactNode}
     */
    function RenderSettingsSection(props) {
      const [state, setState] = useState(null)
      const [phase, setPhase] = useState('loading')
      const [draft, setDraft] = useState(null)
      const [notice, setNotice] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const seqRef = useRef(0)

      const load = useCallback(async () => {
        const seq = ++seqRef.current
        setPhase('loading')
        setError('')
        try {
          const response = await fetch(API_STATE, { credentials: 'same-origin', headers: { accept: 'application/json' } })
          if (!response.ok) throw new Error('HTTP ' + response.status)
          const payload = await response.json()
          if (payload?.ok !== true || !isRecord(payload.value)) throw new Error('malformed state payload')
          if (seq !== seqRef.current) return
          const settings = mergeSettings(payload.value.settings, defaultSettings())
          runtime.settings = settings
          setState({ settings, vendor: payload.value.vendor ?? {} })
          setDraft(settings)
          setPhase('ready')
        } catch (cause) {
          if (seq !== seqRef.current) return
          setPhase('error')
          setError(messageOf(cause))
        }
      }, [])

      useEffect(() => {
        void load()
      }, [load])

      const save = useCallback(async (reset) => {
        setBusy(true)
        setNotice(null)
        try {
          const body = reset ? { action: 'reset' } : { settings: draft }
          const response = await fetch(API_ACTION, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(body),
          })
          if (!response.ok) throw new Error('HTTP ' + response.status)
          const payload = await response.json()
          if (payload?.ok !== true || !isRecord(payload.value)) throw new Error('malformed action response')
          const settings = mergeSettings(payload.value.settings, defaultSettings())
          setState(current => current === null ? { settings, vendor: {} } : { ...current, settings })
          setDraft(settings)
          runtime.settings = settings
          applySettings(settings)
          setNotice({ kind: 'success', text: translate('saved') })
        } catch (cause) {
          setNotice({ kind: 'error', text: translate('saveFailed') + ': ' + messageOf(cause) })
        } finally {
          setBusy(false)
        }
      }, [draft])

      const patch = useCallback((section, value) => {
        setDraft(current => current === null ? current : mergeSettings({ [section]: value }, current))
      }, [])

      const setMermaid = useCallback((value) => {
        setDraft(current => current === null ? current : { ...current, mermaid: { ...current.mermaid, ...value } })
      }, [])

      const setDetection = useCallback((value) => {
        setDraft(current => current === null ? current : { ...current, detection: { ...current.detection, ...value } })
      }, [])

      const setPrompt = useCallback((value) => {
        setDraft(current => current === null ? current : { ...current, prompt: { ...current.prompt, ...value } })
      }, [])

      const setAppearance = useCallback((value) => {
        setDraft(current => current === null ? current : { ...current, appearance: { ...current.appearance, ...value } })
      }, [])

      if (phase === 'loading' && state === null) {
        return h('div', { className: 'dshrender-settings' },
          h('h2', null, translate('title')),
          h('p', null, translate('loading')))
      }
      if (phase === 'error' && state === null) {
        return h('div', { className: 'dshrender-settings' },
          h('h2', null, translate('title')),
          h('p', null, translate('loadFailed') + ': ' + error),
          h('div', { className: 'dshrender-actions-row' },
            h('button', { type: 'button', className: 'dshrender-primary', onClick: () => { void load() } }, translate('refresh'))))
      }
      const settings = draft ?? state?.settings ?? defaultSettings()
      const vendor = state?.vendor ?? {}
      return h('div', { className: 'dshrender-settings' },
        h('h2', null, translate('title')),
        h('p', null, translate('intro')),
        h('div', { className: 'dshrender-vendor' },
          h('span', null, translate('vendorLabel') + ': '),
          h('span', null, translate('mermaidVersion') + ' ' + (vendor.mermaid?.version ?? '—') + ' · ' + (vendor.mermaid?.ready === true ? translate('vendorReady') : translate('vendorMissing'))),
          h('span', null, translate('echartsVersion') + ' ' + (vendor.echarts?.version ?? '—') + ' · ' + (vendor.echarts?.ready === true ? translate('vendorReady') : translate('vendorMissing')))),
        h('div', { className: 'dshrender-group' },
          h('h3', null, translate('sectionAppearance')),
          h('p', { className: 'dshrender-row-hint' }, translate('appearanceHint')),
          settingRow(translate('tableStyle'), null,
            h('select', {
              className: 'dshrender-select', value: settings.appearance.table,
              onChange: event => { setAppearance({ table: event.target.value }) },
            },
            h('option', { value: 'claude' }, translate('tableStyleClaude')),
            h('option', { value: 'dsh' }, translate('tableStyleDsh')))),
          settingRow(translate('inlineStyle'), null,
            h('select', {
              className: 'dshrender-select', value: settings.appearance.inlineCode,
              onChange: event => { setAppearance({ inlineCode: event.target.value }) },
            },
            h('option', { value: 'claude' }, translate('inlineStyleClaude')),
            h('option', { value: 'dsh' }, translate('inlineStyleDsh')))),
          settingRow(translate('codeBlockStyle'), null,
            h('select', {
              className: 'dshrender-select', value: settings.appearance.codeBlock,
              onChange: event => { setAppearance({ codeBlock: event.target.value }) },
            },
            h('option', { value: 'claude' }, translate('codeBlockClaude')),
            h('option', { value: 'minimal' }, translate('codeBlockMinimal')),
            h('option', { value: 'dsh' }, translate('codeBlockDsh')))),
          settingRow(translate('codeFont'), null,
            h('select', {
              className: 'dshrender-select', value: settings.appearance.codeFont,
              onChange: event => { setAppearance({ codeFont: event.target.value }) },
            },
            h('option', { value: 'inherit' }, translate('codeFontInherit')),
            h('option', { value: 'system' }, translate('codeFontSystem')),
            h('option', { value: 'jetbrains' }, translate('codeFontJetbrains')),
            h('option', { value: 'fira' }, translate('codeFontFira')),
            h('option', { value: 'cascadia' }, translate('codeFontCascadia')),
            h('option', { value: 'sfmono' }, translate('codeFontSfmono')),
            h('option', { value: 'consolas' }, translate('codeFontConsolas')),
            h('option', { value: 'menlo' }, translate('codeFontMenlo')),
            h('option', { value: 'custom' }, translate('codeFontCustom')))),
          settings.appearance.codeFont === 'custom'
            ? settingRow(translate('customCodeFont'), translate('customCodeFontHint'),
              h('input', {
                className: 'dshrender-input', type: 'text', value: settings.appearance.customCodeFont,
                onChange: event => { setAppearance({ customCodeFont: event.target.value }) },
              }))
            : null,
          settingRow(translate('codeFontSize'), translate('codeFontSizeHint'),
            h('input', {
              className: 'dshrender-input', type: 'number', min: 0, max: 20, step: 1,
              value: settings.appearance.codeFontSize,
              onChange: event => { setAppearance({ codeFontSize: Number(event.target.value) || 0 }) },
            })),
          settingRow(translate('codeLineHeight'), translate('codeLineHeightHint'),
            h('input', {
              className: 'dshrender-input', type: 'number', min: 0, max: 2, step: 0.05,
              value: settings.appearance.codeLineHeight,
              onChange: event => { setAppearance({ codeLineHeight: Number(event.target.value) || 0 }) },
            })),
          settingRow(translate('codeLigatures'), translate('codeLigaturesHint'),
            h('input', {
              className: 'dshrender-checkbox', type: 'checkbox', checked: settings.appearance.codeLigatures,
              onChange: event => { setAppearance({ codeLigatures: event.target.checked }) },
            })),
          settingRow(translate('collapseUserMessages'), translate('collapseUserMessagesHint'),
            h('input', {
              className: 'dshrender-checkbox', type: 'checkbox', checked: settings.appearance.collapseUserMessages,
              onChange: event => { setAppearance({ collapseUserMessages: event.target.checked }) },
            })),
          settingRow(translate('userMessageMaxHeight'), translate('userMessageMaxHeightHint'),
            h('input', {
              className: 'dshrender-input', type: 'number', min: 160, max: 800, step: 20,
              value: settings.appearance.userMessageMaxHeight,
              disabled: settings.appearance.collapseUserMessages !== true,
              onChange: event => { setAppearance({ userMessageMaxHeight: Number(event.target.value) || 360 }) },
            }))),
        h('div', { className: 'dshrender-group' },
          h('h3', null, translate('sectionDiagrams')),
          settingRow(translate('mermaidEnabled'), translate('mermaidEnabledHint'),
            h('input', {
              className: 'dshrender-checkbox', type: 'checkbox', checked: settings.mermaid.enabled,
              onChange: event => { setMermaid({ enabled: event.target.checked }) },
            })),
          settingRow(translate('mermaidTheme'), null,
            h('select', {
              className: 'dshrender-select', value: settings.mermaid.theme,
              onChange: event => { setMermaid({ theme: event.target.value }) },
            },
            h('option', { value: 'auto' }, translate('mermaidThemeAuto')),
            h('option', { value: 'light' }, translate('mermaidThemeLight')),
            h('option', { value: 'dark' }, translate('mermaidThemeDark')))),
          settingRow(translate('debounce'), translate('debounceHint'),
            h('input', {
              className: 'dshrender-input', type: 'number', min: 200, max: 3000, step: 50,
              value: settings.mermaid.debounceMs,
              onChange: event => { setMermaid({ debounceMs: Number(event.target.value) || 500 }) },
            })),
          settingRow(translate('maxSource'), translate('maxSourceHint'),
            h('input', {
              className: 'dshrender-input', type: 'number', min: 2000, max: 2000000, step: 1000,
              value: settings.mermaid.maxSourceChars,
              onChange: event => { setMermaid({ maxSourceChars: Number(event.target.value) || 200000 }) },
            })),
          settingRow(translate('echartsEnabled'), translate('echartsEnabledHint'),
            h('input', {
              className: 'dshrender-checkbox', type: 'checkbox', checked: settings.echarts.enabled,
              onChange: event => { setDraft(current => current === null ? current : { ...current, echarts: { enabled: event.target.checked } }) },
            })),
          settingRow(translate('csvEnabled'), translate('csvEnabledHint'),
            h('input', {
              className: 'dshrender-checkbox', type: 'checkbox', checked: settings.csv.enabled,
              onChange: event => { setDraft(current => current === null ? current : { ...current, csv: { enabled: event.target.checked } }) },
            }))),
        h('div', { className: 'dshrender-group' },
          h('h3', null, translate('sectionDetection')),
          settingRow(translate('heuristic'), translate('heuristicHint'),
            h('input', {
              className: 'dshrender-checkbox', type: 'checkbox', checked: settings.detection.heuristic,
              onChange: event => { setDetection({ heuristic: event.target.checked }) },
            })),
          h('div', { className: 'dshrender-row-copy' },
            h('span', { className: 'dshrender-row-title' }, translate('extraKeywords')),
            h('span', { className: 'dshrender-row-hint' }, translate('extraKeywordsHint'))),
          h('textarea', {
            className: 'dshrender-textarea',
            value: settings.detection.extraKeywords.join('\n'),
            onChange: event => { setDetection({ extraKeywords: event.target.value.split('\n').map(line => line.trim()).filter(line => line !== '') }) },
          })),
        h('div', { className: 'dshrender-group' },
          h('h3', null, translate('sectionPrompt')),
          settingRow(translate('promptEnabled'), translate('promptEnabledHint'),
            h('input', {
              className: 'dshrender-checkbox', type: 'checkbox', checked: settings.prompt.enabled,
              onChange: event => { setPrompt({ enabled: event.target.checked }) },
            }))),
        notice === null ? null : h('p', { className: 'dshrender-note', 'data-kind': notice.kind }, notice.text),
        h('div', { className: 'dshrender-actions-row' },
          h('button', {
            type: 'button', className: 'dshrender-primary', disabled: busy,
            onClick: () => { void save(false) },
          }, busy ? translate('saving') : translate('save')),
          h('button', {
            type: 'button', className: 'dshrender-secondary', disabled: busy,
            onClick: () => { void save(true) },
          }, translate('reset')),
          h('button', {
            type: 'button', className: 'dshrender-secondary', disabled: busy,
            onClick: () => { void load() },
          }, translate('refresh'))))
    }

    /**
     * One labeled settings row.
     * @param {string} title - row title.
     * @param {string | null} hint - optional hint.
     * @param {import('react').ReactNode} control - control element.
     * @returns {import('react').ReactNode}
     */
    function settingRow(title, hint, control) {
      return h('div', { className: 'dshrender-row' },
        h('div', { className: 'dshrender-row-copy' },
          h('span', { className: 'dshrender-row-title' }, title),
          hint === null ? null : h('span', { className: 'dshrender-row-hint' }, hint)),
        h('div', { className: 'dshrender-control' }, control))
    }

    /* ------------------------------ plugin registration ------------------------------ */

    /**
     * Cordis client plugin body.
     * @param {Record<string, any>} ctx - client root context.
     * @returns {void}
     */
    function apply(ctx) {
      try {
        if (ctx.locale === undefined || ctx.locale === null || typeof ctx.locale.bind !== 'function') {
          throw new Error('locale service is unavailable')
        }
        runtime.translate = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-render: dictionaries')
      } catch (cause) {
        runtime.translate = key => key
        try {
          ctx.logger?.warn?.('dsh-render: locale registration failed: ' + messageOf(cause))
        } catch {
          // Logging is best-effort.
        }
      }

      applyStyles(runtime.settings)

      // Settings arrive asynchronously; rendering starts with defaults and is
      // re-evaluated once the Host answers.
      void fetchSettings().then(settings => {
        if (runtime.disposed) return
        runtime.settings = settings
        applyStyles(settings)
        scanBlocks(document)
        resetUserMessages()
        scanUserMessages(document)
      })

      if (document.body !== null) {
        ctx.effect(() => startObserver(), 'dsh-render: markdown observer')
        scanBlocks(document)
        scanUserMessages(document)
      }

      ctx.effect(() => {
        const timer = setInterval(() => {
          if (runtime.disposed) return
          // Catch blocks that mounted before the observer or through a route
          // swap that did not produce a relevant mutation record.
          scanBlocks(document)
          scanUserMessages(document)
          }, 4000)
        return () => clearInterval(timer)
      }, 'dsh-render: periodic sweep')

      ctx.effect(() => {
        document.addEventListener('click', onUserMessageClick)
        return () => document.removeEventListener('click', onUserMessageClick)
      }, 'dsh-render: user message collapse')

      ctx.slots?.inject?.('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'render',
        order: SETTINGS_ORDER,
        label: () => translate('nav'),
        locale: NS,
      }, RenderSettingsSection))


      ctx.effect(() => () => {
        runtime.disposed = true
        for (const observer of runtime.observers) {
          try {
            observer.disconnect()
          } catch {
            // Disposal is best-effort.
          }
        }
        runtime.observers = []
        for (const surface of document.querySelectorAll(SURFACE_SELECTOR)) {
          surface.remove()
        }
        for (const block of document.querySelectorAll(BLOCK_SELECTOR)) {
          setSourceHidden(block, false)
        }
        resetUserMessages()
        document.getElementById(STYLE_ID)?.remove()
      }, 'dsh-render: teardown')
    }

    // Test-only surface: the browser bundle stays closed, but a Node test can
    // reach the pure detection/parsing helpers through this opt-in global.
    if (globalThis.__DSH_RENDER_TEST__ === true) {
      globalThis.__DSH_RENDER_TEST_EXPORTS__ = {
        mergeSettings, defaultSettings, detectFenceKind, looksLikeCsv, parseCsv,
        parseEchartsOption, splitCsvLine, hashString, firstMeaningfulLine, renderCsvTable,
        clampZoom, fitTransform, zoomAt, appearanceCss, cleanCustomFont, clampUserMessageMaxHeight, shouldCollapseUserMessage,
        typographyCss, clampTypographySize, zoomCss, clampUiScale,
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply,
    }
  },
})
