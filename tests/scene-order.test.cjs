'use strict';
// v0.5.0 D — {{세계}} in scene mode: pinned → the scene's settings → rules of the whole world (latest first) → rules of
// the places and groups here (with the places they are in, the bigger groups, the groups of the people) and their
// 시간표 → rules nobody said where for. A rule of a place not here stays out. Made-up world only (별시계 학원).
const test = require('node:test');
const assert = require('node:assert/strict');
const I = require('../world-archive/lib/inject.cjs');

let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const ent = (type, name, extra = {}) => ({ entityId: id(), type, name, aliases: [], description: '', fields: {}, extra: [], pinned: false, status: 'confirmed', revision: 1, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', ...extra });

function world() {
  const school = ent('group', '별시계 학원');
  const house = ent('group', '은사슴 기숙사');
  const year1 = ent('group', '은사슴 1학년');
  const manor = ent('place', '하르트 저택');
  const campus = ent('place', '별시계 캠퍼스');
  const tower = ent('place', '별시계탑');
  const hayun = ent('person', '하윤');
  const duke = ent('person', '하르트 공작');
  const E = [school, house, year1, manor, campus, tower, hayun, duke,
    ent('rule', '마법은 지팡이로', { appliesTo: 'world', updatedAt: '2026-11-02T00:00:00Z' }),
    ent('system', '금화와 은화', { appliesTo: 'world', updatedAt: '2026-11-05T00:00:00Z' }),
    ent('rule', '탑 계단은 오른쪽으로만', { appliesTo: tower.entityId }),
    ent('rule', '캠퍼스 안 비행 금지', { appliesTo: campus.entityId }),
    ent('rule', '기숙사 암호는 2주마다', { appliesTo: house.entityId }),
    ent('rule', '저택에서는 하인이 문을 연다', { appliesTo: manor.entityId }),
    ent('rule', '어디 것인지 모르는 규칙'),
    ent('schedule', '은사슴 1학년 시간표', { timetable: { ownerId: year1.entityId, cells: { '월|1교시': { day: '월', slot: '1교시', value: '별자리학', source: 'auto' } } } }),
  ];
  const R = [
    { from: tower.entityId, to: campus.entityId, type: '위치' },
    { from: year1.entityId, to: house.entityId, type: '소속' },
    { from: house.entityId, to: school.entityId, type: '소속' },
    { from: hayun.entityId, to: year1.entityId, type: '소속' },
  ];
  const by = (name) => E.find((e) => e.name === name).entityId;
  return { E, R, by };
}
const run = (E, R, scene, budget = 5000) => I.assembleWorld({ name: '별시계 학원', description: '', injectMode: 'scene' }, E, budget, { scene: new Set(scene), relations: R });
const names = (E, ids) => ids.map((x) => E.find((e) => e.entityId === x).name);

test('a school scene: world rules (latest first), then the rules of the tower, the campus it is in, the house and year of the person — not the manor\'s', () => {
  const { E, R, by } = world();
  const r = run(E, R, [by('하윤'), by('별시계탑')]);
  assert.deepEqual(names(E, r.included), [
    '하윤', '별시계탑', // the scene
    '금화와 은화', '마법은 지팡이로', // the whole world, latest first
    '탑 계단은 오른쪽으로만', '캠퍼스 안 비행 금지', '은사슴 1학년 시간표', '기숙사 암호는 2주마다', // here: the tower (0), the campus it is in (1), 하윤's year (1), the house of that year (2)
    '어디 것인지 모르는 규칙', // nobody said where
  ].filter((x) => r.included.some((i) => E.find((e) => e.entityId === i).name === x)));
  assert.ok(!names(E, r.included).includes('저택에서는 하인이 문을 연다'), 'a rule of a place not here stays out');
  assert.match(r.text, /- 탑 계단은 오른쪽으로만 \[별시계탑에서\]/);
  assert.match(r.text, /은사슴 1학년 시간표\n {2}시간표: 월 1교시 별자리학/);
});

test('a manor scene: no school rules, no 시간표; the manor\'s rule after the world\'s; the unknown last', () => {
  const { E, R, by } = world();
  const r = run(E, R, [by('하르트 공작'), by('하르트 저택')]);
  assert.deepEqual(names(E, r.included), ['하르트 저택', '하르트 공작', '금화와 은화', '마법은 지팡이로', '저택에서는 하인이 문을 연다', '어디 것인지 모르는 규칙'].sort((a, b) => names(E, r.included).indexOf(a) - names(E, r.included).indexOf(b)));
  for (const x of ['탑 계단은 오른쪽으로만', '캠퍼스 안 비행 금지', '기숙사 암호는 2주마다', '은사슴 1학년 시간표']) assert.ok(!names(E, r.included).includes(x), x);
  const order = names(E, r.included);
  assert.ok(order.indexOf('마법은 지팡이로') < order.indexOf('저택에서는 하인이 문을 연다'));
  assert.ok(order.indexOf('저택에서는 하인이 문을 연다') < order.indexOf('어디 것인지 모르는 규칙'));
  assert.equal(r.skipped, 10, 'out of the scene: the groups, places, people, rules and 시간표 of the school');
});

test('a small budget fills in that order: the unknown rule is the first to be left out; pinned always first', () => {
  const { E, R, by } = world();
  const full = run(E, R, [by('하르트 공작'), by('하르트 저택')]);
  const small = run(E, R, [by('하르트 공작'), by('하르트 저택')], full.chars - 5);
  assert.ok(small.omitted.map((x) => E.find((e) => e.entityId === x).name).includes('어디 것인지 모르는 규칙'));
  E.find((e) => e.name === '캠퍼스 안 비행 금지').pinned = true;
  const pinned = run(E, R, [by('하르트 저택')]);
  assert.equal(names(E, pinned.included)[0], '캠퍼스 안 비행 금지', 'pinned: in, and first, even out of the scene');
});

test('the budget after the scene: rules of the whole world take at most a third, the rules here the rest; a rule named in the scene comes first in its part', () => {
  const E = [];
  const school = ent('group', '별시계 학원');
  E.push(school);
  for (let i = 0; i < 12; i++) E.push(ent('rule', `세계 규칙 ${String(i).padStart(2, '0')} ${'가'.repeat(40)}`, { appliesTo: 'world', updatedAt: `2026-11-${String(10 + i).padStart(2, '0')}T00:00:00Z` }));
  for (let i = 0; i < 12; i++) E.push(ent('rule', `학원 규칙 ${String(i).padStart(2, '0')} ${'나'.repeat(40)}`, { appliesTo: school.entityId }));
  const old = E.find((e) => e.name.startsWith('세계 규칙 00'));
  const scene = [school.entityId, old.entityId]; // the oldest world rule is named in the latest messages
  const r = I.assembleWorld({ name: '별시계 학원', description: '', injectMode: 'scene' }, E, 1200, { scene: new Set(scene), relations: [] });
  const inc = r.included.map((x) => E.find((e) => e.entityId === x).name);
  const worldIn = inc.filter((n) => n.startsWith('세계'));
  const schoolIn = inc.filter((n) => n.startsWith('학원'));
  assert.ok(worldIn.length >= 1 && worldIn.length < schoolIn.length, `world ${worldIn.length} < school ${schoolIn.length}`);
  assert.equal(worldIn[0], old.name, 'named in the scene: first of the world rules even though it is the oldest');
  assert.ok(worldIn.slice(1).every((n, i, a) => i === 0 || a[i - 1] > n), 'then the latest first');
  // no rules here: the whole space goes to the world rules
  const lone = I.assembleWorld({ name: '별시계 학원', description: '', injectMode: 'scene' }, E.filter((e) => !e.name.startsWith('학원 규칙')), 1200, { scene: new Set(scene), relations: [] });
  assert.ok(lone.included.length - 1 > worldIn.length, 'a part that does not use its share leaves it to the other');
});

test('names as the room reads them: 「Original(한국어)」 when asked (or 자동 in a room in English); the Korean alone without an original', () => {
  const E = [
    ent('person', '세베루스 스네이프', { aliases: ['Severus Snape', '스네이프 교수'] }),
    ent('person', '하윤', { aliases: ['윤이'] }),
  ];
  E[0].fields = { personality: '엄격하다' };
  const w = { name: '별시계 학원', description: '', injectMode: 'all' };
  const ko = I.assembleWorld(w, E, 3000, {}).text;
  assert.match(ko, /- 세베루스 스네이프 \(다른 이름: Severus Snape, 스네이프 교수\)/);
  const en = I.assembleWorld(w, E, 3000, { names: 'original' }).text;
  assert.match(en, /- Severus Snape\(세베루스 스네이프\) \(다른 이름: 스네이프 교수\)/);
  assert.match(en, /- 하윤 \(다른 이름: 윤이\)/, 'no original: the Korean alone');
});
