// 战斗统计（DPS / 治疗）悬浮窗插件 —— 见 plugins/README.md。
//
// 数据来自战斗模拟自己在每个单位上累计的 `stats`（server/sim/units.js：dmg / heal / attacks / kills / taken），
// 由战斗 runner 的只读接口 `fieldUnits()` 暴露（public/js/battle/runner.js）——插件只读，不参与模拟，不改伤害。
// 纯逻辑在 dps-core.js（可单测），这个文件只负责：取样、范围切换、渲染与生命周期。
//
// 卸载：插件 loader 会先调这个模块返回的 dispose()（清定时器），再移除容器与样式；因此删掉 plugins/dps-meter/
// 整个文件夹就完全不生效。

// 路径必须是「站点绝对路径」：插件的 URL 是 /plugins/<id>/plugin.js，相对路径只能回到站根 `/`，
// 而 vendor / ui 的挂载点是 /vendor/ 与 /js/（public/ 不对外暴露 —— 写成 ../../public/… 会 404）
import { render, Fragment } from '/vendor/preact.module.js';
import { useEffect, useRef, useState } from '/vendor/hooks.module.js';
// `html` 是 htm 绑定版，由项目的 ui/components.js 导出（preact 本身没有这个导出——插件必须从这里拿）
import { html } from '/js/ui/components.js';
import {
  SAMPLE_MS, takeSample, pushSample, aggregate, rankRows, visibleRows, showHeal, stepRound, matchActive, fmtInt,
} from './dps-core.js';

export const VERSION = '1.2.0';

/** 每回合归档保留多少条（最近的在前）。 */
const MAX_ROUNDS_KEPT = 12;

const cx = (...p) => p.flat().filter(Boolean).join(' ');
/** 数字一律整数显示（fmtInt 在 dps-core，有单测）。 */
const fmt = fmtInt;

/**
 * 一行：名字 + 近 10 秒 / 总体 DPS + **总伤**（治疗列只要有单位的 heal > 0 就显示，0 也照写 0）。
 * 数值顺序与表头一一对应：近 10 秒 / 总体 / 总伤，治疗侧是 近 10 秒 / 总量。
 */
function Row({ r, t, heal = false }) {
  return html`<li class="dpsm-row" data-unit=${r.key}>
    <span class="dpsm-name" title=${r.defId}>${r.name}${r.golden ? html`<i class="dpsm-gold"></i>` : null}</span>
    <span class="dpsm-nums">
      <b class="num dpsm-recent">${fmt(r.recentDps)}</b>
      <span class="dpsm-sep">/</span>
      <b class="num dpsm-total">${fmt(r.dps)}</b>
      <b class="num dpsm-dmg" title=${t('总伤害')}>${fmt(r.dmg)}</b>
      ${heal ? html`<b class="num dpsm-heal" title=${t('治疗')}>${fmt(r.recentHps)}</b>
        <b class="num dpsm-heal dpsm-heal--sum" title=${t('总治疗')}>${fmt(r.heal)}</b>` : null}
    </span>
    <i class="dpsm-bar" style=${`width:${Math.round(Math.max(0, Math.min(1, r.share)) * 100)}%`}></i>
  </li>`;
}

/**
 * Store one finished round (its last sampled numbers) — the collapse list under the live table.
 * @param {{ label: string, round?: number|null, t?: number, dmg?: number, heal?: number }[]} history newest first
 * @param {string} label @param {any[]} rows the last ranked rows of that round
 * @param {{ time?: number, round?: number|null }} meta battle clock when it was archived (seconds) + the game's round
 */
function archiveRound(history, label, rows, meta = {}) {
  if (!rows.length) return history;
  let dmg = 0; let heal = 0;
  for (const r of rows) { dmg += r.dmg || 0; heal += r.heal || 0; }
  const next = [{ label, at: Date.now(), time: meta.time || 0, round: meta.round ?? null, dmg, heal, rows: rows.map((r) => ({ ...r })) }, ...history];
  return next.slice(0, MAX_ROUNDS_KEPT);
}

