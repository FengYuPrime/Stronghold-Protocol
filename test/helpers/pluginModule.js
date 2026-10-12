// 插件契约测试的共享工具：最小 DOM 打桩 + `api` 替身 + 「按浏览器的方式加载插件模块」。
//
// 插件在浏览器里是 `/plugins/<id>/plugin.js` 这样的 ES 模块，import 用的是**站点绝对路径**（`/vendor/…`、`/js/…`）。
// Node 里解析不了这种路径，所以这里把它改写成仓库内的相对路径、写到插件目录下的临时 `.entry.test.mjs` 再 import。
// **这个改写本身就是被测契约**：插件必须用站点挂载，不能写 `../../public/…`（静态服务器会 404，当年就是这么挂的）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Where a site-absolute mount lives in the repository: /vendor and /js under public/, /data and /shared at the root. */
export const SITE_MOUNTS = Object.freeze({ vendor: 'public', js: 'public', data: '', shared: '' });

/** The repo-relative path behind a site-absolute URL (`/vendor/x` → `public/vendor/x`), or null. */
export function repoPathOf(url) {
  const m = /^\/([a-z]+)\/(.+)$/.exec(url);
  if (!m) return null;
  const [mount, rest] = [m[1], m[2]];
  if (!(mount in SITE_MOUNTS)) return null;
  return path.join(SITE_MOUNTS[mount], mount, rest);
}

/** The least DOM a plugin touches: createElement / head / body / localStorage / timers / window size. */
export function stubDom() {
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
  // 插件用 rAF 轮询自己重画；测试里不跑它（否则会一直自我重排，进程结束不了）
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};
}

/**
 * The api object public/js/plugins.js hands a plugin.
 * @param {{ id: string, files?: Record<string, string> }} o
 */
export function stubApi({ id, files = {} } = { id: 'test' }) {
  const links = [];
  // 应用 store 的最小替身：插件会订阅它来侦测「新一局开始」（matchActive 的 false→true 跳变）
  const listeners = new Set();
  let state = { match: { public: { phase: 'LOBBY', round: 0 }, result: null } };
  return {
    id,
    manifest: { files },
    t: (s) => s,
    N_: (s) => s,
    log() {}, warn() {},
    loadCss: () => { const l = { rel: 'stylesheet', href: `/plugins/${id}/plugin.css`, dataset: {}, remove() {} }; links.push(l); return l; },
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

/** Temp module copies of the last loadModule() call (removed again right after the import). */
const tempFiles = [];

/**
 * Load one plugin module the way the browser would, but with Node able to resolve it.
 * @param {string} pluginDir repo-relative, e.g. 'plugins/dps-meter'
 * @param {'plugin'|'chart'|'panel'} which which module to import
 * @param {string[]} deps the plugin's own sibling modules
 * @returns {Promise<any>} the imported module
 */
export async function loadModule(pluginDir, which, deps = []) {
  const dir = path.join(ROOT, pluginDir);
  if (tempFiles.length) for (const t of tempFiles) fs.rmSync(t, { force: true });
  tempFiles.length = 0;
  const rewrite = (src) => src.replace(/(['"])(\/(?:vendor|js|data|shared)\/[^'"]+)\1/g, (_, q, url) => {
    const rel = repoPathOf(url);
    return `${q}${path.relative(dir, path.join(ROOT, rel)).split(path.sep).join('/')}${q}`;
  });
  for (const file of [...deps, 'plugin.js']) {
    if (!fs.existsSync(path.join(dir, file))) continue;
    let src = rewrite(fs.readFileSync(path.join(dir, file), 'utf8'));
    // 相对模块改指向临时副本（Node 解析得到），其余相对路径不动
    for (const dep of deps) {
      const stem = path.basename(dep, '.js');
      src = src.replace(new RegExp(`(['"])\\./${dep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1`, 'g'), (_, q) => `${q}./${stem}.entry.test.mjs${q}`);
    }
    const tmp = path.join(dir, `${path.basename(file, '.js')}.entry.test.mjs`);
    fs.writeFileSync(tmp, src);
    tempFiles.push(tmp);
  }
  const mod = await import(`../../${pluginDir}/${which}.entry.test.mjs`).finally(() => {
    // 成功或抛错都要清掉临时模块（抛错时留下残骸会污染插件目录）
    for (const t of tempFiles) fs.rmSync(t, { force: true });
    tempFiles.length = 0;
  });
  return mod;
}

/**
 * Every import specifier in a plugin file, checked against the served mounts (the 404 that killed the plugin once).
 * @param {string} pluginDir @param {string} file
 */
export function checkImports(pluginDir, file) {
  const abs = path.join(ROOT, pluginDir, file);
  const src = fs.readFileSync(abs, 'utf8');
  const checked = [];
  for (const m of src.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)) {
    const spec = m[1];
    if (spec.startsWith('./') || spec.startsWith('../')) {
      if (spec.includes('public/')) throw new Error(`${file}: "${spec}" 会解析成 /public/…，静态服务器不服务它`);
      if (!fs.existsSync(path.resolve(path.dirname(abs), spec))) throw new Error(`${file}: ${spec} 不存在`);
      checked.push(spec);
      continue;
    }
    if (!spec.startsWith('/')) throw new Error(`${file}: "${spec}" 必须是站点绝对路径`);
    const rel = repoPathOf(spec);
    if (!rel) throw new Error(`${file}: "${spec}" 不在服务挂载点里（/vendor /js /data /shared）`);
    if (!fs.existsSync(path.join(ROOT, rel))) throw new Error(`${file}: ${spec} → ${rel} 不存在`);
    checked.push(spec);
  }
  return checked;
}
