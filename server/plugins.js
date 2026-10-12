// server/plugins.js — the optional plugins a server may drop into plugins/<id>/ (docs/PLUGINS.md).
//
// A plugin is one folder with a manifest (`plugin.json`) and its own files, loaded by the browser *after* the app
// starts: the server never runs plugin code, it only lists the folders and serves the files their manifests name
// (`GET /plugins/index.json`, `GET /plugins/<id>/<file>`). That is what makes a plugin additive — installing it is
// dropping a folder in, removing it is deleting the folder (or the whole `plugins/` directory) — while the core
// keeps exactly three touch points: this registry, its two static routes and one call in public/js/main.js.
//
// The shape follows the content packs (server/packs.js, docs/PACKS.md) on purpose: same scan-once-then-recheck-on-
// change model, same "only a file the manifest names is servable" rule, same warnings instead of failures.
//
// A broken plugin never breaks the server: it is skipped with a warning and left out of the index.

import fs from 'node:fs';
import path from 'node:path';
import { APP_VERSION } from '../shared/constants.js';
import { appVersionMatches } from '../shared/packs.js';

/** The plugin folders' directory, under the project root. */
export const PLUGINS_DIR = 'plugins';
/** The manifest of a plugin folder. */
export const PLUGIN_MANIFEST = 'plugin.json';
/** The index the browser reads (GET /plugins/index.json). */
export const PLUGIN_INDEX_FILE = 'index.json';
/** The URL prefix the browser loads a plugin from. */
export const PLUGINS_URL = '/plugins/';
/** The only files a plugin folder may serve, by extension (ES modules, styles, text). */
export const PLUGIN_EXT = Object.freeze(['.js', '.mjs', '.css', '.json', '.txt', '.md']);
/** Largest manifest / file read into memory (bytes). */
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const noop = () => {};

const sizeOf = (abs) => { try { return fs.statSync(abs).size; } catch { return 0; } };
const readDirSorted = (dir) => { try { return fs.readdirSync(dir).filter((n) => !n.startsWith('.')).sort(); } catch { return []; } };

/** A plugin id: letters, digits, `.`, `_`, `-` (the pack rule, shared/packs.js isPackId). */
export const isPluginId = (v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v);

/**
 * A path inside a plugin folder: relative, no `..`, allowed characters and a serveable extension. A plain name (no
 * slash, no extension) is allowed too — `files.i18n: "i18n"` names a FOLDER whose files the scan expands (that is how
 * a plugin ships its own `i18n/<lang>.json` without listing every language).
 */
export function isPluginPath(rel) {
  if (typeof rel !== 'string' || !rel.length || rel.length > 200) return false;
  if (rel.startsWith('/') || rel.includes('..') || rel.includes('\\') || rel.includes('\0')) return false;
  if (!/^[A-Za-z0-9._ -]+(?:\/[A-Za-z0-9._ -]+)*$/.test(rel)) return false;
  if (!rel.includes('.')) return !rel.includes('/'); // a folder name: no dots, no nesting
  return PLUGIN_EXT.includes(path.extname(rel).toLowerCase());
}

/** Every file under a plugin folder, as forward-slash paths relative to it (depth-limited, served extensions only). */
function listPluginFiles(dir, base = dir, depth = 2, out = []) {
  if (depth < 0) return out;
  for (const name of readDirSorted(dir)) {
    const abs = path.join(dir, name);
    const st = (() => { try { return fs.statSync(abs); } catch { return null; } })();
    if (!st) continue;
    if (st.isDirectory()) listPluginFiles(abs, base, depth - 1, out);
    else if (st.isFile() && PLUGIN_EXT.includes(path.extname(name).toLowerCase())) out.push(path.relative(base, abs).split(path.sep).join('/'));
  }
  return out;
}

/** Whether `abs` is inside `dir` once symbolic links are resolved (a plugin file never leads out of its folder). */
function inside(dir, abs) {
  try { return fs.realpathSync(abs).startsWith(fs.realpathSync(dir) + path.sep); } catch { return false; }
}

const urlOf = (id, rel) => `${PLUGINS_URL}${encodeURIComponent(id)}/${rel.split('/').map(encodeURIComponent).join('/')}`;

/**
 * Validate one manifest (the fields a plugin needs; unknown fields are ignored and reported as warnings).
 * @param {any} raw @param {{ id: string, app?: string }} ctx
 * @returns {{ manifest: any|null, problems: string[], warnings: string[] }}
 */