/**
 * 悬浮窗本体：每 SAMPLE_MS 取一次样，随时切「当前战场 / 全部战场」，每回合结束后留一份可折叠的历史。
 *
 * `hidden` 只是把它藏起来（`display:none`），**组件不卸载** —— 关窗再打开时这一局的 history / 采样 /
 * 回合状态都还在；采样与回合归档在隐藏时也照常跑。
 *
 * 它只做「对局中看数字」这一件事：每回合的明细不再落盘（那是 plugins/match-charts 自己的事），
 * 所以这个插件删掉之后不会有任何残留数据。
 */
export function DpsPanel({ api, onClose, hint = '', hidden = false }) {
  const [rows, setRows] = useState([]);
  const [history, setHistory] = useState([]);   // [{ label, at, rows }] 最近的在前
  const [openRound, setOpenRound] = useState(0); // 展开的历史轮次（下标）；-1 = 全部折叠
  const [scope, setScope] = useState('field'); // 'field' 当前战场 | 'all' 全部战场
  const [pos, setPos] = useState(() => {
    try { return JSON.parse(globalThis.localStorage?.getItem('sp.dpsMeter.pos') || 'null') || { left: 18, bottom: 92 }; } catch { return { left: 18, bottom: 92 }; }
  });
  const samplesRef = useRef(new Map()); // `${fieldId}` → samples[]
  /** 当前这一回合的记录：{ key, bid, n, round, last, time, archived, misses }。只跟「主战场」走。 */
  const roundRef = useRef(null);
  const dragRef = useRef(null);

  useEffect(() => {
    let live = true;
    let loggedAt = 0;

    /**
     * 收尾一回合：把它最后取到的数字归成一条可折叠记录。只做一次（archived 标记）。
     *
     * 三条路都会走到这里——回合结束（`fieldUnits().done`）、下一场开打（battleId 变了）、战斗从 runner 消失。
     * 早先的版本只认「换场」，于是第一回合的记录要等第二回合开始才出现。
     */
    const closeRound = (rec) => {
      if (!rec || rec.archived || !(rec.last || []).length) return;
      rec.archived = true;
      const rows = rec.last;
      const n = rec.round ?? rec.n;
      setHistory((h) => archiveRound(h, api.t('第 {n} 回合', { n }), rows, { time: rec.time || 0, round: rec.round ?? null }));
      if (globalThis.__SP_DEBUG_PLUGINS__) console.info('[plugin:dps-meter] 归档回合', n, rows.length, '人');
    };

    const tick = () => {
      if (!live) return;
      const runner = api.runner;
      if (!runner || typeof runner.fieldUnits !== 'function') {
        if (globalThis.__SP_DEBUG_PLUGINS__ && Date.now() - loggedAt > 2000) { loggedAt = Date.now(); console.warn('[plugin:dps-meter] runner 不可用', !!runner); }
        return;
      }
      const fields = scope === 'all' ? allFieldIds(api) : [null];
      const all = [];
      let seen = false;
      let primary = null;      // 主战场（收尾以它为准，避免多战场各归一条重复记录）
      let primaryInfo = null;  // { bid, done, time }
      for (const fid of (fields.length ? fields : [null])) {
        let data;
        try { data = runner.fieldUnits(fid); } catch { continue; }
        if (!data || !Array.isArray(data.units) || !data.units.length) continue;
        seen = true;
        const key = String(data.fieldId || 'field');
        if (!primary) {
          primary = key;
          primaryInfo = {
            bid: data.battleId == null ? null : String(data.battleId),
            done: data.done === true,
            time: Number.isFinite(data.time) ? data.time : 0,
          };
        }
        const samples = pushSample(samplesRef.current.get(key) || [], takeSample(data.units, data.time));
        samplesRef.current.set(key, samples);
        for (const r of visibleRows(aggregate(samples, data.time))) all.push({ ...r, field: key });
      }
      // 名次与横条都按**总伤**（需求方指定）：调用 rankRows 的默认口径，不再按近 10 秒 DPS
      const ranked = seen ? rankRows(scope === 'all' ? mergeFields(all) : all) : [];
      if (globalThis.__SP_DEBUG_PLUGINS__ && Date.now() - loggedAt > 2000) {
        loggedAt = Date.now();
        console.info('[plugin:dps-meter] 取样', { scope, fields, seen, rows: ranked.length, done: !!primaryInfo?.done, sample: ranked.slice(0, 3).map((r) => `${r.name} ${Math.round(r.recentDps)}/${Math.round(r.dps)}`) });
      }
      if (!seen) setRows([]); else setRows(ranked);

      // 收尾/开新场由纯函数决定（dps-core.stepRound，有单测）：回合结束 / 换场 / 战斗消失 三条路
      const step = stepRound(roundRef.current, primaryInfo ? { ...primaryInfo, key: primary } : null, { round: gameRound(api) });
      if (step.close) closeRound(step.close);
      if (step.rec !== roundRef.current) roundRef.current = step.rec;
      if (!primaryInfo) return;      // 战斗不在数据里：只可能收尾，没有新数字可记
      const cur = roundRef.current;
      if (step.fresh) samplesRef.current.set(cur.key, []); // 新回合的窗口从零开始（否则近 10 秒会跨两场）
      if (ranked.length) cur.last = ranked;
      cur.time = Math.max(cur.time || 0, primaryInfo.time);
    };
    tick();
    const timer = setInterval(tick, SAMPLE_MS);
    const off = runnerHook(api, () => { samplesRef.current.clear(); tick(); });
    return () => { live = false; clearInterval(timer); off(); };
  }, [scope]);

  const startDrag = (e) => {
    const el = e.currentTarget.closest('.dpsm');
    if (!el) return;
    const rect = el.getBoundingClientRect();
    dragRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    const move = (ev) => {
      const d = dragRef.current;
      if (!d) return;
      setPos({
        left: Math.max(4, Math.min(globalThis.innerWidth - 80, ev.clientX - d.dx)),
        top: Math.max(4, Math.min(globalThis.innerHeight - 40, ev.clientY - d.dy)),
      });
    };
    const up = () => {
      dragRef.current = null;
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      setPos((p) => { try { globalThis.localStorage?.setItem('sp.dpsMeter.pos', JSON.stringify(p)); } catch { /* ignore */ } return p; });
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  };

  const heal = rows.some(showHeal) || history.some((h) => h.rows.some(showHeal));
  const style = pos.left != null ? `left:${pos.left}px;top:${pos.top}px` : `right:${pos.right}px;bottom:${pos.bottom}px`;
  return html`<section class=${cx('dpsm', hidden && 'is-hidden')} style=${style} data-testid="dps-meter">
    <header class="dpsm-head" onPointerDown=${startDrag}>
      <span class="dpsm-title">${api.t('战斗统计')}</span>
      <div class="dpsm-scope" role="tablist" aria-label=${api.t('统计范围')}>
        <button type="button" role="tab" class=${cx(scope === 'field' && 'is-on')} onClick=${() => setScope('field')}>${api.t('当前战场')}</button>
        <button type="button" role="tab" class=${cx(scope === 'all' && 'is-on')} onClick=${() => setScope('all')}>${api.t('全部战场')}</button>
      </div>
      ${heal ? html`<label class="dpsm-healbox" title=${api.t('治疗')}><input type="checkbox" checked disabled />${api.t('治疗')}</label>` : null}
      <button type="button" class="dpsm-x" title=${api.t('关闭')} onClick=${onClose}>×</button>
    </header>
    <div class="dpsm-legend">
      <span class="dpsm-legend__labels">
        <span>${api.t('近 10 秒')}</span><span class="dpsm-sep">/</span><span>${api.t('总体')}</span>
        <span class="dpsm-dmg-label" title=${api.t('总伤害')}>${api.t('总伤')}</span>
        ${heal ? html`<span class="dpsm-heal" title=${api.t('治疗')}>${api.t('治疗')}</span>` : null}
      </span>
    </div>
    ${rows.length
      ? html`<ul class="dpsm-list">${rows.slice(0, 20).map((r) => html`<${Row} key=${`${r.field}|${r.key}`} r=${r} t=${api.t} heal=${heal} />`)}</ul>`
      : html`<p class="dpsm-empty">${hint || api.t('本场还没有伤害数据')}</p>`}
    ${history.length ? html`<div class="dpsm-hist">
      <div class="dpsm-hist__title">${api.t('历史回合')}<span class="dpsm-hist__n">${history.length}</span></div>
      ${history.map((h, i) => html`<div class="dpsm-round" key=${h.at}>
        <button type="button" class="dpsm-round__head" aria-expanded=${openRound === i ? 'true' : 'false'}
          onClick=${() => setOpenRound((v) => (v === i ? -1 : i))}>
          <span class="dpsm-round__caret">${openRound === i ? '▾' : '▸'}</span>
          <span class="dpsm-round__label">${h.label}</span>
          <span class="dpsm-round__sum">${sumLine(h.rows, heal)}</span>
        </button>
        ${openRound === i ? html`<ul class="dpsm-list dpsm-list--round">
          ${h.rows.map((r) => html`<${Row} key=${`${h.at}|${r.key}`} r=${r} t=${api.t} heal=${heal} />`)}
        </ul>` : null}
      </div>`)}
    </div>` : null}
  </section>`;
}

/** 一行的摘要（折叠状态下显示）：人头数 + 总伤害/总治疗。 */
function sumLine(rows, heal) {
  let dmg = 0; let hp = 0;
  for (const r of rows) { dmg += r.dmg || 0; hp += r.heal || 0; }
  return `${rows.length} 人 · ${fmt(dmg)}${heal ? ` · +${fmt(hp)}` : ''}`;
}

/** 游戏自己的回合号（`m.public.round`）；读不到就 null（那时退回自增序号）。 */
function gameRound(api) {
  try {
    const pub = api.store?.get?.()?.match?.public;
    const r = pub && pub.round;
    return Number.isFinite(r) && r > 0 ? Math.trunc(r) : null;
  } catch { return null; }
}

/** The Toggle: a small 开关 button, shown only while a battle is on screen; the choice and position are remembered. */
function Toggle({ api }) {
  const [open, setOpen] = useState(() => {
    try { return globalThis.localStorage?.getItem('sp.dpsMeter.open') === '1'; } catch { return false; }
  });
  const [live, setLive] = useState(false);
  const [hint, setHint] = useState('');
  const [btnPos, setBtnPos] = useState(() => {
    try { return JSON.parse(globalThis.localStorage?.getItem('sp.dpsMeter.btn.pos') || 'null') || { left: 14, bottom: 106 }; } catch { return { left: 14, bottom: 106 }; }
  });

  // 自己轮询判断「屏幕上有没有战斗」——不依赖 field 事件（它只在变化时发，首次可能永远轮不到），
  // 这是这个按钮之前完全不出现的根因。
  useEffect(() => {
    const probe = () => {
      const runner = api.runner;
      if (!runner) { setHint('runner 未就绪'); setLive(false); return; }
      if (typeof runner.fieldUnits !== 'function') { setHint('runner 没有 fieldUnits（旧版本？）'); setLive(false); return; }
      let on = false;
      try { const d = runner.fieldUnits(); on = !!(d && Array.isArray(d.units) && d.units.length); } catch { /* 旧版本 runner：当作没在战斗 */ }
      setHint(on ? '' : '当前没有战斗');
      setLive(on);
    };
    probe();
    const timer = setInterval(probe, 500);
    return () => clearInterval(timer);
  }, []);

  /**
   * 新一局开始 → 清空窗口里的记录。
   *
   * 判定用 `dps-core.matchActive()`（与 ui/stats.js 的 observeMatch 同一规则）的 **false → true 跳变**，
   * 也就是「进入对局」那一刻（准备阶段/机变之前）：给 DpsPanel 换一个 key 让它重新挂载，
   * 面板内的 history / rows / 采样 / 回合状态随之重置。
   *
   * 这个插件不落盘，所以没有别的要清 —— 每局的存档是 plugins/match-charts 自己的事。
   */
  const [gen, setGen] = useState(0);
  useEffect(() => {
    const store = api.store;
    if (!store || typeof store.subscribe !== 'function' || typeof store.get !== 'function') return undefined;
    let was = matchActive(store.get());
    return store.subscribe((s) => {
      const now = matchActive(s);
      if (now === was) return;
      was = now;
      if (!now) return; // 对局结束 / 回大厅：先不动，等下一局开始时再清
      setGen((g) => g + 1);
      if (globalThis.__SP_DEBUG_PLUGINS__) console.info('[plugin:dps-meter] 新一局开始 → 清空窗口记录');
    });
  }, []);

  useEffect(() => {
    if (globalThis.__SP_DEBUG_PLUGINS__) console.info('[plugin:dps-meter] toggle', { live, open, hint, gen, pos: btnPos });
  }, [live, open, hint, gen, btnPos]);

  // 面板不会随战斗结束自动关闭：玩家点开就一直留着，随时可以看上一场的数字、也可以自己关（需求方指定）

  const toggle = () => setOpen((v) => {
    const next = !v;
    try { globalThis.localStorage?.setItem('sp.dpsMeter.open', next ? '1' : '0'); } catch { /* ignore */ }
    if (globalThis.__SP_DEBUG_PLUGINS__) console.info('[plugin:dps-meter] 面板', next ? '打开' : '关闭');
    return next;
  });

  // 按钮也能拖：拖动结束（超过 4px）不当作点击，避免拖完手一松就把面板开了
  const startBtnDrag = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const from = { x: e.clientX, y: e.clientY };
    const drag = { dx: from.x - rect.left, dy: from.y - rect.top, moved: false };
    const move = (ev) => {
      if (!drag.moved && Math.abs(ev.clientX - from.x) + Math.abs(ev.clientY - from.y) < 4) return;
      drag.moved = true;
      setBtnPos({
        left: Math.max(4, Math.min(globalThis.innerWidth - 40, ev.clientX - drag.dx)),
        top: Math.max(4, Math.min(globalThis.innerHeight - 30, ev.clientY - drag.dy)),
      });
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      if (!drag.moved) { toggle(); return; }
      setBtnPos((p) => {
        try { globalThis.localStorage?.setItem('sp.dpsMeter.btn.pos', JSON.stringify(p)); } catch { /* ignore */ }
        return p;
      });
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  };

  // 战斗中才出现在战斗界面之外不打扰玩家；但只要面板是打开的（或 runner 存在）就保留按钮，
  // 这样「按钮不出现」永远能通过点击进一步排查，而不是只有沉默。
  if (!live && !open && !api.runner) return null;
  const btnStyle = btnPos.left != null ? `left:${btnPos.left}px;top:${btnPos.top}px` : `left:${btnPos.left ?? 14}px;bottom:${btnPos.bottom ?? 106}px`;
  return html`<${Fragment}>
    <button type="button" class=${cx('dpsm-toggle', open && 'is-on', live && 'is-live')} title=${api.t('战斗统计')}
      style=${btnStyle} onPointerDown=${startBtnDrag}>
      <span class="dpsm-toggle__icon">DPS</span>
    </button>
    ${/* 面板常驻挂载、只用 CSS 隐藏：关窗再打开时 history / 采样 / 回合状态都还在，
         否则组件被卸载就会把这一局已经攒下的统计丢掉（用户报的 bug）。 */ ''}
    <${DpsPanel} key=${gen} api=${api} onClose=${toggle} hint=${hint} hidden=${!open} />
  <//>`;
}

/** 插件入口：装一个开关按钮，点开就是悬浮窗。 */
export default function register(api) {
  api.loadCss();
  api.i18n().catch(() => {}); // 自带文案（i18n/<语言>.json）；缺文件就用中文原文
  const host = api.mount(html`<${Toggle} api=${api} />`);
  if (globalThis.__SP_DEBUG_PLUGINS__) console.info('[plugin:dps-meter] 注册完成');
  return {
    dispose() {
      try { render(null, host); } catch { /* the loader removes it anyway */ }
    },
  };
}

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

/** 全部战场：同一 operator 的同一单位 uid 在四个战场里分别存在，合并为一行（队友的算在队友名下）。 */
function mergeFields(rows) {
  const byKey = new Map();
  for (const r of rows) {
    const key = `${r.defId}#${r.unitId == null ? r.name : r.unitId}`;
    const cur = byKey.get(key);
    if (!cur) { byKey.set(key, { ...r }); continue; }
    cur.dmg += r.dmg; cur.heal += r.heal; cur.attacks += r.attacks; cur.kills += r.kills;
    cur.dps += r.dps; cur.hps += r.hps; cur.recentDps += r.recentDps; cur.recentHps += r.recentHps;
    cur.share = Math.max(cur.share, r.share);
  }
  return [...byKey.values()];
}
