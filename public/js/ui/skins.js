// 干员换装（皮肤）状态与同步 —— 干员调配详情页的「换装」区块。
//
// 两件事分开放，这是「素材缺失也能用」的关键：
//
//   * 目录（data/skins.json）—— 本项目认识的全部皮肤：id、名称、系列。**不含任何 URL**：一套没有下载模型的皮肤
//     没有文件可指。
//   * 已安装（data/assets.json 的 chars[charId].skins）—— 这台服务器上真有模型/头像的皮肤。渲染时以它为准
//     （public/js/assets.js spineEntry / avatarUrl），缺文件就回退到干员自己的模型，不会 404 出一片空白。
//
// 选择本身是一个朴素的 `{ [chessId]: skinId }` 映射，按浏览器存在 localStorage，并通过 `room.skins` 同步到服务端。
// 与干员调配不同的两点：条目按 **chessId** 存（目录与清单按 **干员 id** 分组），而且它是**公开**的 —— 服务端会放进
// `Match.publicView().players[]`，队友看得到你的棋子穿的是哪套。

import { createStore, loadPref, savePref } from '../store.js';
import { data } from '../data.js';
import { isSkinId } from '../../../shared/protocol.js';
import { t } from '../../../shared/i18n.js';

export const SKINS_PREF = 'skins';
export const SYNC_DEBOUNCE_MS = 500;
export const RETRY_MS = 1500;

/**
 * 换装的现场排查开关：控制台执行 `__SP_DEBUG_SKINS__(true)`（或在页面加载前设
 * `globalThis.__SP_DEBUG_SKINS__ = true`）后，选择/同步/服务端回执/渲染取用都会打日志，前缀 `[skins]`。
 * 默认关闭，所以正常游玩时不会刷屏。
 */
const DEBUG = () => globalThis.__SP_DEBUG_SKINS__ === true;
globalThis.__SP_DEBUG_SKINS__ = () => { globalThis.__SP_DEBUG_SKINS__ = true; console.info('[skins] 调试日志已打开'); };
export const debugLog = (...a) => { if (DEBUG()) console.info('[skins]', ...a); };

function readStored() {
  const raw = loadPref(SKINS_PREF, null);
  const out = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [chessId, skinId] of Object.entries(raw)) {
      if (typeof chessId === 'string' && chessId && isSkinId(skinId)) out[chessId] = skinId;
    }
  }
  return out;
}

/** The chosen outfits (per browser) and this selection's sync state — kept apart from the app store, like the loadout. */
export const skinsStore = createStore({ entries: readStored(), sync: 'idle' });

/** Replace the whole selection (persisted at once; the sync picks the change up). */
export function setSkins(entries) {
  const next = {};
  for (const [chessId, skinId] of Object.entries(entries && typeof entries === 'object' ? entries : {})) {
    if (typeof chessId === 'string' && chessId && isSkinId(skinId)) next[chessId] = skinId;
  }
  savePref(SKINS_PREF, next);
  skinsStore.set({ entries: next });
}

/** Choose a skin for one chess (the operator goes back to its default model with `clearSkin`). */
export function setSkin(chessId, skinId) {
  debugLog('setSkin', chessId, skinId);
  if (skinId) setSkins({ ...skinsStore.get().entries, [chessId]: skinId });
  else clearSkin(chessId);
}

/** Drop one chess's choice (it goes back to the operator's default model). */
export function clearSkin(chessId) {
  const next = { ...skinsStore.get().entries };
  delete next[chessId];
  setSkins(next);
}

/** The skin this browser picked for a chess, or null. Also the renderer's lookup for a piece without an own choice. */
export const skinFor = (chessId) => (chessId ? skinsStore.get().entries[chessId] || null : null);

/** How many outfits are chosen (the 干员调配 header count). */
export const skinCount = () => Object.keys(skinsStore.get().entries).length;

/**
 * Every skin of an operator (the catalogue).
 *
 * Takes the OPERATOR id (`char_498_inside`), not the chess id (`chess_char_1_01_a`): both data/skins.json and
 * data/assets.json are grouped per operator, while a skin *choice* is stored per chess — see ui/skinPicker.js.
 * @param {string} charId
 * @returns {{ id: string, name: string, group: string, installed: boolean }[]}
 */
