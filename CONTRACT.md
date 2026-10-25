# dsh-render 内部契约

本文定义 Host 半与 Web 半之间的稳定接口，供维护与验收对照。实现变更时先改本文。

## 1. 包与插件形态

| 项 | 值 |
|---|---|
| 包名 | `@local/dsh-render` |
| Host 入口 | `index.js`（`export const name = 'dsh-render'`、`export function apply(ctx)`） |
| Web 入口 | `client.js`（`window.__ModuleLoader__.load({ id: '@local/dsh-render', factory(require) })`） |
| 插件行 id | `dsh-render`（`cordis.patch.yml` 的 `- insert: - id: dsh-render`） |
| Client 注入服务 | 静态：`slots`、`locale`；动态可选：`theme`（`ctx.inject(['theme'])`，缺失时降级） |
| 设置页 slot | `settings.section`，`id: 'render'`，`order: 31` |
| 通用页外观行 slot | `settings.general.item`，`id: 'dsh-render-light-background'`，`order: 12`（宿主 Appearance=10、FontSize=11） |
| DSH 兼容范围 | `engines.dsh: >=0.2.1-rc.2 <0.3.0`（0.2.1-rc.2 / rc.3 实测） |

## 2. 设置文档

路径：`$DSH_HOME/dsh-render/settings.json`（`DSH_HOME` 缺省为 `~/.dsh`）。

```json
{
  "version": 1,
  "mermaid": {
    "enabled": true,
    "theme": "auto",
    "debounceMs": 500,
    "maxSourceChars": 200000
  },
  "echarts": { "enabled": true },
  "csv": { "enabled": true },
  "detection": {
    "heuristic": true,
    "extraKeywords": []
  },
  "prompt": { "enabled": false },
  "appearance": {
    "table": "claude",
    "inlineCode": "brand",
    "codeBlock": "claude",
    "codeFont": "inherit",
    "customCodeFont": "",
    "codeFontSize": 0,
    "codeLineHeight": 0,
    "codeLigatures": false,
    "collapseUserMessages": true,
    "userMessageMaxHeight": 360,
    "lightBackground": "#FCFCFB",
    "inlineCodeColor": "red",
    "customInlineCodeColor": "#8E2626"
  },
  "typography": {
    "textFontFamily": "",
    "textFontSize": 0,
    "codeFontSize": 0,
    "terminalFontSize": 0
  },
  "uiScale": 1
}
```

约束：

- `mermaid.theme` ∈ `auto | light | dark`；
- `mermaid.debounceMs` ∈ `[200, 3000]`；
- `mermaid.maxSourceChars` ∈ `[2000, 2000000]`；
- `detection.extraKeywords`：最多 50 条，每条 trim 后 ≤64 字符，去重；
- `appearance.table` ∈ `claude | dsh`；
- `appearance.inlineCode` ∈ `claude | dsh`（旧值 `brand` 兼容映射为 `claude`）；
- `appearance.codeBlock` ∈ `claude | minimal | dsh`；
- `appearance.codeFont` ∈ `inherit | system | jetbrains | fira | cascadia | sfmono | consolas | menlo | custom`；
- `appearance.customCodeFont`：去除控制字符与 `; { } < > \\`，trim 后 ≤200 字符；
- `appearance.codeFontSize`：`0`（跟随 DSH 外观）或 `[12, 20]`；
- `appearance.codeLineHeight`：`0`（跟随 DSH 外观）或 `[1.4, 1.9]`；
- `appearance.collapseUserMessages`：boolean，默认 `true`（长用户消息默认折叠）；
- `appearance.userMessageMaxHeight`：`[160, 800]`，默认 `360`；
- `appearance.lightBackground`：`''` 或 `#RGB` / `#RRGGBB`（大小写归一为 `#RRGGBB`，可省略 `#`），默认 `#FCFCFB`；空串表示关闭覆盖、回到 DSH 原生浅色调色板；非法值归一为 `''`（关闭覆盖）；非字符串值保留原值；
- `appearance.inlineCodeColor` ∈ `inherit | blue | red | custom`，默认 `red`（用户截图取样暗红 `#8E2626`）；`inherit` 不输出 color 规则（跟随正文）；`blue` 是原 Claude 蓝字；`custom` 使用 `customInlineCodeColor` 且为空/非法时回退 `blue`；仅 `appearance.inlineCode=claude` 时生效；
- `appearance.customInlineCodeColor`：`#RGB` / `#RRGGBB` 归一化后保存，默认 `#8E2626`；暗色模式下自动与白色混合提亮（`color-mix(… 58%, #fff 42%)`）以保持可读；
- `typography.textFontFamily`：字体栈字符串，去控制字符与 `; { } < > \\` 后 ≤200 字符，空串跟随原生；
- `typography.textFontSize`：`0`（跟随原生）或 `[10, 22]`；
- `typography.codeFontSize`：`0` 或 `[10, 16]`；
- `typography.terminalFontSize`：`0` 或 `[10, 20]`；
- `uiScale`：`[0.8, 1.3]`，默认 `1`（100%），按 0.01 取整；
- `typography` 与 `uiScale` 是保留字段：界面不再暴露入口，客户端也不会应用（通用页相关功能已撤销）；Host 仍归一化这两个字段，保证旧设置文件可读且往返不丢数据。
- 未知字段丢弃；缺失字段用默认值补齐；
- 文件损坏时备份为 `settings.json.bak-<timestamp>` 并回退默认值。

