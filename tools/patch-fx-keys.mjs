// tools/patch-fx-keys.mjs — merge a small "fx keys" pack into an existing extraction.
//
// Why this exists: the official effect assets (`public/assets/local/fx/**`) and their two manifests
// (`data/local-fx.json`, `public/assets/local/fx/index.json`, `…/textures.json`) are generated on each machine by
// `tools/local-extract/extract.py --only fx`, so they never ship with the repository. When a later release adds a
// handful of effect keys (a binding in `public/js/render/vfx/skills.js` referring to a key the older extraction
// never exported), updating a server means either re-running the whole 8-minute extraction or merging just those
// keys. This script does the second: it reads the pack (prefabs + textures already unpacked into
// `public/assets/local/fx/`, and `data/fx-keys.json` describing them) and adds the missing entries to the three
// manifests. Idempotent: running it twice adds nothing the second time.
//
// Usage:  node tools/patch-fx-keys.mjs [--dry-run]
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const dry = process.argv.includes('--dry-run');
const read = (rel, fallback = null) => {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return fallback;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
};
const write = (rel, obj) => {
  const p = path.join(ROOT, rel);
  if (!dry) fs.writeFileSync(p, JSON.stringify(obj));
  return rel;
};

const pack = read('data/fx-keys.json');
if (!pack) {
  console.error('  data/fx-keys.json not found — unpack the fx-keys pack into the project first');
  process.exit(1);
}

const added = { prefabs: 0, localFx: 0, textures: 0 };
const missing = [];

// 1. data/local-fx.json — the client's prefab table (key → where the prefab JSON lives).
const localFx = read('data/local-fx.json');
if (localFx?.groups?.['fx/prefabs']) {
  for (const [key, entry] of Object.entries(pack.localFx ?? {})) {
    if (localFx.groups['fx/prefabs'][key]) continue;
    localFx.groups['fx/prefabs'][key] = entry;
    added.localFx += 1;
  }
  if (added.localFx) console.log('  ' + (dry ? '[dry] ' : '') + 'data/local-fx.json: +' + added.localFx);
  if (added.localFx) write('data/local-fx.json', localFx);
} else missing.push('data/local-fx.json');

// 2. public/assets/local/fx/index.json — the descriptor table the runtime reads (nodes / looping / spawn …).
const index = read('public/assets/local/fx/index.json');
if (index?.prefabs) {
  for (const [key, entry] of Object.entries(pack.prefabs ?? {})) {
    if (index.prefabs[key]) continue;
    if (!fs.existsSync(path.join(ROOT, 'public/assets/local/fx', entry.file))) { missing.push(entry.file); continue; }
    index.prefabs[key] = entry;
    added.prefabs += 1;
  }
  if (added.prefabs) console.log('  ' + (dry ? '[dry] ' : '') + 'index.json: +' + added.prefabs + ' prefab(s)');
  if (added.prefabs) write('public/assets/local/fx/index.json', index);
} else missing.push('public/assets/local/fx/index.json');

// 3. public/assets/local/fx/textures.json — texture id → the .webp next to the prefabs (full and half size).
const tex = read('public/assets/local/fx/textures.json');
if (tex?.textures) {
  for (const [id, rel] of Object.entries(pack.textures ?? {})) {
    if (tex.textures[id]) continue;
    if (!fs.existsSync(path.join(ROOT, 'public/assets/local/fx', rel))) { missing.push(rel); continue; }
    tex.textures[id] = rel;
    added.textures += 1;
  }
  if (added.textures) console.log('  ' + (dry ? '[dry] ' : '') + 'textures.json: +' + added.textures + ' texture(s)');
  if (added.textures) write('public/assets/local/fx/textures.json', tex);
} else missing.push('public/assets/local/fx/textures.json');

const total = added.prefabs + added.localFx + added.textures;
console.log(total ? '  done: ' + JSON.stringify(added) + (dry ? ' (dry run, nothing written)' : '') : '  nothing to add — already merged');
if (missing.length) console.log('  skipped (file not found): ' + [...new Set(missing)].slice(0, 8).join(', '));
