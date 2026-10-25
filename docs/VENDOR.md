# 浏览器端 Vendor 资源说明（Mermaid / ECharts）

本文件记录 dsh-render 浏览器端第三方运行时资源的来源、版本、许可、目录清单与更新方法。
`vendor/` 随插件包提交与发布，安装、运行都不依赖项目 `node_modules`，也不需要联网；
Host 半通过只读路由 `/api/dsh-render/vendor/*` 提供入口与按需 chunk（见 `lib/vendor.js`），
浏览器按需加载。

- 最后同步：2026-10-20
- 同步脚本：`scripts/sync-vendor.mjs`
- 合计：**113 个文件，6,535,482 字节（约 6.23 MiB）**

## 1. 来源与版本

| 库 | 版本 | 许可 | 上游仓库 | 本目录的分发包来源 |
|---|---|---|---|---|
| Mermaid | **12.2.0** | MIT | <https://github.com/mermaid-js/mermaid> | <https://registry.npmjs.org/mermaid/-/mermaid-12.2.0.tgz> |
| ECharts | **6.1.0** | Apache-2.0 | <https://github.com/apache/echarts> | <https://registry.npmjs.org/echarts/-/echarts-6.1.0.tgz> |

版本由同步脚本顶部的 `MERMAID` / `ECHARTS` 常量固定；Host 侧 `lib/vendor.js` 的
`VENDOR_VERSION` 也报告同样的版本号，升级时需要一起修改。

### Mermaid：ESM 按需加载形态

- `vendor/mermaid/dist/mermaid.esm.min.mjs` 是唯一入口；
- 入口通过 `./chunks/mermaid.esm.min/*.mjs` 相对路径导入各图类型；
- chunk 之间同样使用相对导入，因此 **`dist/` 与 `chunks/` 的层级不能被展平或改名**；
- 复制后对入口与 104 个 chunk 共 105 个模块做静态扫描，全部相对 import 均可解析，
  整棵模块树自包含。

### ECharts：UMD 单文件形态

- `vendor/echarts/echarts.min.js` 是完整图表类型的单文件 UMD 构建；
- 浏览器通过 `<script>` 加载后使用全局 `window.echarts`，不需要额外 chunk。

## 2. 目录清单

### 层级与字节数

```text
vendor/                                         113 files    6,535,482 B  (6.23 MiB)
├── mermaid/                                    108 files    5,399,961 B  (5.15 MiB)
│   ├── VERSION                                       6 B    "12.2.0"
│   ├── LICENSE                                   1,089 B    MIT 全文
│   ├── package.json                              4,829 B    上游 package.json
│   └── dist/
│       ├── mermaid.esm.min.mjs                  30,936 B    ESM 入口
│       └── chunks/mermaid.esm.min/             104 files   5,363,101 B
└── echarts/                                      5 files    1,135,521 B  (1.08 MiB)
    ├── VERSION                                       5 B    "6.1.0"
    ├── LICENSE                                  11,990 B    Apache-2.0 全文
    ├── NOTICE                                      168 B    ASF 归属声明
    ├── licenses/LICENSE-d3                       1,475 B    d3 第三方许可
    └── echarts.min.js                        1,121,883 B    UMD 完整构建
```

### 逐项统计

| 路径 | 文件数 | 字节 | 说明 |
|---|---:|---:|---|
| `vendor/mermaid/dist/mermaid.esm.min.mjs` | 1 | 30,936 | Mermaid ESM 入口 |
| `vendor/mermaid/dist/chunks/mermaid.esm.min/` | 104 | 5,363,101 | 按需加载的压缩 ESM chunk（仅 `.mjs`） |
| `vendor/mermaid/LICENSE` | 1 | 1,089 | MIT 许可全文 |
| `vendor/mermaid/package.json` | 1 | 4,829 | 上游包元数据，便于审计版本 |
| `vendor/mermaid/VERSION` | 1 | 6 | 内容为 `12.2.0`（无换行） |
| `vendor/mermaid/` 小计 | **108** | **5,399,961** | — |
| `vendor/echarts/echarts.min.js` | 1 | 1,121,883 | ECharts UMD 完整构建 |
| `vendor/echarts/LICENSE` | 1 | 11,990 | Apache-2.0 许可全文 |
| `vendor/echarts/NOTICE` | 1 | 168 | Apache ASF 归属声明 |
| `vendor/echarts/licenses/LICENSE-d3` | 1 | 1,475 | 打包代码中 d3 部分的第三方许可 |
| `vendor/echarts/VERSION` | 1 | 5 | 内容为 `6.1.0`（无换行） |
| `vendor/echarts/` 小计 | **5** | **1,135,521** | — |
| **vendor/ 总计** | **113** | **6,535,482** | 约 6.23 MiB |

磁盘占用（`du`，含文件系统块开销）：`vendor/mermaid` 约 5.5 MB，`vendor/echarts` 约 1.2 MB。

## 3. 保留与排除

Mermaid 12.2.0 的 `dist/chunks/mermaid.esm.min/` 实际有 208 个文件：104 个 `.mjs`
与 104 个 `.map`。同步脚本只复制 `.mjs`，共 104 个 chunk（要求为至少 30 个），
入口与全部 chunk 的引用关系保持完整。

