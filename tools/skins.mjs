#!/usr/bin/env node
// 干员换装（皮肤）素材管线 —— 从上游把官方时装的头像与 Spine 模型抓到本项目，并写进素材清单。
// 数据来源：docs/research/08-skins.json（静态研究表：271 套皮肤，其中 174 套上游有模型，全部有头像）。
//
//   node tools/skins.mjs plan [--chars char_a,char_b] [--limit N]
//       只打印计划：每套皮肤要下几个文件、多大、URL 是什么。不写任何文件。
//   node tools/skins.mjs fetch [--chars …] [--limit N] [--concurrency=8] [--force] [--source=direct|mirror]
//       下载到 public/assets/char/skin_avatar/ 与 public/assets/spine/op/<charId>/<stem>/{front,back}/（已存在且非空的跳过）。
//   node tools/skins.mjs inject [--chars …]
//       把磁盘上真有文件的皮肤写进 data/assets.json 的 chars[charId].skins[skinId] = { name, group, avatar, spine? };
//       没有模型的皮肤只写头像与名字（客户端会回退到干员默认模型，见 docs/SKINS.md）。
//
// 上游（docs/research/08-skins.json 的 meta.generatedFrom 同源）：
//   fexli/ArknightsResource            spine/<charId>/<stem>/<Front|Back>/<stem>.{skel,atlas,png}
//   yuanyan3060/ArknightsGameResource  avatar/<avatarId>.png    （'#' 写成 %23）
//   命名规则：stem = skinId.replace(/@/g,'_').replace(/#/g,'_')
//
// 注意：tools/fetch-assets.mjs 重新生成清单时会丢掉它不认识的字段，所以 inject 要在 fetch-assets 之后跑；
// public/assets 不进 git（AGENTS.md），模型随完整包分发或各人自己下载。

import fs from 'node:fs';
import { readFile, writeFile, mkdir, stat, rename, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadUrls, RAW } from './assets/sources.mjs';
import { atlasInfo, normalizeAtlas } from './assets/atlas.mjs';
import { pngSize } from './assets/formats.mjs';
import { parseSkel, skelParserAvailable } from './assets/skel.mjs';
import { resolveRoles } from './assets/anim-roles.mjs';
import { guardDefaultFetch, proxyConfigured, restartForEnvProxy } from './assets/env-proxy.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/**
 * The static research table of upstream skins (271 套, 174 with models). Normally committed as
 * `docs/research/08-skins.json`; a checkout that has not added it can point at another copy — the sibling 「纸鸢」
 * build of this project carries the same table in its own tree — with --research=<file> or SP_SKINS_RESEARCH.
 */
const RESEARCH = join(ROOT, 'docs', 'research', '08-skins.json');
const RESEARCH_FALLBACKS = [
  process.env.SP_SKINS_RESEARCH,
  'G:/卫/纸鸢/Stronghold-Protocol/docs/research/08-skins.json',
].filter(Boolean);
const MANIFEST = join(ROOT, 'data', 'assets.json');
/**
 * Resolve every numbered skill clip of a skin skeleton (`anims.skills`), not just the indices the plan hands in.
 *
 * A skin is resolved on its own, without the operator's skill list: an outfit's `rec.skills` does not exist in
 * `data/assets.json` (the manifest carries no skill table), so `skillIndices` was always `[0]` and a model whose clips
 * are Skill_2 / Skill_3 got `anims.skill = { via: 'attack' }` and no `skills` map — 史尔特尔 wearing 自由//失效 opened
 * S3 with her normal attack swing instead of Skill_3_Begin/Loop/Idle, though the outfit's skeleton ships those clips
 * (test/skins.test.js "every skill clip of an outfit's model is mapped"). Numbered resolution takes what the skeleton
 * has, which is exactly the per-outfit model in hand.
 */
const SKIN_NUMBERED_SKILLS = true;
/** `charId/stem → layoutKey` (fetch remembers which upstream layout answered; a re-run costs no probing). */
const LAYOUT_CACHE = join(ROOT, '.cache', 'skins-layout.json');

const HEADERS = { 'user-agent': 'stronghold-protocol-skins/1.0' };
/** The model dump the skin Spine models come from (docs/research/08-skins.json `meta.generatedFrom`). */
const RAW_FEXLI = 'https://raw.githubusercontent.com/fexli/ArknightsResource/main/';

/**
 * The fetch used everywhere here — with the same `HTTP(S)_PROXY` rule as the asset pipeline
 * (tools/assets/env-proxy.mjs): a proxy configured for the process goes through it, a proxy that this Node cannot
 * route (older than 22.21 / 24.0, or a process started without NODE_USE_ENV_PROXY) is refused instead of silently
 * bypassed. `main()` restarts the script once with the switch, so `set HTTPS_PROXY=…` is enough.
 */
const httpFetch = guardDefaultFetch(globalThis.fetch);

const log = (m) => console.log(m);
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

