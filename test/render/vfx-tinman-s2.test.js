// test/render/vfx-tinman-s2.test.js — 锡人 (char_4151_tinman) S2: one cast shows each cast effect ONCE.
//
// index.json writes 锡人 S2's uses once per ability node that emits them: `tinman_skill_02_start_03` / `_04` (and the
// heal / hit rows) are there under `HitTile` (`ProjectileToTileAbility`, not an attack: the skill's own start row) and
// again under `HitEnemy` (`RangedAttack`: that attack's cast row). skillPlan placed both copies, and one cast played each
// twice, a moment apart: skillfx.js skill(on) plays the skill-level start and, on the instant skill's off in the same
// frame, _instCast plays the attack's cast rows — the same two keys again. planUses now drops an entry that repeats one
// already placed (skills.js dedupePlan: the same key in the same role at the same point, held the same way), so each key
// plays once. On a synthetic index shaped like index.json's and a fake effects layer, as vfx-tinman-s1.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FxWiring } from '../../public/js/render/vfx/wiring.js';
import { skillPlan, planUses, emptyPlan } from '../../public/js/render/vfx/skills.js';
import { setIndexVersion } from '../../public/js/render/vfx/mounts.js';

setIndexVersion(3);

const HER = 'char_4151_tinman';
const SKILL = 'skchr_tinman_2';
const PROJ = 'projectile_chr_tinman_s2';
const START3 = 'tinman_skill_02_start_03';
const START4 = 'tinman_skill_02_start_04';
const HEAL = 'tinman_skill_02_heal_01';
const HIT = 'tinman_skill_02_hit_01';
const CAST = [START3, START4];
const KEYS = [START3, START4, HEAL, HIT];

/** index.json's uses of the skill, verbatim: each cast row once under HitTile and once under HitEnemy. */
const USES = [
  { role: 'trigger', keys: [HIT], from: 'ProjectileToTileAbility._activeBuffs → template tinman_s_2[buff]', event: 'ON_BUFF_TRIGGER', action: 'CreateEffectHookProjectileEffect', on: 'targets', buff: 'tinman_s_2[buff]', node: 'HitTile', life: { type: 'INFINITY', tick: 1 } },
  { role: 'loop', keys: [HEAL], from: 'ProjectileToTileAbility._activeBuffs → template tinman_s_2[buff]', event: 'ON_BUFF_START', action: 'CreateBuff', on: 'targets', buff: 'tinman_s_2[buff]', node: 'HitTile', life: { type: 'INFINITY', tick: 1 } },
  { role: 'loop', keys: [START3], from: 'UberEffectEmitter._castEffects', node: 'HitTile', ability: 'ProjectileToTileAbility', startEvent: 'ON_CAST_START', endEvent: 'ON_CAST_END', oneshot: false, list: 'cast', projectileKey: PROJ },
  { role: 'loop', keys: [START4], from: 'UberEffectEmitter._castEffects', node: 'HitTile', ability: 'ProjectileToTileAbility', startEvent: 'ON_CAST_START', endEvent: 'ON_CAST_END', oneshot: false, list: 'cast', projectileKey: PROJ },
  { role: 'trigger', keys: [HIT], from: 'RangedAttack._activeBuffs → template tinman_s_2[buff]', event: 'ON_BUFF_TRIGGER', action: 'CreateEffectHookProjectileEffect', on: 'targets', buff: 'tinman_s_2[buff]', node: 'HitEnemy', life: { type: 'INFINITY', tick: 1 } },
  { role: 'loop', keys: [HEAL], from: 'RangedAttack._activeBuffs → template tinman_s_2[buff]', event: 'ON_BUFF_START', action: 'CreateBuff', on: 'targets', buff: 'tinman_s_2[buff]', node: 'HitEnemy', life: { type: 'INFINITY', tick: 1 } },
  { role: 'loop', keys: [START3], from: 'UberEffectEmitter._castEffects', node: 'HitEnemy', ability: 'RangedAttack', startEvent: 'ON_CAST_START', endEvent: 'ON_CAST_END', oneshot: false, list: 'cast', projectileKey: PROJ },
  { role: 'loop', keys: [START4], from: 'UberEffectEmitter._castEffects', node: 'HitEnemy', ability: 'RangedAttack', startEvent: 'ON_CAST_START', endEvent: 'ON_CAST_END', oneshot: false, list: 'cast', projectileKey: PROJ },
];

const ABILITIES = [
  { node: SKILL, class: 'AbilitySelectableGroup', select: { method: 'trigger' } },
  { node: 'HitTile', class: 'ProjectileToTileAbility', animKey: 'Skill_2', projectileKey: PROJ, mount: 'MUZZLE' },
  { node: 'HitEnemy', class: 'RangedAttack', animKey: 'Skill_2', projectileKey: PROJ, extraProjectileKeys: [], projectileDestination: 4, mount: 'MUZZLE' },
];

