'use strict';
// v0.7.2 — a world organized in English: the Korean word lists have their English beside them; scene order; 숨김 by the
// story's own words; 소속 칸 against a relation; other names; 정리 후보 ②; 주제 guide; names; 대표 이름.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const R = require('../world-archive/lib/roster.cjs');
const I = require('../world-archive/lib/inject.cjs');
const N = require('../world-archive/lib/names.cjs');
const X = require('../world-archive/lib/extract.cjs');
const { Archive } = require('../world-archive/lib/store.cjs');

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-072-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new Archive(dir);
}

test('0) English word lists: roles · past · described names · laws · currency', () => {
  assert.ok(R.ROLE_WORDS.test('Slytherin Head of House'));
  assert.ok(R.ROLE_WORDS.test('Head parlourmaid of the Dukedom'));
  assert.ok(!R.ROLE_WORDS.test('Slytherin first-year'));
  assert.ok(R.PAST_WORDS.test('former Ravenclaw'));
  assert.ok(R.unnamed("Pansy Parkinson's cousin") && R.unnamed('one of the Carrow girls'));
  assert.ok(!R.unnamed('Gemma Farley'));
  assert.ok(I.LAW_NAME.test('Statute of Secrecy') && I.LAW_NAME.test('Decree for the Reasonable Restriction of Underage Wizardry'));
  assert.ok(I.WORLD_SYSTEM.test('Wizarding currency') && !I.LAW_NAME.test('Actually fine'));
});

test('0) English: 「beneath the Black Lake」 is not in the lake; dungeons under the castle are in it', (t) => {
  const s = temp(t);
  const w = s.createWorld({ name: 'Hogwarts' });
  s.applyAuto(w.worldId, [
    { type: 'place', name: 'Black Lake' },
    { type: 'place', name: 'Hogwarts Castle' },
    { type: 'place', name: 'Slytherin common room', fields: { location: 'beneath the Black Lake' } },
    { type: 'place', name: 'Potions dungeon', fields: { location: 'under Hogwarts Castle' } },
  ]);
  s.linkPlaces(w.worldId);
  const id = (n) => s.listEntities(w.worldId).find((e) => e.name === n).entityId;
  const up = (n) => s.listRelations(w.worldId).filter((r) => r.type === '위치' && r.from === id(n)).map((r) => r.to);
  assert.deepEqual(up('Slytherin common room'), []);
  assert.deepEqual(up('Potions dungeon'), [id('Hogwarts Castle')]);
});

test('A) scene order: spoken of in more batches before the name order; K) 주제 instead of 분류', () => {
  const w = { name: 'H', injectMode: 'scene' };
  const ents = [
    { entityId: 'p', type: 'place', name: 'Great Hall', aliases: [], fields: {}, status: 'confirmed' },
    { entityId: 'a', type: 'rule', name: 'A one-off', aliases: [], fields: { category: 'Prohibition' }, appliesTo: 'p', status: 'confirmed', seen: { n: 1 } },
    { entityId: 'z', type: 'rule', name: 'Z house points', aliases: [], fields: { category: 'Scoring' }, topic: '그 밖', appliesTo: 'p', status: 'confirmed', seen: { n: 5 } },
  ];
  const text = I.assembleWorld(w, ents, 3000, { scene: new Set(['p']), relations: [] }).text;
  assert.ok(text.indexOf('Z house points') < text.indexOf('A one-off'), 'more often first');
  assert.match(text, /주제: 그 밖/);
  assert.doesNotMatch(text, /분류: Scoring/);
});

