// test/render/vfx-swire2.test.js — 琳琅诗怀雅 S2's champagne bomb has its official effect: her kit places the token in a
// 'tick' hook and sends only a 'summon' fx (chess_char_3_04-swire2.js installS2), while the cast row of the mode's
// SpawnTokenOnTileByIDAbility (index.json units.char_1033_swire2.modes[2].attack.abilities[0].cast[0] →
// swire2_skill_02_start, ON_CAST_START) rides no 'atk' event — a throw is no attack, so pickAttacks never picks it.
// FX_BINDINGS binds the summon to that row at the bomb's tile, once, turned by her side; the row belongs to her own
// animation, so a worn outfit's hook (换装, wiring.skinKey: char_1033_swire2@ambiencesynesthesia#4 replaces it, vfx-skins)
// plays its own prefab. On a synthetic index and a fake effects layer, as the other bindings' tests.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FxWiring } from '../../public/js/render/vfx/wiring.js';
import { FX_BINDINGS, bindingEffects, bindingKeys } from '../../public/js/render/vfx/skills.js';
import { setIndexVersion } from '../../public/js/render/vfx/mounts.js';

setIndexVersion(2);   // as FxLibrary.index() does once index.json is in: no skinShift on the points

const HER = 'char_1033_swire2';
const TOKEN = 'token_10031_swire2_gdtrap';
const OUTFIT = `${HER}@ambiencesynesthesia#4`;
const THROW = 'swire2_skill_02_start';                 // modes[2].attack.abilities[0].cast[0]
const THROW_OUTFIT = `${THROW}_ambiencesynesthesia#4`;  // skinFx[OUTFIT].replace
const BIRTH = 'token_swire2_birth_01_start';            // units[TOKEN].startEffect (not the row bound here)
const RANGE = 'swire2_skill_02_range';
const PREFABS = { [THROW]: { spawn: 1 }, [THROW_OUTFIT]: { spawn: 1 }, [BIRTH]: { spawn: 1 }, [RANGE]: { spawn: 2, isLoop: true } };

/** index.json's row shape (a mode's attack cast / hit row). */
const row = (effects, startEvent = 2) => ({
  directionType: 0, effects, oneshot: 0, startEvent, endEvent: 3, onlyOnce: 0, useFourDirectionalFace: 0,
  delayIfFirstAttack: 0, hookEffectAfterFirstAttack: '',
});

/** Her three mode attacks: S2's is the composite (a selectable group whose trigger spawns the token), as in index.json. */
const MODES = [
  { name: 'Default', attack: { class: 'MeleeAttack', cast: [row(['swire2_attack_01_start'])], hit: [] } },
  { name: 'S1', attack: { class: 'MeleeAttack', cast: [], hit: [] } },
  {
    name: 'S2',
    attack: {
      class: 'AbilitySelectableGroup', select: { method: 'trigger' },
      abilities: [
        { class: 'SpawnTokenOnTileByIDAbility', node: 'Modes/S2/Body/Trigger/SpawnToken', cast: [row([THROW])], hit: [] },
        { class: 'MeleeAttack', node: 'Modes/S2/Body/Trigger/Attack', cast: [row(['swire2_attack_01_start'])], hit: [] },
      ],
    },
  },
];

function makeIndex() {
  const skills = {
    skchr_swire2_2: {
      rootClass: 'AppearSkill', rootAbility: 'ActiveBuffAbility', mode: 2, projectiles: [], effects: [RANGE],
      uses: [{ role: 'loop', keys: [RANGE], from: 'ActiveBuffAbility._buffs', node: 'skchr_swire2_2', on: 'owner', buff: 'swire2_skill_on' }],
    },
  };
  return {
    version: 3,
    units: {
      [HER]: { kind: 'char', skin: HER, modes: MODES, skills, startEffect: null, deadEffect: null },
      [TOKEN]: { kind: 'char', skin: TOKEN, modes: [], skills: {}, startEffect: BIRTH, deadEffect: null },
    },
    skills, projectiles: {},
    skins: { [HER]: {}, [TOKEN]: {} },
    skinFx: { [OUTFIT]: { replace: { [THROW]: THROW_OUTFIT } } },
    generic: { hit: {}, die: {}, birth: {}, status: {} },
    prefabs: {},
  };
}

/** A battle view (the shape render/vfx reads: board feet, facing, `info` with the worn skin). */
const viewOf = (id, key, x, y, o = {}) => ({
  id, x, y, z: 0, visFacing: o.visFacing ?? 1, alive: true, destroyed: false, flags: 0, sp: 0, spMax: 10,
  info: { id, spine: key, defId: key, side: 'ally', kind: 'op', skillIndex: 0, skin: o.skin ?? null },
});

async function setup() {
  const index = makeIndex();
  const spawned = [];
  const ofx = {
    active: true, time: 0, lite: false,
    lib: {
      has: (k) => k in PREFABS,
      def: (k) => (k in PREFABS ? { key: k, ...PREFABS[k] } : null),
      index: async () => index, preload: async (keys) => keys.length, defs: new Map(),
    },
    spawn(key, place, opts) {
      const h = { key, place, opts, stopped: false, get alive() { return !this.stopped; }, stop() { this.stopped = true; } };
      spawned.push(h);
      return h;
    },
  };
  const rec = { charId: HER, skill: { skillId: 'skchr_swire2_2', index: 0, skillType: 'PASSIVE', durationType: 'NONE', duration: 0, bb: {} } };
  const views = new Map();
  const w = new FxWiring(ofx, { speed: () => 10, record: (info) => (info.defId === HER ? rec : null), view: (id) => views.get(id) || null });
  await w.ready();
  const view = (id, key, x, y, o = {}) => { const v = viewOf(id, key, x, y, o); views.set(id, v); return v; };
  const frame = (dt = 1 / 30) => { w.sync(views.values()); w.tick(); ofx.time += dt; };
  return { w, ofx, spawned, index, view, frame };
}

