// test/match/dev-give.test.js — the dev-only gain intent `g.devGive` (SP_DEV=1; server/match/player/dev.js): any chess,
// any item, or any 自选 / 替补 operator onto the caller's side through the ordinary acquisition path.
//
// Covered: the shared/protocol.js whitelist entry, the dev-mode gate (off ⇒ ERR.BAD_MSG, never a silent gain), the
// validation (unknown id / charId, a tier that is not the record's, an illegal skill, a charId with no 自选 slot), the
// chess gain (hand / overflow temp, immediate merge, bonds recomputed), the item gain (stock gate bypassed), the 自选
// gain (a 6★ owned operator and a 原型 / 替补 one, through the player/diy.js slot path — pick, records, stock, the
// battleInput `diy` pick), the explicit skill / module on a plain chess piece, and the other seats staying untouched.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, DATA, legalTileFor } from './harness.js';
import { tileKey } from '../../server/match/board.js';
import { C2S, validateC2S } from '../../shared/protocol.js';
import { ERR } from '../../shared/constants.js';
import { lockedSelection, isPrototypePick } from '../../shared/diy.js';
import { KITTED_CHARS } from '../../server/sim/content/kits/index.js';
import { DEV_DIY_MAX_SLOTS } from '../../server/match/player/dev.js';

/** A visible normal chess with a bond (any bond: the derived state of a gain must be recomputed). */
const CHESS = Object.values(DATA.chess).find((c) => c.visible && !c.isGolden && !c.isDiy && Array.isArray(c.bonds) && c.bonds.length);
/** A normal equipment item. */
const ITEM = Object.values(DATA.items).find((i) => i.itemType === 'EQUIP' && !i.isGolden);
/** 自选 (DIY) operators: the data's own lists, never hard-coded ids — the pool changes between seasons. */
const DIY_OPS = Object.keys(DATA.backups?.diy?.operators ?? {});
const OWNED = (DATA.backups?.diy?.ownedPool ?? []).filter((id) => Object.hasOwn(DATA.backups.diy.operators, id));
const PROTOS = (DATA.backups?.diy?.prototypes?.[5] ?? []).filter((id) => Object.hasOwn(DATA.backups.diy.operators, id));
const SHU = 'char_2025_shu'; // 黍: a 6★ owned 自选 operator (not a chess piece)
const PROTO = PROTOS.find((id) => isPrototypePick(DATA, 5, id) && !isPrototypePick(DATA, 6, id)) || PROTOS[0];
const CHESS_CHAR = Object.values(DATA.chess).find((c) => !c.isGolden && !c.isDiy && c.charId && !DIY_OPS.includes(c.charId))?.charId;

/** Every piece a seat owns, wherever it is. */
const owned = (ps) => [...ps.board.values(), ...ps.hand.filter(Boolean), ...ps.temp.filter(Boolean)];
/** The chair's 自选 slots filled so far (the base ids of `ps.diy`). */
const diySlots = (ps) => Object.keys(ps.diy || {});

/** A started match in PREP with the dev switch on or off. */
function devMatch(o = {}) {
  const h = makeMatch({ mode: 'solo', difficulty: 'NORMAL', humans: 1, seed: 11, fake: true, devGold: o.devGold !== false });
  h.start();
  h.toPrep(1);
  return h;
}

test('g.devGive is a registered C2S message with a validated shape', () => {
  assert.ok(Object.hasOwn(C2S, 'g.devGive'));
  assert.equal(validateC2S({ t: 'g.devGive', kind: 'chess', id: CHESS.chessId }), null);
  assert.equal(validateC2S({ t: 'g.devGive', kind: 'item', id: ITEM.id }), null);
  assert.equal(validateC2S({ t: 'g.devGive', kind: 'diy', id: SHU }), null);
  assert.equal(validateC2S({ t: 'g.devGive', kind: 'chess', id: CHESS.chessId, tier: 3, skillIndex: 0, moduleId: 'x' }), null);
  assert.ok(validateC2S({ t: 'g.devGive', kind: 'bot', id: CHESS.chessId }));
  assert.ok(validateC2S({ t: 'g.devGive', kind: 'chess' }));
  assert.ok(validateC2S({ t: 'g.devGive', kind: 'chess', id: CHESS.chessId, tier: 0 }));
  assert.ok(validateC2S({ t: 'g.devGive', kind: 'chess', id: CHESS.chessId, skillIndex: 99 }));
});

