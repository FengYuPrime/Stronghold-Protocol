// 「战后统计」插件（plugins/match-charts）的纯逻辑：每回合存档、某一回合的占比切片、以及 ECharts 的饼图 option。
//
// 这些函数不碰 DOM / store / runner：输入是「该回合每个干员的累计值」，输出是要画的扇区与要落盘的档案，所以能直接单测。
// 与 plugins/dps-meter 的纯逻辑测试（test/plugins/dps-meter.test.js）分开，两个插件各自独立。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  LATEST_KEY, LOG_KEY, LEGACY_LOG_KEY, serializeLatest, readLatest, withLiveRound,
  roundSeries, matchLog, readLog, saveMatch, readMatch, roundPie,
} from '../../plugins/match-charts/charts-core.js';

const ROOT = path.join(import.meta.dirname, '..', '..');

test('对局记录的曲线数据：roundSeries 按时间顺序给出每回合的总量与每秒速率', () => {
  // history 是「最近的在前」，图上要的时间顺序 = 反过来
  const history = [
    { label: '第 2 回合', time: 30, dmg: 6000, heal: 1200 },
    { label: '第 1 回合', time: 20, dmg: 3000, heal: 300 },
  ];
  const s = roundSeries(history);
  assert.equal(s.length, 2);
  assert.deepEqual(s.map((r) => r.n), [1, 2], '序号按时间顺序');
  assert.deepEqual(s.map((r) => r.dmg), [3000, 6000]);
  assert.deepEqual(s.map((r) => r.dps), [150, 200], 'dps = 该回合总伤 ÷ 该回合时长');
  assert.deepEqual(s.map((r) => r.hps), [15, 40], 'hps = 该回合总治 ÷ 该回合时长');
  assert.deepEqual(roundSeries([]), []);
  // 时长缺失时不产生 Infinity，速率记 0
  const zero = roundSeries([{ label: 'x', time: 0, dmg: 100, heal: 10 }]);
  assert.equal(zero[0].dps, 0);
  assert.equal(zero[0].hps, 0);
});

test('对局记录存档：matchLog 汇总一局（含每回合每个干员的明细），saveMatch/readMatch 按 record.id 读写', () => {
  const history = [
    { label: '第 2 回合', round: 2, time: 30, dmg: 2000, heal: 200, rows: [{ key: 'u9', defId: 'b', name: 'B', dmg: 2000, heal: 200 }] },
    { label: '第 1 回合', round: 1, time: 20, dmg: 1000, heal: 100, rows: [{ key: 'u1', defId: 'a', name: 'A', dmg: 1000, heal: 100 }] },
  ];
  const log = matchLog(history);
  assert.equal(log.v, 2);
  assert.equal(log.rounds.length, 2);
  assert.deepEqual(log.total, { rounds: 2, dmg: 3000, heal: 300, time: 50, dps: 60, hps: 6 });
  // 每回合带上该回合各干员的量（图表一人一条线要用），且顺序是从早到晚
  assert.deepEqual(log.rounds.map((r) => r.n), [1, 2]);
  assert.deepEqual(log.rounds[0].units.map((u) => [u.name, u.dmg, u.heal]), [['A', 1000, 100]]);
  assert.deepEqual(log.rounds[1].units.map((u) => [u.name, u.dmg, u.heal]), [['B', 2000, 200]]);
  // 什么都没做的单位不进图
  const idle = matchLog([{ round: 1, time: 5, dmg: 0, heal: 0, rows: [{ key: 'u1', name: 'A', dmg: 0, heal: 0 }] }]);
  assert.deepEqual(idle.rounds[0].units, []);
  assert.equal(matchLog([]), null, '没有回合就不建档');

  // 用一个假的 localStorage 验证读写与条数上限
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v) };
  assert.equal(Object.keys(readLog(storage)).length, 0, '还没写过时是空表');
  assert.equal(saveMatch('r1.a', log, storage), true);
  assert.equal(readMatch('r1.a', storage).total.dmg, 3000);
  assert.equal(readMatch('r1.missing', storage), null);
  assert.equal(saveMatch('', log, storage), false, '没有 record.id 不写');
  assert.equal(saveMatch('r1.b', null, storage), false, '没有数据不写');
  // 覆盖同一条而不是追加
  saveMatch('r1.a', matchLog([{ label: 'a', time: 10, dmg: 5, heal: 0 }]), storage);
  assert.equal(readMatch('r1.a', storage).total.dmg, 5);
  assert.deepEqual(Object.keys(readLog(storage)), ['r1.a']);
});

