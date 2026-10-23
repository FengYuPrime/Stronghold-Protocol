// public/js/ui/devGiveModel.js — the pure data helpers of the 调试 dialog (ui/devGive.js, dev mode only, SP_DEV=1):
// what the panel lists (every chess / item / 自选 (DIY) operator the `g.devGive` intent accepts) and how its search
// filters that list. No DOM / Preact imports — test/ui/dev-give.test.js exercises these directly, and the shapes are
// exactly the `g.devGive { kind, id }` fields (shared/protocol.js; the server re-checks every id in
// server/match/player/dev.js).
//
// Three sources:
//   chess — data/chess.json's normal records (the intent's `kind: 'chess'`);
//   item  — data/items.json's normal records (`kind: 'item'`);
//   diy   — data/backups.json `diy.operators` (the owned 6★ pool and the 原型 / 替补 picks), which have no chess id of
//           their own: the server fields one through a 自选编队 slot (kind: 'diy', id = charId, player/dev.js
//           devGiveDiy) and REPLACES that slot's pick when all four are taken (announced by an m.toast). A row is `ok`
//           when a 自选 slot accepts the pick the server would default to (shared/diy.js checkDiyPick) and — when the
//           kit list is known — the operator has a kit; otherwise it is listed GREYED with the reason that is exactly
//           the server's refusal (ERR.DEV_NO_SLOT / ERR.DEV_NO_KIT), never silently dropped.

import { diySlot, diySlotIds, isPrototypePick, checkDiyPick } from '../../../shared/diy.js';
import { N_ } from '../../../shared/i18n.js';
import { defaultPick } from './diyModel.js';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * How many rows the dialog shows at once. It must cover every source (the whole chess roster is ~129 rows, items ~140,
 * 自选/替补 ~87): a smaller cap silently hid tier 5–6 behind the first 80 rows.
 */
export const DEV_GIVE_ROWS = 400;

/** Why a 自选 row cannot be given (shown on the greyed row; msgids, translated by the dialog). */
export const DEV_DIY_NO_FORM = N_('数据里没有可作为棋子的形态');
export const DEV_DIY_NO_KIT = N_('尚未实装技能组（kit）');

/** tier, then name, then id — the shop's order for chess, a stable one for items. */
const byTierThenName = (a, b) => (a.tier ?? 99) - (b.tier ?? 99)
  || String(a.name).localeCompare(String(b.name)) || String(a.id).localeCompare(String(b.id));

/**
 * The chess entries of the panel: every normal chess the intent can hand out — the visible roster and the hidden
 * twins alike (server/match/player/dev.js takes any `gd.chess(id)`), one row per operator. Elite records are left out
 * (the ordinary merge produces them, and a debugger usually wants to try the operator itself); a 自选 slot has no
 * body until its player picks one, so it is left out too.
 * @param {Record<string, any>|null|undefined} chess data/chess.json (the raw map)
 * @returns {Array<{ kind: 'chess', id: string, name: string, tier: number|null, golden: false, charId: string|null, sub: string }>}
 */
export function chessCatalog(chess) {
  const out = [];
  for (const c of Object.values(isObj(chess) ? chess : {})) {
    if (!isObj(c) || typeof c.chessId !== 'string' || !c.chessId) continue;
    if (c.isGolden || c.isDiy) continue;
    // a record that points at another chess (an alias row of a hidden twin) is not its own id
    if (typeof c.baseId === 'string' && c.baseId && c.baseId !== c.chessId) continue;
    out.push({
      kind: 'chess',
      id: c.chessId,
      name: String(c.name || c.chessId),
      tier: Number.isInteger(c.tier) ? c.tier : null,
      golden: false,
      charId: typeof c.charId === 'string' ? c.charId : null,
      sub: [c.appellation, c.subProfessionName].filter((x) => typeof x === 'string' && x).join(' · '),
    });
  }
  return out.sort(byTierThenName);
}

/**
 * The item entries of the panel: every normal item (装备 and 法术 — both are given and used the same way; the elite
 * copies come from the ordinary merge). `sub` is the short effect line the row shows.
 * @param {Record<string, any>|null|undefined} items data/items.json (the raw map)
 * @returns {Array<{ kind: 'item', id: string, name: string, tier: number|null, golden: false, sub: string }>}
 */
export function itemCatalog(items) {
  const out = [];
  for (const it of Object.values(isObj(items) ? items : {})) {
    if (!isObj(it) || typeof it.id !== 'string' || !it.id || it.isGolden) continue;
    if (typeof it.baseId === 'string' && it.baseId && it.baseId !== it.id) continue;
    out.push({
      kind: 'item',
      id: it.id,
      name: String(it.name || it.id),
      tier: Number.isInteger(it.tier) ? it.tier : null,
      golden: false,
      sub: typeof it.desc === 'string' ? it.desc : (typeof it.effectName === 'string' ? it.effectName : ''),
    });
  }
  return out.sort(byTierThenName);
}

