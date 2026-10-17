// test/render/vfx-shu-cross.test.js — 黍 S3 离离枯荣's sowing has its official effect. Her kit sends one 'fx' tuple per
// sowing — `battle.fx('healField', { x, y, id })` on the healed unit's tile (server/sim/content/kits/ops/op-shu.js sow) —
// while T1 百谷长青 sows that tile and the four next to it (the kit's SOW: a cross of five). The client draws the
// one-tile ground decal `shu_talent_buff_02` there (index.json prefabs: spawn 5, a 2 s looping clip), so FX_BINDINGS
// binds the fx to that key at 'point' and the binding plays one copy per tile offset (`tiles`: skills.js SOW_TILES,
// skillfx.js `_bound`). The key is a prefab of her own effects, and her outfits replace it (换装: wiring.skinKey —
// char_2025_shu@nian#11 plays shu_talent_buff_02_nian#11), so `skin` makes a worn outfit play its variant.
// A sow lasts until she leaves the field (op-shu.js clears her sown set on death / retreat, never by time), so the decal
// is held for the owner's lifetime (`hold: 'owner'`: skillfx.js `_bound` → `U.decals` → `_releaseU`) and is no longer
// capped by them: `decal` keeps it out of OfficialFx's effects budget (system.js `_room`).
// On a synthetic index and a fake effects layer, as the other bindings' tests (vfx-swire2, vfx-blaze2-s3).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FxWiring } from '../../public/js/render/vfx/wiring.js';
import { FX_BINDINGS, bindingEffects, bindingKeys } from '../../public/js/render/vfx/skills.js';
import { setIndexVersion } from '../../public/js/render/vfx/mounts.js';
import { OfficialFx, MAX_EFFECTS, MAX_PARTICLES } from '../../public/js/render/vfx/system.js';

setIndexVersion(2);   // as FxLibrary.index() does once index.json is in: no skinShift on the points

const HER = 'char_2025_shu';
const S1 = 'skchr_shu_1', S3 = 'skchr_shu_3';
const OUTFIT = `${HER}@nian#11`;
const DECAL = 'shu_talent_buff_02';                      // the client's one-tile ground decal
const DECAL_OUTFIT = `${DECAL}_nian#11`;                 // skinFx[OUTFIT].replace
const BUFF = 'shu_skill_03_buff';                        // the S3 plan's only row (index.json: uses[0].keys)
const PREFABS = { [DECAL]: { spawn: 5, isLoop: true }, [DECAL_OUTFIT]: { spawn: 5, isLoop: true }, [BUFF]: { spawn: 1, isLoop: true } };
/** T1's sowing in board offsets [dx, dy] (the kit's SOW, [dr, dc] there): the tile and the four next to it. */
const CROSS = ['0,0', '1,0', '-1,0', '0,1', '0,-1'];
/** The same five, in the order the offset helper sorts them (string order). */
const CROSS_SET = [...CROSS].sort();

/** index.json's row shape (a mode's attack cast row). */
const row = (effects) => ({
  directionType: 0, effects, oneshot: 1, startEvent: 2, endEvent: 3, onlyOnce: 0, useFourDirectionalFace: 0,
  delayIfFirstAttack: 0, hookEffectAfterFirstAttack: '',
});

/** Her modes: the Default melee attack, S1 and S3 as index.json lists them (S3's plan is a looping buff use). */
const MODES = [
  { name: 'Default', attack: { class: 'MeleeAttack', cast: [row(['shu_attack_start'])], hit: [] } },
  { name: 'S1', attack: { class: 'MeleeAttack', cast: [row(['shu_skill_01_start'])], hit: [] } },
  { name: 'S3', attack: { class: 'MeleeAttack', cast: [row(['shu_skill_03_attack_start'])], hit: [row(['shu_skill_03_attack_hit'])] } },
];

function makeIndex() {
  const skills = {
    [S3]: {
      rootClass: 'CastSkill', rootAbility: 'ActiveBuffAbility', mode: 2, effects: [BUFF], projectiles: [],
      uses: [{ role: 'loop', keys: [BUFF], from: 'ActiveBuffAbility._buffs', node: S3, on: 'owner', buff: 'shu_s_3' }],
    },
    [S1]: {
      rootClass: 'AutoSkill', rootAbility: 'ActiveBuffAbility', mode: 1, effects: [], projectiles: [],
      uses: [{ role: 'loop', keys: ['shu_skill_01_start'], from: 'ActiveBuffAbility._buffs', node: S1, on: 'owner', buff: 'shu_s_1' }],
    },
  };
  return {
    version: 3,
    units: { [HER]: { kind: 'char', skin: HER, modes: MODES, skills, startEffect: null, deadEffect: null } },
    skills, projectiles: {},
    skins: { [HER]: {} },
    skinFx: { [OUTFIT]: { replace: { [DECAL]: DECAL_OUTFIT } } },
    generic: { hit: {}, die: {}, birth: {}, status: {} },
    prefabs: {},
  };
}

