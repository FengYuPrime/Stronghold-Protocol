// 战斗统计悬浮窗插件（plugins/dps-meter）的纯逻辑：取样、10 秒滑动窗口、总体口径、排序与显示过滤。
//
// 这些函数不碰 DOM / store / runner：输入是「每个单位在各次取样里的累计值」，输出是插件要显示的行，所以能直接单测。
// 战后图表那部分逻辑在 plugins/match-charts，测试见 test/plugins/match-charts.test.js。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SAMPLE_MS, WINDOW_SAMPLES, takeSample, pushSample, aggregate, rankRows, visibleRows, showHeal, rateBetween, keyOf,
  stepRound, matchActive, fmtInt,
} from '../../plugins/dps-meter/dps-core.js';

/** One sampling frame: [{ unitId, defId, name, dmg, heal, … }] → the shape fieldUnits() returns. */
const frame = (time, units) => takeSample(units.map((u) => ({ kind: 'op', golden: false, taken: 0, attacks: 0, kills: 0, ...u })), time);

test('takeSample normalises the runner payload (missing / negative counters become 0, uid kept)', () => {
  const s = takeSample([
    { unitId: 7, defId: 'chess_a', name: 'A', dmg: 100, heal: undefined, attacks: 3 },
    { unitId: null, defId: 'chess_b', dmg: -5 },
  ], 12.5);
  assert.equal(s.time, 12.5);
  assert.equal(s.units.length, 2);
  assert.equal(s.units[0].dmg, 100);
  assert.equal(s.units[0].heal, 0);
  assert.equal(s.units[0].attacks, 3);
  assert.equal(s.units[1].dmg, 0, 'a negative counter is clamped');
  assert.equal(s.units[1].name, 'chess_b', 'the defId stands in for a missing name');
  assert.equal(takeSample([], -3).time, 0, 'a bad time counts as 0');
});

test('the window keeps at most WINDOW_SAMPLES frames (oldest dropped)', () => {
  let samples = [];
  for (let i = 0; i < WINDOW_SAMPLES + 10; i++) samples = pushSample(samples, frame(i * 0.25, [{ unitId: 1, defId: 'a', dmg: i }]));
  assert.equal(samples.length, WINDOW_SAMPLES);
  assert.equal(samples[0].units[0].dmg, 10, 'the oldest ten are gone');
  assert.equal(samples[samples.length - 1].units[0].dmg, WINDOW_SAMPLES + 9);
});

test('aggregate: total DPS uses the battle time, the 10 s window uses the two ends of the window', () => {
  // 20 s of battle, 500 damage every 5 s → 100 dps on average; the last 10 s hold 1000 damage → 100 dps too
  const samples = [
    frame(0, [{ unitId: 1, defId: 'a', name: 'A', dmg: 0 }]),
    frame(5, [{ unitId: 1, defId: 'a', name: 'A', dmg: 500 }]),
    frame(10, [{ unitId: 1, defId: 'a', name: 'A', dmg: 1000 }]),
    frame(15, [{ unitId: 1, defId: 'a', name: 'A', dmg: 1500 }]),
    frame(20, [{ unitId: 1, defId: 'a', name: 'A', dmg: 2000 }]),
  ];
  const [row] = aggregate(samples, 20);
  assert.equal(row.dmg, 2000);
  assert.equal(row.dps, 100, 'total: 2000 / 20 s');
  assert.equal(Math.round(row.recentDps), 100, 'window: (2000 − 1000) / 10 s');

  // a burst in the last 5 s: the window sees it, the average barely moves
  const burst = samples.concat([frame(25, [{ unitId: 1, defId: 'a', name: 'A', dmg: 5000 }])]);
  const [after] = aggregate(burst, 25);
  assert.equal(Math.round(after.dps), 200, 'total: 5000 / 25 s');
  assert.equal(Math.round(after.recentDps), 350, 'window: (5000 − 1500) / 10 s (the oldest frame inside the window)');
});