/** stem of a skinId: `char_002_amiya@winter#1` → `char_002_amiya_winter_1` (docs/SKINS.md). */
export const stemOf = (skinId) => String(skinId).replace(/@/g, '_').replace(/#/g, '_');

/**
 * Every skin of the research table, as the jobs the pipeline needs.
 * @returns {{ charId: string, skinId: string, stem: string, name: string, group: string,
 *   avatar: string, spine: { front: string[], back: string[] } | null }[]}
 */
export function skinJobs(research) {
  const out = [];
  for (const [charId, list] of Object.entries(research.skins || {})) {
    for (const s of list || []) {
      const stem = s.stem || stemOf(s.skinId);
      const variants = spineVariants(charId, stem);
      const sides = { front: null, back: null };
      let hasModel = false;
      for (const [side, b] of [['front', s.battleSpine && s.battleSpine.front], ['back', s.battleSpine && s.battleSpine.back]]) {
        if (!b) continue;
        hasModel = true;
        sides[side] = { urls: ['skel', 'atlas', 'png'].map((k) => b[k] && b[k].url).filter(Boolean) };
      }
      // 上游只有单文件夹的一套模型：研究表把每一侧都指向它（两份 URL 去重后只剩一份）
      for (const side of ['front', 'back']) {
        if (!sides[side]) continue;
        const seen = new Set(sides[side].urls);
        const alt = variants.find((v) => !v.build && v.key === 'spine');
        for (const u of alt.urls) if (!seen.has(u)) { seen.add(u); sides[side].urls.push(u); }
      }
      out.push({
        charId, skinId: s.skinId, stem, name: s.name || s.skinId, group: s.group || '',
        avatar: (s.avatar && s.avatar.url) || avatarUrlOf(s.skinId),
        spine: hasModel ? { front: sides.front, back: sides.back, variants } : null,
      });
    }
  }
  return out;
}

/** `…/Front/<stem>.skel` → the local path `spine/op/<charId>/<stem>/front/<stem>.skel` (atlas / png likewise). */
export function localPathOf(charId, stem, url) {
  const name = decodeURIComponent(String(url).split('/').pop() || '');
  const side = /\/Back\//i.test(url) ? 'back' : 'front';
  return `spine/op/${charId}/${stem}/${side}/${name}`;
}

/**
 * The upstream model layouts of one skin, most likely first.
 *
 * fexli/ArknightsResource is NOT uniform: some operators keep `char_x/<stem>/{Front,Back}/` (a battle pair), others
 * only `char_x/<stem>/Spine/` (one model), and every operator also has a `build_char_x/<stem>/Spine/` (the 基建 model).
 * The research table assumes the Front/Back pair, which 404s for the Spine-only ones (measured: 13 of 32 sampled
 * directories of 5 operators are Spine-only). `fetch` probes these variants once per skin and remembers the winner
 * (`.cache/skins-layout.json`), so a wrong assumption costs one 404 per side, not a failed install.
 * @param {string} charId @param {string} stem
 * @returns {{ key: string, urls: string[], build: boolean }[]}
 */
export function spineVariants(charId, stem) {
  const mk = (dir, folder) => {
    const base = `${RAW_FEXLI}${dir}/${stem}/${folder}/${stem}`;
    return [`${base}.skel`, `${base}.atlas`, `${base}.png`];
  };
  const out = [];
  for (const [key, dir, folder] of [
    ['front-back', `spine/${charId}`, 'Front'],
    ['spine', `spine/${charId}`, 'Spine'],
    ['build', `spine/build_${charId}`, 'Spine'],
  ]) {
    out.push({ key, urls: mk(decodeURIComponent(dir), folder), build: dir.includes('/build_') });
  }
  return out.map((v) => ({ ...v, urls: v.urls.map((u) => encodeURI(u)) }));
}

/** The upstream avatar URL of a skinId (`avatar/<stem>.png`; a `#` in a name is percent-encoded). */
export const avatarUrlOf = (skinId) => `https://raw.githubusercontent.com/yuanyan3060/ArknightsGameResource/main/avatar/${encodeURIComponent(stemOf(skinId))}.png`;

/**
 * Is a URL really there? A plain GET of the first bytes — no GitHub API (its anonymous quota is 60/h and the
 * jsdelivr listing API refuses this repo: "Package size exceeded the configured limit of 50 MB").
 * `fetch` uses it once per skin variant; `probe` / `layout` use it too.
 */
export async function urlExists(url, o = {}) {
  for (const u of candidates(url, o)) {
    try {
      const res = await httpFetch(u, { method: 'GET', headers: { ...HEADERS, range: 'bytes=0-2047' }, signal: AbortSignal.timeout(30000) });
      if (res.ok) { await res.arrayBuffer().catch(() => {}); return true; }
      if (res.status === 404 || res.status === 410) continue; // this host does not have it; try the next
    } catch { /* network: try the next host */ }
  }
  return false;
}

/** The avatar's local path: `char/skin_avatar/<stem>.png` (the stem keeps `#` away from the file name). */
export const avatarPathOf = (stem) => `char/skin_avatar/${stem}.png`;
/** The half-body portrait's local path: `char/skin_portrait/<stem>.png` (the shop / detail card art). */
export const portraitPathOf = (stem) => `char/skin_portrait/${stem}.png`;

/**
 * Every file job of one skin: [{ rel, urls, kind, layout }] (`rel` is relative to public/assets).
 * `layout` is the resolved upstream variant (see spineVariants) — for the Spine-only one both local sides resolve to
 * that single model, and the client's `hasBackSpine` simply reports no Back model (it falls back to Front).
 */
export function fileJobs(job, sides = null, layoutKey = null) {
  const out = [{ rel: avatarPathOf(job.stem), urls: [job.avatar], kind: 'avatar', layout: null }];
  if (job.spine) {
    const layout = layoutKey || (job.spine.variants && job.spine.variants[0] && job.spine.variants[0].key) || 'front-back';
    for (const [side, set] of [['front', job.spine.front], ['back', job.spine.back]]) {
      if (!set || (sides && !sides.includes(side))) continue;
      let urls = set.urls;
      if (layout !== 'front-back') {
        const v = (job.spine.variants || []).find((x) => x.key === layout);
        if (v) urls = v.urls;
      }
      for (const u of urls) out.push({ rel: localPathOf(job.charId, job.stem, u), urls: [u], kind: side, layout });
    }
  }
  return out;
}

/**
 * A URL and its alternatives (jsDelivr / the opt-in GitHub prefix proxy), same rule as the asset pipeline
 * (tools/assets/sources.mjs downloadUrls): direct mode keeps the jsDelivr order, mirror mode tries the proxy first.
 */
function alternatives(url, source, proxy) {
  const list = downloadUrls(url, { source, proxyPrefix: proxy });
  return list.length ? list : [url];
}

/** HEAD commit of the model repo, resolved once per run (a jsDelivr URL pinned to it resolves even when the branch
 * form does not: `cdn.jsdelivr.net/gh/OWNER/REPO@<sha>/…`). Empty = the API was unreachable, branch URLs only. */
let fexliSha = '';

export async function resolveFexliCommit() {
  if (fexliSha !== '') return fexliSha;
  try {
    const res = await httpFetch('https://api.github.com/repos/fexli/ArknightsResource/commits/main', {
      headers: { 'user-agent': HEADERS['user-agent'], accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(45000),
    });
    if (res.ok) {
      const j = await res.json();
      if (j && typeof j.sha === 'string' && /^[0-9a-f]{40}$/.test(j.sha)) fexliSha = j.sha;
    } else await res.body?.cancel();
  } catch { /* offline or rate-limited: branch URLs are still tried */ }
  if (fexliSha === '') fexliSha = 'none';
  return fexliSha;
}

/**
 * Where to really fetch a file from, best first.
 *
 * `raw.githubusercontent.com` is the canonical host but is unreachable from a mainland line (measured: connect
 * timeouts), while jsDelivr answers happily — including this 18 GB repo, as long as the path is right (a wrong path
 * is a 404, not a silent success). So the order is: the commit-pinned jsDelivr URL, then jsDelivr with the branch,
 * then the jsDelivr mirror the asset pipeline computes, then the GitHub original (and, in mirror mode, the opt-in
 * prefix proxy). A skin out of a GitHub raw URL only — the avatars — goes through the same list.
 */
function candidates(url, o) {
  const list = [];
  const m = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(url);
  if (m) {
    const [, owner, repo, branch, rest] = m;
    const repoName = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
    const sha = repoName === 'fexli/arknightsresource' ? fexliSha : '';
    if (sha && sha !== 'none') list.push(`https://cdn.jsdelivr.net/gh/${owner}/${repo}@${sha}/${rest}`);
    list.push(`https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${rest}`);
  }
  for (const u of alternatives(url, o.source, o.proxy)) if (!list.includes(u)) list.push(u);
  return list;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

/** The research table in use: the given path, else the committed one, else a known sibling copy. */
function researchPath(explicit) {
  for (const p of [explicit, RESEARCH, ...RESEARCH_FALLBACKS]) if (p && existsSync(p)) return p;
  return RESEARCH;
}

function parseArgs(argv) {
  const first = argv[0];
  const flagsFirst = !!first && first.startsWith('-');
  const o = { cmd: flagsFirst ? null : first, chars: null, limit: 0, concurrency: 8, force: false, source: process.env.SP_ASSET_SOURCE || 'direct', proxy: process.env.SP_GITHUB_PROXY, research: null, help: false, overwrite: '', unknown: [] };
  for (let i = flagsFirst ? 0 : 1; i < argv.length; i++) {
    const [k, v] = argv[i].split('=');
    if (k === '--chars') o.chars = String(v || argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === '--limit') o.limit = Math.max(0, parseInt(v || argv[++i] || '0', 10) || 0);
    else if (k === '--concurrency') o.concurrency = Math.max(1, Math.min(32, parseInt(v || argv[++i] || '8', 10) || 8));
    else if (k === '--force') o.force = true;
    else if (k === '--dry-run') o.dryRun = true;
    else if (k === '--no-spine') o.spine = false;
    else if (k === '--source') o.source = v || argv[++i];
    else if (k === '--proxy') o.proxy = v || argv[++i];
    else if (k === '--research') o.research = v || argv[++i];
    else if (k === '--manifest') o.manifest = v || argv[++i];
    else if (k === '--from') o.from = v || argv[++i];
    else if (k === '--overwrite') o.overwrite = v || argv[++i] || 'big';
    else if (k === '--net-only') o.netOnly = true;
    else if (k === '--timeout') o.timeoutMs = Math.max(5000, parseInt(v || argv[++i] || '25000', 10) || 25000);
    else if (k === '--only') o.only = v || argv[++i] || '';
    else if (k === '--no-names') o.names = false;
    else if (k === '--refresh-names') o.refresh = true;
    else if (k === '--all') o.chars = null;
    else if (k === '--probe') o.probe = true;
    else if (k === '--fix') o.fix = true;
    else if (k === '--side') o.side = String(v || argv[++i] || '').split(',').map((s) => s.trim()).filter((s) => s === 'front' || s === 'back');
    else if (k === '--help' || k === '-h') o.help = true;
    // 不认识的参数绝不能一声不响地丢掉：写错一个 flag 会变成「什么都没做，还报成功」
    else o.unknown.push(argv[i]);
  }
  return o;
}

function pickJobs(jobs, o) {
  let list = jobs;
  if (o.chars) list = list.filter((j) => o.chars.includes(j.charId));
  if (o.limit) list = list.slice(0, o.limit);
  return list;
}

/** Where the downloaded files land, relative to public/assets (same walk as fetch-assets test helpers). */
async function onDisk(rel) {
  try { const st = await stat(join(ROOT, 'public', 'assets', rel)); return st.isFile() && st.size > 100; } catch { return false; }
}

/** The first of `names` that exists in `dir`, or null. */
async function firstExisting(dir, names) {
  for (const n of names) {
    try { if ((await stat(join(dir, n))).isFile()) return n; } catch { /* next */ }
  }
  return null;
}

/**
 * Drop the blank line(s) a raw dump atlas starts with.
 *
 * This is THE reason a skin's skeleton failed to load in the browser with
 * "Something went terribly wrong loading a spine .atlas file / Most likely your texture failed to load": pixi-spine
 * reads an atlas line by line, takes the FIRST line as the texture page's file name, and the dump's atlases begin with
 * an empty line (measured: 1956/1956 files in the dump, and every one of the 1039 skin atlases copied from it). So the
 * page name became "" and the loader asked for the directory itself — the texture came back null and the whole skeleton
 * was dropped, silently falling back to the operator's default model. The default operators' atlases were normalised
 * by the asset pipeline long ago, which is why only skins were affected.
 * @param {string} text @returns {string}
 */
export function stripLeadingBlankLines(text) {
  let out = String(text).replace(/^\uFEFF/, '');
  out = out.replace(/^(?:[ \t\r]*\n)+/, '');
  return out;
}

/**
 * Rewrite an atlas so its texture-page names match the files actually on disk, and give every page a `size:` when it
 * has none (the matching page file's dimensions).
 *
 * Why: the dump names files after the skin id (`char_145_prove_summer#3.png`), while the site path uses the underscore
 * stem — the png is copied under the stem name but the atlas still names the old one, and pixi-spine then dies with
 * "error in texture loader … reading 'baseTexture'". The asset pipeline normalises atlases for exactly this reason
 * (tools/assets/spine.mjs → normalizeAtlas); skins that `local` copies never went through it.
 * @param {string} dir folder holding the atlas and its pages
 * @param {(page: string) => string} rename page name → the file name to use
 * @returns {Promise<{ names: string[], text: string|null, changed: boolean }>} page file names + the normalized text
 */
async function normalizePageNames(dir, rename) {
  const files = await readdir(dir).catch(() => []);
  const atlasName = files.find((n) => /\.atlas$/i.test(n));
  if (!atlasName) return { names: [], text: null, changed: false };
  const abs = join(dir, atlasName);
  const raw = await readFile(abs, 'utf8');
  const text = stripLeadingBlankLines(raw);
  const info = atlasInfo(text);
  const names = info.pages.map(rename);
  const present = (n) => files.includes(n);
  // pngSize() 吃的是字节，先把页文件的尺寸读出来（图集缺 size: 时补上）
  const sizes = new Map();
  for (const n of files) {
    if (!/\.(png|jpg|webp)$/i.test(n)) continue;
    try { sizes.set(n, pngSize(await readFile(join(dir, n)))); } catch { /* 不是图片就跳过 */ }
  }
  const { text: normalized, changed: fieldsChanged } = normalizeAtlas(text, {
    pageSize: (page) => {
      const n = rename(page);
      return present(n) ? sizes.get(n) || null : null;
    },
    renamePage: (page) => {
      const n = rename(page);
      return present(n) ? n : page; // 页文件不在（可能没下载）→ 保留原名，别改坏图集
    },
  });
  // 开头空行也必须落盘（changed 只反映页名/size 的变化）
  const changed = fieldsChanged || normalized !== raw;
  if (changed) {
    try { await writeFile(abs, normalized); } catch { /* 只读时用内存里的文本继续解析 */ }
  } else if (atlasInfo(text).pages.some((p) => p !== rename(p))) {
    log(`  ! ${relative(ROOT, abs)}：图集里的页名与磁盘文件名仍不一致（写盘被拒？），浏览器会取不到贴图`);
  }
  return { names, text: normalized, changed };
}

/**
 * The manifest `Spine` object of one skin side, resolved from the files on disk — the same work
 * tools/assets/spine.mjs does for the whole plan: read the atlas (pages + regions), parse the skeleton and turn its
 * animation list into the role map the renderer needs (`anims`; client `validSpine()` requires it — a model without
 * one would leave the unit on its placeholder avatar forever, docs/SKINS.md).
 * @returns {Promise<{ entry: object|null, why: string }>}
 */
export async function resolveSkinSpine(charId, stem, side, urls, opts = {}) {
  const base = join(ROOT, 'public', 'assets', `spine/op/${charId}/${stem}/${side}`);
  const nameOf = (u) => decodeURIComponent(String(u).split('/').pop() || '');
  const pngs = urls.map(nameOf).filter((n) => /\.(png|jpg|webp)$/i.test(n));
  const skelName = urls.map(nameOf).find((n) => /\.skel$/i.test(n));
  const atlasName = urls.map(nameOf).find((n) => /\.atlas$/i.test(n));
  if (!skelName || !atlasName || !pngs.length) return { entry: null, why: '研究表里缺 skel/atlas/贴图' };
  const skelFile = join(base, skelName);
  const atlasFile = join(base, atlasName);
  if (!existsSync(skelFile) || !existsSync(atlasFile) || !pngs.length) return { entry: null, why: '文件不全' };
  if (!pngs.every((n) => existsSync(join(base, n)))) return { entry: null, why: '图集页缺失' };
  let info;
  try { info = atlasInfo(await readFile(atlasFile, 'utf8')); } catch (e) { return { entry: null, why: `atlas 解析失败: ${e.message}` }; }
  let sk;
  try { sk = parseSkel(await readFile(skelFile), info.regions); } catch (e) { return { entry: null, why: `skel 解析失败: ${e.message}` }; }
  if (!sk.animations || !sk.animations.length) return { entry: null, why: '骨骼没有动画' };
  // `resolveRoles` 直接返回 roles 对象（tools/assets/anim-roles.mjs:298-311），生产管线也是 `const anims = resolveRoles(...)`
  const anims = resolveRoles(sk.animations, { skillIndices: opts.skillIndices, numberedSkills: SKIN_NUMBERED_SKILLS, durations: sk.durations });
  // 没有 anims 的条目客户端会拒绝（validSpine）并一直停在占位头像上：宁可不写 spine 块，让渲染回退到干员默认模型
  if (!anims || typeof anims !== 'object' || !anims.idle) return { entry: null, why: 'anims 解析不出（骨骼的动画名不认识）' };
  return {
    entry: {
      skel: `/assets/spine/op/${charId}/${stem}/${side}/${skelName}`,
      atlas: `/assets/spine/op/${charId}/${stem}/${side}/${atlasName}`,
      textures: pngs.map((n) => `/assets/spine/op/${charId}/${stem}/${side}/${n}`),
      pma: !!info.hasPma,
      anims,
      animations: sk.durations,
      events: sk.events,
      hits: sk.hits,
      bounds: sk.bounds,
    },
    why: '',
  };
}

async function downloadOne(task, o) {
  const abs = join(ROOT, 'public', 'assets', task.rel);
  if (!o.force) {
    try {
      const st = await stat(abs);
      if (st.isFile() && st.size > 100) return { rel: task.rel, status: 'skip', bytes: st.size };
    } catch { /* missing */ }
  }
  const errors = [];
  for (const src of task.urls) {
    for (const url of candidates(src, o)) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (attempt === 2) await new Promise((r) => setTimeout(r, 800));
        try {
          const res = await httpFetch(url, { headers: HEADERS, signal: AbortSignal.timeout(120000) });
          if (res.status === 404 || res.status === 410) { errors.push(`HTTP ${res.status}（上游没有这个文件）`); break; }
          if (!res.ok) { errors.push(`HTTP ${res.status}`); continue; }
          const buf = Buffer.from(await res.arrayBuffer());
          if (!buf.length) { errors.push('空响应'); continue; }
          try {
            await mkdir(dirname(abs), { recursive: true });
            await writeFile(`${abs}.part`, buf);
            await rename(`${abs}.part`, abs);
          } catch (e) {
            // 写不进去是环境问题（目录权限 / 沙箱），换 URL 也没用：立刻停手并报清楚
            return {
              rel: task.rel, status: 'error', bytes: 0, code: 'WRITE',
              error: `${e?.code || e?.message || 'WRITE'}: mkdir/写入 ${dirname(abs)} 被拒（目录权限或沙箱限制）`,
            };
          }
          return { rel: task.rel, status: 'ok', bytes: buf.length };
        } catch (e) {
          errors.push(e?.name === 'TimeoutError' ? '请求超时' : (e?.code || e?.message || String(e)));
        }
      }
    }
  }
  const code = /^HTTP 4/.test(errors[0] || '') ? '404' : /^HTTP/.test(errors[0] || '') ? 'HTTP' : 'NET';
  return { rel: task.rel, status: 'error', bytes: 0, code, error: errors.slice(0, 3).join(' / ') };
}

async function commandPlan(o) {
  const research = await readJson(o.research || RESEARCH);
  const jobs = pickJobs(skinJobs(research), o);
  const layouts = { ...(await readJson(LAYOUT_CACHE).catch(() => ({}))) };
  // 没探测过的皮肤：plan 默认按研究表（Front/Back）猜；--probe 就现场探一遍（不写缓存）
  const unknown = jobs.filter((j) => j.spine && !layouts[`${j.charId}/${j.stem}`]);
  if (unknown.length && o.probe) {
    await resolveFexliCommit();
    let done = 0; let next = 0;
    const worker = async () => {
      while (next < unknown.length) {
        const j = unknown[next++];
        const hit = await probeLayout(j, o);
        layouts[`${j.charId}/${j.stem}`] = hit ? hit.key : 'front-back';
        done++;
        if (done % 20 === 0 || done === unknown.length) log(`[skins] 探测 ${done}/${unknown.length}`);
      }
    };
    log(`[skins] --probe：探测 ${unknown.length} 套的上游布局…`);
    await Promise.all(Array.from({ length: Math.min(o.concurrency, unknown.length) }, worker));
  }
  const layoutOf = (j) => layouts[`${j.charId}/${j.stem}`] || 'front-back';
  let files = 0; let withModels = 0; let present = 0; let missing = 0;
  for (const j of jobs) {
    const set = fileJobs(j, o.side, layoutOf(j));
    files += set.length;
    if (j.spine) withModels++;
    for (const t of set) (await onDisk(t.rel) ? present++ : missing++);
  }
  // the URL list is the point of `plan`: print it for a limited selection only, the whole table otherwise
  if (o.chars || o.limit) {
    for (const j of jobs) {
      const key = layoutOf(j);
      log(`${j.charId}  ${j.skinId}  ${j.name}${j.group ? `  [${j.group}]` : ''}${j.spine ? `  [上游布局: ${key}${unknown.some((u) => u.stem === j.stem && u.charId === j.charId) && !o.probe ? '?（未探测，先跑 layout）' : ''}]` : '  （上游没有模型，仅头像）'}`);
      for (const t of fileJobs(j, o.side, key)) {
        const have = await onDisk(t.rel);
        log(`   ${have ? '✔' : '·'} public/assets/${t.rel}`);
        log(`     ${t.urls[0]}`);
      }
    }
  }
  log(`[skins] ${jobs.length} 套皮肤：头像 ${jobs.length} 个、含模型 ${withModels} 套（其余上游没有模型），合计 ${files} 个文件`);
  log(`[skins] 磁盘现状：已在 ${present} 个、缺 ${missing} 个（磁盘上的总大小见 fetch 的进度行）`);
  log(`[skins] 来源：${relative(ROOT, RESEARCH)}（${Object.keys(research.skins || {}).length} 名干员）`);
  if (unknown.length && !o.probe) log(`[skins] 其中 ${unknown.length} 套还没探测上游布局：node tools/skins.mjs layout（或 plan --probe）`);
  log('[skins] 想看具体 URL：--chars=char_1014_nearl2 只看某名干员，或 --limit=3 看前几套');
  log('[skins] 还没探测过上游布局的话，先跑 node tools/skins.mjs layout（fetch 也会自动探测）');
  return 0;
}

/**
 * The upstream model layout of one skin: probe its variants in order (Front/Back → Spine → build_ Spine) and return
 * the first whose skeleton is really there. Result: `{ key, build }` or null when none answers.
 */
export async function probeLayout(job, o = {}) {
  for (const v of job.spine ? job.spine.variants : []) {
    if (await urlExists(v.urls[0], o)) return { key: v.key, build: v.build };
  }
  return null;
}

/**
 * Resolve (and remember) the layout of every job: `.cache/skins-layout.json` caches `charId/stem → layoutKey`, so a
 * re-run never re-probes and a partial download keeps its decision. Returns a Map `charId/stem → layoutKey`.
 */
async function ensureLayout(jobs, o) {
  const cache = await readJson(LAYOUT_CACHE).catch(() => ({}));
  const out = new Map();
  const todo = [];
  for (const j of jobs) {
    const key = `${j.charId}/${j.stem}`;
    if (cache[key] && ['front-back', 'spine', 'build'].includes(cache[key])) out.set(key, cache[key]);
    else if (j.spine) todo.push(j);
  }
  if (todo.length) {
    log(`[skins] 探测上游模型布局：${todo.length} 套（研究表假定 Front/Back，部分干员只有单文件夹 Spine）…`);
    let done = 0;
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const j = todo[next++];
        const hit = await probeLayout(j, o);
        out.set(`${j.charId}/${j.stem}`, hit ? hit.key : 'front-back');
        if (!hit) log(`  ! ${j.charId}/${j.stem}: 三种布局都没找到模型（上游可能真没有）`);
        done++;
        if (done % 20 === 0 || done === todo.length) log(`[skins] 探测 ${done}/${todo.length}`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(o.concurrency || 8, todo.length) }, worker));
    const nextCache = { ...cache };
    for (const [k, v] of out) nextCache[k] = v;
    try {
      await mkdir(dirname(LAYOUT_CACHE), { recursive: true });
      await writeFile(LAYOUT_CACHE, JSON.stringify(nextCache, null, 1) + '\n');
    } catch (e) {
      log(`  （布局缓存写不进 ${relative(ROOT, LAYOUT_CACHE)}：${e?.code || e?.message}；本次仍按探测结果跑）`);
    }
  }
  return out;
}