export function normalizePluginManifest(raw, { id, app = APP_VERSION } = /** @type {any} */ ({})) {  const problems = [];
  const warnings = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { manifest: null, problems: ['manifest is not an object'], warnings };
  if (raw.type !== undefined && raw.type !== 'plugin') problems.push(`type must be "plugin" (got ${JSON.stringify(raw.type)})`);
  if (raw.id !== undefined && raw.id !== id) warnings.push(`id "${raw.id}" is ignored: the folder name "${id}" decides`);
  for (const k of ['name', 'version', 'entry']) {
    if (typeof raw[k] !== 'string' || !raw[k].trim()) problems.push(`${k} is required`);
  }
  if (raw.version !== undefined && typeof raw.version === 'string' && !/^\d+\.\d+\.\d+/.test(raw.version)) warnings.push(`version "${raw.version}" does not look like 1.2.3`);
  if (raw.app !== undefined && typeof raw.app !== 'string') problems.push('app must be a string (a version range, e.g. ">=0.2.4")');
  if (raw.entry !== undefined && !isPluginPath(raw.entry)) problems.push(`entry "${raw.entry}" is not a path a plugin may serve (${PLUGIN_EXT.join(' ')})`);
  const files = raw.files === undefined ? {} : raw.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) problems.push('files must be an object of role → path');
  else {
    for (const [role, rel] of Object.entries(files)) {
      if (!isPluginPath(rel)) problems.push(`files.${role}: "${rel}" is not a path a plugin may serve`);
    }
  }
  if (problems.length) return { manifest: null, problems, warnings };
  const manifest = {
    id,
    type: 'plugin',
    name: String(raw.name).trim(),
    version: String(raw.version).trim(),
    app: typeof raw.app === 'string' && raw.app.trim() ? raw.app.trim() : '*',
    entry: raw.entry,
    files: { ...files },
    description: typeof raw.description === 'string' ? raw.description : '',
    authors: Array.isArray(raw.authors) ? raw.authors.filter((a) => typeof a === 'string') : [],
    license: typeof raw.license === 'string' ? raw.license : '',
    ui: raw.ui === true,
  };
  if (!appVersionMatches(manifest.app, app)) warnings.push(`made for "${manifest.app}", this server is ${app} — loaded anyway`);
  return { manifest, problems, warnings };
}

/**
 * Scan the plugin folders once.
 * @param {{ pluginsDir: string }} dirs
 * @param {{ app?: string }} [opts]
 * @returns {{ plugins: any[], skipped: { where: string, problems: string[] }[], warnings: { where: string, warning: string }[] }}
 */