test('dev on: a chess joins the hand and the derived state is recomputed', () => {
  const h = devMatch();
  const ps = h.ps('p_0');
  const before = ps.hand.filter(Boolean).length;
  const res = h.m.handle('p_0', { t: 'g.devGive', kind: 'chess', id: CHESS.chessId });
  assert.deepEqual(res, { ok: true });
  const piece = owned(ps).find((p) => p && p.kind === 'chess' && p.id === CHESS.chessId);
  assert.ok(piece, 'the chess joined the seat');
  // the gain went through acquireChess: a hand slot (or the overflow temp queue when the hand is full), never a stray
  assert.ok(Number.isInteger(piece.uid) && piece.uid > 0);
  assert.ok(ps.hand.filter(Boolean).length >= before || ps.temp.some(Boolean));
  assert.ok(ps.bonds && typeof ps.bonds === 'object', 'bonds were recomputed');
  h.invariants();
});

test('dev on: copies do merge into the elite like any gain', () => {
  const h = devMatch();
  const ps = h.ps('p_0');
  const need = h.m.gd.mergeCount(CHESS.chessId);
  assert.ok(need > 1 && h.m.gd.goldenIdOf(CHESS.chessId), 'the picked chess merges');
  for (let i = 0; i < need; i++) assert.deepEqual(h.m.handle('p_0', { t: 'g.devGive', kind: 'chess', id: CHESS.chessId }), { ok: true });
  const eliteId = h.m.gd.goldenIdOf(CHESS.chessId);
  assert.ok(owned(ps).some((p) => p && p.id === eliteId), 'the merge produced the elite');
  assert.ok(!owned(ps).some((p) => p && p.kind === 'chess' && p.id === CHESS.chessId), 'the normal copies are gone');
  h.invariants();
});

test('dev on: any item joins the bench (stock gate bypassed)', () => {
  const h = devMatch();
  const ps = h.ps('p_0');
  assert.deepEqual(h.m.handle('p_0', { t: 'g.devGive', kind: 'item', id: ITEM.id }), { ok: true });
  assert.ok(owned(ps).some((p) => p && p.kind === 'item' && p.id === ITEM.id), 'the item joined the seat');
  h.invariants();
});

test('dev on: an item is handed out even when its stock is used up (the only bypass)', () => {
  const h = devMatch();
  const ps = h.ps('p_0');
  const real = h.m.itemPool.canGain.bind(h.m.itemPool);
  h.m.itemPool.canGain = () => false;
  assert.equal(ps.acquireItem(ITEM.id, { source: 'test' }), null, 'the ordinary grant refuses the sold-out item');
  assert.deepEqual(h.m.handle('p_0', { t: 'g.devGive', kind: 'item', id: ITEM.id }), { ok: true });
  assert.ok(owned(ps).some((p) => p && p.kind === 'item' && p.id === ITEM.id), 'the dev grant kept it');
  h.m.itemPool.canGain = real;
  h.invariants();
});

test('dev on: an explicit skill / module rides on the piece into battleInput', () => {
  const h = devMatch();
  const ps = h.ps('p_0');
  const rec = h.m.gd.chess(CHESS.chessId);
  const skillIndex = Array.isArray(rec.skills) && rec.skills.length ? rec.skills[rec.skills.length - 1].index : rec.skill?.index ?? 0;
  const res = h.m.handle('p_0', { t: 'g.devGive', kind: 'chess', id: CHESS.chessId, skillIndex });
  assert.deepEqual(res, { ok: true });
  const piece = owned(ps).find((p) => p && p.kind === 'chess' && p.id === CHESS.chessId);
  assert.deepEqual(piece.meta.dev, { skillIndex });
  // put it on a board tile (the tile's legality is not what this test is about) and read battleInput
  const i = ps.hand.findIndex((p) => p && p.uid === piece.uid);
  if (i >= 0) ps.hand[i] = null;
  ps.board.set(tileKey(11, 5), piece);
  ps.recompute();
  const unit = ps.battleInput().units.find((u) => u.uid === piece.uid);
  assert.ok(unit, 'the piece is on the board');
  assert.equal(unit.skillIndex, skillIndex);
  h.invariants();
});

