// test/match/dev-enemy-hp.test.js — the dev-only intent `g.devEnemyHp` (SP_DEV=1): the enemy-HP multiplier a debugger
// uses to get a「耐打靶子」for damage-over-time / element tests.
//
// Covered: the shared/protocol.js whitelist entry and its shape check; the dev-mode gate (off ⇒ ERR.BAD_MSG, the
// multiplier stays 1); the plain invariant that a non-dev match's spawn list is byte-identical (mods.hpMul = the round's
// own scale); ×20 on the max HP of the enemies a NEW battle spawns (a real Battle, same seed, dev off vs on — one
// comparison per spawn); the client-combat BattleSpec carrying the same scale (the browser builds its own battle);
// back to ×1 restoring the plain enemies; and the value the client gets (m.private.devEnemyHp).

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch } from './harness.js';
import { C2S, validateC2S } from '../../shared/protocol.js';
import { ERR } from '../../shared/constants.js';

/** A started match in PREP with the dev switch on (default) or off. `fake: false` = the real sim Battle. */
function devMatch(devGold = true) {
  const h = makeMatch({ mode: 'solo', difficulty: 'NORMAL', humans: 1, seed: 23, fake: false, devGold });
  h.start();
  h.toPrep(1);
  return h;
}

/**
 * The enemies the next battle of this match spawns (a real Battle built from the match's own options, stepped until a
 * few enemies are on the field). Same seed, same wave ⇒ the same sequence in every run, so index i of two runs is the
 * same spawn.
 */
function spawnedEnemies(m, ps, { ticks = 3000, want = 6 } = {}) {
  const b = m.newBattle(m._normalOpts(ps));
  b.start();
  const enemies = () => b.units.filter((u) => u.kind === 'enemy');
  for (let i = 0; i < ticks && enemies().length < want && !b.finished; i++) b.step();
  return enemies().map((u) => ({ key: u.defId, maxHp: u.base.maxHp }));
}

test('g.devEnemyHp is a registered C2S message with a validated shape', () => {
  assert.ok(Object.hasOwn(C2S, 'g.devEnemyHp'));
  for (const mul of [1, 5, 20, 100, 1000]) assert.equal(validateC2S({ t: 'g.devEnemyHp', mul }), null);
  assert.ok(validateC2S({ t: 'g.devEnemyHp' }), 'mul is required');
  assert.ok(validateC2S({ t: 'g.devEnemyHp', mul: 0 }));
  assert.ok(validateC2S({ t: 'g.devEnemyHp', mul: -5 }));
  assert.ok(validateC2S({ t: 'g.devEnemyHp', mul: 1.5 }));
  assert.ok(validateC2S({ t: 'g.devEnemyHp', mul: 1001 }));
  assert.ok(validateC2S({ t: 'g.devEnemyHp', mul: '20' }));
});

test('dev off: the intent is refused and every spawn keeps the round\'s own HP scale', () => {
  const h = devMatch(false);
  const ps = h.ps('p_0');
  const before = h.m.wave.spawns.map((s) => (s.mods && s.mods.hpMul != null ? s.mods.hpMul : 1));
  assert.deepEqual(h.m.handle('p_0', { t: 'g.devEnemyHp', mul: 20 }), { error: ERR.BAD_MSG, detail: 'dev mode is off' });
  assert.equal(h.m.devEnemyHpMul, 1, 'a refused intent changes nothing');
  // a battle of a non-dev match gets the wave's own scale, never a multiplier of its own
  assert.equal(h.m._devEnemySpawns(h.m._normalOpts(ps).spawns), null, 'nothing is copied or changed');
  const spawns = h.m._normalOpts(ps).spawns;
  assert.equal(spawns.length, before.length);
  for (let i = 0; i < spawns.length; i++) assert.equal(spawns[i].mods.hpMul ?? 1, before[i]);
  // and the dev-only field is not in its m.private view at all
  assert.equal(h.lastTo('p_0', 'm.private').dev, undefined);
  assert.equal(h.lastTo('p_0', 'm.private').devEnemyHp, undefined);
});

test('dev on: ×20 multiplies the max HP of the enemies a new battle spawns, ×1 restores them', () => {
  const h = devMatch(true);
  const ps = h.ps('p_0');
  const plainSpawns = h.m._normalOpts(ps).spawns;
  const plain = spawnedEnemies(h.m, ps);
  assert.ok(plain.length > 0, 'the round spawns enemies');

  assert.deepEqual(h.m.handle('p_0', { t: 'g.devEnemyHp', mul: 20 }), { ok: true });
  assert.equal(h.m.devEnemyHpMul, 20);
  assert.equal(h.lastTo('p_0', 'm.private').devEnemyHp, 20, 'the client is told the current step');
  const scaled = spawnedEnemies(h.m, ps);
  assert.equal(scaled.length, plain.length, 'the same spawns (same seed)');
  for (let i = 0; i < plain.length; i++) {
    assert.equal(scaled[i].key, plain[i].key, `spawn ${i} is the same enemy`);
    assert.ok(Math.abs(scaled[i].maxHp - plain[i].maxHp * 20) < 1e-6,
      `spawn ${i} (${plain[i].key}): ${scaled[i].maxHp} != ${plain[i].maxHp} × 20`);
  }

  // the same scale goes to a browser that simulates its own field (client-side combat)
  const spec = h.m._ccField({ fieldId: 'n:p_0', kind: 'normal', players: ['p_0'], opts: h.m._normalOpts(ps) }).spec;
  assert.equal(spec.spawns.length, plainSpawns.length);
  for (let i = 0; i < plainSpawns.length; i++) {
    assert.equal(spec.spawns[i].enemyKey, plainSpawns[i].enemyKey);
    assert.equal(spec.spawns[i].mods.hpMul, (plainSpawns[i].mods.hpMul ?? 1) * 20, `spec spawn ${i}`);
  }

  // back to ×1: new enemies are ordinary again
  assert.deepEqual(h.m.handle('p_0', { t: 'g.devEnemyHp', mul: 1 }), { ok: true });
  assert.equal(h.m.devEnemyHpMul, 1);
  assert.equal(h.lastTo('p_0', 'm.private').devEnemyHp, 1);
  const again = spawnedEnemies(h.m, ps);
  assert.deepEqual(again, plain);
  h.invariants();
});

test('dev on: the multiplier combines with the round\'s own HP scale (never replaces it)', () => {
  const h = devMatch(true);
  const ps = h.ps('p_0');
  const spawns = h.m.newBattle(h.m._normalOpts(ps)).opts.spawns;
  const waveHp = h.m.wave.spawns.map((s) => (s.mods && s.mods.hpMul != null ? s.mods.hpMul : 1));
  h.m.handle('p_0', { t: 'g.devEnemyHp', mul: 20 });
  const scaled = h.m.newBattle(h.m._normalOpts(ps)).opts.spawns;
  assert.equal(scaled.length, spawns.length);
  for (let i = 0; i < spawns.length; i++) {
    assert.equal(scaled[i].enemyKey, spawns[i].enemyKey);
    assert.equal(scaled[i].mods.hpMul, (spawns[i].mods.hpMul ?? 1) * 20, `spawn ${i}`);
  }
  // the stored wave is never mutated by the debug multiplier: the next round starts from the round's own scale
  assert.deepEqual(h.m.wave.spawns.map((s) => (s.mods && s.mods.hpMul != null ? s.mods.hpMul : 1)), waveHp);
});
