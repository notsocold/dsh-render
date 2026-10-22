# dsh-render 内部契约

本文定义 Host 半与 Web 半之间的稳定接口，供维护与验收对照。实现变更时先改本文。

## 1. 包与插件形态

| 项 | 值 |
|---|---|
| 包名 | `@local/dsh-render` |
| Host 入口 | `index.js`（`export const name = 'dsh-render'`、`export function apply(ctx)`） |
| Web 入口 | `client.js`（`window.__ModuleLoader__.load({ id: '@local/dsh-render', factory(require) })`） |
| 插件行 id | `dsh-render`（`cordis.patch.yml` 的 `- insert: - id: dsh-render`） |
| Client 注入服务 | `slots`、`locale` |
| 设置页 slot | `settings.section`，`id: 'render'`，`order: 31` |
| DSH 兼容范围 | `engines.dsh: >=0.2.1-rc.2 <0.3.0`（0.2.1-rc.2 实测） |

## 2. 设置文档

路径：`$DSH_HOME/dsh-render/settings.json`（`DSH_HOME` 缺省为 `~`）。

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
  "prompt": { "enabled": false }
}
```

约束：

- `mermaid.theme` ∈ `auto | light | dark`；
- `mermaid.debounceMs` ∈ `[200, 3000]`；
- `mermaid.maxSourceChars` ∈ `[2000, 2000000]`；
- `detection.extraKeywords`：最多 50 条，每条 trim 后 ≤64 字符，去重；
- 未知字段丢弃；缺失字段用默认值补齐；
- 文件损坏时备份为 `settings.json.bak-<timestamp>` 并回退默认值。

## 3. HTTP 路由

全部通过 `ctx.connection.fetch.register()` 注册，位于认证 `/api` 围栏内，仅页面 owner 可访问。无 `connection` 服务的 profile（headless/CLI）跳过注册，不报错。

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
- `cache-control: public, max-age=31536000, immutable`；
- 文件不存在 404，读取失败 500。

客户端实际使用的入口（与 `state.vendor.mermaid.entry` 一致；prefix handler 对缺少 `dist/` 的写法也做一次回退解析）：

- Mermaid：`/api/dsh-render/vendor/mermaid/dist/mermaid.esm.min.mjs`（其内部相对 import 的 `./chunks/mermaid.esm.min/*.mjs` 由同一 prefix 路由解析）；
- ECharts：`/api/dsh-render/vendor/echarts/echarts.min.js`（UMD，加载后 `window.echarts`）。

## 4. Web 半 DOM 契约

### 4.1 识别锚点

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

### 4.3 生命周期

- 启动：`apply(ctx)` 注册 locale、注入样式、启动 `MutationObserver`（`document.body`，`childList/subtree/characterData/attributes[data-ds-dark-theme]`）、启动 4s 周期清扫；
- 设置加载：`GET /state` 成功后更新内存设置并重扫；
- 设置保存：`POST /action` 成功后立即重扫；
- 清理：`ctx.effect` 返回值断开 observer、移除所有 surface、恢复源码显示、移除样式标签；插件禁用/页面刷新后页面恢复原生代码块。

## 5. 安全契约

- Mermaid：`securityLevel: 'strict'`、`htmlLabels: false`、`startOnLoad: false`；
- ECharts：仅 JSON，拒绝函数/表达式；离屏 SVG 渲染；
- CSV：所有单元格 HTML 转义；
- vendor：只读、白名单、防穿越；
- 不记录对话内容、不写用户数据文件（设置文件仅开关与数值）。