test('dev on: an unknown id, a foreign tier and an illegal skill are refused and change nothing', () => {
  const h = devMatch();
  const ps = h.ps('p_0');
  const before = owned(ps).length;
  assert.equal(h.m.handle('p_0', { t: 'g.devGive', kind: 'chess', id: 'chess_nope_0' }).error, ERR.BAD_TARGET);
  assert.equal(h.m.handle('p_0', { t: 'g.devGive', kind: 'item', id: 'item_nope_0' }).error, ERR.BAD_TARGET);
  const wrongTier = CHESS.tier === 6 ? 1 : CHESS.tier + 1;
  assert.equal(h.m.handle('p_0', { t: 'g.devGive', kind: 'chess', id: CHESS.chessId, tier: wrongTier }).error, ERR.BAD_TARGET);
  assert.equal(h.m.handle('p_0', { t: 'g.devGive', kind: 'chess', id: CHESS.chessId, skillIndex: 8 }).error, ERR.BAD_TARGET);
  assert.equal(owned(ps).length, before, 'nothing was gained');
  h.invariants();
});

test('dev off: the intent is refused with BAD_MSG and nothing is gained', () => {
  const h = devMatch({ devGold: false });
  const ps = h.ps('p_0');
  const before = owned(ps).length;
  const res = h.m.handle('p_0', { t: 'g.devGive', kind: 'chess', id: CHESS.chessId });
  assert.equal(res.error, ERR.BAD_MSG);
  assert.equal(h.m.handle('p_0', { t: 'g.devGive', kind: 'item', id: ITEM.id }).error, ERR.BAD_MSG);
  assert.equal(owned(ps).length, before);
  h.invariants();
});

test('dev on: the gain never touches another seat', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, seed: 11, fake: true, devGold: true });
  h.start();
  h.toPrep(1);
  const [a, b] = ['p_0', 'p_1'].map((id) => h.ps(id));
  const before = owned(b).length;
  assert.deepEqual(h.m.handle('p_0', { t: 'g.devGive', kind: 'chess', id: CHESS.chessId }), { ok: true });
  assert.deepEqual(h.m.handle('p_0', { t: 'g.devGive', kind: 'item', id: ITEM.id }), { ok: true });
  assert.equal(owned(b).length, before, 'the other seat gained nothing');
  assert.ok(owned(a).some((p) => p && p.id === CHESS.chessId));
  h.invariants();
});

test('dev off: a match without the switch has no dev views flag', () => {
  const h = devMatch({ devGold: false });
  const msg = h.lastTo('p_0', 'm.private');
  assert.ok(msg, 'm.private was sent');
  assert.notEqual(msg.dev, true);
  const on = devMatch();
  assert.equal(on.lastTo('p_0', 'm.private').dev, true);
});

// ---- 自选 / 替补 (kind 'diy'): no chess id of their own — the 自选编队 slot path (player/diy.js) ----------------

test('dev on: a 6★ owned 自选 operator is fielded through a 自选 slot', () => {
  assert.ok(DIY_OPS.includes(SHU), '黍 is a 自选 operator in this data');
  assert.ok(!Object.values(DATA.chess).some((c) => c.chessId === SHU), '黍 has no chess id of its own');
  const h = devMatch();
  const ps = h.ps('p_0');
  assert.deepEqual(h.m.handle('p_0', { t: 'g.devGive', kind: 'diy', id: SHU }), { ok: true });
  const piece = owned(ps).find((p) => p && p.kind === 'chess' && ps.gd.chess(p.id)?.charId === SHU);
  assert.ok(piece, 'the operator joined the seat');
  // the formal path: the slot's composed record (shared/diy.js diyRecord), the pick in ps.diy, the player's own stock
  assert.ok(piece.id.startsWith('chess_char_'), `a 自选 slot id, got ${piece.id}`);
  assert.equal(diySlots(ps).length, 1, 'one 自选 slot was taken');
  assert.equal(ps.diy[piece.id.replace(/_b$/, '_a')]?.charId, SHU);
  assert.equal(ps.gd.chess(piece.id)?.name, '黍');
  assert.equal(ps.diyPickOf(piece.id)?.charId, SHU);
  assert.ok(ps.diyStock.has(piece.id.replace(/_b$/, '_a')) || ps.diyStock.has(piece.id), 'the piece has its own stock');
  assert.ok(ps.bonds && typeof ps.bonds === 'object', 'bonds were recomputed');
  // and it fights as the pick (battleInput's `diy`), which a plain chess gain cannot express
  const tile = legalTileFor(h.m, ps, piece.id);
  assert.ok(tile, 'a legal tile');
  assert.deepEqual(h.m.handle('p_0', { t: 'g.move', uid: piece.uid, to: { area: 'board', row: tile[0], col: tile[1] } }), { ok: true });
  const unit = ps.battleInput().units.find((u) => u.uid === piece.uid);
  assert.ok(unit, 'the piece is on the board');
  assert.equal(unit.diy?.charId, SHU);
  assert.equal(unit.diy.skillIndex, ps.diyPickOf(piece.id).skillIndex);
  h.invariants();
});

