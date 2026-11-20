'use strict';
// v0.5.0 K — 학사일정 · the story's today (§RP header) · 학년도. Made-up world only (별시계 학원).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Archive } = require('../world-archive/lib/store.cjs');
const C = require('../world-archive/lib/calendar.cjs');
const X = require('../world-archive/lib/extract.cjs');
const I = require('../world-archive/lib/inject.cjs');
const service = require('../world-archive/lib/service.cjs');

const msg = (i, content, speaker = i % 2 ? '서하' : '나') => ({ id: `m${i}`, speaker, role: i % 2 ? 'assistant' : 'user', content });
function world(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-cal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new Archive(dir);
  service._test.useStore(s);
  const w = s.createWorld({ name: '별시계 학원' });
  s.applyAuto(w.worldId, [{ type: 'group', name: '별시계 학원' }, { type: 'group', name: '은사슴 1학년' }, { type: 'place', name: '대식당' }, { type: 'person', name: '하윤', fields: { affiliation: '은사슴 1학년' } }]);
  s.linkAffiliations(w.worldId);
  const id = (n) => s.listEntities(w.worldId).find((e) => e.name === n)?.entityId;
  const cal = (n) => s.listEntities(w.worldId).find((e) => e.calendar && (e.calendar.ownerId ?? null) === (n ? id(n) : null));
  return { s, w, id, cal };
}

test('dates, school years and the story\'s today', () => {
  assert.equal(C.normDate('1891년 10월 31일'), '1891-10-31');
  assert.equal(C.normDate('10월 31일'), '--10-31', 'no year: kept without one');
  assert.equal(C.normDate('10월 31일', 1891), '1891-10-31');
  assert.equal(C.normDate('91.10.31', 1891), '1891-10-31', 'two digits: the story\'s century');
  assert.equal(C.normDate('다음 주'), null);
  assert.deepEqual([C.schoolYear('1891-10-31'), C.schoolYear('1892-03-01'), C.schoolYear('1891-08-31')], ['1891–92', '1891–92', '1890–91']);
  assert.equal(C.schoolYear('1892-03-01', 3), '1892–93');
  assert.deepEqual(C.storyToday([msg(0, '§RP | 1891-10-26 (토) | 09:00 | 대식당 | 맑음§\n하윤이 왔다.'), msg(1, '평범한 문장.')]), { date: '1891-10-26', weekday: '토', written: true });
  assert.equal(C.storyToday([msg(0, '날짜 없는 이야기.')]), null);
  assert.equal(C.storyToday([msg(0, '§RP | 2024-10-18 | 11:15 | 서재§')]).weekday, '금', 'no weekday written: from the calendar');
});

