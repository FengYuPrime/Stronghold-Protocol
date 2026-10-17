// 召唤物换装（token 皮肤变体）的素材计划：tools/assets/plan.mjs 从官方皮肤表的 tokenSkinMap 派生**全部**变体模型。
//
// 官方 `.cache/skin-table.json` 的 charSkins[*].tokenSkinMap 共 82 对 (tokenId → tokenSkinId)，之前只计划每对里的第一个
// （research 07 的 battleSpineSkinVariantsOnly），磁盘因此只有 12 套。这里检查派生的形状：每个变体一个模型、模型 key 唯一、
// 目录与 token 的默认模型相同（processModels 会全部下载）、旧的单数 spineVariant 仍然指向老的那一套；
// 另有一条用真实皮肤表断言 82 对全部被计划（没有 .cache 的 checkout 跳过）；owner 派生：池内没归属的召唤物从
// tokenSkinMap 所属皮肤的干员反推（仅当 owner 为空，干员不在清单时不派生、只记一条汇总）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlan, tokenSkinPairs, tokenSkinOwners, tokenSkinStem, variantModelFiles } from '../tools/assets/plan.mjs';
import { indexAudio } from '../tools/assets/audio.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const plan = (o = {}) => buildPlan({ assets07: {}, ops03: {}, enemies05: {}, maps05: {}, audio: indexAudio({}), modelsData: {}, ...o });

/** A model of the plan, by key. */
const modelOf = (p, key) => p.models.get(key);

/** The fake token record: no default model, one research-07 variant (`token_a_old_1`). */
const TOKENS07 = {
  token_a: { avatar: { url: 'https://example.test/avatar/token_a.png' }, battleSpineDefault: null, battleSpineSkinVariantsOnly: ['token_a_old_1'] },
  token_b: {
    avatar: { url: 'https://example.test/avatar/token_b.png' },
    battleSpineDefault: {
      skel: ['https://example.test/spine/token_b/token_b/Front/token_b.skel'],
      atlas: ['https://example.test/spine/token_b/token_b/Front/token_b.atlas'],
      png: ['https://example.test/spine/token_b/token_b/Front/token_b.png'],
    },
    battleSpineSkinVariantsOnly: [],
  },
};

const TABLE = {
  charSkins: {
    // a skin that re-models token_a: sale#4 (new) and the old research-07 one, which is also listed twice
    'char_1_owner@sale#4': {
      tokenSkinMap: [
        { tokenId: 'token_a', tokenSkinId: 'token_a_sale#4' },
        { tokenId: 'token_a', tokenSkinId: 'token_a_old#1' },
        { tokenId: 'token_a', tokenSkinId: 'token_a_old#1' },
        { bad: 1 },
        null,
      ],
    },
    'char_1_owner@epoque#2': {
      tokenSkinMap: [
        { tokenId: 'token_a', tokenSkinId: 'token_a_epoque#2' },
        { tokenId: 'token_b', tokenSkinId: 'token_b_epoque#2' },
        { tokenId: 'token_c', tokenSkinId: 'token_c_ghost#1' }, // not a token of this plan: files only, no manifest entry
      ],
    },
    'char_1_owner@plain#1': { tokenSkinMap: null },
  },
};

test('tokenSkinPairs / tokenSkinStem: the official pairs, unique, in table order; the site stem of a tokenSkinId', () => {
  const pairs = tokenSkinPairs(TABLE);
  assert.deepEqual([...pairs.keys()], ['token_a', 'token_b', 'token_c']);
  assert.deepEqual(pairs.get('token_a'), ['token_a_sale#4', 'token_a_old#1', 'token_a_epoque#2'], 'duplicates collapse, order kept');
  assert.deepEqual(tokenSkinPairs(null), new Map());
  assert.deepEqual(tokenSkinPairs({}), new Map());
  assert.deepEqual(tokenSkinPairs({ charSkins: { x: { tokenSkinMap: 'bad' } } }), new Map());
  assert.equal(tokenSkinStem('token_a_sale#4'), 'token_a_sale_4');
  assert.equal(tokenSkinStem('token_10031_swire2_gdtrap_ambienceSynesthesia#4'), 'token_10031_swire2_gdtrap_ambienceSynesthesia_4');
});

test('tokenSkinOwners: the outfit’s charId, first pair wins; no table → empty', () => {
  const owners = tokenSkinOwners(TABLE);
  assert.deepEqual([...owners], [['token_a', 'char_1_owner'], ['token_b', 'char_1_owner'], ['token_c', 'char_1_owner']]);
  assert.deepEqual(tokenSkinOwners(null), new Map());
  assert.deepEqual(tokenSkinOwners({ charSkins: { 'char_285_medic2#1': { tokenSkinMap: null } } }), new Map(),
    'an outfit with no map names no owner');
});