test('G) another person\'s family name is not this one\'s other name; a sign is not a name', (t) => {
  const s = temp(t);
  const w = s.createWorld({ name: 'Hogwarts' });
  s.applyAuto(w.worldId, [
    { type: 'person', name: 'Julian Vane' },
    { type: 'person', name: 'Minerva McGonagall', aliases: ['Miss Vane', 'Professor McGonagall'] },
    { type: 'person', name: 'Clara', aliases: ['Clara Vane'] },
    { type: 'place', name: 'Ollivanders', aliases: ['Ollivanders: Makers of Fine Wands since 382 B.C.'] },
  ]);
  s.tidyAliases(w.worldId);
  const by = (n) => s.listEntities(w.worldId).find((e) => e.name === n);
  assert.ok(!by('Minerva McGonagall').aliases.includes('Miss Vane'));
  assert.ok(by('Minerva McGonagall').aliases.includes('Professor McGonagall'));
  assert.deepEqual(by('Clara').aliases, ['Clara Vane'], 'her own name in it');
  assert.ok(!by('Ollivanders').aliases.some((a) => a.includes(':')));
});

test('H) the 소속 칸 says Gryffindor, a relation says Slytherin first-years: the relation goes, shown as 서로 다른 말', (t) => {
  const s = temp(t);
  const w = s.createWorld({ name: 'Hogwarts' });
  s.applyAuto(w.worldId, [
    { type: 'group', name: 'Gryffindor' }, { type: 'group', name: 'Slytherin first-years' },
    { type: 'person', name: 'Tabitha Abbott', fields: { affiliation: 'Gryffindor first-year' } },
  ]);
  const id = (n) => s.listEntities(w.worldId).find((e) => e.name === n).entityId;
  s.applyRelations(w.worldId, [{ from: id('Tabitha Abbott'), to: id('Slytherin first-years'), type: '소속', note: '', evidence: 'Tabitha Abbott sat with the Slytherin first-years.' }]);
  const removed = s.recheckRelations(w.worldId);
  assert.ok(removed.some((c) => c.why === 'affiliation differs'));
  assert.equal(s.listEntities(w.worldId).find((e) => e.name === 'Tabitha Abbott').differs.affiliation.value, 'Slytherin first-years');
});

test('E) 정리 후보 ②: spoken of once, not a law · 유래·역사; 「남기기」 takes it off', (t) => {
  const s = temp(t);
  const w = s.createWorld({ name: 'Hogwarts' });
  // v0.8.0: 「한 번 나옴」 only in a world read long enough (100 messages)
  s.linkRoom('roomOnce0000000000001', w.worldId);
  s.setRoomRead('roomOnce0000000000001', { lastId: 'm120', count: 120 });
  s.applyAuto(w.worldId, [{ type: 'rule', name: 'Snape quizzes on Friday' }, { type: 'rule', name: 'Statute of Secrecy' }, { type: 'rule', name: 'Old founders' }], { messageIds: ['m1'] });
  const id = (n) => s.listEntities(w.worldId).find((e) => e.name === n).entityId;
  s.setTopic(w.worldId, id('Old founders'), '유래·역사', { by: 'reader' });
  s.saveTidy(w.worldId, { at: null, items: [], fields: [] });
  const names = () => s.readTidy(w.worldId).once.map((x) => x.name);
  assert.deepEqual(names(), ['Snape quizzes on Friday']);
  s.keepTidy(w.worldId, id('Snape quizzes on Friday'));
  assert.deepEqual(names(), []);
});

test('C) the topic guide in the reader\'s prompt (English examples in an English world); one person\'s words are not a rule', () => {
  const [part] = X.batches([{ id: 'm1', speaker: 'A', role: 'assistant', content: 'Curfew is at ten.' }], 0);
  const en = X.buildPrompt({ name: 'w' }, [], part, [], [], null, 'en')[0].content;
  assert.match(en, /Topic meanings/);
  assert.match(en, /Daphne/);
  assert.match(X.buildPrompt({ name: 'w' }, [], part, [], [], null)[0].content, /주제 뜻/);
});