test('存档用插件自己的键，但读得到拆分之前留下的旧档（数据不断）', () => {
  assert.equal(LOG_KEY, 'sp.charts.log');
  assert.equal(LATEST_KEY, 'sp.charts.latest');
  assert.equal(LEGACY_LOG_KEY, 'sp.dpsMeter.log', '拆分前「战斗统计」用的键');
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v) };
  // 只有旧键里有东西：也要能读出来（否则老玩家的纪录会「消失」）
  const legacy = { v: 1, byRecord: { 'r1.old': { v: 2, at: 5, rounds: [{ n: 1, time: 10, dmg: 100, heal: 0, units: [{ key: 'a', name: 'A', dmg: 100, heal: 0 }] }] } } };
  mem.set(LEGACY_LOG_KEY, JSON.stringify(legacy));
  assert.equal(readMatch('r1.old', storage)?.total?.dmg, undefined, '旧档没有 total，但能拿到回合');
  assert.equal(readMatch('r1.old', storage).rounds.length, 1);
  // 新键一出现就优先用它；第一次 saveMatch 会把旧键里的档一起搬进新键（老纪录不会丢）
  saveMatch('r1.new', matchLog([{ round: 3, time: 10, dmg: 700, heal: 0, rows: [{ key: 'b', name: 'B', dmg: 700 }] }]), storage);
  assert.equal(readMatch('r1.new', storage).total.dmg, 700, '新键里有更新的那局');
  assert.equal(readMatch('r1.old', storage).rounds.length, 1, '旧档被搬进新键后仍然读得到');
  assert.deepEqual(Object.keys(readLog(storage)).sort(), ['r1.new', 'r1.old']);
});

test('饼图数据 roundPie：只看下拉框选中的那一回合，按占比从大到小，0 的不占扇区', () => {
  const entry = {
    rounds: [
      { n: 1, units: [{ key: 'a', name: 'A', dmg: 100, heal: 0 }, { key: 'b', name: 'B', dmg: 300, heal: 50 }] },
      { n: 2, units: [{ key: 'a', name: 'A', dmg: 500, heal: 10 }] },
      { n: 3, units: [{ key: 'b', name: 'B', dmg: 100, heal: 80 }, { key: 'a', name: 'A', dmg: 400, heal: 0 },
        { key: 'c', name: 'C', dmg: 0, heal: 0 }] },          // 没出手的单位不占扇区
    ],
  };
  const p1 = roundPie(entry, 0);
  assert.equal(p1.round, 1, '选中第 1 回合就只看第 1 回合');
  assert.equal(p1.total, 400);
  assert.deepEqual(p1.slices.map((s) => [s.name, s.value, s.pct]), [['B', 300, 75], ['A', 100, 25]], '饼图＝占比，从大到小');
  // 默认 = 最后一回合（rounds.length - 1）
  const last = roundPie(entry);
  assert.equal(last.index, 2);
  assert.equal(last.round, 3, '不传下标时默认最后一回合');
  assert.deepEqual(last.slices.map((s) => s.name), ['A', 'B'], '0 伤害的 C 不进饼图');
  assert.equal(last.total, 500);
  assert.deepEqual(last.slices.map((s) => s.pct), [80, 20]);
  assert.equal(last.slices[0].name, 'A');
  // 越界退回最后一回合；治疗口径另算
  assert.equal(roundPie(entry, 99).round, 3);
  assert.equal(roundPie(entry, -5).round, 3);
  assert.equal(roundPie(entry, 1.5).round, 3, '非整数下标也算越界');
  const heal = roundPie(entry, 0, 'heal');
  assert.deepEqual(heal.slices.map((s) => [s.name, s.value, s.pct]), [['B', 50, 100]]);
  assert.equal(heal.total, 50);
  // 没有这一局 / 这一回合没数据：空切片（界面据此显示空状态，不回退到任何别的对局）
  assert.deepEqual(roundPie(null), { index: -1, round: null, total: 0, slices: [] });
  assert.deepEqual(roundPie({ rounds: [] }).slices, []);
  assert.deepEqual(roundPie({ rounds: [{ n: 2, units: [{ key: 'x', name: 'X', dmg: 0, heal: 0 }] }] }).slices, []);
  // 缺 n 时用下标 + 1；没名字时退回 defId / 占位符（脏数据不炸）
  assert.equal(roundPie({ rounds: [{ units: [{ key: 'q', name: 'Q', dmg: 3 }] }] }).round, 1);
  const noName = roundPie({ rounds: [{ n: 2, units: [{ key: 'q', dmg: 5 }] }] }, 0);
  assert.equal(noName.slices[0].name, '—');
  assert.equal(noName.slices[0].key, 'q');
});

