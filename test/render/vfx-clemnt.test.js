// test/render/vfx-clemnt.test.js — 克莱门莎 (char_4231_clemnt) S2 风暴潮's 漩涡 has its official effect. Her kit
// (server/sim/content/kits/ops/op-clemnt.js startCabin / finishCabin) launches the cabin with fx('anchor') and, once it
// has moved its three tiles, leaves the vortex with fx('tide') at the tile the cabin stopped on (r 1.5, dur = the
// skill's time left). index.json's skchr_clemnt_2 lists one effect only — the S2 loop clemnt_skill_02_buff_01, a spinning
// water / wind field whose nodes are the plane background, flow, spiral, wind trail and bubbles — attached to the buff
// clemnt_s2[switch_mode] on the caster, which the plan plays on her for the skill's duration. Nothing played it where the
// vortex stands, so the kit's 'tide' fell back to the procedural zone (render/fx/kinds.js `tide`): FX_BINDINGS now plays
// the official field there as a ground decal (skills.js `decal`, outside MAX_EFFECTS) for the fx's own `dur`.
// Unlike the other bindings' tests this one runs the real index.json, the real record (data/backups.json) and the real
// sim's event stream through the real FxWiring, as render/app.js does; it skips where the client's effects were never
// extracted (public/assets is not in git).
//
// Run: node --test test/render/vfx-clemnt.test.js

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FxWiring } from '../../public/js/render/vfx/wiring.js';
import { FX_BINDINGS, bindingEffects, bindingKeys, skillPlan } from '../../public/js/render/vfx/skills.js';
import { setIndexVersion } from '../../public/js/render/vfx/mounts.js';
import { makeBattle, enemyRec } from '../helpers/battleHarness.js';

setIndexVersion(3);   // as FxLibrary.index() does once index.json is in: no skinShift on the points

const HER = 'char_4231_clemnt';
const SKILL = 'skchr_clemnt_2';
/** The client's S2 landing field (spawn 7 = the struck tile, looping, 44 nodes): what the cabin leaves on the ground. */
const VORTEX = 'clemnt_skill_02_bullet_range_01';
/** Her own S2 loop (index.json skills.skchr_clemnt_2 uses[0]): the plan plays it on her for the skill's duration. */
const AURA = 'clemnt_skill_02_buff_01';
const indexFile = (p) => fileURLToPath(new URL(`../../public/assets/local/fx/${p}`, import.meta.url));
const hasFx = existsSync(indexFile('index.json')) && existsSync(indexFile(`prefabs/${VORTEX}.json`));
const SKIP = !hasFx && 'the client effects were not extracted here (public/assets)';
const INDEX = hasFx ? JSON.parse(readFileSync(indexFile('index.json'), 'utf8')) : null;
const BACKUPS = JSON.parse(readFileSync(new URL('../../data/backups.json', import.meta.url), 'utf8'));

/** The record render/app.js hands the wiring (ctx.lookupDef): her form's three skills. */
const RECORD = { charId: HER, skills: BACKUPS.units[HER].forms['2/60/7/1'].skills };

/**
 * The client's effects layer over the real index: `has` answers from index.json's prefab list (and the file on disk),
 * `spawn` records the handle. Its `time` is the battle clock and it runs the wiring's own timers (skillfx.js `later`).
 */
function effectsLayer() {
  const spawned = [];
  const ofx = {
    active: true, time: 0, lite: false, tier: 'full', timers: [],
    lib: {
      has: (k) => !!INDEX.prefabs?.[k] && existsSync(indexFile(`prefabs/${k}.json`)),
      def: (k) => (INDEX.prefabs?.[k] ? { ...INDEX.prefabs[k], key: k } : null),
      index: async () => INDEX, preload: async (keys) => keys.length, defs: new Map(),
    },
    spawn(key, place, opts) {
      const h = { key, place, opts, stopped: false, get alive() { return !this.stopped; }, stop() { this.stopped = true; }, kill() { this.stopped = true; } };
      spawned.push(h);
      return h;
    },
  };
  return { ofx, spawned };
}