test('J) names of an English world: the Korean other name, then each word of two', () => {
  const pairs = N.englishNamePairs([{ type: 'person', name: 'Morwenna Selwyn', aliases: ['모웨나 셀윈'] }, { type: 'person', name: 'Rolanda Hooch', aliases: [] }], { 'Rolanda Hooch': '롤란다 후치' });
  assert.deepEqual(pairs.map((p) => `${p.from}=${p.to}`), ['Morwenna Selwyn=모웨나 셀윈', 'Morwenna=모웨나', 'Selwyn=셀윈', 'Rolanda Hooch=롤란다 후치', 'Rolanda=롤란다', 'Hooch=후치']);
});

test('L) 대표 이름: an other name said more than twice as often — suggested, never renamed', (t) => {
  const s = temp(t);
  const w = s.createWorld({ name: 'Liverpool' });
  s.applyAuto(w.worldId, [{ type: 'person', name: 'Margaret Doyle', aliases: ['Margaret Holloway', 'Margaret'] }]);
  const story = ['Margaret Holloway bowed.', 'Margaret Holloway left.', 'Margaret Holloway returned.', 'Margaret Doyle, they said.'];
  assert.equal(s.suggestNames(w.worldId, story), 1);
  const e = s.listEntities(w.worldId)[0];
  assert.deepEqual([e.name, e.nameSuggest], ['Margaret Doyle', 'Margaret Holloway']);
});

test('I) recheck in English: a sheet named in Korean gets its English name, a glossary-paired subject too, a 종', (t) => {
  const s = temp(t);
  const w = s.createWorld({ name: 'Hogwarts' });
  s.applyAuto(w.worldId, [{ type: 'group', name: 'Slytherin first-years' }, { type: 'person', name: 'Bloody Baron', fields: { species: '유령' } }]);
  const g = s.listEntities(w.worldId).find((e) => e.type === 'group');
  s.applyTimetable(w.worldId, [{ ownerId: g.entityId, day: '월', slot: '1교시', value: '변신술' }]);
  const changes = s.englishValues(w.worldId, { pairs: [{ from: 'Transfiguration', to: '변신술' }] });
  const sheet = s.listEntities(w.worldId).find((e) => e.timetable);
  assert.equal(sheet.name, 'Slytherin first-years Timetable');
  assert.equal(Object.values(sheet.timetable.cells)[0].value, 'Transfiguration');
  assert.equal(s.listEntities(w.worldId).find((e) => e.name === 'Bloody Baron').fields.species, 'Ghost');
  s.undoChange(w.worldId, changes.find((c) => c.action === 'cell').id);
  assert.equal(Object.values(s.listEntities(w.worldId).find((e) => e.timetable).timetable.cells)[0].value, '변신술');
});

test('v0.7.3 B: 「Inside Hogwarts Castle」 makes the group\'s 본거지 Hogwarts Castle, and 「At Hogwarts」 places go in it', (t) => {
  const s = temp(t);
  const w = s.createWorld({ name: 'Hogwarts' });
  s.applyAuto(w.worldId, [
    { type: 'group', name: 'Hogwarts' },
    { type: 'place', name: 'Owlery', fields: { location: 'At Hogwarts' } },
    { type: 'place', name: 'Entrance Hall', fields: { location: 'Inside Hogwarts Castle' } },
    { type: 'place', name: 'Black Lake', fields: { location: 'Below Hogwarts Castle, at the foot of a cliff' } },
  ]);
  s.linkPlaces(w.worldId);
  const ents = s.listEntities(w.worldId);
  const castle = ents.find((e) => e.name === 'Hogwarts Castle');
  assert.ok(castle && castle.type === 'place');
  assert.equal(ents.find((e) => e.name === 'Hogwarts').base, castle.entityId);
  const up = (n) => s.listRelations(w.worldId).filter((r) => r.type === '위치' && r.from === ents.find((e) => e.name === n).entityId).map((r) => r.to);
  assert.deepEqual(up('Entrance Hall'), [castle.entityId]);
  assert.deepEqual(up('Owlery'), [castle.entityId]);
  assert.deepEqual(up('Black Lake'), [], 'below is not inside');
});
