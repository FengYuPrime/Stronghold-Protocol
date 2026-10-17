// 战斗统计插件的「结算页统计弹窗」（plugins/match-charts，见 plugins/README.md）。
//
// 这里做两件事：
//   1. 记录每一局：监听核心派发的 `sp:match-record` 事件（ui/stats.js 的记录落库点），把本插件攒下的
//      每回合序列按同一个 record.id 存进 `sp.charts.log`；
//   2. 展示：在结算页「模拟完成」标题旁插一个按钮，点开是**白底黑字**的弹窗 —— 下拉框选回合，
//      选中的那一回合画一张**占比饼图**（该回合各单位的输出占比，可切总伤 / 总治疗）。
//
// 数据只认「当前收录的这场战斗」：拿不到它的存档就显示空状态，**绝不**回退到上一局（用户明确要求）。
//
// 图表用 ECharts（用户指定；`npm install && npm run vendor` 把它放到 /vendor/echarts.module.js，
// 用**动态** import 引入，所以没装时插件其余部分照常工作，只在图表位置显示一句提示）。
// 完全自包含：核心代码只多派发了一个事件（外加结算容器上的 data-record），删掉插件文件夹这一栏就不存在。

import { render } from '/vendor/preact.module.js';
import { useEffect, useMemo, useRef, useState } from '/vendor/hooks.module.js';
import { html } from '/js/ui/components.js';
import { matchLog, saveMatch, readMatch, fmtInt, roundPie, pieOption } from './charts-core.js';


/** 记录落库事件（ui/stats.js recordResult 成功保存后派发；detail = 存下来的那条记录）。 */
export const RECORD_EVENT = 'sp:match-record';

/** 结算详情里的数字同样只显示整数（与悬浮窗一致，fmtInt 在 charts-core 有单测）。 */
const fmt = fmtInt;

/** 已加载的 ECharts：undefined = 还没试过，null = 试过但没有（未安装 / 未 vendor）。 */
let echartsLib;

/**
 * 取 ECharts（`npm install && npm run vendor` 会把它放到 /vendor/echarts.module.js）。
 *
 * 用**动态** import：没装时插件其余部分照常工作，只有图表位置显示一句提示 —— 静态 import 会让整个插件加载失败。
 */
export async function loadEcharts() {
  if (echartsLib !== undefined) return echartsLib;
  try {
    const mod = await import('/vendor/echarts.module.js');
    echartsLib = mod && typeof mod.init === 'function' ? mod : (mod?.default && typeof mod.default.init === 'function' ? mod.default : null);
  } catch { echartsLib = null; }
  if (!echartsLib) console.warn('[plugin:match-charts] /vendor/echarts.module.js not found — run `npm install && npm run vendor` in the repo root');
  return echartsLib;
}

/**
 * ECharts 容器：初始化一次 → 数据变化 `setOption` → 卸载时 `dispose`；跟随容器尺寸自动 resize。
 * `option` 由调用方算好（纯函数在 charts-core 里，可单测）。
 * @param {{ option: any, api: any }} props
 */
function EChartView({ option, api }) {
  const boxRef = useRef(null);
  const chartRef = useRef(null);
  const [state, setState] = useState('loading');   // loading | ready | missing

  useEffect(() => {
    let alive = true;
    let ro = null;
    (async () => {
      const lib = await loadEcharts();
      if (!alive) return;
      if (!lib || !boxRef.current) { setState('missing'); return; }
      chartRef.current = lib.init(boxRef.current);
      chartRef.current.setOption(option, true);
      setState('ready');
      if (globalThis.ResizeObserver && boxRef.current) {
        ro = new ResizeObserver(() => { try { chartRef.current?.resize?.(); } catch { /* disposed */ } });
        ro.observe(boxRef.current);
      }
    })();
    return () => {
      alive = false;
      try { ro?.disconnect?.(); } catch { /* ignore */ }
      try { chartRef.current?.dispose?.(); } catch { /* ignore */ }
      chartRef.current = null;
    };
  }, []);   // 只初始化一次；数据变化走下面的 setOption

  useEffect(() => {
    if (state !== 'ready') return;
    try { chartRef.current?.setOption?.(option, true); } catch { /* ignore */ }
  }, [option, state]);

  if (state === 'missing') {
    return html`<p class="dpsm-modal__note">${api.t('图表库未安装：在仓库根目录运行 npm install && npm run vendor，然后重启')}</p>`;
  }
  return html`<div class="dpsm-echart" ref=${boxRef}></div>`;
}

/**
 * 白底黑字的弹窗：标题栏 + 口径切换 + **回合下拉框** + 该回合各单位的**占比饼图**。
 *
 * 选中哪一回合就只画那一回合；**默认选中当前收录这场战斗的最后一回合**（`rounds.length - 1`）。
 * 没有这场战斗的存档 / 这一回合没有任何单位输出 → 只显示空状态，**绝不**拿上一局的数据顶上。
 * @param {{ recordId: string|null, entry: any|null, api: any, onClose: () => void }} props
 */