| 上游内容 | 大小 | 处理 |
|---|---:|---|
| `mermaid/dist/mermaid.esm.min.mjs` | 30,936 B | **保留** |
| `mermaid/dist/chunks/mermaid.esm.min/*.mjs` | 104 个，5,363,101 B | **保留** |
| `mermaid/dist/chunks/mermaid.esm.min/*.map` | 104 个，18,044,826 B | 排除（source map） |
| `mermaid/dist/mermaid.js` | 13,026,468 B | 排除（UMD 全量，非按需） |
| `mermaid/dist/mermaid.min.js` | 5,494,801 B | 排除（UMD 全量压缩版） |
| `mermaid/dist/mermaid.esm.mjs` | 67,026 B | 排除（未压缩 ESM，入口已有压缩版） |
| `mermaid/dist/chunks/mermaid.core/` | 约 9.3 MB | 排除（UMD/CJS 使用的 chunk） |
| `mermaid/dist/chunks/mermaid.esm/` | 约 29 MB | 排除（未压缩 ESM chunk） |
| 其余 `.map`、`.d.ts`、README、demo 等 | — | 排除（浏览器运行不需要） |
| `echarts/dist/echarts.min.js` | 1,121,883 B | **保留** |
| `echarts/dist/echarts.js`、`echarts.esm.*`、`*.map` 等 | — | 排除（只使用最小 UMD 单文件） |
| `node_modules/` | — | 永不复制（所有资源直接来自 npm tarball） |

排除 `.map` 与其它构建产物后，总体积约 6.23 MiB，落在 6–12 MiB 的预期区间内；运行时只请求
入口、实际用到的 Mermaid 图类型 chunk 和 ECharts 单文件。

## 4. 许可与归属

| 库 | 许可 | 随包文件 |
|---|---|---|
| Mermaid | MIT | `vendor/mermaid/LICENSE` |
| ECharts | Apache-2.0 | `vendor/echarts/LICENSE` |
| ECharts 归属声明 | Apache-2.0 NOTICE | `vendor/echarts/NOTICE` |
| ECharts 内嵌 d3 代码 | BSD-3-Clause（d3） | `vendor/echarts/licenses/LICENSE-d3` |

- 上游 JavaScript 文件均按原字节复制，未做修改、转译或再压缩；只额外写入了
  `VERSION` 文件，并保留上游 `package.json` 与许可文件。
- `echarts.min.js` 文件头明确要求“See the NOTICE file distributed with this work”，
  因此除 `LICENSE` 外还保留 `NOTICE`；上游 `licenses/LICENSE-d3` 也一并保留。
- 再分发本插件时请保留上述许可与归属文件。许可全文见对应 `LICENSE` 文件。

## 5. 校验

在插件根目录执行：

```bash
# 1. Mermaid 入口存在
test -f vendor/mermaid/dist/mermaid.esm.min.mjs

# 2. chunk 数 >= 30（当前为 104）
test "$(find vendor/mermaid/dist/chunks/mermaid.esm.min -name '*.mjs' | wc -l)" -ge 30

# 3. ECharts 单文件存在且 > 700000 字节（当前为 1,121,883）
test -f vendor/echarts/echarts.min.js
test "$(stat -c '%s' vendor/echarts/echarts.min.js)" -gt 700000

# 4. 入口使用相对 chunk import
grep -q '\./chunks/mermaid\.esm\.min/' vendor/mermaid/dist/mermaid.esm.min.mjs

# 5. 脚本语法
node --check scripts/sync-vendor.mjs

# 6. 目录体积与文件数
du -sh vendor/mermaid vendor/echarts
find vendor -type f | wc -l          # 113
find vendor -type f -printf '%s\n' | awk '{s+=$1} END{print s}'   # 6535482
find vendor -name '*.map' | wc -l    # 0
```

本次同步的关键运行时文件 SHA-256：

| 文件 | SHA-256 |
|---|---|
| `vendor/mermaid/dist/mermaid.esm.min.mjs` | `dae3440dd5a4adecf76cfd2951c7a69523df3237f110dd186bebbd55f6038c9d` |
| `vendor/echarts/echarts.min.js` | `b66b25aeb4df84e33199dc21694014d336d222cbd9deb0e5a7c14bd6aa0d0fd0` |

## 6. 更新方法

```bash
node scripts/sync-vendor.mjs
```

要求：Node.js ≥ 18（ESM）、`PATH` 中有 `curl` 与 `tar`、可访问 npm registry。
脚本继承当前的 `HTTP(S)_PROXY` / `NO_PROXY` 环境变量（由 curl 处理）。
如需使用镜像，可设置 registry 根地址：

```bash
NPM_REGISTRY=https://registry.npmmirror.com node scripts/sync-vendor.mjs
```

脚本行为（可重复执行，幂等）：

1. 用 `curl` 下载两个版本的 tarball 到系统临时目录（失败自动重试 3 次）；
2. 用 `tar` 解压，并校验解压出的 `package.json` 版本与脚本常量一致；
3. 在 `vendor/.staging-*` 中组装新目录，只复制 `.mjs` chunk、入口、许可与元数据；
4. 自检：入口包含 `./chunks/mermaid.esm.min/` 相对 import、chunk 数 ≥ 30、
   ECharts 入口 > 700000 字节；
5. 自检通过后替换 `vendor/mermaid` 与 `vendor/echarts`，打印每个目标的字节数与总计；
6. 清理临时目录与暂存目录。

失败时脚本以非零状态退出，已存在的 vendor 目录不会被半成品覆盖；`--keep-temp`
可保留下载与解压目录用于排查。脚本**不会**读取或修改 `package.json`，也不执行
`npm install` / `pnpm install`。

升级版本时：修改脚本顶部的 `MERMAID` / `ECHARTS` 常量（版本、tarball URL、最低
chunk 数等），同步更新 `lib/vendor.js` 的 `VENDOR_VERSION`，执行同步脚本，重新运行
第 5 节校验，并更新本文件中的版本、大小、文件数与 SHA-256。

## 7. 维护记录

| 日期 | 版本 | 说明 |
|---|---|---|
| 2026-10-20 | Mermaid 12.2.0 / ECharts 6.1.0 | 首次同步；104 个 Mermaid `.mjs` chunk，排除全部 `.map` |
