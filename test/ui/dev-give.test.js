// test/ui/dev-give.test.js — the dev 调试 panel's data helpers (public/js/ui/devGiveModel.js): what it lists for
// `g.devGive` (any normal chess, any normal item — elite copies come from the ordinary merge — and every 自选 / 替补
// operator of data/backups.json `diy.operators`, greyed when no 自选 slot could take it), the row cap and the search
// filter. Runs against the real generated data. The intent side: test/match/dev-give.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KITTED_CHARS } from '../../server/sim/content/kits/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
globalThis.fetch = async (url) => {
  const name = String(url).split('/').pop();
  try { const body = readFileSync(path.join(ROOT, 'data', name), 'utf8'); return { ok: true, status: 200, json: async () => JSON.parse(body) }; } catch { return { ok: false, status: 404, json: async () => ({}) }; }
};
const { chessCatalog, itemCatalog, diyCatalog, filterCatalog, devGiveFields, DEV_GIVE_ROWS, DEV_DIY_NO_FORM, DEV_DIY_NO_KIT } =
  await import('../../public/js/ui/devGiveModel.js');
const { devChessOverlay, devChessIdentity, devChessKey } = await import('../../public/js/ui/devChess.js');
const { data } = await import('../../public/js/data.js');
await data.loadAll('chess', 'items', 'backups');

const CHESS = data.get('chess');
const ITEMS = data.get('items');
const BACKUPS = data.get('backups');
const chessRows = chessCatalog(CHESS);
const itemRows = itemCatalog(ITEMS);
const diyRows = diyCatalog({ chess: CHESS, backups: BACKUPS }, { kitted: KITTED_CHARS });
const SHU = 'char_2025_shu'; // 黍: a 6★ owned 自选 operator (not a chess piece)

test('the chess list holds every normal chess the intent accepts, never an elite / 自选 / alias row', () => {
  assert.ok(chessRows.length > 100, `only ${chessRows.length} chess listed`);
  const ids = new Set();
  for (const e of chessRows) {
    assert.equal(e.kind, 'chess');
    assert.equal(e.golden, false);
    assert.ok(!ids.has(e.id), `duplicate ${e.id}`);
    ids.add(e.id);
    const rec = data.lookup('chess', e.id);
    assert.ok(rec, `unknown ${e.id}`);
    assert.ok(!rec.isGolden && !rec.isDiy, `${e.id} should not be listed`);
    assert.equal(rec.baseId, rec.chessId, `${e.id} is an alias row`);
    assert.equal(e.name, rec.name);
  }
  // a known visible operator is there, its elite record is not
  const inside = data.lookup('chess', 'chess_char_1_01_a');
  assert.ok(ids.has('chess_char_1_01_a'));
  assert.ok(!ids.has(inside.goldenId));
});

test('the list is ordered by tier, then name', () => {
  const tiers = chessRows.map((e) => e.tier ?? 99);
  assert.deepEqual([...tiers].sort((a, b) => a - b), tiers, 'tiers ascend');
  const firstTier = chessRows.filter((e) => e.tier === chessRows[0].tier).map((e) => e.name);
  assert.deepEqual([...firstTier].sort((a, b) => a.localeCompare(b)), firstTier, 'names ascend inside a tier');
});

test('the item list holds every normal item (装备 and 法术), never an elite copy', () => {
  assert.ok(itemRows.length > 20, `only ${itemRows.length} items listed`);
  const ids = new Set();
  for (const e of itemRows) {
    assert.equal(e.kind, 'item');
    const rec = data.lookup('items', e.id);
    assert.ok(rec, `unknown ${e.id}`);
    assert.ok(!rec.isGolden, `${e.id} is an elite copy`);
    assert.equal(rec.baseId, rec.id);
    ids.add(e.id);
  }
  assert.ok(ids.has('chess_item_1_01_e_a')); // 维式重锤
  assert.ok(!ids.has('chess_item_1_01_e_b')); // its elite copy
});

test('the search is case-insensitive over the name, the id and the short line', () => {
  const name = chessRows.find((e) => e.sub);
  assert.ok(name, 'a chess with a title / subclass exists');
  const byName = filterCatalog(chessRows, name.name.slice(0, 2));
  assert.ok(byName.some((e) => e.id === name.id));
  const byId = filterCatalog(chessRows, name.id.toUpperCase().slice(0, 12));
  assert.ok(byId.some((e) => e.id === name.id));
  const byTier = filterCatalog(chessRows, ` ${name.tier} `);
  assert.ok(byTier.every((e) => `${e.name} ${e.id} ${e.sub} ${e.tier}`.toLowerCase().includes(String(name.tier))));
  // an empty / blank query keeps everything, junk matches nothing
  assert.equal(filterCatalog(chessRows, '').length, chessRows.length);
  assert.equal(filterCatalog(chessRows, '   ').length, chessRows.length);
  assert.equal(filterCatalog(chessRows, 'zzz-nothing-matches').length, 0);
  assert.equal(filterCatalog(chessRows, null).length, chessRows.length);
  assert.deepEqual(filterCatalog(null, 'x'), []);
  assert.ok(DEV_GIVE_ROWS > 0);
});