## 3. HTTP 路由

- `/state`、`/action` 通过 `ctx.connection.fetch.register()` 注册，位于认证 `/api` 围栏内，仅页面 owner 可访问；
- `/vendor/*` 需要子树匹配，而 `connection.fetch` 只支持精确 pathname，因此由 `ctx.webServer.register({ kind: 'prefix' })` 注册，并在 handler 内调用 `ctx.connection.requestRejection(request)` 复用同一套认证围栏；未授权请求先写 401/403，再触碰文件系统；
- 无 `connection` / `webServer` 服务的 profile（headless/CLI）跳过对应注册，不报错。

### 3.1 `GET /api/dsh-render/state`

查询参数：`sessionId`（可选，忽略）。

响应 `200`：

```json
{
  "ok": true,
  "value": {
    "settings": { "...完整设置..." },
    "vendor": {
      "mermaid": {
        "version": "12.2.0",
        "ready": true,
        "entry": "/api/dsh-render/vendor/mermaid/dist/mermaid.esm.min.mjs"
      },
      "echarts": {
        "version": "6.1.0",
        "ready": true,
        "entry": "/api/dsh-render/vendor/echarts/echarts.min.js"
      }
    }
  }
}
```

- `ready`：启动时检查入口文件是否存在；
- 响应头：`cache-control: no-store`。

### 3.2 `POST /api/dsh-render/action`

请求体（JSON）：

```json
{ "settings": { "mermaid": { "enabled": false } } }
```

或：

```json
{ "action": "reset" }
```

响应 `200`：

```json
{ "ok": true, "value": { "settings": { "...完整设置..." } } }
```

错误 `400`：

```json
{ "ok": false, "error": { "code": "invalid-request", "message": "..." } }
```

- `settings` 为深合并的部分设置，按第 2 节约束归一化后整体保存；
- `reset` 恢复默认值并保存；
- 响应头：`cache-control: no-store`。

### 3.3 `GET /api/dsh-render/vendor/*`

静态资源，白名单两个根：

| URL 前缀 | 文件根 |
|---|---|
| `/api/dsh-render/vendor/mermaid/` | `<插件目录>/vendor/mermaid/` |
| `/api/dsh-render/vendor/echarts/` | `<插件目录>/vendor/echarts/` |

规则：

- 只接受 `GET`；
- URL 解码后拒绝 `..` 路径段、绝对路径、反斜杠、空字节；`path.resolve` 后必须仍在根内；
- 只允许扩展名 `.mjs`、`.js`、`.json`、`.map`、`.css`，以及文件名 `VERSION`、`LICENSE`；
- 目录请求返回 404；
- Content-Type：`.mjs`/`.js` → `text/javascript; charset=utf-8`，`.json`/`.map` → `application/json; charset=utf-8`，`.css` → `text/css; charset=utf-8`，其余 `application/octet-stream`；
- 缓存：入口文件（Mermaid `dist/mermaid.esm.min.mjs`、ECharts `echarts.min.js`）返回 `private, no-cache`，保证升级后入口重新验证、不会引用已删除的旧 chunk；其余 chunk 返回 `private, max-age=31536000, immutable`（认证资源不进共享缓存）；
- 文件不存在 404，读取失败 500。

