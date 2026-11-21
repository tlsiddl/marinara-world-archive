'use strict';
// v0.7.8 — A: 「House of X」 · 「X 가문」 · 「X family」 are a family, not a 기숙사 (code's wrong values go back by the history);
// B: a 위치 read the other way round is never turned by code — 「서로 다른 말을 해요」, the person chooses;
//    「the entrance to X」 · 「opens into X」 is not inside X;
// C: an animal's 머리색 is 털 · 깃털; a value is a colour, never cut mid-word, never a state of the hair.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Archive, looksColour } = require('../world-archive/lib/store.cjs');
const I = require('../world-archive/lib/inject.cjs');

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-078-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new Archive(dir);
}
const idOf = (s, w) => (n) => s.listEntities(w).find((e) => e.name === n).entityId;
/** what v0.7.7 and earlier wrote by code: a field change in the history, as it was recorded */
function oldWrite(s, worldId, name, key, value, by) {
  const doc = s.readEntities(worldId);
  const e = doc.entities.find((x) => x.name === name);
  e.fields = { ...(e.fields || {}), [key]: value };
  e.sources = { ...(e.sources || {}), [key]: 'auto' };
  e.revision++;
  s.writeJson(s.entityFile(worldId), doc);
  s.pushHistory(worldId, [{ id: randomUUID(), at: new Date().toISOString(), by, roomId: null, messageIds: [], entityId: e.entityId, name, type: 'person', action: 'field', key, before: '', after: value, evidence: 'x' }]);
}

test('A: a family is never a 기숙사 — 「House of Vane」 · 「Vane family」 (even under a school); 「Slytherin House」 is', (t) => {
  const s = temp(t);
  const w = s.createWorld({ name: 'Hogwarts' }).worldId;
  s.updateWorld(w, { revision: s.getWorld(w).revision, personFields: ['house', 'year'] });
  s.applyAuto(w, [
    { type: 'group', name: 'Hogwarts School' }, { type: 'group', name: 'House of Vane' }, { type: 'group', name: 'Selwyn family' },
    { type: 'group', name: 'Slytherin House' }, { type: 'group', name: 'Ravenclaw' },
    { type: 'person', name: 'Irina' }, { type: 'person', name: 'Oswin' }, { type: 'person', name: 'Pansy' }, { type: 'person', name: 'Luna' },
  ]);
  const id = idOf(s, w);
  s.applyRelations(w, [
    { from: id('Selwyn family'), to: id('Hogwarts School'), type: '소속', note: '', evidence: 'x' },
    { from: id('Ravenclaw'), to: id('Hogwarts School'), type: '소속', note: '', evidence: 'x' },
    { from: id('Irina'), to: id('House of Vane'), type: '소속', note: '', evidence: 'x' },
    { from: id('Oswin'), to: id('Selwyn family'), type: '소속', note: '', evidence: 'x' },
    { from: id('Pansy'), to: id('Slytherin House'), type: '소속', note: '', evidence: 'x' },
    { from: id('Luna'), to: id('Ravenclaw'), type: '소속', note: '', evidence: 'x' },
  ]);
  s.fillHouseYear(w);
  const house = (n) => s.listEntities(w).find((e) => e.name === n).fields.house;
  assert.equal(house('Irina'), undefined);
  assert.equal(house('Oswin'), undefined, 'a family right under a school is still a family');
  assert.equal(house('Pansy'), 'Slytherin');
  assert.equal(house('Luna'), 'Ravenclaw');
});

