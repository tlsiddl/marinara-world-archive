'use strict';
// v0.5.1 J — 전체 인원: a group's whole head count (a field the code reads), shown as 「이름 아는 사람 M명 / 전체 N명」 in the
// 명단 and in {{세계}}. Made-up world only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Archive } = require('../world-archive/lib/store.cjs');
const R = require('../world-archive/lib/roster.cjs');
const X = require('../world-archive/lib/extract.cjs');
const I = require('../world-archive/lib/inject.cjs');

const msg = (i, content, speaker = i % 2 ? '서하' : '나') => ({ id: `m${i}`, speaker, role: i % 2 ? 'assistant' : 'user', content });

test('headcount reads a number of people: digits, Korean words, parts added up, a total said', () => {
  assert.equal(R.headcount('40명'), 40);
  assert.equal(R.headcount('아홉 명'), 9);
  assert.equal(R.headcount('열두 명'), 12);
  assert.equal(R.headcount('스물다섯 명'), 25);
  assert.equal(R.headcount('남학생 다섯 명, 여학생 네 명'), 9, 'parts added up');
  assert.equal(R.headcount('총 30명 중 여학생 12명'), 30, 'the total said');
  assert.equal(R.headcount('두 사람'), 2);
  assert.equal(R.headcount('수십 명'), null);
  assert.equal(R.headcount('유명한 집단'), null, '「유명」 is not a count');
  assert.equal(R.headcount(''), null);
});

test('the reader: 전체 인원 must be in its sentence (a count there, or the counts added up); kept as 「N명」', () => {
  const [part] = X.batches([msg(1, '은사슴 1학년은 남학생 다섯 명과 여학생 네 명이다. 별빛 합창단은 아주 크다.')], 0);
  const parsed = { items: [
    { type: 'group', name: '은사슴 1학년', fields: { size: { v: '아홉 명', n: ['1.1'] } }, evidence: [{ n: '1.1', q: '은사슴 1학년은' }] },
    { type: 'group', name: '별빛 합창단', fields: { size: { v: '50명', n: ['1.2'] } }, evidence: [{ n: '1.2', q: '별빛 합창단은' }] },
  ] };
  const r = X.checkItems(parsed, part, ['서하', '나']);
  assert.equal(r.items.find((i) => i.name === '은사슴 1학년').fields.size, '9명', 'five and four added up');
  assert.deepEqual(r.items.find((i) => i.name === '별빛 합창단').fields, {}, 'a number the sentence does not say');
  assert.ok(r.droppedFields.some((d) => d.name === '별빛 합창단' && d.key === 'size'));
  assert.match(X.buildPrompt({ name: 'x' }, [], part, [])[0].content, /size\(전체 인원\)/);
});

test('명단 and {{세계}}: 「이름 아는 사람 M명 / 전체 N명」 — the named people now, not 지난 구성원 or 「○○의 누나」', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-hc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new Archive(dir);
  const w = s.createWorld({ name: '별시계 학원' });
  s.applyAuto(w.worldId, [
    { type: 'group', name: '은사슴 1학년', fields: { size: '9명', kind: '학년' } },
    { type: 'person', name: '하윤', fields: { affiliation: '은사슴 1학년' } },
    { type: 'person', name: '서윤', fields: { affiliation: '은사슴 1학년' } },
    { type: 'person', name: '하윤의 누나', fields: { affiliation: '은사슴 1학년' } },
    { type: 'person', name: '노을', fields: { affiliation: '은사슴 1학년 출신' } },
  ]);
  s.linkAffiliations(w.worldId);
  const g = s.listEntities(w.worldId).find((e) => e.name === '은사슴 1학년');
  const r = s.roster(w.worldId, g.entityId);
  assert.deepEqual([r.counts.known, r.counts.total], [2, 9]);
  const text = I.assembleWorld(s.getWorld(w.worldId), s.listEntities(w.worldId), 3000, { relations: s.readEntities(w.worldId).relations }).text;
  assert.match(text, /- 은사슴 1학년\n {2}종류: 학년 \/ 인원: 이름 아는 사람 2명 \/ 전체 9명/);
  // no 전체 인원: nothing extra
  s.applyAuto(w.worldId, [{ type: 'group', name: '별빛 합창단' }]);
  const t2 = I.assembleWorld(s.getWorld(w.worldId), s.listEntities(w.worldId), 3000, {}).text;
  assert.doesNotMatch(t2, /별빛 합창단\n {2}인원/);
});
