'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WorldStore, ArchiveError } = require('../world-archive/lib/store.cjs');
const tempStore = t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-test-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return new WorldStore(path.join(base, 'archive'));
};
test('create, list, update and delete worlds', t => {
  const s = tempStore(t);
  assert.deepEqual(s.list(), []);
  const a = s.create({ name: '  호그와트  ', description: '1988년' });
  assert.equal(a.name, '호그와트');
  assert.equal(s.list()[0].worldId, a.worldId);
  const b = s.update(a.worldId, { name: '호그와트 1988', revision: 1 });
  assert.equal(b.revision, 2);
  assert.equal(s.delete(a.worldId, 2).deleted, true);
  assert.equal(s.list().length, 0);
});
test('survives a new store instance', t => {
  const a = tempStore(t); a.create({ name: 'World A' });
  assert.equal(new WorldStore(a.dir).list().length, 1);
});
test('rejects invalid input and optimistic lock conflicts', t => {
  const s = tempStore(t), w = s.create({ name: 'A' });
  assert.throws(() => s.create({ name: '' }), e => e.status === 400);
  assert.throws(() => s.update(w.worldId, { name: 'B', revision: 3 }), e => e.status === 409);
  assert.throws(() => s.delete(w.worldId, 9), e => e.status === 409);
  assert.equal(s.list()[0].name, 'A');
});
test('does not overwrite corrupted or unsupported saved data', t => {
  const s = tempStore(t); s.create({ name: 'Safe' });
  fs.writeFileSync(s.file, '{broken json', 'utf8');
  assert.throws(() => s.create({ name: 'Should fail' }), ArchiveError);
  assert.equal(fs.readFileSync(s.file, 'utf8'), '{broken json');
  fs.writeFileSync(s.file, '{"schemaVersion":99,"worlds":[]}', 'utf8');
  assert.throws(() => s.create({ name: 'Should fail' }), ArchiveError);
  assert.match(fs.readFileSync(s.file, 'utf8'), /99/);
});
test('does not confuse same names with distinct worlds', t => {
  const s = tempStore(t);
  const a=s.create({name:'호그와트'}), b=s.create({name:'호그와트'});
  assert.notEqual(a.worldId,b.worldId);
  assert.equal(s.list().length,2);
});
