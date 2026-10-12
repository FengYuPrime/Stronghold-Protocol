// 战斗统计插件的纯逻辑与本地存档（plugins/dps-meter，见 plugins/README.md）。
//
// 这里只做三件事：取样/聚合（给悬浮窗用，纯函数、可单测）、每回合的折线序列、以及对局级别的本地存档
// （`sp.dpsMeter.log`，按「对局记录」的 record.id 存，供 screens/stats.js 那栏画图）。
// 不碰 DOM、不碰网络：删掉插件就等于没有这段数据，核心代码一行都不依赖它。

/** 取样间隔（毫秒）；40 帧 = 10 秒窗口。 */
export const SAMPLE_MS = 250;
export const WINDOW_SAMPLES = 40;
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

/** 追加一帧，保留最近 WINDOW_SAMPLES 帧。 */
export function pushSample(samples, sample) {
  const next = (Array.isArray(samples) ? samples : []).concat([sample]);
  return next.length > WINDOW_SAMPLES ? next.slice(next.length - WINDOW_SAMPLES) : next;
}

/**
 * 一个单位的窗口内速率：`rateBetween(窗口起点, 最新帧, 秒数)`。
 * 累计值回退（换场/重置）时按 0 处理，不产生负数。
 */
export function rateBetween(from, to, seconds) {
  const dt = Number.isFinite(seconds) && seconds > 0 ? seconds : 1;
  const a = from || { dmg: 0, heal: 0 };
  const b = to || { dmg: 0, heal: 0 };
  // 正常是 b > a；计数回退（换场/重置）时按变化量的绝对值算，至少不会出负数
  return {
    dps: Math.abs((b.dmg || 0) - (a.dmg || 0)) / dt,
    hps: Math.abs((b.heal || 0) - (a.heal || 0)) / dt,
  };
}

/** 稳定的单位键：有 uid 用 uid，否则用 defId + 序号。 */
export function keyOf(unit, index = 0) {
  return unit && Number.isInteger(unit.unitId) ? `u${unit.unitId}` : `${(unit && unit.defId) || 'x'}#${index}`;
}

/**
 * 把一帧序列聚合成每单位一行：近 10 秒速率 + 总体速率 + 累计值 + 占比。
 * @param {{ time: number, units: any[] }[]} samples @param {number} battleTime 战斗用秒数
 */
export function aggregate(samples, battleTime) {
  const list = Array.isArray(samples) ? samples : [];
  if (!list.length) return [];
  const newest = list[list.length - 1];
  const total = Number.isFinite(battleTime) && battleTime > 0 ? battleTime : newest.time;
  // 窗口起点：最新时间往前 10 秒；窗口里的第一帧就是基准（只有一帧时窗口值退化为总体值）
  const windowSeconds = (WINDOW_SAMPLES * SAMPLE_MS) / 1000;
  const windowStart = newest.time - windowSeconds;
  const inWindow = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const s = list[i];
    if (s.time < windowStart && inWindow.length) break;
    inWindow.unshift(s);
  }
  const oldest = inWindow.length ? inWindow[0] : newest;
  // 窗口里有更早的一帧才有差分；只有一帧时窗口值退化为总体值（否则刚开打会显示 0）
  const span = newest.time > oldest.time ? newest.time - oldest.time : total;
  const hasBase = oldest !== newest;
  const index = (sample) => {
    const m = new Map();
    for (const [i, u] of (sample.units || []).entries()) m.set(keyOf(u, i), u);
    return m;
  };
  const windowIdx = index(oldest);
  const newestIdx = index(newest);
  const rows = [];
  for (const [key, cur] of newestIdx) {
    const w0 = hasBase ? (windowIdx.get(key) || null) : null;
    const dmgWindow = cur.dmg - (w0 ? Math.min(w0.dmg, cur.dmg) : 0);
    const healWindow = cur.heal - (w0 ? Math.min(w0.heal, cur.heal) : 0);
    const dt = Math.max(1e-6, span);
    rows.push({
      key,
      unitId: cur.unitId,
      name: cur.name,
      defId: cur.defId,
      golden: cur.golden,
      dmg: cur.dmg,
      heal: cur.heal,
      attacks: cur.attacks,
      kills: cur.kills,
      // 总体：累计 ÷ 战斗用时；窗口：两端累计值之差 ÷ 两端时间之差（不用平滑）
      dps: total > 0 ? cur.dmg / total : 0,
      hps: total > 0 ? cur.heal / total : 0,
      recentDps: Math.max(0, dmgWindow) / dt,
      recentHps: Math.max(0, healWindow) / dt,
      share: 0,
    });
  }
  // 横条按**总伤**归一（面板就是按总伤排序的，条长与名次一致）
  const max = Math.max(1e-6, ...rows.map((r) => r.dmg || 0));
  for (const r of rows) r.share = (r.dmg || 0) / max;
  return rows;
}

/**
 * 排序：默认按**总伤**（面板的名次口径），也可以按总体 DPS / 近 10 秒 DPS / 治疗量。
 * @param {any[]} rows @param {'dmg'|'total'|'recent'|'heal'} [metric]
 */
export function rankRows(rows, metric = 'dmg') {
  const list = Array.isArray(rows) ? [...rows] : [];
  const key = metric === 'total' ? 'dps' : metric === 'recent' ? 'recentDps' : metric === 'heal' ? 'heal' : 'dmg';
  return list.sort((a, b) => (b[key] || 0) - (a[key] || 0)
    || (b.dmg || 0) - (a.dmg || 0)
    || (b.dps || 0) - (a.dps || 0)
    || (b.hps || 0) - (a.hps || 0)
    || String(a.name).localeCompare(String(b.name)));
}

/** 过滤掉那些什么都没做的单位（`includeHealers: false` 时连纯奶妈也滤掉）。 */
export function visibleRows(rows, { includeHealers = true } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  return list.filter((r) => (r.dmg || 0) > 0 || (includeHealers && (r.heal || 0) > 0));
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

/** 这一行要不要显示治疗列（只要奶量 > 0 就显示，治疗列里 0 也照写）。 */
export const showHeal = (row) => !!(row && (row.heal || 0) > 0);