export function availableSkins(charId) {
  const list = data.get('skins')?.chars?.[charId];
  if (!Array.isArray(list) || !list.length) return [];
  return list.map((s) => ({ id: s.id, name: s.name, group: s.group || '', installed: hasSkinFiles(charId, s.id) }));
}

/** Whether this install has the files of a skin: a spine block in the manifest (its avatar alone is not enough). */
export function hasSkinFiles(charId, skinId) {
  const rec = data.get('assets')?.chars?.[charId]?.skins?.[skinId];
  return !!(rec && rec.spine);
}

/** Load what the picker needs (the catalogue and the manifest that says which models are on disk). */
export function loadSkinData() {
  data.load('skins').catch(() => {});
  data.load('assets').catch(() => {});
}

/** The status line of the 换装 block: '' = nothing to say. */
export const skinSyncText = (sync) => ({ idle: '', pending: '', sending: t('同步中…'), synced: t('已同步'), error: t('同步失败') }[sync] || '');

/**
 * Keep the server's copy of this browser's skins current (`room.skins`), like installLoadoutSync but without the
 * sanitising: the loadout has to be checked against data/chess.json before it is sent (a stale entry would be dropped
 * by the server anyway), whereas a skinId needs no lookup — the server keeps the entries whose chess it recognises
 * and drops the rest, and an unknown skinId is harmless (the renderer falls back).
 * @param {{ net: any, timers?: { setTimeout: Function, clearTimeout: Function } }} deps
 * @returns {{ flush: () => Promise<void>, dispose: () => void }}
 */
export function installSkinsSync({ net, timers } = {}) {
  const T = timers || { setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: (id) => globalThis.clearTimeout(id) };
  let timer = null;
  let seq = 0;
  let pendingJson = null;
  let lastSent = null;
  let disposed = false;

  const setState = (sync) => { if (skinsStore.get().sync !== sync) skinsStore.set({ sync }); };
  const schedule = (ms = SYNC_DEBOUNCE_MS) => {
    if (disposed) return;
    T.clearTimeout(timer);
    setState('pending');
    timer = T.setTimeout(() => { timer = null; void flush(); }, ms);
  };

  async function flush() {
    if (disposed || net.status !== 'online') { setState('idle'); return; }
    try {
      const skins = skinsStore.get().entries;
      const json = JSON.stringify(skins);
      if (json === pendingJson) return;
      if (json === lastSent && pendingJson == null) { setState('synced'); return; }
      const my = ++seq;
      pendingJson = json;
      setState('sending');
      debugLog('→ room.skins', json, '(在线:', net.status, ')');
      try {
        await net.request('room.skins', { skins });
        if (my !== seq) return;
        pendingJson = null;
        lastSent = json;
        setState('synced');
        debugLog('← room.skins 收到回执（已同步）');
      } catch (err) {
        if (my !== seq) return;
        pendingJson = null;
        const code = err && err.code;
        if (code === 'RATE' || code === 'TIMEOUT' || code === 'OFFLINE') { debugLog('← room.skins 暂时失败，稍后重试', code); schedule(RETRY_MS); return; }
        console.warn('[skins] room.skins refused', code, err && err.detail);
        debugLog('← room.skins 被拒', code, err && err.detail);
        setState('error');
      }
    } catch (e) {
      console.warn('[skins] sync failed', e);
      setState('error');
    }
  }

  const offWelcome = net.on('welcome', () => { debugLog('welcome → 重发当前选择'); lastSent = null; pendingJson = null; seq++; schedule(50); });
  const offStore = skinsStore.subscribe((s, prev) => { if (s.entries !== prev.entries) { debugLog('选择变了 →', JSON.stringify(s.entries)); schedule(); } });

  return {
    flush,
    dispose() {
      disposed = true;
      T.clearTimeout(timer);
      offWelcome?.();
      offStore?.();
    },
  };
}