test('dev on: a 原型 / 替补 operator takes its locked skill and a tier-5 slot', () => {
  assert.ok(PROTO, 'the data has a tier-5-only prototype');
  const h = devMatch();
  const ps = h.ps('p_0');
  assert.deepEqual(h.m.handle('p_0', { t: 'g.devGive', kind: 'diy', id: PROTO }), { ok: true });
  const piece = owned(ps).find((p) => p && p.kind === 'chess' && ps.gd.chess(p.id)?.charId === PROTO);
  assert.ok(piece, 'the prototype joined the seat');
  assert.ok(piece.id.startsWith('chess_char_5_diy'), `a tier-5 自选 slot, got ${piece.id}`);
  const locked = lockedSelection(DATA, 5, PROTO);
  assert.deepEqual(ps.diyPickOf(piece.id), { charId: PROTO, skillIndex: locked.skillIndex, uniEquipId: locked.uniEquipId });
  h.invariants();
});

test('dev on: a 自选 operator can name its skill / module; an illegal one is refused', () => {
  const h = devMatch();
  const ps = h.ps('p_0');
  const skills = Object.values(DATA.backups.units[SHU].forms).find((f) => Array.isArray(f.skills) && f.skills.length)?.skills ?? [];
  const first = skills[0]?.index ?? 0;
  assert.deepEqual(h.m.handle('p_0', { t: 'g.devGive', kind: 'diy', id: SHU, skillIndex: first }), { ok: true });
  const piece = owned(ps).find((p) => p && p.kind === 'chess' && ps.gd.chess(p.id)?.charId === SHU);
  assert.equal(ps.diyPickOf(piece.id).skillIndex, first);
  assert.equal(h.m.handle('p_0', { t: 'g.devGive', kind: 'diy', id: SHU, skillIndex: 99 }).error, ERR.BAD_TARGET);
  // the slot's pick is fixed: a different skill is refused, the same one is another copy of that slot
  const other = skills.map((s) => s.index).find((i) => i !== first);
  if (other !== undefined) {
    assert.equal(h.m.handle('p_0', { t: 'g.devGive', kind: 'diy', id: SHU, skillIndex: other }).error, ERR.BAD_TARGET);
  }
  assert.deepEqual(h.m.handle('p_0', { t: 'g.devGive', kind: 'diy', id: SHU, skillIndex: first }), { ok: true });
  assert.equal(Object.keys(ps.diy).length, 1, 'still one slot for 黍');
  h.invariants();
});

test('dev on: a charId without a 自选 slot, a foreign tier and an unknown charId are refused', () => {
  const h = devMatch();
  const ps = h.ps('p_0');
  const before = owned(ps).length;
  const slots = diySlots(ps).length;
  assert.equal(h.m.handle('p_0', { t: 'g.devGive', kind: 'diy', id: 'char_nope_0' }).error, ERR.DEV_NO_SLOT);
  if (CHESS_CHAR) {
    // a chess-only operator: a chess id exists, but no 自选 slot takes it
    assert.equal(h.m.handle('p_0', { t: 'g.devGive', kind: 'diy', id: CHESS_CHAR }).error, ERR.DEV_NO_SLOT);
  }
  // the prototype is a tier-5 pick only: tier 6 has no slot for it
  assert.equal(h.m.handle('p_0', { t: 'g.devGive', kind: 'diy', id: PROTO, tier: 6 }).error, ERR.DEV_NO_SLOT);
  assert.equal(owned(ps).length, before, 'nothing was gained');
  assert.equal(diySlots(ps).length, slots, 'no slot was taken');
  h.invariants();
});