test('aggregate: a single frame degrades to the totals (no negative or NaN rates)', () => {
  const [row] = aggregate([frame(3, [{ unitId: 1, defId: 'a', name: 'A', dmg: 900, heal: 300 }])], 3);
  assert.equal(row.dps, 300);
  assert.equal(row.hps, 100);
  assert.equal(row.recentDps, 900 / 3, 'one frame: the window is the total');
  assert.equal(Number.isFinite(row.recentHps), true);
  const [zero] = aggregate([frame(0, [{ unitId: 2, defId: 'b', dmg: 0 }])], 0);
  assert.equal(zero.dps, 0, 'no time → no division by zero');
  assert.equal(zero.recentDps, 0);
  assert.deepEqual(aggregate([], 10), []);
  assert.deepEqual(aggregate(null, 10), []);
});

test('aggregate: healers carry their healing, and a counter reset never produces a negative rate', () => {
  const samples = [
    frame(0, [{ unitId: 1, defId: 'medic', name: 'M', dmg: 0, heal: 0 }]),
    frame(5, [{ unitId: 1, defId: 'medic', name: 'M', dmg: 0, heal: 1000 }]),
    frame(10, [{ unitId: 1, defId: 'medic', name: 'M', dmg: 0, heal: 2000 }]),
  ];
  const [row] = aggregate(samples, 10);
  assert.equal(row.heal, 2000);
  assert.equal(row.hps, 200);
  assert.equal(Math.round(row.recentHps), 200, '(2000 − 1000) / 5 s');
  assert.equal(showHeal(row), true, 'a healer shows the healing column');

  // the battle restarted: the counters went back to 0 → the window must not go negative
  const reset = samples.concat([frame(10.25, [{ unitId: 1, defId: 'medic', name: 'M', dmg: 0, heal: 0 }])]);
  const [after] = aggregate(reset, 10.25);
  assert.ok(after.recentHps >= 0);
  assert.ok(after.recentDps >= 0);
  // 计数回退（换场/重置）：按变化量的绝对值算，绝不产生负数
  assert.deepEqual(rateBetween({ dmg: 100, heal: 100 }, { dmg: 10, heal: 0 }, 1), { dps: 90, hps: 100 }, '计数器回退 → 取变化量');
  assert.deepEqual(rateBetween({ dmg: 100, heal: 100 }, { dmg: 10, heal: 5 }, 2), { dps: 45, hps: 47.5 }, '回退的另一半照常算');
  assert.deepEqual(rateBetween({ dmg: 100, heal: 100 }, { dmg: 100, heal: 100 }, 1), { dps: 0, hps: 0 }, '没动 → 0');
  assert.deepEqual(rateBetween(null, { dmg: 50, heal: 10 }, 2), { dps: 25, hps: 5 });
  assert.deepEqual(rateBetween(null, null, 2), { dps: 0, hps: 0 });
});

test('rankRows 默认按总伤排序（面板口径），也可以按总体/近 10 秒/治疗', () => {
  const rows = [
    { key: 'a', name: 'A', dmg: 5000, heal: 0, dps: 500, hps: 0, recentDps: 10, recentHps: 0 },
    { key: 'b', name: 'B', dmg: 0, heal: 0, dps: 0, hps: 0, recentDps: 0, recentHps: 0 },
    { key: 'c', name: 'C', dmg: 3000, heal: 900, dps: 300, hps: 90, recentDps: 400, recentHps: 120 },
    { key: 'd', name: 'D', dmg: 1000, heal: 0, dps: 100, hps: 0, recentDps: 400, recentHps: 0 },
    { key: 'e', name: 'E', dmg: 0, heal: 800, dps: 0, hps: 80, recentDps: 0, recentHps: 80 }, // 只治疗（纯奶妈）
  ];
  // 默认＝总伤（需求方指定：dps 统计窗按总伤排名）
  assert.deepEqual(rankRows(rows).map((r) => r.key), ['a', 'c', 'd', 'e', 'b'], '总伤 5000/3000/1000/0/0');
  assert.deepEqual(rankRows(rows, 'dmg').map((r) => r.key), ['a', 'c', 'd', 'e', 'b']);
  assert.deepEqual(rankRows(rows, 'total').map((r) => r.key), ['a', 'c', 'd', 'e', 'b'], '总体 DPS 500/300/100/0/0');
  assert.deepEqual(rankRows(rows, 'recent').map((r) => r.key), ['c', 'd', 'a', 'e', 'b'], '近 10 秒 400/400/10/0/0');
  assert.deepEqual(rankRows(rows, 'heal').map((r) => r.key), ['c', 'e', 'a', 'd', 'b'], '治疗量 900/800/0/0/0（并列再按总伤）');
  assert.deepEqual(visibleRows(rows).map((r) => r.key), ['a', 'c', 'd', 'e'], 'an idle operator is not listed');
  assert.deepEqual(visibleRows(rows, { includeHealers: false }).map((r) => r.key), ['a', 'c', 'd'], 'a heal-only row can be hidden');
  assert.equal(showHeal(rows[0]), false);
  assert.equal(showHeal(rows[2]), true);
  assert.ok(SAMPLE_MS > 0 && WINDOW_SAMPLES * SAMPLE_MS === 10000, 'the window is ten seconds');
  assert.equal(keyOf({ unitId: 3, defId: 'x' }), 'u3');
  assert.equal(keyOf({ defId: 'x' }, 2), 'x#2');
});