// The owner is what assets.js tokenSkinSpine resolves an outfit by (`tokens[tokenId].owner` → chars[owner].skins…).
// The pool attributes only its own summons, so a 自选 summon's owner comes from the outfit that re-models it.
test('plan: an absent owner is derived from the outfit; an attributed owner is never replaced; no outfit → still null', () => {
  const tokens07 = {
    token_a: { avatar: { url: 'https://example.test/a.png' }, battleSpineDefault: null, battleSpineSkinVariantsOnly: [] },
    token_b: { avatar: { url: 'https://example.test/b.png' }, battleSpineDefault: null, battleSpineSkinVariantsOnly: [] },
    token_c: { avatar: { url: 'https://example.test/c.png' }, battleSpineDefault: null, battleSpineSkinVariantsOnly: [] },
    token_d: { avatar: { url: 'https://example.test/d.png' }, battleSpineDefault: null, battleSpineSkinVariantsOnly: [] },
  };
  const table = {
    charSkins: {
      'char_1_owner@sale#4': { tokenSkinMap: [{ tokenId: 'token_a', tokenSkinId: 'token_a_sale#4' }] },
      'char_2_other@sale#1': { tokenSkinMap: [{ tokenId: 'token_b', tokenSkinId: 'token_b_sale#1' }] },
      'char_3_gone@sale#2': { tokenSkinMap: [{ tokenId: 'token_c', tokenSkinId: 'token_c_sale#2' }] },
    },
  };
  const ops03 = {
    chess: [{ chessId: 'chess_pool', charId: 'char_9_pool' }],
    tokensUsedByPool: { token_b: { usedByChess: ['chess_pool'] } },
  };
  const extraOperators = { char_1_owner: { skills: [] }, char_9_pool: { skills: [] } };
  const p = plan({ assets07: { tokens: tokens07 }, ops03, extraOperators, skinTable: table });
  assert.equal(p.template.tokens.token_a.owner, 'char_1_owner', 'an absent owner comes from the outfit’s operator');
  assert.equal(p.template.tokens.token_b.owner, 'char_9_pool', 'an owner the pool names is kept (its outfit says char_2_other)');
  assert.equal(p.template.tokens.token_c.owner, null, 'the outfit’s operator is outside this manifest: no owner derived');
  assert.equal(p.template.tokens.token_d.owner, null, 'no outfit: still no owner');
  assert.ok(p.notes.some((n) => /outside this manifest/.test(n) && n.includes('char_3_gone')),
    'the outfits that cannot be derived are reported in one note');
});

test('plan: one model per outfit, the same token folder, unique keys; the old spineVariant stays the first variant', () => {
  const p = plan({ assets07: { tokens: TOKENS07 }, skinTable: TABLE });
  const a = p.template.tokens.token_a;
  // research 07 first, then the table's pairs: the old 12 models keep their meaning and their files
  assert.equal(a.spineVariant, 'token_a_old_1');
  assert.deepEqual(a.spineVariants, ['token_a_old_1', 'token_a_sale_4', 'token_a_epoque_2']);
  const keys = ['token:token_a', 'token:token_a:token_a_sale_4', 'token:token_a:token_a_epoque_2'];
  for (const key of keys) {
    const m = modelOf(p, key);
    assert.ok(m, `${key} planned`);
    assert.equal(m.kind, 'token');
    assert.equal(m.dir, 'spine/token/token_a/', `${key}: the summon's own folder`);
    assert.deepEqual(m.skillIndices, [0]);
  }
  // the summon's own model is the old variant (test/fetch-assets-shrink and tools/skins.mjs read it as such)
  assert.ok(a.spine && a.spine.model === 'token:token_a');
  assert.equal(modelOf(p, 'token:token_a').skel.rel, 'spine/token/token_a/token_a_old_1.skel');
  // a variant model: files named by the token skin's stem, downloaded from the fexli folder named by that stem
  const sale = modelOf(p, 'token:token_a:token_a_sale_4');
  assert.equal(sale.skel.rel, 'spine/token/token_a/token_a_sale_4.skel');
  assert.equal(sale.atlas.rel, 'spine/token/token_a/token_a_sale_4.atlas');
  assert.deepEqual(sale.pngs.map((x) => x.rel), ['spine/token/token_a/token_a_sale_4.png']);
  assert.deepEqual(sale.skel.urls, ['https://raw.githubusercontent.com/fexli/ArknightsResource/main/spine/token_a/token_a_sale_4/Spine/token_a_sale_4.skel',
    'https://raw.githubusercontent.com/fexli/ArknightsResource/main/spine/token_a/token_a_sale_4/Front/token_a_sale_4.skel']);
  assert.deepEqual(sale.atlas.urls, ['https://raw.githubusercontent.com/fexli/ArknightsResource/main/spine/token_a/token_a_sale_4/Spine/token_a_sale_4.atlas',
    'https://raw.githubusercontent.com/fexli/ArknightsResource/main/spine/token_a/token_a_sale_4/Front/token_a_sale_4.atlas']);
  // its files are no manifest entry (only tokens[id].spine is), so fetch-assets has to keep them from --prune
  assert.deepEqual(variantModelFiles(p.models).sort(), [
    'spine/token/token_a/token_a_epoque_2.atlas', 'spine/token/token_a/token_a_epoque_2.png', 'spine/token/token_a/token_a_epoque_2.skel',
    'spine/token/token_a/token_a_sale_4.atlas', 'spine/token/token_a/token_a_sale_4.png', 'spine/token/token_a/token_a_sale_4.skel',
    'spine/token/token_b/token_b_epoque_2.atlas', 'spine/token/token_b/token_b_epoque_2.png', 'spine/token/token_b/token_b_epoque_2.skel',
    'spine/token/token_c/token_c_ghost_1.atlas', 'spine/token/token_c/token_c_ghost_1.png', 'spine/token/token_c/token_c_ghost_1.skel',
  ]);
});

