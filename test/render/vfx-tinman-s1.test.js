// test/render/vfx-tinman-s1.test.js — 锡人 (char_4151_tinman) S1 「老科利」: one cast shows ONE circle.
//
// The kit (server/sim/content/kits/ops/chess_char_2_19-tinman.js `skchr_tinman_1.onStart`) throws the flask with a single
// `battle.fx('zone', { x, y, radius, dur, id, skill: 'tinman1' })` — verified against the real sim: one `['fx','zone',…]`,
// one `['skill', id, 1]` / `['skill', id, 0]` pair per cast, never two. The client therefore draws the kit's fx ONCE
// (FX_BINDINGS.skchr_tinman_1.zone → the flask's reached effects: the `tinman_skill_01_range_01` ring, the flask on the
// ground, the two splashes) — but the same cast's attack ALSO flies the skill's own projectile: 锡人 S1 is a
// ReplacementSkill, so SkillFx.attackFx's `inst` path makes the attack that fires the AUTO skill the skill's own attack,
// `_fly` sends `projectile_chr_tinman_s1` and `_arrive` played its `onReached` again on the target's tile: the ring (and
// the rest) appeared twice, a moment apart and a little offset. SkillFx.landingDrawn (with wiring `_arrive`) now skips the
// keys a binding of the same skill already holds at that tile: one cast, one circle. On a synthetic index shaped like
// index.json's (four reached keys, which is what the extraction holds) and a fake effects layer whose handles advance their
// own time and run the wiring's `track` (a flight's arrival happens nowhere else, as render/vfx/effect.js does).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FxWiring } from '../../public/js/render/vfx/wiring.js';
import { FX_BINDINGS, bindingKeys } from '../../public/js/render/vfx/skills.js';
import { setIndexVersion } from '../../public/js/render/vfx/mounts.js';

setIndexVersion(3);

const HER = 'char_4151_tinman';
const SKILL = 'skchr_tinman_1';
const PROJ = 'projectile_chr_tinman_s1';
const RING = 'tinman_skill_01_range_01';
const START = 'tinman_skill_01_start_01', TOKEN = 'tinman_skill_01_token_01', SPLASH = 'tinman_skill_01_start_02';
const REACHED = [RING, START, TOKEN, SPLASH];          // the real index.json's projectile onReached (four keys)
const CAST = 'tinman_skill_01_start_03';               // the plan's attack cast row (UberEffectEmitter._castEffects)
const TRAIL = 'tinman_skill_01_trail_01';
const ATTACK = 'tinman_attack_start_01';
const KEYS = [RING, START, TOKEN, SPLASH, CAST, TRAIL, ATTACK];

const row = (effects) => ({ directionType: 0, effects, oneshot: 0, startEvent: 2, endEvent: 3, onlyOnce: 0, useFourDirectionalFace: 0, delayIfFirstAttack: 0, hookEffectAfterFirstAttack: '' });

function makeIndex() {
  const skills = {
    // index.json: rootClass ReplacementSkill, an instant skill whose ability is her flask — and no start / loop / range row
    [SKILL]: {
      rootClass: 'ReplacementSkill', rootAbility: 'RangedAttack', mode: null, effects: CAST, projectiles: [PROJ],
      uses: [{ role: 'loop', keys: [CAST], from: 'UberEffectEmitter._castEffects', node: SKILL, ability: 'RangedAttack', startEvent: 'ON_CAST_START', endEvent: 'ON_CAST_END', oneshot: false, list: 'cast' }],
      roles: { loop: [CAST] }, unclassified: [],
      abilities: [{ node: SKILL, class: 'RangedAttack', animKey: 'Skill', attackType: 1, damageType: 1, projectileKey: PROJ, extraProjectileKeys: [], projectileDestination: 4, mount: 'MUZZLE' }],
    },
  };
  return {
    version: 3,
    units: {
      [HER]: {
        kind: 'char', skin: HER, startEffect: null, deadEffect: null,
        modes: [{ name: 'Default', attack: { class: 'RangedAttack', projectileKey: 'projectile_chr_tinman', cast: [row([ATTACK])], hit: [] } }],
        skills,
      },
    },
    skills,
    projectiles: {
      [PROJ]: { main: TRAIL, lifeTime: 100, movement: { class: 'ParacurveMovement', speed: 3 }, onReached: [...REACHED], effects: [] },
    },
    skins: { [HER]: {} },
    skinFx: {},
    generic: { hit: {}, die: {}, birth: {}, status: {} },
    prefabs: Object.fromEntries(KEYS.map((k) => [k, { file: `prefabs/${k}.json` }])),
  };
}

const record = () => ({ charId: HER, skill: { skillId: SKILL, index: 0, skillType: 'AUTO', durationType: 'NONE', duration: -1, bb: {} } });

