// 可选插件（docs/PLUGINS.md）：服务端扫描、清单校验、只能取清单里点名的文件、静态路由。
//
// 这里用一个临时目录造插件，不碰仓库里的 plugins/：注册表的行为由输入的文件夹决定。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  createPluginRegistry, scanPlugins, normalizePluginManifest, pluginIndex, isPluginId, isPluginPath,
  PLUGIN_MANIFEST, PLUGINS_URL,
} from '../server/plugins.js';
import { createStaticHandler } from '../server/http/static.js';
import { serveDirs } from '../server/http/config.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A temp project: plugins/<id>/… — returns { dirs, write } (write makes a file, parents included). */
function sandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-plugins-'));
  const pluginsDir = path.join(base, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  const write = (rel, text) => {
    const abs = path.join(base, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
    return abs;
  };
  const manifest = (id, patch = {}) => write(`plugins/${id}/${PLUGIN_MANIFEST}`, JSON.stringify({
    type: 'plugin', name: `Plugin ${id}`, version: '1.0.0', app: '*', entry: 'plugin.js',
    files: { css: 'plugin.css' }, ...patch,
  }));
  return { base, pluginsDir, write, manifest, dirs: { pluginsDir } };
}

test('a well-formed plugin folder loads: entry + files become URLs, the index lists it', () => {
  const s = sandbox();
  s.manifest('demo', { description: 'x', authors: ['me'], license: 'MIT', ui: true });
  s.write('plugins/demo/plugin.js', 'export default () => ({})');
  s.write('plugins/demo/plugin.css', '.x{}');
  s.write('plugins/demo/i18n/en.json', '{}'); // not named by the manifest → not served, not listed
  const { plugins, skipped } = scanPlugins(s.dirs);
  assert.equal(skipped.length, 0);
  assert.equal(plugins.length, 1);
  const p = plugins[0];
  assert.equal(p.id, 'demo');
  assert.equal(p.compatible, true);
  assert.equal(p.files.entry.url, `${PLUGINS_URL}demo/plugin.js`);
  assert.equal(p.files.css.url, `${PLUGINS_URL}demo/plugin.css`);
  assert.equal(p.files['i18n/en.json'], undefined, 'a file the manifest does not name is not part of the plugin');
  const index = pluginIndex(plugins);
  assert.equal(index.plugins.length, 1);
  assert.equal(index.plugins[0].entry, `${PLUGINS_URL}demo/plugin.js`);
  assert.equal(index.plugins[0].name, 'Plugin demo');
  assert.equal(index.plugins[0].ui, true);
  assert.equal(index.plugins[0].compatible, undefined, 'a compatible plugin does not carry the flag');
});

test('a folder name expands to the serveable files inside it (a plugin ships its own i18n)', () => {
  const s = sandbox();
  s.manifest('i18n-demo', { files: { css: 'plugin.css', i18n: 'i18n' } });
  s.write('plugins/i18n-demo/plugin.js', 'export default () => ({})');
  s.write('plugins/i18n-demo/plugin.css', '.x{}');
  s.write('plugins/i18n-demo/i18n/en.json', '{"a":"b"}');
  s.write('plugins/i18n-demo/i18n/ja.json', '{"a":"c"}');
  s.write('plugins/i18n-demo/i18n/README.md', 'note'); // .md is serveable
  s.write('plugins/i18n-demo/i18n/raw.bin', 'no');      // not a serveable extension
  const { plugins, skipped } = scanPlugins(s.dirs);
  assert.equal(skipped.length, 0);
  const files = Object.keys(plugins[0].files);
  assert.ok(files.includes('i18n/en.json') && files.includes('i18n/ja.json'));
  assert.ok(!files.includes('i18n/raw.bin'), 'only serveable extensions are expanded');
  assert.equal(plugins[0].files['i18n/en.json'].url, `${PLUGINS_URL}i18n-demo/i18n/en.json`);
});

test('a broken plugin is skipped with a reason, never fatal; a bad version range only warns', () => {
  const s = sandbox();
  s.manifest('no-entry-file');                       // manifest ok, plugin.js missing
  s.write('plugins/badjson/plugin.json', '{oops');
  s.manifest('wrong-type', { type: 'lang' });
  s.write('plugins/wrong-type/plugin.js', '');
  s.manifest('old', { app: '>=0.1.0 <0.2.0' });
  s.write('plugins/old/plugin.js', 'export default () => ({})');
  s.write('plugins/old/plugin.css', '');
  fs.mkdirSync(path.join(s.base, 'plugins', 'not-a-plugin'), { recursive: true });
  const { plugins, skipped, warnings } = scanPlugins(s.dirs);
  assert.deepEqual(plugins.map((p) => p.id), ['old'], 'only the loadable one');
  const reasons = Object.fromEntries(skipped.map((k) => [k.where.replace(/^plugins\//, ''), k.problems.join(' ')]));
  assert.match(reasons['no-entry-file'], /entry|missing/);
  assert.match(reasons.badjson, /not valid JSON/);
  assert.match(reasons['wrong-type'], /type must be "plugin"/);
  assert.match(reasons['not-a-plugin'], /no plugin\.json/);
  assert.equal(plugins[0].compatible, false, 'outside the app range');
  assert.equal(pluginIndex(plugins).plugins[0].compatible, false, 'the index says so');
  assert.ok(warnings.some((w) => /this server is/.test(w.warning)), 'and the log warns');
});

test('manifest validation: required fields, id equality, path rules', () => {
  const bad = normalizePluginManifest({ type: 'plugin' }, { id: 'x' });
  assert.equal(bad.manifest, null);
  assert.ok(bad.problems.some((p) => /name is required/.test(p)));
  assert.ok(bad.problems.some((p) => /version is required/.test(p)));
  assert.ok(bad.problems.some((p) => /entry is required/.test(p)));
  const escape = normalizePluginManifest({ type: 'plugin', name: 'n', version: '1.0.0', entry: '../../evil.js' }, { id: 'x' });
  assert.equal(escape.manifest, null, 'an entry that leads out of the folder is refused');
  const other = normalizePluginManifest({ type: 'plugin', name: 'n', version: '1.0.0', entry: 'a.js', id: 'y' }, { id: 'x' });
  assert.ok(other.warnings.some((w) => /folder name/.test(w)), 'a manifest id that disagrees only warns');
  assert.equal(other.manifest.id, 'x');
  assert.ok(isPluginId('dps-meter') && isPluginId('a.b_c-1'));
  assert.ok(!isPluginId('.hidden') && !isPluginId('a/b') && !isPluginId(''));
  assert.ok(isPluginPath('plugin.js') && isPluginPath('i18n/en.json') && isPluginPath('i18n'));
  assert.ok(!isPluginPath('../x.js') && !isPluginPath('/abs.js') && !isPluginPath('a\\b.js') && !isPluginPath('raw.bin') && !isPluginPath('i18n/raw.bin'));
});

test('the registry re-reads the folders when they change, and only serves files a manifest names', () => {
  const s = sandbox();
  s.manifest('one');
  s.write('plugins/one/plugin.js', 'export default () => ({})');
  s.write('plugins/one/plugin.css', '');
  s.write('plugins/one/secret.txt', 'not named by the manifest');
  const reg = createPluginRegistry(s.dirs, { recheckMs: 0 });
  assert.equal(reg.list().length, 1);
  assert.ok(reg.servable('one', 'plugin.js'), 'the entry is servable');
  assert.ok(reg.servable('one', 'plugin.css'));
  assert.equal(reg.servable('one', 'secret.txt'), null, 'a file the manifest does not name is not');
  assert.equal(reg.servable('nope', 'plugin.js'), null);
  assert.equal(reg.index().plugins.length, 1);

  s.manifest('two'); // a new folder appears
  s.write('plugins/two/plugin.js', 'export default () => ({})');
  s.write('plugins/two/plugin.css', '');
  assert.deepEqual(reg.list().map((p) => p.id).sort(), ['one', 'two']);

  fs.rmSync(path.join(s.base, 'plugins', 'one'), { recursive: true, force: true }); // and a folder leaves
  assert.deepEqual(reg.list().map((p) => p.id), ['two']);
  assert.equal(reg.servable('one', 'plugin.js'), null);
});

test('the static handler serves /plugins/index.json and the plugin files, 404 for anything else', async () => {
  const s = sandbox();
  s.manifest('demo');
  s.write('plugins/demo/plugin.js', 'export const marker = 1;');
  s.write('plugins/demo/plugin.css', '.demo{}');
  const dirs = serveDirs({ publicDir: path.join(ROOT, 'public'), dataDir: path.join(ROOT, 'data'), sharedDir: path.join(ROOT, 'shared'), pluginsDir: s.pluginsDir });
  const serveStatic = createStaticHandler({ ...dirs, log: { info: () => {}, warn: () => {}, error: () => {} } });
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    serveStatic(req, res, url.pathname, url.search.slice(1)).catch(() => { res.statusCode = 500; res.end(); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const get = (p) => new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body, type: res.headers['content-type'] }));
    });
  });
  try {
    const index = await get('/plugins/index.json');
    assert.equal(index.status, 200);
    const parsed = JSON.parse(index.body);
    // 0.3.0：`/plugins/index.json` 现在是**官方目录 + 本 fork 的插件**（server/http/static.js 把两个注册表
    // 合在了一起），所以不能再断言「只有 1 个」—— 按 id 找出沙箱里那一个，并确认 entry 的 URL 也给了。
    const demo = parsed.plugins.filter((p) => p && p.id === 'demo');
    assert.equal(demo.length, 1);
    assert.equal(demo[0].entry, '/plugins/demo/plugin.js');

    const js = await get('/plugins/demo/plugin.js');
    assert.equal(js.status, 200);
    assert.match(js.body, /marker = 1/);
    assert.match(String(js.type), /javascript/);

    const css = await get('/plugins/demo/plugin.css');
    assert.equal(css.status, 200);

    assert.equal((await get('/plugins/demo/nope.txt')).status, 404, 'a file the manifest does not name');
    assert.equal((await get('/plugins/unknown/plugin.js')).status, 404);
    assert.equal((await get('/plugins/../server/index.js')).status, 404, 'traversal');
    assert.equal((await get('/plugins/demo/plugin.json')).status, 404, 'the manifest itself is not served');
  } finally {
    srv.close();
  }
});

test('eslint 覆盖 plugins/**（否则插件等于没被检查，漏 import 只会在浏览器里炸）', () => {
  // flat config 里规则只对 `files` 命中的块生效：插件目录曾经不在任何块里，于是 no-unused-vars / no-undef
  // 全都不跑 —— 一个「忘了 import」的符号就这么发到了浏览器（会抛 uncaught ReferenceError）。
  const cfg = fs.readFileSync(path.join(ROOT, 'eslint.config.js'), 'utf8');
  assert.match(cfg, /files: \['plugins\/\*\*\/\*\.js'\]/, 'eslint.config.js 里要有 plugins/** 的块');
  const block = /files: \['plugins\/\*\*\/\*\.js'\][\s\S]*?\n  \},/.exec(cfg);
  assert.ok(block, 'plugins 块要成形');
  assert.match(block[0], /globals: \{ \.\.\.globals\.browser/, '插件跑在浏览器里：给它浏览器 globals');
  assert.match(block[0], /rules,/, '并且套上仓库的规则集（含 no-undef）');
});
