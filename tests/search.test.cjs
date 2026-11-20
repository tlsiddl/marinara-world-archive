'use strict';
// 할 일 6 — 검색: name → other name → content, case and spaces ignored, glossary English, kinds filter, marked parts.
const test = require('node:test');
const assert = require('node:assert/strict');
const { search } = require('../world-archive/lib/search.cjs');
const { FIELDS } = require('../world-archive/lib/store.cjs');

const e = (entityId, type, name, extra = {}) => ({ entityId, type, name, aliases: [], fields: {}, description: '', extra: [], ...extra });
const world = [
  e('a', 'person', '세베루스 스네이프', { aliases: ['Severus Snape'], fields: { affiliation: '슬리데린 사감' } }),
  e('b', 'person', '미네르바 맥고나걸', { fields: { personality: '엄격하지만 공정함. 스네이프와 자주 다툼' } }),
  e('c', 'place', '슬리데린 휴게실', { description: '호수 아래에 있다' }),
  e('d', 'group', '슬리데린', { aliases: ['Slytherin'] }),
  e('e', 'person', '해그리드', { extra: [{ label: '애완동물', value: '팽(Fang)' }] }),
];

test('results come name first, then other name, then content; the matched part is marked in the original text', () => {
  const r = search(world, '스네이프', { fields: FIELDS });
  assert.deepEqual(r.map((x) => [x.entityId, x.rank]), [['a', 0], ['b', 2]]);
  const h = r[1].hits[0];
  assert.equal(h.where, 'personality');
  assert.equal(h.label, '성격');
  assert.equal(h.text.slice(h.start, h.end), '스네이프');
  const s = search(world, '슬리데린');
  assert.deepEqual(s.map((x) => [x.entityId, x.rank]), [['d', 0], ['c', 0], ['a', 2]]);
});

test('case and spaces do not matter; other names, memo and extra fields count', () => {
  assert.deepEqual(search(world, 'severussnape').map((x) => [x.entityId, x.rank, x.hits[0].where]), [['a', 1, 'alias']]);
  const sp = search(world, '세베루스스네이프')[0].hits[0];
  assert.equal(sp.text.slice(sp.start, sp.end), '세베루스 스네이프', 'the mark keeps the space of the original');
  assert.equal(search(world, '호수 아래')[0].hits[0].where, 'description');
  assert.equal(search(world, 'FANG')[0].hits[0].where, 'extra:애완동물');
  assert.deepEqual(search(world, '   '), []);
});

test('the glossary\'s English finds the Korean name; kinds can be filtered', () => {
  const glossary = [{ from: 'Minerva McGonagall', to: '미네르바 맥고나걸' }];
  const r = search(world, 'mcgonagall', { glossary });
  assert.deepEqual(r.map((x) => [x.entityId, x.rank, x.hits[0].where]), [['b', 1, 'glossary']]);
  assert.equal(r[0].hits[0].text.slice(r[0].hits[0].start, r[0].hits[0].end), 'McGonagall');
  assert.deepEqual(search(world, '슬리데린', { types: ['place'] }).map((x) => x.entityId), ['c']);
});

test('a long text is cut around the match', () => {
  const long = 'ㄱ'.repeat(300) + '찾는말' + 'ㄴ'.repeat(300);
  const [r] = search([e('x', 'rule', '규칙', { description: long })], '찾는말');
  const h = r.hits[0];
  assert.ok(h.text.length < 200);
  assert.equal(h.text.slice(h.start, h.end), '찾는말');
});
