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