test('events: one sheet per owner; a new date keeps 「이전」; cancelled is marked, not deleted; the person\'s only offered; undo', (t) => {
  const { s, w, id, cal } = world(t);
  s.applyCalendar(w.worldId, [
    { ownerId: id('별시계 학원'), name: '핼러윈 연회', date: '1891-10-31', place: '대식당', evidence: '10월 31일에 연회가 열린다.' },
    { ownerId: null, name: '왕의 생일', date: '1891-11-12' },
    { ownerId: id('하윤'), name: '사람은 주인이 아님', date: '1891-11-01' },
    { ownerId: id('별시계 학원'), name: '날짜 없음' },
  ]);
  assert.equal(cal('별시계 학원').name, '별시계 학원 학사일정');
  assert.equal(cal(null).name, '세계 학사일정');
  assert.equal(Object.keys(cal('별시계 학원').calendar.events).length, 1);
  s.applyCalendar(w.worldId, [{ ownerId: id('별시계 학원'), name: '핼러윈 연회', date: '1891-11-02', evidence: '연회가 11월 2일로 미뤄졌다.' }]);
  let [ev] = Object.values(cal('별시계 학원').calendar.events);
  assert.deepEqual([ev.date, ev.past[0].date, ev.place], ['1891-11-02', '1891-10-31', '대식당']);
  s.applyCalendar(w.worldId, [{ ownerId: id('별시계 학원'), name: '핼러윈 연회', date: '1891-11-02', cancelled: true }]);
  [ev] = Object.values(cal('별시계 학원').calendar.events);
  assert.equal(ev.cancelled, true);
  const last = s.listHistory(w.worldId).find((c) => c.action === 'event');
  s.undoChange(w.worldId, last.id);
  [ev] = Object.values(cal('별시계 학원').calendar.events);
  assert.equal(ev.cancelled, undefined, 'undo');
  // next year the same name is another event
  s.applyCalendar(w.worldId, [{ ownerId: id('별시계 학원'), name: '핼러윈 연회', date: '1892-10-31' }]);
  assert.equal(Object.keys(cal('별시계 학원').calendar.events).length, 2);
  // v0.6.0: the same day in other school years is another event too (입학식 every 9월 1일), not a date moved
  s.applyCalendar(w.worldId, [{ ownerId: id('별시계 학원'), name: '입학식', date: '1890-09-01' }, { ownerId: id('별시계 학원'), name: '입학식', date: '1891-09-01' }, { ownerId: id('별시계 학원'), name: '입학식', date: '1892-09-01' }]);
  const entry = () => Object.values(cal('별시계 학원').calendar.events).filter((x) => x.name === '입학식');
  assert.deepEqual(entry().map((x) => [x.date, x.past]).sort(), [['1890-09-01', undefined], ['1891-09-01', undefined], ['1892-09-01', undefined]]);
  // a day without a year still finds the dated one (and the dated one the day without a year)
  s.applyCalendar(w.worldId, [{ ownerId: id('별시계 학원'), name: '은사슴 축제', date: '--05-01' }]);
  s.applyCalendar(w.worldId, [{ ownerId: id('별시계 학원'), name: '은사슴 축제', date: '1892-05-01' }]);
  assert.equal(Object.values(cal('별시계 학원').calendar.events).filter((x) => x.name === '은사슴 축제').length, 1);
  // the person's event: the story only offers
  s.setEvent(w.worldId, { ownerId: id('은사슴 1학년'), name: '1학년 첫 시험', date: '1891-12-01' });
  s.applyCalendar(w.worldId, [{ ownerId: id('은사슴 1학년'), name: '1학년 첫 시험', date: '1891-12-08' }]);
  let mine = Object.values(cal('은사슴 1학년').calendar.events)[0];
  assert.deepEqual([mine.date, mine.pending.date], ['1891-12-01', '1891-12-08']);
  s.applyEventPending(w.worldId, cal('은사슴 1학년').entityId, mine.id);
  mine = Object.values(cal('은사슴 1학년').calendar.events)[0];
  assert.deepEqual([mine.date, mine.past[0].date, mine.pending], ['1891-12-08', '1891-12-01', undefined]);
  s.setEvent(w.worldId, { entityId: cal('은사슴 1학년').entityId, eventId: mine.id, name: '' });
  assert.deepEqual(cal('은사슴 1학년').calendar.events, {});
});

test('the reader: a date the sentence says; 「다음 주」 kept as words without today; a date without a year takes today\'s', () => {
  const [part] = X.batches([msg(1, '핼러윈 연회는 10월 31일이다. 다음 주에는 첫 경기가 있다. 시험은 곧 있다.')], 0);
  const parsed = { calendar: [
    { owner: '별시계 학원', name: '핼러윈 연회', date: '10-31', evidence: [{ n: '1.1', q: '10월 31일' }] },
    { owner: '', name: '첫 경기', when: '다음 주', evidence: [{ n: '1.2', q: '다음 주에는' }] },
    { owner: '', name: '시험', date: '1891-11-20', evidence: [{ n: '1.3', q: '시험은 곧' }] },
    { owner: '서하', name: '카드 인물', date: '1891-11-01', evidence: [{ n: '1.1' }] },
  ] };
  const r = X.checkCalendar(parsed, part, ['서하', '나'], { date: '1891-10-26' });
  assert.deepEqual(r.events.map((e) => [e.name, e.date || e.when]), [['핼러윈 연회', '1891-10-31'], ['첫 경기', '다음 주']]);
  assert.deepEqual(r.dropped.map((d) => d.why), ['evidence does not say the date', 'card']);
  const prompt = X.buildPrompt({ name: 'x' }, [], part, [], [], { date: '1891-10-26', weekday: '월' });
  assert.match(prompt[1].content, /\[이야기 속 오늘\] 1891-10-26 \(월\)/);
  assert.match(prompt[0].content, /calendar에 적는다/);
});

