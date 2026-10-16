> **本文件是本 fork 自带插件系统的说明（上游 0.3.0 之前的做法）。上游 0.3.0 起自带官方插件系统：**
> 内容插件 / 外观插件 / 脚本与沙箱执行，见 [docs/PLUGINS.md](../docs/PLUGINS.md)、
> [docs/PLUGIN-API.md](../docs/PLUGIN-API.md)、[docs/PLUGIN-GUIDE.md](../docs/PLUGIN-GUIDE.md)、
> [docs/PLUGIN-DSL.md](../docs/PLUGIN-DSL.md)。两套系统**并联共存**：官方那套由 `server/plugins/registry.js` 扫描，
> 文件从 `/p/<id>/<hash8>/<path>` 取；本 fork 这一套由 `server/plugins.js` + `public/js/plugins.js` 负责，
> 文件从 `/plugins/<id>/<file>` 取，插件清单合并进同一个 `/plugins/index.json`。
> `plugins/dps-meter`、`plugins/match-charts` 这两个插件属于**本 fork 这一套**。
>
> 路径分工：官方那套走 `/plugins/index.json`（目录）、`/p/<id>/<hash8>/<path>`（文件）、`/packs/…`、`/vs/…`、`/cs/…`；
> 本 fork 这条链走**同一个** `/plugins/index.json`（两份条目并列）与 `/plugins/<id>/<file>`（文件）。
# plugins/ — optional add-ons (docs/PLUGINS.md)

One folder is one plugin. **Installing** it means dropping the folder in; **removing** it means deleting the folder
(or the whole `plugins/` directory). No plugin is required for the game to run, and a broken plugin is skipped with a
warning instead of stopping the server.

```
plugins/<id>/plugin.json    the manifest (see below)
plugins/<id>/plugin.js      the entry: `export default (api) => ({ dispose? })`
plugins/<id>/…              whatever else the plugin ships (styles, i18n, helpers)
```

`plugin.json`:

```json
{
  "type": "plugin",
  "name": "战斗统计 DPS 悬浮窗",
  "version": "1.0.0",
  "app": ">=0.2.4",
  "ui": true,
  "entry": "plugin.js",
  "files": { "css": "plugin.css", "core": "dps-core.js", "i18n": "i18n" }
}
```

| Field | Meaning |
|---|---|
| `name`, `version` | required; `version` is the plugin's own |
| `app` | the app versions it is made for (`>=0.2.4`, `^0.2.4`, `*` …). Outside the range the plugin still loads and the server log flags it |
| `entry` | the ES module the browser imports (`modules.default(api)`) |
| `files` | extra files the plugin may load: role → path. A **folder name** (no extension, e.g. `i18n`) is expanded to every serveable file inside it |
| `ui` | optional flag: the plugin adds UI |

The browser only ever loads files a manifest names (`/plugins/<id>/<file>`); nothing else under the folder is served,
and a path that would lead outside the folder is refused.

## What a plugin gets (`api`)

| Member | What |
|---|---|
| `api.id`, `api.manifest` | who it is |
| `api.store`, `api.net`, `api.data` | the app's singletons (the same objects `globalThis.__SP__` carries) |
| `api.runner` | the battle runner (`public/js/battle/runner.js`), or null — read it lazily |
| `api.t`, `api.N_` | `shared/i18n.js` |
| `api.i18n({folder})` | load this plugin's own `i18n/<lang>.json` and register it (no key in the app's packs) |
| `api.mount(node, {parent})` | render a Preact element into a container the loader removes on unload |
| `api.loadCss(rel?)` | inject a stylesheet a manifest names; removed on unload |
| `api.on(type, fn)` | lifecycle: `ready`, `field` (`{ fieldId }` \| `{ fieldId: null }`), `phase` |
| `api.log`, `api.warn` | prefixed console |

`export default (api) => ({ dispose() {} })` — `dispose` runs on unload, before the loader removes the containers and
stylesheets.

## The bundled plugins

Two independent plugins ship with the app. **Deleting either folder removes that feature and leaves the other working** —
they do not import each other and they keep their state under different localStorage keys.

### `dps-meter` — 对局悬浮窗

Live per-operator **DPS (last 10 s / overall)**, **total damage** and **healing** during a battle, switchable between
the battle on screen and every battle this client holds. Read-only: the numbers are the simulation's own per-unit
accumulators (`server/sim/units.js`), exposed by `battleRunner.fieldUnits()` — the plugin never touches the sim.

