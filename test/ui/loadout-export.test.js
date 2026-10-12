// 干员调配导出/导入的「只加字段」约束：带皮肤的新载荷能被读懂，不带皮肤的旧载荷行为与结构完全不变。
//
// 需求方指定：导出的文件即使在没有皮肤的版本里也必须是原版可用的。所以这里断言两件事——
//   1) 没有选任何皮肤时，导出的载荷与 0.2.4 的结构逐字段相同（不多一个键）；
//   2) 旧版本（没有 skins 字段）的载荷导入后，与它自己导出时一致（不多不少）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportPayload, parseImport } from '../../public/js/ui/loadoutModel.js';

const ENTRIES = { chess_char_1_01_a: { skill: 2, module: 'uniequip_001_x' }, chess_char_1_08_a: { skill: 0 } };
const OPS = { char_498_inside: { potential: 3, cultivate: 1 } };
const KIND = 'stronghold.loadout';

test('no skins picked → the payload is byte-identical to the pre-skins structure', () => {
  const plain = exportPayload(ENTRIES, { now: 0, ops: OPS });
  assert.deepEqual(Object.keys(plain).sort(), ['count', 'entries', 'exportedAt', 'kind', 'ops', 'v']);
  assert.equal('skins' in plain, false);

  // an explicit empty map must behave the same way (nothing to carry)
  const empty = exportPayload(ENTRIES, { now: 0, ops: OPS, skins: {} });
  assert.equal('skins' in empty, false);
  assert.deepEqual(empty, plain);
});

test('skins picked → one extra optional field, everything else untouched', () => {
  const withSkins = exportPayload(ENTRIES, { now: 0, ops: OPS, skins: { chess_char_1_01_a: 'char_498_inside@summer#22' } });
  const plain = exportPayload(ENTRIES, { now: 0, ops: OPS });
  assert.deepEqual(withSkins.skins, { chess_char_1_01_a: 'char_498_inside@summer#22' });
  // every original field is identical — the skins field is purely additive
  for (const k of Object.keys(plain)) assert.deepEqual(withSkins[k], plain[k], k);
  // and it survives a round trip
  const parsed = parseImport(JSON.stringify(withSkins));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.skins, withSkins.skins);
  assert.deepEqual(parsed.entries, ENTRIES);
  assert.deepEqual(parsed.ops, OPS);
});

test('a payload without skins (an older export) parses exactly as before', () => {
  const old = { kind: KIND, v: 1, exportedAt: '2026-01-01T00:00:00.000Z', count: 2, entries: ENTRIES, ops: OPS };
  const r = parseImport(JSON.stringify(old));
  assert.equal(r.ok, true);
  assert.deepEqual(r.entries, ENTRIES);
  assert.deepEqual(r.ops, OPS);
  assert.equal('skins' in r, false, 'no skins key in the result');
  // the bare map form and the stored form still work too
  assert.equal(parseImport(JSON.stringify(ENTRIES)).ok, true);
  assert.equal(parseImport(JSON.stringify({ v: 1, entries: ENTRIES })).ok, true);
});

test('a junk / oversized skins field is ignored, not fatal', () => {
  const base = { kind: KIND, v: 1, entries: ENTRIES };
  for (const skins of [null, 42, 'x', [], { bad: 1 }, { chess_char_1_01_a: 123 }]) {
    const r = parseImport(JSON.stringify({ ...base, skins }));
    assert.equal(r.ok, true, `skins=${JSON.stringify(skins)} should not break the import`);
    assert.equal('skins' in r, false, `skins=${JSON.stringify(skins)} must be dropped`);
  }
  // a payload of settings only is still refused (nothing to apply)
  assert.equal(parseImport(JSON.stringify({ kind: KIND, v: 1, entries: {} })).ok, false);
});
