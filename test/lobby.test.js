// test/lobby.test.js — platform tests: static HTTP server, WebSocket session layer, lobby, match wiring,
// reconnect, data loader. Boots real servers in-process on random ports (startServer({ port: 0 })).

import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { startServer, parseRange, acceptsGzip, pickEncoding, parseTrustProxy } from '../server/index.js';
import { maxMatchPlayers, ownerToken } from '../server/http/config.js';
import { loadData, lookup, getChess, getBond, getBand, getMode, getConfig, INDEXED_FILES } from '../server/data.js';
import * as dataModule from '../server/data.js';
import { CODE_ALPHABET, BOT_NAMES } from '../server/lobby.js';
import { sanitizeName, TokenBucket, SessionRegistry, clientAddress, normalizeIp, isLocalIp, limitKeyOf } from '../server/net.js';
import { StubMatch as Match } from '../server/match/StubMatch.js';
import { Match as RealMatch } from '../server/match/Match.js';
import { TestClient } from './helpers/wsClient.js';
import { ERR, ERR_TEXT, MAX_SEATS, MAX_SPECTATORS, PHASE, EMOTES } from '../shared/constants.js';

const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{4}$`);
// fileURLToPath 才会做百分号解码：`new URL().pathname` 在含非 ASCII 的仓库路径（例如 `G:\卫\…`）下会拼出假路径。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------

/** Raw HTTP request (the path is sent verbatim, no normalization). */
function httpReq(port, rawPath, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/** Tracks clients per test so they are always closed. */
function clientPool(getUrl) {
  const open = new Set();
  return {
    async connect(opts) {
      const c = await TestClient.connect(getUrl(), opts);
      open.add(c);
      return c;
    },
    /** Connect + hello; the client gets `.id` and `.token`. */
    async player(name, token) {
      const c = await this.connect();
      const w = await c.hello(name, token);
      c.id = w.playerId;
      c.token = w.token;
      c.welcome = w;
      return c;
    },
    async closeAll() {
      await Promise.all([...open].map((c) => c.terminate().catch(() => {})));
      open.clear();
    },
  };
}

async function createRoom(c, mode = 'coop', difficulty = 'NORMAL') {
  const r = await c.request({ t: 'room.create', mode, difficulty });
  assert.equal(r.t, 'ok', JSON.stringify(r));
  return c.waitFor('room.state', (s) => s.hostId === c.id && s.mode === mode);
}

async function joinRoom(c, code) {
  const r = await c.request({ t: 'room.join', code });
  assert.equal(r.t, 'ok', JSON.stringify(r));
  return c.waitFor('room.state', (s) => s.code === code.toUpperCase() && s.seats.some((x) => x && x.playerId === c.id));
}

const seatOf = (state, id) => state.seats.find((s) => s && s.playerId === id) || null;
const expectError = async (c, msg, code) => {
  const r = await c.request(msg);
  assert.equal(r.t, 'error', `expected error ${code} for ${msg.t}, got ${JSON.stringify(r)}`);
  assert.equal(r.code, code, `${msg.t}: ${JSON.stringify(r)}`);
  assert.equal(typeof r.msg, 'string');
  return r;
};
const expectOk = async (c, msg) => {
  const r = await c.request(msg);
  assert.equal(r.t, 'ok', `${msg.t}: ${JSON.stringify(r)}`);
  return r;
};

/** Collects log output; errors are asserted empty unless a test expects them. */
function captureLog() {
  const errors = [];
  return { errors, log: { info() {}, warn() {}, debug() {}, error: (...a) => errors.push(a.map(String).join(' ')) } };
}

// ---------------------------------------------------------------------------------------------------
// Static HTTP
// ---------------------------------------------------------------------------------------------------

describe('static http server', () => {
  let srv;
  let tmp;
  const js = `// app\n${'export const x = 1;\n'.repeat(200)}`;
  const mp3 = randomBytes(5000);
  const skel = Buffer.from('skel'.repeat(400));
  // over the 8 MB compression cache limit: compressed as a stream
  const big = `// big\n${Array.from({ length: 360000 }, (_, i) => `export const v${i} = ${i % 97};`).join('\n')}\n`;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-static-'));
    const w = (rel, content) => {
      const p = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    };
    w('secret.txt', 'TOP-SECRET-CONTENT');
    w('public/index.html', '<!doctype html><title>t</title><p>hello</p>');
    w('public/js/app.js', js);
    w('public/js/tiny.mjs', 'export default 1;');
    w('public/css/a.css', 'body{color:red}'.repeat(60));
    w('public/assets/audio/bgm.mp3', mp3);
    w('public/assets/audio/bgm.ogg', randomBytes(64));
    w('public/assets/spine/x.skel', skel);
    w('public/assets/spine/x.atlas', 'x.png\nsize: 64,64\n'.repeat(40));
    w('public/assets/img/a.png', randomBytes(32));
    w('public/js/huge.js', big);
    w('public/assets/img/a.webp', randomBytes(32));
    w('public/fonts/f.woff2', randomBytes(32));
    w('public/fonts/f.ttf', randomBytes(32));
    w('public/fonts/f.otf', randomBytes(32));
    w('public/.hidden', 'hidden');
    w('public/sub/index.html', '<p>sub</p>');
    w('data/config.json', JSON.stringify({ hello: 'world', nested: { a: [1, 2] } }));
    w('shared/x.js', 'export const y = 2;');
    srv = await startServer({
      port: 0, host: '127.0.0.1', quiet: true,
      publicDir: path.join(tmp, 'public'), dataDir: path.join(tmp, 'data'), sharedDir: path.join(tmp, 'shared'),
      assetIndex: { delayMs: 0 },
    });
    // the content hashes of public/assets + public/fonts (the ETags of those files): ready before the first request
    await srv.assetIndex.whenReady();
  });

  after(async () => {
    await srv?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('serves index.html at / with no-cache', async () => {
    const r = await httpReq(srv.port, '/');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^text\/html/);
    assert.equal(r.headers['cache-control'], 'no-cache');
    assert.match(r.body.toString(), /hello/);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    const sub = await httpReq(srv.port, '/sub/');
    assert.equal(sub.status, 200);
    assert.match(sub.body.toString(), /sub/);
    const redirect = await httpReq(srv.port, '/sub?x=1');
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.location, '/sub/?x=1');
  });

  test('javascript: correct MIME, brotli when named, gzip when accepted, identity otherwise', async () => {
    const br = await httpReq(srv.port, '/js/app.js', { headers: { 'accept-encoding': 'gzip, deflate, br' } });
    assert.equal(br.status, 200);
    assert.equal(br.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(br.headers['content-encoding'], 'br', 'a browser on an HTTPS page (or localhost) names br');
    assert.equal(br.headers.vary, 'Accept-Encoding');
    assert.equal(Number(br.headers['content-length']), br.body.length);
    assert.equal(zlib.brotliDecompressSync(br.body).toString(), js);
    const gz = await httpReq(srv.port, '/js/app.js', { headers: { 'accept-encoding': 'gzip, deflate' } });
    assert.equal(gz.headers['content-encoding'], 'gzip', 'a LAN http:// page: gzip');
    assert.equal(zlib.gunzipSync(gz.body).toString(), js);
    // cached second responses are identical
    assert.deepEqual((await httpReq(srv.port, '/js/app.js', { headers: { 'accept-encoding': 'gzip' } })).body, gz.body);
    assert.deepEqual((await httpReq(srv.port, '/js/app.js', { headers: { 'accept-encoding': 'br' } })).body, br.body);

    const plain = await httpReq(srv.port, '/js/app.js');
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.equal(plain.body.toString(), js);
    const refused = await httpReq(srv.port, '/js/app.js', { headers: { 'accept-encoding': 'gzip;q=0, identity' } });
    assert.equal(refused.headers['content-encoding'], undefined);

    const mjs = await httpReq(srv.port, '/js/tiny.mjs');
    assert.equal(mjs.headers['content-type'], 'text/javascript; charset=utf-8');
  });

  test('MIME types for every asset kind; .skel/.atlas gzip, media not', async () => {
    const cases = [
      ['/css/a.css', 'text/css; charset=utf-8', true],
      ['/data/config.json', 'application/json; charset=utf-8', false],
      ['/assets/img/a.png', 'image/png', false],
      ['/assets/img/a.webp', 'image/webp', false],
      ['/assets/audio/bgm.mp3', 'audio/mpeg', false],
      ['/assets/audio/bgm.ogg', 'audio/ogg', false],
      ['/fonts/f.woff2', 'font/woff2', false],
      ['/fonts/f.ttf', 'font/ttf', false],
      ['/fonts/f.otf', 'font/otf', false],
      ['/assets/spine/x.skel', 'application/octet-stream', true],
      ['/assets/spine/x.atlas', 'text/plain; charset=utf-8', true],
      ['/shared/x.js', 'text/javascript; charset=utf-8', false],
    ];
    for (const [p, type, gzipped] of cases) {
      const r = await httpReq(srv.port, p, { headers: { 'accept-encoding': 'gzip' } });
      assert.equal(r.status, 200, p);
      assert.equal(r.headers['content-type'], type, p);
      assert.equal(r.headers['content-encoding'] === 'gzip', gzipped, `${p} gzip=${r.headers['content-encoding']}`);
    }
    const skelGz = await httpReq(srv.port, '/assets/spine/x.skel', { headers: { 'accept-encoding': 'gzip' } });
    assert.deepEqual(zlib.gunzipSync(skelGz.body), skel);
    const skelBr = await httpReq(srv.port, '/assets/spine/x.skel', { headers: { 'accept-encoding': 'gzip, br' } });
    assert.equal(skelBr.headers['content-encoding'], 'br');
    assert.deepEqual(zlib.brotliDecompressSync(skelBr.body), skel);
    // media is never compressed, whatever the client names
    assert.equal((await httpReq(srv.port, '/assets/audio/bgm.mp3', { headers: { 'accept-encoding': 'br, gzip' } })).headers['content-encoding'], undefined);
    assert.equal((await httpReq(srv.port, '/assets/img/a.png', { headers: { 'accept-encoding': 'br' } })).headers['content-encoding'], undefined);
  });

  test('a file over the compression cache limit is compressed as a stream (brotli and gzip); HEAD sends no body', async () => {
    const br = await httpReq(srv.port, '/js/huge.js', { headers: { 'accept-encoding': 'br' } });
    assert.equal(br.headers['content-encoding'], 'br');
    assert.equal(br.headers['content-length'], undefined, 'streamed: no length up front');
    assert.equal(zlib.brotliDecompressSync(br.body).toString(), big);
    assert.ok(br.body.length < big.length / 4);
    const gz = await httpReq(srv.port, '/js/huge.js', { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.equal(zlib.gunzipSync(gz.body).toString(), big);
    const head = await httpReq(srv.port, '/js/huge.js', { method: 'HEAD', headers: { 'accept-encoding': 'br' } });
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assert.equal(head.headers['content-encoding'], 'br');
  });

  test('ETag / Last-Modified revalidation and Cache-Control policy', async () => {
    const first = await httpReq(srv.port, '/js/app.js');
    const { etag } = first.headers;
    assert.match(etag, /^"[0-9a-f]+-[0-9a-f]+"$/);
    assert.ok(first.headers['last-modified']);
    assert.equal(first.headers['cache-control'], 'no-cache');
    const revalidated = await httpReq(srv.port, '/js/app.js', { headers: { 'if-none-match': etag } });
    assert.equal(revalidated.status, 304);
    assert.equal(revalidated.body.length, 0);
    const weak = await httpReq(srv.port, '/js/app.js', { headers: { 'if-none-match': `"nope", W/${etag}` } });
    assert.equal(weak.status, 304);
    const ims = await httpReq(srv.port, '/js/app.js', { headers: { 'if-modified-since': first.headers['last-modified'] } });
    assert.equal(ims.status, 304);
    const stale = await httpReq(srv.port, '/js/app.js', { headers: { 'if-none-match': '"other"' } });
    assert.equal(stale.status, 200);
    const gzEtag = (await httpReq(srv.port, '/js/app.js', { headers: { 'accept-encoding': 'gzip' } })).headers.etag;
    assert.notEqual(gzEtag, etag, 'gzip variant has its own ETag');
    const brEtag = (await httpReq(srv.port, '/js/app.js', { headers: { 'accept-encoding': 'br' } })).headers.etag;
    assert.equal(brEtag, etag.replace(/"$/, '-br"'), 'so has the brotli variant');
    assert.equal((await httpReq(srv.port, '/js/app.js', { headers: { 'accept-encoding': 'br', 'if-none-match': brEtag } })).status, 304);
    assert.equal((await httpReq(srv.port, '/js/app.js', { headers: { 'accept-encoding': 'gzip', 'if-none-match': brEtag } })).status, 200, 'not the gzip variant');

    // unversioned art/fonts/vendor: cached for a day (files can be rewritten in place by the asset tools); the art and
    // fonts carry their content hash as ETag (server/http/assetIndex.js), so a rewrite with the same bytes is a 304
    const asset = await httpReq(srv.port, '/assets/img/a.png');
    assert.equal(asset.headers['cache-control'], 'public, max-age=86400');
    assert.match(asset.headers.etag, /^"[0-9a-f]{16}"$/);
    const font = await httpReq(srv.port, '/fonts/f.woff2');
    assert.equal(font.headers['cache-control'], 'public, max-age=86400');
    const assetV = await httpReq(srv.port, '/assets/img/a.png?v=abc');
    assert.match(assetV.headers['cache-control'], /immutable/);
    const assetRoot = await httpReq(srv.port, '/assets');
    assert.equal(assetRoot.status, 301, 'directory redirect, not cached content');
    const versioned = await httpReq(srv.port, '/js/app.js?v=123');
    assert.match(versioned.headers['cache-control'], /immutable/);
    const html = await httpReq(srv.port, '/index.html?v=1');
    assert.equal(html.headers['cache-control'], 'no-cache');
  });

  test('byte ranges for audio (206 / 416 / If-Range)', async () => {
    const full = await httpReq(srv.port, '/assets/audio/bgm.mp3');
    assert.equal(full.headers['accept-ranges'], 'bytes');
    assert.deepEqual(full.body, mp3);

    const head = await httpReq(srv.port, '/assets/audio/bgm.mp3', { headers: { range: 'bytes=0-9' } });
    assert.equal(head.status, 206);
    assert.equal(head.headers['content-range'], `bytes 0-9/${mp3.length}`);
    assert.equal(Number(head.headers['content-length']), 10);
    assert.deepEqual(head.body, mp3.subarray(0, 10));

    const open = await httpReq(srv.port, '/assets/audio/bgm.mp3', { headers: { range: 'bytes=4990-' } });
    assert.equal(open.status, 206);
    assert.deepEqual(open.body, mp3.subarray(4990));

    const suffix = await httpReq(srv.port, '/assets/audio/bgm.mp3', { headers: { range: 'bytes=-100' } });
    assert.equal(suffix.status, 206);
    assert.deepEqual(suffix.body, mp3.subarray(mp3.length - 100));

    const clamp = await httpReq(srv.port, '/assets/audio/bgm.mp3', { headers: { range: 'bytes=4000-999999' } });
    assert.equal(clamp.headers['content-range'], `bytes 4000-4999/${mp3.length}`);

    const bad = await httpReq(srv.port, '/assets/audio/bgm.mp3', { headers: { range: 'bytes=9000-9100' } });
    assert.equal(bad.status, 416);
    assert.equal(bad.headers['content-range'], `bytes */${mp3.length}`);

    const multi = await httpReq(srv.port, '/assets/audio/bgm.mp3', { headers: { range: 'bytes=0-1,5-6' } });
    assert.equal(multi.status, 200, 'multi-range falls back to the full body');

    const ifRangeOk = await httpReq(srv.port, '/assets/audio/bgm.mp3', { headers: { range: 'bytes=0-1', 'if-range': full.headers.etag } });
    assert.equal(ifRangeOk.status, 206);
    const ifRangeStale = await httpReq(srv.port, '/assets/audio/bgm.mp3', { headers: { range: 'bytes=0-1', 'if-range': '"stale"' } });
    assert.equal(ifRangeStale.status, 200);

    const textRange = await httpReq(srv.port, '/js/app.js', { headers: { range: 'bytes=0-1', 'accept-encoding': 'gzip' } });
    assert.equal(textRange.status, 206, 'ranges are served identity-encoded');
    assert.equal(textRange.headers['content-encoding'], undefined);
    assert.equal(textRange.body.toString(), js.slice(0, 2));
  });

  for (const url of ['/assets/audio/bgm.mp3', '/media/bgm']) {
    for (const range of ['bytes=0-0', `bytes=${mp3.length}-`]) {
      test(`HEAD ignores Range ${range} on ${url}`, async () => {
        const full = await httpReq(srv.port, url);
        const head = await httpReq(srv.port, url, { method: 'HEAD', headers: { range } });
        assert.equal(head.status, 200);
        assert.equal(head.headers['content-length'], String(full.body.length));
        assert.equal(head.headers['content-range'], undefined);
        assert.equal(head.headers['content-type'], full.headers['content-type']);
        assert.equal(head.headers.etag, full.headers.etag);
        assert.equal(head.body.length, 0);
      });
    }
  }

  for (const encoding of ['gzip', 'br']) {
    test(`HEAD ignores Range when selecting the ${encoding} representation`, async () => {
      const url = '/js/app.js';
      const headers = { 'accept-encoding': encoding };
      const full = await httpReq(srv.port, url, { headers });
      assert.equal(full.status, 200);
      assert.equal(full.headers['content-encoding'], encoding);
      for (const range of ['bytes=0-0', `bytes=${Buffer.byteLength(js)}-`]) {
        const head = await httpReq(srv.port, url, { method: 'HEAD', headers: { ...headers, range } });
        assert.equal(head.status, 200);
        assert.equal(head.headers['content-encoding'], encoding);
        assert.equal(head.headers['content-length'], String(full.body.length));
        assert.equal(head.headers['content-range'], undefined);
        assert.equal(head.headers.etag, full.headers.etag);
        assert.equal(head.headers.vary, full.headers.vary);
        assert.equal(head.body.length, 0);

        const cached = await httpReq(srv.port, url, {
          method: 'HEAD', headers: { ...headers, range, 'if-none-match': full.headers.etag },
        });
        assert.equal(cached.status, 304, 'Range must not change the selected validator');
        assert.equal(cached.headers.etag, full.headers.etag);
        assert.equal(cached.headers['content-range'], undefined);
        assert.equal(cached.body.length, 0);
      }
    });
  }

  test('HEAD ignores Range while honoring cache validators and ignoring If-Range', async () => {
    for (const url of ['/assets/audio/bgm.mp3', '/media/bgm']) {
      const full = await httpReq(srv.port, url);
      for (const condition of [
        { 'if-none-match': full.headers.etag },
        { 'if-modified-since': full.headers['last-modified'] },
      ]) {
        const cached = await httpReq(srv.port, url, {
          method: 'HEAD', headers: { range: `bytes=${mp3.length}-`, ...condition },
        });
        assert.equal(cached.status, 304);
        assert.equal(cached.headers['content-range'], undefined);
        assert.equal(cached.body.length, 0);
      }
      for (const ifRange of [full.headers.etag, '"stale"']) {
        const head = await httpReq(srv.port, url, {
          method: 'HEAD', headers: { range: 'bytes=0-0', 'if-range': ifRange },
        });
        assert.equal(head.status, 200);
        assert.equal(head.headers['content-length'], String(mp3.length));
        assert.equal(head.headers['content-range'], undefined);
        assert.equal(head.body.length, 0);
      }
    }
  });

  test('extension-less /media audio route (download managers sniff .mp3 URLs)', async () => {
    const direct = await httpReq(srv.port, '/assets/audio/bgm.mp3');
    const media = await httpReq(srv.port, '/media/bgm');
    assert.equal(media.status, 200);
    assert.equal(media.headers['content-type'], 'audio/mpeg', 'resolved from the real .mp3 on disk');
    assert.equal(media.headers['accept-ranges'], 'bytes');
    assert.deepEqual(media.body, mp3, 'same bytes as the direct URL');
    assert.equal(media.headers['cache-control'], direct.headers['cache-control'], 'same 1-day policy as /assets/…');
    assert.equal(media.headers.etag, direct.headers.etag, 'ETag is the file validator, not the URL');

    const range = await httpReq(srv.port, '/media/bgm', { headers: { range: 'bytes=0-9' } });
    assert.equal(range.status, 206);
    assert.equal(range.headers['content-range'], `bytes 0-9/${mp3.length}`);
    assert.deepEqual(range.body, mp3.subarray(0, 10));
    const head = await httpReq(srv.port, '/media/bgm', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);

    // The extension may still be given, and the other audio extension resolves too.
    assert.equal((await httpReq(srv.port, '/media/bgm.mp3')).status, 200);
    const ogg = await httpReq(srv.port, '/media/bgm.ogg');
    assert.equal(ogg.status, 200);
    assert.equal(ogg.headers['content-type'], 'audio/ogg');
    assert.equal(ogg.body.length, 64);

    // …and it only ever reaches public/assets/audio.
    for (const p of ['/media/nope', '/media/bgm/', '/media/', '/media/.hidden', '/media/bgm.mp3/nope', '/media/js/app']) {
      const r = await httpReq(srv.port, p);
      assert.equal(r.status, 404, `${p} → 404`);
      assert.doesNotMatch(r.body.toString(), /TOP-SECRET-CONTENT/, `${p} must not leak files outside public/assets/audio`);
    }
    for (const p of ['/media/..%2f..%2fsecret.txt', '/media/bgm/../..%2f..%2fsecret.txt']) {
      const r = await httpReq(srv.port, p);
      assert.equal(r.status, 403, `${p} → 403 (same as the rest of the server)`);
      assert.doesNotMatch(r.body.toString(), /TOP-SECRET-CONTENT/);
    }
  });

  test('path traversal and dotfiles are blocked', async () => {
    const attempts = [
      '/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/%2e%2e%2fsecret.txt', '/data/../../secret.txt',
      '/shared/..%2f..%2fsecret.txt', '/%2e%2e%5csecret.txt', '/assets/../../secret.txt', '/..', '/./../secret.txt',
      '/%252e%252e/secret.txt', '/.hidden', '/%2ehidden', '/data/%00config.json', '/%E0%A4%A', '//secret.txt',
    ];
    for (const p of attempts) {
      const r = await httpReq(srv.port, p);
      assert.ok([400, 403, 404].includes(r.status), `${p} → ${r.status}`);
      assert.ok(!r.body.toString().includes('TOP-SECRET'), `${p} leaked`);
      assert.ok(!r.body.toString().includes('hidden</'), `${p} leaked dotfile`);
    }
  });

  test('404 page, HEAD, 405, bare mount redirect, healthz', async () => {
    const nf = await httpReq(srv.port, '/nope.js');
    assert.equal(nf.status, 404);
    assert.match(nf.headers['content-type'], /^text\/html/);
    assert.match(nf.body.toString(), /404/);
    const nfData = await httpReq(srv.port, '/data/missing.json');
    assert.equal(nfData.status, 404);

    const head = await httpReq(srv.port, '/js/app.js', { method: 'HEAD', headers: { 'accept-encoding': 'gzip' } });
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assert.ok(Number(head.headers['content-length']) > 0);

    const post = await httpReq(srv.port, '/', { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.allow, 'GET, HEAD');

    const bare = await httpReq(srv.port, '/data');
    assert.equal(bare.status, 301);
    assert.equal(bare.headers.location, '/data/');
    const fileAsDir = await httpReq(srv.port, '/js/app.js/');
    assert.equal(fileAsDir.status, 404);
    const indexAsDir = await httpReq(srv.port, '/index.html/');
    assert.equal(indexAsDir.status, 404);
    const dirNoIndex = await httpReq(srv.port, '/data/');
    assert.equal(dirNoIndex.status, 404, 'no directory listings');

    const health = await httpReq(srv.port, '/healthz');
    assert.equal(health.status, 200);
    const h = JSON.parse(health.body.toString());
    assert.equal(h.ok, true);
    assert.equal(typeof h.rooms, 'number');
    assert.equal(health.headers['cache-control'], 'no-store');
  });

  test('WebSocket upgrade only on /ws', async () => {
    await assert.rejects(TestClient.connect(`ws://127.0.0.1:${srv.port}/other`));
    const ok = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws?x=1`);
    await ok.close();
  });

  test('range / accept-encoding parsers', () => {
    assert.deepEqual(parseRange('bytes=0-0', 10), { start: 0, end: 0 });
    assert.deepEqual(parseRange('bytes=-3', 10), { start: 7, end: 9 });
    assert.deepEqual(parseRange('bytes=-30', 10), { start: 0, end: 9 });
    assert.equal(parseRange('bytes=-0', 10), 'unsatisfiable');
    assert.equal(parseRange('bytes=10-', 10), 'unsatisfiable');
    assert.equal(parseRange('bytes=0-', 0), 'unsatisfiable');
    assert.equal(parseRange('bytes=5-2', 10), null);
    assert.equal(parseRange('items=0-1', 10), null);
    assert.equal(parseRange('bytes=-', 10), null);
    assert.equal(acceptsGzip('gzip'), true);
    assert.equal(acceptsGzip('deflate, gzip;q=0.5'), true);
    assert.equal(acceptsGzip('gzip;q=0'), false);
    assert.equal(acceptsGzip('*'), true);
    assert.equal(acceptsGzip('*;q=0'), false);
    assert.equal(acceptsGzip('br'), false);
    assert.equal(acceptsGzip(undefined), false);
    // brotli when named at least as high as gzip; `*` alone never picks it
    assert.equal(pickEncoding('gzip, deflate, br, zstd'), 'br');
    assert.equal(pickEncoding('gzip, deflate'), 'gzip');
    assert.equal(pickEncoding('br;q=0, gzip'), 'gzip');
    assert.equal(pickEncoding('br;q=0.5, gzip'), 'gzip');
    assert.equal(pickEncoding('gzip;q=0.5, br'), 'br');
    assert.equal(pickEncoding('br'), 'br');
    assert.equal(pickEncoding('*'), 'gzip');
    assert.equal(pickEncoding('*;q=0'), null);
    assert.equal(pickEncoding('identity'), null);
    assert.equal(pickEncoding(undefined), null);
  });
});

describe('static http server (real repository roots)', () => {
  let srv;
  before(async () => { srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true }); });
  after(async () => { await srv?.close(); });

  test('serves shared/ ESM and never exposes server code or package.json', async () => {
    for (const p of ['/shared/constants.js', '/shared/protocol.js']) {
      const r = await httpReq(srv.port, p);
      assert.equal(r.status, 200, p);
      assert.equal(r.headers['content-type'], 'text/javascript; charset=utf-8');
    }
    for (const p of ['/../package.json', '/%2e%2e/package.json', '/shared/../package.json', '/server/index.js', '/node_modules/ws/package.json', '/package.json']) {
      const r = await httpReq(srv.port, p);
      assert.ok([400, 403, 404].includes(r.status), `${p} → ${r.status}`);
      assert.ok(!r.body.toString().includes('"dependencies"'), `${p} leaked package.json`);
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// WebSocket session layer + lobby (default timers)
// ---------------------------------------------------------------------------------------------------

describe('websocket lobby', () => {
  let srv;
  let pool;
  const cap = captureLog();

  before(async () => {
    srv = await startServer({ port: 0, host: '127.0.0.1', log: cap.log, MatchClass: Match });
    pool = clientPool(() => `ws://127.0.0.1:${srv.port}/ws`);
  });
  afterEach(async () => { await pool.closeAll(); });
  after(async () => {
    await srv?.close();
    assert.deepEqual(cap.errors, [], 'no server errors logged');
  });

  test('hello → welcome with playerId, 128-bit token, sanitized name; ping → pong', async () => {
    const c = await pool.connect();
    const w = await c.hello(' 博士  Doctor ');
    assert.equal(w.t, 'welcome');
    assert.match(w.playerId, /^p_[0-9a-f]{10}$/);
    assert.match(w.token, /^[0-9a-f]{32}$/);
    assert.equal(w.name, '博士 Doctor');
    assert.equal(w.resumed, false);
    assert.ok(Math.abs(w.serverNow - Date.now()) < 5000);
    const pong = await c.request({ t: 'ping', c: 12.5 });
    assert.equal(pong.t, 'pong');
    assert.equal(pong.c, 12.5);
    assert.equal(typeof pong.s, 'number');

    const other = await pool.player('Other');
    assert.notEqual(other.id, w.playerId);
    assert.notEqual(other.token, w.token);

    await expectError(c, { t: 'hello', name: '   ' }, ERR.BAD_MSG);
    await expectError(c, { t: 'hello', name: 'x', version: 999 }, ERR.BAD_MSG);
    await expectError(c, { t: 'hello', name: 'x'.repeat(13) }, ERR.BAD_MSG);
    // repeated hello updates the name, keeps identity
    const again = await c.hello('Renamed');
    assert.equal(again.playerId, w.playerId);
    assert.equal(again.name, 'Renamed');
  });

  test('bad messages → BAD_MSG and the connection stays alive', async () => {
    const c = await pool.connect();
    await expectError(c, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' }, ERR.BAD_MSG); // before hello
    c.id = (await c.hello('Fuzzer')).playerId;
    c.sendRaw('{not json');
    let e = await c.waitFor('error');
    assert.equal(e.code, ERR.BAD_MSG);
    assert.equal(e.rid, undefined);
    c.sendRaw(Buffer.from([1, 2, 3]), { binary: true });
    e = await c.waitFor('error');
    assert.equal(e.code, ERR.BAD_MSG);
    for (const raw of ['[1,2]', 'null', '42', '"str"', '{}', '{"t":5}']) {
      c.sendRaw(raw);
      e = await c.waitFor('error');
      assert.equal(e.code, ERR.BAD_MSG, raw);
    }
    for (const t of ['nope', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'g.', 'room.']) {
      const r = await expectError(c, { t }, ERR.BAD_MSG);
      assert.ok(Number.isInteger(r.rid), 'rid echoed');
    }
    await expectError(c, { t: 'room.create', mode: 'pvp', difficulty: 'NORMAL' }, ERR.BAD_MSG);
    await expectError(c, { t: 'room.create', mode: 'coop', difficulty: 'EASY' }, ERR.BAD_MSG);
    await expectError(c, { t: 'room.create', mode: 'coop' }, ERR.BAD_MSG);
    await expectError(c, { t: 'room.join', code: 'AB CD' }, ERR.BAD_MSG);
    await expectError(c, { t: 'room.join', code: { $gt: '' } }, ERR.BAD_MSG);
    await expectError(c, { t: 'room.ready', ready: 'yes' }, ERR.BAD_MSG);
    await expectError(c, { t: 'room.removeBot', seat: 9 }, ERR.BAD_MSG);
    await expectError(c, { t: 'g.buy', slot: -1 }, ERR.BAD_MSG);
    await expectError(c, { t: 'g.move', uid: 1, to: { area: 'moon' } }, ERR.BAD_MSG);
    await expectError(c, { t: 'ping', c: 'x' }, ERR.BAD_MSG);
    c.send({ t: 'ping', c: 1, rid: -5 });
    e = await c.waitFor('error');
    assert.equal(e.code, ERR.BAD_MSG);
    assert.equal(e.rid, undefined, 'invalid rid is not echoed');
    // still alive and functional
    assert.ok(c.isOpen);
    const pong = await c.request({ t: 'ping', c: 1 });
    assert.equal(pong.t, 'pong');
    await createRoom(c);
  });

  test('oversized frame (> 64 KB) closes only that socket', async () => {
    const c = await pool.player('Big');
    const bystander = await pool.player('Bystander');
    c.sendRaw(JSON.stringify({ t: 'ping', c: 1, pad: 'x'.repeat(70 * 1024) }));
    const info = await c.closed;
    assert.equal(info.code, 1009);
    const pong = await bystander.request({ t: 'ping', c: 2 });
    assert.equal(pong.t, 'pong');
  });

  test('rate limit: bursts beyond 40 msg/s get RATE, connection survives, bucket refills', async (t) => {
    // Transport/compression scheduling must not refill a supposedly instantaneous burst.
    let now = Date.now();
    t.mock.method(srv.network, 'now', () => now);
    const c = await pool.player('Spammer');
    const N = 100;
    const rids = [];
    for (let i = 0; i < N; i++) rids.push(c.send({ t: 'ping', c: i }));
    const replies = [];
    for (const rid of rids) replies.push(await c.waitFor(null, (m) => m.rid === rid, 3000));
    const pongs = replies.filter((m) => m.t === 'pong').length;
    const limited = replies.filter((m) => m.t === 'error' && m.code === ERR.RATE).length;
    assert.equal(pongs + limited, N);
    assert.equal(pongs, 39); // hello used one of the 40 tokens
    assert.equal(limited, 61);
    assert.ok(c.isOpen);
    now += 24; // 40/s: less than one token
    await expectError(c, { t: 'ping', c: 0 }, ERR.RATE);
    now += 1;
    const ok = await c.request({ t: 'ping', c: 0 });
    assert.equal(ok.t, 'pong');
    await expectError(c, { t: 'ping', c: 0 }, ERR.RATE);
    now += 1100; // refill, capped at 40 tokens
    for (let i = 0; i < 40; i++) assert.equal((await c.request({ t: 'ping', c: i })).t, 'pong');
    await expectError(c, { t: 'ping', c: 0 }, ERR.RATE);
    assert.ok(c.isOpen);
  });

  test('flooding far beyond the limit closes the socket (1008)', { timeout: 60000 }, async (t) => {
    const now = Date.now();
    t.mock.method(srv.network, 'now', () => now);
    const c = await pool.player('Flood');
    // Keep one rate window and await replies instead of building a compressed send queue ahead of the close frame.
    // A slow runner (Windows, Node 24) took more than the client's 2 s default for one of the ~430 round trips, so each
    // waits up to 10 s; and the drops stop short of the 400 budget so a frame more or less cannot move the boundary.
    for (let i = 0; i < 39; i++) assert.equal((await c.request({ t: 'ping', c: i }, 10_000)).t, 'pong');
    for (let i = 0; i < 390; i++) {
      const r = await c.request({ t: 'ping', c: i }, 10_000);
      assert.equal(r.t, 'error'); assert.equal(r.code, ERR.RATE);
    }
    assert.ok(c.isOpen, '390 drops do not close the socket');
    // past the budget (400 drops a second) the server closes the socket instead of answering
    for (let i = 0; i < 40 && c.isOpen; i++) c.send({ t: 'ping', c: 400 + i, rid: null });
    const info = await c.closed;
    assert.equal(info.code, 1008);
    assert.equal(info.reason, 'rate limit');
  });

  test('create / join / leave', async () => {
    const host = await pool.player('Host');
    const st = await createRoom(host, 'coop', 'HARD');
    assert.match(st.code, CODE_RE);
    assert.equal(st.mode, 'coop');
    assert.equal(st.difficulty, 'HARD');
    assert.equal(st.inMatch, false);
    assert.equal(st.seats.length, MAX_SEATS);
    assert.deepEqual(st.seats[0], { seat: 0, playerId: host.id, name: 'Host', isBot: false, ready: false, connected: true });
    assert.deepEqual(st.seats.slice(1), [null, null, null]);

    const guest = await pool.player('Guest');
    const joined = await joinRoom(guest, st.code.toLowerCase());
    assert.equal(joined.hostId, host.id);
    assert.equal(seatOf(joined, guest.id).seat, 1);
    const hostView = await host.waitFor('room.state', (s) => !!seatOf(s, guest.id));
    assert.equal(hostView.seats[1].name, 'Guest');

    // join is idempotent for members
    await expectOk(guest, { t: 'room.join', code: st.code });
    await guest.waitFor('room.state', (s) => s.code === st.code);

    await expectOk(guest, { t: 'room.ready', ready: true });
    const readyView = await host.waitFor('room.state', (s) => seatOf(s, guest.id)?.ready === true);
    assert.ok(readyView);

    await expectOk(guest, { t: 'room.leave' });
    const afterLeave = await host.waitFor('room.state', (s) => s.seats[1] === null);
    assert.equal(afterLeave.hostId, host.id);
    await expectError(guest, { t: 'room.leave' }, ERR.NOT_IN_ROOM);
    await expectError(guest, { t: 'room.ready', ready: true }, ERR.NOT_IN_ROOM);
    await expectError(guest, { t: 'g.ready', ready: true }, ERR.NOT_IN_ROOM);

    await expectError(guest, { t: 'room.join', code: 'ZZZZ' === st.code ? 'YYYY' : 'ZZZZ' }, ERR.ROOM_NOT_FOUND);
    await expectError(guest, { t: 'room.join', code: 'ABC' }, ERR.ROOM_NOT_FOUND);
    await expectError(guest, { t: 'room.join', code: 'ABCDEF' }, ERR.ROOM_NOT_FOUND);

    // creating a room while in another lobby room moves you
    const g2 = await joinRoom(guest, st.code);
    assert.equal(seatOf(g2, guest.id).seat, 1);
    const own = await createRoom(guest);
    assert.notEqual(own.code, st.code);
    await host.waitFor('room.state', (s) => s.seats[1] === null);

    // last human leaving disposes the room
    await expectOk(guest, { t: 'room.leave' });
    await expectError(host, { t: 'room.join', code: own.code }, ERR.ROOM_NOT_FOUND);
  });

  test('room full, solo rooms admit one human and no AI', async () => {
    const host = await pool.player('H');
    const st = await createRoom(host);
    const guests = [];
    for (let i = 0; i < 2; i++) {
      const g = await pool.player(`G${i}`);
      await joinRoom(g, st.code);
      guests.push(g);
    }
    await expectOk(host, { t: 'room.addBot' });
    await host.waitFor('room.state', (s) => s.seats.every(Boolean));
    const late = await pool.player('Late');
    await expectError(late, { t: 'room.join', code: st.code }, ERR.ROOM_FULL);
    await expectError(host, { t: 'room.addBot' }, ERR.ROOM_FULL);

    const solo = await pool.player('Solo');
    const soloState = await createRoom(solo, 'solo', 'FUNNY');
    assert.equal(soloState.mode, 'solo');
    await expectError(late, { t: 'room.join', code: soloState.code }, ERR.ROOM_FULL);
    await expectError(solo, { t: 'room.addBot' }, ERR.ROOM_FULL);
  });

  // community report #26 (a remake feature): spectator seats — server/lobby.js header
  test('spectator seats: join / cap / leave / host removal; never a player, never acting, never keeping a room', async () => {
    const host = await pool.player('Host');
    const st = await createRoom(host);
    assert.deepEqual(st.spectators, []);
    const guest = await pool.player('Guest');
    await joinRoom(guest, st.code);
    const s1 = await pool.player('Watcher1');
    await expectOk(s1, { t: 'room.spectate', code: st.code.toLowerCase() });
    const v1 = await s1.waitFor('room.state', (s) => s.spectators.some((x) => x.playerId === s1.id));
    assert.deepEqual(v1.spectators, [{ playerId: s1.id, name: 'Watcher1', connected: true }]);
    assert.ok(!v1.seats.some((x) => x && x.playerId === s1.id), 'never in a player seat');
    await host.waitFor('room.state', (s) => s.spectators.length === 1);
    await expectOk(s1, { t: 'room.spectate', code: st.code }); // idempotent
    await expectError(guest, { t: 'room.spectate', code: st.code }, ERR.ALREADY); // a player never switches in place
    // a spectator may not act
    await expectError(s1, { t: 'room.ready', ready: true }, ERR.SPECTATOR);
    for (const msg of [{ t: 'room.start' }, { t: 'room.addBot' }, { t: 'room.setDifficulty', difficulty: 'HARD' }, { t: 'room.removeSpectator', playerId: s1.id }]) {
      await expectError(s1, msg, ERR.NOT_HOST);
    }
    await expectError(s1, { t: 'g.ready', ready: true }, ERR.WRONG_PHASE);
    // the cap; spectators never count toward the players: two player seats still free
    const s2 = await pool.player('Watcher2');
    await expectOk(s2, { t: 'room.spectate', code: st.code });
    assert.equal(MAX_SPECTATORS, 2);
    const s3 = await pool.player('Watcher3');
    await expectError(s3, { t: 'room.spectate', code: st.code }, ERR.ROOM_FULL);
    await joinRoom(s3, st.code);
    await expectOk(host, { t: 'room.addBot' });
    const full = await host.waitFor('room.state', (s) => s.seats.every(Boolean));
    assert.equal(full.spectators.length, 2);
    await expectOk(s3, { t: 'room.ready', ready: true });
    await expectOk(guest, { t: 'room.ready', ready: true });
    // a spectator in the lobby takes a free player seat with room.join of the same code
    await expectError(s2, { t: 'room.join', code: st.code }, ERR.ROOM_FULL);
    await expectOk(host, { t: 'room.removeBot', seat: 3 });
    const sat = await joinRoom(s2, st.code);
    assert.equal(seatOf(sat, s2.id).seat, 3);
    assert.deepEqual(sat.spectators.map((x) => x.playerId), [s1.id]);
    // leave
    host.clearInbox();
    await expectOk(s1, { t: 'room.leave' });
    await host.waitFor('room.state', (s) => s.spectators.length === 0);
    await expectError(s1, { t: 'room.leave' }, ERR.NOT_IN_ROOM);
    await expectError(s1, { t: 'room.ready', ready: true }, ERR.NOT_IN_ROOM);
    // host removal: room.closed {kicked}
    const s4 = await pool.player('Watcher4');
    await expectOk(s4, { t: 'room.spectate', code: st.code });
    await host.waitFor('room.state', (s) => s.spectators.length === 1);
    await expectError(host, { t: 'room.removeSpectator', playerId: guest.id }, ERR.BAD_TARGET);
    await expectError(guest, { t: 'room.removeSpectator', playerId: s4.id }, ERR.NOT_HOST);
    await expectOk(host, { t: 'room.removeSpectator', playerId: s4.id });
    assert.equal((await s4.waitFor('room.closed')).reason, 'kicked');
    await host.waitFor('room.state', (s) => s.spectators.length === 0);
    await expectError(s4, { t: 'room.leave' }, ERR.NOT_IN_ROOM);
    // an offline spectator removed: freed at once, told on its next resume
    const s5 = await pool.player('Watcher5');
    await expectOk(s5, { t: 'room.spectate', code: st.code });
    await s5.terminate();
    await host.waitFor('room.state', (s) => s.spectators.find((x) => x.playerId === s5.id)?.connected === false);
    await expectOk(host, { t: 'room.removeSpectator', playerId: s5.id });
    const s5back = await pool.connect();
    await s5back.hello('Watcher5', s5.token);
    assert.equal((await s5back.waitFor('room.closed')).reason, 'kicked');
    await s5back.expectNone('room.state');
    // solo rooms have no spectator seat; unknown codes
    const solo = await pool.player('Solo');
    const soloSt = await createRoom(solo, 'solo', 'FUNNY');
    await expectError(s4, { t: 'room.spectate', code: soloSt.code }, ERR.ROOM_FULL);
    await expectError(s4, { t: 'room.spectate', code: st.code === 'ZZZZ' ? 'YYYY' : 'ZZZZ' }, ERR.ROOM_NOT_FOUND);
    // a spectator never keeps a room alive: its last human leaving closes it for the spectator
    const lone = await pool.player('Lone');
    const loneSt = await createRoom(lone);
    await expectOk(s4, { t: 'room.spectate', code: loneSt.code });
    await lone.waitFor('room.state', (s) => s.spectators.length === 1);
    await expectOk(lone, { t: 'room.leave' });
    assert.equal((await s4.waitFor('room.closed')).reason, 'empty');
    await expectError(s4, { t: 'room.spectate', code: loneSt.code }, ERR.ROOM_NOT_FOUND);
  });

  test('spectators during a match: broadcasts but no private view, join mid-match, only watching, reconnect gets the seat back', async () => {
    const host = await pool.player('Host');
    const st = await createRoom(host);
    const spec = await pool.player('Spec');
    await expectOk(spec, { t: 'room.spectate', code: st.code });
    await expectOk(host, { t: 'room.start' }); // the spectator is no player to wait for
    const pub = await spec.waitFor('m.public');
    assert.deepEqual(pub.players.map((p) => p.playerId), [host.id], 'never one of the match\'s players');
    const late = await pool.player('Late');
    await expectError(late, { t: 'room.join', code: st.code }, ERR.ROOM_STARTED);
    await expectOk(late, { t: 'room.spectate', code: st.code }); // a running match: a spectator seat is still free
    const lateState = await late.waitFor('room.state', (s) => s.inMatch);
    assert.deepEqual(lateState.spectators.map((x) => x.playerId), [spec.id, late.id]);
    for (const msg of [{ t: 'g.infoReady' }, { t: 'g.buy', slot: 0 }, { t: 'g.ready', ready: true }, { t: 'g.emote', id: EMOTES[0] }, { t: 'g.autoplay', on: true }]) {
      await expectError(spec, msg, ERR.SPECTATOR);
    }
    await expectOk(spec, { t: 'room.loadout', entries: {} }); // kept for its session, never handed to the match
    // drop and resume with the token: the seat is kept meanwhile and given back
    await late.terminate();
    await host.waitFor('room.state', (s) => s.spectators.find((x) => x.playerId === late.id)?.connected === false);
    const back = await pool.connect();
    const w = await back.hello('Late', late.token);
    assert.equal(w.resumed, true);
    const rs = await back.waitFor('room.state');
    assert.deepEqual(rs.spectators.find((x) => x.playerId === late.id), { playerId: late.id, name: 'Late', connected: true });
    await expectError(back, { t: 'g.infoReady' }, ERR.SPECTATOR);
    // the match ends: the spectators see the result (a broadcast) and stay in the room, which returns to its lobby
    await expectOk(host, { t: 'g.infoReady' });
    await spec.waitFor('m.result');
    const lobby = await spec.waitFor('room.state', (s) => !s.inMatch && s.spectators.length === 2);
    assert.deepEqual(lobby.spectators.map((x) => x.playerId), [spec.id, late.id]);
    assert.equal(spec.log.filter((x) => x.t === 'm.private').length, 0, 'no private view, ever');
    assert.equal(back.log.filter((x) => x.t === 'm.private').length, 0);
  });

  test('host-only commands, difficulty change un-readies guests, host migration on leave', async () => {
    const host = await pool.player('Host');
    const st = await createRoom(host, 'coop', 'NORMAL');
    const a = await pool.player('A');
    const b = await pool.player('B');
    await joinRoom(a, st.code);
    await joinRoom(b, st.code);
    for (const msg of [{ t: 'room.setDifficulty', difficulty: 'HARD' }, { t: 'room.addBot' }, { t: 'room.removeBot', seat: 0 }, { t: 'room.start' }]) {
      await expectError(a, msg, ERR.NOT_HOST);
    }
    await expectOk(a, { t: 'room.ready', ready: true });
    await host.waitFor('room.state', (s) => seatOf(s, a.id)?.ready);
    await expectOk(host, { t: 'room.setDifficulty', difficulty: 'ABYSS' });
    const changed = await a.waitFor('room.state', (s) => s.difficulty === 'ABYSS');
    assert.equal(seatOf(changed, a.id).ready, false, 'difficulty change resets ready');

    await expectOk(host, { t: 'room.leave' });
    const migrated = await a.waitFor('room.state', (s) => s.hostId !== host.id);
    assert.equal(migrated.hostId, a.id, 'lowest remaining seat becomes host');
    assert.equal(migrated.seats[0], null);
    await b.waitFor('room.state', (s) => s.hostId === a.id);

    // new joiner takes the lowest free seat (0); host stays with A
    const c = await pool.player('C');
    const joined = await joinRoom(c, st.code);
    assert.equal(seatOf(joined, c.id).seat, 0);
    assert.equal(joined.hostId, a.id);
    await expectOk(a, { t: 'room.addBot' });
    const withBot = await c.waitFor('room.state', (s) => s.seats[3]?.isBot);
    assert.equal(withBot.hostId, a.id);
    await expectError(b, { t: 'room.addBot' }, ERR.NOT_HOST);
    await expectError(host, { t: 'room.addBot' }, ERR.NOT_IN_ROOM);
  });

  test('add / remove AI; a room with only AI is disposed', async () => {
    const host = await pool.player('Host');
    const st = await createRoom(host);
    await expectOk(host, { t: 'room.addBot' });
    const s1 = await host.waitFor('room.state', (s) => s.seats[1]?.isBot);
    assert.equal(s1.seats[1].ready, true);
    assert.equal(s1.seats[1].connected, true);
    assert.equal(s1.seats[1].name, BOT_NAMES[0]);
    assert.match(s1.seats[1].playerId, /^ai_[0-9a-f]{8}$/);
    await expectOk(host, { t: 'room.addBot' });
    const s2 = await host.waitFor('room.state', (s) => s.seats[2]?.isBot);
    assert.equal(s2.seats[2].name, BOT_NAMES[1]);

    await expectError(host, { t: 'room.removeBot', seat: 0 }, ERR.BAD_TARGET); // human seat
    await expectError(host, { t: 'room.removeBot', seat: 3 }, ERR.BAD_TARGET); // empty seat
    await expectOk(host, { t: 'room.removeBot', seat: 1 });
    const s3 = await host.waitFor('room.state', (s) => s.seats[1] === null && s.seats[2]?.isBot);
    assert.ok(s3);
    await expectOk(host, { t: 'room.addBot' });
    const s4 = await host.waitFor('room.state', (s) => s.seats[1]?.isBot);
    assert.equal(s4.seats[1].name, BOT_NAMES[0], 'freed bot name is reused');

    await expectOk(host, { t: 'room.leave' });
    const probe = await pool.player('Probe');
    await expectError(probe, { t: 'room.join', code: st.code }, ERR.ROOM_NOT_FOUND);
  });

  test('start flow: readiness gate → stub INFO_CHECK → end → back to LOBBY → play again', async () => {
    const host = await pool.player('Host');
    const st = await createRoom(host, 'coop', 'HARD');
    const guest = await pool.player('Guest');
    await joinRoom(guest, st.code);
    await expectOk(host, { t: 'room.addBot' });
    await expectError(host, { t: 'g.infoReady' }, ERR.WRONG_PHASE); // no match yet
    await expectError(guest, { t: 'room.start' }, ERR.NOT_HOST);
    await expectError(host, { t: 'room.start' }, ERR.NOT_READY);
    await expectOk(guest, { t: 'room.ready', ready: true });

    await expectOk(host, { t: 'room.start' });
    const inMatch = await guest.waitFor('room.state', (s) => s.inMatch);
    assert.equal(inMatch.code, st.code);
    for (const c of [host, guest]) {
      const pub = await c.waitFor('m.public');
      assert.equal(pub.phase, 'INFO_CHECK');
      assert.equal(pub.modeId, 'mode_multi_hard');
      assert.equal(typeof pub.message, 'string');
      assert.ok(pub.deadline > pub.serverNow);
      assert.equal(pub.players.length, 3);
      assert.equal(pub.players.filter((p) => p.isBot).length, 1);
      const priv = await c.waitFor('m.private');
      assert.equal(priv.playerId, c.id);
    }

    // match intents route to the match; lobby intents are refused
    await expectOk(guest, { t: 'g.buy', slot: 0 });
    await expectOk(guest, { t: 'g.emote', id: 'autochess_battle_happy' });
    const emote = await host.waitFor('m.emote');
    assert.deepEqual([emote.playerId, emote.id], [guest.id, 'autochess_battle_happy']);
    await expectError(guest, { t: 'room.ready', ready: false }, ERR.ROOM_STARTED);
    await expectError(host, { t: 'room.start' }, ERR.ROOM_STARTED);
    await expectError(host, { t: 'room.addBot' }, ERR.ROOM_STARTED);
    await expectError(host, { t: 'room.setDifficulty', difficulty: 'FUNNY' }, ERR.ROOM_STARTED);
    await expectError(host, { t: 'room.create', mode: 'coop', difficulty: 'FUNNY' }, ERR.ROOM_STARTED);
    const outsider = await pool.player('Outsider');
    await expectError(outsider, { t: 'room.join', code: st.code }, ERR.ROOM_STARTED);
    await expectError(outsider, { t: 'g.buy', slot: 0 }, ERR.NOT_IN_ROOM);
    const other = await createRoom(outsider);
    await expectError(host, { t: 'room.join', code: other.code }, ERR.ROOM_STARTED);

    // stub ends once every human confirmed the briefing
    host.clearInbox();
    await expectOk(host, { t: 'g.infoReady' });
    await expectOk(guest, { t: 'g.infoReady' });
    const result = await host.waitFor('m.result');
    assert.equal(result.stub, true);
    const back = await host.waitFor('room.state', (s) => !s.inMatch);
    assert.equal(back.hostId, host.id);
    assert.equal(seatOf(back, guest.id).ready, false, 'humans un-ready after a match');
    assert.equal(back.seats.filter((s) => s?.isBot).length, 1, 'bots stay');
    await expectError(guest, { t: 'g.infoReady' }, ERR.WRONG_PHASE);

    // play again
    await expectOk(guest, { t: 'room.ready', ready: true });
    guest.clearInbox();
    await expectOk(host, { t: 'room.start' });
    const again = await guest.waitFor('m.public', (m) => m.phase === 'INFO_CHECK');
    assert.ok(again.players.every((p) => p.isBot || !p.ready), 'fresh match state');
  });

  test('solo room: host starts alone', async () => {
    const solo = await pool.player('Solo');
    await createRoom(solo, 'solo', 'FUNNY');
    await expectOk(solo, { t: 'room.start' });
    const pub = await solo.waitFor('m.public');
    assert.equal(pub.phase, 'INFO_CHECK');
    assert.equal(pub.modeId, 'mode_single_funny');
    assert.equal(pub.lastRound, 9);
    await expectOk(solo, { t: 'g.infoReady' });
    await solo.waitFor('m.result');
    await solo.waitFor('room.state', (s) => !s.inMatch && s.mode === 'solo');
  });

  test('reconnect with token in LOBBY restores the seat', async () => {
    const host = await pool.player('Host');
    const st = await createRoom(host);
    const guest = await pool.player('Guest');
    await joinRoom(guest, st.code);
    await expectOk(guest, { t: 'room.ready', ready: true });
    await host.waitFor('room.state', (s) => seatOf(s, guest.id)?.ready);
    await guest.terminate();
    const dropped = await host.waitFor('room.state', (s) => seatOf(s, guest.id)?.connected === false);
    assert.equal(seatOf(dropped, guest.id).seat, 1);
    await expectError(host, { t: 'room.start' }, ERR.NOT_READY); // disconnected humans block the start

    host.clearInbox();
    const back = await pool.connect();
    const w = await back.hello('Guest2', guest.token);
    assert.equal(w.resumed, true);
    assert.equal(w.playerId, guest.id);
    assert.equal(w.token, guest.token);
    const restored = await back.waitFor('room.state');
    assert.equal(restored.code, st.code);
    assert.deepEqual(seatOf(restored, guest.id), { seat: 1, playerId: guest.id, name: 'Guest2', isBot: false, ready: true, connected: true });
    await host.waitFor('room.state', (s) => seatOf(s, guest.id)?.connected === true);

    // an unknown token just creates a new identity
    const stranger = await pool.connect();
    const sw = await stranger.hello('Stranger', 'f'.repeat(32));
    assert.equal(sw.resumed, false);
    assert.notEqual(sw.playerId, guest.id);
  });

  test('reconnect with token during a match restores seat and resends match state', async () => {
    const host = await pool.player('Host');
    const st = await createRoom(host);
    const guest = await pool.player('Guest');
    await joinRoom(guest, st.code);
    await expectOk(guest, { t: 'room.ready', ready: true });
    await expectOk(host, { t: 'room.start' });
    await guest.waitFor('m.public');
    await host.waitFor('m.public');

    await guest.terminate();
    await host.waitFor('room.state', (s) => s.inMatch && seatOf(s, guest.id)?.connected === false);
    const pubDrop = await host.waitFor('m.public', (m) => m.players.some((p) => p.playerId === guest.id && !p.connected));
    assert.ok(pubDrop);

    const back = await pool.connect();
    const w = await back.hello('Guest', guest.token);
    assert.equal(w.resumed, true);
    assert.equal(w.playerId, guest.id);
    const rs = await back.waitFor('room.state');
    assert.equal(rs.inMatch, true);
    assert.equal(seatOf(rs, guest.id).connected, true);
    const pub = await back.waitFor('m.public');
    assert.equal(pub.phase, 'INFO_CHECK');
    const priv = await back.waitFor('m.private');
    assert.equal(priv.playerId, guest.id);
    await expectOk(back, { t: 'g.refresh' });
  });

  test('same token on a second socket replaces the first (close 4001)', async () => {
    const a = await pool.player('Twin');
    const st = await createRoom(a);
    const b = await pool.connect();
    const w = await b.hello('Twin', a.token);
    assert.equal(w.resumed, true);
    const info = await a.closed;
    assert.equal(info.code, 4001);
    const rs = await b.waitFor('room.state');
    assert.equal(rs.code, st.code);
    assert.equal(seatOf(rs, a.id).connected, true, 'old socket closing does not mark the session disconnected');
    await delay(50);
    await expectOk(b, { t: 'room.ready', ready: true });
    const ready = await b.waitFor('room.state', (s) => seatOf(s, a.id)?.ready);
    assert.equal(seatOf(ready, a.id).connected, true);
  });

  test('g.leave / room.leave during a match departs permanently; seat freed when the match ends', async () => {
    const host = await pool.player('Host');
    const st = await createRoom(host);
    const guest = await pool.player('Guest');
    await joinRoom(guest, st.code);
    await expectOk(guest, { t: 'room.ready', ready: true });
    await expectOk(host, { t: 'room.start' });
    await guest.waitFor('m.public');
    await expectOk(guest, { t: 'g.leave' });
    const st2 = await host.waitFor('room.state', (s) => s.inMatch && seatOf(s, guest.id)?.connected === false);
    assert.equal(seatOf(st2, guest.id).seat, 1, 'seat kept during the match');
    await expectError(guest, { t: 'g.infoReady' }, ERR.NOT_IN_ROOM);
    await expectError(guest, { t: 'room.join', code: st.code }, ERR.ROOM_STARTED);
    // the departed player is free to do other things
    await createRoom(guest);
    // host finishes; stub counts departed players as ready
    host.clearInbox();
    await expectOk(host, { t: 'g.infoReady' });
    const back = await host.waitFor('room.state', (s) => !s.inMatch);
    assert.equal(seatOf(back, guest.id), null, 'departed seat freed');

    // host leaving a running match with nobody else disposes the room
    host.clearInbox();
    await expectOk(host, { t: 'room.start' });
    await host.waitFor('m.public', (m) => m.phase === 'INFO_CHECK');
    await expectOk(host, { t: 'room.leave' });
    const probe = await pool.player('Probe');
    await expectError(probe, { t: 'room.join', code: st.code }, ERR.ROOM_NOT_FOUND);
  });

  test('protocol fuzz: random intents never crash the server or corrupt lobby invariants', async () => {
    let seed = 0x5eed1234;
    const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const clients = [];
    for (let i = 0; i < 5; i++) clients.push(await pool.player(`F${i}`));
    const codes = () => [...srv.lobby.rooms.keys()];
    const gTypes = ['g.infoReady', 'g.band', 'g.bandSkip', 'g.buy', 'g.refresh', 'g.freeze', 'g.levelUp', 'g.sell', 'g.move', 'g.equip', 'g.art', 'g.destroy', 'g.reward', 'g.choice', 'g.ready', 'g.emote', 'g.watch', 'g.autoplay', 'g.leave'];
    const junk = [1, -1, 1.5, 'x', '', null, true, [], {}, { area: 'board', row: 1, col: 1 }, 'A'.repeat(70), 2 ** 40];
    const gen = () => {
      const r = rnd();
      if (r < 0.12) return { t: 'room.create', mode: pick(['solo', 'coop', 'coop', 'x']), difficulty: pick(['FUNNY', 'NORMAL', 'HARD', 'ABYSS', 'nope']) };
      if (r < 0.25) return { t: 'room.join', code: pick([...codes(), 'ZZZZ', 'abc', ...codes().map((c) => c.toLowerCase())]) || 'QQQQ' };
      if (r < 0.32) return { t: 'room.leave' };
      if (r < 0.42) return { t: 'room.ready', ready: pick([true, false, 'x']) };
      if (r < 0.47) return { t: 'room.setDifficulty', difficulty: pick(['FUNNY', 'ABYSS', 1]) };
      if (r < 0.55) return { t: 'room.addBot' };
      if (r < 0.60) return { t: 'room.removeBot', seat: pick([0, 1, 2, 3, 4, -1, 'x']) };
      if (r < 0.68) return { t: 'room.start' };
      if (r < 0.90) {
        const m = { t: pick(gTypes) };
        for (const k of ['bandId', 'slot', 'uid', 'to', 'itemUid', 'targetUid', 'row', 'col', 'idx', 'ready', 'id', 'fieldId', 'on']) if (rnd() < 0.3) m[k] = pick(junk);
        if (m.t === 'g.emote' && rnd() < 0.5) m.id = 'autochess_battle_happy';
        return m;
      }
      // spectator seats (community report #26)
      if (r < 0.95) {
        return rnd() < 0.7
          ? { t: 'room.spectate', code: pick([...codes(), 'ZZZZ', ...codes().map((c) => c.toLowerCase())]) || 'QQQQ' }
          : { t: 'room.removeSpectator', playerId: pick([...clients.map((x) => x.id), 'p_nope', 1]) };
      }
      return pick([{ t: 'hello', name: pick(['Re', '', 'x'.repeat(20)]) }, { t: 'ping', c: pick([1, 'x']) }, { t: pick(['nope', '__proto__', 'toString']) }, { t: 'room.join', code: pick(junk) }]);
    };
    const okCounts = {};
    for (let i = 0; i < 500; i++) {
      const k = Math.floor(rnd() * clients.length);
      let c = clients[k];
      if (rnd() < 0.04) { // drop & resume
        await c.terminate();
        const back = await pool.connect();
        const w = await back.hello(`F${k}`, c.token);
        Object.assign(back, { id: w.playerId, token: w.token });
        clients[k] = c = back;
        continue;
      }
      const msg = gen();
      const reply = await c.request(msg, 3000);
      assert.ok(['ok', 'error', 'welcome', 'pong'].includes(reply.t));
      if (reply.t === 'ok') okCounts[msg.t] = (okCounts[msg.t] || 0) + 1;
      if (reply.t === 'error') assert.ok(Object.hasOwn(ERR, reply.code), reply.code);
      if (i % 50 === 0) await delay(30); // stay well under the rate limit
    }
    for (const t of ['room.create', 'room.join', 'room.start', 'room.addBot', 'g.infoReady']) assert.ok(okCounts[t] > 0, `fuzz never succeeded at ${t}`);
    // invariants
    const seen = new Set();
    for (const room of srv.lobby.rooms.values()) {
      const humans = room.activeHumans();
      assert.ok(humans.length >= 1, `room ${room.code} has no humans`);
      assert.ok(humans.some((h) => h.playerId === room.hostId), `room ${room.code} host is not an active human`);
      if (room.mode === 'solo') assert.ok(room.seats.filter(Boolean).length === 1);
      room.seats.forEach((s, i) => { if (s) assert.equal(s.seat, i); });
      for (const h of humans) {
        assert.ok(!seen.has(h.playerId), 'player seated twice');
        seen.add(h.playerId);
        const sess = srv.registry.byId(h.playerId);
        assert.ok(sess, 'seated session exists');
        assert.equal(sess.roomCode, room.code);
      }
      // spectator seats: capped, none in solo rooms, never also a player (here or elsewhere), never the host
      assert.ok(room.spectators.length <= MAX_SPECTATORS, `room ${room.code} spectator cap`);
      if (room.mode === 'solo') assert.equal(room.spectators.length, 0, 'no spectator seat in a solo room');
      for (const sp of room.spectators) {
        assert.ok(!seen.has(sp.playerId), 'a spectator is seated (or spectating) twice');
        seen.add(sp.playerId);
        assert.ok(!room.seatOf(sp.playerId) && room.hostId !== sp.playerId);
        assert.equal(srv.registry.byId(sp.playerId)?.roomCode, room.code, 'the spectator\'s session points at its room');
      }
    }
    if (okCounts['room.spectate'] == null) assert.fail('fuzz never took a spectator seat');
    for (const sess of srv.registry.all()) {
      const r = sess.roomCode ? srv.lobby.rooms.get(sess.roomCode) : null;
      if (sess.roomCode) assert.ok(r?.seatOf(sess.playerId) || r?.spectatorOf(sess.playerId), 'session points at its seat');
    }
    const h = JSON.parse((await httpReq(srv.port, '/healthz')).body.toString());
    assert.equal(h.ok, true);
  });

  test('frames still in flight from a replaced socket are ignored (no orphan sessions)', async () => {
    for (let i = 0; i < 5; i++) {
      const a = await pool.player('Twin');
      const before = srv.registry.size;
      const b = await pool.connect();
      b.send({ t: 'hello', name: 'Twin', token: a.token, version: 1 });
      for (let k = 0; k < 5; k++) a.send({ t: 'hello', name: 'Ghost', version: 1 });
      a.send({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
      const info = await a.closed;
      assert.equal(info.code, 4001);
      const w = await b.waitFor('welcome');
      assert.equal(w.playerId, a.id);
      await delay(30);
      assert.equal(srv.registry.size, before, 'no session minted by the replaced socket');
      assert.ok(![...srv.registry.all()].some((x) => x.name === 'Ghost'));
    }
  });

  test('repeated hello resyncs only the requester unless the seat visibly changed', async () => {
    const host = await pool.player('Host');
    const st = await createRoom(host);
    const guest = await pool.player('Guest');
    await joinRoom(guest, st.code);
    await host.waitFor('room.state', (s) => !!seatOf(s, guest.id));
    host.clearInbox();
    guest.clearInbox();
    for (let i = 0; i < 5; i++) await guest.hello('Guest');
    for (let i = 0; i < 5; i++) await guest.waitFor('room.state', (s) => s.code === st.code);
    await host.expectNone('room.state');
    await guest.hello('Renamed');
    const renamed = await host.waitFor('room.state', (s) => seatOf(s, guest.id)?.name === 'Renamed');
    assert.equal(renamed.hostId, host.id);
  });

  test('resend-heavy intents (g.watch) have their own small bucket: RATE, socket survives, bucket refills', async () => {
    const c = await pool.player('Watcher');
    await createRoom(c, 'solo', 'NORMAL');
    await expectOk(c, { t: 'room.start' });
    await c.waitFor('m.public');
    const replies = [];
    for (let i = 0; i < 20; i++) replies.push(c.request({ t: 'g.watch', fieldId: 'f0' }));
    const got = await Promise.all(replies);
    const oks = got.filter((r) => r.t === 'ok').length;
    const rated = got.filter((r) => r.t === 'error' && r.code === ERR.RATE).length;
    assert.equal(oks + rated, 20);
    assert.ok(oks >= 6 && oks <= 8, `burst of ~6 accepted, got ${oks}`);
    await expectOk(c, { t: 'g.emote', id: 'autochess_battle_happy' }); // other intents are unaffected
    await delay(600);
    await expectOk(c, { t: 'g.watch', fieldId: 'f0' });
    assert.ok(c.isOpen);
  });

  test('healthz counts rooms and sockets', async () => {
    const c = await pool.player('Counter');
    await createRoom(c);
    const r = await httpReq(srv.port, '/healthz');
    const h = JSON.parse(r.body.toString());
    assert.ok(h.rooms >= 1);
    assert.ok(h.sockets >= 1);
    assert.ok(h.sessions >= 1);
  });
});

// ---------------------------------------------------------------------------------------------------
// Short timers + instrumented match
// ---------------------------------------------------------------------------------------------------

class RecordingMatch extends Match {
  static instances = [];
  static failStart = false;
  constructor(opts) {
    super(opts);
    this.opts = opts;
    this.calls = [];
    RecordingMatch.instances.push(this);
  }
  start() {
    this.calls.push(['start']);
    if (RecordingMatch.failStart) throw new Error('intentional start failure');
    super.start();
  }
  handle(playerId, msg) {
    this.calls.push(['handle', playerId, msg.t]);
    if (msg.t === 'g.buy' && msg.slot === 13) throw new Error('intentional handler crash');
    if (msg.t === 'g.sell') return { error: ERR.NO_FUNDS };
    if (msg.t === 'g.freeze') return { error: 'NOT_A_REAL_CODE' };
    if (msg.t === 'g.destroy') return { error: 'constructor' };
    if (msg.t === 'g.levelUp') return undefined;
    if (msg.t === 'g.autoplay') return Promise.reject(new Error('async handler rejection'));
    return super.handle(playerId, msg);
  }
  onDisconnect(playerId) { this.calls.push(['onDisconnect', playerId]); super.onDisconnect(playerId); }
  onReconnect(playerId) { this.calls.push(['onReconnect', playerId]); super.onReconnect(playerId); }
  onLeave(playerId) { this.calls.push(['onLeave', playerId]); super.onLeave(playerId); }
  addSpectator(playerId) { this.calls.push(['addSpectator', playerId]); }
  removeSpectator(playerId) { this.calls.push(['removeSpectator', playerId]); }
  dispose() { this.calls.push(['dispose']); super.dispose(); }
}

describe('lobby timers and match interface', () => {
  let srv;
  let pool;
  const cap = captureLog();
  const GRACE = 300;
  const WINDOW = 1200;

  before(async () => {
    srv = await startServer({
      port: 0, host: '127.0.0.1', log: cap.log, MatchClass: RecordingMatch, seedFn: () => 123456789,
      lobbyGraceMs: GRACE, reconnectWindowMs: WINDOW,
    });
    pool = clientPool(() => `ws://127.0.0.1:${srv.port}/ws`);
  });
  afterEach(async () => {
    RecordingMatch.failStart = false;
    await pool.closeAll();
  });
  after(async () => { await srv?.close(); });

  test('lobby grace: disconnected guest is removed, then told room.closed{timeout} on resume', async () => {
    const host = await pool.player('Host');
    const st = await createRoom(host);
    const guest = await pool.player('Guest');
    await joinRoom(guest, st.code);
    await guest.terminate();
    await host.waitFor('room.state', (s) => seatOf(s, guest.id)?.connected === false);
    const removed = await host.waitFor('room.state', (s) => s.seats[1] === null, GRACE + 1000);
    assert.equal(removed.hostId, host.id);
    const back = await pool.connect();
    const w = await back.hello('Guest', guest.token);
    assert.equal(w.resumed, true);
    const closed = await back.waitFor('room.closed');
    assert.equal(closed.reason, 'timeout');
    await back.expectNone('room.state');
  });

  test('lobby grace: host removed → host migrates to the connected guest', async () => {
    const host = await pool.player('Host');
    const st = await createRoom(host);
    const guest = await pool.player('Guest');
    await joinRoom(guest, st.code);
    await host.terminate();
    const migrated = await guest.waitFor('room.state', (s) => s.hostId === guest.id, GRACE + 1000);
    assert.equal(migrated.seats[0], null);
    await expectOk(guest, { t: 'room.addBot' });
  });

  test('spectator seats: lobby grace like a player; never the host; the match hooks (opts.spectators, addSpectator / removeSpectator, only g.watch)', async () => {
    const host = await pool.player('Host');
    const st = await createRoom(host);
    const spec = await pool.player('Spec');
    await expectOk(spec, { t: 'room.spectate', code: st.code });
    // a dropped spectator keeps its seat for the lobby grace, then is freed and told room.closed {timeout} on resume
    const gone = await pool.player('Gone');
    await expectOk(gone, { t: 'room.spectate', code: st.code });
    await gone.terminate();
    await host.waitFor('room.state', (s) => s.spectators.find((x) => x.playerId === gone.id)?.connected === false);
    host.clearInbox();
    await host.waitFor('room.state', (s) => s.spectators.length === 1, GRACE + 1000);
    const goneBack = await pool.connect();
    await goneBack.hello('Gone', gone.token);
    assert.equal((await goneBack.waitFor('room.closed')).reason, 'timeout');
    // the match: the spectator is passed apart from the seats
    RecordingMatch.instances.length = 0;
    await expectOk(host, { t: 'room.start' });
    const m = RecordingMatch.instances[0];
    assert.deepEqual(m.opts.spectators, [spec.id]);
    assert.deepEqual(m.opts.seats.map((s) => s.playerId), [host.id]);
    // only g.watch of a spectator reaches the match
    await expectError(spec, { t: 'g.levelUp' }, ERR.SPECTATOR);
    await spec.request({ t: 'g.watch', fieldId: `n:${host.id}` });
    assert.deepEqual(m.calls.filter((c) => c[0] === 'handle' && c[1] === spec.id).map((c) => c[2]), ['g.watch']);
    // joining mid-match, a drop (the match is not told), a resume (resync) → addSpectator; leaving → removeSpectator
    const late = await pool.player('Late');
    await expectOk(late, { t: 'room.spectate', code: st.code });
    await late.terminate();
    await host.waitFor('room.state', (s) => s.spectators.find((x) => x.playerId === late.id)?.connected === false);
    host.clearInbox();
    const back = await pool.connect();
    await back.hello('Late', late.token);
    await host.waitFor('room.state', (s) => s.spectators.find((x) => x.playerId === late.id)?.connected === true);
    await expectOk(back, { t: 'g.leave' });
    await host.waitFor('room.state', (s) => s.spectators.length === 1);
    const hooks = m.calls.filter((c) => c[1] === late.id).map((c) => c[0]);
    assert.deepEqual(hooks, ['addSpectator', 'addSpectator', 'removeSpectator'], 'never onDisconnect / onReconnect / onLeave');
    // the host leaves mid-match: a spectator never becomes the host and never keeps the room
    await expectOk(host, { t: 'room.leave' });
    assert.equal((await spec.waitFor('room.closed')).reason, 'empty');
  });

  test('match number: every match of a room gets the next matchNo (battleIds stay unique even with the same seed)', async () => {
    const solo = await pool.player('Solo');
    await createRoom(solo, 'solo', 'FUNNY');
    RecordingMatch.instances.length = 0;
    for (let i = 0; i < 2; i++) {
      solo.clearInbox();
      await expectOk(solo, { t: 'room.start' });
      await solo.waitFor('m.public', (p) => p.phase === 'INFO_CHECK');
      await expectOk(solo, { t: 'g.infoReady' }); // the stub ends once every human confirmed the briefing
      await solo.waitFor('room.state', (s) => !s.inMatch);
    }
    assert.deepEqual(RecordingMatch.instances.map((m) => [m.opts.seed, m.opts.matchNo]), [[123456789, 1], [123456789, 2]]);
    await expectOk(solo, { t: 'room.leave' });
  });

  test('match hooks: seats/seed passed, onDisconnect/onReconnect, handler results, crash → INTERNAL', async () => {
    const host = await pool.player('Host');
    const st = await createRoom(host, 'coop', 'ABYSS');
    const guest = await pool.player('Guest');
    await joinRoom(guest, st.code);
    await expectOk(host, { t: 'room.addBot' });
    await expectOk(guest, { t: 'room.ready', ready: true });
    RecordingMatch.instances.length = 0;
    await expectOk(host, { t: 'room.start' });
    const m = RecordingMatch.instances[0];
    assert.ok(m);
    assert.equal(m.opts.roomCode, st.code);
    assert.equal(m.opts.mode, 'coop');
    assert.equal(m.opts.difficulty, 'ABYSS');
    assert.equal(m.opts.modeId, 'mode_multi_abyss');
    assert.equal(m.opts.seed, 123456789);
    assert.equal(typeof m.opts.data, 'object');
    assert.deepEqual(m.opts.seats.map((s) => [s.seat, s.isBot, s.connected]), [[0, false, true], [1, false, true], [2, true, true]]);
    assert.equal(m.opts.seats[0].playerId, host.id);

    await expectError(guest, { t: 'g.sell', uid: 1 }, ERR.NO_FUNDS);
    await expectError(guest, { t: 'g.freeze' }, ERR.INTERNAL);
    await expectError(guest, { t: 'g.destroy', uid: 5 }, ERR.INTERNAL);
    await expectOk(guest, { t: 'g.levelUp' });
    await expectError(guest, { t: 'g.buy', slot: 13 }, ERR.INTERNAL);
    assert.ok(guest.isOpen);
    await expectOk(guest, { t: 'g.autoplay', on: true }); // contract violation (async) is logged, never unhandled
    await delay(10);
    assert.ok(cap.errors.some((e) => e.includes('returned a Promise')));
    assert.ok(cap.errors.some((e) => e.includes('async handler rejection')));
    await expectOk(guest, { t: 'g.buy', slot: 1 });
    assert.ok(!m.calls.some((c) => c[0] === 'handle' && c[2] === 'g.leave'));

    await guest.terminate();
    await host.waitFor('room.state', (s) => seatOf(s, guest.id)?.connected === false);
    assert.deepEqual(m.calls.filter((c) => c[0] === 'onDisconnect'), [['onDisconnect', guest.id]]);
    const back = await pool.connect();
    await back.hello('Guest', guest.token);
    await back.waitFor('m.private');
    assert.deepEqual(m.calls.filter((c) => c[0] === 'onReconnect'), [['onReconnect', guest.id]]);

    // repeated hello = cheap resync
    await back.hello('Guest');
    await back.waitFor('m.private');
    assert.equal(m.calls.filter((c) => c[0] === 'onReconnect').length, 2);

    await expectOk(host, { t: 'g.infoReady' });
    await expectOk(back, { t: 'g.infoReady' });
    await host.waitFor('room.state', (s) => !s.inMatch);
    await delay(20);
    assert.equal(m.calls.filter((c) => c[0] === 'dispose').length, 1, 'disposed exactly once after onEnd');
    assert.ok(cap.errors.some((e) => e.includes('intentional handler crash')));
  });

  test('user Given a running match When sending repeated hellos Then resyncs coalesce within the time window', { timeout: 10000 }, async (t) => {
    const host = await pool.player('Host');
    await createRoom(host, 'solo', 'NORMAL');
    RecordingMatch.instances.length = 0;
    await expectOk(host, { t: 'room.start' });
    await host.waitFor('m.private');
    // Real socket processing may cross the resync window on a busy runner.
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    const clock = srv.lobby.now;
    srv.lobby.now = () => Date.now();
    t.after(() => { srv.lobby.now = clock; });
    const m = RecordingMatch.instances[0];
    const resyncs = () => m.calls.filter((c) => c[0] === 'onReconnect').length;
    host.clearInbox();
    for (let i = 0; i < 12; i++) await host.hello('Host');
    for (let i = 0; i < 12; i++) await host.waitFor('room.state'); // the cheap part answers every hello
    assert.equal(resyncs(), 1, 'first repeated hello resyncs at once, the rest wait for the window');
    await host.waitFor('m.private');
    t.mock.timers.tick(999);
    assert.equal(resyncs(), 1, 'no deferred resync before the window ends');
    t.mock.timers.tick(1);
    await host.waitFor('m.private', () => true, 1500); // one coalesced resync answers the other 11
    assert.equal(resyncs(), 2);
    t.mock.timers.tick(1100);
    assert.equal(resyncs(), 2, 'nothing else was queued');
    // a (re)connect is never delayed
    await host.terminate();
    const back = await pool.connect();
    await back.hello('Host', host.token);
    await back.waitFor('m.private');
    assert.equal(resyncs(), 3);
  });

  test('match start failure → INTERNAL, room stays in LOBBY', async () => {
    const host = await pool.player('Host');
    await createRoom(host, 'solo', 'NORMAL');
    RecordingMatch.failStart = true;
    RecordingMatch.instances.length = 0;
    await expectError(host, { t: 'room.start' }, ERR.INTERNAL);
    const st = await host.waitFor('room.state', (s) => !s.inMatch && RecordingMatch.instances.length === 1);
    assert.equal(st.inMatch, false);
    await delay(10);
    assert.deepEqual(RecordingMatch.instances[0].calls.map((c) => c[0]), ['start', 'dispose']);
    RecordingMatch.failStart = false;
    await expectOk(host, { t: 'room.start' });
    await host.waitFor('m.public');
  });

  test('reconnect window expiry during a match → onLeave; old token no longer resumes; empty room disposed', async () => {
    const host = await pool.player('Host');
    const st = await createRoom(host);
    const guest = await pool.player('Guest');
    await joinRoom(guest, st.code);
    await expectOk(guest, { t: 'room.ready', ready: true });
    RecordingMatch.instances.length = 0;
    await expectOk(host, { t: 'room.start' });
    const m = RecordingMatch.instances[0];
    await guest.terminate();
    await host.waitFor('room.state', (s) => seatOf(s, guest.id)?.connected === false);
    await delay(WINDOW + 700);
    assert.deepEqual(m.calls.filter((c) => c[0] === 'onLeave'), [['onLeave', guest.id]]);
    const back = await pool.connect();
    const w = await back.hello('Guest', guest.token);
    assert.equal(w.resumed, false);
    assert.notEqual(w.playerId, guest.id);

    // host drops too and never returns → room disposed after the window
    await host.terminate();
    await delay(WINDOW + 700);
    assert.ok(m.calls.some((c) => c[0] === 'dispose'));
    await expectError(back, { t: 'room.join', code: st.code }, ERR.ROOM_NOT_FOUND);
  });

  test('match ending while a human is disconnected gives that human the lobby grace', async () => {
    const host = await pool.player('Host');
    const st = await createRoom(host);
    const guest = await pool.player('Guest');
    await joinRoom(guest, st.code);
    await expectOk(guest, { t: 'room.ready', ready: true });
    await expectOk(host, { t: 'room.start' });
    await expectOk(guest, { t: 'g.infoReady' });
    await guest.terminate();
    await host.waitFor('room.state', (s) => seatOf(s, guest.id)?.connected === false);
    host.clearInbox();
    await expectOk(host, { t: 'g.infoReady' }); // disconnected guest already ready → match ends
    const lobbyState = await host.waitFor('room.state', (s) => !s.inMatch);
    assert.equal(seatOf(lobbyState, guest.id)?.connected, false);
    const freed = await host.waitFor('room.state', (s) => !s.inMatch && s.seats[1] === null, GRACE + 1000);
    assert.ok(freed);
  });

  test('a dropped solo run keeps the official singleReconnectTime (24 h), not the 10-minute window', () => {
    assert.equal(srv.lobby.soloResumeWindowMs(), 86_400 * 1000, 'data config.constants.singleReconnectTime');
    assert.ok(srv.lobby.soloResumeWindowMs() > WINDOW);
  });
});

// ---------------------------------------------------------------------------------------------------
// Solo runs: 下半 solo has no prep / 机变 timer and may be resumed within singleReconnectTime (24 h, research 01 §1,
// 06 §17); only co-op sessions expire after the reconnect window (real Match: the untimed solo match waits).
// ---------------------------------------------------------------------------------------------------

describe('solo resume window', () => {
  const WINDOW = 300;       // stands in for the 10-minute reconnect window
  const SOLO_WINDOW = 1500; // stands in for singleReconnectTime (24 h)
  let srv;
  let url;
  const open = [];
  const cap = captureLog();

  before(async () => {
    srv = await startServer({
      port: 0, host: '127.0.0.1', log: cap.log, MatchClass: RealMatch, seedFn: () => 20260929,
      reconnectWindowMs: WINDOW, soloReconnectWindowMs: SOLO_WINDOW, lobbyGraceMs: 200,
    });
    url = `ws://127.0.0.1:${srv.port}/ws`;
  });
  after(async () => {
    await Promise.all(open.map((c) => c.terminate().catch(() => {})));
    await srv?.close();
    assert.deepEqual(cap.errors, [], 'no server errors logged');
  });
  const connect = async () => { const c = await TestClient.connect(url); open.push(c); return c; };

  test('solo: resumable past the reconnect window, the match waits; expires only after the solo window', async () => {
    const a = await connect();
    const w = await a.hello('Solo');
    a.id = w.playerId;
    const st = await createRoom(a, 'solo', 'NORMAL');
    await expectOk(a, { t: 'room.start' });
    await a.waitFor('m.public', (p) => p.phase === PHASE.INFO_CHECK && p.deadline === 0);
    const room = srv.lobby.getRoom(st.code);
    const match = room.match;
    await a.terminate();
    await delay(WINDOW + 600); // several sweeps past the co-op window
    assert.equal(room.match, match, 'the solo match still runs');
    assert.equal(match.players.get(a.id).left, false, 'not treated as a quit');

    const b = await connect();
    const w2 = await b.hello('Solo', w.token);
    assert.equal(w2.resumed, true);
    assert.equal(w2.playerId, a.id);
    assert.equal((await b.waitFor('room.state')).inMatch, true);
    await b.waitFor('m.public', (p) => p.phase === PHASE.INFO_CHECK);
    await b.waitFor('m.private');

    // a reconnect re-evaluates the window: the extension is set at every drop, and still ends after the solo window
    await b.terminate();
    await delay(SOLO_WINDOW + 700);
    assert.equal(match.ended, true, 'expiry after the solo window → onLeave → abandoned');
    assert.equal(srv.lobby.getRoom(st.code), null, 'empty room disposed');
    const c = await connect();
    const w3 = await c.hello('Solo', w.token);
    assert.equal(w3.resumed, false);
    assert.notEqual(w3.playerId, a.id);
  });

  test('co-op sessions keep the plain reconnect window; a solo player back in the lobby too', async () => {
    const a = await connect();
    const w = await a.hello('Coop');
    a.id = w.playerId;
    const st = await createRoom(a, 'coop', 'NORMAL');
    await expectOk(a, { t: 'room.addBot' });
    await expectOk(a, { t: 'room.start' });
    await a.waitFor('m.public', (p) => p.phase === PHASE.INFO_CHECK);
    const match = srv.lobby.getRoom(st.code).match;
    await a.terminate();
    await delay(WINDOW + 600);
    assert.equal(match.players.get(a.id).left, true, 'co-op: the window expired → onLeave');
    const b = await connect();
    assert.equal((await b.hello('Coop', w.token)).resumed, false);

    // solo room without a running match: no extension (the lobby grace frees the seat anyway)
    const s = await connect();
    const ws = await s.hello('Idle');
    s.id = ws.playerId;
    await createRoom(s, 'solo', 'NORMAL');
    await s.terminate();
    await delay(WINDOW + 600);
    const s2 = await connect();
    assert.equal((await s2.hello('Idle', ws.token)).resumed, false);
  });
});

// ---------------------------------------------------------------------------------------------------
// Result replay: humans who miss m.result (dropped socket, reloaded tab) still get the result screen
// ---------------------------------------------------------------------------------------------------

/** Stub match that, like the real Match, sends m.result per player (unicast) when `unicast` is set. */
class ReplayMatch extends Match {
  static unicast = false;
  static instances = [];
  constructor(opts) { super(opts); ReplayMatch.instances.push(this); }
  maybeFinish(deadlinePassed) {
    if (!ReplayMatch.unicast) { super.maybeFinish(deadlinePassed); return; }
    if (this.ended || this.disposed) return;
    if (!deadlinePassed) for (const p of this.players.values()) if (!p.isBot && !p.left && !p.ready) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.ended = true;
    this.phase = PHASE.RESULT;
    this.broadcastFn(this.publicView());
    for (const p of this.players.values()) {
      if (!p.isBot && !p.left) this.sendFn(p.playerId, { t: 'm.result', victory: true, roundsPassed: 7, playerId: p.playerId, players: [] });
    }
    this.onEndFn({ victory: true });
  }
}

describe('match result replay', () => {
  let srv;
  let pool;
  const cap = captureLog();
  const GRACE = 400;

  before(async () => {
    srv = await startServer({ port: 0, host: '127.0.0.1', log: cap.log, MatchClass: ReplayMatch, lobbyGraceMs: GRACE, resyncMinGapMs: 200 });
    pool = clientPool(() => `ws://127.0.0.1:${srv.port}/ws`);
  });
  afterEach(async () => {
    ReplayMatch.unicast = false;
    await pool.closeAll();
  });
  after(async () => {
    await srv?.close();
    assert.deepEqual(cap.errors, [], 'no server errors logged');
  });

  /** Host + guest co-op match; the guest drops, then the host's infoReady ends it. */
  async function endWhileGuestAway() {
    const host = await pool.player('Host');
    const st = await createRoom(host);
    const guest = await pool.player('Guest');
    await joinRoom(guest, st.code);
    await expectOk(guest, { t: 'room.ready', ready: true });
    await expectOk(host, { t: 'room.start' });
    await expectOk(guest, { t: 'g.infoReady' });
    await guest.terminate();
    await host.waitFor('room.state', (s) => seatOf(s, guest.id)?.connected === false);
    await expectOk(host, { t: 'g.infoReady' });
    const hostResult = await host.waitFor('m.result');
    await host.waitFor('room.state', (s) => !s.inMatch);
    return { host, guest, st, hostResult };
  }

  /** Frames of a resumed socket in arrival order (types + phase), after welcome. */
  const order = (c) => c.log.filter((m) => m.t !== 'welcome' && m.t !== 'pong').map((m) => m.t + (m.t === 'm.public' ? `:${m.phase}` : ''));

  for (const unicast of [true, false]) {
    test(`a human disconnected when the match ends gets room.state, the final m.public and m.result on resume (${unicast ? 'per-player' : 'broadcast'} result)`, async () => {
      ReplayMatch.unicast = unicast;
      const { guest, hostResult } = await endWhileGuestAway();
      if (unicast) assert.notEqual(hostResult.playerId, guest.id);
      const back = await pool.connect();
      const w = await back.hello('Guest', guest.token);
      assert.equal(w.resumed, true);
      const res = await back.waitFor('m.result');
      if (unicast) assert.equal(res.playerId, guest.id, 'the player gets their own result');
      else assert.equal(res.reason, hostResult.reason);
      assert.deepEqual(order(back), ['room.state', `m.public:${PHASE.RESULT}`, 'm.result']);
      assert.equal(back.log.find((m) => m.t === 'room.state').inMatch, false);
    });
  }

  test('reloading on the result screen replays it until the player acts in the room; a new match clears it', async () => {
    ReplayMatch.unicast = true;
    const host = await pool.player('Solo');
    await createRoom(host, 'solo', 'NORMAL');
    await expectOk(host, { t: 'room.start' });
    await expectOk(host, { t: 'g.infoReady' });
    await host.waitFor('m.result');
    await host.waitFor('room.state', (s) => !s.inMatch);
    // reload #1 (new socket, same token) → result screen again
    await host.terminate();
    const r1 = await pool.connect();
    await r1.hello('Solo', host.token);
    assert.equal((await r1.waitFor('m.result')).playerId, host.id);
    // a repeated hello (live socket) is a resync too
    await delay(250);
    await r1.hello('Solo');
    await r1.waitFor('m.result');
    // the player moved on (acted in the room) → no more replays
    await expectOk(r1, { t: 'room.ready', ready: true });
    await r1.terminate();
    const r2 = await pool.connect();
    await r2.hello('Solo', host.token);
    await r2.waitFor('room.state');
    await r2.expectNone('m.result', () => true, 300);
    await r2.expectNone('m.public', () => true, 50);

    // a new match replaces any pending replay with the live match state
    await expectOk(r2, { t: 'room.start' });
    await expectOk(r2, { t: 'g.infoReady' });
    await r2.waitFor('m.result');
    await r2.waitFor('room.state', (s) => !s.inMatch);
    await expectOk(r2, { t: 'room.start' });
    await r2.waitFor('m.public', (p) => p.phase === PHASE.INFO_CHECK);
    await r2.terminate();
    const r3 = await pool.connect();
    await r3.hello('Solo', host.token);
    const pub = await r3.waitFor('m.public');
    assert.equal(pub.phase, PHASE.INFO_CHECK);
    await r3.expectNone('m.result', () => true, 200);
  });

  test('a human removed by the lobby grace after the match still gets the result after room.closed{timeout}', async () => {
    ReplayMatch.unicast = true;
    const { host, guest } = await endWhileGuestAway();
    await host.waitFor('room.state', (s) => !s.inMatch && !seatOf(s, guest.id), GRACE + 1000);
    const back = await pool.connect();
    await back.hello('Guest', guest.token);
    assert.equal((await back.waitFor('room.closed')).reason, 'timeout');
    assert.equal((await back.waitFor('m.result')).playerId, guest.id);
    assert.deepEqual(order(back), ['room.closed', `m.public:${PHASE.RESULT}`, 'm.result']);
    // delivered once
    await back.terminate();
    const again = await pool.connect();
    await again.hello('Guest', guest.token);
    await again.expectNone(null, (m) => m.t !== 'welcome', 300);
  });

  test('real Match: a human who is away when the match finishes gets its m.result on resume', async () => {
    const real = await startServer({ port: 0, host: '127.0.0.1', log: cap.log, MatchClass: RealMatch, seedFn: () => 1312887319 });
    const matches = [];
    try {
      const url = `ws://127.0.0.1:${real.port}/ws`;
      const a = await TestClient.connect(url);
      const w = await a.hello('A');
      a.id = w.playerId;
      await createRoom(a, 'coop', 'FUNNY');
      for (let i = 0; i < 3; i++) await expectOk(a, { t: 'room.addBot' });
      await expectOk(a, { t: 'room.start' });
      await a.waitFor('m.public', (p) => p.phase === PHASE.INFO_CHECK);
      const room = real.lobby.getRoom([...real.lobby.rooms.keys()][0]);
      const m = room.match;
      matches.push(m);
      await a.terminate();
      await delay(30);
      m.finish({ victory: true, reason: 'victory' });
      assert.equal(room.match, null, 'room back in LOBBY');
      const b = await TestClient.connect(url);
      await b.hello('A', w.token);
      const res = await b.waitFor('m.result', () => true, 3000);
      assert.equal(res.playerId, a.id);
      assert.equal(res.victory, true);
      const pub = b.log.find((x) => x.t === 'm.public');
      assert.equal(pub.phase, PHASE.RESULT);
      await b.terminate();
    } finally {
      for (const m of matches) m.dispose?.();
      await real.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// Per-network limits (clients behind a local reverse proxy, e.g. cloudflared, identified by forwarding headers)
// ---------------------------------------------------------------------------------------------------

describe('per-network limits', () => {
  let srv;
  let url;
  const open = new Set();
  const cap = captureLog();

  before(async () => {
    srv = await startServer({
      port: 0, host: '127.0.0.1', log: cap.log, MatchClass: Match,
      maxRoomsPerAddr: 3, maxMatchesPerAddr: 2, maxConnectionsPerAddr: 4,
    });
    url = `ws://127.0.0.1:${srv.port}/ws`;
  });
  afterEach(async () => {
    await Promise.all([...open].map((c) => c.terminate().catch(() => {})));
    open.clear();
    await delay(20);
  });
  after(async () => {
    await srv?.close();
    assert.deepEqual(cap.errors, [], 'no server errors logged');
  });

  /** Connect as a client whose address the local proxy forwards (null = a local peer without proxy). */
  async function netPlayer(name, ip) {
    const c = await TestClient.connect(url, { wsOptions: ip ? { headers: { 'X-Forwarded-For': `10.9.9.9, ${ip}` } } : {} });
    open.add(c);
    const w = await c.hello(name);
    c.id = w.playerId;
    c.token = w.token;
    return c;
  }
  /** The orphan loop: create a co-op room with AI, start it, walk away. Returns the room.start reply. */
  async function orphan(ip, i) {
    const c = await netPlayer(`orphan${i}`, ip);
    const r = await c.request({ t: 'room.create', mode: 'coop', difficulty: 'FUNNY' });
    if (r.t !== 'ok') { await c.terminate(); return { create: r }; }
    await expectOk(c, { t: 'room.addBot' });
    const start = await c.request({ t: 'room.start' });
    await c.terminate();
    return { create: r, start };
  }

  test('a socket loop cannot keep more than maxMatchesPerAddr unattended matches or maxRoomsPerAddr rooms', async () => {
    const A = '203.0.113.7';
    const keeper = await netPlayer('keeper', A); // stays connected in its running match
    await createRoom(keeper, 'solo', 'FUNNY');
    await expectOk(keeper, { t: 'room.start' });
    const first = await orphan(A, 1);
    assert.equal(first.start.t, 'ok');
    const second = await orphan(A, 2);
    assert.equal(second.create.t, 'ok', 'third room from A still allowed');
    assert.equal(second.start.t, 'error');
    assert.equal(second.start.code, ERR.RATE, 'third concurrent match from A refused');
    const third = await orphan(A, 3);
    assert.equal(third.create.code, ERR.RATE, 'fourth room from A refused');
    assert.match(third.create.detail, /rooms/);
    const h1 = JSON.parse((await httpReq(srv.port, '/healthz')).body.toString());

    // other networks and local peers are unaffected
    const other = await orphan('198.51.100.20', 4);
    assert.equal(other.start.t, 'ok');
    for (let i = 0; i < 4; i++) assert.equal((await orphan(null, 10 + i)).start.t, 'ok', 'local peers are not limited');
    const h2 = JSON.parse((await httpReq(srv.port, '/healthz')).body.toString());
    assert.equal(h2.matches, h1.matches + 5);

    // a match from A ends → capacity is back
    await expectOk(keeper, { t: 'g.leave' });
    const again = await netPlayer('again', A);
    const st = await again.request({ t: 'room.create', mode: 'solo', difficulty: 'FUNNY' });
    assert.equal(st.t, 'ok', JSON.stringify(st));
    await expectOk(again, { t: 'room.start' });
  });

  test('creating a room from your only room does not count the room being left', async () => {
    const B = '203.0.113.99';
    const c = await netPlayer('hopper', B);
    for (let i = 0; i < 6; i++) await expectOk(c, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
  });

  test('per-network socket cap is enforced at upgrade (429); other networks and local peers are unaffected', async () => {
    const C = '2001:db8:1:2::10';
    const socks = [];
    for (let i = 0; i < 4; i++) socks.push(await netPlayer(`s${i}`, `2001:db8:1:2::${i + 1}`)); // same /64
    await assert.rejects(TestClient.connect(url, { wsOptions: { headers: { 'X-Forwarded-For': C } } }), /429/);
    const other = await netPlayer('other', '2001:db8:1:3::1');
    const local = await netPlayer('local', null);
    assert.ok(other.isOpen && local.isOpen);
    await socks[0].close();
    await delay(50);
    const ok = await netPlayer('s4', C);
    assert.ok(ok.isOpen, 'a slot freed up');
  });
});

// ---------------------------------------------------------------------------------------------------
// 对局人数上限 (SP_MAX_MATCH_PLAYERS) and the server owner's privilege (SP_OWNER_TOKEN)
// ---------------------------------------------------------------------------------------------------

describe('match player limit', () => {
  const cap = captureLog();

  /** Boot a server for one test; `extra` are startServer options (maxMatchPlayers / ownerToken …). */
  async function boot(extra = {}) {
    const srv = await startServer({ port: 0, host: '127.0.0.1', log: cap.log, MatchClass: Match, ...extra });
    const url = `ws://127.0.0.1:${srv.port}/ws`;
    const conns = [];
    /**
     * Connect + hello (`extra`: hello fields, e.g. `{ owner }`).
     * @returns {Promise<{ c: any, welcome: any }>}
     */
    async function player(name, extra = {}) {
      const c = await TestClient.connect(url);
      conns.push(c);
      const welcome = await c.hello(name, null, extra);
      c.id = welcome.playerId;
      c.token = welcome.token;
      return { c, welcome };
    }
    /** A solo room started by one human (its match runs); returns the room.start reply. */
    async function solo(name, helloExtra = {}) {
      const { c } = await player(name, helloExtra);
      const r = await c.request({ t: 'room.create', mode: 'solo', difficulty: 'FUNNY' });
      assert.equal(r.t, 'ok', JSON.stringify(r));
      const start = await c.request({ t: 'room.start' });
      return { c, start };
    }
    const health = async () => JSON.parse((await httpReq(srv.port, '/healthz')).body.toString());
    const done = async () => { for (const c of conns) await c.terminate().catch(() => {}); await srv.close(); };
    return { srv, player, solo, health, done };
  }

  after(() => assert.deepEqual(cap.errors, [], 'no server errors logged'));

  test('with the default cap of 20 in matches the 21st human is refused with SERVER_FULL; the hall stays open', async () => {
    const t = await boot();
    try {
      for (let i = 0; i < 20; i++) {
        const { start } = await t.solo(`L${i}`);
        assert.equal(start.t, 'ok', `match ${i}: ${JSON.stringify(start)}`);
      }
      const before = await t.health();
      assert.equal(before.matchPlayers, 20, 'the one count: humans inside running matches');
      assert.equal(before.online, 20, 'the same humans are online (no room holds more than its one seat yet)');
      assert.equal(before.matchPlayerLimit, 20, 'the default cap, printed by /healthz');

      const { c, welcome } = await t.player('Late');
      assert.deepEqual(welcome.stats, { matchPlayers: 20, matchOwners: 0, matchPlayerLimit: 20, online: 20, onlineOwners: 0 },
        'welcome carries the numbers (a hall visitor without a room is not seated yet)');
      // the hall is never limited: creating a room, taking seats and adding AI all work
      assert.equal((await c.request({ t: 'room.create', mode: 'coop', difficulty: 'FUNNY' })).t, 'ok');
      await expectOk(c, { t: 'room.addBot' });
      const state = await c.waitFor('room.state', (s) => s.seats.filter(Boolean).length === 2);
      assert.deepEqual(state.stats, { matchPlayers: 20, matchOwners: 0, matchPlayerLimit: 20, online: 21, onlineOwners: 0 },
        'room.state carries the numbers: Late is seated in a room, so online grew while the match count did not');
      // … but entering a match does not
      const refused = await c.request({ t: 'room.start' });
      assert.equal(refused.t, 'error');
      assert.equal(refused.code, ERR.SERVER_FULL);
      assert.equal(refused.msg, '服务器对局已满，请稍后再试');
      const after = await t.health();
      assert.equal(after.matchPlayers, 20, 'nothing started');
      assert.equal(after.online, 21, 'Late is still a human on the server, just not in a match');
      assert.equal(after.matches, 20);
    } finally { await t.done(); }
  });

  test('AI seats take no room under the cap (and a room still in its lobby counts nothing)', async () => {
    const t = await boot({ maxMatchPlayers: 2 });
    try {
      assert.equal((await t.solo('A')).start.t, 'ok'); // 1 in a match
      const { c } = await t.player('B'); // a co-op room: 1 human + 3 AI
      assert.equal((await c.request({ t: 'room.create', mode: 'coop', difficulty: 'FUNNY' })).t, 'ok');
      for (let i = 0; i < 3; i++) await expectOk(c, { t: 'room.addBot' });
      const mid = await t.health();
      assert.equal(mid.matchPlayers, 1, 'the room in its lobby counts nothing yet: only A is in a match');
      assert.equal(mid.online, 2, 'both humans are online: A is in a match, B waits in a room');
      assert.equal((await c.request({ t: 'room.start' })).t, 'ok', 'one more human fits: the AI seats are no humans');
      const full = await t.health();
      assert.equal(full.matchPlayers, 2);
      assert.equal(full.online, 2, 'online did not change: the same two humans, both now in a match');
      assert.equal(full.bots, 3, 'three AI seats in the running co-op match');
      assert.equal((await t.solo('C')).start.code, ERR.SERVER_FULL, 'the third human is refused');
    } finally { await t.done(); }
  });

  test('a cap of 0 (or an empty SP_MAX_MATCH_PLAYERS) means no limit', async () => {
    const t = await boot({ maxMatchPlayers: 0 });
    try {
      for (let i = 0; i < 4; i++) assert.equal((await t.solo(`U${i}`)).start.t, 'ok', `unlimited match ${i}`);
      const h = await t.health();
      assert.equal(h.matchPlayers, 4);
      assert.equal(h.online, 4);
      assert.equal(h.matchPlayerLimit, 0, '/healthz says the server is unlimited');
    } finally { await t.done(); }
  });

  test('SP_MAX_MATCH_PLAYERS: default 20, empty/0 = unlimited, a typo keeps the default; SP_OWNER_TOKEN: empty = off', async () => {
    const env = { ...process.env };
    try {
      delete process.env.SP_MAX_MATCH_PLAYERS;
      assert.equal(maxMatchPlayers(), 20, 'unset → 20');
      process.env.SP_MAX_MATCH_PLAYERS = '';
      assert.equal(maxMatchPlayers(), 0, 'empty → unlimited');
      process.env.SP_MAX_MATCH_PLAYERS = '0';
      assert.equal(maxMatchPlayers(), 0, '0 → unlimited');
      process.env.SP_MAX_MATCH_PLAYERS = ' 8 ';
      assert.equal(maxMatchPlayers(), 8);
      process.env.SP_MAX_MATCH_PLAYERS = 'nope';
      assert.equal(maxMatchPlayers(), 20, 'a typo never removes the cap silently');
      delete process.env.SP_OWNER_TOKEN;
      assert.equal(ownerToken(), null, 'unset: nobody has the privilege');
      process.env.SP_OWNER_TOKEN = '  ';
      assert.equal(ownerToken(), null, 'empty: off');
      process.env.SP_OWNER_TOKEN = 'S3CRET';
      assert.equal(ownerToken(), 'S3CRET');
    } finally {
      for (const k of ['SP_MAX_MATCH_PLAYERS', 'SP_OWNER_TOKEN']) {
        if (env[k] == null) delete process.env[k];
        else process.env[k] = env[k];
      }
    }
  });

  test('the server owner is never counted and never refused; a wrong key grants nothing', async () => {
    const t = await boot({ maxMatchPlayers: 1, ownerToken: 'OWNER-KEY' });
    try {
      assert.equal((await t.solo('A')).start.t, 'ok'); // the cap is full: 1 human in a match
      assert.equal((await t.solo('B')).start.code, ERR.SERVER_FULL, 'a plain player is refused');
      assert.equal((await t.solo('C', { owner: 'wrong-key' })).start.code, ERR.SERVER_FULL, 'a wrong key is only a plain player');
      const owner = await t.solo('Owner', { owner: 'OWNER-KEY' });
      assert.equal(owner.start.t, 'ok', 'the owner always starts');
      const h = await t.health();
      assert.equal(h.matchPlayers, 1, 'the owner takes no room under the cap');
      assert.equal(h.matchOwners, 1, 'and is counted apart (12+1/20 in the client)');
      assert.equal(h.online, 4, 'the owner is still a human online (A is in a match; B and C keep the rooms their refused start left behind)');
      assert.equal(h.onlineOwners, 1, 'and named as one of them (a plain player takes it out of both counts)');
      // the owner's own room always starts, a teammate included (the privilege is the room's)
      const { c: host } = await t.player('Owner2', { owner: 'OWNER-KEY' });
      const created = await host.request({ t: 'room.create', mode: 'coop', difficulty: 'FUNNY' });
      assert.equal(created.t, 'ok', JSON.stringify(created));
      const state = await host.waitFor('room.state', (s) => s.hostId === host.id);
      const { c: mate } = await t.player('Mate');
      assert.equal((await mate.request({ t: 'room.join', code: state.code })).t, 'ok');
      assert.equal((await mate.request({ t: 'room.ready', ready: true })).t, 'ok');
      const ownerStart = await host.request({ t: 'room.start' });
      assert.equal(ownerStart.t, 'ok', `an owner's room starts over the cap: ${JSON.stringify(ownerStart)}`);
      const h2 = await t.health();
      assert.equal(h2.matchPlayers, 2, 'the owner\'s teammate does count (the cap is only waived for the owner)');
      assert.equal(h2.matchOwners, 2, 'two owner sessions in matches, both counted apart');
    } finally { await t.done(); }
  });

  test('without SP_OWNER_TOKEN nobody is an owner: the key in the hello changes nothing', async () => {
    const t = await boot({ maxMatchPlayers: 1 }); // no ownerToken
    try {
      assert.equal((await t.solo('A')).start.t, 'ok');
      assert.equal((await t.solo('Boss', { owner: 'OWNER-KEY' })).start.code, ERR.SERVER_FULL);
      const h = await t.health();
      assert.equal(h.matchOwners, 0);
      assert.equal(h.onlineOwners, 0);
    } finally { await t.done(); }
  });

  test('the same shared frame, two views: the owner sees 12+1, a plain player the owner-free counts', async () => {
    const t = await boot({ ownerToken: 'OWNER-KEY' });
    try {
      const { serverLoadText } = await import('../public/js/ui/serverLoad.js');
      const i18n = await import('../shared/i18n.js');
      i18n.setLang('zh');
      // one owner in a match and one plain player in a match: the shared numbers are players 1, owners 1, online 2
      const { c: ownerC, welcome: ownerW } = await t.player('Owner', { owner: 'OWNER-KEY' });
      assert.equal(ownerW.me.owner, true, 'the welcome of the owner session says so (session-level, not a broadcast)');
      assert.equal((await ownerC.request({ t: 'room.create', mode: 'solo', difficulty: 'FUNNY' })).t, 'ok');
      assert.equal((await ownerC.request({ t: 'room.start' })).t, 'ok');
      const { start } = await t.solo('Plain');
      assert.equal(start.t, 'ok', JSON.stringify(start));

      const h = await t.health();
      assert.equal(h.matchPlayers, 1, 'the plain player is the only human under the cap');
      assert.equal(h.matchOwners, 1);
      assert.equal(h.online, 2);
      assert.equal(h.onlineOwners, 1, 'the owner is one of the two humans seated');

      // a fresh welcome (a visitor without a room) carries the whole picture — one frame for both views
      const { welcome: lateW } = await t.player('Late');
      assert.equal(lateW.me.owner, false, 'a session without the key is no owner');
      assert.deepEqual(lateW.stats, { matchPlayers: 1, matchOwners: 1, matchPlayerLimit: 20, online: 2, onlineOwners: 1 });
      assert.equal(serverLoadText(lateW.stats, { withOnline: true, viewerOwner: false }), '在线 1 人 · 对局 1/20 人',
        'the plain player: no +1, and the owner is out of both counts');
      assert.equal(serverLoadText(lateW.stats, { withOnline: true, viewerOwner: true }), '在线 2 人 · 对局 1+1/20 人',
        'the owner: unchanged — its own seat shown apart');
      // … and the very same numbers go to an owner session: one frame, two views (the frame carries no viewer field)
      const { welcome: owner2W } = await t.player('Owner2', { owner: 'OWNER-KEY' });
      assert.equal(owner2W.me.owner, true);
      assert.deepEqual(owner2W.stats, lateW.stats, 'room.state / welcome.stats are the same shared numbers for everybody');
      // the hall shows the match count alone, in each viewer's own view
      assert.equal(serverLoadText(lateW.stats, { viewerOwner: true }), '对局 1+1/20 人', 'the hall: the owner sees +1');
      assert.equal(serverLoadText(lateW.stats), '对局 1/20 人', 'the hall: a plain player sees 1/20');
      // a wrong key grants no view either
      const { welcome: wrongW } = await t.player('Wrong', { owner: 'wrong-key' });
      assert.equal(wrongW.me.owner, false);
    } finally { await t.done(); }
  });

  test('the client text: a plain player never sees +N, the counts never go negative, an old server still works', async () => {
    const { serverLoadText } = await import('../public/js/ui/serverLoad.js');
    const i18n = await import('../shared/i18n.js');
    i18n.setLang('zh');
    // limit 0
    const noLimit = { matchPlayers: 2, matchOwners: 1, matchPlayerLimit: 0, online: 4, onlineOwners: 1 };
    assert.equal(serverLoadText(noLimit, { withOnline: true, viewerOwner: true }), '在线 4 人 · 对局 2+1 人',
      'no limit: the denominator is left out, the owner still shown apart');
    assert.equal(serverLoadText(noLimit, { withOnline: true }), '在线 3 人 · 对局 2 人',
      'no limit: an ordinary player, owner-free counts');
    // nothing but the owner online: floored at 0
    const onlyOwner = { matchPlayers: 0, matchOwners: 1, matchPlayerLimit: 20, online: 1, onlineOwners: 1 };
    assert.equal(serverLoadText(onlyOwner, { withOnline: true }), '在线 0 人 · 对局 0/20 人', 'no negative online');
    assert.equal(serverLoadText({ ...onlyOwner, onlineOwners: 3 }, { withOnline: true }), '在线 0 人 · 对局 0/20 人',
      'a stale frame naming more owners than seats still floors at 0');
    // all AI: no human at all
    assert.equal(serverLoadText({ matchPlayers: 0, matchOwners: 0, matchPlayerLimit: 20, online: 0, onlineOwners: 0 },
      { withOnline: true }), '在线 0 人 · 对局 0/20 人', 'AI seats count nothing');
    // an older server: no onlineOwners at all
    assert.equal(serverLoadText({ matchPlayers: 12, matchOwners: 1, matchPlayerLimit: 20, online: 16 }, { withOnline: true }),
      '在线 16 人 · 对局 12/20 人', 'no onlineOwners: read as 0, the counts stay exactly what they were');
  });

  test('a running match keeps room.state.stats coming (the HUD’s 在线 count moves during a match)', async () => {
    // statsRefreshMs shortened: the lobby re-broadcasts a running room's state (with fresh stats) on that timer
    const t = await boot({ statsRefreshMs: 30 });
    try {
      const { c: a, start } = await t.solo('A');
      assert.equal(start.t, 'ok', JSON.stringify(start));
      const first = await a.waitFor('room.state', (s) => s.inMatch && !!s.stats);
      assert.deepEqual(first.stats, { matchPlayers: 1, matchOwners: 0, matchPlayerLimit: 20, online: 1, onlineOwners: 0 },
        'the match-start room.state already carries the numbers');

      // a second human enters a match: A is inside its own and hears the moved counts without leaving it
      assert.equal((await t.solo('B')).start.t, 'ok');
      const fresh = await a.waitFor('room.state', (s) => !!s.stats && s.stats.matchPlayers === 2, 3000);
      assert.equal(fresh.inMatch, true, 'still the running match’s frame');
      assert.deepEqual(fresh.stats, { matchPlayers: 2, matchOwners: 0, matchPlayerLimit: 20, online: 2, onlineOwners: 0 },
        'online and the match count both moved while A was in a match');

      // exactly this frame is what the HUD prints (ui/serverLoad.js serverLoadText withOnline)
      const { serverLoadText } = await import('../public/js/ui/serverLoad.js');
      const i18n = await import('../shared/i18n.js');
      const prevLang = i18n.getLang?.() ?? 'zh';
      i18n.setLang('zh');
      try {
        assert.equal(serverLoadText(fresh.stats, { withOnline: true }), '在线 2 人 · 对局 2/20 人',
          '「在线 X 人 · 对局 N/M 人」 is built from the frame the HUD receives');
      } finally { i18n.setLang(prevLang); }
    } finally { await t.done(); }
  });

  test('the client text: ERR_TEXT, the four packs and ui/serverLoad.js agree', async () => {
    assert.equal(ERR_TEXT.SERVER_FULL, '服务器对局已满，请稍后再试');
    const packs = {};
    for (const code of ['en', 'ja', 'ko', 'zh-TW']) {
      const p = path.join(ROOT, 'public/i18n', `${code}.json`);
      packs[code] = JSON.parse(fs.readFileSync(p, 'utf8'));
      for (const key of [ERR_TEXT.SERVER_FULL, '对局 {players}/{max} 人', '对局 {players} 人', '同时在对局中的博士人数（服主不计入）',
        '在线 {n} 人', '在线人数与同时在对局中的博士人数（服主不计入）']) {
        assert.ok(typeof packs[code][key] === 'string' && packs[code][key], `${code}.json lacks ${key}`);
      }
      assert.ok(!/[一-鿿]/.test(packs.en[ERR_TEXT.SERVER_FULL]), `en.json translates the error text: ${packs.en[ERR_TEXT.SERVER_FULL]}`);
    }
    const { serverLoad, serverLoadText } = await import('../public/js/ui/serverLoad.js');
    const i18n = await import('../shared/i18n.js');
    assert.deepEqual(serverLoad({ matchPlayers: 12, matchOwners: 1, matchPlayerLimit: 20 }),
      { players: 12, owners: 1, limit: 20, online: null, onlineOwners: 0, full: false },
      'no online field (an older server): null; no onlineOwners: 0');
    assert.deepEqual(serverLoad({ matchPlayers: 12, matchOwners: 1, matchPlayerLimit: 20, online: 15, onlineOwners: 2 }),
      { players: 12, owners: 1, limit: 20, online: 15, onlineOwners: 2, full: false });
    assert.equal(serverLoad({ foo: 1 }), null, 'no numbers: nothing to show');
    i18n.setLang('zh');
    assert.equal(serverLoadText({ matchPlayers: 12, matchOwners: 0, matchPlayerLimit: 20 }), '对局 12/20 人');
    assert.equal(serverLoadText({ matchPlayers: 12, matchOwners: 1, matchPlayerLimit: 20 }, { viewerOwner: true }),
      '对局 12+1/20 人', 'the owner shown apart — for the owner itself');
    assert.equal(serverLoadText({ matchPlayers: 12, matchOwners: 1, matchPlayerLimit: 20 }), '对局 12/20 人',
      'a plain player never sees +N (12 is already owner-free)');
    assert.equal(serverLoadText({ matchPlayers: 12, matchOwners: 0, matchPlayerLimit: 0 }), '对局 12 人', 'no limit: no denominator');
    // the match HUD: the server's online count in front of the match count (withOnline)
    assert.equal(serverLoadText({ matchPlayers: 12, matchOwners: 0, matchPlayerLimit: 20, online: 15 }, { withOnline: true }),
      '在线 15 人 · 对局 12/20 人');
    assert.equal(serverLoadText({ matchPlayers: 12, matchOwners: 0, matchPlayerLimit: 0, online: 15 }, { withOnline: true }),
      '在线 15 人 · 对局 12 人', 'no limit: the denominator is still left out');
    const ownerStats = { matchPlayers: 12, matchOwners: 1, matchPlayerLimit: 20, online: 16, onlineOwners: 1 };
    assert.equal(serverLoadText(ownerStats, { withOnline: true, viewerOwner: true }),
      '在线 16 人 · 对局 12+1/20 人', 'the owner: online includes it, and its seat is shown apart');
    assert.equal(serverLoadText(ownerStats, { withOnline: true }),
      '在线 15 人 · 对局 12/20 人', 'a plain player: the owner is out of both counts, and no +1');
    assert.equal(serverLoadText({ matchPlayers: 12, matchOwners: 0, matchPlayerLimit: 20, online: 15 }), '对局 12/20 人',
      'the hall and the room keep the bare match count');
    assert.equal(serverLoadText({ matchPlayers: 12, matchOwners: 0, matchPlayerLimit: 20 }, { withOnline: true }), '对局 12/20 人',
      'an older server sends no online: the HUD shows the match count alone');
    assert.equal(serverLoadText(null), '');
    i18n.addMessages('en', packs.en);
    i18n.setLang('en');
    try {
      assert.equal(serverLoadText({ matchPlayers: 12, matchOwners: 0, matchPlayerLimit: 20 }), 'Matches 12/20');
      assert.equal(serverLoadText({ matchPlayers: 12, matchOwners: 0, matchPlayerLimit: 20, online: 15 }, { withOnline: true }),
        '15 online · Matches 12/20');
      assert.equal(serverLoadText(ownerStats, { withOnline: true, viewerOwner: true }), '16 online · Matches 12+1/20');
      assert.equal(serverLoadText(ownerStats, { withOnline: true }), '15 online · Matches 12/20');
      assert.equal(i18n.t(ERR_TEXT.SERVER_FULL), 'The server has no free match slot right now — please try again later');
    } finally { i18n.setLang('zh'); i18n.setMessages('en', {}); }
  });
});

// ---------------------------------------------------------------------------------------------------
// Heartbeat, hello timeout, shutdown
// ---------------------------------------------------------------------------------------------------

describe('heartbeat and shutdown', () => {
  test('dead sockets are terminated by the heartbeat; silent sockets hit the hello timeout', async () => {
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, heartbeatMs: 80, helloTimeoutMs: 150 });
    try {
      const url = `ws://127.0.0.1:${srv.port}/ws`;
      const deaf = await TestClient.connect(url, { wsOptions: { autoPong: false } });
      await deaf.hello('Deaf');
      const healthy = await TestClient.connect(url);
      await healthy.hello('Healthy');
      const info = await Promise.race([deaf.closed, delay(2000).then(() => null)]);
      assert.ok(info, 'deaf socket closed');
      assert.equal(info.code, 1006, 'terminated without a close frame');

      const silent = await TestClient.connect(url);
      const silentInfo = await Promise.race([silent.closed, delay(2000).then(() => null)]);
      assert.equal(silentInfo?.code, 4002);

      assert.ok(healthy.isOpen, 'healthy socket survives heartbeats');
      await healthy.close();
    } finally {
      await srv.close();
    }
  });

  test('close() notifies rooms (room.closed shutdown) and closes sockets with 1001', async () => {
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
    const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
    const w = await c.hello('Last');
    c.id = w.playerId;
    await createRoom(c);
    await srv.close();
    const closed = await c.waitFor('room.closed');
    assert.equal(closed.reason, 'shutdown');
    const info = await c.closed;
    assert.equal(info.code, 1001);
    await assert.rejects(httpReq(srv.port, '/healthz'));
  });
});

// ---------------------------------------------------------------------------------------------------
// Units: data loader, name sanitizer, token bucket, registry
// ---------------------------------------------------------------------------------------------------

describe('match stub (server/match/Match.js)', () => {
  const STATUSES = ['acting', 'ready', 'deciding', 'combat', 'done', 'helping', 'left', 'dead'];
  const mk = (over = {}) => {
    const out = { sent: [], bc: [], ended: [] };
    const m = new Match({
      roomCode: 'ABCD', mode: 'coop', difficulty: 'HARD', modeId: 'mode_multi_hard', seed: 7,
      seats: [
        { seat: 0, playerId: 'p_a', name: 'A', isBot: false, connected: true },
        { seat: 1, playerId: 'p_b', name: 'B', isBot: false, connected: true },
        { seat: 3, playerId: 'ai_1', name: 'AI', isBot: true, connected: true },
      ],
      data: { config: { modes: { mode_multi_hard: { lastRound: 14 } }, timers: { infoCheck: 0.08 } } },
      send: (id, msg) => { out.sent.push([id, msg]); return true; },
      broadcast: (msg) => out.bc.push(msg),
      onEnd: (summary) => out.ended.push([summary, out.bc.length]),
      ...over,
    });
    return { m, out };
  };

  test('m.public / m.private follow the DESIGN §8.2 / §8.3 shapes', () => {
    const { m, out } = mk();
    m.start();
    const pub = out.bc[0];
    assert.equal(pub.t, 'm.public');
    for (const k of ['phase', 'round', 'lastRound', 'deadline', 'serverNow', 'modeId', 'difficulty', 'stageId', 'factions', 'disabledBonds', 'bannedChess', 'bossId', 'players', 'fields']) {
      assert.ok(k in pub, `m.public.${k}`);
    }
    assert.equal(pub.phase, 'INFO_CHECK');
    assert.equal(pub.lastRound, 14);
    assert.ok(pub.deadline > pub.serverNow && pub.deadline - pub.serverNow <= 80);
    for (const p of pub.players) {
      for (const k of ['playerId', 'seat', 'name', 'isBot', 'connected', 'alive', 'lp', 'bandId', 'shopLevel', 'boardCount', 'ready', 'bonds', 'fieldId', 'status']) {
        assert.ok(k in p, `players[].${k}`);
      }
      assert.ok(STATUSES.includes(p.status), p.status);
      assert.ok(Array.isArray(p.bonds));
    }
    assert.equal(out.sent.length, 2, 'one m.private per human, none for bots');
    for (const [id, priv] of out.sent) {
      assert.equal(priv.t, 'm.private');
      assert.equal(priv.playerId, id);
      for (const k of ['seat', 'alive', 'lp', 'funds', 'bandId', 'ready', 'canReady', 'shop', 'hand', 'temp', 'board', 'deployCap', 'deployCount', 'bonds', 'effects', 'nextEnemies', 'stats']) {
        assert.ok(k in priv, `m.private.${k}`);
      }
      for (const k of ['level', 'maxLevel', 'upgradePrice', 'refreshPrice', 'freeRefreshes', 'frozen', 'slots', 'rewardOffer']) assert.ok(k in priv.shop, `shop.${k}`);
      assert.equal(priv.hand.length, 10);
      assert.equal(priv.temp.length, 5);
      assert.ok(Array.isArray(priv.bonds) && Array.isArray(priv.board) && Array.isArray(priv.effects));
    }
    m.dispose();
  });

  test('lastRound comes from config (fallback 9 for solo FUNNY, else 14)', () => {
    assert.equal(mk({ data: {}, mode: 'solo', difficulty: 'FUNNY', modeId: 'mode_single_funny' }).m.lastRound, 9);
    assert.equal(mk({ data: undefined }).m.lastRound, 14);
    assert.equal(mk({ data: { config: { modes: { mode_multi_hard: { lastRound: 11 } } } } }).m.lastRound, 11);
    const real = loadData(path.join(ROOT, 'data'), { log: { warn() {}, error() {} } });
    if (real.config?.modes) {
      assert.equal(mk({ data: real, mode: 'solo', difficulty: 'FUNNY', modeId: 'mode_single_funny' }).m.lastRound, 9);
      assert.equal(mk({ data: real }).m.lastRound, 14);
    }
  });

  test('INFO_CHECK deadline ends the stub once (m.result before onEnd); ready/leave also end it', async () => {
    const { m, out } = mk();
    m.start();
    assert.deepEqual(m.handle('p_a', { t: 'g.infoReady' }), { ok: true });
    assert.equal(out.ended.length, 0);
    await delay(200);
    assert.equal(out.ended.length, 1);
    assert.equal(out.ended[0][0].reason, 'timeout');
    assert.ok(out.bc.slice(0, out.ended[0][1]).some((x) => x.t === 'm.result'), 'm.result sent before onEnd');
    assert.deepEqual(m.handle('p_a', { t: 'g.infoReady' }), { error: ERR.WRONG_PHASE });
    m.dispose();
    m.dispose();

    const b = mk();
    b.m.start();
    b.m.handle('p_a', { t: 'g.infoReady' });
    b.m.onLeave('p_b');
    assert.equal(b.out.ended.length, 1);
    assert.equal(b.out.ended[0][0].reason, 'confirmed');
    b.m.dispose();
    await delay(150);
    assert.equal(b.out.ended.length, 1, 'no second onEnd from the cleared deadline timer');

    const c = mk();
    c.m.start();
    c.m.dispose();
    await delay(150);
    assert.equal(c.out.ended.length, 0, 'dispose clears the deadline timer');
    assert.deepEqual(c.m.handle('ai_1', { t: 'g.ready', ready: true }), { error: ERR.NOT_IN_ROOM });
    assert.throws(() => new Match({ seats: [] }), TypeError);
  });
});

describe('platform units', () => {
  test('loadData: reads *.json by basename, deep-freezes, tolerates missing/broken files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-data-'));
    try {
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ modes: { a: { rounds: [1, 2] } } }));
      fs.writeFileSync(path.join(dir, 'chess.json'), JSON.stringify([{ id: 'x', stats: { hp: 1 } }]));
      fs.writeFileSync(path.join(dir, 'broken.json'), '{oops');
      fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
      fs.writeFileSync(path.join(dir, 'local-fx.json'), JSON.stringify({ version: 1, format: 'fx-manifest', groups: {} }));
      const warnings = [];
      const errors = [];
      const data = loadData(dir, { log: { warn: (m) => warnings.push(m), error: (m) => errors.push(m) } });
      assert.deepEqual(Object.keys(data).sort(), ['chess', 'config'], 'data/local-fx.json (the official effects\' file list, UNLOADED_DATA) is never loaded');
      assert.equal(data.config.modes.a.rounds[1], 2);
      assert.ok(Object.isFrozen(data));
      assert.ok(Object.isFrozen(data.config.modes.a.rounds));
      assert.ok(Object.isFrozen(data.chess[0].stats));
      assert.throws(() => { data.config.modes.a.rounds.push(3); }, TypeError);
      assert.throws(() => { data.chess[0].stats.hp = 9; }, TypeError);
      assert.equal(errors.length, 1);
      assert.match(errors[0], /broken\.json/);
      assert.ok(warnings.some((w) => /missing data files/.test(w) && /bonds\.json/.test(w)));
      const none = loadData(path.join(dir, 'does-not-exist'), { log: { warn() {}, error() {} } });
      assert.deepEqual(Object.keys(none), []);
      assert.ok(Object.isFrozen(none));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('data index getters: own-property lookups only, null for unknown ids / missing files', () => {
    const data = loadData('/nonexistent-dir', { log: { warn() {}, error() {} } });
    assert.equal(getChess('chess_char_1_01_a', data), null, 'missing file');
    const fake = Object.freeze({
      chess: { x_a: { chessId: 'x_a' }, n: 5 },
      bonds: [{ bondId: 'arr' }],
      config: { modes: { mode_multi_hard: { lastRound: 14 } } },
    });
    assert.deepEqual(getChess('x_a', fake), { chessId: 'x_a' });
    assert.equal(getChess('n', fake), null, 'non-object record');
    for (const bad of ['constructor', '__proto__', 'toString', 'hasOwnProperty', '', null, undefined, 5, {}]) {
      assert.equal(getChess(bad, fake), null, String(bad));
      assert.equal(getMode(bad, fake), null, String(bad));
    }
    assert.equal(getBond('0', fake), null, 'arrays are not id maps');
    assert.equal(lookup('constructor', 'x', fake), null);
    assert.equal(lookup('chess', 'x_a', null), null);
    assert.equal(getMode('mode_multi_hard', fake).lastRound, 14);
    assert.equal(getConfig({ config: [] }), null);
    for (const fn of Object.values(INDEXED_FILES)) assert.equal(typeof dataModule[fn], 'function', fn);

    // real generated data (when present): every record of every id-keyed file resolves to itself
    const real = loadData(path.join(ROOT, 'data'), { log: { warn() {}, error() {} } });
    let checked = 0;
    for (const [file, fn] of Object.entries(INDEXED_FILES)) {
      if (!real[file]) continue;
      for (const [id, rec] of Object.entries(real[file])) {
        assert.equal(dataModule[fn](id, real), rec, `${file}/${id}`);
        checked++;
      }
    }
    if (real.bands) assert.equal(getBand('band_bldsk', real)?.name, '华法琳');
    if (real.config) assert.equal(getMode('mode_single_funny', real)?.lastRound, 9);
    assert.ok(checked === 0 || checked > 500, `checked ${checked}`);
  });

  test('sanitizeName strips control / invisible characters and caps length', () => {
    assert.equal(sanitizeName('  Amiya  '), 'Amiya');
    assert.equal(sanitizeName('a\tb\nc'), 'a b c');
    assert.equal(sanitizeName(`x${String.fromCharCode(0x202e)}y${String.fromCharCode(0x200b)}z`), 'xyz');
    assert.equal(sanitizeName(String.fromCharCode(0xd800)), null);
    assert.equal(sanitizeName(''), null);
    assert.equal(sanitizeName(42), null);
    assert.equal([...sanitizeName('😀'.repeat(20))].length, 12);
  });

  test('TokenBucket refills continuously up to burst', () => {
    const b = new TokenBucket(40, 40, 0);
    let ok = 0;
    for (let i = 0; i < 100; i++) if (b.take(0)) ok++;
    assert.equal(ok, 40);
    assert.equal(b.take(10), false); // 10 ms → 0.4 token
    assert.equal(b.take(30), true); // 30 ms → 1.2 tokens
    assert.equal(b.take(100000), true);
    let burst = 0;
    for (let i = 0; i < 100; i++) if (b.take(100000)) burst++;
    assert.equal(burst, 39);
  });

  test('clientAddress: proxy headers only from local peers, IPv6 grouped by /64, local peers unlimited', () => {
    const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });
    assert.equal(normalizeIp('::ffff:127.0.0.1'), '127.0.0.1');
    assert.equal(normalizeIp('::ffff:0102:0304'), '1.2.3.4');
    assert.equal(normalizeIp('[FE80::1%en0]'), 'fe80::1');
    assert.equal(normalizeIp('not-an-ip'), '');
    assert.equal(normalizeIp('203.0.113.4:5678'), '203.0.113.4');
    assert.equal(normalizeIp('[2001:db8::1]:443'), '2001:db8::1');
    for (const ip of ['127.0.0.1', '::1', '10.0.0.8', '172.16.4.4', '192.168.65.1', '100.100.1.1', 'fd12::1', 'fe80::2']) assert.equal(isLocalIp(ip), true, ip);
    for (const ip of ['8.8.8.8', '172.32.0.1', '2001:db8::1']) assert.equal(isLocalIp(ip), false, ip);
    assert.equal(limitKeyOf('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2::/64');
    assert.equal(limitKeyOf('2001:db8:1:2::9'), '2001:db8:1:2::/64');
    assert.equal(limitKeyOf('203.0.113.1'), '203.0.113.1');

    // local reverse proxy (cloudflared): CF-Connecting-IP > X-Real-IP > rightmost X-Forwarded-For
    assert.deepEqual(clientAddress(req('::ffff:127.0.0.1', { 'x-forwarded-for': '6.6.6.6, 203.0.113.7' })), { ip: '203.0.113.7', key: '203.0.113.7' });
    assert.deepEqual(clientAddress(req('127.0.0.1', { 'cf-connecting-ip': '203.0.113.8', 'x-forwarded-for': '6.6.6.6' })), { ip: '203.0.113.8', key: '203.0.113.8' });
    assert.deepEqual(clientAddress(req('127.0.0.1', { 'x-real-ip': '2001:db8:a:b::5' })), { ip: '2001:db8:a:b::5', key: '2001:db8:a:b::/64' });
    // local peers without a proxy header and LAN clients forwarded by a LAN proxy are not limited
    assert.deepEqual(clientAddress(req('127.0.0.1')), { ip: '127.0.0.1', key: null });
    assert.deepEqual(clientAddress(req('192.168.1.20', { 'x-forwarded-for': '192.168.1.21' })), { ip: '192.168.1.21', key: null });
    // internet peers: headers are client-controlled → ignored unless trustProxy is true
    assert.deepEqual(clientAddress(req('198.51.100.3', { 'x-forwarded-for': '203.0.113.7' })), { ip: '198.51.100.3', key: '198.51.100.3' });
    assert.deepEqual(clientAddress(req('198.51.100.3', { 'x-forwarded-for': '203.0.113.7' }), true), { ip: '203.0.113.7', key: '203.0.113.7' });
    assert.deepEqual(clientAddress(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.7' }), false), { ip: '127.0.0.1', key: null });
    assert.deepEqual(clientAddress(req('127.0.0.1', { 'x-forwarded-for': 'garbage' })), { ip: '127.0.0.1', key: null });
    assert.deepEqual(clientAddress(undefined), { ip: '?', key: null });
    assert.equal(parseTrustProxy('1'), true);
    assert.equal(parseTrustProxy('off'), false);
    assert.equal(parseTrustProxy(undefined), 'auto');
    assert.equal(parseTrustProxy('auto'), 'auto');
  });

  test('SessionRegistry: token lookup, expiry sweep, eviction', () => {
    let now = 1000;
    const reg = new SessionRegistry({ reconnectWindowMs: 100, maxSessions: 2, now: () => now });
    const a = reg.create('A');
    const b = reg.create('B');
    assert.equal(reg.byToken(a.token), a);
    assert.equal(reg.byToken('nope'), null);
    assert.equal(reg.byToken(undefined), null);
    a.connected = true; a.disconnectedAt = null;
    b.connected = false; b.disconnectedAt = now; b.roomCode = 'ABCD';
    assert.equal(reg.create('C'), null, 'full of active/roomed sessions');
    b.roomCode = null;
    const c = reg.create('C');
    assert.ok(c, 'evicted the idle session');
    assert.equal(reg.byId(b.playerId), null);
    c.connected = false; c.disconnectedAt = now;
    now += 101;
    assert.equal(reg.byToken(c.token), null, 'expired token no longer resumes');
    const swept = reg.sweep();
    assert.deepEqual(swept, [c]);
    assert.equal(reg.size, 1);
  });

  test('SessionRegistry: a session may extend (never shorten) its own reconnect window', () => {
    let now = 1000;
    const reg = new SessionRegistry({ reconnectWindowMs: 100, now: () => now });
    const solo = reg.create('Solo');
    const coop = reg.create('Coop');
    const short = reg.create('Short');
    solo.resumeWindowMs = 5000;
    short.resumeWindowMs = 10;
    for (const s of [solo, coop, short]) { s.connected = false; s.disconnectedAt = now; }
    assert.equal(reg.windowOf(solo), 5000);
    assert.equal(reg.windowOf(coop), 100);
    assert.equal(reg.windowOf(short), 100, 'a shorter override is ignored');
    now += 101;
    assert.equal(reg.byToken(solo.token), solo, 'extended session still resumes');
    assert.equal(reg.byToken(short.token), null);
    assert.deepEqual(reg.sweep().map((s) => s.name).sort(), ['Coop', 'Short']);
    now += 5000;
    assert.deepEqual(reg.sweep(), [solo]);
    assert.equal(reg.size, 0);
  });
});
