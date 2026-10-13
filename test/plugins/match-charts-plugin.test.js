// 「战后统计」插件（plugins/match-charts）的契约：清单、入口能跑、import 可解析、i18n 齐全、
// 按钮只插一次、ECharts 的 option 与生命周期，以及**它与「战斗统计悬浮窗」互不依赖**。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, loadModule, stubDom, stubApi, checkImports } from '../helpers/pluginModule.js';

const PLUGIN = 'plugins/match-charts';
const DEPS = ['chart.js', 'charts-core.js'];
const src = (f) => fs.readFileSync(path.join(ROOT, PLUGIN, f), 'utf8');

/**
 * 一台假 runner：`on('field')` 收集回调，测试自己按「帧」推进（插件每 SAMPLE_MS 也会自己 tick，
 * 但测试里用 field 事件驱动更可控）。
 * @param {{ units?: any[] }} [o]
 */
function fakeRunner(o = {}) {
  const hooks = [];
  const state = { bid: 'b1', time: 0, done: false, units: o.units || [] };
  return {
    state,
    fieldUnits: () => ({ battleId: state.bid, fieldId: 'f1', kind: 'normal', time: state.time, done: state.done, units: state.units }),
    on: (type, fn) => { if (type === 'field') hooks.push(fn); return () => { const i = hooks.indexOf(fn); if (i >= 0) hooks.splice(i, 1); }; },
    _entries: new Map([['f1', {}]]),
    frame(patch) { Object.assign(state, patch); for (const fn of [...hooks]) fn(); },
  };
}

/** 一帧的单位表：一名干员累计打了 dmg 点伤害。 */
const unitsOf = (dmg) => [{ unitId: 1, defId: 'char_a', name: 'A', kind: 'op', dmg, heal: 0, attacks: 5, kills: 1, taken: 0 }];

/** 模拟核心在结算时派发的落库事件。 */
const recordEvent = (id, durationMs) => {
  globalThis.dispatchEvent(new CustomEvent('sp:match-record', { detail: { id, difficulty: 'normal', roomMode: 'solo', victory: true, durationMs } }));
};

test('连打两把：第二把必须按新的 record 建档，不能停在第一把的数据上', async () => {
  stubDom();
  const entry = await loadModule(PLUGIN, 'plugin', DEPS);
  const core = await loadModule(PLUGIN, 'charts-core', DEPS);
  const api = stubApi({ id: 'match-charts' });
  const runner = fakeRunner({ units: unitsOf(0) });
  api.runner = runner;
  const handle = entry.default(api);

  // ---- 第一把：一回合打了 1000 ----
  api.emit({ match: { public: { phase: 'INFO_CHECK', round: 1 }, result: null } });
  runner.frame({ bid: 'b1', time: 10, done: false, units: unitsOf(1000) });
  runner.frame({ bid: 'b2', time: 20, done: false, units: unitsOf(0) });      // 换场 → 收尾第 1 回合
  recordEvent('r1.first', 60000);
  const first = core.readMatch('r1.first');
  assert.ok(first, '第一把要建档');
  assert.equal(first.total.dmg, 1000);

  // ---- 结算 → 再开一局（matchActive 的 false → true 跳变会清空窗口）----
  api.emit({ match: { public: { phase: 'RESULT', round: 3 }, result: { victory: true } } });
  api.emit({ match: { public: { phase: 'INFO_CHECK', round: 1 }, result: null } });

  // ---- 第二把：一回合打了 7777 ----
  runner.frame({ bid: 'c1', time: 12, done: false, units: unitsOf(7777) });
  runner.frame({ bid: 'c2', time: 24, done: false, units: unitsOf(0) });
  recordEvent('r1.second', 61000);

  const second = core.readMatch('r1.second');
  assert.ok(second, '第二把也要建档（这就是「图表没更新」的根因：这一条没写进去）');
  assert.equal(second.total.dmg, 7777, '第二把的数值必须是第二把的');
  assert.equal(core.newestMatch()?.id, 'r1.second', '「最近一局」要指向第二把');
  handle.dispose();
});

