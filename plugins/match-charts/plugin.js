// 「战后统计」插件（plugins/match-charts）—— 结算页「模拟完成」标题旁的按钮 + 白底黑字的 ECharts 统计弹窗
// （下拉框选回合，画该回合各单位的占比饼图）。
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
  SAMPLE_MS, LATEST_KEY, serializeLatest, takeSample, stepRound, withLiveRound, unitKey, matchActive, isContributor, readLog,
  readLatest,
} from './charts-core.js';

/** The runner's own `field` event, defensively: the plugin must work on a runner without it. */
function runnerHook(api, fn) {
  try { return runnerOf(api)?.on?.('field', fn) || (() => {}); } catch { return () => {}; }
}

/**
 * 这场战斗的 runner：先问宿主（`api.runner`），拿不到就退回全局 `__SP_RUNNER__`。
 *
 * 宿主那个 getter 是懒取的，但**只要它为 null，取样循环就会每帧直接返回**，于是整局一条数据都没有
 * （用户报的「战后统计一直不更新」：settled 日志里是 `handing over 0 round(s)`）。全局那个是
 * `public/js/battle/runner.js` 模块级发布的，绕过宿主更稳。
 */
function runnerOf(api) {
  try { return (api && api.runner) || globalThis.__SP_RUNNER__ || null; } catch { return null; }
}

/**
 * 本客户端当前持有的每个**战场 id**（`fieldUnits(参数)` 要的是 fieldId，例如 `n:p_xxx`；`_entries` 的键是
 * battleId，混用会让 `fieldUnits` 永远返回空 —— 见 sampleRound 的注释）。诊断日志用它列出战场。
 */