* the button and the panel are both draggable; positions live in `sp.dpsMeter.btn.pos` / `sp.dpsMeter.pos`;
* sampling every 250 ms, 40 frames (10 s) per battle (`dps-core.js`, tests in `test/plugins/dps-meter.test.js`);
* columns, in this order: **last 10 s DPS / overall DPS / total damage**, plus **last 10 s HPS / total healing** when
  anyone healed (a zero is written as `0`, not hidden);
* every number is an **integer** (`dps-core.fmtInt`; thousands separators from 10,000);
* **ranking and the bars are by total damage** (`rankRows`' default);
* a round is archived the moment it ENDS (`dps-core.stepRound`, three one-shot paths: `fieldUnits().done === true` →
  `battleId` changed → the battle disappeared twice in a row), and the list folds under the table (12 rounds kept);
* **closing the panel only hides it** (CSS `display:none`, the component stays mounted) so the rounds collected so far
  survive closing and reopening; sampling keeps running while hidden;
* a new match clears the window: the plugin watches the app store with `dps-core.matchActive()` (the same rule as
  `ui/stats.js`'s `observeMatch`) and remounts the panel on the false → true transition.
* Removal: delete `plugins/dps-meter/`. It writes only its own UI state (`sp.dpsMeter.pos` / `.open` / `.btn.pos`);
  nothing in the core reads any of it.

### `match-charts` — 战后统计图表

A button next to 模拟完成 / 模拟失败 on the settlement screen (`h1.result__headline`, shared by the live result and the
对局记录 replay). It opens a **white-background** modal with an ECharts line chart: **one line per operator**,
x = the game's round number, y = that operator's total damage in that round (switchable to total healing).

* it **samples the runner itself** (every 250 ms, all fields merged per operator), so it does not depend on the overlay
  plugin being installed or open — delete `dps-meter` and the chart still works;
* when the record is stored (`ui/stats.js` dispatches `sp:match-record`) it writes the match under that `record.id`
  into `sp.charts.log` (20 matches kept), together with the round in progress (`withLiveRound`, since `m.result`
  arrives before the last round closes); the per-round detail (each operator's damage/healing) is what the chart draws,
  so it must never be reduced to totals;
* storage keys are its own (`sp.charts.log` / `sp.charts.latest`); it still READS the pre-split `sp.dpsMeter.log`
  (`LEGACY_LOG_KEY`) so matches archived before the split do not disappear;
* it resolves which match to draw with `resolveMatch()`: by id first, then `newestMatch()` — the id travels
  event detail → archive → button, and the fallback is what the settlement screen wants anyway;
* **ECharts** (the maintainer asked for it over hand-rolled SVG): `echartsOption()` is a pure function with tests —
  `tooltip.trigger: 'axis'` + `order: 'valueDesc'` gives the hover box (round title, colour dot, name, value, sorted),
  and `legend` (`type: 'scroll'`) toggles a line on click with each operator's match total appended. Hiding lines makes
  ECharts rescale the axis to the remaining ones.
* dependency: `echarts` in `package.json` → `tools/vendor.mjs` copies it to `public/vendor/echarts.module.js`
  (gitignored, like the other vendored builds). **Run `npm install && npm run vendor` once** (postinstall does it too),
  then restart. It is imported **dynamically**, so without it everything else keeps working and the modal just says the
  chart library is missing;
* Removal: delete `plugins/match-charts/`. The button, the modal and the archived matches go with it; the stats page
  and the core are untouched (the button is injected, nothing in the core knows it).

### Core-side cost per plugin (removal checklist)

| Core change | Needed by | If the owning plugin is deleted |
|---|---|---|
| `battle/runner.js` — `fieldUnits()` incl. the `done` flag | both | nothing calls the read-only tap; the runner is unchanged otherwise |
| `ui/stats.js` — dispatch `sp:match-record` | match-charts | the event fires with no listener |
| `screens/stats.js` — `data-record="<id>"` on the replay container | match-charts | an unused attribute |
| `public/js/plugins.js`, `server/plugins.js`, two static routes, one line in `main.js` | the plugin system | no plugins load at all |

## Adding your own


1. `plugins/<your-id>/plugin.json` + `plugin.js`;
2. `export default (api) => { const host = api.mount(html`…`); return { dispose() {} }; }`;
3. reload the page — the server logs `[plugins] <your-id> (name)` and the browser loads it.

Nothing in the app needs to change: the server scans the folder, the client loader (`public/js/plugins.js`) imports it.