test('插件清单合法，点名的文件都在', async () => {
  const { normalizePluginManifest, isPluginPath } = await import('../../server/plugins.js');
  const raw = JSON.parse(src('plugin.json'));
  const { manifest, problems } = normalizePluginManifest(raw, { id: 'match-charts' });
  assert.deepEqual(problems, []);
  assert.equal(manifest.entry, 'plugin.js');
  for (const [role, rel] of Object.entries(manifest.files)) {
    assert.ok(isPluginPath(rel) || !rel.includes('.'), `${role}: ${rel} 是合法路径`);
    if (rel.includes('.')) assert.ok(fs.existsSync(path.join(ROOT, PLUGIN, rel)), `${role}: ${rel} 存在`);
    else assert.ok(fs.statSync(path.join(ROOT, PLUGIN, rel)).isDirectory(), `${role}: ${rel}/ 存在`);
  }
  assert.ok(fs.existsSync(path.join(ROOT, PLUGIN, 'i18n', 'en.json')), '自带 i18n');
});

test('入口能被加载并注册，dispose 不抛', async () => {
  stubDom();
  const mod = await loadModule(PLUGIN, 'plugin', DEPS);
  assert.equal(typeof mod.default, 'function', '默认导出是 register');
  const api = stubApi({ id: 'match-charts', files: { css: '/plugins/match-charts/plugin.css' } });
  const handle = mod.default(api);
  assert.equal(typeof handle?.dispose, 'function', 'register() 返回 dispose');
  assert.equal(api.links.length, 1, '注册时注入了清单点名的样式');
  // 走一遍一局的开始 / 结束：订阅没写错、也不抛
  api.emit({ match: { public: { phase: 'INFO_CHECK', round: 1 }, result: null } });
  api.emit({ match: { public: { phase: 'PREP', round: 3 }, result: null } });
  api.emit({ match: { public: { phase: 'RESULT', round: 8 }, result: { victory: true } } });
  handle.dispose();
});

test('入口自己采样（不依赖悬浮窗插件），并依赖 runner 暴露的 done', async () => {
  stubDom();
  const mod = await loadModule(PLUGIN, 'plugin', DEPS);
  const api = stubApi({ id: 'match-charts' });
  // runner 有 fieldUnits：sampleRound 能把一帧整理成「每个干员一行」
  const units = [
    { unitId: 1, defId: 'char_a', name: 'A', kind: 'op', dmg: 1200, heal: 0, taken: 0, attacks: 5, kills: 1 },
    { unitId: 2, defId: 'char_b', name: 'B', kind: 'op', dmg: 300, heal: 900, taken: 0, attacks: 3, kills: 0 },
    { unitId: 3, defId: 'char_c', name: 'C', kind: 'op', dmg: 0, heal: 0, taken: 0, attacks: 0, kills: 0 },  // 什么都没做
  ];
  api.runner = { fieldUnits: () => ({ battleId: 'b1', fieldId: 'f1', kind: 'normal', time: 12, done: true, units }) };
  const got = mod.sampleRound(api);
  assert.equal(got.bid, 'b1');
  assert.equal(got.done, true, 'done 一路传出来（回合结束判定靠它）');
  assert.equal(got.time, 12);
  assert.deepEqual(got.rows.map((r) => [r.name, r.dmg, r.heal]), [['A', 1200, 0], ['B', 300, 900]], '没出手的单位不进图');
  // 没有战斗：空行、不抛
  api.runner = { fieldUnits: () => ({ battleId: null, fieldId: null, kind: null, time: 0, done: false, units: [] }) };
  assert.deepEqual(mod.sampleRound(api).rows, []);
  api.runner = null;
  assert.deepEqual(mod.sampleRound(api).rows, []);
  // 核心侧必须继续暴露这两个字段
  const runnerSrc = fs.readFileSync(path.join(ROOT, 'public/js/battle/runner.js'), 'utf8');
  assert.match(runnerSrc, /fieldUnits\(fieldId = null\)/, 'battleRunner.fieldUnits() 是插件读的接口');
  assert.match(runnerSrc, /done: !!e\.done/, 'fieldUnits() 暴露战斗是否结束（回合收尾靠它）');
});

test('插件 import 的都是静态服务器真正提供的 URL', () => {
  const checked = [];
  for (const f of ['plugin.js', ...DEPS]) checked.push(...checkImports(PLUGIN, f));
  assert.ok(checked.includes('/vendor/preact.module.js') && checked.includes('/js/ui/components.js'),
    `插件通过站点路径引用 app 自己的模块（${checked.join(', ')}）`);
});

