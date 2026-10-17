// server/http/config.js — where the server's settings come from. startServer() options win over the environment:
//
//   * PORT (default 3000), HOST (default '::', one dual-stack socket for IPv6 and IPv4);
//   * TRUST_PROXY ('auto' default: honour CF-Connecting-IP / X-Real-IP / X-Forwarded-For only from loopback/private
//     peers such as a local cloudflared; '1' always; '0' never) → net.js trustProxy;
//   * DEBUG → the console logger's debug level;
//   * SP_MAX_MATCH_PLAYERS (default 20; `0` or empty = no limit) → lobby.js `maxMatchPlayers`: how many humans may be in
//     running matches at once (a low-spec server's cap; the hall, spectating and AI seats are never counted);
//   * SP_OWNER_TOKEN → net.js `ownerToken`: a page that carries it in its URL (`/?owner=…`) plays as the server owner —
//     never refused by that cap and never counted against it; unset/empty = nobody has the privilege;
//   * SP_ASSET_INDEX=0 (or the `assetIndex: false` option) → no content-hash index: plain asset URLs, size-mtime ETags
//     (assetIndex.js); the index of the default public/ persists in .cache/asset-hashes.json;
//   * the served directories (public/, data/, shared/, the content packs' packs/ and the plugins' plugins/ of this
//     repository unless the options name others), and which startServer() options are handed on to net.js Network and
//     lobby.js Lobby.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

/** startServer() options handed on to net.js Network / lobby.js Lobby (an absent one keeps that module's default). */
const NET_OPTION_KEYS = ['reconnectWindowMs', 'heartbeatMs', 'helloTimeoutMs', 'ratePerSec', 'rateBurst', 'maxConnections', 'abuseDropsPerSec',
  'maxConnectionsPerAddr', 'heavyPerSec', 'heavyBurst', 'trustProxy', 'ownerToken'];
const LOBBY_OPTION_KEYS = ['lobbyGraceMs', 'maxRooms', 'maxRoomsPerAddr', 'maxMatchesPerAddr', 'resyncMinGapMs', 'soloReconnectWindowMs', 'maxMatchPlayers'];

/**
 * Bind address used when neither the `host` option nor `HOST` says otherwise: one dual-stack socket, so the server
 * answers IPv6 and IPv4 alike without a second listener (Node keeps `ipv6Only` off for `::`).
 * `HOST=0.0.0.0` still means IPv4 only, `HOST=127.0.0.1` still means loopback only (a reverse proxy in front).
 */
export const DEFAULT_BIND_HOST = '::';

/**
 * Where to listen: the `port` / `host` options, else PORT / HOST, else port 3000 on DEFAULT_BIND_HOST.
 * An empty host is treated as unset.
 * @param {{ port?: number, host?: string }} opts
 * @returns {{ port: number, host: string }}
 * @throws {RangeError} when the port is not an integer in 0…65535
 */
export function listenAddress(opts) {
  const port = opts.port ?? (process.env.PORT != null && process.env.PORT !== '' ? Number(process.env.PORT) : 3000);
  const host = (opts.host || process.env.HOST) || DEFAULT_BIND_HOST;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError(`invalid PORT ${port}`);
  return { port, host };
}

/**
 * The hosts to try, in order, for a bind. Only the default is retried: a host with IPv6 switched off refuses `::`
 * with EAFNOSUPPORT / EADDRNOTAVAIL / EINVAL, and falling back to IPv4 beats not booting. An explicit HOST is literal.
 * @param {string} host a host out of listenAddress()
 * @returns {string[]}
 */
export function bindCandidates(host) {
  return host === DEFAULT_BIND_HOST ? [DEFAULT_BIND_HOST, '0.0.0.0'] : [host];
}

/**
 * The directories the static server reads (packsDir: the pack folders, pluginsDir: the plugin folders —
 * server/plugins/registry.js; default: the plugins/ folder beside packsDir, so a server given its own packs folder —
 * a test — never reads this checkout's plugins). The fork's own plugin registry (server/plugins.js,
 * docs/PLUGINS-fork.md) reads the same pluginsDir.
 * @param {{ publicDir?: string, dataDir?: string, sharedDir?: string, packsDir?: string, pluginsDir?: string }} opts
 */
export function serveDirs(opts) {
  const packsDir = opts.packsDir || path.join(ROOT, 'packs');
  return {
    publicDir: opts.publicDir || path.join(ROOT, 'public'),
    dataDir: opts.dataDir || path.join(ROOT, 'data'),
    sharedDir: opts.sharedDir || path.join(ROOT, 'shared'),
    packsDir,
    pluginsDir: opts.pluginsDir || path.join(path.dirname(path.resolve(packsDir)), 'plugins'),
  };
}

/**
 * The asset index options out of the startServer() options and the environment, or null for none: `assetIndex: false`
 * or SP_ASSET_INDEX=0 / off / false / no switches it off; `assetIndex: { cacheFile, delayMs }` overrides the defaults.
 * The hashes persist in .cache/asset-hashes.json only for the repository's own public/ (a test's temporary folder keeps
 * them in memory).
 * @param {{ assetIndex?: boolean | { cacheFile?: string | null, delayMs?: number } }} opts
 * @param {string} publicDir
 * @returns {{ cacheFile: string | null, delayMs?: number } | null}
 */