export function scanPlugins({ pluginsDir }, { app = APP_VERSION } = {}) {
  const found = [];
  const skipped = [];
  const warnings = [];
  const seen = new Set();
  for (const name of readDirSorted(pluginsDir)) {
    const where = `${PLUGINS_DIR}/${name}`;
    const dir = path.join(pluginsDir, name);
    try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
    if (!isPluginId(name)) { skipped.push({ where, problems: ['not a plugin id (letters, digits, . _ -, up to 64)'] }); continue; }
    const key = name.toLowerCase();
    if (seen.has(key)) { skipped.push({ where, problems: ['the id is already taken (ids compare without case)'] }); continue; }
    seen.add(key);
    const manifestPath = path.join(dir, PLUGIN_MANIFEST);
    if (sizeOf(manifestPath) === 0) { skipped.push({ where, problems: [`no ${PLUGIN_MANIFEST}`] }); continue; }
    let raw;
    try {
      const st = fs.statSync(manifestPath);
      if (st.size > MAX_TEXT_BYTES) throw new Error(`manifest larger than ${MAX_TEXT_BYTES >> 20} MB`);
      raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (e) {
      skipped.push({ where, problems: [`manifest unreadable: ${e instanceof SyntaxError ? 'not valid JSON' : String(e?.code || e?.message || e)}`] });
      continue;
    }
    const { manifest, problems, warnings: warns } = normalizePluginManifest(raw, { id: name, app });
    for (const w of warns) warnings.push({ where, warning: w });
    if (!manifest) { skipped.push({ where, problems }); continue; }
    // every file the manifest names must exist (and stay inside the folder); a plain folder name (`i18n`) expands
    const files = {};
    const missing = [];
    for (const [role, rel] of Object.entries({ entry: manifest.entry, ...manifest.files })) {
      const abs = path.join(dir, rel);
      const st = (() => { try { return fs.statSync(abs); } catch { return null; } })();
      if (!st) { missing.push(`files.${role}: ${rel} is missing`); continue; }
      if (st.isDirectory()) {
        const inner = listPluginFiles(abs);
        if (!inner.length) { missing.push(`files.${role}: ${rel}/ holds no serveable file`); continue; }
        for (const f of inner) files[`${role}/${f}`] = { rel: `${rel}/${f}`, abs: path.join(abs, f), url: urlOf(name, `${rel}/${f}`), dir: rel };
        continue;
      }
      if (!inside(dir, abs)) { missing.push(`files.${role}: ${rel} is outside the folder`); continue; }
      files[role] = { rel, abs, url: urlOf(name, rel) };
    }
    if (missing.length) { skipped.push({ where, problems: missing }); continue; }
    const compatible = appVersionMatches(manifest.app, app);
    found.push({ ...manifest, where, dir, compatible, files, warnings: warns, index: 0 });
  }
  // a stable order: by name, then by id
  found.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  found.forEach((p, i) => { p.index = i; });
  return { plugins: found, skipped, warnings };
}

/** The index body (GET /plugins/index.json): what the browser loads, never the absolute paths. */
export function pluginIndex(plugins, { app = APP_VERSION } = {}) {
  return {
    version: 1,
    app,
    plugins: plugins.map((p) => ({
      id: p.id,
      name: p.name,
      version: p.version,
      app: p.app,
      description: p.description || undefined,
      authors: p.authors.length ? p.authors : undefined,
      license: p.license || undefined,
      ui: p.ui || undefined,
      compatible: p.compatible ? undefined : false,
      entry: p.files.entry.url,
      files: Object.fromEntries(Object.entries(p.files).filter(([role]) => role !== 'entry').map(([role, f]) => [role, f.url])),
    })),
  };
}

/** A fingerprint of the folders + manifests, so a scan is only redone when something changed. */
function signature({ pluginsDir }) {
  const parts = [];
  const add = (abs, depth, tag) => {
    const st = (() => { try { return fs.statSync(abs); } catch { return null; } })();
    parts.push(`${tag}${abs}:${st ? `${st.size}:${Math.floor(st.mtimeMs)}` : 'x'}`);
    if (depth <= 0 || !st || !st.isDirectory()) return;
    for (const name of readDirSorted(abs)) add(path.join(abs, name), depth - 1, `${tag}.`);
  };
  add(pluginsDir, 2, 'p:');
  return parts.join('|');
}

/**
 * The registry: the scan, re-done when the folders change.
 * @param {{ pluginsDir: string }} dirs
 * @param {{ log?: { info: Function, warn: Function }, app?: string, recheckMs?: number }} [opts]
 *   recheckMs: how long a scan stays trusted before the folders are looked at again (default 1000; 0 = every call)
 */
export function createPluginRegistry(dirs, { log = { info: noop, warn: noop }, app = APP_VERSION, recheckMs = 1000 } = {}) {
  let sig = null;
  let checkedAt = -Infinity;
  let state = null;
  const told = new Set();
  const tell = (fn, line) => { if (!told.has(line)) { told.add(line); fn(line); } };

  function refresh(force = false) {
    const now = Date.now();
    if (state && !force && now - checkedAt < recheckMs) return state;
    checkedAt = now;
    const s = signature(dirs);
    if (state && s === sig) return state;
    const first = !state;
    sig = s;
    const scan = scanPlugins(dirs, { app });
    state = { ...scan, index: pluginIndex(scan.plugins, { app }), byId: new Map(scan.plugins.map((p) => [p.id, p])) };
    const line = `[plugins] ${scan.plugins.length ? scan.plugins.map((p) => `${p.id} (${p.name})`).join(', ') : 'none'}`;
    if (first || scan.plugins.length) tell((m) => log.info(m), line);
    for (const k of scan.skipped) tell((m) => log.warn(m), `[plugins] ${k.where} skipped: ${k.problems.join('; ')}`);
    for (const w of scan.warnings) tell((m) => log.warn(m), `[plugins] ${w.where}: ${w.warning}`);
    return state;
  }

  return {
    /** Re-read the folders now if they changed (force: even within recheckMs). */
    refresh: (force = false) => { refresh(force); },
    /** The loaded plugins. @returns {any[]} */
    list: () => refresh().plugins,
    /** The index body (GET /plugins/index.json). */
    index: () => refresh().index,
    /** Plugins that were not loaded and why, and the warnings of the loaded ones. */
    report: () => { const s = refresh(); return { skipped: s.skipped, warnings: s.warnings }; },
    /**
     * The file behind /plugins/<id>/<rel>, or null: only a file a manifest names.
     * @param {string} id @param {string} rel
     */
    servable(id, rel) {
      const p = refresh().byId.get(id);
      if (!p) return null;
      for (const f of Object.values(p.files)) if (f.rel === rel) return f.abs;
      return null;
    },
  };
}