test('结算页的按钮只会插一次（曾经每帧插一个，形成按钮风暴）', async () => {
  stubDom();
  const chart = await loadModule(PLUGIN, 'chart', DEPS);
  const head = { dataset: {}, nextElementSibling: null };
  assert.deepEqual(chart.headingsNeedingButton([head]), [0], '第一次：要求给这个标题插按钮');
  assert.equal(head.dataset.dpsmBtn, '1', '同时在标题上打标记');
  assert.deepEqual(chart.headingsNeedingButton([head]), [], '第二次：不能再要求新建（否则就是按钮风暴）');
  assert.deepEqual(chart.headingsNeedingButton([head]), []);
  // 按钮已经在那里（插件重载）：只打标记，不重复插
  const withBtn = { dataset: {}, nextElementSibling: { className: 'other dpsm-open' } };
  assert.deepEqual(chart.headingsNeedingButton([withBtn]), []);
  assert.equal(withBtn.dataset.dpsmBtn, '1');
  // 已标记过的标题一律跳过；多个标题只处理没标记的；脏数据不炸
  assert.deepEqual(chart.headingsNeedingButton([{ dataset: { dpsmBtn: '1' } }]), []);
  assert.deepEqual(chart.headingsNeedingButton([{ dataset: {} }, null, { dataset: { dpsmBtn: '1' } }, {}]), [0],
    '多个标题只处理没标记的；null 与没有 dataset 的元素直接跳过');
  assert.deepEqual(chart.headingsNeedingButton([{ dataset: {} }, { dataset: {} }]), [0, 1], '两个新标题各插一次');
  assert.deepEqual(chart.headingsNeedingButton(null), []);
});

test('ECharts 的 option：轴触发提示（含回合标题与色点）、图例带总量、一人一条线', async () => {
  stubDom();
  const core = await loadModule(PLUGIN, 'charts-core', DEPS);
  const series = [
    { key: 'a', name: 'A', total: 1900, points: [1000, 900] },
    { key: 'b', name: 'B', total: 500, points: [200, 300] },
  ];
  const t = (s, p) => (p && p.n != null ? `第 ${p.n} 回合` : s);
  const opt = core.echartsOption({ series, rounds: [3, 4], axisName: '总伤', totals: { A: 1900, B: 50000 }, t });
  assert.equal(opt.tooltip.trigger, 'axis', '参考图那种跟随鼠标的提示框');
  assert.equal(opt.tooltip.order, 'valueDesc', '数值从大到小排');
  const tip = opt.tooltip.formatter([
    { axisValue: '4', seriesName: 'A', value: 900, color: '#d9480f' },
    { axisValue: '4', seriesName: 'B', value: 300, color: '#0b7285' },
  ]);
  assert.match(tip, /第 4 回合/, '提示框标题是回合号');
  assert.match(tip, /#d9480f/, '带该线的颜色，便于对号入座');
  assert.equal(opt.tooltip.formatter([]), '');
  // 图例：ECharts 自带点击隐藏 / 显示，文字后补上这一局的总量
  assert.equal(typeof opt.legend.formatter, 'function');
  assert.equal(opt.legend.formatter('A'), 'A  1900', '四位数不加分隔符');
  assert.equal(opt.legend.formatter('B'), 'B  50,000', '五位数起加千分位');
  assert.equal(opt.legend.type, 'scroll', '干员多时图例可滚动');
  // 一人一条线 + 横轴是回合
  assert.deepEqual(opt.series.map((s) => [s.name, s.type]), [['A', 'line'], ['B', 'line']]);
  assert.deepEqual(opt.series[0].data, [1000, 900]);
  assert.deepEqual(opt.xAxis.data, ['3', '4']);
  assert.equal(opt.yAxis.name, '总伤');
  // 颜色按顺序取自调色板（隐藏别的线不会换色）
  assert.deepEqual(opt.color, [core.colorAt(0), core.colorAt(1)]);
  assert.deepEqual(opt.series.map((s) => s.itemStyle.color), [core.colorAt(0), core.colorAt(1)]);
  assert.equal(core.colorAt(core.LINE_COLORS.length), core.colorAt(0), '超出调色板则循环');
  // 脏数据不炸
  assert.deepEqual(core.echartsOption({}).series, []);
  assert.deepEqual(core.echartsOption({ series: null, rounds: null }).xAxis.data, []);
});

test('ECharts 用动态 import 取（没装时插件其余部分照常），dispose / resize 都挂好', async () => {
  const chartSrc = src('chart.js');
  assert.match(chartSrc, /await import\('\/vendor\/echarts\.module\.js'\)/, 'echarts 从站点挂载里动态引入');
  assert.ok(!/^\s*import \* as echarts/m.test(chartSrc), '不能静态 import：没装的话整个插件都会加载失败');
  assert.match(chartSrc, /lib\.init\(boxRef\.current\)/, '在容器上 init');
  assert.match(chartSrc, /chartRef\.current\?\.dispose\?\.\(\)/, '卸载时 dispose，避免泄漏');
  assert.match(chartSrc, /ResizeObserver/, '容器尺寸变化时 resize');
  // vendor 规则：可选（没装就不拷，postinstall 不会因此失败）
  const vendorSrc = fs.readFileSync(path.join(ROOT, 'tools/vendor.mjs'), 'utf8');
  assert.match(vendorSrc, /\['node_modules\/echarts\/dist\/echarts\.esm\.min\.js', 'echarts\.module\.js', true\]/, 'vendor 会把它拷到 public/vendor');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies.echarts, 'echarts 在 dependencies 里');
});