test('端到端：本局副本 → 结算存档 → 图表要有数据（明细不能丢）', () => {
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  // 每回合归档的形状（最后取到的那一帧）
  const history = [
    { label: '第 2 回合', at: 2, time: 30, round: 2, dmg: 2000, heal: 200,
      rows: [{ key: 'b', name: 'B', defId: 'char_b', golden: false, dmg: 2000, heal: 200, dps: 66, recentDps: 70 },
        { key: 'a', name: 'A', defId: 'char_a', golden: false, dmg: 0, heal: 0, dps: 0, recentDps: 0 }] },
    { label: '第 1 回合', at: 1, time: 20, round: 1, dmg: 1000, heal: 100,
      rows: [{ key: 'a', name: 'A', defId: 'char_a', golden: false, dmg: 1000, heal: 100, dps: 50, recentDps: 55 }] },
  ];
  // ① 落盘（这一步曾经只写汇总数字，害得图表全空）
  storage.setItem(LATEST_KEY, JSON.stringify(serializeLatest(history)));
  // ② 结算：读回来建这一局的档案
  const entry = matchLog(readLatest(storage));
  assert.equal(entry.v, 2);
  assert.deepEqual(entry.rounds.map((r) => r.n), [1, 2]);
  assert.deepEqual(entry.rounds.map((r) => r.units.length), [1, 1],
    '每回合都要带上干员明细（第二回合那个 0/0 的干员不进图，所以是 1 条）');
  assert.equal(entry.rounds[1].units[0].name, 'B');
  assert.equal(entry.rounds[1].units[0].dmg, 2000);
  // ③ 图表：下拉框选回合 → 该回合的占比饼图（默认最后回合）
  assert.deepEqual(roundPie(entry, 0).slices.map((s) => [s.name, s.value]), [['A', 1000]]);
  const lastRound = roundPie(entry);
  assert.equal(lastRound.round, 2, '默认最后一回合');
  assert.deepEqual(lastRound.slices.map((s) => [s.name, s.value, s.pct]), [['B', 2000, 100]], 'A 第二回合没输出，不占扇区');
  // ④ 副本里不该有的字段不落盘（体积），坏数据也不抛
  assert.ok(!('dps' in readLatest(storage)[0].rows[0]), '只存图表要用的字段');
  assert.deepEqual(readLatest({ getItem: () => '{oops' }), []);
  assert.deepEqual(readLatest({ getItem: () => null }), []);
  assert.deepEqual(serializeLatest(null), []);
});