/** A battle view (the shape render/vfx reads: board feet, facing, `info` with the worn skin). */
const viewOf = (id, key, x, y, o = {}) => ({
  id, x, y, z: 0, visFacing: o.visFacing ?? 1, alive: true, destroyed: false, flags: 0, sp: 0, spMax: 10,
  info: { id, spine: key, defId: key, side: 'ally', kind: 'op', skillIndex: o.skillIndex ?? 2, skin: o.skin ?? null },
});

async function setup({ skill = S3 } = {}) {
  const index = makeIndex();
  const spawned = [];
  const ofx = {
    active: true, time: 0, lite: false, tier: 'full', timers: [],
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
  const rec = { charId: HER, skill: { skillId: skill, index: 2, skillType: 'MANUAL', durationType: 'TIME', duration: 30, bb: {} } };
  const views = new Map();
  const w = new FxWiring(ofx, { speed: () => 10, record: (info) => (info?.defId === HER ? rec : null), view: (id) => views.get(id) || null });
  await w.ready();
  const view = (id, key, x, y, o = {}) => { const v = viewOf(id, key, x, y, o); views.set(id, v); return v; };
  const frame = (dt = 1 / 30) => { w.sync(views.values()); w.tick(); ofx.time += dt; };
  return { w, ofx, spawned, index, view, frame };
}

/** The kit's tuple: battle.fx('healField', { x: col, y: row, id: her }). */
const sown = (id, col, row) => ({ x: col, y: row, id });

/** The board offsets [dx, dy] of the spawns relative to their first (the fx's own point). */
const offsetsOf = (spawned) => {
  const [ox, oy] = spawned[0].place.pos;
  return spawned.map((h) => `${Math.round(h.place.pos[0] - ox)},${Math.round(h.place.pos[1] - oy)}`).sort();
};

describe("黍 S3's sown tiles (FX_BINDINGS)", () => {
  test('the binding: the healField plays shu_talent_buff_02 at the point, on the five tiles of SOW, with the outfit\'s hook', () => {
    const idx = makeIndex();
    const bind = FX_BINDINGS[S3].healField;
    assert.deepEqual(Object.keys(FX_BINDINGS[S3]), ['healField'], 'nothing else of the skill is bound');
    assert.equal(bind.owner, 'id', 'the kit names her as the fx\'s id (the healed unit\'s tile is the point)');
    assert.equal(bind.at, 'point', 'on the ground at the fx\'s (x, y)');
    assert.deepEqual(bind.tiles.map(([dx, dy]) => `${dx},${dy}`), CROSS, 'the four next to the healed unit\'s tile too');
    assert.equal(bind.skin, true, 'her outfits replace the decal: a worn one plays its variant');
    assert.equal(bind.during, undefined, 'the sowing is T1\'s, not the skill\'s: it plays whenever she heals');
    assert.equal(bind.hold, 'owner', 'a sow lasts until she leaves the field: held for her lifetime, not a fixed time');
    assert.equal(bind.holdS, undefined, 'no time limit of its own');
    assert.equal(bind.decal, true, 'a ground decal: outside the effects budget (system.js MAX_EFFECTS)');
    assert.deepEqual(bindingEffects(idx, bind), [DECAL]);
    assert.deepEqual(bindingKeys(idx, S3), [DECAL], 'preloaded with her skill');
    // the other operators' bindings have no `tiles`: one copy at the point they bind
    assert.equal(FX_BINDINGS.skchr_tinman_1.zone.tiles, undefined);
    assert.equal(FX_BINDINGS.skchr_podego_2.zone.tiles, undefined);
  });

  test('one healField ⇒ five decals, on the fx\'s tile and its four neighbours, held as loops', async () => {
    const { w, spawned, view, frame } = await setup();
    view(1, HER, 5, 10);
    frame();
    assert.equal(w.simFx('healField', 7, 9, sown(1, 7, 9)), true, 'the client\'s decal stands for the kit\'s sowing');
    assert.equal(spawned.length, 5, 'the five tiles of the cross');
    assert.deepEqual(spawned.map((h) => h.key), [DECAL, DECAL, DECAL, DECAL, DECAL]);
    assert.deepEqual(offsetsOf(spawned), CROSS_SET, 'the centre and its four neighbours, in board tiles');
    // the decal is where the sim said (the healed unit's tile), not at her feet: mounts.js unitPoint is (x − 10, y − 9)
    assert.deepEqual(spawned[0].place.pos.slice(0, 2).map((n) => Math.round(n)), [-3, 0]);
    assert.deepEqual(spawned.map((h) => [h.opts.loop, h.opts.important]), [[true, true], [true, true], [true, true], [true, true], [true, true]],
      'a looping ground decal, held');
    assert.equal(spawned[0].opts.owner.id, 'fx:point', 'placed on a ground point, not on her');
  });

  test('the decals stay past the old 5 s hold and past the prefab\'s clip, until she leaves the field', async () => {
    const { w, ofx, spawned, view, frame } = await setup();
    const her = view(1, HER, 5, 10);
    frame();
    assert.equal(w.simFx('healField', 7, 9, sown(1, 7, 9)), true);
    for (let i = 0; i < 60; i++) frame();          // 2 s: the prefab's own clip is over, the decal is not
    assert.equal(spawned.filter((h) => h.alive).length, 5, 'held past its clip');
    for (let i = 0; i < 150; i++) frame();         // past the old 5 s hold
    assert.ok(ofx.time > 6);
    assert.equal(spawned.filter((h) => h.alive).length, 5, 'a sow is no time: the decal stays while she stands');
    for (let i = 0; i < 300; i++) frame();         // 15 s
    assert.equal(spawned.filter((h) => h.alive).length, 5, 'still there');
    assert.equal(w.skills.marks.length, 0, 'no timed mark: a permanent one would keep every `during` binding of hers on');
    assert.deepEqual(w.skills.of(her).decals.length, 5, 'the unit holds them');
    // she leaves the field: death / retreat / leak (render/app.js → FxWiring.release) stops her sown decals
    her.alive = false;
    frame();
    assert.equal(spawned.filter((h) => h.alive).length, 0, 'cleared with her, as the sim clears her sown tiles');
    assert.equal(w.skills.of(her).decals.length, 0);
  });

  test('every sowing lays five more: the decals accumulate with no count limit and no repeat is dropped', async () => {
    const { w, spawned, view, frame } = await setup();
    view(1, HER, 5, 10);
    frame();
    let tiles = 0;
    for (let i = 0; i < 25; i++) {                 // 25 crosses = 125 decals, well over MAX_EFFECTS.full / 4
      assert.equal(w.simFx('healField', 3 + (i % 10), 6 + (i % 3), sown(1, 3, 6)), true, `sow #${i}`);
      tiles += 5;
      frame();
    }
    assert.equal(spawned.length, tiles, 'five decals per sowing, none dropped');
    assert.equal(spawned.filter((h) => h.alive).length, tiles, 'and all of them still there');
    assert.deepEqual([...new Set(spawned.map((h) => h.opts.decal))], [true], 'each one asks for the decal budget');
    // the same tile sown again: another decal there (refresh / stack, never "already sown")
    assert.equal(w.simFx('healField', 4, 6, sown(1, 4, 6)), true);
    assert.equal(spawned.length, tiles + 5, 'a repeated cross lays its five again');
  });

  test('a ground decal is outside MAX_EFFECTS, so the battle\'s own one-shots keep their budget', () => {
    /** A bare OfficialFx (no renderer): only what `spawn`'s cap and the decal pool read. */
    const bare = (tier = 'full') => Object.assign(Object.create(OfficialFx.prototype), {
      tier, unsupported: false, effects: [], pending: [], dropped: 0, particles: 0, plain: 0, time: 0, seed: 1,
      lib: { available: true, has: () => true, def: () => null, defs: new Map(), load: () => new Promise(() => {}) },
    });
    const many = bare('full');
    for (let i = 0; i < MAX_EFFECTS.full * 2; i++) many.effects.push({ decal: true, def: { loops: true } });
    many.plain = 0;                                 // what update() recomputes: only decals are live
    assert.equal(many._room(), true, `${MAX_EFFECTS.full * 2} decals do not use up the tier's ${MAX_EFFECTS.full}`);
    assert.ok(many.spawn('common_hit_01', { pos: [0, 0, 0] }, {}), 'a one-shot still starts');
    assert.equal(many.dropped, 0);
    // the same number of effects that are no decals does fill the budget
    const full = bare('full');
    for (let i = 0; i < MAX_EFFECTS.full; i++) full.effects.push({ decal: false, def: { loops: true } });
    full.plain = MAX_EFFECTS.full;
    assert.equal(full._room(), false);
    assert.equal(full.spawn('common_hit_01', { pos: [0, 0, 0] }, {}), null);
    assert.equal(full.dropped, 1);
    // _add counts a decal in the pool but not against the cap
    const counted = bare('lite');
    counted._add({ decal: true, def: { loops: true }, kill() {} });
    assert.equal(counted.plain, 0, 'a decal is not counted');
    counted._add({ decal: false, def: { loops: true }, kill() {} });
    assert.equal(counted.plain, 1, 'another effect is');
    // the particle sum is unchanged by the decal pool
    const parts = bare('full');
    parts.particles = MAX_PARTICLES.full;
    assert.equal(parts._room(), false, 'the particle cap still holds');
  });

  test('another sowing plays five more, on its own cross', async () => {
    const { w, spawned, view, frame } = await setup();
    view(1, HER, 5, 10);
    frame();
    assert.equal(w.simFx('healField', 7, 9, sown(1, 7, 9)), true);
    for (let i = 0; i < 120; i++) frame();
    assert.equal(w.simFx('healField', 5, 10, sown(1, 5, 10)), true, 'another heal sows again');
    assert.equal(spawned.length, 10);
    assert.deepEqual(offsetsOf(spawned.slice(5)), CROSS_SET, 'the same cross, on the new tile');
    assert.equal(spawned.filter((h) => h.alive).length, 10, 'the first cross is still there too');
  });

  test('a worn outfit plays its own decal on all five tiles; no outfit keeps the base key', async () => {
    const plain = await setup();
    plain.view(1, HER, 5, 10);
    plain.frame();
    assert.equal(plain.w.simFx('healField', 7, 9, sown(1, 7, 9)), true);
    const wear = await setup();
    wear.view(1, HER, 5, 10, { skin: OUTFIT });
    wear.frame();
    assert.equal(wear.w.simFx('healField', 7, 9, sown(1, 7, 9)), true);
    assert.deepEqual(plain.spawned.map((h) => h.key), [DECAL, DECAL, DECAL, DECAL, DECAL]);
    assert.deepEqual(wear.spawned.map((h) => h.key), [DECAL_OUTFIT, DECAL_OUTFIT, DECAL_OUTFIT, DECAL_OUTFIT, DECAL_OUTFIT]);
    assert.deepEqual(offsetsOf(wear.spawned), CROSS_SET, 'the same five tiles');
  });

  test('the outfit\'s key loads with the battle; its absence keeps the base key', async () => {
    const { w, ofx, spawned, view, frame } = await setup();
    const her = view(1, HER, 5, 10, { skin: OUTFIT });
    const keys = w.keysFor([her]);
    assert.ok(keys.includes(DECAL), 'the base decal');
    assert.ok(keys.includes(DECAL_OUTFIT), 'the outfit\'s replacement');
    frame();
    // an outfit whose replacement the extraction does not hold (not installed here) keeps the base key
    ofx.lib.has = (k) => k in PREFABS && k !== DECAL_OUTFIT;
    ofx.lib.def = (k) => (ofx.lib.has(k) ? { key: k, ...PREFABS[k] } : null);
    assert.equal(w.simFx('healField', 7, 9, sown(1, 7, 9)), true);
    assert.deepEqual(spawned.map((h) => h.key), [DECAL, DECAL, DECAL, DECAL, DECAL]);
  });

  test('the sowing of another skill or another unit stays procedural: the binding is S3\'s', async () => {
    const s1 = await setup({ skill: S1 });
    s1.view(1, HER, 5, 10);
    s1.frame();
    assert.equal(s1.w.simFx('healField', 7, 9, sown(1, 7, 9)), false, 'with S1 equipped she binds no healField [ASSUMED: the decal reads as S3\'s]');
    assert.deepEqual(s1.spawned, []);
    const other = await setup();
    other.view(1, HER, 5, 10);
    other.view(2, 'char_900_other', 8, 10);
    other.frame();
    assert.equal(other.w.simFx('healField', 7, 9, sown(2, 7, 9)), false, 'a unit without the kit\'s skill keeps the procedural ring');
    assert.deepEqual(other.spawned, []);
  });

  test('with the effects layer off, nothing is played (the kit fx stays procedural)', async () => {
    const { w, ofx, spawned, view, frame } = await setup();
    view(1, HER, 5, 10);
    frame();
    ofx.active = false;
    assert.equal(w.simFx('healField', 7, 9, sown(1, 7, 9)), false);
    assert.deepEqual(spawned, []);
  });
});