test('两个插件互不依赖：删掉任何一个，另一个照常工作', () => {
  const chartFiles = ['plugin.js', 'chart.js', 'charts-core.js'].map(src).join('\n');
  // 没有跨插件的 import（插件的 URL 是 /plugins/<id>/，也 import 不到别的插件目录）——注释里提一句无妨
  const chartImports = [...chartFiles.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(!chartImports.some((s) => s.includes('dps-meter')), `图表插件不能 import 悬浮窗插件的文件（${chartImports.join(', ')}）`);
  assert.match(chartFiles, /'sp\.charts\.log'|'sp\.charts\.latest'/, '图表插件用自己的键');
  // 悬浮窗插件在的话，再从它那一侧核对：它不认识图表插件、也不碰图表插件的键
  const panelDir = path.join(ROOT, 'plugins/dps-meter');
  if (!fs.existsSync(panelDir)) return;   // 它被删掉了 —— 这本身就是「互不依赖」的证明
  const panelFiles = ['plugin.js', 'dps-core.js']
    .filter((f) => fs.existsSync(path.join(panelDir, f)))
    .map((f) => fs.readFileSync(path.join(panelDir, f), 'utf8')).join('\n');
  const panelImports = [...panelFiles.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(!panelImports.some((s) => s.includes('match-charts')), `悬浮窗插件不能 import 图表插件的文件（${panelImports.join(', ')}）`);
  assert.ok(!/sp\.charts\./.test(panelFiles), '悬浮窗插件不碰图表插件的键');
  // 悬浮窗插件只落盘自己的界面状态（位置 / 开关），不再存每回合明细（那是图表插件的事）
  const panelWrites = [...panelFiles.matchAll(/localStorage\?\.setItem\('([^']+)'/g)].map((m) => m[1]);
  for (const k of panelWrites) {
    assert.match(k, /^sp\.dpsMeter\.(pos|open|btn\.pos)$/, `悬浮窗插件只该存自己的界面状态，实际写了 ${k}`);
  }
  assert.ok(!/sp\.dpsMeter\.latest/.test(panelFiles), '面板插件不再维护「本局副本」');
});

test('自带 i18n 覆盖界面用到的每一条文案', async () => {
  const dir = path.join(ROOT, PLUGIN, 'i18n');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 4, '至少随包带四种语言');
  for (const f of files) {
    const dict = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const id of ['战斗统计', '每回合战斗统计', '总伤', '总治疗', '关闭', '查看每回合各干员的输出曲线']) {
      assert.equal(typeof dict[id], 'string', `${f}: ${id}`);
    }
  }
  // 源码里 t('…') / api.t('…') 用到的每一条都要在包里；系列名是动态传进 t() 的，显式列上
  const srcs = ['plugin.js', 'chart.js'].map(src).join('\n');
  const ids = new Set([...srcs.matchAll(/(?:api\.t|\bt)\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]));
  for (const id of ['每回合治疗量', '每回合伤害量']) ids.add(id);
  assert.ok(ids.size > 0);
  for (const f of files) {
    const dict = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const id of ids) assert.equal(typeof dict[id], 'string', `${f} 缺 "${id}"`);
  }
});
