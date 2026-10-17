// test/render/vfx-effect-root-offset.test.js — where a prefab's root sits (render/vfx/effect.js `_matrices`, DESIGN
// §33.11 `_spawnLocation`): the client sets the effect's root transform to its spawn point (`Effect._InitLocationFromEntity`),
// so a prefab whose root is the `ParticleEffect` and that declares a spawn location is drawn AT that point — the offset it
// was authored at is the extraction's editor layout. 黍's talent ring `shu_talent_buff_01` (root [-1.94, -1, 0],
// `_spawnLocation` 5 GROUND_CENTER) was drawn 2.2 tiles off her feet; its control group (`shu_skill_03_range`,
// `shu_birth_01`) is authored at [0, 0, 0]. Headless, fake descriptors (style of vfx-effect.test.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileEffect, Effect } from '../../public/js/render/vfx/effect.js';

const pe = (fields) => ({ class: 'ParticleEffect', enabled: true, fields: { _spawnLocation: 5, _isLoop: 0, _delayToPlay: 0, _delayToFinish: 0, _maxLifetime: -1, ...fields } });
const root = (pos = [0, 0, 0], behaviours = []) => ({ id: 0, name: 'root', parent: null, children: [1], active: true, pos, rot: [0, 0, 0, 1], scale: [1, 1, 1], behaviours });
const child = (pos = [0.5, 0, 0], behaviours = []) => ({ id: 1, name: 'ps', parent: 0, children: [], active: true, pos, rot: [0, 0, 0, 1], scale: [1, 1, 1], behaviours });
const desc = (nodes) => ({ format: 'fx-prefab', version: 1, key: 'test', nodes, materials: [], clips: [], textures: [], meshes: [], refs: [], stats: {} });

/** A placed instance, updated once so its world matrices exist. */
function placed(nodes, pos = [2, 3, 0]) {
  const fx = new Effect(compileEffect(desc(nodes)), { seed: 1 }).place({ pos });
  fx.update(1 / 30);
  return fx;
}
const at = (fx, i) => [fx.world[i][12], fx.world[i][13], fx.world[i][14]];
/** A node's world position at a point (the local TRS is float32: a tolerance, not deepEqual). */
function near(actual, expected, msg = '') {
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(actual[i] - expected[i]) < 1e-5, `${msg} [${actual}] vs [${expected}]`);
}

test('a root ParticleEffect with a spawn location sits at the anchor, not at anchor + its authored offset', () => {
  // the shape of shu_talent_buff_01: the root IS the ParticleEffect, offset [-1.94, -1, 0], _spawnLocation 5
  const fx = placed([root([-1.94, -1, 0], [pe({})]), child()]);
  near(at(fx, 0), [2, 3, 0], 'the root at the anchor');
  near(at(fx, 1), [2.5, 3, 0], 'its children follow it');
});

test('unchanged: a root authored at [0, 0, 0] is at the anchor (the control group shu_skill_03_range, shu_birth_01)', () => {
  const fx = placed([root([0, 0, 0], [pe({})]), child()]);
  near(at(fx, 0), [2, 3, 0]);
  near(at(fx, 1), [2.5, 3, 0]);
});

test('unchanged: a prefab with `_spawnLocation` NONE (0) keeps its authored root offset', () => {
  const fx = placed([root([0.4, -0.2, 0], [pe({ _spawnLocation: 0 })]), child()]);
  near(at(fx, 0), [2.4, 2.8, 0]);
  near(at(fx, 1), [2.9, 2.8, 0]);
});

test('unchanged: the root offset is kept when the ParticleEffect is not the root node', () => {
  // the 253 root-offset prefabs without a root ParticleEffect (projectile / trail only) are placed by their flight
  const fx = placed([root([0.4, 0, 0]), child([0.5, 0, 0], [pe({})])]);
  near(at(fx, 0), [2.4, 3, 0]);
  near(at(fx, 1), [2.9, 3, 0]);
});

test('only the authored pose is dropped: what a clip animates on top of it is kept', () => {
  const fx = placed([root([-1.94, -1, 0], [pe({})]), child()]);
  const def = fx.def;
  fx.loc[0] = def.base[0] + 0.25;   // a clip's m_LocalPositionX curve, a quarter of a tile off the authored pose
  fx.loc[1] = def.base[1] - 0.5;
  fx.update(1 / 30);
  near(at(fx, 0), [2.25, 2.5, 0]);
});
