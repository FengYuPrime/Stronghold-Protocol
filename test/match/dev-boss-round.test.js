// 调试开关 SP_DEV_BOSS_ROUND (server/http/config.js devBossRound, server/match/gamedata.js bossRound): 只在 dev 模式
// （--dev / SP_DEV=1）且值是正整数时把 boss 回合提前；未设、非 dev、非法值都读数据里的原值。正式局永不生效。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameData } from '../../server/match/gamedata.js';
import { setupMatchWaves, buildBossWave } from '../../server/match/waves.js';
import { createRng } from '../../server/sim/rng.js';
import { DATA } from './harness.js';

/** Run fn with exactly these env values (undefined = unset), then restore the process env. */
function withEnv(env, fn) {
  const keys = ['SP_DEV', 'SP_DEV_BOSS_ROUND'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) {
      const v = env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const k of keys) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const gd = () => new GameData(DATA, 'mode_multi_hard'); // data: lastRound 14, bossRound 14, hiddenRound 15

test('dev + SP_DEV_BOSS_ROUND=2: bossRound is 2; the boss level data is still the mode\'s own boss round', () => {
  withEnv({ SP_DEV: '1', SP_DEV_BOSS_ROUND: '2' }, () => {
    const g = gd();
    assert.equal(g.bossRound, 2);
    assert.equal(g.lastRound, 14, 'the other round numbers do not move');
    assert.equal(g.hiddenRound, 15);
    // 只挪回合号，不挪关卡：被覆盖的回合仍读真正的 boss 回合配置，否则 Final Assault 会是一张没有 boss 的空图
    assert.equal(g.bossLevelTime(2), g.bossLevelTime(14), 'the boss countdown is the boss level\'s own');
    assert.equal(g.roundCfg(2), g.roundCfg(14), 'the boss round config (bossTemplates …) is the boss level\'s own');
    const setup = setupMatchWaves(g, createRng(7));
    const wave = buildBossWave(g, createRng(7), setup.factions, g.bossRound, { bossId: setup.bossId, solo: false });
    assert.ok(wave.templateId && wave.spawns.length > 0, 'the overridden boss round still has the real boss wave');
  });
});

test('a normal boot ignores SP_DEV_BOSS_ROUND (never read without dev mode)', () => {
  withEnv({ SP_DEV: undefined, SP_DEV_BOSS_ROUND: '2' }, () => assert.equal(gd().bossRound, 14));
});

test('dev without SP_DEV_BOSS_ROUND keeps the data value', () => {
  withEnv({ SP_DEV: '1', SP_DEV_BOSS_ROUND: undefined }, () => assert.equal(gd().bossRound, 14));
});

test('illegal values are ignored (0, negative, non-numeric, empty)', () => {
  for (const v of ['0', '-3', 'abc', '2.5', '2x', '']) {
    withEnv({ SP_DEV: '1', SP_DEV_BOSS_ROUND: v }, () => assert.equal(gd().bossRound, 14, `SP_DEV_BOSS_ROUND=${JSON.stringify(v)}`));
  }
});

test('a round the mode does not have is ignored (no wave config; the hidden round stays after the boss)', () => {
  for (const v of ['15', '99']) {
    withEnv({ SP_DEV: '1', SP_DEV_BOSS_ROUND: v }, () => {
      const g = gd();
      assert.equal(g.bossRound, 14, `SP_DEV_BOSS_ROUND=${v} is past lastRound 14`);
      assert.equal(g.hiddenRound, 15);
    });
  }
});
