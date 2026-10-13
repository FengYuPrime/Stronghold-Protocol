// 战斗统计插件的纯逻辑与本地存档（plugins/dps-meter，见 plugins/README.md）。
//
// 这里只做三件事：取样/聚合（给悬浮窗用，纯函数、可单测）、每回合的折线序列、以及对局级别的本地存档
// （`sp.dpsMeter.log`，按「对局记录」的 record.id 存，供 screens/stats.js 那栏画图）。
// 不碰 DOM、不碰网络：删掉插件就等于没有这段数据，核心代码一行都不依赖它。

/** 取样间隔（毫秒）；40 帧 = 10 秒窗口。 */
export const SAMPLE_MS = 250;
/** 每局最多给「对局记录」留多少回合。 */
export const MAX_ROUNDS = 40;
/** `sp.dpsMeter.log` 里最多留多少局（老的先丢）。 */
export const MAX_LOG_MATCHES = 20;

/**
 * 「这一局是不是正在进行」——与 `public/js/ui/stats.js` 的 `observeMatch()` 同一判定规则：
 * 拿到公开视图、阶段不是大厅/结算、也还没有结算结果。
 *
 * 插件用它检测 **false → true 的跳变**＝新一局开始，从而清空悬浮窗里的记录（否则上一局的回合会留在窗口里）。
 * 阶段名与 `shared/constants.js` 的 PHASE 一致（下面两个字面量的对应关系有单测盯着，改名会立刻报错）。
 * @param {any} state app store 的状态
 * @returns {boolean}
 */
export function matchActive(state) {
  const pub = state && state.match && state.match.public;
  if (!pub || !pub.phase) return false;
  if (pub.phase === 'LOBBY' || pub.phase === 'RESULT') return false;   // PHASE.LOBBY / PHASE.RESULT
  return !(state.match && state.match.result);
}


/** 本局每一局存档的键（插件自己的；删掉插件就等于没有这段数据）。 */
export const LOG_KEY = 'sp.charts.log';

/** 拆分之前「战斗统计」用的键：只读回退，老玩家攒下的几局不能因为分家就消失。 */
export const LEGACY_LOG_KEY = 'sp.dpsMeter.log';

/** 本局每回合的落盘副本：结算那一刻（记录落库）拿它正式存档，所以它必须自包含。 */
export const LATEST_KEY = 'sp.charts.latest';

/**
 * 把每回合的历史压成可存的形状。
 *
 * **必须带上每个干员的明细（rows）**：结算时 `matchLog()` 靠它组出图表要的 `units`，只存汇总数字的话
 * 图表就是空的（用户报过「打完点战斗统计显示没数据」）。只保留图表用得到的字段，控制体积。
 * @param {{ label?: string, at?: number, time?: number, round?: number|null, dmg?: number, heal?: number, rows?: any[] }[]} history
 */
export function serializeLatest(history) {
  return (Array.isArray(history) ? history : []).map((h) => ({
    label: h && h.label,
    at: h && h.at,
    time: (h && h.time) || 0,
    round: h && h.round != null ? h.round : null,
    dmg: (h && h.dmg) || 0,
    heal: (h && h.heal) || 0,
    rows: (Array.isArray(h && h.rows) ? h.rows : []).map((r) => ({
      key: r && r.key,
      name: (r && r.name) || '',
      defId: (r && r.defId) || null,
      golden: !!(r && r.golden),
      dmg: Math.max(0, (r && r.dmg) || 0),
      heal: Math.max(0, (r && r.heal) || 0),
    })),
  }));
}

/**
 * 把「正在进行中的这一回合」并进要存档的列表（新的在前）。
 *
 * 为什么需要它：结算事件（`sp:match-record`）只比最后一回合的收尾早一点点 —— 最后一回合往往还没来得及被
 * 归档（收尾要看 `fieldUnits().done`，或等战斗从 runner 消失两次取样），于是那一局会少一回合，极端情况
 * （一局一回合、或很短的局）整局为空、图表显示「没有数据」。收尾事件里带上这一回合的实时快照即可。
 *
 * 同一回合已经收尾过就不重复加（比 `round`）。
 * @param {any[]} history 已收尾的回合（新的在前）
 * @param {{ round?: number|null, time?: number, rows?: any[] }|null} live 进行中的这一回合
 * @param {{ label?: string, now?: number }} [o]
 */
