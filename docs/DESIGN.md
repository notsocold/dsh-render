# dsh-render 设计（v1，已确认）

状态：方案已由用户确认（A 方案 + Mermaid 12.2.0 + ECharts + CSV + Render 设置页 + vendor 随项目提交），本文记录最终设计与实现约束。

## 0. 目标与边界

在 `~/work/NodeJsProjects/dsh-render` 实现一个本地 DeepSeek Harness 插件，为 Web 页面增强围栏代码块的渲染能力：

- **Mermaid 图**：识别 Mermaid 代码块并渲染为 SVG，跟随 DSH 亮/暗主题；
- **ECharts 图表**：识别 ECharts option JSON 并渲染为交互式图表的静态 SVG 预览；
- **CSV 表格**：识别逗号分隔表格并渲染为 HTML 表格；
- **Render 设置页**：逐类开关、Mermaid 主题、流式延迟、检测策略、模型提示开关；
- 源码始终保留，一键在图表与源码之间切换；
- 渲染在浏览器内完成，不把用户内容发送到任何外部服务。

非目标：

- 不改宿主源码、不重建 web shell（选择 A 方案）；
- 不重复实现 KaTeX 数学公式与 Shiki 代码高亮（DSH 0.2.1-rc.2 已内置）；
- 不支持 PlantUML / Graphviz / D2 等需要服务端或 WASM 重依赖的图；
- 不默认渲染裸 HTML（XSS 风险）；
- 不提供模型侧工具（模型只需输出围栏代码块）。

## 1. 关键调研结论

| 事实 | 影响 |
|---|---|
| Markdown 由 `@deepseek-ai/dsh-client-ui-primitives` 的 `MarkdownText` 渲染（micromark + mdast 自研） | 渲染层在宿主内，插件无法在 React 层接管 |
| 已内置 KaTeX（`$...$`、`$$...$$`、` ```math `）与 Shiki 代码高亮 | 公式/高亮不是本插件职责 |
| 仓库无 Mermaid 支持（全局搜索 0 命中） | 这是核心缺口 |
| `renderCode()` 直接渲染 `<CodeBlock>`，无代码块渲染器注册接口 | 不能通过插件注册 React 渲染器 |
| 消息正文没有可替换 slot；`conversation.chat.node` 可按 key 替换整个 `assistant-step` | 整节点替换成本高、易随宿主 UI 漂移，不采用 |
| 浏览器模块表可 `require('@deepseek-ai/dsh-client-ui-primitives')` 等 | 可复用组件，但不能替换实现 |
| `ctx.connection.fetch.register()` 可返回任意 `Response` | Host 半可安全 serve vendor 静态资源 |
| 无 CSP；同源动态 `import()` 可用 | Mermaid ESM 可按需加载 |
| 暗色模式：`body[data-ds-dark-theme]`；主题 token `--dsw-alias-*` | Mermaid/ECharts 主题可跟随 |
| 代码块 DOM 锚点稳定：`.md-code-block`、`[data-code-block-content]` | DOM 增强有可靠锚点 |
| 代码块语言不进 DOM（Mermaid 不在 Shiki 语法表，header 显示"代码"） | 识别 Mermaid 采用首行关键字启发式 |

## 2. 技术路线

选择 **A. 纯插件 + DOM 增强**：

```
浏览器页面
  MarkdownText → CodeBlock (.md-code-block)
        │
        ▼
  client.js: MutationObserver 扫描 + 内容识别
        │  Mermaid / ECharts / CSV
        ▼
  在代码卡片内插入渲染 surface（源码隐藏，可切换）
        │
        ├── Mermaid: import('/api/dsh-render/vendor/mermaid/dist/mermaid.esm.min.mjs')
        ├── ECharts: <script src="/api/dsh-render/vendor/echarts/echarts.min.js">
        └── CSV: 本地解析
