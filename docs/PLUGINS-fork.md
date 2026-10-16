> **这是本 fork 自带插件系统的文档。** 上游 0.3.0 起自带官方插件系统（内容插件、外观插件、脚本与沙箱执行），
> 见 [PLUGINS.md](PLUGINS.md)、[PLUGIN-API.md](PLUGIN-API.md)、[PLUGIN-GUIDE.md](PLUGIN-GUIDE.md)、
> [PLUGIN-DSL.md](PLUGIN-DSL.md)。两套系统**并联共存**：官方那套由 `server/plugins/registry.js` 扫描，
> 本 fork 这一份由 `server/plugins.js` + `public/js/plugins.js` 负责，插件清单合并进同一个 `/plugins/index.json`。
> `plugins/dps-meter`、`plugins/match-charts` 属于本 fork 这一套。
>
> **路径分工**：官方那套的目录与文件走 `/plugins/index.json`、`/p/<id>/<hash8>/<path>`、`/packs/…`、`/vs/…`、`/cs/…`；
> 本 fork 这条加载链走**同一个** `/plugins/index.json`（两份条目并列在 `plugins` 数组里，各自的客户端只认自己那种形状的
> 条目）与 `/plugins/<id>/<file>`。两边的插件文件夹都在 `plugins/` 下，同一套清单文件 `plugins/<id>/plugin.json`
> 各按自己的 schema 解析：不合自己 schema 的文件夹被跳过（只记一条日志），互不干扰。
>
> 以下为本 fork 原文。
# PLUGINS.md — 可选插件

`plugins/<id>/` 里放一个文件夹就是装上一个插件，删掉文件夹（或整个 `plugins/`）就是卸掉。游戏不依赖任何插件；
坏掉的插件被跳过并打一条警告，不会让服务器起不来。

它与内容包（[PACKS.md](PACKS.md)）刻意共用同一套形状——扫描一次、文件夹变了再扫、只提供清单点名的文件、
出问题只警告不失败——因为两者的诉求一样：**核心不认识插件的内容，只负责发现与投递**。

## 组成

| 文件 | 角色 |
|---|---|
| `server/plugins.js` | 注册表：扫描、清单校验、索引、`servable(id, rel)` |
| `server/http/static.js` | 两条路由：`GET /plugins/index.json`、`GET /plugins/<id>/<file>` |
| `public/js/plugins.js` | 客户端加载器：取索引 → 逐个 `import()` → 交给插件 `api`，可卸载 |
| `public/js/main.js` | 唯一接入点：`installPlugins()` 一行（在 app 起来、`battleRunner` 发布自身之后） |
| `plugins/README.md` | 面向插件作者：清单字段、`api` 全表、怎么装/卸、自带 i18n |
| `plugins/dps-meter/` | 内置插件：对局中的 DPS / 治疗悬浮窗（`docs/PLUGINS.md` 的下文） |
| `plugins/match-charts/` | 内置插件：结算页「模拟完成」旁的按钮 + 战后每回合折线图（ECharts） |

## 契约


- 清单 `plugin.json`：`name`、`version`、`entry` 必填；`app` 是版本范围（不在范围内仍加载，日志标记）；
  `files` 是角色 → 路径，**给一个文件夹名（无扩展名，如 `i18n`）就会展开成里面所有可服务的文件**。
- 只有清单点名的文件会被提供；`..`、绝对路径、符号链接外逃一律拒绝；清单本身不对外。
- 插件的入口必须是 ES 模块，`export default (api) => ({ dispose? })`。
- `api`：`store` / `net` / `data` / `runner`、`t` / `N_` / `i18n({folder})`、`mount()` / `loadCss()` / `on(type, fn)`、
  `log` / `warn`。生命期事件：`ready`、`field`（`{ fieldId }`｜`{ fieldId: null }`）、`phase`。
- 卸载时加载器先调插件的 `dispose()`，再移除它渲染出来的容器与样式；插件自己带 i18n 时不必往主语言包加键
  （`api.i18n()` 走 `shared/i18n.js` 的 `addMessages`，缺失的 msgid 回落为中文原文）。

## 内置插件（两个，互相独立）

删掉任何一个文件夹，那个功能就消失，另一个照常工作：两者互不 import，用的 localStorage 键也不同。

### `plugins/dps-meter` — 对局中的悬浮窗

- 数据只读：模拟自己在每个单位上累计的 `stats`（`server/sim/units.js`：`dmg` / `heal` / `attacks` / `kills` / `taken`），
  由 `battle/runner.js` 的 `fieldUnits()` 暴露；插件不改伤害、不改模拟。
- 口径：总体 DPS = 累计伤害 ÷ 战斗用时；10 秒 DPS = 窗口两端累计值之差 ÷ 时间差（40 帧 × 250 ms）。
  治疗同样两列，且只有真的有过治疗的干员才显示治疗列；排名与横条按**总伤**。
- 范围：「当前战场」用屏幕上的那个战场；「全部战场」遍历 runner 持有的每个战场条目。
- 每回合归档用 `stepRound`（回合结束 / 换场 / 战斗消失三条路各收一次）；关窗只隐藏不卸载。
- 纯逻辑在 `plugins/dps-meter/dps-core.js`，单测在 `test/plugins/dps-meter.test.js` 与
  `test/plugins/dps-meter-plugin.test.js`；注册表与静态路由的单测在 `test/plugins.test.js`。

### `plugins/match-charts` — 结算页的战后曲线

- **自己取样**（每 250 ms，合并所有战场到每个干员），不依赖悬浮窗插件是否安装/打开。
- 结算时（核心派发 `sp:match-record`）按 `record.id` 把这一局的每回合明细存进 `sp.charts.log`（留 20 局）；
  进行中的那一回合用 `withLiveRound` 补上（`m.result` 早于最后一回合收尾）。
- 键是插件自己的（`sp.charts.log` / `sp.charts.latest`），另外**只读回退**拆分之前的 `sp.dpsMeter.log`，
  老玩家攒下的几局不会消失。
- 展示：结算页标题（`h1.result__headline`）旁的按钮 → 白底黑字弹窗（ECharts，一人一条线、横轴回合、竖轴总伤/总治疗）。
- 纯逻辑在 `plugins/match-charts/charts-core.js`，单测在 `test/plugins/match-charts.test.js` 与
  `test/plugins/match-charts-plugin.test.js`（后者含「两个插件互不依赖」的断言）。

## 核心侧为插件付出的代价（摘除清单）

| 核心侧改动 | 谁在用 | 删掉对应插件之后 |
|---|---|---|
| `battle/runner.js` 的 `fieldUnits()`（含 `done` 字段） | 两个插件 | 没人调这个只读接口；runner 其余行为不变 |
| `ui/stats.js` 派发 `sp:match-record` | match-charts | 事件还在发，只是没人听 |
| `screens/stats.js` 回看容器上的 `data-record` | match-charts | 一个没人读的属性 |
| `public/js/plugins.js`、`server/plugins.js`、静态服务器两条路由、`main.js` 一行 | 插件系统本身 | 任何插件都不加载 |

移除整个功能就是删 `plugins/` 目录、`public/js/plugins.js`、`server/plugins.js`，以及 `server/http/static.js` 的
两条路由与 `main.js` 那一行。