客户端实际使用的入口（与 `state.vendor.mermaid.entry` 一致；prefix handler 对缺少 `dist/` 的写法也做一次回退解析）：

- Mermaid：`/api/dsh-render/vendor/mermaid/dist/mermaid.esm.min.mjs`（其内部相对 import 的 `./chunks/mermaid.esm.min/*.mjs` 由同一 prefix 路由解析）；
- ECharts：`/api/dsh-render/vendor/echarts/echarts.min.js`（UMD，加载后 `window.echarts`）。

## 4. Web 半 DOM 契约

### 4.1 识别锚点

识别前先读代码卡片 banner 暴露的语言标签：命中常见编程/标记语言（`python`、`js`、`ts`、`bash`、`html`、`css`、`sql`、`yaml`、`markdown`、`text` 等）时保持原生代码块；`json`、`csv`、`echarts`、`mermaid` 不在排除集合内，仍走结构检测。没有语言标签时，结构成立的 CSV 先于 Mermaid 首行关键字识别（例如表头 `graph,score` 渲染为表格）；Mermaid 首行关键字后紧跟 `=` 或 `,` 时不算图。

宿主 `CodeBlock` 的 DOM：

```html
<div class="md-code-block">
  <div data-code-block-banner>…</div>
  <div data-code-block-content>
    <pre>…原始源码…</pre>
  </div>
</div>
```

- 插件只增强 `.md-code-block`；
- 源码从 `[data-code-block-content]` 的 `textContent` 读取；
- 增强节点插入到 `.md-code-block` 内部、content 之后：

```html
<div class="md-code-block" data-dsh-render-enhanced>
  <div data-code-block-banner>…</div>
  <div data-code-block-content style="display:none">…</div>
  <div class="dshrender-surface" data-dsh-render-surface="mermaid"
       data-dsh-render-kind="mermaid" data-dsh-render-theme="dark"
       data-dsh-render-state="ready" data-dsh-render-ready="true">
    <div class="dshrender-bar">
      <span class="dshrender-kind">Mermaid</span>
      <span class="dshrender-status"></span>
      <span class="dshrender-spacer"></span>
      <span class="dshrender-actions">
        <button data-act="toggle-source">查看源码</button>
        <button data-act="copy">复制</button>
        <button data-act="download">下载 SVG</button>
        <button data-act="retry" style="display:none">重试</button>
        <button data-act="fullscreen">全屏</button>
      </span>
    </div>
    <div class="dshrender-body" data-dsh-render-body>
      …SVG / 表格 / 错误占位…
    </div>
  </div>
</div>
```

- `data-dsh-render-state` ∈ `rendering | ready | error`；
- 隐藏源码用 `[data-code-block-content].style.display = 'none'`（恢复时清空）；
- `data-act="toggle-source"` 在源码与图表之间互斥切换：显示源码时把 `[data-dsh-render-body]` 设为
  `display:none`，显示图表时把源码设为 `display:none`，两者不同时可见；
- 主题切换时 surface 的 `data-dsh-render-theme` 更新并重渲染。

### 4.2 样式

- 样式标签 id：`dsh-render-styles`；
- 类名前缀：`dshrender-`；
- 颜色使用 `--dsw-alias-*`、`--dsw-radius-*`、`--dsw-font-family` 等主题变量；
- 不覆盖宿主全局选择器。

### 4.3 全屏查看器

