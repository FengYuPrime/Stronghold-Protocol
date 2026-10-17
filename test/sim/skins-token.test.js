// 换装（皮肤）的召唤物一侧：主人穿着皮肤时，它召唤出的 token 也带上同一套皮肤 id，渲染侧才能按官方 tokenSkinMap
// 换成皮肤模型（public/js/assets.js tokenSkinSpine / test/skins.test.js）。sim 里皮肤只是展示字段（Unit.skin），
// 不进任何数值或随机数：没有皮肤的对局与以前逐字节相同（snapshot unitInfo.skin 为 undefined，JSON 丢掉）。
//
// Run: node --test test/sim/skins-token.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle } from '../helpers/battleHarness.js';
import { unitInfo } from '../../server/sim/snapshot.js';

const SKIN = 'char_1033_swire2@ambienceSynesthesia#4';
const CHESS = 'chess_char_3_04_a';                 // 琳琅诗怀雅 (char_1033_swire2), normal form
const TOKEN = 'token_10031_swire2_gdtrap';         // 香槟炸弹: the token its 2nd skill drops

/** A battle whose single operator (uid 1) is 琳琅诗怀雅 at (10,5), wearing `skin` (null = the default model). */
function field(skin = SKIN) {
  const input = { uid: 1, kind: 'chess', chessId: CHESS, row: 10, col: 5 };
  if (skin) input.skin = skin;
  const h = makeBattle({
    timeLimit: 5, autoFinish: false,
    players: [{ playerId: 'p1', seat: 0, side: 'L', colOffset: 0, units: [input], bonds: {}, playerEffects: [] }],
  });
  h.step();
  return h;
}

test('a summoned token wears its summoner’s outfit (Unit.skin + unitInfo.skin, display only)', () => {
  const h = field();
  const op = h.unit(CHESS);
  assert.equal(op.skin, SKIN);
  const t = h.b.spawnToken(op, TOKEN, 9, 6);   // a free tile next to the operator
  assert.ok(t, 'the token spawned');
  assert.equal(t.skin, SKIN, 'the summon carries the outfit its owner picked');
  assert.equal(unitInfo(t).skin, SKIN, 'and it reaches the client (snapshot unitInfo.skin)');
  // the outfit changes nothing the sim reads back
  assert.equal(t.defId, TOKEN);
});

test('without an outfit neither the operator nor its token has a skin (the wire format is unchanged)', () => {
  const h = field(null);
  const op = h.unit(CHESS);
  assert.equal(op.skin, null);
  const t = h.b.spawnToken(op, TOKEN, 9, 6);
  assert.ok(t);
  assert.equal(t.skin, null);
  assert.equal(unitInfo(t).skin, undefined, 'undefined, not null: JSON.stringify drops the field');
  assert.ok(!('skin' in JSON.parse(JSON.stringify(unitInfo(t)))), 'a match without skins keeps the byte-identical wire format');
});

test('a board token listed before its summoner takes the outfit too (the late owner link)', () => {
  // board order is top→bottom: a token placed above its operator is created first, with no owner yet; Battle._addPlayer
  // links it to the owner afterwards (players.js), and the outfit must come along then
  const h = makeBattle({
    timeLimit: 5, autoFinish: false,
    players: [{
      playerId: 'p1', seat: 0, side: 'L', colOffset: 0, bonds: {}, playerEffects: [],
      units: [
        { uid: 1, kind: 'token', tokenId: TOKEN, ownerUid: 2, row: 9, col: 2 },
        { uid: 2, kind: 'chess', chessId: CHESS, row: 10, col: 5, skin: SKIN },
      ],
    }],
  });
  h.step();
  const token = h.b.allyUnits.find((u) => u.uid === 1);
  assert.ok(token && token.ownerUnit, 'the token is linked to its owner');
  assert.equal(token.skin, SKIN);
  assert.equal(unitInfo(token).skin, SKIN);
});