/**
 * The 自选 / 替补 rows of the panel: every operator of data/backups.json `diy.operators` (the owned 6★ pool and the
 * 原型 / 替补 prototypes), with the 自选 tiers a slot accepts it at and whether the server could slot it now.
 * Availability is the server's own rule, run here on pure data: `shared/diy.js checkDiyPick` on the pick the 自选
 * picker starts with (`defaultPick`: a prototype's locked skill / module, an owned operator's last skill + first
 * module). `kitted` (welcome.diyKitted, or the room content set's list) marks the operators without a kit — the same
 * gate `setDiy` applies; without it the kit gate is skipped (the server still refuses, with a detail).
 * @param {{ chess?: Record<string, any>|null, backups?: any }|null|undefined} data data/chess.json + data/backups.json
 * @param {{ kitted?: Iterable<string>|null }} [opts]
 * @returns {Array<{ kind: 'diy', id: string, charId: string, name: string, tier: number|null, tiers: number[],
 *   rarity: number|null, proto: boolean, ok: boolean, reason: string|null, sub: string }>}
 */
export function diyCatalog(data, { kitted = null } = {}) {
  const backups = isObj(data?.backups) ? data.backups : null;
  const ops = isObj(backups?.diy?.operators) ? backups.diy.operators : null;
  if (!ops) return [];
  const kit = kitted == null ? null : new Set(kitted);
  const slots = diySlotIds(data);
  const out = [];
  for (const charId of Object.keys(ops)) {
    const unit = isObj(backups.units?.[charId]) ? backups.units[charId] : null;
    const tiers = [];
    for (const slotId of slots) {
      const slot = diySlot(slotId, data);
      if (!slot) continue;
      const proto = isPrototypePick(data, slot.tier, charId);
      if (!proto && !(Array.isArray(backups.diy.ownedPool) && backups.diy.ownedPool.includes(charId))) continue;
      const res = checkDiyPick(slotId, defaultPick(charId, slotId, data), data);
      if (!res || !('ok' in res)) continue;
      if (!tiers.includes(slot.tier)) tiers.push(slot.tier);
    }
    tiers.sort((a, b) => a - b);
    const proto = tiers.some((tier) => isPrototypePick(data, tier, charId));
    let reason = null;
    if (!tiers.length) reason = DEV_DIY_NO_FORM;
    else if (kit && !kit.has(charId)) reason = DEV_DIY_NO_KIT;
    out.push({
      kind: 'diy',
      id: charId,
      charId,
      name: String(unit?.name || charId),
      // the row's tier chip: the highest slot tier the operator may fill (tier 6 first in the server's default too)
      tier: tiers.length ? tiers[tiers.length - 1] : null,
      tiers,
      rarity: Number.isInteger(unit?.rarity) ? unit.rarity : null,
      proto,
      ok: reason == null,
      reason,
      sub: [unit?.appellation, unit?.subProfessionName].filter((x) => typeof x === 'string' && x).join(' · '),
    });
  }
  // the givable ones first, then the rarest / the prototypes — a debugger's shortlist
  return out.sort((a, b) => Number(b.ok) - Number(a.ok) || Number(b.proto) - Number(a.proto)
    || (b.rarity ?? 0) - (a.rarity ?? 0) || String(a.name).localeCompare(String(b.name)));
}

/**
 * The rows the search keeps: case-insensitive on the name, the id and the short line (for chess also the operator's
 * title / subclass; for 自选 / 替补 also the rarity / tier). An empty query keeps everything.
 * @param {Array<{ name: string, id: string, sub?: string, tier?: number|null }>} entries
 * @param {string|null|undefined} query
 */
export function filterCatalog(entries, query) {
  const list = Array.isArray(entries) ? entries : [];
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return list;
  return list.filter((e) => `${e.name} ${e.id} ${e.sub || ''} ${e.tier ?? ''} ${e.rarity ?? ''} ${(e.tiers || []).join(' ')}`
    .toLowerCase().includes(q));
}

/**
 * The `g.devGive` fields of a picked row (what the dialog sends): a greyed row (`ok === false`) sends nothing.
 * @param {{ kind?: string, id?: string, ok?: boolean }|null|undefined} entry
 * @returns {{ kind: 'chess'|'item'|'diy', id: string }|null}
 */
export function devGiveFields(entry) {
  if (!isObj(entry) || typeof entry.id !== 'string' || !entry.id) return null;
  if (entry.kind !== 'chess' && entry.kind !== 'item' && entry.kind !== 'diy') return null;
  if (entry.ok === false) return null;
  return { kind: entry.kind, id: entry.id };
}
