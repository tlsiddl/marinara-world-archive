'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Archive, ArchiveError } = require('../world-archive/lib/store.cjs');

const temp = (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-store-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return new Archive(path.join(base, 'world-archive'));
};
const status = (code) => (e) => e instanceof ArchiveError && e.status === code;

test('worlds: create, list, update, delete with revisions', (t) => {
  const s = temp(t);
  assert.deepEqual(s.listWorlds(), []);
  const a = s.createWorld({ name: '  별빛   학원  ', description: '1988년, 산 위의 기숙학교' });
  assert.equal(a.name, '별빛 학원');
  assert.equal(a.injectChars, 3000);
  const b = s.updateWorld(a.worldId, { name: '별빛 학원 1988', revision: 1 });
  assert.equal(b.revision, 2);
  assert.throws(() => s.updateWorld(a.worldId, { name: 'x', revision: 1 }), status(409));
  assert.throws(() => s.updateWorld(a.worldId, { revision: 2 }), status(400));
  assert.throws(() => s.updateWorld(a.worldId, { injectChars: 10, revision: 2 }), status(400));
  assert.equal(s.deleteWorld(a.worldId, 2).deleted, true);
  assert.equal(s.listWorlds().length, 0);
});

test('data survives a new Archive instance (restart)', (t) => {
  const s = temp(t);
  const w = s.createWorld({ name: 'A' });
  s.createEntity(w.worldId, { type: 'person', name: '한여름', description: '3학년 반장' });
  s.linkRoom('room_1', w.worldId);
  const again = new Archive(s.dir);
  assert.equal(again.listEntities(w.worldId)[0].name, '한여름');
  assert.equal(again.roomWorldId('room_1'), w.worldId);
});

test('same names stay separate worlds and entities', (t) => {
  const s = temp(t);
  const a = s.createWorld({ name: '별빛 학원' });
  const b = s.createWorld({ name: '별빛 학원' });
  assert.notEqual(a.worldId, b.worldId);
  const x = s.createEntity(a.worldId, { type: 'person', name: '서준' });
  const y = s.createEntity(a.worldId, { type: 'person', name: '서준' });
  assert.notEqual(x.entityId, y.entityId);
  assert.equal(s.listEntities(b.worldId).length, 0);
});

test('entities: validation, aliases, revisions, delete', (t) => {
  const s = temp(t);
  const w = s.createWorld({ name: 'A' });
  assert.throws(() => s.createEntity(w.worldId, { type: 'dragon', name: 'x' }), status(400));
  assert.throws(() => s.createEntity(w.worldId, { type: 'person', name: '   ' }), status(400));
  assert.throws(() => s.createEntity(w.worldId, { type: 'person', name: 'x', pinned: 'yes' }), status(400));
  const e = s.createEntity(w.worldId, { type: 'person', name: '윤도하', aliases: ['도하', 'Doha', '도하', '윤도하'] });
  assert.deepEqual(e.aliases, ['도하', 'Doha']);
  assert.equal(e.status, 'confirmed');
  assert.deepEqual(e.provenance, { source: 'manual' });
  const e2 = s.updateEntity(w.worldId, e.entityId, { name: '도하', revision: 1 });
  assert.deepEqual(e2.aliases, ['Doha'], 'an alias equal to the new name is dropped');
  assert.equal(e2.type, 'person');
  assert.throws(() => s.updateEntity(w.worldId, e.entityId, { name: 'z', revision: 1 }), status(409));
  assert.throws(() => s.deleteEntity(w.worldId, e.entityId, 1), status(409));
  assert.equal(s.deleteEntity(w.worldId, e.entityId, 2).deleted, true);
  assert.throws(() => s.listEntities('not-an-id'), status(400));
});

test('rooms: link, relink, unlink, branch inheritance', (t) => {
  const s = temp(t);
  const a = s.createWorld({ name: 'A' });
  const b = s.createWorld({ name: 'B' });
  assert.equal(s.getRoom('r1').worldId, null);
  s.linkRoom('r1', a.worldId);
  s.linkRoom('r1', b.worldId);
  assert.equal(s.roomWorldId('r1'), b.worldId);
  assert.equal(s.inheritRoom('r1', 'r2'), true);
  assert.equal(s.roomWorldId('r2'), b.worldId);
  s.linkRoom('r3', a.worldId);
  assert.equal(s.inheritRoom('r1', 'r3'), false, 'an existing link is never replaced');
  assert.equal(s.roomWorldId('r3'), a.worldId);
  s.linkRoom('r1', null);
  assert.equal(s.roomWorldId('r1'), null);
  assert.throws(() => s.linkRoom('../x', a.worldId), status(400));
  assert.throws(() => s.linkRoom('r9', '00000000-0000-4000-8000-000000000000'), status(404));
  assert.equal(s.roomWorldId('../../etc'), null);
});

test('deleting a world keeps a copy in trash and unlinks its rooms', (t) => {
  const s = temp(t);
  const w = s.createWorld({ name: '지울 세계' });
  s.createEntity(w.worldId, { type: 'place', name: '옥상 정원' });
  s.linkRoom('r1', w.worldId);
  const out = s.deleteWorld(w.worldId, 1);
  assert.equal(out.unlinkedRooms, 1);
  assert.equal(s.roomWorldId('r1'), null);
  assert.equal(fs.existsSync(s.entityFile(w.worldId)), false);
  const [bin] = fs.readdirSync(s.trashDir);
  const saved = JSON.parse(fs.readFileSync(path.join(s.trashDir, bin, 'world.json'), 'utf8'));
  assert.equal(saved.world.name, '지울 세계');
  assert.equal(saved.entities[0].name, '옥상 정원');
  assert.deepEqual(saved.rooms, ['r1']);
});

test('broken or newer files are never overwritten', (t) => {
  const s = temp(t);
  const w = s.createWorld({ name: 'Safe' });
  fs.writeFileSync(s.worldsFile, '{broken json', 'utf8');
  assert.throws(() => s.createWorld({ name: 'x' }), status(409));
  assert.equal(fs.readFileSync(s.worldsFile, 'utf8'), '{broken json');
  fs.writeFileSync(s.worldsFile, '{"schemaVersion":99,"worlds":[]}', 'utf8');
  assert.throws(() => s.createWorld({ name: 'x' }), status(409));
  assert.match(fs.readFileSync(s.worldsFile, 'utf8'), /99/);

  const s2 = temp(t);
  const w2 = s2.createWorld({ name: 'B' });
  fs.mkdirSync(s2.entityDir, { recursive: true });
  fs.writeFileSync(s2.entityFile(w2.worldId), '{"schemaVersion":1,"worldId":"other","entities":[]}');
  assert.throws(() => s2.createEntity(w2.worldId, { type: 'person', name: 'x' }), status(409));
  assert.throws(() => s2.deleteWorld(w2.worldId, 1), status(409), 'a world whose settings cannot be read is not deleted');
  assert.equal(s2.listWorlds().length, 1);
  void w;
});

test('no temporary files are left behind', (t) => {
  const s = temp(t);
  const w = s.createWorld({ name: 'A' });
  s.createEntity(w.worldId, { type: 'rule', name: '통금', description: '밤 10시' });
  s.linkRoom('r1', w.worldId);
  const all = [...fs.readdirSync(s.dir), ...fs.readdirSync(s.entityDir)];
  assert.equal(all.filter((f) => f.endsWith('.tmp')).length, 0);
});