test('A: code\'s old 기숙사 from a family goes back through the history; the person\'s and right ones stay', (t) => {
  const s = temp(t);
  const w = s.createWorld({ name: 'Hogwarts' }).worldId;
  s.updateWorld(w, { revision: s.getWorld(w).revision, personFields: ['house', 'year'] });
  s.applyAuto(w, [{ type: 'group', name: 'House of Vane' }, { type: 'group', name: 'Slytherin House' }, { type: 'person', name: 'Irina' }, { type: 'person', name: 'Pansy' }, { type: 'person', name: 'Mine' }]);
  const id = idOf(s, w);
  s.applyRelations(w, [
    { from: id('Irina'), to: id('House of Vane'), type: '소속', note: '', evidence: 'x' },
    { from: id('Pansy'), to: id('Slytherin House'), type: '소속', note: '', evidence: 'x' },
    { from: id('Mine'), to: id('House of Vane'), type: '소속', note: '', evidence: 'x' },
  ]);
  oldWrite(s, w, 'Irina', 'house', 'Vane', 'roster');
  oldWrite(s, w, 'Pansy', 'house', 'Slytherin', 'roster');
  const mine = s.listEntities(w).find((e) => e.name === 'Mine');
  s.updateEntity(w, mine.entityId, { revision: mine.revision, fields: { house: 'Vane' } });
  const undone = s.undoWrongHouses(w);
  assert.deepEqual(undone.map((x) => x.name), ['Irina']);
  const f = (n) => s.listEntities(w).find((e) => e.name === n).fields;
  assert.equal(f('Irina').house, undefined);
  assert.equal(f('Pansy').house, 'Slytherin');
  assert.equal(f('Mine').house, 'Vane', 'what the person wrote stays');
  assert.ok(s.listHistory(w).find((c) => c.name === 'Irina' && c.key === 'house').undoneAt, 'undone in the history');
  assert.deepEqual(s.undoWrongHouses(w), [], 'once');
});

test('B: a 위치 read the other way round stays as it is — 「서로 다른 말을 해요」, recorded, undoable; the person settles it', (t) => {
  const s = temp(t);
  const w = s.createWorld({ name: 'London' }).worldId;
  s.applyAuto(w, [{ type: 'place', name: 'Leaky Cauldron' }, { type: 'place', name: 'Diagon Alley' }]);
  const id = idOf(s, w);
  s.applyRelations(w, [{ from: id('Leaky Cauldron'), to: id('Diagon Alley'), type: '위치', note: '', evidence: 'first' }]);
  s.applyRelations(w, [{ from: id('Diagon Alley'), to: id('Leaky Cauldron'), type: '위치', note: '', evidence: 'behind a pub' }], { by: 'location-fill' });
  let r = s.readEntities(w).relations[0];
  assert.deepEqual([r.from, r.to], [id('Leaky Cauldron'), id('Diagon Alley')], 'not turned');
  assert.deepEqual([r.differs.from, r.differs.to, r.differs.evidence], [id('Diagon Alley'), id('Leaky Cauldron'), 'behind a pub']);
  // the same other reading again: nothing new
  assert.deepEqual(s.applyRelations(w, [{ from: id('Diagon Alley'), to: id('Leaky Cauldron'), type: '위치', note: '', evidence: 'behind a pub' }]), []);
  const c = s.listHistory(w).find((x) => x.action === 'relation-differs');
  s.undoChange(w, c.id);
  assert.equal(s.readEntities(w).relations[0].differs, undefined, 'undone');
  s.applyRelations(w, [{ from: id('Diagon Alley'), to: id('Leaky Cauldron'), type: '위치', note: '', evidence: 'again' }]);
  r = s.readEntities(w).relations[0];
  s.updateRelation(w, r.relationId, { differs: null });
  assert.equal(s.readEntities(w).relations[0].differs, undefined, '「지금대로 두기」');
  s.applyRelations(w, [{ from: id('Diagon Alley'), to: id('Leaky Cauldron'), type: '위치', note: '', evidence: 'once more' }]);
  r = s.readEntities(w).relations[0];
  assert.equal(r.source, 'manual');
  assert.equal(r.differs, undefined, 'the person\'s relation is not marked by code either');
});

