// test/render/spine-skill-stance.test.js — the resting pose of a skill whose loop is a *stance*: 烛煌 S3 (char_1040_blaze2)
// kept falling back to `Idle` between the attacks of her skill, because her S3 clip has no idle of its own
// (`anims.skills['2'] = { begin: 'Skill_3_Begin', loop: 'Skill_3_Loop', end: 'Skill_3_End', idle: null }`) and
// spine.js `_idleName` only held a skill pose when `skill.idle` existed. Skill_3_Loop carries no strike frame while
// Attack / Skill_1 / Skill_2_Loop do (`data/assets.json` `hits`) — it is the casting stance, not a swing — so it is the
// skill's resting clip, and its End clip belongs to the end of the skill (`setSkill(false)`), not to every attack.
// Real manifest entries, headless fake PIXI (test/render/fakepixi.js, style of feedback3-skill-idle.test.js).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakePixi } from './fakepixi.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const assets = JSON.parse(readFileSync(path.join(ROOT, 'data/assets.json'), 'utf8'));

let fake, SpineActor;
before(async () => {
  fake = installFakePixi();
  ({ SpineActor } = await import('../../public/js/render/spine.js'));
});
after(() => fake.restore());

/** An actor of a real operator's Front model with its equipped skill, recording every clip set / queued. */
function actor(charId, skillIndex) {
  const entry = assets.chars[charId].spine.front;
  const a = new SpineActor({ animations: Object.keys(entry.animations).map((name) => ({ name })) }, entry);
  a.setSkillIndex(skillIndex);
  a.log = [];
  const st = a.spine.state;
  const set = st.setAnimation, add = st.addAnimation;
  st.setAnimation = (i, name, loop) => { a.log.push(['set', name, !!loop]); return set(i, name, loop); };
  st.addAnimation = (i, name, loop) => { a.log.push(['queue', name, !!loop]); return add(i, name, loop); };
  return a;
}
const run = (a, s, dt = 1 / 60) => { for (let t = 0; t < s - 1e-9; t += dt) a.update(dt); };
const names = (a) => a.log.map(([, n]) => n);

test('烛煌 S3: the casting stance is the resting clip — an attack ends back on Skill_3_Loop, never on Skill_3_End', () => {
  const a = actor('char_1040_blaze2', 2);
  assert.deepEqual(a.roles.skill, { begin: 'Skill_3_Begin', loop: 'Skill_3_Loop', end: 'Skill_3_End', index: 2, idle: null }, 'the manifest roles');
  assert.ok(!a.entry.hits.Skill_3_Loop, 'Skill_3_Loop has no strike frame (Skill_1 / Skill_2_Loop / Attack do)');
  a.setSkill(true);
  assert.deepEqual(a.log, [['set', 'Skill_3_Begin', false], ['queue', 'Skill_3_Loop', true]], 'Begin, then the stance');
  run(a, 2);
  assert.equal(a.mode, 'base');
  a.log.length = 0;
  a.attack(1.2);
  assert.equal(a.current, 'Skill_3_Loop', 'an attack plays the stance clip, as before');
  run(a, 1.2 * 1.4 + 0.1);
  assert.equal(a.mode, 'base');
  assert.equal(a.current, 'Skill_3_Loop', 'and it stays in the stance afterwards — not back on Idle');
  assert.ok(!names(a).includes('Skill_3_End'), 'no End clip after an attack');
  assert.ok(!names(a).includes('Idle'), 'no flash of the idle either');
  a.setSkill(false);
  assert.equal(a.current, 'Skill_3_End', 'the End clip closes the skill');
  run(a, 1.5);
  assert.equal(a.current, 'Idle');
});

test('the stance is the unit\'s resting clip for everything else too (a base re-pose keeps it)', () => {
  const a = actor('char_1040_blaze2', 2);
  a.setSkill(true);
  run(a, 2);
  a.log.length = 0;
  a.setBase('move');   // a snapshot says "moving": no Move clip, so the resting clip stands
  assert.deepEqual(names(a), ['Skill_3_Loop'], 'still the stance, not Idle');
  a.attack(1.2);
  a.setSkill(false);   // the skill ends inside the attack's recovery
  assert.equal(a.current, 'Skill_3_End');
});

test('unchanged: a skill loop WITH a strike frame rests on the idle (银灰 S3 真银斩 — Skill has a hit at 0.433 s)', () => {
  const a = actor('char_172_svrash', 2);
  assert.deepEqual([a.roles.skill.begin, a.roles.skill.loop, a.roles.skill.idle], [null, 'Skill', null]);
  a.setSkill(true);
  assert.equal(a.current, 'Skill', 'the one-shot cast clip');
  run(a, 2);
  assert.equal(a.mode, 'base');
  assert.equal(a.current, 'Idle', 'rests on the idle while the skill still runs');
  a.log.length = 0;
  a.attack(1.2);
  run(a, 1.2 * 1.4 + 0.1);
  assert.equal(a.current, 'Idle', 'and after an attack, as before');
});

test('unchanged: a skill with its own idle clip between attacks (折桠 S2: Skill_2_Idle)', () => {
  const a = actor('char_4207_branch', 1);
  a.setSkill(true);
  run(a, 2);
  a.attack(1.5);
  run(a, 1.5 * 1.4 + 0.1);
  assert.equal(a.current, 'Skill_2_Idle', 'its own idle wins over the stance rule');
});

test("unchanged: a loop that is the skill's own idle clip (蕾缪安 S3) rests on that idle, as it already did", () => {
  const a = actor('char_4193_lemuen', 2);
  assert.equal(a.roles.skill.loop, a.roles.skill.idle, 'Skill_3_Idle is both');
  a.setSkill(true);
  assert.deepEqual(a.log, [['set', 'Skill_3_Begin', false], ['queue', 'Skill_3_Idle', true]], 'Begin, then its loop = idle');
  assert.equal(a._idleName(), 'Skill_3_Idle', 'the skill idle (the first rule) wins either way');
});

test('unchanged: a skill whose loop is the attack clip (via "attack", 宴 S2) plays no skill clip at all', () => {
  const a = actor('char_337_utage', 1);
  assert.equal(a.roles.skill.via, 'attack');
  a.setSkill(true);
  assert.deepEqual(a.log, [['set', 'Idle', true]], 'no skill clip: straight to the base');
  a.log.length = 0;
  a.attack(1.2);
  assert.equal(a.current, 'Attack', 'its attacks are the ordinary attack clip');
  run(a, 1.2 * 1.4 + 0.1);
  assert.equal(a.current, 'Idle', 'and it rests on the idle, as before');
});

test('unchanged: a skill with no Begin clip keeps resting on the idle (its clip is a one-shot cast — 德克萨斯 S2 剑雨)', () => {
  const a = actor('char_102_texas', 1);
  assert.equal(a.roles.skill.begin, null);
  assert.ok(!a.entry.hits.Skill, 'her Skill clip has no strike frame, but it is a cast clip, not a stance');
  a.setSkill(true);
  assert.equal(a.current, 'Skill');
  assert.equal(a._skillLoopIsStance(), false, 'no Begin clip: the one-shot cast class, not a stance');
  a.setSkill(false);   // an instant skill: the flag is already off
  run(a, 2.6);
  assert.equal(a.current, 'Idle');
  a.log.length = 0;
  a.setSkill(true);
  assert.equal(a.current, 'Skill', 'unchanged: the cast clip plays once');
});