```

不选 B（宿主补丁）：`ui-primitives` 是 web shell 的静态模块表依赖，改它需要重建 web 前端，且每次 DSH 升级都要重打补丁。设置导航图标是唯一可选的宿主补丁，缺失时只降级为通用齿轮，不影响渲染功能。
不选 C（替换 assistant-step 节点）：需要复刻约 300 行宿主渲染逻辑（reasoning、图片、动作行、流式、mentions 等），且只覆盖聊天、不覆盖文档预览。

## 3. 架构

```
Host (index.js + lib/)
  ├── SettingsStore   $DSH_HOME/dsh-render/settings.json（原子写/损坏备份/默认合并）
  ├── Vendor           vendor/mermaid/dist、vendor/echarts
  ├── Routes          /api/dsh-render/{state,action,vendor/*}
  └── Prompt          可选 systemPrompt.section（动态 provider）

Web (client.js)
  ├── Settings 页      settings.section（id=render, order=31）
  ├── 检测器           Mermaid 首行关键字 / ECharts option 结构 / CSV 行结构
  ├── 加载器           Mermaid ESM 动态 import、ECharts UMD script
  ├── 渲染器           mermaid.render() / echarts.renderToSVGString() / CSV 表格
  ├── DOM 增强         MutationObserver + 在 .md-code-block 内插入 surface
  ├── 主题桥           ctx.theme.overrideTokens（浅色调色板覆盖层）
  └── 交互             源码切换、复制、下载 SVG、全屏、重试
```

## 4. 功能范围

### P0（本次交付）

- Mermaid：flowchart、sequence、class、state-v2、ER、gantt、pie、mindmap、timeline、gitGraph、journey、quadrant、requirement、C4、sankey、xychart、block、packet、architecture、kanban、radar、treemap（Mermaid 12 全量，按图类型懒加载）。
- ECharts：option JSON → SVG 预览（line/bar/pie/scatter 等）。
- CSV：两行以上、列数一致的逗号分隔文本 → 表格。
- 主题：跟随 `body[data-ds-dark-theme]`，主题切换后重渲染。
- 流式安全：文本稳定 500ms（可配置）后渲染；渲染令牌取消过期结果。
- 错误兜底：渲染失败显示错误 + 源码 + 重试；不吞内容。
- 交互：源码/图表切换、复制源码、下载 SVG、全屏查看。
- 覆盖：聊天消息、推理、压缩摘要、侧栏文档预览（所有 `MarkdownText` 区域）。
- 安全：Mermaid `securityLevel: 'strict'`；ECharts 只接受 JSON（不执行 JS）；CSV 输出 HTML 转义；vendor 路由白名单。
- 清理：禁用插件后断开 observer、移除 surface、恢复源码、移除样式。

### P1（本次交付）

- Render 设置页：Mermaid/ECharts/CSV 开关、Mermaid 主题、流式延迟、最大源码长度、启发式开关、额外关键字、模型提示开关、vendor 状态、保存/恢复默认/重新读取。

### 追加能力（0.2.6）

- 护眼浅色主题：`ctx.theme.overrideTokens('dsh-render', { light, dark })` 叠加一层 token 覆盖，把浅色调色板的表面（页面底、侧栏、代码块、输入框、菜单等 28 个 token）从纯白换成暖白（默认 `#FCFCFB`），深色值原样回退宿主深色值；设置入口在「设置 → 通用 → 外观」下方一行，可调色、恢复推荐色或关回原生白。纯 CSS 变量覆盖，无额外样式表/observer/每帧成本。

### 追加能力（0.2.8）

- 行内 code 文字颜色：`appearance.inlineCodeColor`（`inherit | blue | red | custom`，默认 `blue`）与 `appearance.customInlineCodeColor`（默认图片取样色 `#8E2626`）；仅在 `inlineCode=claude` 风格下生成颜色规则，暗色模式对图片色/自定义色自动与白色混合提亮。设置页外观组新增「行内代码文字颜色」下拉与自定义取色器。

### 明确不做

- PlantUML / Graphviz / D2；
- 裸 HTML 默认渲染；
- KaTeX / Shiki 重复实现；
- 服务端预渲染。

## 5. 识别规则

| 类型 | 规则 |
|---|---|
| Mermaid | 首个有效行（跳过空行、`%%` 注释、YAML frontmatter）匹配图类型关键字：`graph`、`flowchart`、`sequenceDiagram`、`classDiagram`、`stateDiagram`、`stateDiagram-v2`、`erDiagram`、`journey`、`gantt`、`pie`、`quadrantChart`、`requirementDiagram`、`gitGraph`、`C4*`、`mindmap`、`timeline`、`zenuml`、`sankey-beta`、`xychart-beta`、`block-beta`、`packet-beta`、`architecture-beta`、`kanban`、`radar-beta`、`treemap-beta`；另支持设置中的额外关键字 |
| ECharts | 整段或 `{...}` 子串可解析为 JSON，且对象含 `series` 或 `xAxis`/`yAxis`/`dataset`/`geo`/`radar`/`polar`/`visualMap`/`dataZoom`/`timeline`/`calendar` |
| CSV | 非空行 ≥2、列数一致（2–40 列）、首行不以 `[ { < #` 开头、前 6 行无代码特征（`=>`、`function`、`const`、标签等） |

识别前置：优先读取代码卡片 banner 暴露的语言标签；命中常见编程/标记语言（python、js、ts、bash、html、css、sql、yaml、markdown、text 等）时保持原生代码块，`json`/`csv`/`echarts`/`mermaid` 除外。没有语言标签时，结构成立的 CSV 先于 Mermaid 首行关键字识别；Mermaid 关键字后紧跟 `=`/`,` 时不匹配。

优先级：CSV（结构成立时）→ Mermaid → ECharts。检测失败/关闭时保持原生代码块。

## 6. 渲染与生命周期

- 识别到类型后，在 `.md-code-block` 内部、`[data-code-block-content]` 之后插入 `div[data-dsh-render-surface]`（toolbar + body），并隐藏原 content。
- surface 与 CodeBlock 同生命周期：React 卸载卡片时 surface 随之移除；插件禁用时统一清理。
- React 流式更新只改 content 内的文本，不会动 surface 兄弟节点；文本变化通过 MutationObserver 感知。
- 渲染令牌：每次内容/主题变化 token+1，过期异步结果丢弃。
- 缓存：SVG 按 `hash(kind + theme + maxTextSize + source)` 缓存（最多 60 条，LRU）。
- 并发：最多 1 个图表渲染同时执行，避免阻塞主线程。
- 超时：单次渲染 20s 超时，失败显示错误。
- 主题切换：清空缓存、重新初始化 Mermaid、重渲染所有 surface。

## 7. 设置与 API

Host 路由（全部 `ctx.connection.fetch.register`，认证同源）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/dsh-render/state` | `{ ok, value: { settings, vendor } }` |
| POST | `/api/dsh-render/action` | `{ settings }` 合并保存 / `{ action: 'reset' }` 恢复默认 |
| GET | `/api/dsh-render/vendor/*` | 只读静态资源（白名单 + 防穿越 + 长缓存） |

设置默认值：

```json
{
  "version": 1,
  "mermaid": { "enabled": true, "theme": "auto", "debounceMs": 500, "maxSourceChars": 200000 },
  "echarts": { "enabled": true },
  "csv": { "enabled": true },
  "detection": { "heuristic": true, "extraKeywords": [] },
  "prompt": { "enabled": false },
  "appearance": { "lightBackground": "#FCFCFB" }
}
```

浅色主题颜色通过 `settings.general.item`（id=`dsh-render-light-background`，order=12）注册到「设置 → 通用」页，与宿主的 Appearance（10）、字号（11）行同列；保存后：
1. Host 写 `$DSH_HOME/dsh-render/settings.json`；
2. 客户端立即更新内存设置、重扫页面、重渲染受影响的块；
3. 模型提示段随设置动态生效（下一次提示装配）。

## 8. 安全

- Mermaid `securityLevel: 'strict'`、`htmlLabels: false`、`startOnLoad: false`；不执行源码中的脚本。
- ECharts 只接受 JSON，拒绝函数/表达式；图表在离屏容器渲染为 SVG。
- CSV 单元格经 HTML 转义后插入表格。
- vendor 路由：URL 解码后拒绝 `..`、绝对路径、反斜杠、空字节；`path.resolve` 后必须仍在白名单根内；只允许 `.mjs/.js/.json/.map/.css` 与 `VERSION/LICENSE`。
- 不把对话内容写入磁盘或发送到外部；渲染纯客户端完成。
- 设置文件只含开关与数值。

## 9. 测试与验收

- Host：`node --test test/host.test.js`（设置归一化、vendor 路径安全、Content-Type、vendor 状态、路由与授权）。
- Web：`node --test test/client.test.js`（设置归一化、识别/解析、外观 CSS、折叠阈值、缩放纯函数）。
- 语法：`node --check index.js client.js lib/*.js`。
- 页面验收（安装到 web profile 后）：
  1. 发一条 ` ```mermaid flowchart TD A-->B ` 消息 → 渲染成图，源码可切换；
  2. 暗色/亮色切换 → 图配色跟随；
  3. 发一条 ` ```echarts {"series":[...],"xAxis":{...}} ` → 渲染成图表；
  4. 发一条 ` ```csv a,b\n1,2\n3,4 ` → 渲染成表格；
  5. 流式输出中途不闪烁、稳定后渲染；
  6. 语法错误的 Mermaid → 错误提示 + 源码 + 重试；
  7. 关闭某类渲染 → 该类型恢复原生代码块；
  8. 禁用插件 → 所有增强移除、源码恢复、样式移除。

## 10. 风险与维护

| 风险 | 缓解 |
|---|---|
| DOM 结构变化 | 锚点使用 `.md-code-block` / `[data-code-block-content]` 等稳定属性；失效时自动降级为原生代码块 |
| 启发式误伤 | 首行关键字强特征；失败自动回退；设置页可关闭启发式 |
| Mermaid 体积 | ESM 按图类型懒加载 + 浏览器缓存 + 首次渲染占位 |
| 流式频繁触发 | 500ms 防抖 + 渲染令牌 + 并发队列 |
| React 重渲染 | surface 与 CodeBlock 同生命周期；observer 自愈 + 定时清扫 |
| 升级兼容 | 不改宿主源码；插件可禁用并恢复页面 |

## 11. 版本与资源

- Mermaid 12.2.0（`dist/mermaid.esm.min.mjs` + `dist/chunks/mermaid.esm.min/*`）
- ECharts 6.1.0（`dist/echarts.min.js`）
- 资源由 `scripts/sync-vendor.mjs` 同步，随项目提交，保证离线安装。