const row = (effects) => ({ directionType: 0, effects, oneshot: 0, startEvent: 2, endEvent: 3, onlyOnce: 0, useFourDirectionalFace: 0, delayIfFirstAttack: 0, hookEffectAfterFirstAttack: '' });

/** The prefab summaries the plan reads (index.json: spawn 1 HitPoint for the two cast rows, 2 TileCenter for the rest). */
const PREFABS = { [START3]: { spawn: 1, looping: false }, [START4]: { spawn: 1, looping: false }, [HEAL]: { spawn: 2, looping: true }, [HIT]: { spawn: 2, looping: false } };

function makeIndex() {
  const skills = {
    [SKILL]: {
      rootClass: 'CastSkill', rootAbility: 'AbilitySelectableGroup', mode: null, effects: CAST.concat([HEAL, HIT]), projectiles: [PROJ],
      uses: USES, roles: {}, unclassified: [], abilities: ABILITIES,
    },
  };
  const prefabs = Object.fromEntries(Object.entries(PREFABS).map(([k, p]) => [k, { file: `prefabs/${k}.json`, ...p }]));
  return {
    version: 3,
    units: {
      [HER]: {
        kind: 'char', skin: HER, startEffect: null, deadEffect: null,
        modes: [{ name: 'Default', attack: { class: 'MeleeAttack', cast: [row(['tinman_attack_start_01'])], hit: [] } }],
        skills,
      },
    },
    skills,
    projectiles: { [PROJ]: { main: null, lifeTime: 100, movement: { class: 'ParacurveMovement', speed: 3 }, onReached: [], effects: [] } },
    skins: { [HER]: {} },
    skinFx: {},
    generic: { hit: {}, die: {}, birth: {}, status: {} },
    prefabs,
  };
}

const record = () => ({ charId: HER, skill: { skillId: SKILL, index: 0, skillType: 'AUTO', durationType: 'NONE', duration: -1, bb: {} } });

/** A fake OfficialFx: handles that stop like render/vfx/effect.js's (the wiring's later() only stops a cast row). */
async function setup() {
  const index = makeIndex();
  const spawned = [];
  const live = [];
  const ofx = {
    active: true, time: 0, lite: false, tier: 'full', timers: [],
    lib: {
      has: (k) => KEYS.includes(k), def: (k) => (KEYS.includes(k) ? { key: k, isLoop: !!PREFABS[k].looping, spawn: PREFABS[k].spawn } : null),
      index: async () => index, preload: async (keys) => keys.length, defs: new Map(),
    },
    spawn(key, place, opts = {}) {
      const h = { key, place, opts, alive: true, stop() { this.alive = false; }, kill() { this.alive = false; } };
      live.push(h); spawned.push(h);
      return h;
    },
    step() { for (let i = live.length - 1; i >= 0; i--) if (!live[i].alive) live.splice(i, 1); },
  };
  const views = new Map();
  const w = new FxWiring(ofx, { speed: () => 10, record: () => record(), view: (id) => views.get(id) || null });
  await w.ready();
  const view = (id, key, x, y, enemy) => {
    const v = { id, x, y, z: 0, visFacing: enemy ? -1 : 1, isEnemy: !!enemy, alive: true, dir: 'RIGHT', flags: 0, hp: 100, maxHp: 100,
      info: { id, spine: key, defId: key, side: enemy ? 'enemy' : 'ally', kind: enemy ? 'enemy' : 'op', skillIndex: 0 } };
    views.set(id, v);
    return v;
  };
  const DT = 1 / 30;
  const frame = (n = 1) => { for (let i = 0; i < n; i++) { w.sync(views.values()); w.tick(); ofx.step(); ofx.time += DT; } };
  return { index, w, ofx, spawned, view, frame };
}

const count = (list, k) => list.filter((h) => h.key === k).length;
const entriesOf = (plan) => [...plan.start, ...plan.loop, ...plan.range, ...plan.each.cast, ...plan.attacks.flatMap((a) => [...a.cast, ...a.range, ...a.aim])];