test('横条按总伤归一（与名次一致）', () => {
  const [top, mid, low] = aggregate([
    frame(0, [{ unitId: 1, defId: 'a', name: 'A', dmg: 0 }, { unitId: 2, defId: 'b', name: 'B', dmg: 0 }]),
    frame(10, [{ unitId: 1, defId: 'a', name: 'A', dmg: 800 }, { unitId: 2, defId: 'b', name: 'B', dmg: 400 }]),
  ], 10);
  assert.equal(top.key, 'u1');
  assert.equal(top.share, 1);
  assert.equal(mid.share, 0.5, '400 / 800');
  assert.equal(low, undefined);
});

test('回合状态机：回合结束就收尾（不必等下一场开始）', () => {
  const rows = [{ key: 'u1', name: 'A', dmg: 500, heal: 0 }];
  // 第一场进行中
  let rec = stepRound(null, { key: 'f', bid: 'b1', done: false, time: 5 }, { round: 1 }).rec;
  assert.equal(rec.bid, 'b1');
  assert.equal(rec.round, 1);
  rec.last = rows;
  // 还在打：不收尾
  let s = stepRound(rec, { key: 'f', bid: 'b1', done: false, time: 10 }, { round: 1 });
  assert.equal(s.close, null, '战斗进行中不收尾');
  assert.equal(s.fresh, false);
  // 回合结束：立刻收尾（这就是「第一回合结束就能看到记录」）
  s = stepRound(rec, { key: 'f', bid: 'b1', done: true, time: 30 }, { round: 1 });
  assert.equal(s.close, rec, 'done=true 立刻要求收尾');
  assert.equal(s.fresh, false, '不会另开一条');
  // 收尾后打上 archived 标记，同一回合不再重复收
  rec.archived = true;
  assert.equal(stepRound(rec, { key: 'f', bid: 'b1', done: true, time: 30 }, { round: 1 }).close, null, '同一回合只收一次');
  // 下一场开始：换场也要收尾（拿旧记录）并开新的一条
  const s2 = stepRound(rec, { key: 'f', bid: 'b2', done: false, time: 2 }, { round: 2 });
  assert.equal(s2.close, rec, '换场时把上一场交出去');
  assert.equal(s2.fresh, true);
  assert.equal(s2.rec.bid, 'b2');
  assert.equal(s2.rec.round, 2);
  assert.equal(s2.rec.n, 2, '序号递增');
  assert.deepEqual(s2.rec.last, [], '新的一条从空开始');
});

test('回合状态机：战斗从 runner 消失时，连续两次取不到才收尾', () => {
  const rec = { key: 'f', bid: 'b1', n: 1, round: 3, last: [{ key: 'u1', dmg: 10 }], time: 20, archived: false, misses: 0 };
  assert.equal(stepRound(rec, null, { round: 3 }).close, null, '第一次取不到：先不动（可能只是一次空取样）');
  assert.equal(rec.misses, 1);
  assert.equal(stepRound(rec, null, { round: 3 }).close, rec, '第二次仍取不到：收尾');
  // 取到数据后 misses 归零
  stepRound(rec, { key: 'f', bid: 'b1', done: false, time: 21 }, { round: 3 });
  assert.equal(rec.misses, 0);
  // 没有数据可收（last 为空）时不收
  assert.equal(stepRound({ key: 'f', bid: 'b1', last: [], archived: false }, null).close, null);
});

