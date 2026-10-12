// 插件入口本身：真的 import 那个 ES 模块并跑 register()（最小 DOM 打桩）。
//
// 这条测试抓的是「模块级错误」——写错 import（`html` 不是 preact 的导出）、拼错导出名、register() 一上来就抛、
// dispose() 抛——这类问题在浏览器里只会表现为「插件什么都没出现」，没有别的线索。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLUGIN = 'plugins/dps-meter';

/** The least DOM the plugin touches: createElement / head / body / localStorage / timers / window size. */
function stubDom() {
  const node = () => ({
    dataset: {}, className: '', style: {},
    appendChild() {}, remove() {}, addEventListener() {}, removeEventListener() {},
    querySelector: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
    closest: () => null,
  });
  globalThis.document = {
    createElement: node,
    head: { appendChild() {} },
    body: { appendChild() {} },
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  globalThis.localStorage = { store: new Map(), getItem(k) { return this.store.get(k) ?? null; }, setItem(k, v) { this.store.set(k, String(v)); }, removeItem(k) { this.store.delete(k); } };
  globalThis.innerWidth = 1280;
  globalThis.innerHeight = 720;
  // 曲线栏在浏览器里靠 requestAnimationFrame 轮询；测试里不跑它（否则会一直自我重排，进程结束不了）
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};
}

/** The api object public/js/plugins.js hands a plugin. */
function stubApi() {
  const links = [];
  // 应用 store 的最小替身：register() 会订阅它来侦测「新一局开始」（matchActive 的 false→true 跳变）
  const listeners = new Set();
  let state = { match: { public: { phase: 'LOBBY', round: 0 }, result: null } };
  return {
    id: 'dps-meter',
    manifest: { files: { css: '/plugins/dps-meter/plugin.css', i18n: '/plugins/dps-meter/i18n' } },
    t: (s) => s,
    N_: (s) => s,
    log() {}, warn() {},
    loadCss: () => { const l = { rel: 'stylesheet', href: '/plugins/dps-meter/plugin.css', dataset: {}, remove() {} }; links.push(l); return l; },
    mount: () => ({ dataset: {}, appendChild() {}, remove() {} }),
    on: () => () => {},
    i18n: async () => 0,
    store: {
      get: () => state,
      set: (s) => { state = { ...state, ...s }; for (const fn of [...listeners]) fn(state); },
      subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    },
    emit: (s) => { state = s; for (const fn of [...listeners]) fn(state); },
    listeners,
    links,
  };
}

test('the plugin manifest is valid and every file it names exists', async () => {
  const { normalizePluginManifest, isPluginPath } = await import('../../server/plugins.js');
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, PLUGIN, 'plugin.json'), 'utf8'));
  const { manifest, problems } = normalizePluginManifest(raw, { id: 'dps-meter' });
  assert.deepEqual(problems, []);
  assert.equal(manifest.entry, 'plugin.js');
  for (const [role, rel] of Object.entries(manifest.files)) {
    assert.ok(isPluginPath(rel) || !rel.includes('.'), `${role}: ${rel} is a legal manifest path`);
    if (rel.includes('.')) assert.ok(fs.existsSync(path.join(ROOT, PLUGIN, rel)), `${role}: ${rel} exists`);
    else assert.ok(fs.statSync(path.join(ROOT, PLUGIN, rel)).isDirectory(), `${role}: ${rel}/ exists`);
  }
  assert.ok(fs.existsSync(path.join(ROOT, PLUGIN, 'i18n', 'en.json')), 'the plugin ships its own i18n');
});

/** Where a site-absolute mount lives in the repository: /vendor and /js under public/, /data and /shared at the root. */
const SITE_MOUNTS = Object.freeze({ vendor: 'public', js: 'public', data: '', shared: '' });

/** The repo-relative path behind a site-absolute URL (`/vendor/x` → `public/vendor/x`), or null. */
function repoPathOf(url) {
  const m = /^\/([a-z]+)\/(.+)$/.exec(url);
  if (!m) return null;
  const [mount, rest] = [m[1], m[2]];
  if (!(mount in SITE_MOUNTS)) return null;
  return path.join(SITE_MOUNTS[mount], mount, rest);
}

/**
 * Load one plugin module the way the browser would, but with Node able to resolve it: every site-absolute import
 * (`/vendor/…`, `/js/…`) is rewritten to the repository-relative path it is served from, and the result is written to
 * a temp file inside the repo before importing. That rewrite IS the contract under test — the plugin must use the
 * served mounts, never `../../public/…` (which the static server answers with 404 and which killed the plugin once).
 * @param {'plugin'|'panel'} which
 * @returns {Promise<any>} the imported module
 */