test('B: a person turning it round settles it; 소속 read the other way still turns (only 위치 is held)', (t) => {
  const s = temp(t);
  const w = s.createWorld({ name: 'London' }).worldId;
  s.applyAuto(w, [{ type: 'place', name: 'Pub' }, { type: 'place', name: 'Alley' }, { type: 'group', name: 'A' }, { type: 'group', name: 'B' }]);
  const id = idOf(s, w);
  s.applyRelations(w, [{ from: id('Pub'), to: id('Alley'), type: '위치', note: '', evidence: 'x' }, { from: id('A'), to: id('B'), type: '소속', note: '', evidence: 'x' }]);
  s.applyRelations(w, [{ from: id('Alley'), to: id('Pub'), type: '위치', note: '', evidence: 'y' }, { from: id('B'), to: id('A'), type: '소속', note: '', evidence: 'y' }]);
  const rels = s.readEntities(w).relations;
  const pos = rels.find((r) => r.type === '위치');
  assert.deepEqual([pos.from, pos.to], [id('Pub'), id('Alley')]);
  const aff = rels.find((r) => r.type === '소속');
  assert.deepEqual([aff.from, aff.to], [id('B'), id('A')]);
  s.updateRelation(w, pos.relationId, { from: pos.to, to: pos.from });
  const after = s.readEntities(w).relations.find((r) => r.type === '위치');
  assert.deepEqual([after.from, after.to, after.differs], [id('Alley'), id('Pub'), undefined]);
});

test('B: 위치 code turned round before (v0.7.7) → 「서로 다른 말」 with the other reading\'s evidence, kept as it is now', (t) => {
  const s = temp(t);
  const w = s.createWorld({ name: 'London' }).worldId;
  s.applyAuto(w, [{ type: 'place', name: 'Leaky Cauldron' }, { type: 'place', name: 'Diagon Alley' }, { type: 'place', name: 'Hall' }, { type: 'place', name: 'Castle' }]);
  const id = idOf(s, w);
  s.applyRelations(w, [{ from: id('Leaky Cauldron'), to: id('Diagon Alley'), type: '위치', note: '', evidence: 'now' }, { from: id('Hall'), to: id('Castle'), type: '위치', note: '', evidence: 'x' }]);
  const r = s.readEntities(w).relations.find((x) => x.from === id('Leaky Cauldron'));
  // as v0.7.7 recorded a flip: Diagon Alley → Leaky Cauldron turned to Leaky Cauldron → Diagon Alley
  s.pushHistory(w, [{ id: randomUUID(), at: new Date().toISOString(), by: 'location-fill', roomId: null, messageIds: [], entityId: r.from, entityIds: [r.from, r.to], name: 'x', type: 'relation', action: 'relation-flip', relation: { ...r, from: r.to, to: r.from, evidence: 'Diagon Alley, behind a pub' }, before: { from: r.to, to: r.from }, after: { from: r.from, to: r.to }, evidence: 'now' }]);
  const ch = s.flipsToDiffers(w);
  assert.equal(ch.length, 1);
  const now = s.readEntities(w).relations.find((x) => x.relationId === r.relationId);
  assert.deepEqual([now.from, now.to], [id('Leaky Cauldron'), id('Diagon Alley')], 'kept as it is');
  assert.deepEqual([now.differs.from, now.differs.to, now.differs.evidence], [id('Diagon Alley'), id('Leaky Cauldron'), 'Diagon Alley, behind a pub']);
  assert.deepEqual(s.flipsToDiffers(w), [], 'once');
});

test('B: 「장소 위치 채우기」 — 「the entrance to X」 · 「opens into X」 · 「X, in London, behind …」 is not inside X', async (t) => {
  const service = require('../world-archive/lib/service.cjs');
  const real = require('../world-archive/lib/vendor/engine.cjs');
  const s = temp(t);
  service._test.useStore(s);
  const w = s.createWorld({ name: 'London', auto: { connectionId: 'c1' } }).worldId;
  s.applyAuto(w, [
    { type: 'place', name: 'Diagon Alley' },
    { type: 'place', name: 'Leaky Cauldron', fields: { location: 'Charing Cross Road, London; the entrance to Diagon Alley' }, memo: 'Its back yard has a brick wall that opens into Diagon Alley. Diagon Alley, in London, behind a public house.' },
    { type: 'place', name: 'Flourish and Blotts', fields: { location: 'Diagon Alley, three doors up from Madam Malkin\'s' }, memo: 'A bookshop in Diagon Alley.' },
  ]);
  service._test.useEngine({ model: async (c) => ({ id: c }), askModel: async (m, messages) => {
    assert.match(messages[0].content, /entrance to Diagon Alley/);
    return { content: JSON.stringify({ places: [{ name: 'Leaky Cauldron', in: 'Diagon Alley' }, { name: 'Flourish and Blotts', in: 'Diagon Alley' }] }) };
  }, parseJsonObject: real.parseJsonObject });
  await service.fillPlaces(w);
  const id = idOf(s, w);
  const up = (n) => s.readEntities(w).relations.filter((r) => r.type === '위치' && r.from === id(n)).map((r) => r.to);
  assert.deepEqual(up('Leaky Cauldron'), []);
  assert.deepEqual(up('Flourish and Blotts'), [id('Diagon Alley')]);
});

