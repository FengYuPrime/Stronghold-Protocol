// test/render/vfx-skins.test.js — the outfits' official effects (换装; DESIGN §33.12 Skin hook): a worn outfit
// (render/app.js liveInfo fills `info.skin`, ui/skins.js) plays the prefabs its battle skin names in place of the unit's
// own (index.json `skinFx[skin].replace`, tools/local-extract/fx.py skin_hooks — the client's
// Torappu.Battle.CharacterSkinHooker `_replaceEffectPairs`), and its own mount points place them
// (index.json `skinFx[skin].points`). A unit with no outfit, an outfit the extraction has no hooks for and a hook whose
// replacement is not installed all keep the base key and the unit's own skin.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FxWiring } from '../../public/js/render/vfx/wiring.js';
import { setIndexVersion } from '../../public/js/render/vfx/mounts.js';

setIndexVersion(2);   // as FxLibrary.index() does once index.json is in: no skinShift on the points

const BASE = { source: 'chararts/kalts.ab defaultskin', points: { HitPoint: { front: { pos: [1, 0.5, 0] } } } };
const OUTFIT = {
  source: 'skinpack/char_003_kalts.ab char_003_kalts_boc#6',
  replace: { 'kalts_attack_01_hit': 'kalts_attack_01_hit_boc#6' },
  points: { HitPoint: { front: { pos: [2, 1.5, 0] } } },
};
const DEFS = {
  kalts_attack_01_hit: { spawn: 2 },
  'kalts_attack_01_hit_boc#6': { spawn: 2 },
};

function makeIndex() {
  return {
    version: 3,
    units: {
      char_003_kalts: {
        kind: 'char', skin: 'char_003_kalts', skills: {},
        modes: [{ name: 'Default', attack: { class: 'MeleeAttack', cast: [{ effects: ['kalts_attack_01_hit'], oneshot: 1, startEvent: 4, endEvent: 3 }] } }],
      },
    },
    skills: {}, projectiles: {},
    skins: { char_003_kalts: BASE },
    skinFx: { 'char_003_kalts@boc#6': OUTFIT },
    generic: { hit: {}, die: {}, birth: {}, status: {} },
    prefabs: {},
  };
}

function makeWiring() {
  const index = makeIndex();
  const spawned = [];
  const ofx = {
    active: true, time: 0, ctx: { cam: () => ({ tilt: 30 }) },
    lib: {
      index: async () => index, preload: async (keys) => keys.length, defs: new Map(),
      has: (k) => k in DEFS, def: (k) => (k in DEFS ? { key: k, ...DEFS[k] } : null),
    },
    spawn(key, place, opts) { const h = { key, place, opts }; spawned.push(h); return h; },
  };
  const w = new FxWiring(ofx, { speed: () => 10, record: () => null, view: () => null });
  return { w, spawned, index, ofx };
}

/** A battle view (the shape render/vfx reads: board feet, facing, `info` with the worn skin). */
const view = (id, skin) => ({
  id, x: 1, y: 2, z: 0, visFacing: 1, alive: true, destroyed: false,
  info: { id, spine: 'char_003_kalts', defId: 'char_003_kalts', side: 'ally', kind: 'op', skin },
});

describe("the outfits' effects (换装)", () => {
  test('a worn outfit plays its own prefab, placed on the outfit\'s mount point', async () => {
    const { w, spawned } = makeWiring();
    await w.ready();
    assert.ok(w.playOn('kalts_attack_01_hit', view(1, 'char_003_kalts@boc#6'), {}));
    assert.equal(spawned[0].key, 'kalts_attack_01_hit_boc#6');
    // the outfit's HitPoint (2, 1.5) on a view at (1, 2): board (x − 10, y − 9)
    assert.deepEqual(spawned[0].place.pos.slice(0, 2), [-7, -5.5]);
  });

  test('no outfit, an outfit without hooks and a missing replacement all keep the base key and skin', async () => {
    const { w, spawned } = makeWiring();
    await w.ready();
    for (const skin of [null, 'char_003_kalts@epoque#1', 'char_003_kalts@unknown#9']) {
      assert.ok(w.playOn('kalts_attack_01_hit', view(1, skin), {}));
      assert.equal(spawned.at(-1).key, 'kalts_attack_01_hit', `skin ${skin}`);
      assert.deepEqual(spawned.at(-1).place.pos.slice(0, 2), [-8, -6.5], `skin ${skin}`);
    }
  });

  test('a hook whose replacement the extraction does not hold keeps the base key', async () => {
    const { w, spawned, index } = makeWiring();
    await w.ready();
    index.skinFx['char_lob@x#1'] = { replace: { kalts_attack_01_hit: 'not_in_the_set' }, points: OUTFIT.points };
    assert.ok(w.playOn('kalts_attack_01_hit', view(1, 'char_lob@x#1'), {}));
    assert.equal(spawned.at(-1).key, 'kalts_attack_01_hit');
    assert.deepEqual(spawned.at(-1).place.pos.slice(0, 2), [-7, -5.5], "the outfit's own points still place it");
  });

  test('skinFxOf / skinKey read the worn skin only', async () => {
    const { w } = makeWiring();
    await w.ready();
    assert.deepEqual(w.skinFxOf(view(1, 'char_003_kalts@boc#6')), OUTFIT);
    assert.equal(w.skinFxOf(view(1, null)), null);
    assert.equal(w.skinFxOf({ id: 1, info: { id: 1 } }), null);
    assert.equal(w.skinKey(view(1, 'char_003_kalts@boc#6'), 'kalts_attack_01_hit'), 'kalts_attack_01_hit_boc#6');
    assert.equal(w.skinKey(view(1, 'char_003_kalts@boc#6'), 'other'), 'other');
    assert.equal(w.skinOfView(view(1, 'char_003_kalts@boc#6')), OUTFIT);
    assert.equal(w.skinOfView(view(1, null)), BASE);
  });

  test('the battle preloads the worn outfits\' prefabs too', async () => {
    const { w } = makeWiring();
    await w.ready();
    const infos = [{ id: 1, info: { id: 1, spine: 'char_003_kalts', skin: 'char_003_kalts@boc#6' } }];
    assert.ok(w.keysFor(infos).includes('kalts_attack_01_hit_boc#6'));
    assert.ok(w.keysFor(infos).includes('kalts_attack_01_hit'), 'the base key stays (other units share it)');
  });
});