async function loadModule(which = 'plugin') {
  const dir = path.join(ROOT, PLUGIN);
  if (tempFiles.length) for (const t of tempFiles) fs.rmSync(t, { force: true });
  tempFiles.length = 0;
  const rewrite = (src) => src.replace(/(['"])(\/(?:vendor|js|data|shared)\/[^'"]+)\1/g, (_, q, url) => {
    const rel = repoPathOf(url);
    return `${q}${path.relative(dir, path.join(ROOT, rel)).split(path.sep).join('/')}${q}`;
  });
  for (const file of ['panel.js', 'dps-core.js', 'plugin.js']) {
    if (!fs.existsSync(path.join(dir, file))) continue;
    let src = rewrite(fs.readFileSync(path.join(dir, file), 'utf8'));
    // 相对模块改指向临时副本（Node 解析得到），其余相对路径不动
    for (const dep of ['panel.js', 'dps-core.js']) {
      const stem = path.basename(dep, '.js');
      src = src.replace(new RegExp(`(['"])\\./${dep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1`, 'g'), (_, q) => `${q}./${stem}.entry.test.mjs${q}`);
    }
    const tmp = path.join(dir, `${path.basename(file, '.js')}.entry.test.mjs`);
    fs.writeFileSync(tmp, src);
    tempFiles.push(tmp);
  }
  const mod = await import(`../../${PLUGIN}/${which}.entry.test.mjs`).finally(() => {
    // 成功或抛错都要清掉临时模块（抛错时留下残骸会污染插件目录）
    for (const t of tempFiles) fs.rmSync(t, { force: true });
    tempFiles.length = 0;
  });
  return mod;
}

/** Temp module copies of the last loadModule() call (removed again right after the import). */
const tempFiles = [];

const loadEntry = () => loadModule('plugin');

test('the entry loads as an ES module and register() runs (the bug class: a wrong import, a throwing setup)', async () => {
  stubDom();
  const mod = await loadEntry();
  assert.equal(typeof mod.default, 'function', 'the entry exports a default register function');
  const api = stubApi();
  const handle = mod.default(api);
  assert.equal(typeof handle?.dispose, 'function', 'register() returns a dispose handle');
  assert.equal(api.links.length, 1, 'register() injected the stylesheet the manifest names');
  handle.dispose();
  assert.equal(typeof mod.VERSION, 'string');
});

test('the entries the poll depends on exist on the runner (fieldUnits) and the plugin degrades quietly without it', async () => {
  stubDom();
  const mod = await loadEntry();
  const api = stubApi();
  // no runner at all: register() must still succeed (the button simply never lights up)
  const handle = mod.default(api);
  assert.equal(typeof handle.dispose, 'function');
  handle.dispose();
  // a runner without fieldUnits (an older build): same
  const handle2 = mod.default({ ...api, runner: { currentBattle: () => null } });
  assert.equal(typeof handle2.dispose, 'function');
  handle2.dispose();
  // and the surface the plugin reads must be the runner's own contract
  const runnerSrc = fs.readFileSync(path.join(ROOT, 'public/js/battle/runner.js'), 'utf8');
  assert.match(runnerSrc, /fieldUnits\(fieldId = null\)/, 'battleRunner.fieldUnits() is the tap the plugin reads');
  // 回合结束判定依赖 runner 暴露的 `done`：没有它，「第一回合结束就看到记录」又要等下一场开始
  assert.match(runnerSrc, /done: !!e\.done/, 'fieldUnits() exposes the battle’s finished flag');
  assert.match(runnerSrc, /return \{ battleId: null, fieldId: null, kind: null, time: 0, done: false, units: \[\] \}/, 'the no-battle shape carries done: false');
  const coreSrc = fs.readFileSync(path.join(ROOT, PLUGIN, 'plugin.js'), 'utf8');
  assert.match(coreSrc, /runner\.fieldUnits\(fid\)/, 'the panel polls fieldUnits itself (no field event dependency)');
  assert.match(coreSrc, /stepRound\(/, 'the round state machine (dps-core.stepRound) decides when a round closes');
  // 新一局开始要清窗口：订阅 store 的「进入对局」跳变，并丢弃上一局残留的每回合状态
  assert.match(coreSrc, /store\.subscribe\(/, 'the plugin subscribes to the app store for the new-match transition');
  assert.match(coreSrc, /matchActive\(/, 'it uses the shared “is a match on screen” rule');
  assert.match(coreSrc, /key=\$\{gen\}/, 'the panel is remounted on a new match, so its history/rows reset');
  // 关窗只隐藏、不卸载：卸载会把这局的 history / 采样 / 回合状态一起丢掉（用户报的 bug）
  assert.match(coreSrc, /hidden=\$\{!open\}/, 'closing the panel hides it instead of unmounting it');
  assert.match(coreSrc, /cx\('dpsm', hidden && 'is-hidden'\)/, 'the hidden state is a CSS class on the same section');
  assert.ok(!/open \? html`<\$\{DpsPanel\}/.test(coreSrc), 'the panel must not be unmounted when closed');
  // 这个插件只做悬浮窗：战后曲线与每局存档都是 plugins/match-charts 的事
  assert.ok(!/mountResultButton|createRecorder/.test(coreSrc), 'the panel plugin does not mount the result-screen chart');
  assert.ok(!/serializeLatest|readLatest|LATEST_KEY/.test(coreSrc), 'and does not persist per-round history');
  assert.ok(/setInterval\(probe, 500\)/.test(coreSrc), 'the toggle detects a battle by polling, not by a one-shot event');
  // 需求：面板不随战斗结束自动关闭（玩家自己开关），位置在左下角
  assert.ok(!/if \(!live\) setOpen\(false\)/.test(coreSrc), 'the panel must stay open when the battle ends');
  assert.match(coreSrc, /\{ left: 18, bottom: 92 \}/, 'the panel defaults to the bottom-left corner');
  const css = fs.readFileSync(path.join(ROOT, PLUGIN, 'plugin.css'), 'utf8');
  assert.match(css, /\.dpsm-toggle \{[^}]*left: 14px[^}]*bottom: 106px/, 'the toggle sits at the bottom-left');
  assert.ok(!/\.dpsm-toggle \{[^}]*right:/.test(css), 'and not on the right any more');
});

test('every import the plugin makes resolves to a URL the static server serves (the 404 that killed it once)', async () => {
  const dir = path.join(ROOT, PLUGIN);
  const files = [path.join(dir, 'plugin.js'), path.join(dir, 'dps-core.js')];
  const checked = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)) {
      const spec = m[1];
      if (spec.startsWith('./') || spec.startsWith('../')) {
        // a relative specifier from /plugins/<id>/<file> must stay inside the plugin folder
        assert.ok(!spec.includes('public/'), `${path.basename(file)}: "${spec}" would resolve to /public/… which the server does not serve`);
        const abs = path.resolve(path.dirname(file), spec);
        assert.ok(fs.existsSync(abs), `${path.basename(file)}: ${spec} exists`);
        checked.push(spec);
        continue;
      }
      assert.ok(spec.startsWith('/'), `${path.basename(file)}: "${spec}" must be a site-absolute path`);
      const rel = repoPathOf(spec);
      assert.ok(rel, `${path.basename(file)}: "${spec}" is not one of the served mounts (/vendor /js /data /shared)`);
      assert.ok(fs.existsSync(path.join(ROOT, rel)), `${path.basename(file)}: ${spec} → ${rel} exists`);
      checked.push(spec);
    }
  }
  assert.ok(checked.includes('/vendor/preact.module.js') && checked.includes('/js/ui/components.js'), `the plugin imports the app’s own modules via site paths (${checked.join(', ')})`);
});

test('the plugin’s own i18n files are well-formed and cover the strings the UI asks for', async () => {  const dir = path.join(ROOT, PLUGIN, 'i18n');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 4, 'at least the four shipped languages');
  for (const f of files) {
    const dict = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    assert.equal(typeof dict['战斗统计'], 'string', `${f}: 战斗统计`);
    assert.equal(typeof dict['当前战场'], 'string', `${f}: 当前战场`);
    assert.equal(typeof dict['全部战场'], 'string', `${f}: 全部战场`);
    assert.equal(typeof dict['治疗'], 'string', `${f}: 治疗`);
  }
  // every msgid the plugin asks for must be in every pack — plugin.js uses `api.t(…)`
  const srcs = fs.readFileSync(path.join(ROOT, PLUGIN, 'plugin.js'), 'utf8');
  const ids = new Set([...srcs.matchAll(/(?:api\.t|\bt)\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]));
  assert.ok(ids.size > 0);
  for (const f of files) {
    const dict = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const id of ids) assert.equal(typeof dict[id], 'string', `${f} is missing "${id}"`);
  }
});