test('C: a colour, not a state; short; animals\' 털 · 깃털 in {{세계}}', (t) => {
  for (const v of ['black', 'sleek silver-blond', 'Red-gold', 'orange-and-black patchwork', '검은색', 'silver-grey']) assert.ok(looksColour(v), v);
  for (const v of ['hair that needs cutting', 'balding', '', 'x'.repeat(70), '짧게 자름']) assert.ok(!looksColour(v), v);
  const s = temp(t);
  const w = s.createWorld({ name: 'Hogwarts' }).worldId;
  s.applyAuto(w, [{ type: 'person', name: 'Fawkes', fields: { species: 'Phoenix', hair: 'Red-gold' } }, { type: 'person', name: 'Tom', fields: { species: 'Human', hair: 'grey' } }]);
  const text = I.assembleWorld(s.getWorld(w), s.listEntities(w), 3000, {}).text;
  assert.match(text, /털 · 깃털: Red-gold/);
  assert.match(text, /머리색: grey/);
});

test('C: 「머리색 · 눈색 채우기」 never cuts mid-word (a long one → its first clause) and drops a state; old bad ones go back', async (t) => {
  const service = require('../world-archive/lib/service.cjs');
  const real = require('../world-archive/lib/vendor/engine.cjs');
  const s = temp(t);
  service._test.useStore(s);
  const w = s.createWorld({ name: 'Hogwarts', auto: { connectionId: 'c1' } }).worldId;
  const long = 'silver-grey, darker along the spine like old pewter and almost black at the tail tip';
  s.applyAuto(w, [
    { type: 'person', name: 'Beatrix', fields: { species: 'Cat', appearance: `A cat, ${long}; green eyes` } },
    { type: 'person', name: 'Barnaby', fields: { appearance: 'Brown hair that needs cutting, a crooked nose' } },
    { type: 'person', name: 'Tom', fields: { appearance: 'Balding, grey eyes' } },
  ]);
  let prompt = '';
  service._test.useEngine({ model: async (c) => ({ id: c }), askModel: async (m, msgs) => { prompt = msgs[1].content; return { content: JSON.stringify({ people: [
    { name: 'Beatrix', hair: long, eyes: 'green' }, { name: 'Barnaby', hair: 'hair that needs cutting', eyes: '' },
  ] }) }; }, parseJsonObject: real.parseJsonObject });
  await service.fillHairEyes(w);
  assert.match(prompt, /Beatrix \(종: Cat\)/);
  const f = (n) => s.listEntities(w).find((e) => e.name === n).fields;
  assert.deepEqual([f('Beatrix').hair, f('Beatrix').eyes], ['silver-grey', 'green']);
  assert.equal(f('Barnaby').hair, undefined);
  // what v0.7.6 · v0.7.7 wrote: a state, and a value cut at 60
  oldWrite(s, w, 'Barnaby', 'hair', 'hair that needs cutting', 'hair-fill');
  oldWrite(s, w, 'Tom', 'hair', 'balding', 'hair-fill');
  const doc = s.readEntities(w);
  const b = doc.entities.find((e) => e.name === 'Beatrix');
  delete b.fields.hair;
  s.writeJson(s.entityFile(w), doc);
  oldWrite(s, w, 'Beatrix', 'hair', long.slice(0, 60), 'hair-fill');
  const undone = s.undoBadLooks(w);
  assert.deepEqual(undone.map((x) => x.name).sort(), ['Barnaby', 'Beatrix', 'Tom']);
  assert.equal(f('Beatrix').eyes, 'green', 'the good one stays');
  assert.deepEqual(s.undoBadLooks(w), []);
});