test('{{세계}}: the next three events, 「며칠 뒤」 from the story\'s today; the world\'s with the world\'s rules; a 학사일정 with nothing ahead is not put in', (t) => {
  const { s, w, id } = world(t);
  s.applyCalendar(w.worldId, [
    { ownerId: id('은사슴 1학년'), name: '지난 일', date: '1891-09-01' },
    { ownerId: id('은사슴 1학년'), name: '첫 시험', date: '1891-11-02' },
    { ownerId: id('은사슴 1학년'), name: '취소된 무도회', date: '1891-10-28', cancelled: true },
    { ownerId: null, name: '왕의 생일', date: '1891-11-12' },
  ]);
  const ents = s.listEntities(w.worldId);
  const R = s.listRelations(w.worldId);
  const scene = I.assembleWorld({ ...s.getWorld(w.worldId), injectMode: 'scene' }, ents, 3000, { scene: new Set([id('하윤')]), relations: R, today: '1891-10-26' }).text;
  assert.match(scene, /은사슴 1학년 학사일정\n {2}다가오는 일: 11\/2 첫 시험 \(7일 뒤\)/);
  assert.match(scene, /왕의 생일 \(17일 뒤\)/);
  assert.doesNotMatch(scene, /무도회|지난 일/);
  const noToday = I.assembleWorld({ ...s.getWorld(w.worldId), injectMode: 'all' }, ents, 3000, {}).text;
  assert.match(noToday, /다가오는 일: 9\/1 지난 일 · 11\/2 첫 시험/, 'without today: the first by date, no 「며칠 뒤」');
  const far = I.assembleWorld({ ...s.getWorld(w.worldId), injectMode: 'all' }, ents, 3000, { today: '1899-01-01' }).text;
  assert.doesNotMatch(far, /학사일정/, 'nothing ahead: left out');
});

test('a 시간표 follows the school year: the first year takes the sheet; a new year a new sheet, last year\'s stays', (t) => {
  const { s, w, id } = world(t);
  s.applyTimetable(w.worldId, [{ ownerId: id('은사슴 1학년'), day: '월', slot: '1교시', value: '별자리학' }]);
  s.applyTimetable(w.worldId, [{ ownerId: id('은사슴 1학년'), day: '월', slot: '2교시', value: '약초학' }], { year: '1891–92' });
  let sheets = s.listEntities(w.worldId).filter((e) => e.timetable);
  assert.deepEqual(sheets.map((e) => [e.name, e.timetable.year, Object.keys(e.timetable.cells).length]), [['은사슴 1학년 시간표', '1891–92', 2]]);
  s.applyTimetable(w.worldId, [{ ownerId: id('은사슴 1학년'), day: '월', slot: '1교시', value: '고대 룬' }], { year: '1892–93' });
  sheets = s.listEntities(w.worldId).filter((e) => e.timetable);
  assert.deepEqual(sheets.map((e) => [e.name, e.timetable.year]), [['은사슴 1학년 시간표', '1891–92'], ['은사슴 1학년 시간표 (1892–93)', '1892–93']]);
  assert.equal(sheets[0].timetable.cells['월|1교시'].value, '별자리학', 'last year\'s stays');
  const updated = s.updateWorld(w.worldId, { revision: s.getWorld(w.worldId).revision, yearStart: 3, nameStyle: 'original' });
  assert.deepEqual([updated.yearStart, updated.nameStyle], [3, 'original']);
  assert.throws(() => s.updateWorld(w.worldId, { revision: updated.revision, yearStart: 13 }), (e) => e.status === 400);
});

test('「학사일정으로 모으기」: a dated schedule becomes an event of its owner\'s 학사일정 (by code); a weekly one stays for 시간표', async (t) => {
  const { s, w, id, cal } = world(t);
  s.applyAuto(w.worldId, [
    { type: 'schedule', name: '입학식', fields: { when: '1891년 9월 1일', where: '대식당', who: '별시계 학원 신입생' } },
    { type: 'schedule', name: '수요일 관측', fields: { when: '수요일 밤', who: '은사슴 1학년' } },
  ]);
  const r = await service.gatherCalendar(w.worldId);
  assert.deepEqual(r.moved.map((m) => m.event), ['별시계 학원 1891-09-01 입학식']);
  const [ev] = Object.values(cal('별시계 학원').calendar.events);
  assert.deepEqual([ev.name, ev.date, ev.placeId], ['입학식', '1891-09-01', id('대식당')]);
  assert.ok(s.listEntities(w.worldId).some((e) => e.name === '수요일 관측'));
  assert.ok(!s.listEntities(w.worldId).some((e) => e.name === '입학식' && !e.calendar));
});