/** A battle view of a sim entity (the shape render/vfx reads: the board feet, the facing, `info`). */
function viewOf(e) {
  const enemy = e.side === 'enemy';
  const key = e.def?.charId || e.def?.key || (enemy ? 'enemy' : 'op');
  return {
    id: e.id, x: e.x, y: e.y, z: 0, visFacing: enemy ? -1 : 1, alive: true, destroyed: false, dir: enemy ? 'LEFT' : 'RIGHT', flags: 0,
    info: { id: e.id, spine: key, defId: key, side: e.side, kind: enemy ? 'enemy' : 'op', skillIndex: 1, skin: null },
  };
}

/**
 * A real battle with 克莱门莎 at (10, 5) carrying S2 and one walking enemy, its views, the client's effects layer and the
 * wiring — fed every drained event the way render/app.js does (skill / atk / dmg / fx).
 */
async function setup() {
  const h = makeBattle({    defs: { enemies: { enemy_walk: enemyRec({ key: 'enemy_walk', hp: 1e9, speed: 0.6, mass: 0 }) } },
    timeLimit: 60, autoFinish: false, seed: 5, flags: { dpPerSec: 0, dpMax: 999 },
    units: [{ diy: { slot: 6, charId: HER, skillIndex: 1 }, elite: true, row: 10, col: 5 }],
    enemies: [{ key: 'enemy_walk', time: 0, route: 0 }],
  });
  h.step();
  const her = h.unit(1);
  const { ofx, spawned } = effectsLayer();
  const views = new Map();
  const w = new FxWiring(ofx, {
    speed: () => 10,
    unitKey: (info) => (info ? [info.spine, info.defId].filter(Boolean) : null),
    record: (info) => (info?.defId === HER ? RECORD : null),
    view: (id) => views.get(id) || null,
  });
  /** The sim's units as views, once (before the first frame). */
  const look = () => {
    for (const e of [...h.allies(), ...h.enemies()]) views.set(e.id, { ...(views.get(e.id) || viewOf(e)), x: e.x, y: e.y });
    return [...views.values()];
  };
  const cast = () => { her.skill.gainSp(999, 'init'); return her.skill.activate('test'); };
  let seen = 0;   // the harness drains the sim's events into `h.events` (battleHarness.js step)
  /** One step: the sim's events → the wiring (render/app.js's cases), then a rendered frame. */
  const frame = () => {
    h.step();
    const now = h.b.time;
    const batch = h.events.slice(seen);
    seen = h.events.length;
    for (const e of batch) {
      if (e[0] === 'skill') { const v = views.get(e[1]); if (v) w.skill(v, !!e[2]); }
      else if (e[0] === 'atk') { const s = views.get(e[1]), t = views.get(e[2]); if (s) w.attack(s, t, e[3], now); }
      else if (e[0] === 'dmg') { const v = views.get(e[1]); if (v) w.damage(v, e[3], null, now); }
      else if (e[0] === 'fx') w.simFx(e[1], Number(e[2]), Number(e[3]), e[4]);
    }
    w.sync(look());
    w.tick();
    ofx.time = now;
  };
  await w.ready();
  return { h, her, w, ofx, spawned, views, look, cast, frame };
}