- 点击 `data-act="fullscreen"` 打开 overlay：stage 占 `96vw × calc(100vh - 48px)`（扣掉 overlay 的 24px 上下内边距，页面不出现滚动条），内容在克隆的 canvas 上做 `translate + scale`；
- **不修改克隆图本身**：不清除/重设 `viewBox`、不改 `overflow`、不改属性，只按它在消息中已有的显示尺寸（`getBoundingClientRect`）渲染克隆 SVG；缩放时 SVG 保持原布局尺寸（`flex: none`），只对整个画布做 `translate + scale`——这样 Mermaid 的 foreignObject HTML 不会被重新布局，不会再产生图内滚动条或节点裁剪；同时移除 `will-change: transform`，避免图层被提前栅格化；这样图的内容与消息里一致、不会被 viewBox/getBBox 裁剪，放大也不会模糊；
- **初始打开按 contain 完整显示整张图**；滚轮围绕画布中心缩放（范围 **2%–2000%**）；放大后拖拽平移，平移量被钳制在「内容超出画布」的范围内；「适应屏幕」回到完整视图，**「重置缩放」回到 100% 居中**（键盘 `R` 同样重置）；
- 键盘 `+`/`-` 缩放、`0`/`F`/`R` 适应屏幕、`Esc` 关闭；
- 打开期间锁定 `body` 滚动，关闭时恢复；
- 仅 CSV 表格走静态滚动模式；Mermaid/ECharts（含找不到 SVG 的降级渲染）始终使用可缩放/拖拽查看器；
- 关闭时移除 overlay、恢复 body 滚动并移除 keydown/resize 监听。

### 4.4 Markdown 外观层

- 由 `client.js` 的 `appearanceCss(settings)` 生成，写入 `<style id="dsh-render-appearance">`，与渲染器样式 `<style id="dsh-render-styles">` 分离；
- 作用域：`:is([data-chat-flow], [data-document-markdown])`，不触碰设置页、插件 UI 或其它宿主区域；
- 代码字体/字号/行高/连字：作用于 `.md-code-block pre`、`.md-code-block code`、`:not(pre) > code`；`codeFontSize=0` / `codeLineHeight=0` 时沿用 DSH 外观设置（`--dsh-code-font-size`、`--dsw-font-markdown-code-block`）；
- 代码块边框与 banner 分隔线同样限定在 `:is([data-chat-flow], [data-document-markdown])` 作用域内，不触碰工具详情、计划预览等其它 Markdown 区域；
- 链接与文件引用：Markdown 区域内普通链接（`a[href]`）以及文件提及/文件链接（`button`/`a` 的 `fileMention`/`fileLink` 类，按类名子串匹配）常驻 1.5px 虚线下划线（`--dsw-alias-link` 76% 混合色、offset 3px）；`hover` / `focus-visible` 时加粗到 2px、改用完整 link 色、offset 4px；不改变链接文字颜色，也不影响设置页与插件 UI。
- 行内 code：`inlineCode=claude` 时按用户截图几何绘制 chip —— 亮色底 `rgba(0,0,0,.05)`（在 `#FCFCFB` 上≈`#EFEFEE`）/ 暗 `rgba(255,255,255,.09)`、**1px 边框**（亮 `rgba(0,0,0,.14)`≈`#D9D9D8` / 暗 `rgba(255,255,255,.14)`）、**`0.55em` 圆角**（14px 代码字号下约 7.7px，明显更圆）、**`0.1em 0.32em 0.02em` 非对称内边距 + 行内 code 局部 `line-height:1.15`**（14px 下上约 1.4px、下约 0.3px、左右约 4.5px；上边距略大于下边距，用于抵消无降部字形留下的字体降部空白，使上下视觉间距相同；宿主把行内 code 渲染成 `inline-flex`，chip 高度=内部行盒+padding+边框，所以必须单独压行高，代码块仍遵循用户的「代码行高」设置）、`font-weight:400`（不加粗）；代码块内 `pre code` 重置为透明/无边框/常规字重；
- 行内 code 文字颜色由 `inlineCodeColor` 决定（在 claude 风格下生成独立 color 规则）：`red`（默认）亮 `#8E2626`（用户截图取样）/ 暗 `color-mix(#8E2626 58%, #fff 42%)`；`blue` 亮 `color-mix(--dsw-alias-link 84%, #000 16%)` / 暗 `--dsw-alias-link`；`custom` 使用归一化后的自定义色，暗色同样自动提亮；`inherit` 不生成 color 规则、跟随正文；
- 代码块：`codeBlock=claude|minimal` 时 `.md-code-block` 加 **1px `--dsw-alias-border-l2`** 边框 + 10px 圆角；`claude` 额外给 `[data-code-block-banner]` 底部分隔线（同色）；
- 表格：`table=claude` 时给 `[data-chat-flow] table` / `[data-document-markdown] table` 应用 **Claude 风格**：1px 外框（`--dsw-alias-border-l2`，比 `l1` 稍深）、10px 圆角、表头半透明灰底（亮 `rgba(0,0,0,.05)` / 暗 `rgba(255,255,255,.07)`，另以 `color-mix(label-primary 6%)` 兜底）、表头 `label-primary` + 600 字重（避免次级文字色在浅灰底上显得发虚）、表头底部 1px `--dsw-alias-border-l2`、行间 1px `--dsw-alias-border-l2`、`8px 12px` 内边距、顶部对齐、行高 1.5、无竖线、**无行悬停**；**字号使用 `var(--dsh-content-font-size, 14px)`，随设置 → 外观的通用字号变化**（表格内 code 为 `0.9em` 随表格缩放）；**所有表格强制适应会话列宽**：直接包含表格的外层 `div:has(> table)` 先强制 `width:100%`（否则它作为 flex item 会收缩到内容宽，令表格的 100% 失去参照），表格再用 `width:100%` + `max-width:100%` + `table-layout:fixed` + `box-sizing:border-box`，列宽等分，单元格 `white-space:normal` + `overflow-wrap:anywhere` 允许严重换行，长 URL/行内 code 也可断行；宽表外层 `.md-table-wide` 用 `overflow-x:hidden`（覆盖宿主悬停时的 `overflow-x:scroll`），表格强制适应用会话宽度、不出现横向滚动；CSV 表格（`.dshrender-table`）落在同一作用域内，随之统一；
- 所有样式均限定在 Markdown 区域，插件禁用时随 `dsh-render-appearance` 一起移除。