test('the 自选 / 替补 list holds every backup operator the data offers, with its tiers and greying', () => {
  const ops = Object.keys(BACKUPS.diy.operators);
  assert.equal(diyRows.length, ops.length, 'every diy.operators entry is listed');
  const byId = new Map(diyRows.map((e) => [e.id, e]));
  for (const id of ops) {
    const e = byId.get(id);
    assert.ok(e, `${id} is listed`);
    assert.equal(e.kind, 'diy');
    assert.equal(e.charId, id);
    assert.ok(e.name && e.name !== id, `${id} has a name`);
    assert.ok(!Object.hasOwn(CHESS, id), `${id} has no chess id (that is why it needs the diy kind)`);
  }
  // 黍: a 6★ owned pick at both tiers, a prototype at tier 5 only
  const shu = byId.get(SHU);
  assert.ok(shu, '黍 is listed');
  assert.equal(shu.name, '黍');
  assert.deepEqual(shu.tiers, [5, 6]);
  assert.equal(shu.rarity, 6);
  assert.equal(shu.proto, false);
  assert.equal(shu.ok, true);
  assert.equal(shu.reason, null);
  const proto = diyRows.find((e) => e.proto);
  assert.ok(proto, 'a 原型 / 替补 operator is listed');
  assert.ok(proto.tiers.length >= 1);
  // the givable rows come first in the list
  assert.equal(diyRows[0].ok, true);
});

test('a 自选 row without a form or without a kit is greyed with its reason, never silently dropped', () => {
  const noKit = diyCatalog({ chess: CHESS, backups: BACKUPS }, { kitted: [] });
  assert.equal(noKit.length, diyRows.length, 'the rows are still listed');
  assert.ok(noKit.every((e) => e.ok === false && e.reason === DEV_DIY_NO_KIT));
  assert.equal(devGiveFields({ kind: 'diy', id: SHU, ok: false }), null, 'a greyed row sends nothing');
  // an operator whose forms are missing (a stale / partial data file) keeps its row, greyed
  const bare = { ...BACKUPS, units: { ...BACKUPS.units, [SHU]: { ...BACKUPS.units[SHU], forms: {} } } };
  const noForm = diyCatalog({ chess: CHESS, backups: bare }, { kitted: KITTED_CHARS });
  const row = noForm.find((e) => e.id === SHU);
  assert.ok(row, 'the row is still listed');
  assert.equal(row.ok, false);
  assert.equal(row.reason, DEV_DIY_NO_FORM);
  assert.equal(row.tier, null);
  // a data file without the 自选 block lists nothing (no crash)
  assert.deepEqual(diyCatalog({ chess: CHESS, backups: {} }), []);
  assert.deepEqual(diyCatalog(null), []);
});

test('the row cap covers every source (the bug that hid tier 5–6 behind the first 80 rows)', () => {
  for (const [what, rows] of [['chess', chessRows], ['items', itemRows], ['diy', diyRows]]) {
    assert.ok(rows.length > 0, `${what} rows`);
    assert.ok(DEV_GIVE_ROWS >= rows.length, `${what}: ${rows.length} rows but the cap is ${DEV_GIVE_ROWS}`);
  }
  assert.ok(DEV_GIVE_ROWS >= 400 - 1);
});

test('the 自选 / 替补 rows are searchable by name and by tier', () => {
  const hits = filterCatalog(diyRows, '黍');
  assert.ok(hits.some((e) => e.id === SHU));
  const byTier = filterCatalog(diyRows, '6');
  assert.ok(byTier.some((e) => e.id === SHU));
  assert.equal(filterCatalog(diyRows, 'zzz-nothing-matches').length, 0);
});

test('a row becomes exactly the g.devGive fields, junk is refused', () => {
  assert.deepEqual(devGiveFields(chessRows[0]), { kind: 'chess', id: chessRows[0].id });
  assert.deepEqual(devGiveFields({ kind: 'item', id: 'x' }), { kind: 'item', id: 'x' });
  assert.deepEqual(devGiveFields({ kind: 'diy', id: SHU }), { kind: 'diy', id: SHU });
  assert.equal(devGiveFields(null), null);
  assert.equal(devGiveFields({ kind: 'chess' }), null);
  assert.equal(devGiveFields({ kind: 'bot', id: 'x' }), null);
  assert.equal(devGiveFields({ kind: 'chess', id: '' }), null);
});

// ---- 调试自选槽的显示：m.private.devChess + ui/devChess.js 的 overlay（棋盘 / 详情卡按 data.lookup 查） ----

const DEV_ID = 'chess_char_6_diy9_a'; // a dev slot's id: not in data/chess.json
const PICK = { charId: SHU, skillIndex: 2, uniEquipId: null, slotId: 'chess_char_6_diy1_a' };

