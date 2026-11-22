'use strict';
// v0.8.3 (사령탑 「규칙 · 시스템 몫 먼저」 + 덧붙임 3-1 · 3-2): {{세계}} is filled in tiers with a short form —
// the people of the scene never drop out (short at worst, the latest named first), the rules keep at least a fifth,
// and with room: the scene's people whole → the rules here · named lately whole → every other rule at least short →
// what is left (people · places out of the scene, named lately → often).
const test = require('node:test');
const assert = require('node:assert/strict');
const I = require('../world-archive/lib/inject.cjs');

let n = 0;
const ent = (type, name, extra = {}) => ({ entityId: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, type, name, aliases: [], fields: {}, description: '', status: 'confirmed', pinned: false, ...extra });
const world = (mode) => ({ name: '은사슴', description: '', injectMode: mode });
const person = (name, more = {}) => ent('person', name, { fields: { gender: '여', age: '11', hair: '은발', eyes: '회색', affiliation: '은사슴 1학년', appearance: '긴 설명 '.repeat(40), personality: '성격 '.repeat(30), state: '지금은 별시계탑에 있다. 그리고 다른 일도 있다.' }, ...more });
const rule = (name, more = {}) => ent('rule', name, { description: `${name}의 요지다. 덧붙임 `.padEnd(220, '가'), appliesTo: 'world', ...more });

function big() {
  const hall = ent('place', '대식당', { fields: { location: '은사슴 학교 1층' } });
  const people = Array.from({ length: 12 }, (_, i) => person(`학생 ${String(i).padStart(2, '0')}`));
  const away = Array.from({ length: 6 }, (_, i) => person(`다른 사람 ${i}`));
  const here = Array.from({ length: 4 }, (_, i) => rule(`대식당 규칙 ${i}`, { appliesTo: hall.entityId }));
  const laws = Array.from({ length: 20 }, (_, i) => rule(`세계 규칙 ${String(i).padStart(2, '0')}`));
  const E = [hall, ...people, ...away, ...here, ...laws];
  const scene = new Set([hall.entityId, ...people.map((p) => p.entityId)]);
  // 학생 11 is named last, 학생 00 first
  const mentions = new Map(people.map((p, i) => [p.entityId, { last: i, n: 1 }]));
  return { E, hall, people, away, here, laws, scene, mentions };
}

test('3-1: a small budget — every person of the scene is in (short at worst), the latest named first; the rules keep 1/5', () => {
  const { E, people, laws, here, scene, mentions } = big();
  for (const mode of ['scene', 'all']) {
    const r = I.assembleWorld(world(mode), E, 3000, { scene, mentions, relations: [] });
    assert.equal(r.scenePeople.out, 0, `${mode}: nobody of the scene is out`);
    assert.ok(r.scenePeople.short > 0, `${mode}: some are short`);
    const lawIds = new Set([...laws, ...here].map((e) => e.entityId));
    const lawChars = r.text.split('\n').filter((l) => l.startsWith('- ') && [...laws, ...here].some((e) => l.startsWith(`- ${e.name}`))).join('\n').length;
    assert.ok(r.included.some((id) => lawIds.has(id)), `${mode}: rules are in`);
    assert.ok(lawChars >= 3000 / 5 - 200, `${mode}: the rules hold about a fifth or more (${lawChars})`);
    const order = r.included.filter((id) => people.some((p) => p.entityId === id));
    assert.equal(order[0], people.at(-1).entityId, `${mode}: the one named last comes first`);
  }
});

test('3-2: with room — scene people whole, the rules here whole, every world rule at least short, then the rest', () => {
  const { E, people, away, here, laws, scene, mentions } = big();
  const r = I.assembleWorld(world('scene'), E, 40000, { scene, mentions, relations: [] });
  for (const p of people) assert.equal(r.forms[p.entityId], 'full', p.name);
  for (const x of here) assert.equal(r.forms[x.entityId], 'full', x.name);
  for (const x of laws) assert.ok(r.forms[x.entityId], x.name);
  for (const x of away) assert.ok(r.included.includes(x.entityId), `${x.name}: out of the scene, with room to spare`);
  assert.ok(r.included.indexOf(away[0].entityId) > r.included.indexOf(laws.at(-1).entityId), 'out of the scene comes after every rule');
  // a middle budget: the scene's people get whole before the world rules beyond the floor
  const mid = I.assembleWorld(world('scene'), E, 12000, { scene, mentions, relations: [] });
  const full = people.filter((p) => mid.forms[p.entityId] === 'full').length;
  assert.ok(full >= 6, `half or more of the scene whole at 12,000 (${full})`);
  assert.deepEqual(mid.groups.here.sort(), here.map((x) => x.entityId).sort());
});

test('short forms: a person (성별 · 나이 · 머리 · 눈 · 소속 — 지금 첫 마디), a rule (곳 · 요지 첫 마디), hidden left out', () => {
  const { E, people, scene, mentions } = big();
  assert.equal(I.shortLine(people.at(-1)), '- 학생 11 (여 · 11 · 머리 은발 · 눈 회색 · 은사슴 1학년) — 지금은 별시계탑에 있다.');
  const r = I.assembleWorld(world('scene'), E, 1500, { scene, mentions, relations: [] });
  assert.ok(r.text.includes('- 학생 00 (여 · 11'), 'a short one in the text');
  const hid = person('숨은 사람', {});
  hid.hidden = { age: true, state: true };
  const r2 = I.assembleWorld(world('scene'), [hid, ...E], 300, { scene: new Set([hid.entityId]), relations: [] });
  assert.match(r2.text, /- 숨은 사람 \(여 · 머리 은발 · 눈 회색 · 은사슴 1학년\)$/m);
  const ruleLine = I.assembleWorld(world('all'), [rule('통금', { description: '밤 10시 이후 복도 금지. 사감이 순찰한다.' })], 400, {}).text;
  assert.match(ruleLine, /- 통금/);
  void people;
});

test('all mode: people named lately first (not by name), then the rest by how often', () => {
  const a = person('가가'), b = person('나나'), c = person('다다', { seen: { n: 5, last: 'x' } });
  const mentions = new Map([[b.entityId, { last: 3, n: 2 }], [a.entityId, { last: 1, n: 1 }]]);
  const r = I.assembleWorld(world('all'), [a, b, c], 40000, { scene: new Set([a.entityId, b.entityId]), mentions, relations: [] });
  assert.deepEqual(r.included, [b.entityId, a.entityId, c.entityId]);
});