test('dev on: the official four slots are not a limit — 20 operators coexist, no replacement', () => {
  const h = devMatch();
  const ps = h.ps('p_0');
  const toasts = [];
  h.onSend.push((pid, msg) => { if (msg.t === 'm.toast') toasts.push(msg); });
  const ids = OWNED.slice(0, 20);
  assert.equal(ids.length, 20, '20 owned 自选 operators in the data');
  ids.forEach((id, i) => {
    assert.deepEqual(h.m.handle('p_0', { t: 'g.devGive', kind: 'diy', id }), { ok: true }, `${id} (#${i + 1})`);
  });
  // the first four land in the official slots (tier 6 first, then tier 5); the rest are dev slots beside them
  const slots = Object.keys(ps.diy);
  assert.equal(slots.length, 20, 'every operator keeps its own slot');
  for (const official of ['chess_char_6_diy1_a', 'chess_char_6_diy2_a', 'chess_char_5_diy1_a', 'chess_char_5_diy2_a']) {
    assert.ok(slots.includes(official), `the official slot ${official} is used first`);
  }
  for (const id of ids) assert.equal(Object.values(ps.diy).filter((p) => p.charId === id).length, 1, `${id} kept its pick`);
  // the dev slots' ids are predictable: <tier>/diy3_, diy4_ … beside the official diy1_ / diy2_
  const dev = slots.filter((id) => !['chess_char_6_diy1_a', 'chess_char_6_diy2_a', 'chess_char_5_diy1_a', 'chess_char_5_diy2_a'].includes(id));
  assert.equal(dev.length, 16);
  for (const id of dev) assert.match(id, /^chess_char_[56]_diy\d+_a$/);
  // every operator is fielded as its pick, and no replacement toast was ever sent
  for (const p of owned(ps)) {
    if (p.kind !== 'chess') continue;
    const rec = ps.gd.chess(p.id);
    assert.ok(rec && rec.charId, `piece ${p.id} resolves`);
    assert.equal(ps.diyPickOf(p.id)?.charId, rec.charId, `piece ${p.id} fights as its pick`);
  }
  assert.equal(toasts.filter((m) => String(m.msgid || '').includes('已替换')).length, 0, 'nothing was replaced');
  h.invariants();
});

test('dev on: a dev slot’s piece is a real operator in battle (the sim composes its def)', () => {
  const h = devMatch();
  const ps = h.ps('p_0');
  for (const id of OWNED.slice(0, 5)) assert.deepEqual(h.m.handle('p_0', { t: 'g.devGive', kind: 'diy', id }), { ok: true });
  const dev = owned(ps).find((p) => p && p.kind === 'chess' && /_diy([3-9]|\d\d)_a$/.test(p.id));
  assert.ok(dev, 'a dev slot piece exists');
  const rec = ps.gd.chess(dev.id);
  assert.equal(dev.id.replace(/_a$/, '_b').length > 0, true);
  assert.match(rec.diyTemplate, /^chess_char_[56]_diy1_a$/);
  // the pick the battle input carries names the official slot its records come from
  const tile = legalTileFor(h.m, ps, dev.id);
  assert.deepEqual(h.m.handle('p_0', { t: 'g.move', uid: dev.uid, to: { area: 'board', row: tile[0], col: tile[1] } }), { ok: true });
  const unit = ps.battleInput().units.find((u) => u.uid === dev.uid);
  assert.ok(unit, 'the piece is on the board');
  assert.equal(unit.diy.slotId, rec.diyTemplate);
  // the sim resolves it: an operator def with the dev ids and the operator's body (not null, as an unknown id would be)
  const def = h.m.ds.getChess(dev.id, { diy: unit.diy });
  assert.ok(def, 'the sim composes the dev slot def');
  assert.equal(def.charId, rec.charId);
  assert.equal(def.diyFor, dev.id);
  assert.equal(def.tier, rec.tier);
  h.invariants();
});

