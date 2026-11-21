'use strict';
// v0.7.6 — 인물 카드 네 칸: fields.hair · fields.eyes (every world), fields.house · fields.year (a world turns them on);
// 기숙사 · 학년 by code from 소속 · 명단; 머리색 · 눈색 from the 외형 only (never invented).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const X = require('../world-archive/lib/extract.cjs');
const { Archive, FIELDS } = require('../world-archive/lib/store.cjs');

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-076-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new Archive(dir);
}

test('the four keys are person fields; 기숙사 · 학년 optional; a world turns them on', (t) => {
  const keys = FIELDS.person.map((f) => f.key);
  for (const k of ['hair', 'eyes', 'house', 'year']) assert.ok(keys.includes(k), k);
  assert.deepEqual(FIELDS.person.filter((f) => f.optional).map((f) => f.key), ['house', 'year']);
  const s = temp(t);
  const w = s.createWorld({ name: 'Hogwarts' });
  s.updateWorld(w.worldId, { revision: s.getWorld(w.worldId).revision, personFields: ['house', 'year'] });
  assert.deepEqual(s.getWorld(w.worldId).personFields, ['house', 'year']);
  assert.throws(() => s.updateWorld(w.worldId, { revision: s.getWorld(w.worldId).revision, personFields: ['wand'] }), (e) => e.status === 400);
  s.updateWorld(w.worldId, { revision: s.getWorld(w.worldId).revision, personFields: [] });
  assert.equal(s.getWorld(w.worldId).personFields, undefined);
});

test('the reader is asked for 기숙사 · 학년 only in a world that has them', () => {
  const [part] = X.batches([{ id: 'm1', speaker: 'A', role: 'assistant', content: 'Pansy is a Slytherin first-year.' }], 0);
  const off = X.buildPrompt({ name: 'w' }, [], part, [], [], null, 'en')[0].content;
  const on = X.buildPrompt({ name: 'w', personFields: ['house', 'year'] }, [], part, [], [], null, 'en')[0].content;
  assert.match(off, /hair\(머리색\), eyes\(눈색\)/);
  assert.doesNotMatch(off, /house\(기숙사\)/);
  assert.match(on, /house\(기숙사\), year\(학년\)/);
});

test('기숙사 · 학년 by code from 소속 · 명단; empty only, never the person\'s; undoable', (t) => {
  const s = temp(t);
  const w = s.createWorld({ name: 'Hogwarts' });
  s.updateWorld(w.worldId, { revision: s.getWorld(w.worldId).revision, personFields: ['house', 'year'] });
  s.applyAuto(w.worldId, [
    { type: 'group', name: 'Hogwarts School' }, { type: 'group', name: 'Slytherin House' }, { type: 'group', name: 'Slytherin first-years' },
    { type: 'group', name: 'Ravenclaw' },
    { type: 'person', name: 'Pansy Burke' }, { type: 'person', name: 'Luna', fields: { affiliation: 'Ravenclaw, 2nd-year' } }, { type: 'person', name: 'Mine' },
  ]);
  const id = (n) => s.listEntities(w.worldId).find((e) => e.name === n).entityId;
  s.applyRelations(w.worldId, [
    { from: id('Slytherin first-years'), to: id('Slytherin House'), type: '소속', note: '', evidence: 'Slytherin first-years of Slytherin House' },
    { from: id('Ravenclaw'), to: id('Hogwarts School'), type: '소속', note: '', evidence: 'Ravenclaw of Hogwarts School' },
    { from: id('Pansy Burke'), to: id('Slytherin first-years'), type: '소속', note: '', evidence: 'Pansy Burke, one of the Slytherin first-years' },
    { from: id('Luna'), to: id('Ravenclaw'), type: '소속', note: '', evidence: 'Luna of Ravenclaw' },
    { from: id('Mine'), to: id('Slytherin first-years'), type: '소속', note: '', evidence: 'Mine, of the Slytherin first-years' },
  ]);
  const mine = s.listEntities(w.worldId).find((e) => e.name === 'Mine');
  s.updateEntity(w.worldId, mine.entityId, { revision: mine.revision, fields: { house: 'Gryffindor' } });
  const changes = s.fillHouseYear(w.worldId);
  const f = (n) => s.listEntities(w.worldId).find((e) => e.name === n).fields;
  assert.deepEqual([f('Pansy Burke').house, f('Pansy Burke').year], ['Slytherin', '1']);
  assert.deepEqual([f('Luna').house, f('Luna').year], ['Ravenclaw', '2'], 'a group right under a school is a house; the year from the 소속 칸');
  assert.deepEqual([f('Mine').house, f('Mine').year], ['Gryffindor', '1'], 'the person\'s house stays');
  s.undoChange(w.worldId, changes.find((c) => c.name === 'Pansy Burke' && c.key === 'house').id);
  assert.equal(f('Pansy Burke').house, undefined);
  // a world without them: nothing
  const w2 = s.createWorld({ name: 'Elsewhere' });
  s.applyAuto(w2.worldId, [{ type: 'group', name: 'Slytherin House' }, { type: 'person', name: 'X' }]);
  assert.deepEqual(s.fillHouseYear(w2.worldId), []);
});

test('「머리색 · 눈색 채우기」: from the 외형 only — a value not in it is dropped; empty fields only', async (t) => {
  const service = require('../world-archive/lib/service.cjs');
  const real = require('../world-archive/lib/vendor/engine.cjs');
  const s = temp(t);
  service._test.useStore(s);
  const w = s.createWorld({ name: 'Hogwarts', auto: { connectionId: 'c1' } });
  s.applyAuto(w.worldId, [
    { type: 'person', name: 'Pansy', fields: { appearance: 'Sleek black hair in a bob, dark eyes, a pointed chin' } },
    { type: 'person', name: 'Draco', fields: { appearance: 'Pale and pointed, silver-blond hair', eyes: 'grey' } },
  ]);
  service._test.useEngine({ model: async (c) => ({ id: c }), askModel: async () => ({ content: JSON.stringify({ people: [
    { name: 'Pansy', hair: 'sleek black', eyes: 'dark' }, { name: 'Draco', hair: 'silver-blond', eyes: 'piercing blue' },
  ] }) }), parseJsonObject: real.parseJsonObject });
  const r = await service.fillHairEyes(w.worldId);
  const f = (n) => s.listEntities(w.worldId).find((e) => e.name === n).fields;
  assert.deepEqual([f('Pansy').hair, f('Pansy').eyes], ['sleek black', 'dark']);
  assert.deepEqual([f('Draco').hair, f('Draco').eyes], ['silver-blond', 'grey'], 'eyes were there already; 「piercing blue」 is not in the 외형 anyway');
  assert.equal(f('Pansy').appearance, 'Sleek black hair in a bob, dark eyes, a pointed chin', 'the 외형 stays');
  assert.equal(r.filled.length, 2);
});
