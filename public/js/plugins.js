// public/js/plugins.js — the optional plugins of this server (docs/PLUGINS.md).
//
// The server lists the folders it has (`GET /plugins/index.json`, server/plugins.js) and serves the files their
// manifests name; this module is the client half: it fetches that index once the app is up, imports each plugin's
// entry as an ES module and calls its default export with the `api` below. A plugin that throws, fails to load or
// returns junk is reported and skipped — the app never breaks because of one.
//
// What a plugin gets (and nothing else — the core stays unaware of what plugins do):
//
//   api = {
//     id, manifest,            // who it is
//     store, net, data,        // the app's singletons (the same objects main.js exposes as globalThis.__SP__)
//     runner,                  // the battle runner (public/js/battle/runner.js) or null outside a browser
//     t, N_,                   // shared/i18n.js (a plugin may carry its own i18n/<code>.json and register it)
//     mount(node, props?),     // render a Preact element into a container the loader owns and removes with the plugin
//     on(type, fn),            // app lifecycle: 'ready' (once, now), 'field' ({ fieldId, phase }|{ fieldId: null }),
//                              // 'phase' (the match phase), 'dispose' (the plugin is being unloaded)
//     loadCss(url),            // inject a stylesheet (a file the manifest names), removed on dispose
//     log, warn,               // prefixed console
//   }
//
// A plugin's default export may return `{ dispose() }`; the loader calls it on unload, removes the containers and
// the stylesheets it handed out, so unload leaves nothing behind.

import { render } from '../vendor/preact.module.js';
import { store } from './store.js';
import { data } from './data.js';
import { t, N_, addMessages, getLang } from '../../shared/i18n.js';

/** Where the server publishes its plugin folders. */
export const PLUGINS_INDEX_URL = '/plugins/index.json';

/** Every plugin currently loaded: `{ id, manifest, api, dispose, containers, styles }`. */
export const loadedPlugins = new Map();

const log = (...a) => console.info('[plugin]', ...a);
const warn = (...a) => console.warn('[plugin]', ...a);

/**
 * Create the `api` one plugin runs with.
 * @param {{ id: string, manifest: any, entry: () => any }} ctx
 */
function makeApi({ id, manifest, hub, fetchImpl = globalThis.fetch }) {
  const containers = [];
  const styles = [];
  const api = {
    id,
    manifest,
    store,
    net: globalThis.__SP__?.net || null,
    data,
    /** The battle runner (public/js/battle/runner.js), or null outside a browser — read lazily: it is created after this module. */
    get runner() { return hub.runner; },
    t,
    N_,
    log: (...a) => log(`[${id}]`, ...a),
    warn: (...a) => warn(`[${id}]`, ...a),
    /**
     * Render a Preact element into a container appended to `parent` (default: document.body).
     * @param {any} node @param {{ parent?: HTMLElement, className?: string }} [opts]
     * @returns {HTMLElement} the container
     */
    mount(node, opts = {}) {
      const el = document.createElement('div');
      el.dataset.plugin = id;
      el.className = opts.className || `plugin-${id}`;
      (opts.parent || document.body).appendChild(el);
      containers.push(el);
      render(node, el);
      return el;
    },
    /** Inject a stylesheet from a file the manifest names (`files.css`); returns its <link>. */
    loadCss(rel = null) {
      const url = rel || manifest.files?.css;
      if (!url) return null;
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = url;
      link.dataset.plugin = id;
      document.head.appendChild(link);
      styles.push(link);
      return link;
    },
    on(type, fn) { return hub.on(type, fn); },
    /**
     * Load this plugin's own translations and register them with shared/i18n.js — so `api.t('…')` speaks the
     * player's language without a single key in the app's own packs (an unknown msgid falls back to itself, which
     * is the source language). `files.i18n` is a folder the manifest names; a missing file is not an error. Safe to
     * call again on a language change (messages are merged per language).
     * @param {{ lang?: string, folder?: string }} [opts]
     * @returns {Promise<number>} how many entries were added
     */
    async i18n({ lang = getLang(), folder = null } = {}) {
      const base = folder || manifest.files?.i18n || null;
      if (!base) return 0;
      const url = base.endsWith('/') ? `${base}${lang}.json` : `${base}/${lang}.json`;
      try {
        const res = await fetchImpl(url, { headers: { accept: 'application/json' } });        if (!res.ok) return 0;
        const dict = await res.json();
        return addMessages(lang, dict);
      } catch (e) {
        warn(`[${id}] i18n ${url} unreadable (${e?.message || e})`);
        return 0;
      }
    },
  };
  api.dispose = () => {
    for (const el of containers) { try { render(null, el); el.remove(); } catch { /* ignore */ } }
    for (const link of styles) { try { link.remove(); } catch { /* ignore */ } }
  };
  return api;
}

