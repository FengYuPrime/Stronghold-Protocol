// test/render/vfx-blaze2-s3.test.js — 烛煌 (char_1040_blaze2) S3 众恶的焚场: her two S3 hit effects are not in the skill's
// plan (skchr_blaze2_3's plan has loop rows only: buff / buff_02 / range) but in index.json
// units.char_1040_blaze2.modes[3].attack.hit[0..1] (blaze2_skill_03_hit / _02), and her S3 is a RangedAttack with
// projectile_chr_blaze2_s3 — a projectile with no flying effect of its own (`main` null, lifeTime 0.3): attack() plays the
// mode S3's rows with that timer's hit (wiring.js `attack` → `_fly` → `_arrive`). This file locks that chain, the pieces
// it depends on, and the two ways it silently falls back (the skill state not seen → Default; a worn outfit's replacement).
// On a synthetic index shaped as index.json's, a fake effects layer, as the other wiring tests.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FxWiring } from '../../public/js/render/vfx/wiring.js';
import { setIndexVersion } from '../../public/js/render/vfx/mounts.js';

setIndexVersion(3);

const HER = 'char_1040_blaze2';
const SKILL = 'skchr_blaze2_3';
const OUTFIT = `${HER}@winter#5`;
const PROJ = 'projectile_chr_blaze2_s3';
const HIT = 'blaze2_skill_03_hit', HIT2 = 'blaze2_skill_03_hit_02';
const START = 'blaze2_skill_03_start';
const BUFF = 'blaze2_skill_03_buff', BUFF2 = 'blaze2_skill_03_buff_02', RANGE = 'blaze2_skill_03_range';
const DEF_CAST = 'blaze2_attack_01_start';
const KEYS = [HIT, HIT2, START, BUFF, BUFF2, RANGE, DEF_CAST, `${HIT}_winter_5`, `${HIT2}_winter_5`, `${START}_winter_5`];

/** index.json's row shape (directionType 0, one key). */
const row = (k, o = {}) => ({ directionType: 0, effects: [k], oneshot: 1, startEvent: 4, endEvent: 3, onlyOnce: 0, hookEffectAfterFirstAttack: '', ...o });

function makeIndex() {
  const modes = [
    { name: 'Default', attack: { class: 'RangedAttack', projectileKey: PROJ, cast: [row(DEF_CAST, { startEvent: 2 })], hit: [] } },
    { name: 'Reborn', attack: { class: 'RangedAttack', cast: [], hit: [] } },   // index.json keeps her 重生 form at [1]
    { name: 'S2', attack: { class: 'RangedAttack', cast: [], hit: [] } },
    // index.json: Modes[3] — a RangedAttack whose hit rows are the only place the S3 hit effects appear
    { name: 'S3', attack: { class: 'RangedAttack', projectileKey: PROJ, mount: 'MUZZLE', cast: [row(START, { startEvent: 5 })], hit: [row(HIT), row(HIT2)] } },
  ];
  // her S3's plan: three looping buff uses and no attack ability of its own (the plan's `attacks` stays empty)
  const skills = {
    [SKILL]: {
      rootClass: 'CastSkillWithLimitTimes', rootAbility: 'ActiveBuffAbility', mode: 3, effects: [BUFF, BUFF2, RANGE], projectiles: [],
      uses: [BUFF, BUFF2, RANGE].map((k) => ({ role: 'loop', keys: [k], from: 'ActiveBuffAbility._buffs', node: SKILL, on: 'owner', life: { type: 'INFINITY' } })),
    },
  };
  return {
    version: 3,
    units: { [HER]: { kind: 'char', skin: HER, modes, skills, startEffect: null, deadEffect: null } },
    skills,
    // a timer projectile: nothing to fly, its hit at the end of its life (as index.json's SimpleProjectile)
    projectiles: { [PROJ]: { main: null, lifeTime: 0.3, effects: [] } },
    skins: { [HER]: {} },
    skinFx: { [OUTFIT]: { replace: { [HIT]: `${HIT}_winter_5`, [HIT2]: `${HIT2}_winter_5`, [START]: `${START}_winter_5` } } },
    generic: { hit: {}, die: {}, birth: {}, status: {} },
    prefabs: Object.fromEntries(KEYS.map((k) => [k, { file: `prefabs/${k}.json` }])),
  };
}

/** The record render/app.js hands the wiring (ctx.lookupDef): her equipped skill and its index. */
const record = () => ({ charId: HER, skill: { skillId: SKILL, index: 2, skillType: 'MANUAL', durationType: 'AMMO', duration: 0, bb: {} } });

async function setup() {
  const index = makeIndex();
  const spawned = [];
  const ofx = {
    active: true, time: 0, lite: false, tier: 'full', timers: [],
    lib: {
      has: (k) => k in index.prefabs,
      def: (k) => (index.prefabs[k] ? { ...index.prefabs[k], isLoop: false } : null),
      index: async () => index, preload: async (keys) => keys.length, defs: new Map(),
    },
    spawn(key, place, opts) {
      const h = { key, place, opts, stopped: false, get alive() { return !this.stopped; }, stop() { this.stopped = true; }, kill() { this.stopped = true; } };
      spawned.push(key);
      return h;
    },
  };
  const views = new Map();
  const w = new FxWiring(ofx, { speed: () => 10, record: (info) => (info?.defId === HER ? record() : null), view: (id) => views.get(id) || null });
  await w.ready();
  const view = (id, key, x, y = 10, o = {}) => {
    const enemy = /^enemy_/.test(key);
    const v = { id, x, y, z: 0, visFacing: enemy ? -1 : 1, isEnemy: !!enemy, alive: true, destroyed: false, dir: 'RIGHT', flags: o.flags || 0,
      info: { id, spine: key, defId: key, side: enemy ? 'enemy' : 'ally', kind: enemy ? 'enemy' : 'op', skillIndex: o.skillIndex ?? 2, skin: o.skin ?? null } };
    views.set(id, v);
    return v;
  };
  const frame = (dt = 1 / 30) => { w.sync(views.values()); w.tick(); ofx.time += dt; };
  return { index, w, ofx, spawned, view, frame };
}

