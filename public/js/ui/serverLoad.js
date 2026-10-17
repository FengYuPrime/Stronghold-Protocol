// public/js/ui/serverLoad.js — how full the server's matches are («对局 12/20 人»), the client side of the
// match-player limit (server/lobby.js Lobby.matchStats, n env SP_MAX_MATCH_PLAYERS).
//
// The server sends the numbers with the frames it already broadcasts — `welcome.stats` and `room.state.stats`
// { matchPlayers, matchOwners, matchPlayerLimit } (main.js keeps the latest in store.stats) — so nothing here polls.
//   * matchPlayers: the humans inside running matches (bots and spectator seats are none, a room still in its lobby is
//     none — server/lobby.js matchLoad);
//   * matchOwners: the server owner's own seats (SP_OWNER_TOKEN), counted apart: they take no room under the limit, so
//     they are shown beside it («12+1/20»);
//   * matchPlayerLimit: the cap; 0 = no limit — then the denominator is left out («对局 12 人») rather than shown as
//     /0, which would read as a full server.
// Texts go through t() (docs/I18N.md), four packs: '对局 {players}/{max} 人', '对局 {players} 人' and the tooltip.

import { h } from '../../vendor/preact.module.js';
import htm from '../../vendor/htm.module.js';
import { t } from '../../../shared/i18n.js';

// no shared static vnodes (see components.js hFresh: htm's static cache would retain unmounted DOM)
function hFresh(type, props, ...children) {
  if (this && typeof this === 'object') this[0] = 3;
  return h(type, props, ...children);
}
const html = htm.bind(hFresh);

/** A whole number ≥ 0 out of a stats field (anything else is 0). */
const count = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : 0);
const cx = (...a) => a.filter(Boolean).join(' ');

/**
 * The numbers of a `stats` object (`welcome.stats` / `room.state.stats`), normalised — null when there are none (an
 * older server, or the first frame before any welcome). A limit of 0 (or a missing one) means no limit.
 * @param {any} stats
 * @returns {{ players: number, owners: number, limit: number, full: boolean } | null}
 */
export function serverLoad(stats) {
  if (!stats || typeof stats !== 'object') return null;
  if (!('matchPlayers' in stats) && !('matchPlayerLimit' in stats)) return null;
  const players = count(stats.matchPlayers);
  const owners = count(stats.matchOwners);
  const limit = count(stats.matchPlayerLimit);
  return { players, owners, limit, full: limit > 0 && players >= limit };
}

/**
 * The display text: 「对局 12/20 人」, 「对局 12+1/20 人」 for a server owner in a match (shown apart: it is not counted
 * against the limit), and 「对局 12 人」 when the server has no limit (0): a `/0` denominator would read as full.
 * @param {any} stats a `stats` object, or what serverLoad() returns
 * @returns {string} '' when there is nothing to show
 */
export function serverLoadText(stats) {
  const s = stats && 'players' in stats && 'limit' in stats ? stats : serverLoad(stats);
  if (!s) return '';
  const players = s.owners > 0 ? `${s.players}+${s.owners}` : String(s.players);
  return s.limit > 0 ? t('对局 {players}/{max} 人', { players, max: s.limit }) : t('对局 {players} 人', { players });
}

/**
 * The pill: 「对局 12/20 人」 — the hall, a room's top bar, and the match's HUD corner.
 * @param {{ stats?: any, class?: string }} props `stats`: store.stats (welcome / room.state); nothing to show → null
 */
export function ServerLoad({ stats = null, class: cls }) {
  const text = serverLoadText(stats);
  if (!text) return null;
  const s = serverLoad(stats);
  const tip = t('同时在对局中的博士人数（服主不计入）');
  return html`<span class=${cx('server-load', s.full && 'server-load--full', cls)} title=${tip} data-testid="server-load">
    <span class="server-load__dot" aria-hidden="true"></span>
    <span class="server-load__text num">${text}</span>
  </span>`;
}
