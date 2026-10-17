// public/js/ui/serverLoad.js — how full the server's matches are («对局 12/20 人») and, in a match, how many humans are
// online at all («在线 15 人 · 对局 12/20 人»): the client side of the match-player limit (server/lobby.js
// Lobby.matchStats, n env SP_MAX_MATCH_PLAYERS).
//
// The server sends the numbers with the frames it already broadcasts — `welcome.stats` and `room.state.stats`
// { matchPlayers, matchOwners, matchPlayerLimit, online } (main.js keeps the latest in store.stats) — so nothing here
// polls.
//   * matchPlayers: the humans inside running matches (bots and spectator seats are none, a room still in its lobby is
//     none — server/lobby.js matchLoad);
//   * matchOwners: the server owner's own seats (SP_OWNER_TOKEN), counted apart: they take no room under the limit, so
//     they are shown beside it («12+1/20»);
//   * matchPlayerLimit: the cap; 0 = no limit — then the denominator is left out («对局 12 人») rather than shown as
//     /0, which would read as a full server.
//   * online: the humans seated anywhere on the server (a match or a room still in its lobby, bots excluded) — the pool
//     matchPlayers is drawn from. Only the match's HUD shows it, beside the match count: the hall and the room's top bar
//     keep the bare «对局 12/20 人» (there the match count is the number being watched; the HUD is where a player is
//     away from the hall and still asks how busy the server is).
// Texts go through t() (docs/I18N.md), four packs: '对局 {players}/{max} 人', '对局 {players} 人', '在线 {n} 人' and
// the tooltips.

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
 * older server, or the first frame before any welcome). A limit of 0 (or a missing one) means no limit. `online` is
 * null when the frame does not carry it (a server from before the HUD count): nothing is shown for it then.
 * @param {any} stats
 * @returns {{ players: number, owners: number, limit: number, online: number|null, full: boolean } | null}
 */
export function serverLoad(stats) {
  if (!stats || typeof stats !== 'object') return null;
  if (!('matchPlayers' in stats) && !('matchPlayerLimit' in stats)) return null;
  const players = count(stats.matchPlayers);
  const owners = count(stats.matchOwners);
  const limit = count(stats.matchPlayerLimit);
  const online = 'online' in stats ? count(stats.online) : null;
  return { players, owners, limit, online, full: limit > 0 && players >= limit };
}

/**
 * The display text: 「对局 12/20 人」, 「对局 12+1/20 人」 for a server owner in a match (shown apart: it is not counted
 * against the limit), and 「对局 12 人」 when the server has no limit (0): a `/0` denominator would read as full.
 * `withOnline` (the match HUD) puts the server's online count in front of it: 「在线 15 人 · 对局 12/20 人」.
 * @param {any} stats a `stats` object, or what serverLoad() returns
 * @param {{ withOnline?: boolean }} [opts] withOnline: also show the server's humans online (the HUD; omitted when the
 *   frame carries no `online`)
 * @returns {string} '' when there is nothing to show
 */
export function serverLoadText(stats, { withOnline = false } = {}) {
  const s = stats && 'players' in stats && 'limit' in stats ? stats : serverLoad(stats);
  if (!s) return '';
  const players = s.owners > 0 ? `${s.players}+${s.owners}` : String(s.players);
  const match = s.limit > 0 ? t('对局 {players}/{max} 人', { players, max: s.limit }) : t('对局 {players} 人', { players });
  if (!withOnline || !Number.isFinite(s.online)) return match;
  return `${t('在线 {n} 人', { n: s.online })} · ${match}`;
}

/**
 * The pill: 「对局 12/20 人」 — the hall, a room's top bar, and (with `showOnline`: 「在线 15 人 · 对局 12/20 人」) the
 * match's HUD corner.
 * @param {{ stats?: any, class?: string, showOnline?: boolean }} props `stats`: store.stats (welcome / room.state);
 *   `showOnline`: lead with the server's online count (the HUD); nothing to show → null
 */
export function ServerLoad({ stats = null, class: cls, showOnline = false }) {
  const text = serverLoadText(stats, { withOnline: showOnline });
  if (!text) return null;
  const s = serverLoad(stats);
  const tip = showOnline && s && Number.isFinite(s.online)
    ? t('在线人数与同时在对局中的博士人数（服主不计入）')
    : t('同时在对局中的博士人数（服主不计入）');
  return html`<span class=${cx('server-load', s && s.full && 'server-load--full', cls)} title=${tip} data-testid="server-load">
    <span class="server-load__dot" aria-hidden="true"></span>
    <span class="server-load__text num">${text}</span>
  </span>`;
}