/**
 * `local`: install the skins out of a complete local dump instead of downloading them.
 *
 * The repo this project was built for (`G:\尖塔mod\HellaAssets` and its siblings) lays the models out as
 * `spine/operator/battle/<skinId>/{front,back}/{<skinId>.skel,.atlas,.png,[alpha].png}` and the thumbnails as
 * `operator/avatars/<skinId>.png` — the directory IS the skin id (`#` and all, while the site path uses the
 * underscore stem). So nothing has to be guessed: the id from data/skins.json names the folder, and the three files
 * per side are copied to the site's own layout (`spine/op/<charId>/<stem>/<front|back>/`).
 * The operator's own default model (`char_x`, no `#`) and the 基建 `build` tree are not touched — the default model
 * is already installed by the asset pipeline.
 */
async function commandLocal(o) {
  const repo = o.from || process.env.SP_SKINS_REPO || 'G:/尖塔mod/HellaAssets';
  const root = join(repo, 'spine', 'operator', 'battle');
  const avatars = join(repo, 'operator', 'avatars');
  if (!existsSync(root)) {
    log(`[skins] 找不到本地资源库：${root}`);
    log('        用 --from=<路径> 指定（形如 <库根>/spine/operator/battle 与 <库根>/operator/avatars）');
    return 1;
  }
  const { jobs: allJobs, from } = await sourceJobs(o);
  if (from !== relative(ROOT, o.research || RESEARCH)) log(`[skins] 按当前目录 ${from} 工作（共 ${allJobs.length} 套）`);
  const jobs = pickJobs(allJobs, o).filter((j) => j.skinId.includes('@') || j.skinId.includes('#'));
  // 库里的目录名保留 `#`/`@` 原样（`char_1012_skadi2_boc#4`），站点路径用下划线 stem：两边都算一次，做成映射
  const dirOf = new Map();
  for (const name of await readdir(root)) dirOf.set(stemOf(name), name);
  let copied = 0; let bytes = 0; let avatarsDone = 0; let noAvatar = 0; let portraitsDone = 0; let noPortrait = 0;
  const missing = [];
  for (const j of jobs) {
    const dirName = dirOf.get(j.stem);
    if (!dirName) { missing.push(`${j.skinId}（库里没有对应目录）`); continue; }
    const src = join(root, dirName);
    for (const side of ['front', 'back']) {
      const from = join(src, side);
      if (!existsSync(from)) continue;
      let names = [];
      try { names = await readdir(from); } catch { continue; }
      // [alpha].png 是官方 alpha 通道图，渲染器不用
      const wanted = names.filter((n) => /\.(skel|atlas|png)$/i.test(n) && !/\[alpha\]/i.test(n));
      if (!wanted.length) { missing.push(`${j.skinId}/${side}：三件套都没有`); continue; }
      const to = join(ROOT, 'public', 'assets', 'spine', 'op', j.charId, j.stem, side);
      try {
        await mkdir(to, { recursive: true });
        for (const n of wanted) {
          const buf = await readFile(join(from, n));
          // 目标文件名统一成 stem（站点路径全用下划线 stem）
          await writeFile(join(to, `${j.stem}${n.slice(dirName.length)}`), buf);
          copied++; bytes += buf.length;
        }
      } catch (e) {
        log(`  ! ${j.skinId}/${side}: 写盘失败 ${e?.code || e?.message}`);
        return 1;
      }
    }
    const avatarName = await firstExisting(avatars, [`${dirName}.png`, `${dirName}_1.png`, `${dirName}_2.png`, `${stemOf(dirName)}.png`]);
    if (avatarName) {
      const to = join(ROOT, 'public', 'assets', 'char', 'skin_avatar', `${j.stem}.png`);
      const buf = await readFile(join(avatars, avatarName));
      await mkdir(dirname(to), { recursive: true });
      await writeFile(to, buf);
      avatarsDone++; bytes += buf.length;
    } else noAvatar++;
    // 半身立绘（商店/购买卡）——同一个库的 operator/arts/
    const artState = await copySkinPortrait(join(repo, 'operator', 'arts'), j, { force: o.force, dirName });
    if (artState === 'ok') { portraitsDone++; bytes += sizeOfSync(join(ROOT, 'public', 'assets', portraitPathOf(j.stem))); }
    else if (artState === 'none') noPortrait++;
  }
  log(`[skins] 本地导入：${jobs.length} 套皮肤 → 复制 ${copied} 个模型文件 + ${avatarsDone} 个头像 + ${portraitsDone} 张立绘（${mb(bytes)}${noAvatar ? `，${noAvatar} 套库里没有头像` : ''}${noPortrait ? `，${noPortrait} 套库里没有立绘` : ''}）`);
  if (missing.length) {
    log(`[skins] 库里没有的 ${missing.length} 套（这些仍需 fetch 下载）：`);
    for (const x of missing.slice(0, 12)) log(`  · ${x}`);
    if (missing.length > 12) log(`  · …另有 ${missing.length - 12} 套`);
  }
  log(`[skins] 库：${repo}`);
  log('[skins] 下一步：node tools/skins.mjs inject   （写进 data/assets.json）');
  return 0;
}

