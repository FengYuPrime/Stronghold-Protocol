// public/js/ui/devChess.js — 调试 (g.devGive, SP_DEV=1): the records of this player's dev-only 自选 slots, so the board,
// the bench cards and the detail card can draw an operator whose id is not in data/chess.json.
//
// Two sources, merged (the server's copy wins):
//   1. `priv.devChess` — the composed records the server puts in THIS player's private view only
//      (server/match/player/dev.js devChessRecords, player/views.js): authoritative, the same records its own rules use;
//   2. a local composition from `priv.diy[slotId]` (a dev slot's pick carries `slotId` = the official slot it borrows its
//      identity and pick rules from, shared/diy.js diyRecordOf's `checkSlotId`) — so a page that missed the private frame
//      (a reload / reconnect) still draws the operator.
// The result is installed with `data.setChessOverlay(map)` (public/js/data.js): `lookup('chess', id)` falls back to it,
// `get` / `list` / `getRaw` do not — nothing that lists the game data ever sees a dev slot. A formal match has no dev
// pick, so the overlay is null and every lookup behaves exactly as before.
//
// Pure (no DOM / Preact): test/ui/dev-give.test.js exercises it against the real data.

import { diyRecordOf } from '../../../shared/diy.js';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** The synthetic 自选 slot record a dev slot composes against (an official slot's identity under the dev ids). */
export function devChessIdentity(id, templateId, data) {
  if (typeof id !== 'string' || typeof templateId !== 'string' || !isObj(data?.chess)) return null;
  const elite = /_b$/.test(id);
  const tplId = elite ? templateId.replace(/_a$/, '_b') : templateId;
  const tpl = Object.hasOwn(data.chess, tplId) ? data.chess[tplId] : null;
  if (!isObj(tpl) || !tpl.isDiy) return null;
  return {
    ...tpl,
    chessId: id,
    baseId: id.replace(/_b$/, '_a'),
    goldenId: id.replace(/_a$/, '_b'),
    isGolden: elite,
    // the official slot the pick rules come from (shared/diy.js checkDiyPick) — nothing about that slot changes
    checkSlotId: tpl.chessId,
  };
}

/**
 * `{ [devId]: record }` for this player's dev-only 自选 slots (both forms), or null when it has none. `data` is the raw
 * game data (`{ chess, backups }`, i.e. `data.get('chess')` + `data.get('backups')`).
 * @param {Record<string, any>|null|undefined} devChess `m.private.devChess`
 * @param {{ diy?: any }|null|undefined} priv `m.private`
 * @param {{ chess?: any, backups?: any }|null|undefined} data
 * @returns {Record<string, any>|null}
 */
export function devChessOverlay(devChess, priv, data) {
  /** @type {Record<string, any>} */
  const out = {};
  if (isObj(devChess)) {
    for (const [id, rec] of Object.entries(devChess)) if (isObj(rec)) out[id] = rec;
  }
  const picks = isObj(priv?.diy) ? priv.diy : {};
  for (const [slotId, pick] of Object.entries(picks)) {
    if (!isObj(pick) || typeof pick.slotId !== 'string') continue;
    for (const id of [slotId, slotId.replace(/_a$/, '_b')]) {
      if (out[id]) continue;
      const identity = devChessIdentity(id, pick.slotId, data);
      let rec;
      try { rec = identity ? diyRecordOf(identity, pick, data) : null; } catch { rec = null; }
      if (rec) out[id] = rec;
    }
  }
  return Object.keys(out).length ? out : null;
}

/**
 * A short key of what the overlay is made of (the ids and the operators), for a React effect: the private view is a new
 * object on every push, the overlay's content is not.
 * @param {{ devChess?: any, diy?: any }|null|undefined} priv
 * @returns {string}
 */
export function devChessKey(priv) {
  const recs = isObj(priv?.devChess) ? Object.keys(priv.devChess) : [];
  const picks = isObj(priv?.diy)
    ? Object.entries(priv.diy).filter(([, p]) => isObj(p) && typeof p.slotId === 'string').map(([id, p]) => `${id}:${p.charId}:${p.skillIndex ?? ''}:${p.uniEquipId ?? ''}`)
    : [];
  return `${recs.join(',')}|${picks.join(',')}`;
}
