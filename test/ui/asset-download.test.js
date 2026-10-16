import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { collectAssetUrls, createAssetDownload } from '../../public/js/assetDownload.js';
import { mediaUrl } from '../../public/js/media.js';

const json = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const file = () => new Response('asset', { headers: { 'content-type': 'application/octet-stream' } });
function fixture(assets, get, local = { groups: {} }, fx = null) {
  return async (url, options) => url === '/data/assets.json' ? json(assets)
    : url === '/data/local-assets.json' ? local === null ? new Response('', { status: 404 }) : json(local)
      : url === '/data/local-fx.json' ? fx === null ? new Response('', { status: 404 }) : json(fx)
        : get(url, options);
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('all model pages/local scenes/fonts are deduplicated; audio matches the playback URL', () => {
  const urls = collectAssetUrls({ a: { skel: '/assets/~1234567890abcdef/model.skel', atlas: '/assets/model.atlas',
    textures: ['/assets/one.png', '/assets/two.png'] }, b: '/assets/one.png', audio: '/assets/~1234567890abcdef/audio/bgm/a.mp3',
  source: 'https://external.test/a.png', invalid: '//external.test/x', font: '/fonts/a.woff2' },
  { groups: { scene: { binary: { path: '/assets/local/scene.bin' } } } });
  assert.equal(urls.length, 7);
  assert.ok(urls.includes('/assets/local/scene.bin'));
  assert.ok(urls.includes('/assets/two.png'));
  assert.equal(urls.at(-1), '/media/~1234567890abcdef/bgm/a');
  assert.ok(!urls.some((url) => url.includes('external')));
});

test('does nothing before click, bounds concurrency and consumes full bodies without decoding', async () => {
  let active = 0, max = 0, calls = 0;
  const queue = createAssetDownload({ concurrency: 2, fetch: fixture(
    ['/assets/a', '/assets/b', '/assets/c'].reduce((o, url) => ({ ...o, [url]: url }), {}),
    async (_url, options) => {
      assert.equal(options.cache, 'default');
      calls++; active++; max = Math.max(max, active);
      await tick();
      active--;
      return file();
    }) });
  assert.equal(calls, 0);
  const first = queue.start();
  assert.equal(queue.start(), first);
  await first;
  assert.equal(max, 2);
  assert.deepEqual([queue.get().phase, queue.get().total, queue.get().done, queue.get().bytes], ['complete', 3, 3, 15]);
});

test('failed files stay incomplete and manual retry skips successful files', async () => {
  const calls = [];
  let missing = true;
  const queue = createAssetDownload({ retries: 0, fetch: fixture({ a: '/assets/a', b: '/assets/b' }, async (url) => {
    calls.push(url);
    return url === '/assets/b' && missing ? new Response('missing', { status: 404 }) : file();
  }) });
  await queue.start();
  assert.equal(queue.get().phase, 'partial');
  assert.equal(queue.get().done, 1);
  assert.deepEqual(queue.get().failures, [{ url: '/assets/b', status: 404 }]);
  missing = false;
  await queue.start();
  assert.equal(queue.get().phase, 'complete');
  assert.equal(calls.filter((u) => u === '/assets/a').length, 1);
  assert.equal(calls.filter((u) => u === '/assets/b').length, 2);
});

test('HTML fallbacks, empty and partial responses never count as downloaded', async () => {
  const responses = {
    '/assets/a': new Response('<html>missing</html>', { headers: { 'content-type': 'text/html' } }),
    '/assets/b': new Response('', { status: 200 }),
    '/assets/c': new Response('part', { status: 206 }),
  };
  const queue = createAssetDownload({ fetch: fixture(Object.keys(responses), async (url) => responses[url]) });
  // A malformed root manifest is rejected before processing.
  await queue.start();
  assert.equal(queue.get().phase, 'error');
  const valid = createAssetDownload({ fetch: fixture({ files: Object.keys(responses) }, async (url) => responses[url]) });
  await valid.start();
  assert.equal(valid.get().phase, 'partial');
  assert.equal(valid.get().done, 0);
  assert.equal(valid.get().failures.length, 3);
});

test('an aborted body is unfinished; resume retains earlier successes and retries the interrupted file', async () => {
  const calls = [];
  let reading;
  const begun = new Promise((resolve) => { reading = resolve; });
  let hold = true;
  const queue = createAssetDownload({ concurrency: 1, fetch: fixture({ a: '/assets/a', b: '/assets/b' }, async (url, { signal }) => {
    calls.push(url);
    if (url === '/assets/a' || !hold) return file();
    return new Response(new ReadableStream({ start(stream) {
      stream.enqueue(new Uint8Array([1, 2]));
      signal.addEventListener('abort', () => stream.error(new DOMException('Aborted', 'AbortError')), { once: true });
      reading();
    } }));
  }) });
  const run = queue.start();
  await begun;
  queue.pause();
  await run;
  assert.equal(queue.get().phase, 'paused');
  assert.equal(queue.get().done, 1);
  assert.equal(queue.get().failures.length, 0);
  hold = false;
  await queue.start();
  assert.equal(queue.get().phase, 'complete');
  assert.deepEqual(calls, ['/assets/a', '/assets/b', '/assets/b']);
});

test('timeouts and transient errors retry a bounded number of times', async () => {
  let calls = 0;
  const queue = createAssetDownload({ timeoutMs: 10, retries: 1, fetch: fixture({ a: '/assets/a' }, (_url, { signal }) => {
    calls++;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  }) });
  await queue.start();
  assert.equal(calls, 2);
  assert.equal(queue.get().phase, 'partial');
  let tries = 0;
  const recovered = createAssetDownload({ fetch: fixture({ a: '/assets/a' }, async () => ++tries === 1 ? new Response('', { status: 503 }) : file()) });
  await recovered.start();
  assert.equal(tries, 2);
  assert.equal(recovered.get().phase, 'complete');
});

test('optional local manifest absence is disclosed; failed base manifest is never complete', async () => {
  const queue = createAssetDownload({ fetch: fixture({ a: '/assets/a' }, async () => file(), null) });
  await queue.start();
  assert.equal(queue.get().phase, 'complete');
  assert.equal(queue.get().localMissing, true);
  const broken = createAssetDownload({ fetch: async () => new Response('missing', { status: 404 }) });
  await broken.start();
  assert.equal(broken.get().phase, 'error');
  assert.equal(broken.get().total, 0);
});

test('0.3.0 manifest groups stay in the queue: extra dubs, stats art and a local device file', () => {
  const urls = collectAssetUrls({
    voiceEn: { char_a: { battle: '/assets/~abcdef0123456789/audio/voice/en/char_a/battle.mp3' } },
    voiceKr: { char_a: { battle: '/assets/audio/voice/kr/char_a/battle.mp3' } },
    voiceNative: { char_a: { battle: '/assets/audio/voice/native/char_a/battle.mp3' } },
    ui: { stats: { trophy: '/assets/ui/stats/trophy.png' } },
  }, {
    groups: { 'mesh/trap_110': { model: { path: '/assets/local/mesh/trap_110/trap_1106_achplat.bin' } } },
  });
  assert.ok(urls.includes('/media/~abcdef0123456789/voice/en/char_a/battle'));
  assert.ok(urls.includes('/media/voice/kr/char_a/battle'));
  assert.ok(urls.includes('/media/voice/native/char_a/battle'));
  assert.ok(urls.includes('/assets/ui/stats/trophy.png'));
  assert.ok(urls.includes('/assets/local/mesh/trap_110/trap_1106_achplat.bin'));
  assert.equal(urls.filter((url) => url.startsWith('/media/')).length, 3);
});

test('a completed check reads updated manifests and downloads newly supplied files', async () => {
  const manifest = { a: '/assets/a' };
  const calls = [];
  const queue = createAssetDownload({ fetch: fixture(manifest, async (url) => { calls.push(url); return file(); }) });
  await queue.start();
  manifest.b = '/assets/b';
  await queue.start();
  assert.equal(queue.get().done, 2);
  assert.deepEqual(calls, ['/assets/a', '/assets/a', '/assets/b']);
});

test('the official battle effects manifest (/data/local-fx.json, DESIGN §33) is queued when the host has it', async () => {
  const got = [];
  const queue = createAssetDownload({
    lookupImported: async () => new Set(),
    fetch: fixture({ a: '/assets/~1234567890abcdef/a.png' }, async (url) => { got.push(url); return file(); }, { groups: {} },
      { format: 'fx-manifest', groups: { 'fx/prefabs': { common_hit_01: { path: '/assets/~fedcba0987654321/local/fx/prefabs/common_hit_01.json' } } } }),
  });
  await queue.start();
  assert.equal(queue.get().phase, 'complete');
  assert.ok(got.includes('/assets/~fedcba0987654321/local/fx/prefabs/common_hit_01.json'));
  assert.ok(got.includes('/assets/~1234567890abcdef/a.png'));
});

// This fork's two kinds of extra material: the operator outfits (`chars[<charId>].skins[<skinId>]`: the front and
// back Spine models, the avatar and the portrait) and the local-client art of data/local-assets.json
// (`/assets/local/…`). Both reach the queue only because collectAssetUrls walks the served manifest instead of a key
// list (docs/SKINS.md, docs/ASSETS.md §13): a filter that ever started excluding a subtree fails here.
test('the committed manifests are queued whole: operator skins (front and back) and public/assets/local', () => {
  const assets = JSON.parse(readFileSync(new URL('../../data/assets.json', import.meta.url), 'utf8'));
  const local = JSON.parse(readFileSync(new URL('../../data/local-assets.json', import.meta.url), 'utf8'));
  const urls = new Set(collectAssetUrls(assets, local));

  // 1. every art URL of either manifest is queued, whatever key path it sits under (audio under its /media/ URL)
  const missing = [];
  const walk = (value) => {
    if (typeof value === 'string') {
      if (/^\/(?:assets|fonts)\/[^/]/.test(value) && !/[?#\\]/.test(value) && !urls.has(mediaUrl(value))) missing.push(value);
      return;
    }
    if (value && typeof value === 'object') for (const child of Object.values(value)) walk(child);
  };
  walk(assets);
  walk(local);
  assert.equal(missing.length, 0, `art URLs the queue never sees: ${missing.slice(0, 5).join(', ')}`);

  // 2. the outfits: every set the manifest carries, both directions, its art and its model members
  let sets = 0;
  let files = 0;
  for (const [charId, char] of Object.entries(assets.chars)) {
    for (const [skinId, skin] of Object.entries(char.skins || {})) {
      sets++;
      for (const url of [skin.avatar, skin.portrait]) {
        if (!url) continue;
        assert.ok(urls.has(url), `${charId}/${skinId}: ${url}`);
        files++;
      }
      for (const dir of ['front', 'back']) {
        const model = skin.spine?.[dir];
        if (!model) continue;
        for (const url of [model.skel, model.atlas, ...(model.textures || [])]) {
          if (!url) continue;
          assert.ok(urls.has(url), `${charId}/${skinId}/${dir}: ${url}`);
          files++;
        }
      }
    }
  }
  assert.ok(sets > 0 && files >= sets * 4, `outfits walked: ${sets} sets / ${files} files`);

  // 3. the local-client art (`data/local-assets.json` → `/assets/local/…`)
  const localPaths = [];
  const paths = (value) => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.path === 'string') localPaths.push(value.path);
    for (const child of Object.values(value)) paths(child);
  };
  paths(local.groups);
  assert.ok(localPaths.length > 0);
  assert.equal(localPaths.filter((path) => !urls.has(path)).length, 0, `local files the queue never sees: ${localPaths.slice(0, 5).join(', ')}`);
});