/** The kit's tuple: battle.fx('summon', { x: bomb.x, y: bomb.y, id: bomb.id, src: her.id, token, coins }). */
const placed = (bombId, herId, bomb) => ({ id: bombId, src: herId, token: TOKEN, coins: 2, ...bomb });

describe("琳琅诗怀雅 S2's bomb (FX_BINDINGS)", () => {
  test("the binding: the summon plays modes[2].attack.abilities[0].cast[0]'s key, once, with the outfit's hook", () => {
    const idx = makeIndex();
    const bind = FX_BINDINGS.skchr_swire2_2.summon;
    assert.deepEqual(Object.keys(FX_BINDINGS.skchr_swire2_2), ['summon'], 'nothing else of the skill is bound');
    assert.equal(bind.owner, 'src', 'the kit names her as the fx\'s src, the bomb as its id');
    assert.equal(bind.at, 'target', 'once, at the fx\'s point (no extra.target), turned by her side');
    assert.equal(bind.skin, true, 'a row of her own animation: her outfit replaces it');
    assert.deepEqual(bindingEffects(idx, bind), [THROW]);
    assert.deepEqual(bindingKeys(idx, 'skchr_swire2_2'), [THROW], 'preloaded with her skill');
    // the other operators' bindings play their keys as they stand
    assert.equal(FX_BINDINGS.skchr_bubble_2.counter.skin, undefined);
    assert.equal(FX_BINDINGS.skchr_blkkgt_3.slash.skin, undefined);
  });

  test('the bomb\'s summon plays the official throw at its tile; another skill\'s summon is not ours', async () => {
    const { w, spawned, view, frame } = await setup();
    const her = view(1, HER, 4, 10);
    view(2, TOKEN, 5, 12);
    frame();
    assert.equal(w.simFx('summon', 5, 12, placed(2, 1)), true, 'the client\'s throw stands for the kit\'s summon');
    assert.deepEqual(spawned.map((h) => h.key), [THROW]);
    assert.equal(spawned[0].opts.loop, false, 'a one-shot prefab, never held as a loop');
    // at the bomb's tile: one tile further right moves the effect by one tile
    const first = spawned[0].place.pos.slice(0, 2);
    assert.equal(w.simFx('summon', 6, 12, placed(2, 1)), true);
    const second = spawned[1].place.pos.slice(0, 2);
    assert.ok(Math.abs((second[0] - first[0]) - 1) < 1e-6, 'the throw follows the fx\'s point');
    assert.equal(second[1], first[1], 'the same row');
    // the fx of a unit whose skill binds no summon keeps the procedural pillar
    const other = view(3, 'char_900_other', 7, 10);
    frame();
    assert.equal(w.simFx('summon', 7, 10, { id: 3, src: 3, token: 'token_900' }), false, 'nothing bound for her');
    assert.equal(spawned.length, 2);
    her.alive = true; other.alive = true;
  });

  test('a worn outfit plays its own throw, at the same tile; no outfit keeps the base key', async () => {
    const plain = await setup();
    plain.view(1, HER, 4, 10);
    plain.frame();
    assert.equal(plain.w.simFx('summon', 5, 12, placed(2, 1)), true);
    const wear = await setup();
    wear.view(1, HER, 4, 10, { skin: OUTFIT });
    wear.frame();
    assert.equal(wear.w.simFx('summon', 5, 12, placed(2, 1)), true);
    assert.deepEqual(plain.spawned.map((h) => h.key), [THROW]);
    assert.deepEqual(wear.spawned.map((h) => h.key), [THROW_OUTFIT]);
    assert.deepEqual(wear.spawned[0].place.pos.slice(0, 2), plain.spawned[0].place.pos.slice(0, 2), 'the same point');
  });

  test('the outfit\'s key loads with the battle; its absence keeps the base key', async () => {
    const { w, ofx, spawned, view, frame } = await setup();
    const her = view(1, HER, 4, 10, { skin: OUTFIT });
    view(2, TOKEN, 5, 12);
    const keys = w.keysFor([her]);
    assert.ok(keys.includes(THROW), 'the row');
    assert.ok(keys.includes(THROW_OUTFIT), 'the outfit\'s replacement');
    frame();
    // an outfit whose replacement the extraction does not hold (not installed here) keeps the base key
    const saved = ofx.lib.def;
    ofx.lib.has = (k) => k in PREFABS && k !== THROW_OUTFIT;
    ofx.lib.def = (k) => (ofx.lib.has(k) ? saved(k) : null);
    assert.equal(w.simFx('summon', 5, 12, placed(2, 1)), true);
    assert.deepEqual(spawned.map((h) => h.key), [THROW]);
  });

  test('with the layer off, nothing is played (the kit fx stays procedural)', async () => {
    const { w, ofx, spawned, view, frame } = await setup();
    view(1, HER, 4, 10);
    frame();
    ofx.active = false;
    assert.equal(w.simFx('summon', 5, 12, placed(2, 1)), false);
    assert.deepEqual(spawned, []);
  });
});