### 4.5 浅色主题 token 覆盖层（护眼浅色）

- 机制：`client.js` 在 `ctx.inject(['theme'])` 解析后调用 `ctx.theme.overrideTokens('dsh-render', overrides)`，叠加一层主题 token 覆盖。`overrides` 的每个 token 都是 `{ light, dark }` 成对值；主题服务的 presenter 把它们写成 `<body>` 上的内联 CSS 变量，因此无需注入样式表、无需与宿主选择器抢优先级，也不产生每帧计算。
- 覆盖的浅色表面（`light` 值由 `appearance.lightBackground` 派生，见下）：

  | token | 相对基色差 | 用途 |
  |---|---|---|
  | `--dsw-alias-bg-base` | 0 | 页面/会话/代码块 banner 底色 |
  | `--dsw-alias-bg-layer-1/2/3` | 0 | 主面层/嵌套面层/浮层面层 |
  | `--dsw-specific-input-major` | 0 | 输入框卡片 |
  | `--dsw-alias-markdown-code-segment-selected` | 0 | 代码块分段选中态 |
  | `--dsw-alias-button-elevated-fill` / `--dsw-alias-button-floating-fill` | 0 | 抬升/浮动按钮 |
  | `--dsw-specific-sidebar-fill` / `--dsw-alias-markdown-code-block` / `--dsw-alias-markdown-code-block-banner` / `--dsw-specific-login-input` | 6 | 侧栏、代码块、banner、登录输入 |
  | `--dsw-alias-markdown-inline-code` | 5 | 行内 code（DSH 原生风格时） |
  | `--dsw-specific-selector` / `--dsw-specific-tip` / `--dsw-alias-bg-module-platform` / `--dsw-alias-bg-multi-select` / `--dsw-alias-markdown-placeholder` | 10 | 选择器、提示、模块底、多选、占位底 |
  | `--dsw-alias-markdown-code-segment-unselected` / `--dsw-alias-markdown-tag` / `--dsw-alias-button-floating-hover` | 14 | 分段未选、标签、浮动按钮悬停 |
  | `--dsw-alias-markdown-citation` / `--dsw-alias-bg-document-preview` / `--dsw-specific-sidebar-nav-item-active` / `--dsw-alias-button-primary-dimmed` / `--dsw-alias-button-ghost-active-fill` | 20 | 引用、文档预览、侧栏选中、主按钮淡底、幽灵按钮选中 |
  | `--dsw-alias-bg-overlay` / `--dsw-alias-button-ghost-active-hover` | 22 | 浮层底、幽灵按钮悬停 |