test('dev on: the same operator again is another copy of the SAME slot (and merges like any piece)', () => {
  const h = devMatch();
  const ps = h.ps('p_0');
  const id = OWNED[0];
  for (let i = 0; i < 3; i++) assert.deepEqual(h.m.handle('p_0', { t: 'g.devGive', kind: 'diy', id }), { ok: true });
  assert.equal(Object.keys(ps.diy).length, 1, 'one slot, not three');
  const slotId = Object.keys(ps.diy)[0];
  const eliteId = ps.gd.goldenIdOf(slotId);
  assert.ok(owned(ps).some((p) => p && p.id === eliteId), 'the third copy merged into the elite of the same slot');
  assert.equal(ps.gd.chess(eliteId)?.charId, id, 'the elite is the same operator');
  h.invariants();
});

test('dev on: the dev slots stay out of the shop / promotion / random-grant draws', () => {
  const h = devMatch();
  const ps = h.ps('p_0');
  const official = new Set(['chess_char_6_diy1_a', 'chess_char_6_diy2_a', 'chess_char_5_diy1_a', 'chess_char_5_diy2_a']);
  for (const id of OWNED.slice(0, 6)) h.m.handle('p_0', { t: 'g.devGive', kind: 'diy', id });
  const devIds = Object.keys(ps.diy).filter((id) => !official.has(id));
  assert.ok(devIds.length, 'dev slots exist');
  for (const [list, what] of [[ps.diyRollEntries(), 'shop'], [ps.diyStockEntries(), 'reward / random grant']]) {
    for (const [id] of list || []) assert.ok(official.has(id), `${what} never lists the dev slot ${id}`);
  }
  // the stock itself is there (a real slot's own copies), only the draws skip it
  for (const id of devIds) assert.ok(ps.diyStock.has(id), `dev slot ${id} has stock`);
  h.invariants();
});

test('dev on: the defensive bound only (DEV_DIY_MAX_SLOTS, injectable) refuses with DEV_NO_SLOT', () => {
  assert.ok(Number.isInteger(DEV_DIY_MAX_SLOTS) && DEV_DIY_MAX_SLOTS >= 20, 'the real bound is generous');
  const h = devMatch();
  h.m.devDiyMaxSlots = 4; // the test's own bound: never build 64 slots
  const ps = h.ps('p_0');
  const toasts = [];
  h.onSend.push((pid, msg) => { if (msg.t === 'm.toast') toasts.push(msg); });
  const ids = OWNED.slice(0, 5);
  for (const id of ids.slice(0, 4)) assert.deepEqual(h.m.handle('p_0', { t: 'g.devGive', kind: 'diy', id }), { ok: true });
  const res = h.m.handle('p_0', { t: 'g.devGive', kind: 'diy', id: ids[4] });
  assert.equal(res.error, ERR.DEV_NO_SLOT);
  assert.equal(Object.keys(ps.diy).length, 4, 'nothing was replaced to make room');
  const note = toasts.filter((m) => String(m.msgid || '').includes('安全上限'));
  assert.equal(note.length, 1, 'the bound is said out loud');
  assert.equal(note[0].params.max, 4);
  // an operator already slotted still gains a copy at the bound (a copy is not a new slot)
  assert.deepEqual(h.m.handle('p_0', { t: 'g.devGive', kind: 'diy', id: ids[0] }), { ok: true });
  h.invariants();
});

test('dev on: the player’s own 自选 picks survive (dev slots are created beside them)', () => {
  const h = devMatch();
  const ps = h.ps('p_0');
  const own = OWNED.slice(0, 2);
  const okDiy = ps.setDiy({ 'chess_char_5_diy1_a': { charId: own[0], skillIndex: 2 }, 'chess_char_6_diy1_a': { charId: own[1], skillIndex: 2 } }, { kitted: KITTED_CHARS });
  assert.equal(okDiy, true);
  ps.initDiyStock(new Set());
  ps.recompute();
  for (const id of OWNED.slice(2, 8)) assert.deepEqual(h.m.handle('p_0', { t: 'g.devGive', kind: 'diy', id }), { ok: true });
  assert.equal(ps.diy['chess_char_5_diy1_a']?.charId, own[0], 'the original tier-5 pick stays');
  assert.equal(ps.diy['chess_char_6_diy1_a']?.charId, own[1], 'the original tier-6 pick stays');
  assert.equal(Object.keys(ps.diy).length, 8, 'six dev slots beside the two official picks');
  h.invariants();
});

