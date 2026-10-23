// public/js/ui/devGive.js — the dev-mode 调试 dialog (调试器第一档, SP_DEV=1): search any operator / any item / any
// 自选 (DIY, incl. 替补) operator and hand it to yourself through `g.devGive` (server/match/player/dev.js). The HUD's
// 调试 button (ui/hud.js, shown only while m.private.dev is true) opens it; 加入 sends one intent, the caller
// (screens/game.js) toasts the outcome.
// A row the server could not take (a 自选 operator with no legal slot or no kit) is listed GREYED with its reason: the
// dialog never sends what the server would refuse silently.
// The listing / search itself is pure and lives in ui/devGiveModel.js (test/ui/dev-give.test.js).
//
//   <DevGiveDialog open chess={data.get('chess')} items={data.get('items')} backups={data.get('backups')} busy
//     onGive(fields) onClose />
//
// Styles: css/screens/game.css (.devgive rows, next to .gtop__dev).

import { useMemo, useState } from '../../vendor/hooks.module.js';
import { html, Modal, Button, TextField, Tabs, TierChip, MicroLabel } from './components.js';
import { chessCatalog, itemCatalog, diyCatalog, filterCatalog, DEV_GIVE_ROWS } from './devGiveModel.js';
import { loadoutStore } from './loadoutSync.js';
import { t } from '../../../shared/i18n.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');

/** The row's second line: the operator / item's own short description. */
function rowSub(e) {
  if (e.kind !== 'diy') return e.sub || e.id;
  const parts = [e.sub, e.rarity ? t('{n}★', { n: e.rarity }) : '', e.proto ? t('原型 / 替补') : t('已持有')];
  if (e.tiers.length) parts.push(t('{tiers}阶自选', { tiers: e.tiers.join(' / ') }));
  return parts.filter(Boolean).join(' · ') || e.id;
}

/**
 * @param {{ open?: boolean, chess?: any, items?: any, backups?: any, busy?: boolean,
 *   onGive?: (fields: { kind: 'chess'|'item'|'diy', id: string }) => void, onClose?: () => void }} props
 */
export function DevGiveDialog({ open = false, chess = null, items = null, backups = null, busy = false, onGive, onClose }) {
  const [kind, setKind] = useState('chess');
  const [query, setQuery] = useState('');
  // the operators a 自选 slot may field (welcome.diyKitted, kept by ui/loadoutSync.js); null while unknown = no gate
  const kitted = loadoutStore.get().diyKitted || null;
  const catalog = useMemo(() => {
    if (kind === 'chess') return chessCatalog(chess);
    if (kind === 'item') return itemCatalog(items);
    return diyCatalog({ chess, backups }, { kitted });
  }, [kind, chess, items, backups, kitted]);
  const rows = useMemo(() => filterCatalog(catalog, query), [catalog, query]);
  if (!open) return null;
  const shown = rows.slice(0, DEV_GIVE_ROWS);
  const tabs = [{ id: 'chess', label: t('干员') }, { id: 'item', label: t('装备') }, { id: 'diy', label: t('自选 / 替补') }];
  return html`<${Modal} open=${true} tone="mint" class=${cx('devgive')} width="min(6.6rem, 94vw)" micro="DEBUGGER · GIVE · DEV"
      title=${t('调试：任意干员 / 装备')} onClose=${onClose}
      actions=${html`<${Button} variant="secondary" icon="close" onClick=${onClose}>${t('关闭')}<//>`}>
    <div class="devgive__head">
      <${Tabs} items=${tabs} value=${kind} onChange=${(k) => { setKind(k); setQuery(''); }} />
      <${TextField} size="sm" icon="search" value=${query} placeholder=${t('搜索名称或 id')} class="devgive__search"
        onInput=${(v) => setQuery(String(v).slice(0, 32))} />
    </div>
    <p class="devgive__hint">${t('只在开发模式（SP_DEV=1）下可用：选中的干员 / 装备会直接加入你的整备区。')}</p>
    ${kind === 'diy' ? html`<p class="devgive__hint">${t('调试模式不受 4 个自选位限制：官方槽位用完后会新建调试槽位（同一干员仍复用已有槽位）。')}</p>` : null}
    <div class="devgive__count"><${MicroLabel}>${kind === 'chess' ? 'OPERATORS' : kind === 'item' ? 'ITEMS' : 'DIY / RESERVE'}<//>
      <span class="num">${rows.length}${rows.length > shown.length ? ` / ${DEV_GIVE_ROWS}` : ''}</span></div>
    ${shown.length ? html`<ul class="devgive__list">
      ${shown.map((e) => html`<li key=${`${e.kind}:${e.id}`} class=${cx('devgive__row', e.ok === false && 'is-off')}>
        ${e.tier ? html`<${TierChip} tier=${e.tier} size="sm" />` : null}
        <span class="devgive__text">
          <b class="devgive__name">${e.name}</b>
          <span class="devgive__sub">${rowSub(e)}</span>
        </span>
        ${e.ok === false
          ? html`<span class="devgive__reason" title=${e.reason ? t(e.reason) : ''}>${e.reason ? t(e.reason) : t('不可加入')}</span>`
          : html`<${Button} size="sm" variant="primary" disabled=${busy} onClick=${() => onGive?.({ kind: e.kind, id: e.id })}>${t('加入')}<//>`}
      </li>`)}
    </ul>` : html`<p class="devgive__empty">${t('没有匹配的条目')}</p>`}
  <//>`;
}