function allFieldIds(api) {
  try {
    const entries = runnerOf(api)?._entries;
    const out = [];
    if (entries && typeof entries.values === 'function') {
      for (const e of entries.values()) if (e && typeof e.fieldId === 'string' && e.fieldId) out.push(e.fieldId);
    }
    return out;
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

/** 本机玩家 id（`store.me.playerId`）；读不到就 null（那时不做归属过滤）。 */
function myPlayerId(api) {
  try { const v = api?.store?.get?.()?.me?.playerId; return typeof v === 'string' && v ? v : null; } catch { return null; }
}

/**
 * 原始模拟单位 → `fieldUnits()` 那种**拍平**形状。
 *
 * 关键：`battle.allyUnits` 里的单位把累计数据放在 `u.stats` 里（`u.stats.dmg/heal/taken/attacks/kills`），
 * 而 `takeSample()`/`isContributor()` 读的是顶层字段。少了这一步，每个单位看起来都是 0 伤害、全被过滤掉，
 * 于是整局 0 行数据（日志里表现为 `raw units=3` 但 `rowsSeen=0`）。映射规则与 runner 的 fieldUnits 完全一致。
 */
function battleUnits(list) {
  const out = [];
  for (const u of Array.isArray(list) ? list : []) {
    if (!u) continue;
    const st = u.stats || null;
    out.push({
      unitId: Number.isInteger(u.id) ? u.id : (Number.isInteger(u.uid) ? u.uid : null),
      ownerId: typeof u.ownerId === 'string' ? u.ownerId : null,
      defId: typeof u.defId === 'string' ? u.defId : null,
      name: typeof u.name === 'string' ? u.name : (u.defId || ''),
      kind: typeof u.kind === 'string' ? u.kind : 'op',
      golden: !!(u.def && u.def.golden),
      dmg: st ? Math.max(0, st.dmg || 0) : 0,
      heal: st ? Math.max(0, st.heal || 0) : 0,
      taken: st ? Math.max(0, st.taken || 0) : 0,
      attacks: st ? Math.max(0, st.attacks || 0) : 0,
      kills: st ? Math.max(0, st.kills || 0) : 0,
    });
  }
  return out;
}

/**
 * 这一帧的「每个干员累计伤害 / 治疗」——按干员身份合并所有战场（同一名干员在多个战场里算一个人）。
 * @returns {{ rows: { key: string, name: string, defId: string|null, golden: boolean, dmg: number, heal: number }[], bid: string|null, done: boolean, time: number }}
 */
export function sampleRound(api) {
  const runner = runnerOf(api);
  const byKey = new Map();
  let bid = null;
  let done = false;
  let time = 0;
  let seen = false;
  // 优先**直接读 runner 手里每个 entry 的战场对象**：`fieldUnits(fid)` 只认「当前显示在屏幕上」的那一场
  // （作者的原话：a field other than the one on screen → []），换场 / 观战 / 联防时会整帧取空。
  // 直接读 `e.battle.allyUnits` 则每个客户端持有的战场都能取到，且和 `fieldUnits` 读的是同一份数据。
  const entries = (() => { try { return runner?._entries; } catch { return null; } })();
  // 只看**自己的**干员：观战队友 / 联防共用战场时同屏还有他的干员，混进统计就不是「我的每回合输出」了。
  // ownerId 为空的单位（召唤物等没带归属的）仍然保留。
  const me = myPlayerId(api);
  const battles = [];
  if (entries && typeof entries.values === 'function') {
    for (const e of entries.values()) {
      const b = e && e.battle;
      if (!b || !Array.isArray(b.allyUnits)) continue;
      const units = battleUnits(b.allyUnits).filter((u) => !u.ownerId || !me || u.ownerId === me);
      battles.push({ id: e.battleId, units, time: b.time, done: !!b.finished || !!e.done });
    }
  }
  if (!battles.length) {
    // 兜底：只问「屏幕上那一场」（`fieldUnits(null)`）。
    // 注意别再传 `_entries` 的键：那些是 **battleId**，而 `fieldUnits(参数)` 要的是 **fieldId**（`n:p_xxx`），
    // 传错了它内部 `e.fieldId !== fieldId` 恒成立、永远返回空 —— 这正是之前整局 0 行数据的根因。
    let data;
    try { data = runner?.fieldUnits?.(null) || null; } catch { data = null; }
    if (data && Array.isArray(data.units) && data.units.length) {
      // 兜底这条路也要按归属过滤：观战队友时 `fieldUnits(null)` 给的就是**他的**干员，
      // 直接收下会把队友的数据记进我的统计（战后统计只记自己的）。
      // 注意**不要**再过一遍 battleUnits()：`fieldUnits()` 返回的已经是拍平后的单位（runner.js：dmg/heal/taken/
      // attacks/kills 都在顶层），再过一次会被当成「没有 stats」，每个单位都记成 0 —— 整局 0 行数据。
      const units = data.units.filter((u) => u && (!u.ownerId || !me || u.ownerId === me));
      battles.push({ id: data.battleId, units, time: data.time, done: data.done === true });
    }
  }
  for (const b of battles) {
    if (!b.units.length) continue;
    seen = true;
    if (bid == null) bid = b.id == null ? null : String(b.id);
    if (b.done) done = true;
    time = Math.max(time, Number.isFinite(b.time) ? b.time : 0);
    for (const u of takeSample(b.units, b.time).units) {
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

  // 落盘副本：每收尾一回合就写一次，**连正在进行的这一回合一起写**。
  // 这样即使内存里的 history/live 因为什么被清空，结算时还能从这份快照把这一局救回来（见下面的兜底）。
  const persist = () => {
    try {
      const snap = withLiveRound(history, live, { label: api.t('最后一回合') });
      globalThis.localStorage?.setItem(LATEST_KEY, JSON.stringify(serializeLatest(snap)));
    } catch { /* quota / private mode */ }
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
    api.log?.(`round archived: round ${round} · ${rows.length} operators · damage ${dmg}`);
  };

  // 排查用：**每 3 秒最多一条**（不设总数上限，所以战斗中一定会打到，不会像之前那样被开打前的空帧用光）。
  let lastDiagAt = 0;
  let rowTicks = 0;      // 本局有多少次取样真的拿到了数据（结算日志里会带上）
  const diag = () => {
    if (Date.now() - lastDiagAt < 3000) return;
    lastDiagAt = Date.now();
    const r = runnerOf(api);
    let entries = null;
    let sample = null;
    try {
      entries = r && r._entries && typeof r._entries.size === 'number' ? r._entries.size : null;
      const ids = entries ? [...r._entries.keys()] : [];
      const d = r && typeof r.fieldUnits === 'function' ? r.fieldUnits(ids[0] ?? null) : null;
      sample = d ? { battle: d.battleId ?? null, done: !!d.done, units: (d.units || []).length, dmg: (d.units || [])[0]?.dmg ?? null } : null;
    } catch (e) { sample = `err:${e && e.message}`; }
    // 直接读 entry 的战场对象（新采样路径）：看得出有几个战场、各有多少单位
    let raw = null;
    try {
      const list = [];
      const es = r && r._entries;
      if (es && typeof es.values === 'function') for (const e of es.values()) list.push({ id: e?.battleId ?? null, units: e?.battle?.allyUnits?.length ?? 0, t: e?.battle?.time ?? null, fin: !!e?.battle?.finished });
      raw = list;
    } catch (e) { raw = `err:${e && e.message}`; }
    // runner 自己的视角（0.2.5 的公开 API）：它认不认这场战斗、是不是「本客户端权威」
    let st = null;
    try {
      const v = typeof r?.state === 'function' ? r.state() : null;
      st = v ? { id: v.battleId ?? null, field: v.fieldId ?? null, kind: v.kind ?? null, auth: !!v.authoritative, done: !!v.done } : null;
    } catch (e) { st = `err:${e && e.message}`; }
    const phase = (() => { try { return api.store?.get?.()?.match?.public?.phase ?? null; } catch { return null; } })();
    // 诊断心跳：只在浏览器里设了 window.__SP_DEBUG_PLUGINS__ = true 时才打（否则每 3 秒一条噪声日志）
    if (globalThis.__SP_DEBUG_PLUGINS__) api.log?.(`tick diag: phase=${phase} rowsSeen=${rowTicks} runner=${!!r} entries=${entries} fields=${JSON.stringify(allFieldIds(api))} raw=${JSON.stringify(raw)} sample=${JSON.stringify(sample)} state=${JSON.stringify(st)}`);
  };

  const tick = () => {
    const runner = runnerOf(api);
    if (!runner) { diag(); return; }
    const { rows, bid, done, time } = sampleRound(api);
    if (rows.length) rowTicks++;
    else diag();
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
  //
  // 这里打的两行日志是排查「图表没更新」的抓手：
  //   · 每次落库都说明交出去几回合（history + live）—— 若这里是 0，说明这一局根本没采到样；
  //   · 真正的写盘结果在 chart.js 的 createRecorder（会打出 record.id 与回合数）。
  const stopRecorder = createRecorder(api, () => {
    const merged = withLiveRound(history, live, { label: api.t('最后一回合') });
    // 兜底：内存里空了就用落盘快照（`sp.charts.latest`，每次回合收尾都写）。内存被清空时（结算前后 store 抖动
    // 触发过「新一局」清理）这一局仍然能存下来 —— 注意这是**本局**的快照，不是上一局的存档。
    const snap = merged.length ? [] : readLatest();
    api.log?.(`match settled: handing over ${merged.length} round(s) (closed ${history.length} + live ${live.rows.length} rows · rowTicks ${rowTicks})`
      + (merged.length ? ' — ok' : snap.length ? ` — MEMORY EMPTY, recovered ${snap.length} round(s) from the snapshot` : ' — NOTHING TO ARCHIVE (no data was ever sampled)'));
    return merged.length ? merged : snap;
  });

  // 新一局开始：清掉上一局的回合（否则新一局的统计会把上一局的回合算进去）。
  //
  // 「新一局」判定要防抖动：战斗结束前后 store 可能瞬间没有 match.public（false → true 一闪），
  // 那种抖动如果当成新一局，就会把刚打完这局的回合全擦掉 —— 结算事件紧接着到达，于是变成
  // 「NOTHING TO ARCHIVE」、图表没有这一局的数据（用户报的现象）。所以只在**确实闲置过一段时间**后才清。
  const NEW_MATCH_GAP_MS = 1200;
  let offStore = () => {};
  const store = api.store;
  if (store && typeof store.subscribe === 'function' && typeof store.get === 'function') {
    let was = matchActive(store.get());
    let idleSince = was ? 0 : Date.now();
    offStore = store.subscribe((s) => {
      const now = matchActive(s);
      if (now === was) return;
      was = now;
      if (!now) { idleSince = Date.now(); return; }   // 结算 / 回大厅：先不动，等下一局开始时再清
      const idle = idleSince ? Date.now() - idleSince : Infinity;
      idleSince = 0;
      if (idle < NEW_MATCH_GAP_MS) {
        api.log?.(`match re-activated after ${idle} ms — treated as a flicker, rounds kept`);
        return;
      }
      history = [];
      live = { round: null, time: 0, rows: [] };
      roundRec = null;
      rowTicks = 0; lastDiagAt = 0;   // 新一局：诊断计数清零（心跳日志每 3 秒一条，不会再被吃完）
      try { globalThis.localStorage?.removeItem(LATEST_KEY); } catch { /* ignore */ }
      api.log?.('new match started — cleared the previous match’s rounds');
    });
  }

  // 结算页「模拟完成」标题旁的按钮 + 白底黑字弹窗
  const stopButton = mountResultButton(api);

  // 控制台自查（排查「图表没更新」时用）：浏览器控制台执行 __SP_CHARTS__()
  const probe = () => ({
    closedRounds: history.length,
    liveRound: live.round,
    liveRows: live.rows.length,
    current: roundRec ? { bid: roundRec.bid, round: roundRec.round, archived: !!roundRec.archived, rows: (roundRec.last || []).length } : null,
    archivedMatches: Object.keys(readLog()),
  });
  try { globalThis.__SP_CHARTS__ = probe; } catch { /* no DOM */ }

  return {
    dispose() {
      clearInterval(timer);
      offField();
      offStore();
      stopRecorder();
      stopButton();
      try { if (globalThis.__SP_CHARTS__ === probe) delete globalThis.__SP_CHARTS__; } catch { /* ignore */ }
    },
  };
}

/** 调试日志开关（浏览器里设 window.__SP_DEBUG_PLUGINS__ = true）；每次读，随时开。 */
const _debug = () => !!globalThis.__SP_DEBUG_PLUGINS__;