/**
 * What a local dump offers, keyed by stem: `{ stem → { dirName, charId, sides[], avatar } }`.
 * The directory name IS the skin id with `@`/`#` intact (`char_1012_skadi2_boc#4`), so the stem key is normalised.
 * A directory whose stem equals its charId is the operator's own default model (`battle/char_x/`), which the asset
 * pipeline already installs — it is not a skin and is skipped. The 基建 tree (`operator/build`, `battle/build_*`)
 * is not scanned at all.
 */
export async function scanLocalRepo(repoRoot, { withAvatars = true } = {}) {
  const root = join(repoRoot, 'spine', 'operator', 'battle');
  const out = new Map();
  if (!existsSync(root)) return out;
  const avatars = new Set();
  if (withAvatars && existsSync(join(repoRoot, 'operator', 'avatars'))) {
    for (const f of await readdir(join(repoRoot, 'operator', 'avatars'))) {
      if (/\.png$/i.test(f)) avatars.add(stemOf(f.replace(/\.png$/i, '')));
    }
  }
  for (const dirName of await readdir(root)) {
    const stem = stemOf(dirName);
    const charId = /^char_[0-9]+_[a-z0-9_]+$/i.exec(stem.split('_').slice(0, 3).join('_'))?.[0] || null;
    if (!charId || stem === charId) continue; // 默认模型
    const sides = [];
    for (const side of ['front', 'back']) if (existsSync(join(root, dirName, side))) sides.push(side);
    if (!sides.length) continue;
    out.set(stem, { stem, dirName, charId, sides, avatar: avatars.has(stem) });
  }
  return out;
}

/** The official skin names/series, cached in `.cache/` (Kengxxiao's skin_table.json; ~1.4 MB). */
const SKIN_TABLE_CACHE = join(ROOT, '.cache', 'skin-table.json');
const SKIN_TABLE_URL = 'https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData/master/zh_CN/gamedata/excel/skin_table.json';

export async function loadSkinTable({ refresh = false, log: say = log } = {}) {
  const cached = await readJson(SKIN_TABLE_CACHE).catch(() => null);
  if (cached && !refresh) return cached;
  say('[skins] 拉取官方皮肤表（Kengxxiao skin_table.json，约 1.4 MB）…');
  for (const url of [SKIN_TABLE_URL, alternatives(SKIN_TABLE_URL, 'direct')[0]]) {
    try {
      const res = await httpFetch(url, { headers: HEADERS, signal: AbortSignal.timeout(120000) });
      if (!res.ok) continue;
      const table = JSON.parse(await res.text());
      if (table && table.charSkins) {
        try {
          await mkdir(dirname(SKIN_TABLE_CACHE), { recursive: true });
          await writeFile(SKIN_TABLE_CACHE, JSON.stringify(table));
        } catch { /* 缓存写不进去就用这一次 */ }
        return table;
      }
    } catch (e) {
      say(`[skins] 皮肤表下载失败（${e?.name || e?.message}），名字将退回用 id`);
    }
  }
  return cached || null;
}

/**
 * The official name / series / id of a repo skin stem.
 *
 * The dump's directory is the `displaySkin.skinGroupId` (`char_1012_skadi2_boc#4`), while `charSkins` is keyed by
 * `char_x@grp#n`; so the lookup restores the `@`/`#` forms before giving up.
 * @param {any} table skin_table.json @param {string} stem
 * @returns {{ name: string|null, group: string|null, id: string|null }}
 */
export function officialNameOf(table, stem) {
  const skins = table && table.charSkins;
  if (!skins) return { name: null, group: null, id: null };
  const at = /^(char_[0-9a-z]+_[a-z0-9_]+?)_([a-z0-9]+)_(\d+)$/i.exec(stem);
  const tries = [
    at ? `${at[1]}@${at[2]}#${at[3]}` : null,
    stem,
    stem.replace(/_(\d+)$/, '#$1'),
    stem.replace(/_(\d+)$/, '@#$1'),
    stem.replace(/_(\d+)$/, '@$1'),
  ].filter(Boolean);
  for (const key of tries) {
    const rec = skins[key];
    if (!rec) continue;
    const ds = rec.displaySkin || {};
    const name = ds.skinName || ds.chineseName || rec.skinName || null;
    if (!name) continue;
    return { name, group: ds.skinGroupName || ds.seriesId || null, id: rec.skinId || key };
  }
  return { name: null, group: null, id: null };
}

/**
 * The full catalogue: what the local dump (and whatever was fetched before) really offers, with the names the
 * existing data/skins.json already knows and the official table's names for everything else.
 * @returns {Promise<{ doc: object, stats: object, missing: string[] }>}
 */
export async function mergedCatalog({ repoRoot, names = true, refresh = false, log: say = log } = {}) {
  const found = await scanLocalRepo(repoRoot);
  const previous = await readJson(join(ROOT, 'data', 'skins.json')).catch(() => null);
  const known = new Map();
  for (const [charId, list] of Object.entries((previous && previous.chars) || {})) {
    for (const s of list || []) known.set(stemOf(s.id), { name: s.name, group: s.group });
  }
  const table = names ? await loadSkinTable({ refresh, log: say }) : null;
  const chars = {};
  let named = 0; let unnamed = 0;
  for (const [stem, info] of [...found].sort((a, b) => a[0].localeCompare(b[0]))) {
    const prev = known.get(stem);
    let name = prev && prev.name && prev.name !== stem ? prev.name : null;
    let group = prev && prev.group;
    let id = stem;
    if (table) {
      const off = officialNameOf(table, stem);
      if (!name && off.name) { name = off.name; named++; }
      group = group || off.group || undefined;
      // 目录名不是官方键：优先用官方 skinId（`char_x@grp#n`），与 room.skins / 导出格式一致
      if (off.id) id = off.id;
    }
    if (!name) { name = stem; unnamed++; }
    (chars[info.charId] = chars[info.charId] || []).push(group ? { id, name, group } : { id, name });
  }
  const total = [...found.values()].length;
  const doc = {
    version: 1,
    counts: { chars: Object.keys(chars).length, skins: total },
    chars,
  };
  return {
    doc,
    stats: { chars: Object.keys(chars).length, skins: total, named, unnamed, avatars: [...found.values()].filter((v) => v.avatar).length, previous: known.size },
    missing: [],
  };
}

/**
 * The operators this build actually plays with: every `charId` of data/chess.json plus the backup/stand-in units, with
 * their alt-form spellings (`char_1001_amiya2`) resolved to the base id the chess table uses.
 *
 * The dump holds far more than that — measured: 372 characters in the dump against 210 in the manifest, the extra 162
 * being alt-form/未实装 operators whose skins can never appear in a match. Those 250 skins are what `inject` skips for
 * "not in the manifest", and scoping `sync` with `--only=chess` keeps the catalogue clean instead.
 * @returns {Set<string>}
 */
export function playableChars() {
  const out = new Set();
  const add = (id) => {
    if (typeof id !== 'string' || !id.startsWith('char_')) return;
    out.add(id);
    const base = id.replace(/_\d+$/, '');
    if (base !== id) out.add(base);
  };
  try {
    const chess = JSON.parse(fs.readFileSync(join(ROOT, 'data', 'chess.json'), 'utf8'));
    for (const rec of Object.values(chess)) {
      if (!rec || typeof rec !== 'object') continue;
      add(rec.charId);
      add(rec.assets && rec.assets.spine);
      add(rec.assets && rec.assets.avatar);
    }
  } catch { /* data/chess.json is generated; without it --only=chess just keeps everything */ }
  try {
    const backups = JSON.parse(fs.readFileSync(join(ROOT, 'data', 'backups.json'), 'utf8'));
    for (const id of Object.keys(backups.units || {})) add(id);
  } catch { /* optional */ }
  return out;
}