const count = (list, k) => list.filter((x) => x === k).length;

describe('烛煌 S3: the hit effects of modes[3].attack.hit play with her shot', () => {
  test('while the skill is on she attacks in mode S3, whose two hit rows are the S3 keys', async () => {
    const { index, w, view, frame } = await setup();
    const her = view(1, HER, 5), foe = view(2, 'enemy_1007_slime', 8);
    frame();
    assert.equal(w.mode(w.unitOf(her), her)?.name, 'Default', 'the skill is off: the mode is her Default');
    assert.equal(w.skill(her, true), true);
    assert.equal(w.mode(w.unitOf(her), her)?.name, 'S3', 'the plan names mode S3 (skills.js skillPlan modeName)');
    const set = w._attackSet(w.unitOf(her), w.mode(w.unitOf(her), her), her, foe, 'bolt', 0);
    assert.deepEqual(set.hit.map((r) => r.effects[0]), [HIT, HIT2], 'both rows of modes[3].attack.hit');
    assert.equal(set.projectileKey, PROJ, 'her S3 projectile');
    assert.equal(index.projectiles[PROJ].main, null, 'a timer: it has no flying effect of its own');
  });

  test('the shot\'s hit plays both S3 keys on the target when the timer\'s life ends, not at the muzzle', async () => {
    const { w, ofx, spawned, view, frame } = await setup();
    const her = view(1, HER, 5), foe = view(2, 'enemy_1007_slime', 8);   // 3 tiles at 10 tiles/s: 0.3 s
    frame();
    w.skill(her, true);
    assert.equal(w.attack(her, foe, 'bolt', 1), true, 'her official attack is drawn (no procedural bolt over it)');
    assert.equal(count(spawned, START), 1, 'the ON_SPELL_ON cast row plays at the strike');
    assert.equal(count(spawned, HIT) + count(spawned, HIT2), 0, 'the hit rows wait for the shot');
    for (let i = 0; i < 12; i++) frame();   // past the drawn flight (0.3 s) and the timer's life
    assert.equal(count(spawned, HIT), 1, 'blaze2_skill_03_hit plays');
    assert.equal(count(spawned, HIT2), 1, 'blaze2_skill_03_hit_02 plays');
    // one attack, one hit of each row — and every later attack plays them again
    w.attack(her, foe, 'bolt', 2);
    for (let i = 0; i < 12; i++) frame();
    assert.equal(count(spawned, HIT), 2);
    assert.equal(count(spawned, HIT2), 2);
    assert.ok(ofx.time > 0);
  });

  test('with the skill off the S3 keys never play: the Default mode\'s own rows do', async () => {
    const { w, spawned, view, frame } = await setup();
    const her = view(1, HER, 5), foe = view(2, 'enemy_1007_slime', 8);
    frame();
    assert.equal(w.attack(her, foe, 'bolt', 1), true);
    for (let i = 0; i < 12; i++) frame();
    assert.equal(count(spawned, DEF_CAST), 1, 'her normal attack');
    assert.equal(count(spawned, HIT) + count(spawned, HIT2), 0, 'S3\'s hit effects belong to the skill');
  });

  test('a worn outfit plays its own S3 hits (换装: skinFx replace), at the same target', async () => {
    const plain = await setup();
    const p = plain.view(1, HER, 5), pf = plain.view(2, 'enemy_1007_slime', 8);
    plain.frame(); plain.w.skill(p, true);
    plain.w.attack(p, pf, 'bolt', 1);
    for (let i = 0; i < 12; i++) plain.frame();
    const wear = await setup();
    const wv = wear.view(1, HER, 5, 10, { skin: OUTFIT }), wf = wear.view(2, 'enemy_1007_slime', 8);
    wear.frame(); wear.w.skill(wv, true);
    wear.w.attack(wv, wf, 'bolt', 1);
    for (let i = 0; i < 12; i++) wear.frame();
    assert.deepEqual([count(plain.spawned, HIT), count(plain.spawned, HIT2)], [1, 1], 'the base keys');
    assert.deepEqual([count(wear.spawned, `${HIT}_winter_5`), count(wear.spawned, `${HIT2}_winter_5`)], [1, 1], 'the outfit\'s keys');
    assert.equal(count(wear.spawned, HIT) + count(wear.spawned, HIT2), 0, 'never both');
  });

  test('with the effects layer off nothing official plays', async () => {
    const { w, ofx, spawned, view, frame } = await setup();
    const her = view(1, HER, 5), foe = view(2, 'enemy_1007_slime', 8);
    frame();
    ofx.active = false;
    assert.equal(w.attack(her, foe, 'bolt', 1), false);
    for (let i = 0; i < 12; i++) frame();
    assert.deepEqual(spawned, []);
    assert.ok(!spawned.includes(HIT));
  });
});
