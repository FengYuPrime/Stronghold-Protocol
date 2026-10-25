// Pith 盟约·辅助干员 (char_616_pithst, chess_char_1_15) — the 侵蚀 (WATER) rider of 迭代元素, on the real battle path.
//
// Live report: after 侵蚀 joined PITHST_ELEMENTS the operator still shows no 水蚀 damage. The sim does attach it — every
// damage she deals adds ep_damage_ratio × ATK to all four gauges — but 神经 is applied first and every gauge fills at the
// same rate, so 神经 reaches 1000 first, bursts, and its 爆发冷却 locks every gauge of the unit (PRTS 元素); when the lock
// ends every gauge resets. Alone she therefore only ever bursts 神经 (docs/history v2.4-playtest5.md) and the official
// single-gauge HUD (`b.snap elem` ← damage.js elementView, the *fullest* gauge) can only ever show 神经. 侵蚀 bursts as
// soon as a teammate has pre-filled its gauge. This test pins that behaviour so it is not mistaken for "not attached".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeBattle, enemyRec } from '../helpers/battleHarness.js';
import { getDefaultSource } from '../../server/sim/simdata.js';
import { PITHST_ELEMENTS } from '../../server/sim/content/kits/ops/chess_char_1_15-pithst.js';
import { KITS } from '../../server/sim/content/kits/index.js';
import { ELEMENTS, ELEMENT_ORDER, ELEMENT_GAUGE_MAX } from '../../server/sim/constants.js';
import { elementView } from '../../server/sim/damage.js';

const BANDS = JSON.parse(readFileSync(new URL('../../data/bands.json', import.meta.url), 'utf8'));
const SRC = getDefaultSource();
const PITH = 'chess_char_1_15_a', PITH_B = 'chess_char_1_15_b';
const defs = { enemies: { enemy_e: enemyRec({ key: 'enemy_e', hp: 1e9, speed: 0 }) } };
const battle = (units, enemies, seed = 5) => makeBattle({ defs, timeLimit: 120, autoFinish: false, seed, units, enemies });
const ratioOf = (id) => SRC.rawChess(id).talents.filter((t) => t.index !== -1)[0].bb.ep_damage_ratio;

test('Pith 侵蚀 on the real path: 侵蚀 fills but never bursts alone, and the HUD shows 神经', () => {
  assert.deepEqual([...PITHST_ELEMENTS], ['neural', 'burn', 'apoptosis', 'erosion']);
  // the path: band_pith grants chess_char_1_15_a, which the kit registers (its `_b` elite reads the same `_a` kit)
  assert.equal(BANDS.band_pith.buffs[0].bbStr.chess, PITH);
  assert.equal(typeof KITS[PITH], 'function');
  assert.equal(KITS[PITH_B], undefined, 'the elite id has no separate entry — registeredKit maps it to _a');

  const h = battle([{ chessId: PITH, row: 10, col: 4 }], [{ key: 'enemy_e', pos: [10, 5] }]);
  const u = h.unit(PITH);
  h.step();
  const e = h.enemy('enemy_e');
  assert.equal(e.gaugeMax, ELEMENT_GAUGE_MAX);

  // one hit attaches 18 % ATK to all four gauges, 侵蚀 included
  const per = u.s.atk * ratioOf(PITH);
  const n0 = e.elem.neural;
  assert.ok(h.runUntil(() => e.elem.neural > n0, 10), 'her attack lands');
  for (const el of PITHST_ELEMENTS) assert.ok(e.elem[el] > 0, `${el} attached`);
  assert.ok(Math.abs(e.elem.erosion - per) < 1e-6, '侵蚀 = 18 % ATK');

  // every burst alone is 神经; 侵蚀 tops out one hit short of its gauge and never bursts
  let maxErosion = 0;
  const shown = new Set();
  for (let i = 0; i < 120 * 20 && !h.b.finished; i++) {
    h.b.step();
    if (e.elem.erosion > maxErosion) maxErosion = e.elem.erosion;
    const v = elementView(e, h.b.time);
    if (v) shown.add(v[0]);
  }
  const bursts = h.hooksOf('elementBurst').filter((c) => c.target === e);
  assert.ok(bursts.length >= 2, `she bursts repeatedly (${bursts.length})`);
  assert.deepEqual([...new Set(bursts.map((c) => c.element))], ['neural'], 'alone: only 神经 bursts');
  assert.equal(bursts.filter((c) => c.element === 'erosion').length, 0, '侵蚀 never bursts solo');
  // 侵蚀 is left exactly one hit short of 1000: (hits − 1) × 18 % ATK, because the 神经 burst locks the loop's tail
  assert.ok(maxErosion < ELEMENT_GAUGE_MAX, `侵蚀 stays below the gauge (${maxErosion})`);
  assert.ok(maxErosion >= ELEMENT_GAUGE_MAX - 2 * per, `侵蚀 fills to one hit short (${maxErosion})`);

  // the official HUD is the single fullest gauge (ties by element id 神经 < 侵蚀 < 灼燃 < 凋亡): always 神经 here —
  // 侵蚀 is attached on the target but is never the one the client is sent
  assert.deepEqual([...ELEMENTS].sort(), [...ELEMENT_ORDER].sort(), 'every gauge has a client icon');
  assert.deepEqual([...shown], ['neural'], `b.snap elem never shows 侵蚀 (${[...shown]})`);
});

test('Pith 侵蚀 bursts once a teammate pre-fills its gauge — and then the HUD shows the water icon', () => {
  const h = battle([{ chessId: PITH, row: 10, col: 4 }], [{ key: 'enemy_e', pos: [10, 8] }]);
  const u = h.unit(PITH);
  h.step();
  const e = h.enemy('enemy_e');
  for (const k of Object.keys(e.elem)) e.elem[k] = 0;
  e.elem.erosion = 950; // e.g. another 侵蚀 source built it up
  assert.equal(elementView(e, h.b.time)[0], 'erosion', 'the HUD shows the fullest gauge (水蚀)');
  h.b.dealDamage(u, e, { amount: 100, type: 'arts', canDodge: false });
  const bursts = h.hooksOf('elementBurst').filter((c) => c.target === e);
  assert.equal(bursts.length, 1, '侵蚀 bursts');
  assert.equal(bursts[0].element, 'erosion');
  // 神经 is still applied first (it filled before 侵蚀 burst and the lock then froze it), so it did attach
  assert.ok(e.elem.neural > 0, '神经 attached before the 侵蚀 burst');
});
