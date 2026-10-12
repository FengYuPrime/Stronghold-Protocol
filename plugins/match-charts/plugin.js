// 「战后统计」插件（plugins/match-charts）—— 结算页「模拟完成」标题旁的按钮 + 白底黑字的 ECharts 折线图。
//
// 与「战斗统计悬浮窗」（plugins/dps-meter）是**两个互相独立的插件**：本插件自己每 250 ms 取样一次
// （`battleRunner.fieldUnits()`），自己按回合累计、自己在结算时把这一局的每回合明细存档 ——
// 所以删掉任何一个，另一个都照常工作。
//
// 一条链：取样 → 回合状态机（charts-core.stepRound）→ 一局结束时建档（按 record.id）→ 结算页按钮 → 弹窗。
//
// 核心侧只为它多了两处（都留着也无副作用）：`ui/stats.js` 派发 `sp:match-record`、`screens/stats.js` 的
// 结算容器带 `data-record`。

import { createRecorder, mountResultButton } from './chart.js';
import {
  SAMPLE_MS, LATEST_KEY, serializeLatest, takeSample, stepRound, withLiveRound, unitKey, matchActive, isContributor,
} from './charts-core.js';

/** The runner's own `field` event, defensively: the plugin must work on a runner without it. */
function runnerHook(api, fn) {
  try { return api.runner?.on?.('field', fn) || (() => {}); } catch { return () => {}; }
}

/** Every fieldId this client currently holds a battle for (battleRunner keeps one entry per field). */
function allFieldIds(api) {
  try {
    const entries = api.runner?._entries;
    return entries && typeof entries.keys === 'function' ? [...entries.keys()] : [];
  } catch { return []; }
}

/** 游戏自己的回合号（`m.public.round`）；读不到就 null（那时退回自增序号）。 */
function gameRound(api) {
  try {
    const pub = api.store?.get?.()?.match?.public;
    const r = pub && pub.round;
    return Number.isFinite(r) && r > 0 ? Math.trunc(r) : null;
  } catch { return null; }
}

/**
 * 这一帧的「每个干员累计伤害 / 治疗」——按干员身份合并所有战场（同一名干员在多个战场里算一个人）。
 * @returns {{ rows: { key: string, name: string, defId: string|null, golden: boolean, dmg: number, heal: number }[], bid: string|null, done: boolean, time: number }}
 */
export function sampleRound(api) {
  const runner = api.runner;
  const byKey = new Map();
  let bid = null;
  let done = false;
  let time = 0;
  let seen = false;
  const fields = allFieldIds(api);
  for (const fid of (fields.length ? fields : [null])) {
    let data;
    try { data = runner?.fieldUnits?.(fid) || null; } catch { continue; }
    if (!data || !Array.isArray(data.units) || !data.units.length) continue;
    seen = true;
    if (bid == null) bid = data.battleId == null ? null : String(data.battleId);
    if (data.done === true) done = true;
    time = Math.max(time, Number.isFinite(data.time) ? data.time : 0);
    for (const u of takeSample(data.units, data.time).units) {
      if (!isContributor(u)) continue;
      const key = unitKey(u);
      const cur = byKey.get(key);
      if (!cur) {
        byKey.set(key, { key, name: u.name || u.defId || key, defId: u.defId || null, golden: !!u.golden, dmg: u.dmg, heal: u.heal });
        continue;
      }
      cur.dmg += u.dmg;
      cur.heal += u.heal;
      cur.golden = cur.golden || !!u.golden;
    }
  }
  return { rows: seen ? [...byKey.values()] : [], bid, done, time };
}

/**
 * 插件入口：起一个取样循环（含回合归档），在结算页放一个按钮。
 * @returns {{ dispose: () => void }}
 */
export default function register(api) {
  api.loadCss();
  api.i18n().catch(() => {}); // 自带文案（i18n/<语言>.json）；缺文件就用中文原文

  /** 本局已收尾的回合（新的在前）——只活在这个插件里，落盘只为「结算那一刻」读得回来。 */
  let history = [];
  /** 正在进行的这一回合的实时快照（结算事件比回合收尾早，靠它补最后一回合）。 */
  let live = { round: null, time: 0, rows: [] };
  let roundRec = null;   // stepRound 的状态机记录

  const persist = () => {
    try { globalThis.localStorage?.setItem(LATEST_KEY, JSON.stringify(serializeLatest(history))); } catch { /* quota / private mode */ }
  };

  const closeRound = (rec) => {
    if (!rec || rec.archived || !(rec.last || []).length) return;
    rec.archived = true;
    const rows = rec.last;
    const round = rec.round ?? rec.n;
    let dmg = 0; let heal = 0;
    for (const r of rows) { dmg += r.dmg || 0; heal += r.heal || 0; }
    history = [{ label: api.t('第 {n} 回合', { n: round }), at: Date.now(), time: rec.time || 0, round, dmg, heal, rows }, ...history];
    persist();
    if (_debug()) console.info('[plugin:match-charts] 归档回合', round, rows.length, '人');
  };

  const tick = () => {
    if (!api.runner || typeof api.runner.fieldUnits !== 'function') return;
    const { rows, bid, done, time } = sampleRound(api);
    // 回合状态机：回合结束（done）/ 换场（battleId 变了）/ 战斗消失（连续两次取不到）三条路各收一次
    const info = rows.length ? { key: 'all', bid, done, time } : null;
    const step = stepRound(roundRec, info, { round: gameRound(api) });
    if (step.close) closeRound(step.close);
    roundRec = step.rec;
    if (!info) return;
    if (!roundRec) return;
    if (step.fresh) live = { round: roundRec.round ?? roundRec.n, time: 0, rows: [] };
    if (rows.length) {
      roundRec.last = rows;
      live = { round: roundRec.round ?? roundRec.n, time, rows };
    }
    roundRec.time = Math.max(roundRec.time || 0, time);
  };

  tick();
  const timer = setInterval(tick, SAMPLE_MS);
  const offField = runnerHook(api, tick);

  // 一局结束（记录落库）：把「已收尾的回合 + 进行中的这一回合」一起按 record.id 存档
  const stopRecorder = createRecorder(api, () => withLiveRound(history, live, { label: api.t('最后一回合') }));

  // 新一局开始：清掉上一局的回合（否则新一局的曲线会把上一局的回合算进去）
  let offStore = () => {};
  const store = api.store;
  if (store && typeof store.subscribe === 'function' && typeof store.get === 'function') {
    let was = matchActive(store.get());
    offStore = store.subscribe((s) => {
      const now = matchActive(s);
      if (now === was) return;
      was = now;
      if (!now) return;                        // 结算 / 回大厅：先不动，等下一局开始时再清
      history = [];
      live = { round: null, time: 0, rows: [] };
      roundRec = null;
      try { globalThis.localStorage?.removeItem(LATEST_KEY); } catch { /* ignore */ }
      if (_debug()) console.info('[plugin:match-charts] 新一局开始 → 清空回合记录');
    });
  }

  // 结算页「模拟完成」标题旁的按钮 + 白底黑字弹窗
  const stopButton = mountResultButton(api);

  return {
    dispose() {
      clearInterval(timer);
      offField();
      offStore();
      stopRecorder();
      stopButton();
    },
  };
}

/** 调试日志开关（浏览器里设 window.__SP_DEBUG_PLUGINS__ = true）；每次读，随时开。 */
const _debug = () => !!globalThis.__SP_DEBUG_PLUGINS__;