describe('锡人 S2: one cast, each cast row once', () => {
  test("the plan lists each cast row once, not once per ability node (HitTile + HitEnemy)", () => {
    const plan = skillPlan(makeIndex(), HER, SKILL, { rec: record().skill });
    assert.equal(plan.kind, 'instant', 'CastSkill without a duration: one cast');
    const keys = entriesOf(plan).map((e) => e.key);
    for (const k of CAST) assert.equal(keys.filter((x) => x === k).length, 1, k);
    assert.deepEqual(plan.start.map((e) => e.key).sort(), [...CAST].sort(), 'the skill\'s start rows: the HitTile copy');
    const attacked = plan.attacks.flatMap((a) => a.cast).map((e) => e.key);
    assert.deepEqual(attacked, [], 'the HitEnemy copy was the same effect: the attack casts nothing of its own');
  });

  test('one cast (sim skill 1 → 0) spawns each row once', async () => {
    const { w, spawned, view, frame } = await setup();
    const her = view(1, HER, 10, 10);
    frame();
    assert.equal(w.skill(her, true), true);
    assert.equal(w.skill(her, false), true);
    frame(30);
    for (const k of CAST) assert.equal(count(spawned, k), 1, k);
    assert.deepEqual(spawned.map((h) => h.key).sort(), [...CAST].sort(), 'nothing else plays on the cast');
  });

  test('a second cast plays each row once again', async () => {
    const { w, spawned, view, frame } = await setup();
    const her = view(1, HER, 10, 10);
    frame();
    for (let i = 0; i < 2; i++) { w.skill(her, true); w.skill(her, false); frame(); }
    frame(30);
    for (const k of CAST) assert.equal(count(spawned, k), 2, `${k}: one per cast`);
  });

  test('the heal loop and the triggered hit are one entry each, on the carriers they name', () => {
    // the buff's heal loop lands on `targets` (no client signal names its carriers) and the buff's tick is a pulse: the
    // same key twice under HitTile / HitEnemy is one of each, not two
    const plan = skillPlan(makeIndex(), HER, SKILL, { rec: record().skill });
    assert.deepEqual(plan.targets.map((e) => [e.key, e.at, e.hold]), [[HEAL, 'targets', 'skill']]);
    assert.deepEqual(plan.pulse.map((e) => [e.key, e.at, e.reason]), [[HIT, 'target', 'tick']]);
  });
});

describe('plan-level dedupe of same-key uses', () => {
  const idxWith = (uses, prefabs) => ({
    version: 3, units: {}, skills: {}, projectiles: {},
    prefabs: Object.fromEntries(prefabs.map((k) => [k, { file: `prefabs/${k}.json`, spawn: 1, looping: false }])),
    generic: {}, skinFx: {}, skins: {},
  });
  const planOf = (uses, prefabs) => planUses(idxWith(uses, prefabs), emptyPlan('u', 's'), uses, { mode: null, abilities: [] });
  const loop = (k, ability = 'ProjectileToTileAbility') => ({ role: 'loop', keys: [k], from: 'UberEffectEmitter._castEffects', node: ability === 'RangedAttack' ? 'HitEnemy' : 'HitTile', ability, startEvent: 'ON_CAST_START', endEvent: 'ON_CAST_END', oneshot: false });
  const keyCount = (plan) => entriesOf(plan).map((e) => e.key);

  test('the same key, role and placement from two nodes → one entry', () => {
    const plan = planOf([loop('x1'), loop('x1', 'RangedAttack')], ['x1']);
    assert.deepEqual(keyCount(plan), ['x1']);
    assert.equal(plan.start[0].node, 'HitTile', 'the first use wins');
  });

  test('the same key in another role → both entries stay', () => {
    const uses = [
      { role: 'loop', keys: ['x1'], from: 'ActiveBuffAbility._buffs', node: 'n', on: 'owner', buff: 'b' },
      { role: 'start', keys: ['x1'], from: 'X._beginEffect', node: 'n' },
    ];
    const plan = planOf(uses, ['x1']);
    assert.equal(plan.loop.filter((e) => e.key === 'x1').length, 1);
    assert.equal(plan.start.filter((e) => e.key === 'x1').length, 1);
  });

  test('the same key and role but a different hold → both entries stay', () => {
    const uses = [
      { role: 'loop', keys: ['x1'], from: 'ActiveBuffAbility._buffs', node: 'n', on: 'owner', buff: 'b' },   // hold 'skill'
      loop('x1', 'RangedAttack'),                                                                          // hold 'cast', an attack's row
    ];
    const plan = planOf(uses, ['x1']);
    assert.equal(plan.loop.filter((e) => e.key === 'x1').length, 1);
    assert.equal(plan.attacks.flatMap((a) => a.cast).filter((e) => e.key === 'x1').length, 1);
  });

  test('different keys are untouched', () => {
    const plan = planOf([loop('x1'), loop('x2')], ['x1', 'x2']);
    assert.deepEqual(keyCount(plan).sort(), ['x1', 'x2']);
  });

  test('a key a path or a tile field places is no entry: its rows stay unmapped, one per use', () => {
    const uses = [
      { role: 'range', keys: ['x1'], from: 'T._tileEffectKey', node: 'n' },
      { role: 'range', keys: ['x1'], from: 'T._tileEffectKey', node: 'n' },
    ];
    const plan = planOf(uses, ['x1']);
    assert.equal(plan.range.length, 0);
    assert.deepEqual(plan.unmapped.map((u) => [u.key, u.reason]), [['x1', 'tiles'], ['x1', 'tiles']], '黍-style tile rows: one per use');
  });
});
