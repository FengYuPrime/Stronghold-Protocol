// test/ui/dev-enemy-hp.test.js — the dev enemy-HP button's ladder (public/js/ui/hud.js DEV_ENEMY_HP_STEPS /
// nextDevEnemyHp): the top bar cycles ×1 → ×5 → ×20 → ×100 → ×1 and sends the next step as `g.devEnemyHp { mul }`.
// The intent side: test/match/dev-enemy-hp.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { DEV_ENEMY_HP_STEPS, nextDevEnemyHp } = await import('../../public/js/ui/hud.js');

test('the dev enemy-HP button cycles ×1 → ×5 → ×20 → ×100 → ×1', () => {
  assert.deepEqual(DEV_ENEMY_HP_STEPS, [1, 5, 20, 100]);
  const seen = [];
  let cur = 1;
  for (let i = 0; i < 5; i++) { seen.push(cur); cur = nextDevEnemyHp(cur); }
  assert.deepEqual(seen, [1, 5, 20, 100, 1]);
  // the server's own value is what the button shows: a value the ladder does not hold restarts the cycle
  assert.equal(nextDevEnemyHp(undefined), 5);
  assert.equal(nextDevEnemyHp(7), 5);
  assert.equal(nextDevEnemyHp(100), 1);
});
