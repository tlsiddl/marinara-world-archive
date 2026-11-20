'use strict';
// v0.5.0 F — 「같은 것일 수 있음」 for places, groups, rules …: offered, never merged by code; an English other name left
// on a rule goes to the group its glossary pair names. Made-up world only (별시계 학원).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Archive } = require('../world-archive/lib/store.cjs');

function world(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-st-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new Archive(dir);
  const w = s.createWorld({ name: '별시계 학원' });
  s.applyAuto(w.worldId, [
    { type: 'group', name: '은사슴 기숙사', aliases: ['은사슴'] },
    { type: 'place', name: '은사슴 휴게실' },
    { type: 'place', name: '은사슴 기숙사 휴게실' },
    { type: 'place', name: '은사슴 1학년 여학생 침실' },
    { type: 'place', name: '은사슴 1학년 여자 기숙사' },
    { type: 'place', name: '별시계 지하' },
    { type: 'place', name: '별시계 지하 선착장' },
    { type: 'system', name: '별시계 특급 열차' },
    { type: 'system', name: '별시계 급행 열차' },
    { type: 'rule', name: '기숙사 암호' },
    { type: 'rule', name: '은사슴 기숙사 암호' },
    { type: 'rule', name: '별시계는 세 기숙사로 나뉜다', aliases: ['Silver Stag', 'Blue Plum'] },
  ]);
  const id = (n) => s.listEntities(w.worldId).find((e) => e.name === n)?.entityId;
  const pairs = () => s.listDuplicates(w.worldId).filter((p) => p.type !== 'person').map((p) => [s.listEntities(w.worldId).find((e) => e.entityId === p.a).name, s.listEntities(w.worldId).find((e) => e.entityId === p.b).name].sort().join(' ~ '));
  return { s, w, id, pairs };
}

test('two names for one place or system are offered; a place inside another, or a word that says something new, is not', (t) => {
  const { s, w, id, pairs } = world(t);
  const got = pairs();
  assert.ok(got.includes(['은사슴 기숙사 휴게실', '은사슴 휴게실'].sort().join(' ~ ')), '기숙사: a common word');
  assert.ok(got.includes(['은사슴 1학년 여자 기숙사', '은사슴 1학년 여학생 침실'].sort().join(' ~ ')), '여자 · 여학생, 침실 · 기숙사 read alike');
  assert.ok(got.includes(['별시계 급행 열차', '별시계 특급 열차'].sort().join(' ~ ')), '특급 · 급행');
  assert.ok(got.includes(['기숙사 암호', '은사슴 기숙사 암호'].sort().join(' ~ ')), '은사슴: a name the world has');
  assert.ok(!got.some((p) => p.includes('선착장')), '선착장 says something new');
  // a place in the other (위치) is never the same; rules said to hold in different places are not either
  s.createRelation(w.worldId, { from: id('은사슴 휴게실'), to: id('은사슴 기숙사 휴게실'), type: '위치' });
  assert.ok(!pairs().includes(['은사슴 기숙사 휴게실', '은사슴 휴게실'].sort().join(' ~ ')));
  s.setAppliesTo(w.worldId, id('기숙사 암호'), id('은사슴 기숙사'), {}, { force: true });
  s.applyAuto(w.worldId, [{ type: 'place', name: '청매 기숙사' }]);
  s.setAppliesTo(w.worldId, id('은사슴 기숙사 암호'), id('청매 기숙사'), {}, { force: true });
  assert.ok(!pairs().some((p) => p.includes('암호')), 'different 적용되는 곳');
  // 「다른 것이에요」 like people
  const [p] = s.listDuplicates(w.worldId).filter((x) => x.type === 'system');
  s.dismissPair(w.worldId, p.a, p.b);
  assert.ok(!pairs().some((x) => x.includes('열차')));
  assert.equal(s.listEntities(w.worldId).length, 13, 'nothing merged by code');
});

test('an English other name left on a rule goes to the group its glossary pair names; undo brings it back', (t) => {
  const { s, w, id } = world(t);
  const changes = s.alignGlossary(w.worldId, [{ from: 'Silver Stag', to: '은사슴' }, { from: 'Blue Plum', to: '청매' }]);
  const mv = changes.filter((c) => c.action === 'alias-move');
  assert.deepEqual(mv.map((c) => [c.alias, c.to]), [['Silver Stag', '은사슴 기숙사']], 'Blue Plum: no such group — stays');
  const by = (n) => s.listEntities(w.worldId).find((e) => e.name === n);
  assert.deepEqual(by('별시계는 세 기숙사로 나뉜다').aliases, ['Blue Plum']);
  assert.ok(by('은사슴 기숙사').aliases.includes('Silver Stag'));
  s.undoChange(w.worldId, mv[0].id);
  assert.ok(by('별시계는 세 기숙사로 나뉜다').aliases.includes('Silver Stag'));
  assert.ok(!by('은사슴 기숙사').aliases.includes('Silver Stag'));
  void id;
});

test('a word stuck to the next is cut by the same-word list: 「특급 열차」 ~ 「급행열차」, but not 「급행열차 노선」', () => {
  const { thingPairs } = require('../world-archive/lib/same.cjs');
  const E = [
    { entityId: 'a', type: 'system', name: '별시계 특급 열차', aliases: [] },
    { entityId: 'b', type: 'system', name: '별시계 급행열차', aliases: [] },
    { entityId: 'c', type: 'system', name: '별시계 급행열차 노선', aliases: [] },
  ];
  assert.deepEqual(thingPairs(E).map((p) => [p.a, p.b].sort().join('')), ['ab']);
});
