'use strict';
// 할 일 7 — 백업 · 복원: one file per world; restore makes a new world 「(복원)」 with no room linked; refuses newer or
// broken files without writing anything; backup → restore → backup gives the same content.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Archive } = require('../world-archive/lib/store.cjs');

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-bak-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new Archive(dir);
}

function filled(t) {
  const s = temp(t);
  const w = s.createWorld({ name: '호그와트', description: '1988년', injectChars: 4000, injectMode: 'scene', auto: { enabled: true, connectionId: 'c1', every: 5 } });
  s.applyAuto(w.worldId, [{ type: 'person', name: '해나', fields: { affiliation: '후플푸프' } }, { type: 'group', name: '후플푸프' }, { type: 'person', name: '해나 애벗' }]);
  s.linkAffiliations(w.worldId);
  const id = (n) => s.listEntities(w.worldId).find((e) => e.name === n).entityId;
  s.createRelation(w.worldId, { from: id('해나'), to: id('해나 애벗'), type: '기타', note: '같은 사람일지도' });
  s.dismissPair(w.worldId, id('해나'), id('해나 애벗'));
  s.linkRoom('room1', w.worldId);
  return { s, w };
}

const content = (b) => ({ ...b, exportedAt: undefined, world: { ...b.world, name: undefined, auto: { ...b.world.auto, enabled: undefined } }, rooms: undefined });

test('backup → restore → backup: the same content; restored as a new world 「(복원)」, no room linked, nothing overwritten', (t) => {
  const { s, w } = filled(t);
  const file = s.exportWorld(w.worldId);
  assert.equal(file.format, 'marinara-world-archive-backup');
  assert.equal(file.schemaVersion, 1);
  assert.deepEqual(file.rooms, ['room1']);
  assert.ok(file.entities.length === 3 && file.relations.length === 2 && file.history.length > 0 && file.dismissed.length === 1);
  const r = s.importWorld(JSON.parse(JSON.stringify(file)));
  assert.equal(r.world.name, '호그와트 (복원)');
  assert.notEqual(r.world.worldId, w.worldId);
  assert.equal(r.world.auto.enabled, false, 'a restored world does not read by itself until it is switched on');
  assert.equal(s.getRoom('room1').worldId, w.worldId, 'the room still reads the original only');
  assert.equal(s.listWorlds().length, 2, 'the original is still there');
  const again = s.exportWorld(r.world.worldId);
  assert.deepEqual(content(again), content(file));
  assert.deepEqual(again.rooms, []);
  assert.equal(s.listDuplicates(r.world.worldId).length, 0, 'the 「다른 사람이에요」 marks came along');
});

test('a newer, foreign or broken file is refused whole and nothing is written', (t) => {
  const { s, w } = filled(t);
  const file = s.exportWorld(w.worldId);
  const before = s.listWorlds().length;
  const bad = [
    [{ ...file, schemaVersion: 99 }, 409],
    [{ ...file, format: 'something-else' }, 400],
    [{ ...file, schemaVersion: undefined }, 400],
    [{ ...file, entities: 'x' }, 400],
    [{ ...file, entities: [...file.entities, file.entities[0]] }, 400],
    [{ ...file, relations: [{ ...file.relations[0], to: '00000000-0000-4000-8000-000000000000' }] }, 400],
    [{ ...file, history: [1] }, 400],
    [{ ...file, entities: Array.from({ length: 2001 }, () => file.entities[0]) }, 413],
    [null, 400],
  ];
  for (const [f, code] of bad) assert.throws(() => s.importWorld(f), (e) => e.status === code, JSON.stringify(f && { ...f, entities: f.entities?.length }).slice(0, 80));
  assert.equal(s.listWorlds().length, before);
});