/** `sync`: rebuild the catalogue from the local dump (+ the official names), so new operators appear too. */
async function commandSync(o) {
  const repo = o.from || process.env.SP_SKINS_REPO || 'G:/尖塔mod/HellaAssets';
  if (!existsSync(join(repo, 'spine', 'operator', 'battle'))) {
    log(`[skins] 找不到本地资源库：${join(repo, 'spine', 'operator', 'battle')}（--from=<库根>）`);
    return 1;
  }
  const { doc, stats } = await mergedCatalog({ repoRoot: repo, names: o.names !== false, refresh: o.refresh, log });
  log(`[skins] 扫描 ${repo}`);
  let dropped = 0;
  if (o.only === 'chess') {
    // 只留本作真正会出场的干员（异格/未实装的那些皮肤在游戏里永远不会被选中）
    const keep = playableChars();
    for (const [charId, list] of Object.entries(doc.chars)) {
      if (keep.has(charId)) continue;
      dropped += (list || []).length;
      delete doc.chars[charId];
    }
    doc.counts = { ...doc.counts, chars: Object.keys(doc.chars).length, skins: Object.values(doc.chars).reduce((n, l) => n + l.length, 0), droppedToPlayable: dropped };
    log(`[skins] --only=chess：剔除 ${dropped} 套（不在本作棋子表里的干员）`);
  }
  log(`[skins] 目录：${stats.chars} 名干员 / ${stats.skins} 套皮肤（旧目录 ${stats.previous} 套 → ${stats.skins - stats.previous > 0 ? `新增 ${stats.skins - stats.previous}` : '无新增'}）`);
  log(`[skins] 名字：官方表命中 ${stats.named} 套，其余 ${stats.unnamed} 套用 id 兜底；头像齐全 ${stats.avatars} 套`);
  if (o.dryRun) { log('[skins] --dry-run：未写 data/skins.json'); return 0; }
  await writeFile(join(ROOT, 'data', 'skins.json'), JSON.stringify(doc, null, 1) + '\n');
  log(`[skins] 已写入 data/skins.json（${Object.keys(doc.chars).length} 名干员 / ${doc.counts.skins} 套）`);
  log('[skins] 下一步：node tools/skins.mjs local && node tools/skins.mjs inject && node tools/skins.mjs verify');
  return 0;
}

/**
 * The jobs of the CURRENT catalogue (data/skins.json) — the same shape skinJobs() makes out of the research table.
 *
 * This is the source `local` / `inject` / `verify --fix` must use: data/skins.json is what the picker shows, and
 * `node tools/skins.mjs sync` may have widened it far beyond the older research table (measured: 523 skins vs 271).
 * Driving the installer from the research table silently skipped every skin the sync added.
 * @param {any} catalogue data/skins.json
 * @returns {ReturnType<typeof skinJobs>}
 */
export function catalogueJobs(catalogue) {
  const out = [];
  for (const [charId, list] of Object.entries((catalogue && catalogue.chars) || {})) {
    for (const s of list || []) {
      const skinId = s && typeof s.id === 'string' ? s.id : null;
      if (!skinId) continue;
      const stem = stemOf(skinId);
      out.push({
        charId,
        skinId,
        stem,
        name: s.name || skinId,
        group: s.group || '',
        avatar: avatarUrlOf(skinId),
        spine: null, // 本地库 / 磁盘决定有没有模型，路径由 fileJobs() 算
      });
    }
  }
  return out;
}

/**
 * The jobs to work on: the current catalogue when it exists (that is what the player sees), else the research table.
 * @param {{ research?: string|null, catalogue?: boolean, log?: (m: string) => void }} opts
 */
async function sourceJobs(o) {
  const catalogue = await readJson(join(ROOT, 'data', 'skins.json')).catch(() => null);
  if (catalogue && o.catalogue !== false && Object.keys(catalogue.chars || {}).length) {
    if (Object.keys(catalogue.chars).length !== (catalogue.counts?.chars ?? 0)) log('[skins] 注意：data/skins.json 的 counts 与内容不一致（可能被手工改过）');
    return { jobs: catalogueJobs(catalogue), from: 'data/skins.json' };
  }
  const research = await readJson(o.research || RESEARCH);
  return { jobs: skinJobs(research), from: relative(ROOT, o.research || RESEARCH) };
}

/**
 * The manifest `Spine` object of one skin side, resolved from the files that are ON DISK — the shape `local` and
 * `inject` need, where no upstream URL exists (the catalogue names the skin, the dump filled the folder):
 * `public/assets/spine/op/<charId>/<stem>/<side>/<whatever>.skel|.atlas|.png`. The names are read from the folder
 * itself (the dump's `<stem>.skel`, upstream's `build_…` variants — it does not matter), and the atlas + skeleton are
 * parsed exactly like the rest of the asset pipeline so the client accepts the model.
 * @returns {Promise<{ entry: object|null, why: string }>}
 */
export async function resolveSkinSpineFromDisk(charId, stem, side, opts = {}) {
  const dir = join(ROOT, 'public', 'assets', 'spine', 'op', charId, stem, side);
  if (!existsSync(dir)) return { entry: null, why: '文件不全' };
  let names;
  try { names = await readdir(dir); } catch { return { entry: null, why: '目录不可读' }; }
  const skelName = names.find((n) => /\.skel$/i.test(n));
  const atlasName = names.find((n) => /\.atlas$/i.test(n));
  if (!skelName || !atlasName) return { entry: null, why: '文件不全' };
  // 图集里的页名可能是库里的原件名（带 #），先对齐成本地实际文件名，再解析
  const pageNames = await normalizePageNames(dir, (page) => {
    const want = `${stem}${String(page).slice(String(page).lastIndexOf('.'))}`;
    return names.includes(page) ? page : (names.includes(want) ? want : page);
  });
  let atlasText = pageNames.text || await readFile(join(dir, atlasName), 'utf8').catch(() => '');
  if (!atlasText) return { entry: null, why: 'atlas 读取失败' };
  atlasText = stripLeadingBlankLines(atlasText);
  let info;
  try { info = atlasInfo(atlasText); } catch (e) { return { entry: null, why: `atlas 解析失败: ${e.message}` }; }
  const listed = info.pages.filter((p) => names.includes(p));
  const pngs = listed.length ? listed : names.filter((n) => /\.(png|jpg|webp)$/i.test(n) && !/\[alpha\]/i.test(n));
  if (!pngs.length) return { entry: null, why: '图集页缺失' };
  let sk;
  try { sk = parseSkel(await readFile(join(dir, skelName)), info.regions); } catch (e) { return { entry: null, why: `skel 解析失败: ${e.message}` }; }
  if (!sk.animations || !sk.animations.length) return { entry: null, why: '骨骼没有动画' };
  const anims = resolveRoles(sk.animations, { skillIndices: opts.skillIndices, numberedSkills: SKIN_NUMBERED_SKILLS, durations: sk.durations });
  if (!anims || typeof anims !== 'object' || !anims.idle) return { entry: null, why: 'anims 解析不出（骨骼的动画名不认识）' };
  const base = `/assets/spine/op/${charId}/${stem}/${side}`;
  return {
    entry: {
      skel: `${base}/${skelName}`,
      atlas: `${base}/${atlasName}`,
      textures: pngs.map((n) => `${base}/${n}`),
      pma: !!info.hasPma,
      anims,
      animations: sk.durations,
      events: sk.events,
      hits: sk.hits,
      bounds: sk.bounds,
    },
    why: '',
  };
}

/**
 * The summons one outfit re-models — the official `skin_table.json` `tokenSkinMap` of `skinId`:
 * `[{ tokenId, tokenSkinId }]` (null/absent on most skins: that outfit swaps no token model).
 *
 * Real samples (`.cache/skin-table.json`, the table `loadSkinTable` caches):
 *   char_1033_swire2@ambienceSynesthesia#4 → [{ tokenId: 'token_10031_swire2_gdtrap',
 *                                               tokenSkinId: 'token_10031_swire2_gdtrap_ambienceSynesthesia#4' }]
 *   char_003_kalts@sale#14                 → [{ tokenId: 'token_10002_kalts_mon3tr', tokenSkinId: '…_sale#14' }]
 * @param {any} table skin_table.json @param {string} skinId @returns {{ tokenId: string, tokenSkinId: string }[]}
 */
export function tokenSkinMapOf(table, skinId) {
  const rec = table && table.charSkins && table.charSkins[skinId];
  const list = rec && Array.isArray(rec.tokenSkinMap) ? rec.tokenSkinMap : [];
  return list
    .filter((e) => e && typeof e.tokenId === 'string' && typeof e.tokenSkinId === 'string')
    .map((e) => ({ tokenId: e.tokenId, tokenSkinId: e.tokenSkinId }));
}

/**
 * The manifest `Spine` object of a summon's OUTFIT model, read from the files on disk:
 * `public/assets/spine/token/<tokenId>/<stem>.{skel,atlas,png}` — one flat folder per token, the files named after the
 * token skin's stem (`token_10031_swire2_gdtrap_ambienceSynesthesia_4`, stemOf()). The asset pipeline puts the upstream
 * skin-variant models there (tools/assets/plan.mjs `spineVariant`), so this resolves the same shape as a skin's model.
 * @param {string} tokenId @param {string} stem the token skin's stem
 * @returns {Promise<{ entry: object|null, why: string }>}
 */
export async function resolveTokenSkinSpineFromDisk(tokenId, stem, opts = {}) {
  const dir = join(ROOT, 'public', 'assets', 'spine', 'token', tokenId);
  if (!existsSync(dir)) return { entry: null, why: '文件不全' };
  let names;
  try { names = await readdir(dir); } catch { return { entry: null, why: '目录不可读' }; }
  const skelName = `${stem}.skel`;
  const atlasName = `${stem}.atlas`;
  if (!names.includes(skelName) || !names.includes(atlasName)) return { entry: null, why: '文件不全' };
  let info;
  try { info = atlasInfo(await readFile(join(dir, atlasName), 'utf8')); } catch (e) { return { entry: null, why: `atlas 解析失败: ${e.message}` }; }
  // the page names in the atlas are the site names the pipeline normalised to; fall back to the variant's own pages
  const pages = names.filter((n) => info.pages.includes(n));
  const pngs = pages.length ? pages : names.filter((n) => /\.(png|jpg|webp)$/i.test(n) && n.startsWith(stem) && !/\[alpha\]/i.test(n));
  if (!pngs.length) return { entry: null, why: '图集页缺失' };
  let sk;
  try { sk = parseSkel(await readFile(join(dir, skelName)), info.regions); } catch (e) { return { entry: null, why: `skel 解析失败: ${e.message}` }; }
  if (!sk.animations || !sk.animations.length) return { entry: null, why: '骨骼没有动画' };
  const anims = resolveRoles(sk.animations, { skillIndices: opts.skillIndices, numberedSkills: SKIN_NUMBERED_SKILLS, durations: sk.durations });
  if (!anims || typeof anims !== 'object' || !anims.idle) return { entry: null, why: 'anims 解析不出（骨骼的动画名不认识）' };
  const base = `/assets/spine/token/${tokenId}`;
  return {
    entry: {
      skel: `${base}/${skelName}`,
      atlas: `${base}/${atlasName}`,
      textures: pngs.map((n) => `${base}/${n}`),
      pma: !!info.hasPma,
      anims,
      animations: sk.durations,
      events: sk.events,
      hits: sk.hits,
      bounds: sk.bounds,
    },
    why: '',
  };
}

