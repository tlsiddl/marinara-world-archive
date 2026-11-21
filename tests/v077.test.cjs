'use strict';
// v0.7.7 (셸이 찾은 버그): PATCH …/entities/:id merges fields — only the keys sent change, "" or null takes a key off,
// the keys not sent stay. hidden · pastInPrompt merge the same way; aliases · extra (lists) are replaced when sent.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Archive } = require('../world-archive/lib/store.cjs');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-077-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new Archive(dir);
  const w = s.createWorld({ name: 'Hogwarts' });
  s.applyAuto(w.worldId, [{ type: 'person', name: 'Pansy', aliases: ['Pans'], fields: { gender: 'Female', age: '11', hair: 'black', appearance: 'Sleek black bob', personality: 'Sharp' } }]);
  const get = () => s.listEntities(w.worldId).find((e) => e.name === 'Pansy');
  return { s, w, get };
}

test('only the keys sent change; the rest stay', (t) => {
  const { s, w, get } = setup(t);
  const e = get();
  s.updateEntity(w.worldId, e.entityId, { revision: e.revision, fields: { personality: 'Sharp and proud' } });
  const f = get().fields;
  assert.deepEqual(f, { gender: 'Female', age: '11', hair: 'black', appearance: 'Sleek black bob', personality: 'Sharp and proud' });
  assert.equal(get().sources.personality, 'manual');
  assert.equal(get().sources.gender, 'auto', 'a key not sent keeps its source');
  const edit = s.listHistory(w.worldId).find((c) => c.action === 'edit');
  assert.deepEqual(edit.keys, ['personality'], 'recorded: only the key that changed');
});

test('all fields sent: the same as before (a full replace that names every key)', (t) => {
  const { s, w, get } = setup(t);
  const e = get();
  s.updateEntity(w.worldId, e.entityId, { revision: e.revision, fields: { ...e.fields, age: '12' } });
  assert.deepEqual(get().fields, { ...e.fields, age: '12' });
});

test('"" or null takes only that key off', (t) => {
  const { s, w, get } = setup(t);
  let e = get();
  s.updateEntity(w.worldId, e.entityId, { revision: e.revision, fields: { hair: '' } });
  e = get();
  assert.equal(e.fields.hair, undefined);
  assert.equal(e.fields.appearance, 'Sleek black bob');
  s.updateEntity(w.worldId, e.entityId, { revision: e.revision, fields: { age: null } });
  assert.equal(get().fields.age, undefined);
  assert.equal(get().fields.gender, 'Female');
});

test('a stale revision is 409 and nothing changes', (t) => {
  const { s, w, get } = setup(t);
  const e = get();
  s.updateEntity(w.worldId, e.entityId, { revision: e.revision, fields: { age: '12' } });
  assert.throws(() => s.updateEntity(w.worldId, e.entityId, { revision: e.revision, fields: { age: '13' } }), (x) => x.status === 409);
  assert.equal(get().fields.age, '12');
});

test('hidden merges too; aliases are replaced when sent', (t) => {
  const { s, w, get } = setup(t);
  let e = get();
  s.updateEntity(w.worldId, e.entityId, { revision: e.revision, hidden: { age: true, hair: true } });
  e = get();
  s.updateEntity(w.worldId, e.entityId, { revision: e.revision, hidden: { hair: false } });
  assert.deepEqual(get().hidden, { age: true }, 'the key not sent (age) stays hidden');
  e = get();
  s.updateEntity(w.worldId, e.entityId, { revision: e.revision, aliases: ['Parkinson'] });
  assert.deepEqual(get().aliases, ['Parkinson'], 'a list sent is the whole list');
  assert.equal(get().fields.hair, 'black', 'fields untouched when not sent');
});