- 派生规则：浅色值 = `shade(base, delta)`，逐通道减 `delta`，并把每通道下限钳在 `200`（`#C8C8C8`）；因此用户选极暗的颜色只会得到深灰浅色面，不会破坏标签对比度。`base` 本身也先过该下限。
- `dark` 值：一律写成 `var(--dsw-static-*, <rc.3 实值>)`，即宿主深色调色板的原值（外带 rc.3 硬编码回退）。深色模式下渲染结果与原生完全一致；宿主升级改色时仍跟随 static 调色板。
- 更新时机：设置变化时以相同 source 重新注册（服务语义是“同 source 整体替换”，只发一次 `theme/change`）；`''` 表示关闭覆盖，直接 dispose 该层。插件 teardown 时 dispose，页面恢复原生浅色。
- 预览与提交：通用页外观行的取色器拖动时只 restack 覆盖层（不重扫会话、不重渲染图表）；停手 500ms 或失焦/回车后 `POST /action` 持久化，并在成功后 `applySettings` 重渲染图表（Mermaid/ECharts 的主题变量会读取新 token）。
- 降级：宿主没有 `theme` 服务（0.2.1-rc.2 及更早）时不注册该层，界面保持 DSH 原生浅色，其余功能不受影响；`overrideTokens` 抛错也只降级、不使插件失败。
- 旧 Host 向前兼容：`GET /state` 返回的文档可能缺少 `lightBackground`（旧 Host 的归一化会丢弃未知字段）。客户端合并时以当前内存值为基座（`mergeSettings(hostDoc, runtime.settings)`），因此缺字段不会把颜色打回默认；`POST /action` 后若响应文档同样缺该字段，行内保留本地颜色并提示重启 dsh web，而不是回填默认值。

### 4.6 长用户消息折叠

- 锚点：聊天流中的 `[data-chat-flow-kind="user"]` 节点，折叠对象为其内部的 `[data-message-bubble]`；
- 当 `bubble.scrollHeight > 阈值 + 24` 时，给气泡加 `.dshrender-user-collapsed`（`max-height: var(--dshrender-user-max-height)` + `overflow:hidden` + 底部 56px 渐变遮罩），并在气泡后插入 `.dshrender-user-toggle` 按钮；
- 按钮文案来自 locale 的 `expandMore` / `showLess`；点击切换折叠 class 并设置 `aria-expanded`；
- 已展开/已折叠的气泡用 `data-dshrender-user-state` 标记，避免重复测量；设置变更时先重置全部再重新评估；
- 默认折叠（`collapseUserMessages: true`）；关闭设置或插件 teardown 时移除按钮与折叠 class；
- 重渲染/切换会话后气泡为新节点，重新按默认折叠；折叠只作用于文本气泡，附件与图片留在气泡外。

### 4.7 生命周期

- 启动：`apply(ctx)` 注册 locale；优先读取 localStorage 缓存 `dsh-render:settings-v1`，命中则先应用样式并扫描页面；无缓存时不应用外观、不增强任何区块，等 `GET /state` 返回后一次性应用并全量扫描（避免先用默认设置渲染、再被用户设置重排的二次抖动）；随后启动 `MutationObserver`（`document.body`，`childList/subtree/characterData/attributes[data-ds-dark-theme]`）与 4s 周期清扫；
- 设置加载：`GET /state` 成功后更新内存设置并写缓存；与当前内存设置不同（或此前无缓存）时应用样式并重扫；
- 设置保存：`POST /action` 成功后立即重扫并更新缓存；
- 清理：`ctx.effect` 返回值断开 observer、关闭全屏查看器（恢复 body 滚动与焦点）、清空渲染队列与定时器、移除所有 surface、恢复源码显示、移除全部样式标签（`dsh-render-styles` 与 `dsh-render-appearance`）、dispose 浅色主题覆盖层；插件禁用/页面刷新后页面恢复原生代码块与原生浅色调色板，模块再次 apply 时复位 disposed 状态。

## 5. 安全契约

- Mermaid：`securityLevel: 'strict'`、`htmlLabels: false`、`startOnLoad: false`；
- ECharts：仅 JSON，拒绝函数/表达式；离屏 SVG 渲染；
- CSV：所有单元格 HTML 转义；
- vendor：只读、白名单、防穿越；
- 不记录对话内容、不写用户数据文件（设置文件仅开关与数值）。