/**
 * The `tokens` block inject writes into one outfit's manifest entry:
 * `{ [tokenId]: { tokenSkinId, spine } }` for every `tokenSkinMap` entry whose model is on disk (a mapped token this
 * install has no files for is left out — the renderer keeps the token's own model, docs/SKINS.md "召唤物").
 *
 * The spine is the asset pipeline's own parsed entry when it is the file the map names (`tokens[id].spineVariant`),
 * else re-parsed from disk (the same skel/atlas/anims rules as the operators' skins).
 * @param {any} manifest data/assets.json @param {string} skinId @param {any} table skin_table.json
 * @returns {Promise<Record<string, { tokenSkinId: string, spine: object }>>}
 */
export async function tokenSkinEntries(manifest, skinId, table) {
  const out = {};
  for (const { tokenId, tokenSkinId } of tokenSkinMapOf(table, skinId)) {
    const stem = stemOf(tokenSkinId);
    const tok = manifest && manifest.tokens ? manifest.tokens[tokenId] : null;
    let spine = tok && tok.spineVariant === stem && tok.spine && tok.spine.skel && tok.spine.anims ? tok.spine : null;
    if (!spine) spine = (await resolveTokenSkinSpineFromDisk(tokenId, stem)).entry;
    if (spine) out[tokenId] = { tokenSkinId, spine };
  }
  return out;
}

/**
 * `normalize`: rewrite the atlas of every skin already under `public/assets/spine/op/` so its texture-page names match
 * the files on disk. This is the repair for a dump copied before the renaming step existed (and the cheap way to fix
 * an install whose atlases still name `…#3.png` files that are stored as `…_3.png`).
 */
async function commandNormalize(o) {
  const root = join(ROOT, 'public', 'assets', 'spine', 'op');
  if (!existsSync(root)) { log(`[skins] 没有 ${relative(ROOT, root)}：先跑 node tools/skins.mjs local 或 fetch`); return 1; }
  let dirs = 0; let fixed = 0; const failed = [];
  for (const charId of await readdir(root)) {
    for (const stem of await readdir(join(root, charId)).catch(() => [])) {
      for (const side of ['front', 'back']) {
        const dir = join(root, charId, stem, side);
        if (!existsSync(dir)) continue;
        const files = await readdir(dir).catch(() => []);
        if (!files.some((n) => /\.atlas$/i.test(n))) continue;
        dirs++;
        const res = await normalizePageNames(dir, (page) => {
          const ext = String(page).slice(String(page).lastIndexOf('.'));
          const want = `${stem}${ext}`;
          return files.includes(page) ? page : (files.includes(want) ? want : page);
        });
        if (res.changed) fixed++;
        else if (files.some((n) => /\.(png|jpg|webp)$/i.test(n) && !files.includes(n))) failed.push(`${charId}/${stem}/${side}`);
      }
    }
  }
  log(`[skins] 图集归一：检查 ${dirs} 个模型目录，改写 ${fixed} 个图集${failed.length ? `，仍有 ${failed.length} 个对不上（${failed.slice(0, 3).join(', ')}）` : ''}`);
  log('[skins] 提示：浏览器可能缓存了旧的 .atlas，改完后请硬刷新（Ctrl+F5）');
  return failed.length ? 1 : 0;
}

/**
 * The upstream half-body portrait URL of a skin — the mirror `plan.mjs` uses for the operators (`RAW.yuanyan`), with
 * that repository's two naming quirks: `@` becomes `_` and the `#` must be percent-encoded
 * (`portrait/char_1012_skadi2_boc%234.png`); without the encoding the request 404s (measured).
 * Those files are 180×360 — exactly the size the shop card draws — at 100–140 KB, against 450 KB–6 MB for the
 * full-resolution illustrations in the local dump, which are the wrong crop for a card.
 * @param {string} skinId e.g. `char_1012_skadi2@boc#4`
 * @returns {string} an absolute URL
 */
export function skinPortraitUrl(skinId) {
  return `${RAW.yuanyan}portrait/${encodeURIComponent(String(skinId).replace(/@/g, '_'))}.png`;
}

/** The same file on jsDelivr (the mirror that survives a blocked raw.githubusercontent.com). */
export function skinPortraitMirrorUrl(skinId) {
  return `https://cdn.jsdelivr.net/gh/yuanyan3060/ArknightsGameResource@main/portrait/${encodeURIComponent(String(skinId).replace(/@/g, '_'))}.png`;
}

/**
 * The URL order for a skin's portrait, jsDelivr first.
 *
 * It must NOT go through candidates(): that put `raw.githubusercontent.com` before the mirror, and on a mainland line
 * the raw host connects and then stalls, so each of the 523 files sat there until the 120 s abort (measured: the run
 * looked hung). jsDelivr answers immediately for this repo, raw stays as the last resort, and `--source=mirror` (with
 * `--proxy`) still prepends the prefix proxy when GitHub itself is the only reachable route.
 * @param {string} skinId @param {{ source?: string, proxy?: string }} o
 * @returns {string[]}
 */
export function portraitUrlOrder(skinId, o = {}) {
  const order = [skinPortraitMirrorUrl(skinId), skinPortraitUrl(skinId)];
  for (const u of alternatives(skinPortraitUrl(skinId), o.source, o.proxy)) if (!order.includes(u)) order.unshift(u);
  return order;
}

/** The exact size of the half-body art the cards draw (public/assets/char/portrait/*.png are 180×360 too). */
export const PORTRAIT_SIZE = Object.freeze({ w: 180, h: 360 });

/** The pixel size of a PNG file, or null when it is missing / not a PNG. */
function pngSizeOf(abs) {
  try {
    const buf = fs.readFileSync(abs);
    if (buf.length < 24 || !buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return null;
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  } catch { return null; }
}

/**
 * Is the portrait already at the right size? A file that is not exactly 180×360 is the wrong crop, whatever its byte
 * count: the dump's `operator/arts` illustrations are square (1024×1024 …) and an avatar is 180×180.
 */
function portraitLooksRight(abs) {
  const s = pngSizeOf(abs);
  return !!s && s.w === PORTRAIT_SIZE.w && s.h === PORTRAIT_SIZE.h;
}

/**
 * Fetch the 180×360 half-body portrait of a skin into `public/assets/char/skin_portrait/<stem>.png`.
 * Tries `portraitUrlOrder()` in turn — jsDelivr first, raw last — with a short timeout per attempt so a stalling host
 * cannot hold up the run. An existing file is kept only when it really is 180×360 (`--force` overrides that).
 * @returns {Promise<'ok'|'skip'|'none'|'error'>}
 */
async function fetchSkinPortrait(job, o) {
  const rel = portraitPathOf(job.stem);
  const abs = join(ROOT, 'public', 'assets', rel);
  if (!o.force && portraitLooksRight(abs)) return 'skip';
  for (const url of portraitUrlOrder(job.skinId, o)) {
    try {
      const res = await httpFetch(url, { headers: HEADERS, signal: AbortSignal.timeout(o.timeoutMs || 25000) });
      if (!res.ok) continue; // 404 = 上游没有这张；其余（5xx/429）换下一个源
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) continue;
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, buf);
      return 'ok';
    } catch { /* timeout / DNS / TLS → 下一个源 */ }
  }
  return 'none';
}
async function skinArtName(arts, skinId, stem, dirName = null) {
  // 库里的命名是 `@` → `_`、`#` 保留：`char_002_amiya_epoque#4.png`（`b` 后缀是更小的同一张图）
  const underscore = String(skinId).replace(/@/g, '_');
  const names = [
    dirName && `${dirName}b.png`, `${underscore}b.png`, `${skinId}b.png`, `${stem}b.png`,
    dirName && `${dirName}.png`, `${underscore}.png`, `${skinId}.png`, `${stem}.png`,
  ];
  return firstExisting(arts, names.filter(Boolean));
}

/**
 * Copy the half-body art of one skin into `public/assets/char/skin_portrait/<stem>.png` (no-op when it is already
 * there with the same byte size).
 * @returns {Promise<'ok'|'skip'|'none'|'error'>}
 */
async function copySkinPortrait(arts, job, { force = false, dirName = null } = {}) {
  const name = await skinArtName(arts, job.skinId, job.stem, dirName);
  if (!name) return 'none';
  const to = join(ROOT, 'public', 'assets', portraitPathOf(job.stem));
  try {
    const buf = await readFile(join(arts, name));
    if (!force && sizeOfSync(to) === buf.length) return 'skip';
    await mkdir(dirname(to), { recursive: true });
    await writeFile(to, buf);
    return 'ok';
  } catch (e) {
    if (e?.code !== 'ENOENT') log(`  ! ${job.skinId}: 立绘写盘失败 ${e?.code || e?.message}`);
    return 'error';
  }
}

/**
 * `portraits`: put the skins' half-body art (the shop / warp card and the detail header) into
 * `public/assets/char/skin_portrait/`.
 *
 * Two sources, and they are NOT equivalent: the upstream mirror ships the art already cropped to 180×360 at
 * 100–140 KB — the size the card draws — while the local dump only holds the full-resolution illustrations
 * (1024×1024 … 6 MB), a full-body crop that does not fit a card. So `--source=net` (the default) downloads from the
 * mirror and `--source=local` copies from the dump (`--from=<库根>`, default `G:\尖塔mod\HellaAssets`).
 * @param {{ source?: string }} o
 */