export function MatchChartModal({ recordId, entry = null, api, onClose }) {
  const t = api.t;
  const [metric, setMetric] = useState('dmg');   // 'dmg' 总伤 | 'heal' 总治疗
  const rounds = useMemo(() => (Array.isArray(entry && entry.rounds) ? entry.rounds : []), [entry]);
  // 默认选「最后一回合」（需求方指定）；弹窗每次打开都是新挂载，初始化一次就够
  const [pick, setPick] = useState(() => Math.max(0, rounds.length - 1));
  const pie = useMemo(() => roundPie(entry, pick, metric), [entry, pick, metric]);
  const hasHeal = useMemo(() => rounds.some((r) => (Array.isArray(r && r.units) ? r.units : [])
    .some((u) => (Number(u && u.heal) || 0) > 0)), [rounds]);
  const axisName = metric === 'heal' ? t('总治疗') : t('总伤');
  const option = useMemo(() => pieOption({ slices: pie.slices, round: pie.round, axisName, t }), [pie, axisName, t]);
  const hasData = rounds.length > 0 && pie.slices.length > 0;
  const roundLabel = pie.round == null ? '—' : pie.round;
  // 存档时间（HH:MM）：一眼看出这是哪一局
  const at = Number(entry && entry.at) || 0;
  const hhmm = at ? `${String(new Date(at).getHours()).padStart(2, '0')}:${String(new Date(at).getMinutes()).padStart(2, '0')}` : '';
  return html`<div class="dpsm-modal" role="dialog" aria-modal="true" aria-label=${t('战斗统计')} onClick=${onClose}>
    <div class="dpsm-modal__box" data-record=${recordId || ''} onClick=${(e) => e.stopPropagation()}>
      <header class="dpsm-modal__head">
        <h2 class="dpsm-modal__title">${t('每回合战斗统计')}</h2>
        <div class="dpsm-modal__tabs" role="tablist" aria-label=${t('统计口径')}>
          <button type="button" role="tab" aria-selected=${metric === 'dmg' ? 'true' : 'false'}
            class=${metric === 'dmg' ? 'is-on' : ''} onClick=${() => setMetric('dmg')}>${t('总伤')}</button>
          ${hasHeal ? html`<button type="button" role="tab" aria-selected=${metric === 'heal' ? 'true' : 'false'}
            class=${metric === 'heal' ? 'is-on' : ''} onClick=${() => setMetric('heal')}>${t('总治疗')}</button>` : null}
        </div>
        ${rounds.length ? html`<label class="dpsm-modal__pick">
          <span class="dpsm-modal__pick-label">${t('选择回合')}</span>
          <select class="dpsm-modal__select" value=${String(pick)}
            onChange=${(e) => setPick(Number(e.currentTarget.value) || 0)}>
            ${rounds.map((r, i) => html`<option value=${String(i)}>${t('第 {n} 回合', { n: r && Number.isFinite(r.n) ? r.n : i + 1 })}</option>`)}
          </select>
        </label>` : null}
        ${hasData ? html`<span class="dpsm-modal__sum">${t('第 {n} 回合', { n: roundLabel })} · ${axisName} ${fmt(pie.total)}${hhmm ? ` · ${hhmm}` : ''}</span>` : null}
        <button type="button" class="dpsm-modal__x" title=${t('关闭')} aria-label=${t('关闭')} onClick=${onClose}>×</button>
      </header>
      ${!hasData
        ? html`<div class="dpsm-modal__empty">
            <p class="dpsm-modal__emptyline">${t('没有这场战斗的数据')}</p>
          </div>`
        : html`<div class="dpsm-modal__body">
            <${EChartView} option=${option} api=${api} />
            <p class="dpsm-modal__note">${t('该回合各单位的{v}占比；鼠标移到扇区可看数值', { v: axisName })}</p>
          </div>`}
    </div>
  </div>`;
}




/** 最近一次落库的记录 id（结算页是「刚打完这一局」时用它）。 */
let lastRecordId = null;

/**
 * 该展示哪一局：回看某条记录时容器上带 `data-record`，否则就是刚打完的那一局。
 * @returns {string|null}
 */
function currentRecordId() {
  try {
    const replay = document.querySelector('.st--replay[data-record]');
    const id = replay && replay.getAttribute('data-record');
    if (id) return id;
  } catch { /* no DOM */ }
  return lastRecordId;
}

/**
 * 取要画的那一局：**只按编号找**，找不到就是没数据。
 *
 * 以前这里在编号对不上时退回「最近存档的一局」并在弹窗里挂一条黄色警告条；用户明确要求去掉 ——
 * 结算页刚打完的这一局还没存档时，宁可显示空状态，也不能把上一局的数据当成这一局给他看。
 * @returns {{ id: string|null, entry: any|null }}
 */
export function resolveMatch(id = currentRecordId()) {
  return { id: id || null, entry: readMatch(id) || null };
}

/**
 * 哪些标题还需要插按钮 —— 纯函数，便于单测。
 *
 * 这里曾经出过一个真 bug：标记打在按钮上、判断却看标题（`h.dataset.dpsmBtn`），于是标题永远算「没插过」，
 * 每帧又插一个按钮。现在**由这个函数统一在标题上打标记**，一次调用只会返回需要新建的下标。
 * @param {{ dataset: any, nextElementSibling?: { className?: string }|null }[]} heads
 * @returns {number[]} 需要新建按钮的标题下标
 */
