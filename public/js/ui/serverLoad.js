// public/js/ui/serverLoad.js — how full the server's matches are («对局 12/20 人») and, in a match, how many humans are
// online at all («在线 15 人 · 对局 12/20 人»): the client side of the match-player limit (server/lobby.js
// Lobby.matchStats, n env SP_MAX_MATCH_PLAYERS).
//
// The server sends the numbers with the frames it already broadcasts — `welcome.stats` and `room.state.stats`
// { matchPlayers, matchOwners, matchPlayerLimit, online, onlineOwners } (main.js keeps the latest in store.stats) — so
// nothing here polls.
//   * matchPlayers: the humans inside running matches (bots and spectator seats are none, a room still in its lobby is
//     none — server/lobby.js matchLoad);
//   * matchOwners: the server owner's own seats (SP_OWNER_TOKEN), counted apart: they take no room under the limit;
//   * matchPlayerLimit: the cap; 0 = no limit — then the denominator is left out («对局 12 人») rather than shown as
//     /0, which would read as a full server.
//   * online: the humans holding an open socket on the server right now — a seated player (in a match or in a room
//     still in its lobby), a visitor browsing the hall without a room, a connected spectator; bots have no session and
//     never count, and a seat kept for its reconnect is not a socket, so it is not counted either (server/lobby.js
//     matchLoad, net.js Session.connected). The number therefore follows the page: closing a tab lowers it. Because a
//     dropped seat stays in a match, `online` may briefly read *less* than matchPlayers; the view below floors it at 0.
//     Only the match's HUD shows it, beside the match count: the hall and the room's top bar keep the bare
//     «对局 12/20 人» (there the match count is the number being watched; the HUD is where a player is away from the
//     hall and still asks how busy the server is).
//   * onlineOwners: how many of those connected humans are the server owner's (server/lobby.js matchLoad).
//
// 服主特权 — the same shared frame, two views (`viewerOwner`, the session-level `welcome.me.owner` in store.viewerOwner;
// room.state is one broadcast, so it can never carry a per-viewer field):
//   * the owner itself (viewerOwner === true): its seats are shown apart, as before — «在线 16 人 · 对局 12+1/20 人»;
//   * everyone else: ordinary numbers, no «+N», and the owner is taken out of BOTH counts — «在线 15 人 ·
//     对局 12/20 人». A server that counts nothing but owners can then read «在线 0 人 · 对局 0/20 人» (never a negative),
//     and an older server (no `onlineOwners`) is read as 0: the counts stay exactly what they were.
//   * the limit (0 = no limit) is shown the same way to both: the denominator is simply left out.
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
 * `onlineOwners` is 0 when the frame does not carry it (a server from before this count): then a non-owner view is
 * exactly what it was before.
 * @param {any} stats
 * @returns {{ players: number, owners: number, limit: number, online: number|null, onlineOwners: number,
 *   full: boolean } | null}
 */
export function serverLoad(stats) {
  if (!stats || typeof stats !== 'object') return null;
  if (!('matchPlayers' in stats) && !('matchPlayerLimit' in stats)) return null;
  const players = count(stats.matchPlayers);
  const owners = count(stats.matchOwners);
  const limit = count(stats.matchPlayerLimit);
  const online = 'online' in stats ? count(stats.online) : null;
  const onlineOwners = 'onlineOwners' in stats ? count(stats.onlineOwners) : 0;
  return { players, owners, limit, online, onlineOwners, full: limit > 0 && players >= limit };
}

/**
 * The display text: 「对局 12/20 人」, 「对局 12+1/20 人」 for the server owner itself (shown apart: it is not counted
 * against the limit), and 「对局 12 人」 when the server has no limit (0): a `/0` denominator would read as full.
 * `withOnline` (the match HUD) puts the server's online count in front of it: 「在线 15 人 · 对局 12/20 人」.
 * `viewerOwner` (store.viewerOwner, the session's `welcome.me.owner`) picks the view of the same numbers: the owner
 * keeps the «+N» and its own seats inside `online`; everyone else gets ordinary numbers — no «+N», and the owner's
 * seats taken out of both counts (floored at 0).
 * @param {any} stats a `stats` object, or what serverLoad() returns
 * @param {{ withOnline?: boolean, viewerOwner?: boolean }} [opts] withOnline: also show the server's humans online (the
 *   HUD; omitted when the frame carries no `online`); viewerOwner: show this session's own owner seats apart (default
 *   false: the plain-player view)
 * @returns {string} '' when there is nothing to show
 */
export function serverLoadText(stats, { withOnline = false, viewerOwner = false } = {}) {
  const s = stats && 'players' in stats && 'limit' in stats ? stats : serverLoad(stats);
  if (!s) return '';
  const players = viewerOwner && s.owners > 0 ? `${s.players}+${s.owners}` : String(s.players);
  const match = s.limit > 0 ? t('对局 {players}/{max} 人', { players, max: s.limit }) : t('对局 {players} 人', { players });
  let online = s.online;
  // a plain player: the owner is no part of either count (never below 0 — a stale frame may name more owners than seats)
  if (!viewerOwner && Number.isFinite(online)) online = Math.max(0, online - s.onlineOwners);
  if (!withOnline || !Number.isFinite(online)) return match;
  return `${t('在线 {n} 人', { n: online })} · ${match}`;
}

/**
 * The pill: 「对局 12/20 人」 — the hall, a room's top bar, and (with `showOnline`: 「在线 15 人 · 对局 12/20 人」) the
 * match's HUD corner.
 * @param {{ stats?: any, class?: string, showOnline?: boolean, viewerOwner?: boolean }} props `stats`: store.stats
 *   (welcome / room.state); `showOnline`: lead with the server's online count (the HUD); `viewerOwner`:
 *   store.viewerOwner — the «+1» / owner-in-the-count view of the server owner itself (ui/serverLoad.js above);
 *   nothing to show → null
 */
export function ServerLoad({ stats = null, class: cls, showOnline = false, viewerOwner = false }) {
  const text = serverLoadText(stats, { withOnline: showOnline, viewerOwner });
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