async function commandPortraits(o) {
  const source = o.source === 'local' || o.source === 'dump' ? 'local' : 'net';
  const repo = o.from || process.env.SP_SKINS_REPO || 'G:/尖塔mod/HellaAssets';
  const arts = join(repo, 'operator', 'arts');
  if (source === 'local' && !existsSync(arts)) {
    log(`[skins] 找不到立绘目录：${arts}（--from=<库根>，里面应有 operator/arts/）`);
    log('[skins] 或者用默认的 --source=net 从上游下载裁好的 180×360 立绘');
    return 1;
  }
  const { jobs: allJobs, from } = await sourceJobs(o);
  if (from !== relative(ROOT, o.research || RESEARCH)) log(`[skins] 按当前目录 ${from} 工作（共 ${allJobs.length} 套）`);
  const jobs = pickJobs(allJobs, o);
  const forceMode = o.overwrite === 'big';
  log(`[skins] 立绘来源：${source === 'net' ? `上游 ${new URL(RAW.yuanyan).host}（180×360，100+ KB）` : `本地库 ${arts}（全分辨率，仅作回退）`}${forceMode ? ' · --overwrite=big（尺寸不是 180×360 的旧图会被替换）' : ''}${o.force ? ' · --force（全部重写）' : ''}${o.dryRun ? ' · --dry-run' : ''}`);
  // 库里的文件名保留 `#`（`char_002_amiya_epoque#4.png`）：把 stem 映射回原件名
  const dirOf = new Map();
  for (const n of await readdir(arts).catch(() => [])) dirOf.set(stemOf(n.replace(/b?\.png$/i, '')), n.replace(/b?\.png$/i, ''));
  let taken = 0; let bytes = 0; let fromDump = 0; let failed = 0; let replaced = 0; let failedWrite = null; const missing = [];
  let done = 0;
  const batch = Math.max(1, Math.min(32, Number(o.concurrency) || 8));
  const forceAll = o.force || o.overwrite === 'big';
  const one = async (j) => {
    const dirName = dirOf.get(j.stem) || null;
    // 磁盘上那张已经不是 180×360（库里的全分辨率全身图，或误搬的 180×180 头像）→ 用上游裁好的版本覆盖
    const target = join(ROOT, 'public', 'assets', portraitPathOf(j.stem));
    const stale = forceAll && !portraitLooksRight(target) && sizeOfSync(target) > 0;
    const opts = stale || o.force ? { ...o, force: true } : o;
    if (source === 'net') {
      const state = await fetchSkinPortrait(j, opts);
      if (state === 'ok') { taken++; bytes += sizeOfSync(target); if (stale) replaced++; return; }
      if (state === 'skip') return;
    }
    // 上游没有这张（新皮肤 / 镜像缺文件）→ 回退到本地库那张（全分辨率，至少不是空白）
    if (source === 'local' || !o.netOnly) {
      const localState = await copySkinPortrait(arts, j, { force: o.force, dirName });
      if (localState === 'ok') { taken++; fromDump++; bytes += sizeOfSync(target); return; }
    }
    failed++; missing.push(j.skinId);
  };
  for (let i = 0; o.dryRun !== true && i < jobs.length; i += batch) {
    const slice = jobs.slice(i, i + batch);
    const results = await Promise.allSettled(slice.map((j) => one(j)));
    for (const r of results) if (r.status === 'rejected') failedWrite = r.reason;
    done += slice.length;
    // 进度：每批都报，别让 500 个文件看着像卡死
    log(`[skins] 立绘 ${done}/${jobs.length} · 写入 ${taken} · 跳过 ${done - taken - failed} · 失败 ${failed}`);
    if (failedWrite) break;
  }
  if (failedWrite) {
    const e = failedWrite;
    log(`  ! 写盘/处理失败：${e?.code || e?.message || e}——目录权限或沙箱限制（不是上游的问题），已停在 ${done}/${jobs.length}`);
    return 1;
  }
  if (o.dryRun) { log(`[skins] --dry-run：${jobs.length} 套待处理（未写文件）`); return 0; }
  log(`[skins] 立绘导入：${jobs.length} 套 → 写入 ${taken} 张（${mb(bytes)}）${replaced ? `，其中 ${replaced} 张是替换掉库里的全分辨率旧图` : ''}${fromDump ? `，${fromDump} 张回退自本地库` : ''}；跳过已有 ${jobs.length - taken - failed} 套`);
  if (missing.length) log(`[skins] 上游和本地库都没有的：${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ` …共 ${missing.length} 套` : ''}`);
  log('[skins] 下一步：node tools/skins.mjs inject   （把立绘写进 data/assets.json）');
  return failed && failed === jobs.length ? 1 : 0;
}

/** Synchronous size, for the "already copied" check. */
function sizeOfSync(abs) {
  try { return fs.statSync(abs).size; } catch { return -1; }
}

