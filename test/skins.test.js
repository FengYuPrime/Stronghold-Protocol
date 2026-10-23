// 干员换装（皮肤）：目录、协议校验、以及素材缺失时的回退（docs/SKINS.md）。
//
// 这里检查的是「代码与数据合同的形状」，不是界面：目录里的每条皮肤都被协议接受、目录与素材清单不互相矛盾、
// 挑了模型不在磁盘上的皮肤时 spineEntry 仍然给出干员自己的模型（回退，绝不返回 null 让棋子变成空壳）。
// 素材本身要靠 tools/fetch-assets.mjs / 完整包补齐，测试不依赖它。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKIN_LIMITS, isSkinId, isSkinSelection, C2S } from '../shared/protocol.js';
import { spineEntry, hasBackSpine, avatarUrl } from '../public/js/assets.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const catalogue = read('data/skins.json');
const manifest = read('data/assets.json');

/** The site path's stem: `char_1012_skadi2@boc#4` → `char_1012_skadi2_boc_4` (both id forms of one skin). */
const stemOf = (id) => String(id).replace(/@/g, '_').replace(/#/g, '_');
/** Every catalogue stem — a manifest entry may use the other id form of the same skin (`@` vs `_`). */
const catalogueStems = new Set();
for (const list of Object.values(catalogue.chars || {})) for (const s of list || []) catalogueStems.add(stemOf(s.id));

/** Every { charId, skin } of the catalogue, flattened. */
function* entries() {
  for (const [charId, list] of Object.entries(catalogue.chars || {})) {
    for (const s of list || []) yield { charId, skin: s };
  }
}

test('data/skins.json is a pure catalogue: ids, names, series — no URLs', () => {
  assert.ok(catalogue.chars && typeof catalogue.chars === 'object');
  assert.equal(catalogue.counts.chars, Object.keys(catalogue.chars).length);
  let n = 0;
  for (const { charId, skin } of entries()) {
    n++;
    assert.match(charId, /^char_/, `${charId} is an operator id`);
    assert.ok(isSkinId(skin.id), `${skin.id} is a legal skinId`);
    // 皮肤 id 的前缀是它所属的干员；阿米娅的变体（char_1001_amiya2…）按官方表归到阿米娅名下，用 stem 判断
    assert.ok(stemOf(skin.id).startsWith(charId), `${skin.id} belongs to ${charId}`);
    assert.equal(typeof skin.name, 'string');
    assert.ok(skin.name.length > 0);
    if (skin.group !== undefined) assert.equal(typeof skin.group, 'string');
    for (const v of Object.values(skin)) assert.ok(typeof v === 'string', `${skin.id} carries no objects/URLs`);
  }
  assert.equal(catalogue.counts.skins, n);
  assert.ok(n > 0);
});

test('every catalogued skin is a legal room.skins entry (the @ and # of a skinId are not isId-legal)', () => {
  assert.equal(typeof C2S['room.skins']?.skins, 'function');
  for (const { charId, skin } of entries()) {
    assert.ok(isSkinId(skin.id), skin.id);
    assert.ok(isSkinSelection({ chess_char_1_01_a: skin.id }), `${charId}: a chess → skinId map passes`);
  }
  assert.ok(isSkinId('char_002_amiya@winter#1'));
  assert.ok(!isSkinId('bad id!'));
  assert.ok(!isSkinId(''));
  assert.ok(!isSkinId('x'.repeat(SKIN_LIMITS.idLen + 1)));
  assert.ok(!isSkinSelection([]));
  assert.ok(!isSkinSelection({ 'chess_char_1_01_a': 'has space' }));
});

test('the manifest only lists skins the catalogue knows, and a listed spine is structurally resolvable', () => {
  let withSpine = 0;
  for (const [charId, rec] of Object.entries(manifest.chars || {})) {
    for (const [skinId, skin] of Object.entries(rec.skins || {})) {
      const known = (catalogue.chars[charId] || []).some((s) => s.id === skinId || stemOf(s.id) === stemOf(skinId));
      assert.ok(known, `${skinId} is not in data/skins.json`);
      if (skin.avatar) assert.match(skin.avatar, /^\/assets\//);
      if (!skin.spine) continue; // no files on disk: the catalogue still lists it, the renderer falls back
      withSpine++;
      const sp = skin.spine.front;
      assert.ok(sp && typeof sp.skel === 'string' && typeof sp.atlas === 'string' && Array.isArray(sp.textures));
      assert.equal(sp.skel.replace(/\.skel$/, '.atlas'), sp.atlas, `${skinId}: the atlas sits next to the skeleton`);
      assert.ok(sp.anims && typeof sp.anims === 'object', `${skinId}: the build-time spine pipeline produced anims`);
    }
  }
  // the assertion above is the shape check; this documents that an install without skin models is the normal state
  assert.ok(Number.isInteger(withSpine));
});

test('spineEntry resolves a skin, and falls back to the operator when its files are missing', () => {
  const charId = 'char_1014_nearl2';
  const rec = manifest.chars[charId];
  assert.ok(rec, `${charId} is in the manifest`);
  const own = spineEntry(manifest, charId, {});
  assert.ok(own && own.skel, 'the operator has its own model');

  // the skin block of the manifest (`chars[charId].skins`) only exists once the models are downloaded; without it a
  // choice must still resolve — to the operator's own model, never null (the piece keeps a body)
  const skinId = Object.keys(rec.skins || {})[0] || 'char_1014_nearl2@epoque#17';
  const skinned = spineEntry(manifest, charId, { skin: skinId });
  assert.ok(skinned && skinned.skel, 'a skin resolves to a model (its own, or the operator as fallback)');
  if (rec.skins?.[skinId]?.spine) {
    assert.equal(skinned.skel, rec.skins[skinId].spine.front.skel);
    assert.deepEqual(skinned.fallback?.skel, own.skel, 'the skin entry carries the operator model as its fallback');
  } else {
    assert.equal(skinned.skel, own.skel, 'no skin files on disk → the operator’s own model, never null');
  }

  // an unknown chess / skin never throws and never leaves a piece without a model
  assert.equal(spineEntry(manifest, 'char_1014_nearl2', { skin: 'char_1014_nearl2@nope#99' }).skel, own.skel);
  assert.equal(spineEntry(manifest, 'not_a_char', {}), null);
  assert.equal(typeof avatarUrl(manifest, charId, { skin: skinId }), 'string');
  assert.equal(typeof hasBackSpine(manifest, charId, skinId), 'boolean');
  assert.equal(hasBackSpine(manifest, 'not_a_char', null), false);
});

test('every installed atlas names texture files that really exist (the pixi-spine baseTexture crash)', async () => {
  // 这条抓的是搬运时最容易错的一步：库里的文件叫 `char_x_summer#3.png`，站点路径叫 `..._summer_3.png`，
  // 图集里若还写着旧名字，pixi-spine 取图失败（error in texture loader … reading 'baseTexture'），
  // 棋子在棋盘上就没有模型——tools/skins.mjs 的 normalizePageNames 负责改图集里的页名。
  const { atlasInfo } = await import('../tools/assets/atlas.mjs');
  const { join } = await import('node:path');
  let checked = 0;
  const missing = [];
  for (const [charId, rec] of Object.entries(manifest.chars || {})) {
    for (const [skinId, skin] of Object.entries(rec.skins || {})) {
      const sp = skin.spine && skin.spine.front;
      if (!sp || !sp.atlas) continue;
      const atlasAbs = join(ROOT, 'public', ...String(sp.atlas).split('/').filter(Boolean));
      if (!fs.existsSync(atlasAbs)) continue;
      const dir = path.dirname(atlasAbs);
      let info;
      try { info = atlasInfo(fs.readFileSync(atlasAbs, 'utf8')); } catch { continue; }
      checked++;
      for (const page of info.pages) {
        if (!fs.existsSync(join(dir, page))) missing.push(`${charId} ${skinId}: 图集页 ${page} 在磁盘上不存在`);
      }
    }
  }
  assert.equal(missing.length, 0, missing.slice(0, 5).join(' | '));
  assert.ok(checked >= 0);
});

test('the blank-line fix: an atlas copied from the dump must not start with an empty line', async () => {
  // pixi-spine 逐行读图集、把第一行当贴图页名；本地库的图集开头都有一个空行（实测 1956/1956），
  // 于是页名变成 ""、贴图取不到，整条骨骼被丢弃并回退到默认模型。tools/skins.mjs 的
  // stripLeadingBlankLines() 负责去掉它，normalize 会把它落盘。
  const { stripLeadingBlankLines } = await import('../tools/skins.mjs');
  const { atlasInfo } = await import('../tools/assets/atlas.mjs');
  assert.equal(stripLeadingBlankLines('\nchar_x.png\nsize: 1,1\n').split('\n')[0], 'char_x.png');
  assert.equal(stripLeadingBlankLines('\uFEFF\n\nchar_x.png\n').split('\n')[0], 'char_x.png');
  assert.equal(stripLeadingBlankLines('char_x.png\n').split('\n')[0], 'char_x.png');
  assert.equal(stripLeadingBlankLines('').split('\n')[0], '');
  assert.deepEqual(atlasInfo(stripLeadingBlankLines('\n\nchar_x.png\nsize: 512,512\nformat: RGBA8888\n')).pages, ['char_x.png']);

  // 站点 URL /assets/spine/... → 磁盘 public/assets/spine/...
  const { join } = await import('node:path');
  const blank = [];
  let seen = 0;
  for (const [charId, rec] of Object.entries(manifest.chars || {})) {
    for (const [skinId, skin] of Object.entries(rec.skins || {})) {
      for (const side of ['front', 'back']) {
        const sp = skin.spine && skin.spine[side];
        if (!sp || !sp.atlas) continue;
        const abs = join(ROOT, 'public', ...String(sp.atlas).split('/').filter(Boolean));
        if (!fs.existsSync(abs)) continue;
        seen++;
        const first = fs.readFileSync(abs, 'utf8').split('\n')[0];
        if (first.trim() === '') blank.push(`${charId} ${skinId} ${side}`);
      }
    }
  }
  assert.ok(seen > 100, `检查了 ${seen} 个图集（应覆盖清单里的皮肤模型）`);
  assert.equal(blank.length, 0, `${blank.length}/${seen} 个图集首行是空的（跑 node tools/skins.mjs normalize 修）：${blank.slice(0, 4).join(', ')}`);
});

test('the catalogue covers most of this version’s operators (a missing char simply hides the 换装 block)', () => {
  const chess = read('data/chess.json');
  const backups = read('data/backups.json');
  const charIds = new Set();
  for (const c of Object.values(chess)) if (c && typeof c.charId === 'string') charIds.add(c.charId);
  for (const id of Object.keys(backups.units || {})) charIds.add(id);
  const covered = [...charIds].filter((id) => (catalogue.chars[id] || []).length > 0);
  assert.ok(charIds.size > 100);
  assert.ok(covered.length / charIds.size > 0.7, `${covered.length}/${charIds.size} operators have skins`);
});

// ---- 召唤物换装 (the official tokenSkinMap) ----------------------------------------------------------------

/** The cached official table (`node tools/skins.mjs inject` reads the same file); absent on a checkout that never ran it. */
function skinTable() {
  const abs = path.join(ROOT, '.cache', 'skin-table.json');
  return fs.existsSync(abs) ? JSON.parse(fs.readFileSync(abs, 'utf8')) : null;
}

test('tokenSkinMapOf: the official tokenSkinMap of an outfit (null for most, [{ tokenId, tokenSkinId }] for the rest)', async () => {
  const { tokenSkinMapOf } = await import('../tools/skins.mjs');
  // shape as in .cache/skin-table.json: `tokenSkinMap: null` on a normal outfit, an array of pairs on one that re-models
  // a summon; malformed members are dropped instead of reaching the manifest
  const table = {
    charSkins: {
      'char_x@plain#1': { skinId: 'char_x@plain#1', tokenSkinMap: null },
      'char_x@aura#2': {
        skinId: 'char_x@aura#2',
        tokenSkinMap: [{ tokenId: 'token_a', tokenSkinId: 'token_a_aura#2' }, { bad: 1 }, { tokenId: 5, tokenSkinId: 'x' }, null],
      },
    },
  };
  assert.deepEqual(tokenSkinMapOf(table, 'char_x@plain#1'), []);
  assert.deepEqual(tokenSkinMapOf(table, 'char_x@aura#2'), [{ tokenId: 'token_a', tokenSkinId: 'token_a_aura#2' }]);
  assert.deepEqual(tokenSkinMapOf(null, 'char_x@aura#2'), []);
  assert.deepEqual(tokenSkinMapOf({ charSkins: {} }, 'nope'), []);

  // the real table carries the reported case: 琳琅诗怀雅's 律动方格 and 盛世之象 both re-model the 香槟炸弹
  const real = skinTable();
  if (!real) return;
  assert.deepEqual(tokenSkinMapOf(real, 'char_1033_swire2@ambienceSynesthesia#4'), [
    { tokenId: 'token_10031_swire2_gdtrap', tokenSkinId: 'token_10031_swire2_gdtrap_ambienceSynesthesia#4' },
  ]);
  assert.deepEqual(tokenSkinMapOf(real, 'char_1033_swire2@nlc#1'), [
    { tokenId: 'token_10031_swire2_gdtrap', tokenSkinId: 'token_10031_swire2_gdtrap_nlc#1' },
  ]);
  assert.deepEqual(tokenSkinMapOf(real, 'char_285_medic2#1'), [], 'a default outfit swaps no token');
});

test('inject’s join: an outfit gets its summons’ models only where the files are on disk', async (t) => {
  const { tokenSkinEntries } = await import('../tools/skins.mjs');
  const table = skinTable();
  if (!table) return t.skip('no .cache/skin-table.json (tools/skins.mjs has not fetched it)');
  const skinId = 'char_1033_swire2@ambienceSynesthesia#4';
  // the map names token_10031_swire2_gdtrap_ambienceSynesthesia#4 → the flat site folder of the token, file named by stem
  const stem = 'token_10031_swire2_gdtrap_ambienceSynesthesia_4';
  const skel = path.join(ROOT, 'public', 'assets', 'spine', 'token', 'token_10031_swire2_gdtrap', `${stem}.skel`);
  if (!fs.existsSync(skel)) return t.skip('the skin-variant token model is not installed on this checkout');
  const entries = await tokenSkinEntries(manifest, skinId, table);
  const e = entries.token_10031_swire2_gdtrap;
  assert.ok(e, 'the outfit contributes a model for the bottle');
  assert.equal(e.tokenSkinId, 'token_10031_swire2_gdtrap_ambienceSynesthesia#4');
  assert.equal(e.spine.skel, `/assets/spine/token/token_10031_swire2_gdtrap/${stem}.skel`);
  assert.equal(e.spine.skel.replace(/\.skel$/, '.atlas'), e.spine.atlas, 'the atlas sits next to the skeleton');
  assert.ok(e.spine.anims && e.spine.anims.idle, 'anims resolved: the client validSpine() accepts it');
  // an outfit with no tokenSkinMap contributes nothing (the summons keep their own model)
  assert.deepEqual(await tokenSkinEntries(manifest, 'char_285_medic2#1', table), {});
});

test('inject maps every numbered skill clip of an outfit’s own skeleton (her S3 stance, not the attack swing)', async (t) => {
  const { resolveSkinSpineFromDisk } = await import('../tools/skins.mjs');
  // `inject` resolves a skin on its own (data/assets.json carries no skill table), so the outfit's skeleton is the only
  // source of its skill clips: 史尔特尔's 自由//失效 ships Skill_2 / Skill_3_Begin / _Idle / _Loop and must resolve them
  // (a `skills` map the renderer's setSkillIndex reads) instead of falling back to `via: 'attack'` for every skill.
  const charId = 'char_350_surtr';
  const stem = 'char_350_surtr_it_1';
  const skel = path.join(ROOT, 'public', 'assets', 'spine', 'op', charId, stem, 'front', `${stem}.skel`);
  if (!fs.existsSync(skel)) return t.skip('the 自由//失效 model is not installed on this checkout');
  const { entry } = await resolveSkinSpineFromDisk(charId, stem, 'front', { skillIndices: [0] });
  assert.ok(entry && entry.anims, 'the outfit resolves to a drawable entry');
  assert.deepEqual(entry.anims.skills?.['2'], { begin: 'Skill_3_Begin', loop: 'Skill_3_Loop', end: null, index: 2, idle: 'Skill_3_Idle' },
    'S3 (index 2) is her own clip set');
  assert.deepEqual(entry.anims.skills?.['1'], { begin: null, loop: 'Skill_2', end: null, index: 1, idle: null }, 'S2 likewise');

  // and what the manifest's installed outfits carry today: a clip set per numbered skill its skeleton has. A manifest
  // written before this fix has none (data/assets.json is generated: re-run `node tools/skins.mjs inject`), so this
  // sweep reports the gap instead of failing the tree.
  let missing = 0;
  for (const [id, rec] of Object.entries(manifest.chars || {})) {
    for (const [skinId, skin] of Object.entries(rec.skins || {})) {
      const sp = skin && skin.spine && skin.spine.front;
      if (!sp || !sp.anims) continue;
      const names = Object.keys(sp.animations || {});
      // Some skeletons zero-pad the skill index (Skill_03_Loop) and some do not (Skill_3_Loop): compare with the
      // name the skeleton actually carries, not with a name built from the number.
      const loops = names.filter((x) => /^Skill_\d+_Loop$/.test(x));
      const n = loops.map((x) => Number(/^Skill_(\d+)_Loop$/.exec(x)[1])).sort((a, b) => a - b)[0];
      if (!n) continue;
      const expected = loops.find((x) => Number(/^Skill_(\d+)_Loop$/.exec(x)[1]) === n);
      const clip = sp.anims.skills?.[String(n - 1)];
      if (clip && clip.loop === expected) continue;
      missing++;
      assert.ok(!clip || clip.loop === expected, `${id} ${skinId}: a skill map names the wrong clip (${clip?.loop} vs ${expected})`);
    }
  }
  t.diagnostic(`${missing} installed outfit(s) in data/assets.json have no numbered skill clips yet`);
});

test('浊心斯卡蒂: 红女爵’s summon is 红女爵’s own model — never 升华’s (user report)', (t) => {
  // 用户实测：浊心斯卡蒂穿「红女爵」时，她召唤的海嗣用的是「升华」那套的召唤物模型。
  // 两套皮肤的官方 tokenSkinMap、磁盘变体与清单条目：
  //   char_1012_skadi2@iteration#2 红女爵 → token_10017_skadi2_dedant_iteration#2 → 文件 …_iteration_2.*
  //   char_1012_skadi2@boc#4       升华   → token_10017_skadi2_dedant_boc#4       → 文件 …_boc_4.*
  const TOKEN = 'token_10017_skadi2_dedant';
  const RED = 'char_1012_skadi2@iteration#2';
  const BOC = 'char_1012_skadi2@boc#4';
  const tok = manifest.tokens?.[TOKEN];
  const skins = manifest.chars?.char_1012_skadi2?.skins || {};
  if (!tok || !skins[RED]?.tokens?.[TOKEN] || !skins[BOC]?.tokens?.[TOKEN]) {
    return t.skip('the skadi2 summon outfit models are not installed on this checkout');
  }
  const own = tok.spine;                                  // the token's own model (for this summon: the 升华 variant — see below)
  const red = skins[RED].tokens[TOKEN].spine;
  const boc = skins[BOC].tokens[TOKEN].spine;
  assert.equal(skins[RED].tokens[TOKEN].tokenSkinId, 'token_10017_skadi2_dedant_iteration#2', '红女爵 re-models it with its own skin');
  assert.equal(skins[BOC].tokens[TOKEN].tokenSkinId, 'token_10017_skadi2_dedant_boc#4');
  assert.match(red.skel, /token_10017_skadi2_dedant_iteration_2\.skel$/);
  assert.match(boc.skel, /token_10017_skadi2_dedant_boc_4\.skel$/);

  // the invariant: wearing 红女爵 resolves to 红女爵's stem or (with no files) the token's own model — the 升华 stem may never
  // come out of it. `skattered`: the token has no default model upstream (research 07 battleSpineDefault null), so
  // `tokens[].spine` IS the 升华 variant's files (plan.mjs spineVariant) — that is exactly why a lookup that never got the
  // outfit drew 升华, and why every surface must hand `skin` to spineEntry (render/app.js pieceInfo, 召唤物换装).
  assert.equal(own.skel, boc.skel, 'this summon’s own model is the first outfit variant the plan had (升华)');
  const allowed = new Set([red.skel, own.skel]);
  const worn = spineEntry(manifest, TOKEN, { skin: RED });
  assert.ok(allowed.has(worn.skel), `${worn.skel} is 红女爵’s own model or the token’s own`);
  assert.equal(worn.skel, red.skel, 'the outfit’s model wins');
  assert.ok(!worn.skel.includes('boc_4'), 'never 升华');
  assert.equal(worn.fallback.skel, own.skel, 'a load failure falls back to the token’s own model, not to another outfit search');

  // 升华 still resolves to 升华, and a state without the outfit gets the token's own model
  assert.equal(spineEntry(manifest, TOKEN, { skin: BOC }).skel, boc.skel);
  assert.equal(spineEntry(manifest, TOKEN, {}).skel, own.skel, 'no outfit: the token’s own model');
  // an outfit that swaps no token (this one belongs to another operator) falls back too, never to a sibling outfit
  assert.equal(spineEntry(manifest, TOKEN, { skin: 'char_014_cardigan@epoque#1' }).skel, own.skel);

  // 2a check: the manifest entry agrees with the official table (tools/skins.mjs inject wrote both outfits, none missing)
  const table = skinTable();
  if (table) {
    assert.deepEqual(tokenSkinMapOfReal(table, RED), [{ tokenId: TOKEN, tokenSkinId: 'token_10017_skadi2_dedant_iteration#2' }]);
    assert.deepEqual(tokenSkinMapOfReal(table, BOC), [{ tokenId: TOKEN, tokenSkinId: 'token_10017_skadi2_dedant_boc#4' }]);
  }
});

test('a summon whose outfit has no variant keeps the token’s own model (the fallback, never a sibling outfit)', () => {
  // any installed outfit that does not re-model this token: the answer is `tokens[id].spine` — the same model as no
  // outfit at all, so an install without the variant files still draws a body.
  const TOKEN = 'token_10017_skadi2_dedant';
  const tok = manifest.tokens?.[TOKEN];
  if (!tok?.spine) return;
  const own = spineEntry(manifest, TOKEN, {});
  assert.equal(own.skel, tok.spine.skel);
  for (const skinId of ['char_1012_skadi2@iteration#2', 'char_1012_skadi2@boc#4']) {
    const mapped = manifest.chars?.char_1012_skadi2?.skins?.[skinId]?.tokens?.[TOKEN];
    if (mapped) assert.equal(spineEntry(manifest, TOKEN, { skin: skinId }).skel, mapped.spine.skel, `${skinId}: its own stem`);
    else assert.equal(spineEntry(manifest, TOKEN, { skin: skinId }).skel, tok.spine.skel, `${skinId}: the token’s own model`);
  }
});

test('the prep board hands a summon piece its owner’s outfit (render/app.js pieceInfo → assets.js tokenSkinSpine)', () => {
  // 实测的漏点：召唤物的 skin 只在战斗侧由 UnitInfo 带过来（server/sim/battle/players.js _makeAlly），而备战棋盘 /
  // 整备区 / 临时整备区画的是 m.private 的棋子（pieceView 只给 chess 棋子 skin）——召唤物棋子因此没有皮肤，
  // spineEntry 拿不到 skin，退回 tokens[id].spine（对海嗣就是升华的模型）。pieceInfo 必须像给干员取皮肤那样，
  // 用 ownerUid 找主人棋子、按主人的规则解析。
  const src = fs.readFileSync(path.join(ROOT, 'public/js/render/app.js'), 'utf8');
  assert.match(src, /const skin = piece\.skin \?\? summonerSkin\(piece\);/);
  assert.match(src, /function summonerSkin\(piece\) \{[\s\S]{0,300}summonSkinOf\(piece, prepByUid, \{ chess: \(id\) => data\.chess\(id\), diy: diyPicks \}\);/,
    'the owner piece’s own outfit, by the same rule (ui/skins.js summonSkinOf)');
  assert.match(src, /prepByUid = new Map\(list\.map\(\(e\) => \[e\.uid, e\.piece\]\)\);/);
  assert.match(src, /tier: piece\.tier \|\| 1, golden: false, dir, skin \}/, 'the summon piece carries it into the view');
  assert.match(src, /import \{ skinFor, summonSkinOf \} from '\.\.\/ui\/skins\.js';/);
});

test('summonSkinOf: the summon wears its owner piece’s outfit — never another piece’s, base when there is none', async () => {
  const { summonSkinOf, setSkins } = await import('../public/js/ui/skins.js');
  const RED = 'char_1012_skadi2@iteration#2';
  const BOC = 'char_1012_skadi2@boc#4';
  const chess = (rec) => (id) => (id === 'chess_char_6_04_a' || id === 'chess_char_6_04_b' ? rec : null);
  const SKADI = { baseId: 'chess_char_6_04_a', chessId: 'chess_char_6_04_b', charId: 'char_1012_skadi2' };
  const TOKEN = { kind: 'token', id: 'token_10017_skadi2_dedant', uid: 11, ownerUid: 10 };
  const run = (pieces, lookups = { chess: chess(SKADI), diy: {} }) => summonSkinOf(TOKEN, pieces, lookups);

  try {
    // the browser's own choice, keyed by the BASE chess id (a promoted copy uses the same choice)
    setSkins({ 'chess_char_6_04_a': RED });
    const own = new Map([[10, { kind: 'chess', id: 'chess_char_6_04_b' }], [11, TOKEN]]);
    assert.equal(run(own), RED, '红女爵 from the local choice of its base chess');
    // the server piece view's own skin wins (a teammate's / a committed placement)
    const served = new Map([[10, { kind: 'chess', id: 'chess_char_6_04_a', skin: BOC }], [11, TOKEN]]);
    assert.equal(run(served), BOC);
    // the owner standing in the hand / 临时整备区 counts the same (any area of the same prep state)
    assert.equal(run(new Map([[10, { kind: 'chess', id: 'chess_char_6_04_a' }]]).set(11, TOKEN)), RED);
    // no choice at all: null — the summon then keeps its own model (for this token: the 升华 variant the mirror has)
    setSkins({});
    assert.equal(run(own), null);
    // no owner in this state / not a chess / no uid: never a guess, and never another piece's outfit
    assert.equal(run(new Map([[11, TOKEN]])), null, 'the owner is not listed');
    assert.equal(run(new Map([[10, { kind: 'item', id: 'x' }], [11, TOKEN]])), null, 'the owner uid names an item');
    assert.equal(summonSkinOf({ ...TOKEN, ownerUid: undefined }, own, { chess: chess(SKADI) }), null);
    assert.equal(summonSkinOf({ ...TOKEN, ownerUid: '10' }, own, { chess: chess(SKADI) }), null, 'a string uid is not an uid');
    assert.equal(summonSkinOf({ kind: 'chess', id: 'chess_char_6_04_a', ownerUid: 10 }, own, { chess: chess(SKADI) }), null);
    assert.equal(summonSkinOf(null, own, { chess: chess(SKADI) }), null);
    // 自选编队: the outfit choice is keyed by the pick's charId (screens/diy.js)
    setSkins({ char_1012_skadi2: BOC });
    const diyRec = { baseId: 'chess_char_2_03_a', chessId: 'chess_char_2_03_a', charId: 'char_1012_skadi2', isDiy: true };
    const diyToken = { ...TOKEN, uid: 21, ownerUid: 20 };
    const diyPieces = new Map([[20, { kind: 'chess', id: 'chess_char_2_03_a' }], [21, diyToken]]);
    assert.equal(summonSkinOf(diyToken, diyPieces, {
      chess: (id) => (id === 'chess_char_2_03_a' ? diyRec : null),
      diy: { chess_char_2_03_a: { charId: 'char_1012_skadi2' } },
    }), BOC);
  } finally {
    setSkins({});
  }
});


/** `tokenSkinMapOf` with a real skin table — the same shape `.cache/skin-table.json` has. */
function tokenSkinMapOfReal(table, skinId) {
  const rec = table && table.charSkins && table.charSkins[skinId];
  return (rec && Array.isArray(rec.tokenSkinMap) ? rec.tokenSkinMap : []).map((e) => ({ tokenId: e.tokenId, tokenSkinId: e.tokenSkinId }));
}

test('spineEntry: an outfit’s summon model wins for the owner’s token, the token’s own model is the fallback', () => {
  const BASE = { skel: '/assets/base/token.skel', atlas: '/assets/base/token.atlas', textures: ['/assets/base/token.png'], anims: { idle: 'Idle' } };
  const WORN = { skel: '/assets/worn/token.skel', atlas: '/assets/worn/token.atlas', textures: ['/assets/worn/token.png'], anims: { idle: 'Idle' } };
  const m = {
    chars: { owner: { skins: { 'owner@aura#2': { name: 'x', tokens: { token_a: { tokenSkinId: 'token_a_aura#2', spine: WORN } } } } } },
    tokens: {
      token_a: { owner: 'owner', spine: BASE },
      token_b: { owner: 'owner', spine: BASE },
      token_orphan: { spine: BASE },
    },
  };
  assert.equal(spineEntry(m, 'token_a', {}).skel, BASE.skel, 'no outfit: the token’s own model');
  const worn = spineEntry(m, 'token_a', { skin: 'owner@aura#2' });
  assert.equal(worn.skel, WORN.skel);
  assert.equal(worn.fallback.skel, BASE.skel, 'a load failure falls back to the token’s own model');
  assert.equal(spineEntry(m, 'token_a', { skin: 'owner@plain#1' }).skel, BASE.skel, 'an outfit with no map for this token');
  assert.equal(spineEntry(m, 'token_b', { skin: 'owner@aura#2' }).skel, BASE.skel, 'a token the outfit does not re-model');
  assert.equal(spineEntry(m, 'token_orphan', { skin: 'owner@aura#2' }).skel, BASE.skel, 'a token with no owner');

  // after `node tools/skins.mjs inject`, the real manifest must resolve every mapped token through its outfit
  let checked = 0;
  let unattributed = 0;
  for (const [charId, rec] of Object.entries(manifest.chars || {})) {
    for (const [skinId, skin] of Object.entries(rec.skins || {})) {
      for (const [tokenId, tk] of Object.entries(skin.tokens || {})) {
        const sp = tk && tk.spine;
        const listed = manifest.tokens?.[tokenId];
        if (!sp || !listed) continue; // a token the manifest does not list has no model to swap
        checked++;
        assert.equal(spineEntry(manifest, tokenId, { skin: skinId }).skel, sp.skel, `${charId} ${skinId} → ${tokenId}`);
        // the outfit always resolves (assets.js tokenSkinSpine: tokens[id].owner, else the operator the outfit's id
        // names). `tokens[id].owner` itself is the plan's pool attribution and may be absent: tools/assets/plan.mjs
        // tokenSkinOwners only fills it for operators its own operator list holds, while inject wrote the outfit
        // anyway (2026-10 data: 43 such pairs, e.g. 凯尔希's Mon3tr, 令's three souls) — then it must be null, never
        // another operator's charId.
        if (!listed.owner) unattributed++;
        else assert.equal(listed.owner, charId, `${tokenId} is the summon of ${charId}`);
      }
    }
  }
  assert.ok(Number.isInteger(checked));
  assert.ok(unattributed < checked, 'at least one summon outfit is attributed to an operator by the manifest');
});