test('结算比回合收尾早：用实时快照补上最后一回合（少了它整局就像没数据）', () => {
  const closed = [{ round: 1, time: 20, dmg: 1000, heal: 100, rows: [{ key: 'a', name: 'A', defId: 'char_a', dmg: 1000, heal: 100 }] }];
  const live = { round: 2, time: 30, rows: [{ key: 'a', name: 'A', defId: 'char_a', dmg: 800, heal: 0 }, { key: 'b', name: 'B', defId: 'char_b', dmg: 200, heal: 50 }] };
  const merged = withLiveRound(closed, live, { label: '最后一回合' });
  assert.deepEqual(merged.map((r) => r.round), [2, 1], '进行中的这一回合排在最前');
  assert.equal(merged[0].dmg, 1000, '合计 = 800 + 200');
  assert.equal(merged[0].heal, 50);
  // 存档 → 两个回合各画一张饼（最后一回合默认选中）
  const entry = matchLog(merged);
  assert.deepEqual(entry.rounds.map((r) => r.n), [1, 2]);
  assert.deepEqual(roundPie(entry, 0).slices.map((s) => [s.name, s.value]), [['A', 1000]]);
  assert.deepEqual(roundPie(entry, 1).slices.map((s) => [s.name, s.value, s.pct]), [['A', 800, 80], ['B', 200, 20]]);
  assert.equal(roundPie(entry).round, 2, '默认选中最后一回合');
  // 同一回合已经收尾过就不重复加
  assert.equal(withLiveRound(merged, live).length, 2);
  // 一局只有实时快照（很短的局 / 前面什么都没收尾）：也要能出图
  const only = withLiveRound([], live);
  assert.equal(only.length, 1);
  assert.equal(matchLog(only).rounds.length, 1);
  // 没有进行中的数据：原样返回
  assert.equal(withLiveRound(closed, { round: 3, rows: [] }).length, 1);
  assert.equal(withLiveRound(closed, null).length, 1);
  assert.deepEqual(withLiveRound(null, live).length, 1);
});

test('只按 record.id 取档：编号对不上就是没数据（不再退回「最近存档的一局」）', () => {
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v) };
  saveMatch('r1.old', matchLog([{ round: 1, time: 10, dmg: 100, heal: 0, rows: [{ key: 'a', name: 'A', dmg: 100 }] }]), storage);
  saveMatch('r1.new', matchLog([{ round: 4, time: 20, dmg: 500, heal: 0, rows: [{ key: 'b', name: 'B', dmg: 500 }] }]), storage);
  // 有别的对局的档，但这一局没存过：readMatch 必须返回 null（界面据此显示空状态）
  assert.equal(readMatch('r1.missing', storage), null, '别的对局有档也不能拿来顶替');
  assert.equal(readMatch(null, storage), null);
  assert.equal(readMatch('', storage), null);
  assert.equal(readMatch('r1.old', storage).rounds.length, 1);
  // 没有回合的残档同样算「没数据」
  saveMatch('r1.empty', { v: 2, at: 9999, rounds: [] }, storage);
  assert.equal(readMatch('r1.empty', storage), null);
});

test('两个插件共有的纯函数不能各改各的（复制粘贴的防漂移）', () => {
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  // 悬浮窗插件被删掉了就没有「漂移」可言：这条断言只在两个插件都在时才做
  if (!fs.existsSync(path.join(ROOT, 'plugins/dps-meter/dps-core.js'))) return;
  const chartCore = read('plugins/match-charts/charts-core.js');
  const panelCore = read('plugins/dps-meter/dps-core.js');
  /** 取一个顶层 export 的整块源码（函数按花括号收尾；const 就是那一行）。 */
  const block = (src, name) => {
    const lines = src.split('\n');
    const i = lines.findIndex((l) => l.startsWith(`export function ${name}(`) || l.startsWith(`export const ${name} =`));
    if (i < 0) return null;
    if (lines[i].startsWith('export const')) return lines[i];
    for (let j = i; j < lines.length; j++) if (lines[j] === '}') return lines.slice(i, j + 1).join('\n');
    return null;
  };
  // 两个插件各自带一份（插件必须自包含、不能跨插件 import），所以这几份必须一模一样
  const shared = ['SAMPLE_MS', 'fmtInt', 'matchActive', 'takeSample', 'isContributor', 'stepRound'];
  for (const name of shared) {
    const a = block(chartCore, name);
    const b = block(panelCore, name);
    assert.ok(a, `charts-core 里应有 ${name}`);
    assert.ok(b, `dps-core 里应有 ${name}`);
    assert.equal(a, b, `${name} 在两个插件里必须逐字一致（改一处就要改另一处）`);
  }
});