export function withLiveRound(history, live, { label = '', now = Date.now() } = {}) {
  const list = Array.isArray(history) ? history : [];
  const rows = live && Array.isArray(live.rows) ? live.rows.filter(Boolean) : [];
  if (!rows.length) return list;
  const round = live.round != null ? live.round : null;
  if (list.length && (list[0].round ?? null) === round) return list;   // 这一回合已经收尾
  let dmg = 0; let heal = 0;
  for (const r of rows) { dmg += r.dmg || 0; heal += r.heal || 0; }
  const entry = { label, at: now, time: live.time || 0, round, dmg, heal, rows };
  return [entry, ...list].slice(0, MAX_ROUNDS);
}

/** 读回这份副本（解析失败当空数组，不抛）。 */
export function readLatest(storage = globalThis.localStorage) {
  try {
    const parsed = JSON.parse(storage?.getItem(LATEST_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}


/**
 * 面板上所有数字的格式：**只显示整数**（四舍五入），五位数起加千分位。
 *
 * 这是需求方指定的：DPS / 治疗 / 总伤都不再带小数位（原来 `420.1` 这类读数太吵），
 * 而 `1.2k` 那种缩写同样带小数，所以大数改成 `12,345` 这种写法。
 * @param {number} n @returns {string}
 */
export function fmtInt(n) {
  const num = Number(n);
  const v = Number.isFinite(num) ? Math.round(num) : 0;   // NaN / ±Infinity → 0（不可能是有效伤害）
  return Math.abs(v) >= 10000 ? v.toLocaleString('en-US') : String(v);
}


/** 参战单位：只有真正打过或奶过的才进榜（`taken`/`attacks` 单独记账的召唤物也算）。 */
export const isContributor = (u) => !!u && (u.dmg > 0 || u.heal > 0 || u.attacks > 0 || u.kills > 0 || u.taken > 0);

/** 一次取样的单位表 → 归一化的一帧（缺字段补 0，负数归零）。 */
export function takeSample(units, time) {  const list = Array.isArray(units) ? units : [];
  return {
    time: Number.isFinite(time) && time > 0 ? time : 0,
    units: list.map((u, i) => ({
      unitId: Number.isInteger(u && u.unitId) ? u.unitId : null,
      // 归属玩家：观战队友的战场 / 联防共用战场时，同屏会有两个人的干员，必须带上才能分开统计
      ownerId: (u && typeof u.ownerId === 'string') ? u.ownerId : null,
      defId: (u && (u.defId || u.name)) || `#${i}`,
      name: (u && (u.name || u.defId)) || `#${i}`,
      kind: (u && u.kind) || 'op',
      golden: !!(u && u.golden),
      dmg: Math.max(0, (u && u.dmg) || 0),
      heal: Math.max(0, (u && u.heal) || 0),
      taken: Math.max(0, (u && u.taken) || 0),
      attacks: Math.max(0, (u && u.attacks) || 0),
      kills: Math.max(0, (u && u.kills) || 0),
    })),
  };
}
/**
 * 回合状态机（悬浮窗每 250 ms 调一次）：决定「收尾上一场 / 开一场新的 / 继续攒 / 记一次未命中」。
 *
 * 关键点：**回合一结束就要收尾**，不能等下一场开始（那样第一回合的记录要等第二回合才出现）：
 *   · `info.done === true`        战斗自己结束了（runner 的 `fieldUnits().done`）→ 调用方立刻收尾
 *   · `info.bid` 变了 / 换了战场  上一场收尾，同时开一场新的
 *   · `info == null`（战斗已从 runner 清掉）→ 连续两次取不到才收尾，避免被一次空取样误判
 *
 * `rec` 是调用方自己的对象（会被就地更新 `misses`）；返回的 `close` 非空就表示「把这一条收尾」。
 * @param {{ key: string, bid: string|null, n: number, round: number|null, last: any[], time: number, archived: boolean, misses?: number }|null} rec
 * @param {{ key: string, bid: string|null, done: boolean, time: number }|null} info
 * @param {{ round?: number|null }} [o]
 * @returns {{ rec: any, close: any, fresh: boolean }}
 */
export function stepRound(rec, info, { round = null } = {}) {
  if (!info) {
    if (rec && (rec.last || []).length && !rec.archived) {
      rec.misses = (rec.misses || 0) + 1;
      return { rec, close: rec.misses >= 2 ? rec : null, fresh: false };
    }
    return { rec, close: null, fresh: false };
  }
  const isNew = !rec || rec.key !== info.key || rec.bid !== info.bid;
  if (isNew) {
    return {
      rec: { key: info.key, bid: info.bid, n: rec ? rec.n + 1 : 1, round: round ?? null, last: [], time: 0, archived: false, misses: 0 },
      close: rec || null,
      fresh: true,
    };
  }
  rec.misses = 0;
  // 回合结束：这一条就地收尾（不必等下一场开始）。archived 由调用方的收尾逻辑打标，所以这里不重复收。
  if (info.done && (rec.last || []).length && !rec.archived) return { rec, close: rec, fresh: false };
  return { rec, close: null, fresh: false };
}
/** 一个单位在这张图里的身份：同一名干员跨回合要连成一条线，而 unitId 每场战斗都会变。 */
export function unitKey(u) {
  const defId = (u && u.defId) || (u && u.name) || '?';
  return `${defId}${u && u.golden ? '|g' : ''}`;
}

/**
 * 「对局记录」那张折线图的数据：**一人一条线**，横轴回合、竖轴该干员该回合的总量。
 *
 * 说明：竖轴用**总伤**（不是 DPS）——需求方指定；要治疗就传 `metric: 'heal'`。
 * 某回合该干员没上场/没出手时记 0（线上落在 0 而不是断开，回合数仍然对齐）。
 * @param {{ rounds?: { n?: number, units?: { key?: string, name?: string, defId?: string, golden?: boolean, dmg?: number, heal?: number }[] }[] }} entry
 * @param {'dmg'|'heal'} [metric]
 * @returns {{ rounds: number[], series: { key: string, name: string, defId: string, total: number, points: number[] }[] }}
 */
export function unitSeries(entry, metric = 'dmg') {
  const field = metric === 'heal' ? 'heal' : 'dmg';
  const rounds = Array.isArray(entry && entry.rounds) ? entry.rounds : [];
  const roundNums = rounds.map((r, i) => (Number.isFinite(r && r.n) ? Math.trunc(r.n) : i + 1));
  const byKey = new Map();
  rounds.forEach((r, i) => {
    for (const u of Array.isArray(r && r.units) ? r.units : []) {
      if (!u) continue;
      const k = u.key || unitKey(u);
      let s = byKey.get(k);
      if (!s) {
        s = { key: k, name: u.name || u.defId || k, defId: u.defId || null, total: 0, points: rounds.map(() => 0) };
        byKey.set(k, s);
      }
      const v = Math.max(0, Number(u[field]) || 0);
      s.points[i] = v;
      s.total += v;
    }
  });
  const series = [...byKey.values()].sort((a, b) => b.total - a.total || String(a.name).localeCompare(String(b.name)));
  return { rounds: roundNums, series };
}

/**
 * 一局的历史 → 折线图要的每回合序列（从早到晚）。
 *
 * 一回合 = 一次战斗（`battleId` 变了就归档一回合），每个点是一次战斗自己的总量与它自己的时长；
 * 横轴用**游戏自己的回合号**（`round`，m.public.round），没有就退回自增序号。
 *   dmg  该回合全队总伤害      dps  = dmg / 该回合时长
 *   heal 该回合全队总治疗      hps  = heal / 该回合时长
 * @param {{ label?: string, round?: number|null, time?: number, dmg?: number, heal?: number }[]} history newest first
 */
export function roundSeries(history) {
  const list = Array.isArray(history) ? [...history] : [];
  list.reverse(); // 图上从左到右 = 时间顺序
  return list.map((h, i) => {
    const time = Number.isFinite(h.time) && h.time > 0 ? h.time : 0;
    const dmg = Math.max(0, h.dmg || 0);
    const heal = Math.max(0, h.heal || 0);
    // 游戏回合号优先（可能不连续，比如跳过了隐藏回合）；缺失时退回 1..n
    const round = Number.isFinite(h.round) && h.round > 0 ? Math.trunc(h.round) : i + 1;
    return {
      n: round,
      label: h.label || `#${i + 1}`,
      dmg,
      heal,
      time,
      dps: time > 0 ? dmg / time : 0,
      hps: time > 0 ? heal / time : 0,
    };
  });
}

/**
 * 一局的存档记录（交给 saveMatch 写进 localStorage）。
 *
 * 每回合除了全队合计，还带上**该回合每个干员的伤害/治疗** —— 「对局记录」那张图是一人一条折线
 * （横轴回合、竖轴总伤），没有这份明细就画不出来。
 * @param {{ label?: string, round?: number|null, time?: number, dmg?: number, heal?: number, rows?: any[] }[]} history newest first
 * @param {{ difficulty?: any, roomMode?: any, victory?: any }} [meta]
 */
export function matchLog(history, meta = {}) {
  const list = Array.isArray(history) ? [...history] : [];
  const rounds = roundSeries(list).map((r, i) => {
    const src = list[list.length - 1 - i] || {};     // roundSeries 反过来了：这里取回同一回合的原始归档
    const units = [];
    for (const u of Array.isArray(src.rows) ? src.rows : []) {
      if (!u) continue;
      const key = unitKey(u);
      const dmg = Math.max(0, u.dmg || 0);
      const heal = Math.max(0, u.heal || 0);
      if (!dmg && !heal) continue;                   // 什么都没做的单位不进图
      units.push({ key, name: u.name || u.defId || key, defId: u.defId || null, golden: !!u.golden, dmg, heal });
    }
    return { ...r, units };
  });
  if (!rounds.length) return null;
  let dmg = 0; let heal = 0; let time = 0;
  for (const r of rounds) { dmg += r.dmg; heal += r.heal; time += r.time; }
  return {
    v: 2,
    at: Date.now(),
    rounds,
    total: { rounds: rounds.length, dmg, heal, time, dps: time > 0 ? dmg / time : 0, hps: time > 0 ? heal / time : 0 },
    meta: { difficulty: meta.difficulty ?? null, roomMode: meta.roomMode ?? null, victory: meta.victory ?? null },
  };
}

/**
 * 读整个日志表（解析失败当空表；不抛）。
 *
 * 自己的键没有时回退读**拆分之前**「战斗统计」用的旧键（`LEGACY_LOG_KEY`）：那时候悬浮窗和图表在一个插件里，
 * 老玩家已经攒下的几局不能因为分家就消失。只读不写 —— 新档一律写进 `LOG_KEY`。
 */
export function readLog(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(LOG_KEY) ?? storage?.getItem(LEGACY_LOG_KEY);
    const j = raw ? JSON.parse(raw) : null;
    return j && typeof j === 'object' && j.byRecord && typeof j.byRecord === 'object' ? j.byRecord : {};
  } catch { return {}; }
}

/** 写入一局的记录（按 record.id 覆盖同一条）；超出 MAX_LOG_MATCHES 时丢最旧的。 */
export function saveMatch(recordId, entry, storage = globalThis.localStorage) {
  if (!recordId || !entry) return false;
  try {
    const byRecord = readLog(storage);
    byRecord[recordId] = entry;
    const ids = Object.keys(byRecord)
      .sort((a, b) => (byRecord[b]?.at || 0) - (byRecord[a]?.at || 0))
      .slice(0, MAX_LOG_MATCHES);
    const trimmed = {};
    for (const id of ids) trimmed[id] = byRecord[id];
    storage?.setItem(LOG_KEY, JSON.stringify({ v: 1, byRecord: trimmed }));
    return true;
  } catch { return false; }
}

/** 读一局（没有就返回 null）。 */
export function readMatch(recordId, storage = globalThis.localStorage) {
  if (!recordId) return null;
  const entry = readLog(storage)[recordId];
  return entry && Array.isArray(entry.rounds) && entry.rounds.length ? entry : null;
}

/**
 * 最近存档的一局（按 `at`）→ `{ id, entry }`；表空时 null。
 *
 * 结算页上「最近一局」就是刚打完那局，所以按钮拿不到对应编号时用它兜底 —— 编号是一路传递的（事件 detail →
 * 按钮），任何一环没接上都会让弹窗显示「没数据」，而兜底能保证只要有存档就画得出来。
 */
export function newestMatch(storage = globalThis.localStorage) {
  const byRecord = readLog(storage);
  let best = null;
  for (const id of Object.keys(byRecord)) {
    const entry = byRecord[id];
    if (!entry || !Array.isArray(entry.rounds) || !entry.rounds.length) continue;
    if (!best || (entry.at || 0) > (best.entry.at || 0)) best = { id, entry };
  }
  return best;
}

/**
 * 折线调色板（**白底用**，所以取饱和的深色）：一人一条线，按图例顺序（总量从大到小）取色。
 */
export const LINE_COLORS = Object.freeze([
  '#d9480f', '#0b7285', '#1971c2', '#7048e8', '#c2255c', '#2b8a3e',
  '#e8590c', '#5f3dc4', '#0c8599', '#a61e4d', '#364fc7', '#5c940d',
]);

/** 第 i 条线的颜色（超出调色板就循环）。ECharts 的 color 数组就按这个顺序给。 */
export const colorAt = (i) => LINE_COLORS[i % LINE_COLORS.length];

/**
 * ECharts 的 option（**纯函数，可单测**）。
 *
 * 交互全交给 ECharts（用户指定用 ECharts）：
 *   · `tooltip.trigger: 'axis'` + `order: 'valueDesc'` → 参考图那种跟随鼠标的提示框，数值从大到小排；
 *   · `legend` 自带点击隐藏 / 显示折线，并在图例文字后面补上该干员这一局的总量。
 * 隐藏某些线之后纵轴由 ECharts 自动按**剩余可见线**重算（与它默认行为一致）。
 *
 * @param {{ series: { name: string, points: number[] }[], rounds: number[], axisName?: string, totals?: Record<string, number>, t?: (s: string, p?: any) => string }} o
 */
export function echartsOption({ series, rounds, axisName = '', totals = {}, t = (s) => s }) {
  const list = Array.isArray(series) ? series : [];
  const roundLabels = (Array.isArray(rounds) ? rounds : []).map((r) => String(r));
  return {
    animation: false,
    color: list.map((_, i) => colorAt(i)),
    grid: { left: 66, right: 78, top: 48, bottom: 32 },
    tooltip: {
      trigger: 'axis',
      confine: true,
      order: 'valueDesc',
      axisPointer: { type: 'line', lineStyle: { color: '#9aa3a0', type: 'dashed' } },
      backgroundColor: '#ffffff',
      borderColor: '#d5dbd9',
      textStyle: { color: '#0b0f14', fontSize: 12 },
      formatter: (params) => {
        const arr = Array.isArray(params) ? params : [params];
        if (!arr.length) return '';
        const head = t('第 {n} 回合', { n: arr[0].axisValue });
        const rows = arr.map((p) => `<div style="display:flex;align-items:center;gap:8px;line-height:1.6">`
          + `<span style="width:8px;height:8px;border-radius:50%;background:${p.color};display:inline-block"></span>`
          + `<span style="flex:1;color:#3b4450">${p.seriesName}</span>`
          + `<b style="margin-left:16px;font-variant-numeric:tabular-nums">${fmtInt(p.value)}</b></div>`).join('');
        return `<div style="font-weight:700;margin-bottom:4px">${head}</div>${rows}`;
      },
    },
    legend: {
      type: 'scroll',
      top: 0,
      left: 0,
      right: 0,
      itemWidth: 14,
      itemHeight: 8,
      itemGap: 14,
      textStyle: { color: '#1a2027', fontSize: 12 },
      formatter: (name) => `${name}  ${fmtInt(totals[name] || 0)}`,
    },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: roundLabels,
      name: t('回合'),
      nameLocation: 'end',
      nameGap: 8,
      nameTextStyle: { color: '#5b6470', fontSize: 11 },
      axisLine: { lineStyle: { color: '#d5dbd9' } },
      axisTick: { show: false },
      axisLabel: { color: '#4b545f', fontSize: 12 },
    },
    yAxis: {
      type: 'value',
      name: axisName,
      nameTextStyle: { color: '#5b6470', fontSize: 11 },
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: '#4b545f', fontSize: 12, formatter: (v) => fmtInt(v) },
      splitLine: { lineStyle: { color: '#e3e7e6' } },
    },
    series: list.map((s, i) => ({
      name: s.name,
      type: 'line',
      smooth: false,
      symbol: 'circle',
      symbolSize: 6,
      lineStyle: { width: 2.2 },
      itemStyle: { color: colorAt(i) },
      emphasis: { focus: 'series' },
      data: (s.points || []).slice(),
    })),
  };
}