describe('克莱门莎 S2 风暴潮: the 漩涡 is the client\'s own field (FX_BINDINGS)', { skip: SKIP }, () => {
  test('the kit\'s tide is bound to the S2 field; the key is in the table and loads with her skill', () => {
    const bind = FX_BINDINGS[SKILL].tide;
    assert.deepEqual(Object.keys(FX_BINDINGS[SKILL]), ['tide'], 'nothing else of S2 is bound');
    assert.equal(bind.owner, 'id', 'the kit names her as the fx\'s id');
    assert.equal(bind.at, 'point', 'the vortex stands where the cabin stopped, not on her');
    assert.equal(bind.hold, 'fx', 'its life is the fx\'s own `dur` (the skill\'s time left)');
    assert.equal(bind.decal, true, 'a ground field: outside the effects budget (system.js MAX_EFFECTS)');
    assert.deepEqual(bindingEffects(INDEX, bind), [VORTEX]);
    assert.deepEqual(bindingKeys(INDEX, SKILL), [VORTEX], 'preloaded with her skill');
    assert.ok(INDEX.prefabs[VORTEX], `${VORTEX} is exported (fx/prefabs)`);
    assert.equal(INDEX.prefabs[VORTEX].looping, true, 'the client loops it');
    assert.equal(INDEX.prefabs[VORTEX].spawn, 7, 'spawn 7 = the struck tile, not her (spawn 1)');
  });

  test('S2: the sim\'s events open the skill, and the vortex plays once where the cabin stops', async () => {
    const { h, her, w, ofx, spawned, look, cast, frame } = await setup();
    look();
    w.sync(look());
    w.tick();
    assert.equal(h.b.time < 1, true, 'the battle has just started');
    // S2's own loop is already the skill's plan row (index.json: clemnt_s2[switch_mode] on the caster)
    assert.deepEqual(skillPlan(INDEX, HER, SKILL, { rec: RECORD }).loop.map((e) => e.key), [AURA]);
    assert.equal(cast(), true, 'she casts S2');
    for (let i = 0; i < 90; i++) frame();   // 3 s at 30 fps: the cabin's 3 tiles at speed 2
    // the skill's own aura (the plan's loop, on her) and the vortex (the kit's 'tide', on the ground): the decal is ours
    const decals = () => spawned.filter((x) => x.key === VORTEX && x.opts.decal);
    const cabin = her.mem.clemntCabin;
    assert.equal(cabin.stopped, true, 'the kit stopped the cabin and left the vortex');
    assert.deepEqual([cabin.x, cabin.y], [8, 10], 'three tiles in front of her (col 5 → col 8)');
    assert.equal(decals().length, 1, 'the vortex plays once, at the kit\'s tide');
    const vortex = decals()[0];
    assert.equal(vortex.opts.loop, true, 'a looping field, held');
    assert.equal(vortex.stopped, false, 'still held while the skill lasts');
    assert.ok(spawned.some((x) => x.key === AURA && !x.opts.decal), 'her S2 aura (the plan\'s loop) plays too');
    // the field is the vortex's own tile: the same fx one tile further right lands one tile further right
    const before = vortex.place.pos.slice(0, 2);
    assert.equal(w.simFx('tide', 9, 10, { r: 1.5, dur: 5, id: her.id }), true, 'the same fx one tile further');
    const after = decals().pop().place.pos.slice(0, 2);
    assert.ok(Math.abs(after[0] - before[0]) > 0.5, 'the effect sits on the fx\'s point');
    // and each ends by itself once its own `dur` has run out (hold: 'fx' → ofx.timers)
    ofx.time += 20;
    w.tick();
    assert.equal(decals().every((x) => x.stopped), true, 'both expired');
  });

  test('S1 carries no vortex: the binding belongs to S2 alone', async () => {
    const { h } = await setup();
    assert.equal(h.unit(1).skill.id, SKILL);
    assert.equal(FX_BINDINGS.skchr_clemnt_1, undefined, 'S1 (冲蚀, a next-attack buff) binds nothing');
    assert.equal(FX_BINDINGS.skchr_clemnt_3.tide, undefined, 'S3\'s mark keeps its own binding');
  });

  test('with the effects layer off nothing official plays', async () => {
    const { w, ofx, spawned, look, cast, frame } = await setup();
    ofx.active = false;
    look();
    cast();
    for (let i = 0; i < 90; i++) frame();
    assert.deepEqual(spawned, []);
    assert.equal(w.simFx('tide', 8, 10, { dur: 5, id: 1 }), false, 'the procedural zone stays then');
  });

  test('换装: she has no outfit hook yet, so the base key plays as it stands', () => {
    const outfits = Object.keys(INDEX.skinFx || {}).filter((k) => k.startsWith(HER));
    assert.deepEqual(outfits, [], 'no outfit of hers is extracted (@… hooker)');
    assert.equal(FX_BINDINGS[SKILL].tide.skin, undefined, 'so the binding names no skin hook');
  });
});