test('面板数字只显示整数（四舍五入），五位数起加千分位', () => {
  // 需求方指定：DPS / 治疗 / 总伤都不带小数位
  assert.equal(fmtInt(0), '0');
  assert.equal(fmtInt(1.4), '1');
  assert.equal(fmtInt(1.5), '2');
  assert.equal(fmtInt(420.7), '421', '原来的 420.1 这类读数不再出现');
  assert.equal(fmtInt(999.6), '1000');
  assert.equal(fmtInt(1234), '1234', '四位数不加分隔符');
  assert.equal(fmtInt(9999), '9999');
  assert.equal(fmtInt(10000), '10,000');
  assert.equal(fmtInt(12345), '12,345');
  assert.equal(fmtInt(1234567), '1,234,567');
  assert.equal(fmtInt(-42.6), '-43');
  // 脏数据不产生 NaN / undefined
  for (const bad of [NaN, null, undefined, '', 'x', Infinity, -Infinity]) {
    const out = fmtInt(bad);
    assert.match(out, /^-?[\d,]+$/, `${String(bad)} → ${out}`);
  }
});

test('新一局判定：进入对局那一刻才算开始（false → true 跳变清窗口）', async () => {
  const { PHASE } = await import('../../shared/constants.js');
  // 插件里写的两个字面量必须与 PHASE 常量一致（改名会在这里炸掉，而不是悄悄失效）
  assert.equal(PHASE.LOBBY, 'LOBBY');
  assert.equal(PHASE.RESULT, 'RESULT');

  const pub = (phase, round = 1) => ({ match: { public: { phase, round }, result: null } });
  assert.equal(matchActive(null), false);
  assert.equal(matchActive({}), false);
  assert.equal(matchActive(pub(null)), false, '没有阶段：不算在对局中');
  assert.equal(matchActive(pub(PHASE.LOBBY)), false);
  assert.equal(matchActive(pub(PHASE.RESULT)), false, '结算画面：对局已结束');
  // 一局的各个阶段都算「在对局中」——进入 INFO_CHECK 就是新一局开始的跳变点
  for (const p of [PHASE.INFO_CHECK, PHASE.BAND_DRAFT, PHASE.PREP, PHASE.COMBAT, PHASE.SETTLE, PHASE.HIDDEN_CORE]) {
    assert.equal(matchActive(pub(p)), true, `${p} 应算在对局中`);
  }
  // 已经拿到结算结果：即使阶段还没切，也不算在对局中（与 observeMatch 一致）
  assert.equal(matchActive({ match: { public: { phase: PHASE.RESULT, round: 9 }, result: { victory: true } } }), false);
  assert.equal(matchActive({ match: { public: { phase: PHASE.PREP, round: 3 }, result: { victory: false } } }), false);

  // 一局的跳变序列：大厅 → 进对局（跳变 1 次）→ 回合推进（不再跳变）→ 结算（回落）→ 再开一局（再跳变 1 次）
  const seq = [pub(PHASE.LOBBY), pub(PHASE.INFO_CHECK), pub(PHASE.PREP, 1), pub(PHASE.COMBAT, 1), pub(PHASE.PREP, 2),
    { match: { public: { phase: PHASE.RESULT, round: 8 }, result: { victory: true } } }, pub(PHASE.INFO_CHECK)];
  let was = false; const starts = [];
  for (const [i, s] of seq.entries()) {
    const now = matchActive(s);
    if (now && !was) starts.push(i);
    was = now;
  }
  assert.deepEqual(starts, [1, 6], '只在新一局开始的两处跳变（回合推进不触发清空）');
});

test('aggregate: an operator that appears mid-battle is averaged over the battle, not over its own life', () => {
  const samples = [
    frame(0, [{ unitId: 1, defId: 'early', name: 'E', dmg: 0 }]),
    frame(10, [{ unitId: 1, defId: 'early', name: 'E', dmg: 1000 }, { unitId: 2, defId: 'late', name: 'L', dmg: 0 }]),
    frame(20, [{ unitId: 1, defId: 'early', name: 'E', dmg: 2000 }, { unitId: 2, defId: 'late', name: 'L', dmg: 2000 }]),
  ];
  const rows = aggregate(samples, 20);
  const late = rows.find((r) => r.defId === 'late');
  assert.equal(late.dps, 100, '2000 over the battle’s 20 s (the same denominator as the结算 stat)');
  assert.equal(Math.round(late.recentDps), 200, 'the window only knows its own frames');
});