export function assetIndexOptionsFrom(opts, publicDir) {
  if (opts.assetIndex === false) return null;
  const env = String(process.env.SP_ASSET_INDEX ?? '').trim().toLowerCase();
  if (opts.assetIndex == null && ['0', 'off', 'false', 'no'].includes(env)) return null;
  const o = typeof opts.assetIndex === 'object' && opts.assetIndex ? opts.assetIndex : {};
  const own = path.resolve(publicDir) === path.join(ROOT, 'public');
  const cacheFile = o.cacheFile !== undefined ? o.cacheFile : (own ? path.join(ROOT, '.cache', 'asset-hashes.json') : null);
  return { cacheFile, ...(Number.isFinite(o.delayMs) ? { delayMs: o.delayMs } : {}) };
}

/** net.js Network options out of the startServer() options; `trustProxy` falls back to TRUST_PROXY. */
export function netOptionsFrom(opts) {
  const netOptions = {};
  for (const k of NET_OPTION_KEYS) {
    if (opts[k] != null) netOptions[k] = opts[k];
  }
  if (netOptions.trustProxy == null) netOptions.trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
  // 服主密钥 (SP_OWNER_TOKEN): the privilege token a page may carry in its URL (`/?owner=…`); null = the feature is off
  if (netOptions.ownerToken == null) netOptions.ownerToken = ownerToken();
  return netOptions;
}

/** lobby.js Lobby options out of the startServer() options. */
export function lobbyOptionsFrom(opts) {
  const lobbyOptions = {};
  for (const k of LOBBY_OPTION_KEYS) {
    if (opts[k] != null) lobbyOptions[k] = opts[k];
  }
  // 调试开关 (devGold): 起服时 SP_DEV=1 打开，客户端会多出一个「+999 资金」按钮（server/match/player/economy.js
  // devGold）。只在这里读一次环境变量，按对局带过去，所以线上/普通启动里这条命令根本不存在。
  lobbyOptions.devGold = opts.devGold != null ? !!opts.devGold : isDev();
  // 对局人数上限 (SP_MAX_MATCH_PLAYERS): 低配服务器限制同时在「对局中」的真人玩家数；0 = 不限制
  if (lobbyOptions.maxMatchPlayers == null) lobbyOptions.maxMatchPlayers = maxMatchPlayers();
  return lobbyOptions;
}

/** The default cap on humans in running matches: LOBBY_DEFAULTS.maxMatchPlayers (server/lobby.js). */
export const DEFAULT_MAX_MATCH_PLAYERS = 20;

/**
 * How many humans may be in running matches at once (env `SP_MAX_MATCH_PLAYERS`; server/lobby.js Lobby.start):
 *   * unset → the default (20);
 *   * an empty value, `0` or a value < 1 → 0, i.e. no limit (a small server that wants no cap says so);
 *   * any other number → that number (floored; a negative/unparsable value keeps the default — a typo never removes
 *     the cap silently, which is the whole point of setting it on a low-spec machine).
 * The hall is unaffected: waiting, browsing and spectating never count against it.
 * @returns {number} 0 = unlimited
 */
export function maxMatchPlayers() {
  const raw = process.env.SP_MAX_MATCH_PLAYERS;
  if (raw == null) return DEFAULT_MAX_MATCH_PLAYERS;
  const s = String(raw).trim();
  if (s === '') return 0;
  const n = Number(s);
  if (!Number.isFinite(n)) return DEFAULT_MAX_MATCH_PLAYERS;
  const cap = Math.floor(n);
  return cap > 0 ? cap : 0;
}

/**
 * The server owner's privilege key (env `SP_OWNER_TOKEN`), or null when the feature is off. A page that presents it in
 * its URL (`/?owner=<key>`) gets its session marked as the owner's (server/net.js onHelloMsg): its seats are never
 * refused by the match-player limit and never count against it (server/lobby.js Lobby.start). The key is never
 * logged, never sent to a client and never part of /healthz — an empty value means off, like an unset one.
 * @returns {string | null}
 */
export function ownerToken() {
  const s = String(process.env.SP_OWNER_TOKEN ?? '').trim();
  return s ? s : null;
}

/** 是否开启了开发调试（SP_DEV=1 / true / on）；也接受命令行 --dev（tools/setup.mjs、npm run dev 用得上）。 */
export function isDev(argv = process.argv) {
  const v = String(process.env.SP_DEV ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  return Array.isArray(argv) && argv.includes('--dev');
}

/** TRUST_PROXY env → net.js trustProxy ('auto' unless explicitly on/off). @param {string | undefined} v */
export function parseTrustProxy(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'always'].includes(s)) return true;
  if (['0', 'false', 'no', 'off', 'never'].includes(s)) return false;
  return 'auto';
}

/** The console logger (`quiet` → silent; debug lines only with DEBUG set). */
export function makeLogger(quiet) {
  if (quiet) return noopLog;
  return {
    info: (...a) => console.log(...a),
    warn: (...a) => console.warn(...a),
    error: (...a) => console.error(...a),
    debug: process.env.DEBUG ? (...a) => console.debug(...a) : () => {},
  };
}