test('the overlay makes data.lookup resolve a dev slot’s operator (name, class, model assets)', async () => {
  assert.equal(data.lookup('chess', DEV_ID), null, 'without the overlay the dev id is unknown, as before');
  const overlay = devChessOverlay(null, { diy: { [DEV_ID]: PICK } }, { chess: CHESS, backups: BACKUPS });
  assert.ok(overlay, 'a local composition from the pick');
  const rec = overlay[DEV_ID];
  assert.ok(rec, 'the normal form');
  assert.equal(rec.name, '黍');
  assert.equal(rec.charId, SHU);
  assert.equal(rec.tier, 6);
  assert.equal(rec.profession, 'TANK');
  assert.equal(rec.assets.spine, 'char_2025_shu', 'the model the renderer draws');
  assert.ok(Array.isArray(rec.skills) && rec.skills.length, 'the detail card’s skills');
  assert.ok(rec.skills.some((s) => s.index === 2), 'the picked skill');
  assert.equal(rec.diyFor, DEV_ID.replace(/_a$/, '_a'));
  const elite = overlay[DEV_ID.replace(/_a$/, '_b')];
  assert.ok(elite && elite.isGolden, 'the elite form too');
  data.setChessOverlay(overlay);
  assert.equal(data.lookup('chess', DEV_ID)?.name, '黍', 'lookup falls back to the overlay');
  assert.equal(data.lookup('chess', DEV_ID.replace(/_a$/, '_b'))?.name, '黍');
  // the overlay is lookup-only: what lists / downloads the game data is untouched (no formal path sees a dev slot)
  assert.equal(data.get('chess')[DEV_ID], undefined);
  assert.ok(!data.list('chess').some((c) => c.chessId === DEV_ID));
  data.setChessOverlay(null);
  assert.equal(data.lookup('chess', DEV_ID), null, 'cleared → the old behaviour');
});

test('the server’s m.private.devChess records win over the local composition', () => {
  const fromServer = { [DEV_ID]: { chessId: DEV_ID, charId: SHU, name: '黍（服务端）', assets: { spine: 'char_2025_shu' } } };
  const priv = { devChess: fromServer, diy: { [DEV_ID]: PICK } };
  const overlay = devChessOverlay(fromServer, priv, { chess: CHESS, backups: BACKUPS });
  assert.equal(overlay[DEV_ID].name, '黍（服务端）');
  assert.equal(devChessOverlay(null, { diy: {} }, { chess: CHESS, backups: BACKUPS }), null);
  assert.equal(devChessOverlay(null, null, null), null);
  // a formal match: no devChess, no dev pick → no overlay at all (behaviour unchanged)
  assert.equal(devChessOverlay(undefined, { diy: { 'chess_char_6_diy1_a': { charId: SHU, skillIndex: 2 } } }, { chess: CHESS, backups: BACKUPS }), null);
  assert.equal(devChessIdentity(DEV_ID, 'chess_char_6_diy1_a', { chess: CHESS })?.checkSlotId, 'chess_char_6_diy1_a');
  assert.equal(devChessIdentity(DEV_ID, 'chess_char_5_diy1_a', { chess: CHESS })?.tier, 5);
  assert.equal(devChessIdentity(DEV_ID, 'nope', { chess: CHESS }), null);
});

test('eight dev slots at once: every operator resolves (name, class, model) for the board and the detail card', () => {
  const ids = BACKUPS.diy.ownedPool.slice(0, 8);
  assert.equal(ids.length, 8);
  const diy = {};
  ids.forEach((charId, i) => {
    const slotId = `chess_char_6_diy${i + 3}_a`; // dev slots beside the official diy1_ / diy2_
    diy[slotId] = { charId, skillIndex: 2, uniEquipId: null, slotId: 'chess_char_6_diy1_a' };
  });
  const overlay = devChessOverlay(null, { diy }, { chess: CHESS, backups: BACKUPS });
  assert.equal(Object.keys(overlay).length, 16, 'both forms of all eight');
  data.setChessOverlay(overlay);
  try {
    for (const [slotId, pick] of Object.entries(diy)) {
      const rec = data.lookup('chess', slotId);
      assert.ok(rec, `${slotId} resolves`);
      assert.equal(rec.charId, pick.charId);
      assert.equal(rec.name, BACKUPS.units[pick.charId].name);
      assert.ok(rec.assets?.spine, `${slotId} has a model`);
      assert.ok(rec.profession && rec.subProfessionName, `${slotId} has its class`);
      assert.ok(rec.skills.some((s) => s.index === 2), `${slotId} has the picked skill for the detail card`);
      assert.ok(data.lookup('chess', slotId.replace(/_a$/, '_b'))?.isGolden);
    }
  } finally {
    data.setChessOverlay(null);
  }
});

test('the overlay key changes with the dev slots, not with every private push', () => {
  const a = devChessKey({ devChess: { [DEV_ID]: { name: 'x' } }, diy: { [DEV_ID]: PICK } });
  const b = devChessKey({ devChess: { [DEV_ID]: { name: 'x' } }, diy: { [DEV_ID]: PICK } });
  assert.equal(a, b);
  assert.notEqual(a, devChessKey({ devChess: { [DEV_ID]: { name: 'x' } }, diy: { [DEV_ID]: { ...PICK, charId: 'other' } } }));
  assert.equal(devChessKey({ diy: { 'chess_char_6_diy1_a': { charId: SHU } } }), '|');
});