/**
 * The tiny lifecycle bus plugins subscribe to.
 *
 * The core only pushes three things into it — the app is ready, the battle on screen changed, the match phase changed
 * (main.js `installPlugins`) — and the loader forwards them to the plugins. A plugin that needs more polls the app's
 * own stores (`api.store`) or the runner, which is what keeps this hook surface small.
 */
export function createPluginHub({ getRunner = () => globalThis.__SP_RUNNER__ || null } = {}) {
  const byType = new Map();
  return {
    /** The battle runner of this page, or null (it is created after this module). */
    get runner() { return getRunner(); },
    on(type, fn) {
      if (typeof fn !== 'function') return () => {};
      if (!byType.has(type)) byType.set(type, new Set());
      byType.get(type).add(fn);
      return () => byType.get(type)?.delete(fn);
    },
    emit(type, payload) {
      for (const fn of [...(byType.get(type) || [])]) {
        try { fn(payload); } catch (e) { warn(`listener of "${type}" threw`, e); }
      }
    },
  };
}

/**
 * Fetch the index and load every plugin it lists, then keep the `field` event flowing (the battle on screen changed
 * — its fieldId, or null when none is on screen, read from the runner's own frame stream). Resolves to the loaded
 * ids; never rejects.
 * @param {{ hub?: ReturnType<typeof createPluginHub>, url?: string, fetchImpl?: typeof fetch, watchFields?: boolean }} [opts]
 * @returns {Promise<string[]>}
 */
export async function installPlugins({ hub = createPluginHub(), url = PLUGINS_INDEX_URL, fetchImpl = globalThis.fetch, watchFields = true } = {}) {
  let index;
  try {
    const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
    if (!res.ok) { if (res.status !== 404) warn(`index ${url} answered ${res.status}`); return []; }
    index = await res.json();
  } catch (e) {
    warn(`index ${url} unreadable (${e?.message || e})`);
    return [];
  }
  if (watchFields) watchFieldChanges(hub);
  const entries = Array.isArray(index?.plugins) ? index.plugins : [];
  if (!entries.length) return [];
  const ids = [];
  for (const entry of entries) {
    if (!entry || typeof entry.entry !== 'string' || typeof entry.id !== 'string') { warn('index entry without id/entry', entry); continue; }
    try {
      const mod = await import(/* @vite-ignore */ entry.entry);
      const register = typeof mod.default === 'function' ? mod.default : (typeof mod.register === 'function' ? mod.register : null);
      if (!register) { warn(`${entry.id}: entry has no default export function`); continue; }
      const api = makeApi({ id: entry.id, manifest: entry, hub, fetchImpl });
      const result = await register(api);
      loadedPlugins.set(entry.id, { id: entry.id, manifest: entry, api, dispose: typeof result?.dispose === 'function' ? result.dispose : null });
      ids.push(entry.id);
      log(`loaded ${entry.id} v${entry.version || '?'}${entry.compatible === false ? ' (made for another version)' : ''}`);
    } catch (e) {
      warn(`${entry.id} failed to load`, e);
    }
  }
  hub.emit('ready', { ids });
  return ids;
}

/**
 * The `field` event: the fieldId of the battle on screen whenever it changes (null = none). The runner already emits
 * its own `field` (show/clear); a 1 s poll covers the cases it does not announce, so this needs no core change
 * beyond the runner's public surface.
 */
export function watchFieldChanges(hub) {
  let last = undefined;
  const poke = () => {
    const cur = hub.runner?.currentBattle?.() || null;
    const fieldId = cur ? cur.fieldId : null;
    if (fieldId === last) return;
    last = fieldId;
    hub.emit('field', { fieldId, kind: cur ? cur.kind : null });
  };
  const off = hub.runner?.on?.('field', poke) || (() => {});
  const timer = globalThis.setInterval ? globalThis.setInterval(poke, 1000) : null;
  return () => {
    off();
    if (timer != null) globalThis.clearInterval(timer);
  };
}

/** Unload every plugin (dispose, containers, stylesheets) — used by tests and a future 重新加载入口. */
export function disposePlugins() {
  for (const [id, p] of loadedPlugins) {
    try { p.dispose?.(); } catch (e) { warn(`${id} dispose threw`, e); }
    try { p.api.dispose(); } catch { /* ignore */ }
  }
  loadedPlugins.clear();
}