test('dev on: the dev slots’ records ride in the OWNER’s private view only (never broadcast)', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, seed: 13, fake: true, devGold: true });
  h.start();
  h.toPrep(1);
  const [a, b] = ['p_0', 'p_1'].map((id) => h.ps(id));
  // an official slot needs no overlay; a dev slot does
  assert.equal(a.devChessRecords(), null, 'nothing before a dev slot exists');
  const ids = OWNED.slice(0, 6);
  for (const id of ids) assert.deepEqual(h.m.handle('p_0', { t: 'g.devGive', kind: 'diy', id }), { ok: true });
  const devId = Object.keys(a.diy).find((id) => !DATA.backups.diy.slots[id]);
  assert.ok(devId, 'a dev slot exists');
  const devChess = a.devChessRecords();
  assert.ok(devChess[devId], 'the composed normal record');
  assert.ok(devChess[devId.replace(/_a$/, '_b')], 'and its elite form');
  assert.equal(devChess[devId].charId, a.diy[devId].charId);
  assert.ok(devChess[devId].assets?.spine, 'the model the client draws');
  // the owner's private view carries it; the other seat's does not, and no broadcast frame knows it
  const mine = h.lastTo('p_0', 'm.private');
  assert.ok(mine.devChess?.[devId], 'm.private.devChess of the owner');
  const other = h.lastTo('p_1', 'm.private');
  assert.equal(other.devChess, undefined, 'the other seat never gets it');
  assert.equal(b.devChessRecords(), null, 'and its own state has none');
  assert.ok(!h.bc.some((msg) => msg && msg.devChess), 'no broadcast frame carries devChess');
  assert.ok(!h.bc.some((msg) => msg && msg.t === 'm.public' && JSON.stringify(msg).includes(devId)), 'm.public never names a dev slot id');
  h.invariants();
});

test('dev on: a skin picked for the operator dresses its dev slot piece', () => {
  const h = devMatch();
  const ps = h.ps('p_0');
  for (const id of OWNED.slice(0, 5)) assert.deepEqual(h.m.handle('p_0', { t: 'g.devGive', kind: 'diy', id }), { ok: true });
  const dev = owned(ps).find((p) => p && p.kind === 'chess' && !DATA.backups.diy.slots[p.id]);
  assert.ok(dev, 'a dev slot piece');
  const charId = ps.diy[dev.id]?.charId ?? ps.diy[dev.id.replace(/_b$/, '_a')]?.charId;
  assert.ok(charId, 'the operator of the dev slot');
  const skin = 'skin_test_skin_1';
  assert.equal(ps.setSkins({ [charId]: skin }), true, 'a skin keyed by the operator (the 自选 picker’s key) is accepted');
  const tile = legalTileFor(h.m, ps, dev.id);
  assert.deepEqual(h.m.handle('p_0', { t: 'g.move', uid: dev.uid, to: { area: 'board', row: tile[0], col: tile[1] } }), { ok: true });
  const unit = ps.battleInput().units.find((u) => u.uid === dev.uid);
  assert.equal(unit.diy.slotId, ps.gd.chess(dev.id).diyTemplate);
  assert.equal(unit.skin, skin, 'the outfit rides to the battle unit');
  h.invariants();
});

test('the panel’s givable rows and the server’s acceptances agree for every 自选 operator', async () => {
  const { diyCatalog } = await import('../../public/js/ui/devGiveModel.js');
  const rows = diyCatalog({ chess: DATA.chess, backups: DATA.backups }, { kitted: KITTED_CHARS });
  const clientOk = rows.filter((r) => r.ok).map((r) => r.id).sort();
  // each operator in its own fresh dev match (a single match would run into the defensive bound)
  const accepted = [];
  for (const id of DIY_OPS) {
    const one = devMatch();
    const res = one.m.handle('p_0', { t: 'g.devGive', kind: 'diy', id });
    if (res.ok) accepted.push(id);
  }
  accepted.sort();
  assert.deepEqual(accepted, clientOk, 'what the panel offers is what the server takes');
});

test('dev off: the 自选 kind is refused with BAD_MSG and no slot is taken', () => {
  const h = devMatch({ devGold: false });
  const ps = h.ps('p_0');
  const before = owned(ps).length;
  assert.equal(h.m.handle('p_0', { t: 'g.devGive', kind: 'diy', id: SHU }).error, ERR.BAD_MSG);
  assert.equal(owned(ps).length, before);
  assert.equal(diySlots(ps).length, 0);
  h.invariants();
});