/** `layout`: resolve and remember the layout only (no download) — handy before a long fetch run. */async function commandLayout(o) {
  const research = await readJson(o.research || RESEARCH);
  const jobs = pickJobs(skinJobs(research), o);
  await resolveFexliCommit();
  const layouts = await ensureLayout(jobs, o);
  const tally = {};
  for (const j of jobs) {
    if (!j.spine) continue;
    const k = layouts.get(`${j.charId}/${j.stem}`) || 'front-back';
    tally[k] = (tally[k] || 0) + 1;
  }
  log(`[skins] 布局统计：${Object.entries(tally).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  log(`[skins] 缓存写入 ${relative(ROOT, LAYOUT_CACHE)}（fetch 会直接用它）`);
  return 0;
}

async function commandFetch(o) {
  const research = await readJson(o.research || RESEARCH);
  const jobs = pickJobs(skinJobs(research), o);
  await resolveFexliCommit();
  const layouts = await ensureLayout(jobs, o);
  const tasks = [];
  for (const j of jobs) for (const t of fileJobs(j, o.side, layouts.get(`${j.charId}/${j.stem}`))) {
    for (const u of t.urls) tasks.push({ rel: t.rel, urls: alternatives(u, o.source, o.proxy) });
  }
  // 先探一次落盘：目录权限有问题时立刻说清楚，不要让 1300 个任务一个个撞墙
  const probeRel = join('char', 'skin_avatar', '.skins-write-probe');
  try {
    await mkdir(dirname(join(ROOT, 'public', 'assets', probeRel)), { recursive: true });
    await writeFile(join(ROOT, 'public', 'assets', probeRel), 'x');
    await rm(join(ROOT, 'public', 'assets', probeRel), { force: true });
  } catch (e) {
    log(`[skins] 无法写入 public/assets：${e?.code || e?.message}`);
    log(`        如果是 EPERM / 拒绝访问，先恢复目录权限继承，例如：icacls "${join(ROOT, 'public', 'assets')}" /reset`);
    return 1;
  }
  log(`[skins] ${jobs.length} 套皮肤 → ${tasks.length} 个文件，并发 ${o.concurrency}（已存在的跳过，可随时中断重跑）`);  let done = 0; let ok = 0; let skip = 0; let err = 0; let bytes = 0;
  const failures = [];
  const byCode = new Map();
  const big = [];
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const task = tasks[next++];
      const r = await downloadOne(task, o);
      done++;
      if (r.status === 'ok') { ok++; bytes += r.bytes; big.push(r); } else if (r.status === 'skip') { skip++; } else {
        err++;
        const code = r.code || 'OTHER';
        byCode.set(code, (byCode.get(code) || 0) + 1);
        failures.push(`${r.rel}  [${code}]  ${r.error}`);
      }
      if (done % 25 === 0 || done === tasks.length) log(`[skins] ${done}/${tasks.length} ok=${ok} skip=${skip} err=${err} ${mb(bytes)}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(o.concurrency, tasks.length || 1) }, worker));
  log(`[skins] 完成：新增 ${ok}，跳过 ${skip}，失败 ${err}（新增 ${mb(bytes)}）`);
  if (failures.length) {
    const summary = [...byCode.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}×${n}`).join('  ');
    log(`[skins] 失败分类：${summary}`);
    log('[skins] 前 15 条：');
    for (const f of failures.slice(0, 15)) log(`  ! ${f}`);
    if (byCode.has('404')) log('  · 404 = 上游确实没有这个文件（例如某套皮肤没有 Back 模型），不是错误，跳过即可');
    if (byCode.has('NET') || byCode.has('HTTP')) log('  · NET/HTTP = 网络问题：重跑一次，或加 --source=mirror（--proxy 可换前缀）');
    if (byCode.has('WRITE')) log('  · WRITE = 写盘被拒：恢复目录权限继承（icacls "<项目>\\public\\assets" /reset）或换到有写权限的目录');
  }
  if (big.length) {
    const top = big.sort((a, b) => b.bytes - a.bytes).slice(0, 5);
    log(`[skins] 最大的几个文件：${top.map((t) => `${t.rel} ${(t.bytes / 1024).toFixed(0)} KB`).join('，')}`);
  }
  log('[skins] 下一步：node tools/skins.mjs inject   （把已下载的皮肤写进 data/assets.json）');
  return err ? 1 : 0;
}

async function commandInject(o) {
  const { jobs: allJobs, from } = await sourceJobs(o);
  if (from !== relative(ROOT, o.research || RESEARCH)) log(`[skins] 按当前目录 ${from} 工作（共 ${allJobs.length} 套）`);
  const jobs = pickJobs(allJobs, o);
  const manifestPath = o.manifest || MANIFEST;
  const manifest = await readJson(manifestPath);
  manifest.chars = manifest.chars || {};
  const canParse = skelParserAvailable();
  if (o.spine !== false && !canParse) {
    log('[skins] 警告：@pixi-spine/runtime-3.8 不在（先 npm install）——这次只写头像与名字，spine 留待下次 inject');
  }
  // the official tokenSkinMap of each outfit (换装 召唤物): cached in .cache/skin-table.json; offline without the cache
  // the outfits are written without a `tokens` block (the summons keep their own model, which is what shipped so far)
  const table = await loadSkinTable({ log });
  if (!table) log('[skins] 没有官方皮肤表（.cache/skin-table.json 且离线）：这次不写召唤物的换装模型');
  let withModels = 0; let withAvatars = 0; let withTokenSkins = 0; let skipped = 0; const problems = [];
  const layouts = o.fix ? await readJson(LAYOUT_CACHE).catch(() => ({})) : {};
  for (const j of jobs) {
    const rec = manifest.chars[j.charId];
    if (!rec) { skipped++; continue; }
    const avatarRel = avatarPathOf(j.stem);
    const hasAvatar = await onDisk(avatarRel);
    const entry = { name: j.name, group: j.group };
    if (hasAvatar) entry.avatar = `/assets/${avatarRel}`;
    // 半身立绘（商店/购买卡与详情页大图用到；没有就不写，客户端回退到默认立绘）
    const portraitRel = portraitPathOf(j.stem);
    if (await onDisk(portraitRel)) entry.portrait = `/assets/${portraitRel}`;
    if (canParse && o.spine !== false) {
      // 直接读磁盘上的 front/back 目录（`local` / `fetch` 已经把文件放进去了），不依赖上游 URL
      const skillIndices = [0, ...(Array.isArray(rec.skills) ? rec.skills.map((s) => s.index).filter(Number.isInteger) : [])];
      const front = await resolveSkinSpineFromDisk(j.charId, j.stem, 'front', { skillIndices });
      const back = await resolveSkinSpineFromDisk(j.charId, j.stem, 'back', { skillIndices });
      if (front.entry) {
        entry.spine = { front: front.entry, ...(back.entry && back.entry.skel !== front.entry.skel ? { back: back.entry } : {}) };
        withModels++;
      } else if (front.why !== '文件不全') {
        problems.push(`${j.skinId}: ${front.why}`);
      }
    }
    // 换装 (召唤物皮肤): the summons this outfit re-models (official skin_table.json `tokenSkinMap`) — only the models
    // this install really has; the renderer draws them for the owner's summoned tokens (assets.js tokenSkinSpine) and
    // keeps the token's own model otherwise (docs/SKINS.md "召唤物"). Needs the skin table: cached in .cache/.
    const tokenSkins = table ? await tokenSkinEntries(manifest, j.skinId, table) : {};
    const tokenCount = Object.keys(tokenSkins).length;
    if (tokenCount) { entry.tokens = tokenSkins; withTokenSkins += tokenCount; }
    if (!rec.skins) rec.skins = {};
    rec.skins[j.skinId] = entry;
    if (hasAvatar) withAvatars++;
  }
  if (!withAvatars && !withModels) {
    log('[skins] 磁盘上还没有皮肤素材：先跑 node tools/skins.mjs fetch，再 inject');
    return 0;
  }
  if (o.dryRun) {
    log(`[skins] --dry-run：将写入 ${withAvatars} 个头像、${withModels} 套带模型、${withTokenSkins} 个召唤物换装模型（未写文件）`);
    return 0;
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 1) + '\n');
  log(`[skins] 写入 ${relative(ROOT, manifestPath)}：${withAvatars} 个头像，${withModels} 套带模型，${withTokenSkins} 个召唤物换装模型（跳过 ${skipped} 名不在清单里的干员）`);
  log(`[skins] anims 由构建期解析生成（tools/assets/anim-roles.mjs），客户端 validSpine() 因此能接受这些模型`);
  for (const p of problems.slice(0, 10)) log(`  ! ${p}`);
  if (problems.length > 10) log(`  ! 另有 ${problems.length - 10} 条见上（多数是上游单侧模型缺失或骨骼损坏）`);
  log('[skins] 提示：tools/fetch-assets.mjs 重新生成清单会丢掉这些字段，顺序是 fetch-assets → skins inject');
  return 0;
}

/**
 * What the client will actually load: every skin the manifest lists that has files on disk, checked exactly the way
 * public/js/assets.js validSpine() does (skel + atlas + at least one texture + an anims map). Run this after inject.
 *
 * `--fix` repairs the entries a bad/older inject left behind: it re-reads the files on disk and re-resolves `anims`
 * (the one field the client cannot work without), so a manifest written before the anims fix heals in place.
 */
async function commandVerify(o) {
  const manifestPath = o.manifest || MANIFEST;
  const manifest = await readJson(manifestPath);
  const exists = (url) => existsSync(join(ROOT, 'public', ...String(url).split('/').filter(Boolean)));
  const { jobs } = o.fix ? await sourceJobs(o) : { jobs: [] };
  let listed = 0; let drawable = 0; let avatars = 0; let broken = 0; let fixed = 0;
  const bad = [];
  for (const [charId, rec] of Object.entries(manifest.chars || {})) {
    for (const [skinId, skin] of Object.entries(rec.skins || {})) {
      listed++;
      if (skin.avatar && exists(skin.avatar)) avatars++;
      const sp = skin.spine && skin.spine.front;
      if (!sp) continue; // 目录里有、模型没下：客户端回退到干员默认模型，不算坏
      const shapesOk = typeof sp.skel === 'string' && sp.skel.endsWith('.skel') && typeof sp.atlas === 'string'
        && Array.isArray(sp.textures) && sp.textures.length > 0
        && exists(sp.skel) && exists(sp.atlas) && sp.textures.every(exists);
      const animsOk = !!sp.anims && typeof sp.anims === 'object' && !!sp.anims.idle;
      if (shapesOk && animsOk) { drawable++; continue; }
      // --fix: 文件和 skel/atlas 都在、只是 anims 丢了 → 从磁盘重新解析角色（与 inject 同一条代码路径）
      if (o.fix && shapesOk && !animsOk) {
        const job = jobs.find((j) => j.skinId === skinId);
        const r = job ? await resolveSkinSpineFromDisk(charId, job.stem, 'front', { skillIndices: [0, ...(rec.skills || [])] }) : { entry: null };
        if (r.entry) { skin.spine.front = { ...r.entry, ...(skin.spine.back ? { back: skin.spine.back } : {}) }; fixed++; drawable++; continue; }
      }
      broken++; bad.push(`${charId} ${skinId}`);
    }
  }
  if (fixed && !o.dryRun) await writeFile(manifestPath, JSON.stringify(manifest, null, 1) + '\n');
  log(`[skins] 清单 ${relative(ROOT, manifestPath)}：列出 ${listed} 套，可绘制 ${drawable} 套，头像在盘 ${avatars} 个，坏掉 ${broken} 个${fixed ? `，已就修 ${fixed} 套` : ''}`);
  for (const b of bad.slice(0, 10)) log(`  ! ${b}`);
  if (broken) {
    log('  坏掉的：文件缺了，或 anims 没解析出来');
    log('  修法：node tools/skins.mjs verify --fix（只补 anims，不动别的）／或 node tools/skins.mjs fetch && node tools/skins.mjs inject');
  }
  return broken ? 1 : 0;
}

const HELP = `Usage: node tools/skins.mjs <plan|sync|normalize|portraits|layout|local|fetch|inject|verify> [options]
  plan      print every skin, its files and its upstream URLs (writes nothing)
  sync      rebuild data/skins.json from the local dump (every skin it holds, named from the official table)
  normalize rewrite the atlases already under public/assets so their page names match the files (fixes the
            pixi-spine "baseTexture" crash of a dump copied before that step existed)
  portraits put the skins' half-body art into public/assets/char/skin_portrait: --source=net (default) downloads the
            upstream 180×360 crop (100–140 KB, the size the card draws); --source=local copies the dump's
            operator/arts (full resolution, wrong crop for a card — only a fallback for skins the mirror lacks)
            --overwrite=big  replace an existing file when it is a full-resolution one (>250 KB)
            (the file names there keep the dump's #; the stem is tried too, so either dump works)
  layout    probe which upstream model layout each skin uses and remember it (.cache/skins-layout.json)
  local     copy the skins out of a complete local dump (--from=<库根>) instead of downloading them
  fetch     download the avatars and Spine models of the research table into public/assets
  inject    write the skins that are on disk into data/assets.json (chars[charId].skins, anims resolved; plus the
            summons each outfit re-models — the official skin_table tokenSkinMap — as skin.tokens[tokenId])
  verify    check that every skin the manifest lists really loads (validSpine rules, files on disk)
            --fix re-resolves the anims of entries an older inject left without it (nothing else is touched)
Options:
  --chars=a,b        only these operators (charId); --all is the default
  --from=<dir>       local repo root for the local command (default G:\\尖塔mod\\HellaAssets, or SP_SKINS_REPO):
                     expects <root>/spine/operator/battle/<stem>/{front,back}/ and <root>/operator/avatars/<stem>.png
  --side=front,back  fetch only these model sides (default both)
  --probe            plan: probe the upstream layout on the spot (does not write the cache)
  --no-names         sync: do not fetch the official name table (keep the previous names, id for the rest)
  --only=chess       sync: keep only the operators this build plays with (data/chess.json + backups) — the dump also
                     holds alt-form/未实装 operators whose skins can never be picked (measured: 250 of 523 skins)
  --refresh-names    sync: re-download the name table instead of using .cache/skin-table.json
  --limit=N          only the first N skins
  --concurrency=N    parallel downloads (fetch; default 8)
  --force            re-download files that already exist (fetch)
  --overwrite=big    portraits: replace an existing portrait whose pixels are not 180×360 (the dump's full-resolution
                     illustrations, 1024×1024 and up, are the wrong crop for a card)
  --net-only         portraits: never fall back to the dump's full-resolution art (a skin with no upstream file is
                     then reported instead of being filled with a bad crop)
  --timeout=MS       portraits: per-attempt timeout (default 25000). Lower it if a stalling host makes a run feel
                     hung — every source is tried in turn and jsDelivr is tried first
  --dry-run          print what inject would write, change nothing
  --no-spine         inject: skip the skeleton parsing (avatars and names only)
  --research=<file>  the skin research table (default docs/research/08-skins.json, else a known sibling copy)
  --manifest=<file>  the manifest to read/write (inject / verify; default data/assets.json)
  --source=direct|mirror   GitHub source policy (default direct; mirror tries SP_GITHUB_PROXY first)
  --proxy=<prefix>   the HTTPS prefix proxy of mirror mode (default https://gh-proxy.com/)
  -h, --help
Environment:
  HTTP_PROXY / HTTPS_PROXY   routed through by Node's fetch only when the process was started with
                             NODE_USE_ENV_PROXY=1 (Node >=22.21 or >=24) — this script restarts itself once to set
                             that, so setting HTTPS_PROXY in the shell is enough. SP_GITHUB_PROXY is the
                             prefix proxy of --source=mirror (an empty value disables it).`;

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { log(HELP); return 0; }
  if (o.unknown.length) {
    log(`[skins] 不认识的参数：${o.unknown.join(' ')}（不会被执行，先改对再跑）`);
    log(HELP);
    return 2;
  }
  if (!o.cmd) { log(HELP); return 2; }
  // a configured HTTP(S)_PROXY must be used, not silently bypassed (tools/assets/env-proxy.mjs): restart once with
  // NODE_USE_ENV_PROXY=1 so Node's fetch routes through it — the same one-shot hand-off the asset pipeline does
  if (restartForEnvProxy()) return 0;
  if (process.env.SP_SKINS_DEBUG) log(`[skins] HTTP(S)_PROXY ${proxyConfigured(process.env) ? '已启用' : '未设置'}`);
  const research = researchPath(o.research);
  if (!existsSync(research)) {
    console.error(`[skins] 缺少研究表 ${relative(ROOT, RESEARCH)}（静态表，不从网络取）`);
    console.error('        可以用 --research=<08-skins.json 的路径> 或 SP_SKINS_RESEARCH 指向另一份拷贝');
    return 1;
  }
  if (research !== RESEARCH) log(`[skins] 研究表改用 ${research}`);
  const opts = { ...o, research };
  if (o.cmd === 'plan') return commandPlan(opts);
  if (o.cmd === 'sync') return commandSync(opts);
  if (o.cmd === 'normalize') return commandNormalize(opts);
  if (o.cmd === 'portraits') return commandPortraits(opts);
  if (o.cmd === 'layout') return commandLayout(opts);
  if (o.cmd === 'local') return commandLocal(opts);
  if (o.cmd === 'fetch') return commandFetch(opts);
  if (o.cmd === 'inject') return commandInject(opts);
  if (o.cmd === 'verify') return commandVerify(opts);
  console.error(`unknown command ${o.cmd}\n${HELP}`);
  return 2;
}

// only when run as a script (tests import stemOf / skinJobs / localPathOf)
const invoked = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invoked) {
  main().then((code) => { process.exitCode = code; }, (e) => {
    console.error(`[skins] FAILED: ${process.env.DEBUG ? e?.stack || e : e?.message || e}`);
    process.exitCode = 1;
  });
}