/** A fake OfficialFx whose handles tick like render/vfx/effect.js (time + the wiring's track), so a flight really lands. */
async function setup({ installed = KEYS } = {}) {
  const index = makeIndex();
  const spawned = [];
  const live = [];
  const ofx = {
    active: true, time: 0, lite: false, tier: 'full', timers: [],
    lib: {
      has: (k) => installed.includes(k), def: (k) => (installed.includes(k) ? { key: k, isLoop: false, spawn: 2 } : null),
      index: async () => index, preload: async (keys) => keys.length, defs: new Map(),
    },
    spawn(key, place, opts = {}) {
      const h = {
        key, place, opts, time: 0, time0: this.time, alive: true,
        anchor: (place?.pos || [0, 0, 0]).slice(), yaw: 0, mirror: false, pitch: 0, groundZ: 0,
        stop() { this.alive = false; }, kill() { this.alive = false; },
      };
      live.push(h); spawned.push(h);
      return h;
    },
    step(dt) {
      for (const h of live) {
        if (!h.alive) continue;
        if (h.opts.track) { try { h.opts.track(h); } catch { /* ignore */ } }
        h.time += dt;
      }
      for (let i = live.length - 1; i >= 0; i--) if (!live[i].alive) live.splice(i, 1);
    },
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
  const frame = (n = 1) => { for (let i = 0; i < n; i++) { w.sync(views.values()); w.tick(); ofx.step(DT); ofx.time += DT; } };
  return { index, w, ofx, spawned, view, frame };
}

const count = (list, k) => list.filter((h) => h.key === k).length;

describe('锡人 S1: the kit\'s one zone fx, the flask\'s one landing', () => {
  test('the binding plays the flask\'s four reached keys once, at the fx\'s tile, held for the zone\'s time', async () => {
    const { w, spawned, view, frame } = await setup();
    const her = view(1, HER, 10, 10);
    frame();
    w.skill(her, true);
    assert.equal(w.simFx('zone', 12, 10, { radius: 1, dur: 8, id: 1, skill: 'tinman1' }), true);
    for (const k of REACHED) assert.equal(count(spawned, k), 1, k);
    assert.equal(FX_BINDINGS[SKILL].zone.hold, 'fx');
    assert.deepEqual(bindingKeys(makeIndex(), SKILL).sort(), [...REACHED].sort(), 'the index\'s reached set');
  });

  test('the cast-frame attack flies the flask but its landing does not play the ring again: one cast, one circle', async () => {
    const { w, spawned, view, frame } = await setup();
    const her = view(1, HER, 10, 10), foe = view(2, 'enemy_e', 12, 10, true);
    frame();
    // one tick of the AUTO skill: skill 1 → the kit's zone fx → skill 0 → the attack that triggered it
    w.skill(her, true);
    assert.equal(w.simFx('zone', 12, 10, { radius: 1, dur: 8, id: 1, skill: 'tinman1' }), true);
    assert.equal(w.attack(her, foe, 'arrow', 0), true, 'her official attack is drawn');
    w.skill(her, false);
    assert.equal(count(spawned, TRAIL), 1, 'the skill\'s own projectile flies (a ReplacementSkill: the attack is its)');
    assert.equal(count(spawned, CAST), 1, 'and its cast row plays');
    frame(90);   // the flight lands well inside this
    for (const k of REACHED) assert.equal(count(spawned, k), 1, `${k}: the binding's, not a second landing`);
    assert.equal(count(spawned, RING), 1, 'one circle per cast');
  });

  test('a landing elsewhere is not suppressed: only the tile the binding holds is', async () => {
    const { w, spawned, view, frame } = await setup();
    const her = view(1, HER, 10, 10), near = view(2, 'enemy_near', 12, 10, true), far = view(3, 'enemy_far', 13, 10, true);
    frame();
    w.skill(her, true);
    w.simFx('zone', 12, 10, { radius: 1, dur: 8, id: 1, skill: 'tinman1' });
    w.attack(her, near, 'arrow', 0);       // the cast's own attack: the same tile, deduped
    frame(30);
    assert.equal(count(spawned, RING), 1);
    // the helper: the binding's mark is that tile only
    const proj = w.idx.projectiles[PROJ];
    assert.deepEqual([...w.skills.landingDrawn({ x: 12, y: 10 }, proj)].sort(), [...REACHED].sort(), 'held at the fx\'s tile');
    assert.deepEqual([...w.skills.landingDrawn({ x: 13, y: 10 }, proj)], [], 'nothing bound one tile over');
    assert.deepEqual([...w.skills.landingDrawn(null, proj)], [], 'no target, no landing');
    far.alive = true;
  });

  test('the dedupe is per key: a reached prefab the local set lacks does not reopen the others', async () => {
    const lite = await setup({ installed: KEYS.filter((k) => k !== RING) });
    const her = lite.view(1, HER, 10, 10), foe = lite.view(2, 'enemy_e', 12, 10, true);
    lite.frame();
    lite.w.skill(her, true);
    assert.equal(lite.w.simFx('zone', 12, 10, { radius: 1, dur: 8, id: 1, skill: 'tinman1' }), true, 'the binding keeps its other keys');
    lite.w.attack(her, foe, 'arrow', 0);
    lite.frame(90);
    assert.equal(count(lite.spawned, RING), 0, 'not installed: neither path can draw it');
    for (const k of [START, TOKEN, SPLASH]) assert.equal(count(lite.spawned, k), 1, k);
  });

  test('with the effects layer off nothing official plays', async () => {
    const { w, ofx, spawned, view, frame } = await setup();
    const her = view(1, HER, 10, 10), foe = view(2, 'enemy_e', 12, 10, true);
    frame();
    ofx.active = false;
    assert.equal(w.skill(her, true), false);
    assert.equal(w.simFx('zone', 12, 10, { radius: 1, dur: 8, id: 1, skill: 'tinman1' }), false);
    assert.equal(w.attack(her, foe, 'arrow', 0), false);
    frame(60);
    assert.deepEqual(spawned.map((h) => h.key), []);
  });
});
