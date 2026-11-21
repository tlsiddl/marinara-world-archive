'use strict';
// v0.7.1 — a world organized in English gets English from code too; 기억 서재 0.38.3's date fix (eight digits).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const P = require('../world-archive/lib/profile.cjs');
const S = require('../world-archive/lib/vendor/storydate.cjs');
const X = require('../world-archive/lib/extract.cjs');
const { Archive } = require('../world-archive/lib/store.cjs');

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-071-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new Archive(dir);
}

test('프로필 값: in English as written (Male · 107), in Korean as before (남성 · 107살)', () => {
  assert.equal(P.tidyValue('gender', 'male', 'en'), 'Male');
  assert.equal(P.tidyValue('gender', '여성', 'en'), 'Female');
  assert.equal(P.tidyValue('age', '107', 'en'), '107');
  assert.equal(P.tidyValue('age', '107살', 'en'), '107');
  assert.equal(P.tidyValue('gender', 'Male'), '남성');
  assert.equal(P.tidyValue('age', '107'), '107살');
});

test('a person from a profile in English: the name as written, the glossary\'s Korean an other name', (t) => {
  const s = temp(t);
  const w = s.createWorld({ name: 'Liverpool' });
  const profile = { kind: 'npc', name: 'Margaret', fields: { gender: 'Female', age: '34' }, lines: { name: 'Name: Margaret', gender: 'Gender: Female', age: 'Age: 34' } };
  s.applyProfiles(w.worldId, [profile], { pairs: [{ from: 'Margaret', to: '마거릿' }], lang: 'en', by: 'profile' });
  const e = s.listEntities(w.worldId).find((x) => x.type === 'person');
  assert.equal(e.name, 'Margaret');
  assert.ok(e.aliases.includes('마거릿'));
  assert.deepEqual([e.fields.gender, e.fields.age], ['Female', '34']);
});

test('a new 시간표 in English: 「… Timetable」 · Weekly', (t) => {
  const s = temp(t);
  const w = s.createWorld({ name: 'Hogwarts' });
  s.applyAuto(w.worldId, [{ type: 'group', name: 'Slytherin First Years' }]);
  const g = s.listEntities(w.worldId)[0];
  s.applyTimetable(w.worldId, [{ ownerId: g.entityId, day: '월', slot: '1교시', value: 'Potions' }], { lang: 'en' });
  const sheet = s.listEntities(w.worldId).find((x) => x.timetable);
  assert.deepEqual([sheet.name, sheet.fields.when], ['Slytherin First Years Timetable', 'Weekly']);
});

test('recheck in English: 남성 → Male · 107살 → 107 · 매주 → Weekly · a Korean 분류 word; never the person\'s', (t) => {
  const s = temp(t);
  const w = s.createWorld({ name: 'Hogwarts' });
  s.applyAuto(w.worldId, [
    { type: 'person', name: 'Albus', fields: { gender: '남성', age: '107살' } },
    { type: 'person', name: 'Minerva', fields: { gender: '여성' } },
    { type: 'system', name: 'House points', fields: { category: '점수' } },
    { type: 'rule', name: 'Curfew', fields: { category: '금지·예절' } },
    { type: 'rule', name: 'Odd one', fields: { category: '아주 특이한 것' } },
    { type: 'schedule', name: 'Quidditch practice', fields: { when: '매주' } },
  ]);
  const mine = s.listEntities(w.worldId).find((e) => e.name === 'Minerva');
  s.updateEntity(w.worldId, mine.entityId, { revision: mine.revision, fields: { gender: '여자' } });
  const changes = s.englishValues(w.worldId);
  const by = (n) => s.listEntities(w.worldId).find((e) => e.name === n).fields;
  assert.deepEqual([by('Albus').gender, by('Albus').age], ['Male', '107']);
  assert.equal(by('Minerva').gender, '여자', 'the person\'s stays');
  assert.equal(by('House points').category, 'Scoring');
  assert.equal(by('Curfew').category, 'Prohibitions & etiquette');
  assert.equal(by('Odd one').category, '아주 특이한 것', 'code cannot tell: left');
  assert.equal(by('Quidditch practice').when, 'Weekly');
  assert.equal(changes.length, 5);
  s.undoChange(w.worldId, changes.find((c) => c.key === 'age').id);
  assert.equal(by('Albus').age, '107살');
});

test('the English prompt asks 분류 in English words, not the 주제 list', () => {
  const [part] = X.batches([{ id: 'm1', speaker: 'A', role: 'assistant', content: 'Curfew is at ten.' }], 0);
  assert.match(X.buildPrompt({ name: 'w' }, [], part, [], [], null, 'en')[0].content, /category\(분류\)는 짧은 영어 낱말/);
});

test('기억 서재 0.38.3: eight digits under another label are an amount, not a day', () => {
  assert.equal(S.dateInText('[금화|20241018]'), null);
  assert.equal(S.dateInText('[날짜|20241018]')?.date, '2024-10-18');
  assert.equal(S.dateInText('§RP | 1988-09-02 (금) | 11:15 | 대강당§')?.date, '1988-09-02');
});