test('plan: a summon with a default model keeps it and still gets every outfit model beside it', () => {
  const p = plan({ assets07: { tokens: TOKENS07 }, skinTable: TABLE });
  const b = p.template.tokens.token_b;
  assert.equal(b.spineVariant, undefined, 'the default model is not an outfit');
  assert.deepEqual(b.spineVariants, ['token_b_epoque_2']);
  assert.ok(b.spine && b.spine.model === 'token:token_b');
  assert.equal(modelOf(p, 'token:token_b').skel.rel, 'spine/token/token_b/token_b.skel');
  assert.equal(modelOf(p, 'token:token_b:token_b_epoque_2').dir, 'spine/token/token_b/');
});

test('plan: a summon this fork does not list still gets its outfit models (files only, no tokens[id] entry)', () => {
  const p = plan({ assets07: { tokens: TOKENS07 }, skinTable: TABLE });
  assert.equal(p.template.tokens.token_c, undefined);
  const m = modelOf(p, 'token:token_c:token_c_ghost_1');
  assert.ok(m);
  assert.equal(m.dir, 'spine/token/token_c/');
  assert.equal(m.skel.rel, 'spine/token/token_c/token_c_ghost_1.skel');
});

test('variantModelFiles keeps a summon’s other outfits from the --prune orphan sweep', async () => {
  const { orphanFiles } = await import('../tools/fetch-assets.mjs');
  const p = plan({ assets07: { tokens: TOKENS07 }, skinTable: TABLE });
  const kept = new Set(variantModelFiles(p.models));
  assert.deepEqual(orphanFiles(['spine/token/token_a/unrelated.png', ...kept], kept), ['spine/token/token_a/unrelated.png'],
    'the variant files are not orphans, anything else still is');
});

test('plan: without a skin table research 07 still plans its single variant per summon (the old 12 sets)', () => {
  const p = plan({ assets07: { tokens: TOKENS07 } });
  assert.deepEqual([...p.models.keys()].sort(), ['token:token_a', 'token:token_b']);
  assert.equal(p.template.tokens.token_a.spineVariant, 'token_a_old_1');
  assert.deepEqual(p.template.tokens.token_a.spineVariants, ['token_a_old_1']);
  assert.deepEqual(variantModelFiles(p.models), [], 'the only variant is the summon’s own model: nothing extra to keep');
});

test('the real skin table: all 82 tokenSkinMap pairs are planned, under their summon’s folder', () => {
  const skinTablePath = path.join(ROOT, '.cache', 'skin-table.json');
  if (!fs.existsSync(skinTablePath)) return; // a checkout that never ran tools/skins.mjs
  const table = readJson('.cache/skin-table.json');
  const pairs = tokenSkinPairs(table);
  let total = 0;
  for (const list of pairs.values()) total += list.length;
  assert.equal(total, 82, 'the official skin_table.json maps 82 summons to an outfit (2026-10 data)');

  const p = plan({
    assets07: readJson('docs/research/07-assets.json'),
    ops03: readJson('docs/research/03-operators.json'),
    enemies05: readJson('docs/research/05-enemies.json'),
    maps05: readJson('docs/research/05-maps.json'),
    extraTokenIds: Object.keys(readJson('data/backups.json').tokens || {}),
    skinTable: table,
  });
  for (const [tokenId, tokenSkinIds] of pairs) {
    for (const tokenSkinId of tokenSkinIds) {
      const stem = tokenSkinStem(tokenSkinId);
      const primary = modelOf(p, `token:${tokenId}`);
      const key = `token:${tokenId}:${stem}`;
      const m = modelOf(p, key) || primary;
      assert.ok(m, `${tokenSkinId} planned (as ${key} or the summon's own model)`);
      assert.equal(m.dir, `spine/token/${tokenId}/`, `${tokenSkinId}: the summon's own folder`);
      if (modelOf(p, key)) assert.equal(m.skel.rel, `spine/token/${tokenId}/${stem}.skel`);
      else assert.equal(p.template.tokens[tokenId]?.spineVariant, stem, `${tokenSkinId}: the plan's own model is this outfit`);
    }
  }
  // the old sets are still the plan's own models (tools/skins.mjs tokenSkinEntries reads tokens[id].spineVariant)
  for (const [id, t] of Object.entries(readJson('docs/research/07-assets.json').tokens || {})) {
    const first = (t.battleSpineSkinVariantsOnly || [])[0];
    if (!first) continue;
    assert.equal(p.template.tokens[id]?.spineVariant, first, `${id}: the research-07 variant stays the summon's model`);
    assert.ok(p.template.tokens[id].spineVariants.includes(first), `${id}: and is listed among its outfits`);
  }
});