export function headingsNeedingButton(heads) {
  const out = [];
  const list = Array.isArray(heads) ? heads : [];
  list.forEach((h, i) => {
    if (!h || !h.dataset) return;
    if (h.dataset.dpsmBtn === '1') return;                       // 已经插过
    const sib = h.nextElementSibling;
    const cls = sib && typeof sib.className === 'string' ? sib.className.split(/\s+/) : [];
    h.dataset.dpsmBtn = '1';                                     // 标记：无论下面插不插，都只处理一次
    if (cls.includes('dpsm-open')) return;                       // 按钮已经在那里（例如插件重载）
    out.push(i);
  });
  return out;
}

/**
 * 在「模拟完成 / 模拟失败」标题旁边放一个按钮，点开是白底黑字的统计弹窗。
 *
 * 为什么不再往结算页里插图表：那会把结算页的排版挤变形（用户反馈）。所以只插一个**按钮**（跟在
 * `h1.result__headline` 后面，不改变原布局），图表画在一个浮层弹窗里 —— 弹窗是插件自己的，怎么排版都行。
 * 锚点是结果页自己的类名（结算页与「对局记录」回看用的是同一个 ResultView），找不到就什么都不做。
 * @returns {() => void} 卸载函数
 */
export function mountResultButton(api) {
  let timer = 0;
  let stop = false;
  let host = null;        // 弹窗的挂载点（挂在 body 上，避免被结算页的 overflow 裁掉）
  const buttons = new Set();

  const closeModal = () => {
    if (host) { try { render(null, host); } catch { /* ignore */ } host.remove(); host = null; }
    document.removeEventListener('keydown', onKey, true);
  };
  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); closeModal(); }
  }
  const openModal = () => {
    closeModal();
    const { id, entry } = resolveMatch();
    host = document.createElement('div');
    host.className = 'dpsm-modal-host';
    document.body.appendChild(host);
    render(html`<${MatchChartModal} recordId=${id} entry=${entry} api=${api} onClose=${closeModal} />`, host);
    document.addEventListener('keydown', onKey, true);
    // 排查「图表没更新」的第一手证据：打开的是哪一局、几回合、有没有拿到这一局的存档
    api.log?.(`chart opened: record ${id ?? '—'} · ${entry?.rounds?.length ?? 0} round(s)${entry ? '' : ' · no archive for this record (empty state, no fallback)'}`);
  };

  const paint = () => {
    if (stop) return;
    // 结算页的标题（结算与回看共用）：标题旁没有按钮就补一个。判定在 headingsNeedingButton 里（有单测）
    const heads = [...document.querySelectorAll('h1.result__headline')];
    for (const i of headingsNeedingButton(heads)) {
      const h = heads[i];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dpsm-open';
      btn.textContent = api.t('战斗统计');
      btn.title = api.t('查看每回合各单位的伤害占比');
      btn.addEventListener('click', () => openModal());
      h.insertAdjacentElement('afterend', btn);
      buttons.add(btn);
    }
    // 结算页关掉了：按钮与弹窗一起收走
    if (!heads.length) {
      for (const b of buttons) b.remove();
      buttons.clear();
      if (host) closeModal();
    }
  };

  paint();
  timer = setInterval(paint, 250);   // 每 250ms 看一眼即可（不再用 rAF：60fps 做 DOM 查询没必要）
  return () => {
    stop = true;
    clearInterval(timer);
    for (const b of buttons) b.remove();
    buttons.clear();
    closeModal();
  };
}

/**
 * 一局记录落库时（核心派发的 `sp:match-record`）把本插件的每回合存档按同一个 record.id 存下来。
 * @param {any} api @param {() => any[]} readHistory
 * @returns {() => void} 卸载函数
 */
export function createRecorder(api, readHistory) {
  const onRecord = (e) => {
    const rec = e && e.detail;
    if (!rec || typeof rec.id !== 'string') {
      api.warn?.('sp:match-record without a usable id — skipped', e && e.detail);
      return;
    }
    const entry = matchLog(readHistory() || [], { difficulty: rec.difficulty, roomMode: rec.roomMode, victory: rec.victory });
    lastRecordId = rec.id;   // 即使这一局没数据，也让按钮按这个编号去找（找不到会退回「最近一局」）
    if (!entry) {
      // 沉默失败最坑：明确报出来（这一局在弹窗里会显示空状态，不会退回去画别的对局）。
      api.warn?.(`no rounds to archive for ${rec.id} — the chart will show the empty state for this match`);
      return;
    }
    const ok = saveMatch(rec.id, entry);
    api.log?.(`match archived: ${rec.id} · ${entry.rounds.length} round(s) · damage ${entry.total.dmg} · healing ${entry.total.heal}${ok ? '' : ' — WRITE FAILED'}`);
  };
  globalThis.addEventListener?.(RECORD_EVENT, onRecord);
  return () => globalThis.removeEventListener?.(RECORD_EVENT, onRecord);
}
