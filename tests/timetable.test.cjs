'use strict';
// v0.5.0 B — 시간표: one sheet per owner (a group or a person), weekday × time cells; filled by the reader (evidence
// sentence per cell), by hand, or by 「시간표로 모으기」; 「이전」 kept, the person's cells never written over; in {{세계}}
// only the sheets of the scene. Made-up world only (별시계 학원), no RP content.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Archive } = require('../world-archive/lib/store.cjs');
const TT = require('../world-archive/lib/timetable.cjs');
const X = require('../world-archive/lib/extract.cjs');
const I = require('../world-archive/lib/inject.cjs');
const service = require('../world-archive/lib/service.cjs');
const real = require('../world-archive/lib/vendor/engine.cjs');

const msg = (i, content, speaker = i % 2 ? '서하' : '나') => ({ id: `m${i}`, speaker, role: i % 2 ? 'assistant' : 'user', content });
function world(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-tt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new Archive(dir);
  const w = s.createWorld({ name: '별시계 학원' });
  s.applyAuto(w.worldId, [
    { type: 'group', name: '은사슴 1학년' },
    { type: 'person', name: '하윤', fields: { affiliation: '은사슴 1학년' } },
    { type: 'person', name: '노을 교수' },
    { type: 'place', name: '별시계탑' },
  ]);
  s.linkAffiliations(w.worldId);
  const id = (n) => s.listEntities(w.worldId).find((e) => e.name === n)?.entityId;
  const sheet = (n) => s.listEntities(w.worldId).find((e) => e.timetable?.ownerId === id(n));
  return { s, w, id, sheet };
}

test('days and slots: 「월요일」 · 「Mon」 → 월; slots tidied; cells in weekday and clock order; 「언제」 text read by code', () => {
  assert.deepEqual(['월요일', 'Mon', 'friday', '평일', '매일', '9월 1일'].map(TT.normDay), ['월', '월', '금', '평일', '매일', null]);
  assert.equal(TT.normSlot(' 09:00 ~ 10:30 '), '09:00–10:30');
  assert.equal(TT.normSlot(''), null);
  const cells = { a: { day: '화', slot: '오전', value: 'x' }, b: { day: '월', slot: '2교시', value: 'y' }, c: { day: '월', slot: '1교시', value: 'z' }, d: { day: '월', slot: '13:30–15:00', value: 'w' } };
  assert.deepEqual(TT.sortCells(cells).map((c) => c.day + c.slot), ['월1교시', '월2교시', '월13:30–15:00', '화오전']);
  assert.deepEqual(TT.parseWhen('금요일 아침').map((c) => [c.day, c.slot]), [['금', '아침']]);
  assert.deepEqual(TT.parseWhen('월요일 09:00–12:00 별자리학, 수요일 23:00–00:30 천문 관측').map((c) => [c.day, c.slot, c.after]), [['월', '09:00–12:00', '별자리학'], ['수', '23:00–00:30', '천문 관측']]);
  assert.deepEqual(TT.parseWhen('9월 1일 개학'), [], 'a date is not a weekly cell');
  assert.deepEqual(TT.parseWhen('수요일 09:00–15:00 및 23:00–00:30 천문 관측').map((c) => [c.slot, c.after]), [['09:00–15:00', ''], ['23:00–00:30', '천문 관측']], 'two times in a day: two cells');
  assert.deepEqual(TT.parseWhen('금요일 아침 9시').map((c) => c.slot), ['아침 9시'], 'a word and a clock time together: one slot');
  assert.deepEqual(TT.parseWhen('금요일, 1시 30분까지').map((c) => [c.slot, c.after]), [['1시 30분까지', '']], '「까지」 is part of the time, not what happens');
  assert.deepEqual(TT.parseWhen('목요일'), [], 'a day without a time is not a cell');
});

test('the reader\'s cells: one sheet for the owner, 「이전」 on a new value, a cell the person wrote only offered; undo', (t) => {
  const { s, w, id, sheet } = world(t);
  const c1 = s.applyTimetable(w.worldId, [
    { ownerId: id('은사슴 1학년'), day: '월', slot: '1교시', value: '별자리학 — 노을 교수', evidence: '월요일 1교시는 별자리학이다.' },
    { ownerId: id('은사슴 1학년'), day: '월요일', slot: '2교시', value: '약초학', evidence: '2교시는 약초학.' },
    { ownerId: id('별시계탑'), day: '월', slot: '3교시', value: '장소는 주인이 아님' },
  ]);
  assert.deepEqual(c1.map((c) => c.action), ['create', 'cell', 'cell']);
  const sh = sheet('은사슴 1학년');
  assert.equal(sh.name, '은사슴 1학년 시간표');
  assert.deepEqual(Object.keys(sh.timetable.cells).sort(), ['월|1교시', '월|2교시']);
  assert.equal(TT.timetableLine(sh), '월 1교시 별자리학 — 노을 교수 · 월 2교시 약초학');
  // a new value for a cell: the old one is 「이전」
  s.applyTimetable(w.worldId, [{ ownerId: id('은사슴 1학년'), day: '월', slot: '2교시', value: '비행술', evidence: '2교시가 비행술로 바뀌었다.' }]);
  const cell = sheet('은사슴 1학년').timetable.cells['월|2교시'];
  assert.equal(cell.value, '비행술');
  assert.deepEqual(cell.past.map((p) => p.value), ['약초학']);
  assert.deepEqual(s.applyTimetable(w.worldId, [{ ownerId: id('은사슴 1학년'), day: '월', slot: '2교시', value: '비행술' }]), [], 'the same value: nothing');
  // undo puts the earlier value back
  const ch = s.listHistory(w.worldId).find((c) => c.action === 'cell' && c.after === '비행술');
  s.undoChange(w.worldId, ch.id);
  assert.equal(sheet('은사슴 1학년').timetable.cells['월|2교시'].value, '약초학');
  // the person writes a cell: the story's value only waits
  s.setCell(w.worldId, { entityId: sheet('은사슴 1학년').entityId, day: '월', slot: '1교시', value: '별자리학(합반)' });
  s.applyTimetable(w.worldId, [{ ownerId: id('은사슴 1학년'), day: '월', slot: '1교시', value: '휴강', evidence: '월요일 1교시는 휴강이다.' }]);
  let c = sheet('은사슴 1학년').timetable.cells['월|1교시'];
  assert.deepEqual([c.value, c.source, c.pending?.value], ['별자리학(합반)', 'manual', '휴강']);
  s.applyCellPending(w.worldId, sheet('은사슴 1학년').entityId, '월|1교시', { discard: true });
  c = sheet('은사슴 1학년').timetable.cells['월|1교시'];
  assert.deepEqual([c.value, c.pending], ['별자리학(합반)', undefined], '[무시]');
  s.applyTimetable(w.worldId, [{ ownerId: id('은사슴 1학년'), day: '월', slot: '1교시', value: '휴강' }]);
  s.applyCellPending(w.worldId, sheet('은사슴 1학년').entityId, '월|1교시');
  c = sheet('은사슴 1학년').timetable.cells['월|1교시'];
  assert.deepEqual([c.value, c.past[0].value], ['휴강', '별자리학(합반)'], '[적용]: the person\'s value is 「이전」');
});

test('cells by hand: a sheet for someone made by its first cell; empty value takes a cell away; errors in Korean', (t) => {
  const { s, w, id, sheet } = world(t);
  const r = s.setCell(w.worldId, { ownerId: id('하윤'), day: '화', slot: '저녁', value: '천문 동아리' });
  assert.equal(r.entity.name, '하윤 시간표');
  assert.equal(sheet('하윤').provenance.source, 'manual');
  s.setCell(w.worldId, { entityId: r.entity.entityId, day: '화', slot: '저녁', value: '' });
  assert.deepEqual(sheet('하윤').timetable.cells, {});
  assert.throws(() => s.setCell(w.worldId, { ownerId: id('하윤'), day: '어제', slot: '저녁', value: 'x' }), (e) => e.status === 400);
  assert.throws(() => s.setCell(w.worldId, { ownerId: id('별시계탑'), day: '화', slot: '저녁', value: 'x' }), (e) => e.status === 404);
  assert.throws(() => s.setCell(w.worldId, { entityId: r.entity.entityId, day: '화', slot: '저녁', value: 'x', revision: 1 }), (e) => e.status === 409);
  // a world with a sheet goes out and comes back
  s.setCell(w.worldId, { ownerId: id('하윤'), day: '수', slot: '1교시', value: '고대 룬' });
  const back = s.importWorld(s.exportWorld(w.worldId));
  const copied = s.listEntities(back.worldId || back.world?.worldId).find((e) => e.timetable);
  assert.equal(TT.timetableLine(copied), '수 1교시 고대 룬');
});

test('checkTimetable: a weekday, a slot, a value and an evidence sentence; a card person is not an owner', () => {
  const [part] = X.batches([msg(1, '은사슴 1학년은 월요일 1교시에 별자리학을 듣는다. 서하는 화요일 저녁에 검술을 배운다.')], 0);
  const parsed = { timetable: [
    { owner: '은사슴 1학년', day: '월요일', slot: '1교시', value: '별자리학', evidence: [{ n: '1.1', q: '월요일 1교시에 별자리학' }] },
    { owner: '서하', day: '화', slot: '저녁', value: '검술', evidence: [{ n: '1.2', q: '화요일 저녁에 검술' }] },
    { owner: '은사슴 1학년', day: '수', slot: '2교시', value: '지어냄', evidence: [{ n: '1.1', q: '없는 구절입니다' }] },
    { owner: '은사슴 1학년', day: '언젠가', slot: '1교시', value: '약초학', evidence: [{ n: '1.1' }] },
  ] };
  const r = X.checkTimetable(parsed, part, ['서하', '나']);
  assert.deepEqual(r.cells.map((c) => [c.owner, c.day, c.slot, c.value]), [['은사슴 1학년', '월', '1교시', '별자리학']]);
  assert.match(r.cells[0].evidence, /월요일 1교시에 별자리학/);
  assert.deepEqual(r.dropped.map((d) => d.why), ['card', 'evidence does not say it', 'day, slot or value'], 'a sentence number alone is not enough');
  assert.equal(X.readReply('{"items":[],"timetable":[{"owner":"a"}]}', real.parseJsonObject).timetable.length, 1);
  const prompt = X.buildPrompt({ name: 'x' }, [], part, [], null, null)[0].content;
  assert.match(prompt, /timetable에 칸 하나씩 적는다/);
});

test('{{세계}} scene mode: a sheet goes in when its owner is in the scene, or a group someone in the scene belongs to', (t) => {
  const { s, w, id } = world(t);
  s.applyTimetable(w.worldId, [{ ownerId: id('은사슴 1학년'), day: '금', slot: '아침', value: '천문 관측' }]);
  const world2 = { ...s.getWorld(w.worldId), injectMode: 'scene' };
  const ents = s.listEntities(w.worldId);
  const rels = s.listRelations(w.worldId);
  const text = (scene) => I.assembleWorld(world2, ents, 3000, { scene: new Set(scene), relations: rels }).text;
  assert.match(text([id('은사슴 1학년')]), /은사슴 1학년 시간표\n {2}시간표: 금 아침 천문 관측/);
  assert.match(text([id('하윤')]), /금 아침 천문 관측/, '하윤 belongs to 은사슴 1학년');
  assert.doesNotMatch(text([id('노을 교수')]), /시간표/, 'not in the scene');
  assert.match(I.assembleWorld({ ...world2, injectMode: 'all' }, ents, 3000, {}).text, /금 아침 천문 관측/, '모두 넣기: all of them');
});

test('「시간표로 모으기」: weekly lessons move into their owner\'s sheet by code (the setting goes to 기록, undoable); dates and the person\'s stay', async (t) => {
  const { s, w, id, sheet } = world(t);
  service._test.useStore(s);
  s.applyAuto(w.worldId, [
    { type: 'schedule', name: '금요일 아침 별자리학 수업', fields: { when: '금요일 아침', who: '노을 교수가 가르치는 은사슴 1학년' } },
    { type: 'schedule', name: '개학식', fields: { when: '9월 1일', who: '전교생' } },
    { type: 'schedule', name: '수요일 밤 관측', fields: { when: '수요일 밤', who: '누군지 모름' } },
  ]);
  s.createEntity(w.worldId, { type: 'schedule', name: '하윤의 검술 연습', fields: { when: '목요일 저녁', who: '하윤' } });
  const r = await service.gatherTimetables(w.worldId, { model: false });
  assert.deepEqual(r.moved.map((m) => [m.name, m.cells, !!m.kept]), [
    ['금요일 아침 별자리학 수업', ['은사슴 1학년 금 아침 별자리학 수업'], false],
    ['하윤의 검술 연습', ['하윤 목 저녁 하윤의 검술 연습'], true],
  ]);
  assert.deepEqual(r.left, ['수요일 밤 관측'], 'no owner known: left (the model would be asked once)');
  const names = s.listEntities(w.worldId).filter((e) => e.type === 'schedule' && !e.timetable).map((e) => e.name).sort();
  assert.deepEqual(names, ['개학식', '수요일 밤 관측', '하윤의 검술 연습'].sort(), 'moved auto one gone; date and the person\'s stay');
  assert.equal(sheet('은사슴 1학년').timetable.cells['금|아침'].value, '별자리학 수업');
  const del = s.listHistory(w.worldId).find((c) => c.action === 'delete' && c.name === '금요일 아침 별자리학 수업');
  assert.ok(del, 'in 기록');
  assert.equal(r.calls, 0);
});

test('cells that cross in time are shown as 「시간이 겹쳐요」 (never merged by code); a wide cell holding a narrow one is background, after it in {{세계}}', (t) => {
  const { s, w, id, sheet } = world(t);
  s.applyTimetable(w.worldId, [
    { ownerId: id('은사슴 1학년'), day: '금', slot: '아침', value: '별자리학 · 약초학' },
    { ownerId: id('은사슴 1학년'), day: '금', slot: '09:00–12:00', value: '두 시간 약초학' },
    { ownerId: id('은사슴 1학년'), day: '월', slot: '09:00–15:00', value: '수업' },
    { ownerId: id('은사슴 1학년'), day: '월', slot: '13:30–15:00', value: '비행술' },
    { ownerId: id('은사슴 1학년'), day: '수', slot: '23:00–00:30', value: '천문 관측' },
  ]);
  let tt = sheet('은사슴 1학년').timetable;
  assert.deepEqual(tt.overlaps, [['금|아침', '금|09:00–12:00']]);
  assert.deepEqual(tt.wide, ['월|09:00–15:00']);
  assert.equal(Object.keys(tt.cells).length, 5, 'nothing merged or taken away');
  assert.equal(TT.timetableLine(sheet('은사슴 1학년')), '월 13:30–15:00 비행술 · 수 23:00–00:30 천문 관측 · 금 아침 별자리학 · 약초학 · 금 09:00–12:00 두 시간 약초학 · 월 09:00–15:00 수업', 'the wide cell last');
  // the person takes one of the two away: the overlap goes
  s.setCell(w.worldId, { entityId: sheet('은사슴 1학년').entityId, day: '금', slot: '아침', value: '' });
  tt = sheet('은사슴 1학년').timetable;
  assert.deepEqual(tt.overlaps, []);
  assert.deepEqual(TT.span('1시 30분까지'), [750, 810], '1–6시 read as afternoon; 「까지」 is up to then');
  assert.equal(TT.span('1교시'), null, 'a 교시 has no clock time: never said to cross');
});

test('「시간표로 모으기」 asks the model once, small, for what code could not place — with the sheets there are; its owner must be a group or person', async (t) => {
  const { s, w, id, sheet } = world(t);
  service._test.useStore(s);
  const asked = [];
  service._test.useEngine({
    model: async (cid) => ({ id: cid }),
    askModel: async (m, messages) => { asked.push(messages[1].content); return { content: JSON.stringify({ cells: [
      { from: '비행 수업', owner: '은사슴 1학년', day: '목', slot: '오후', value: '비행술' },
      { from: '비행 수업', owner: '별시계탑', day: '목', slot: '오후', value: '장소는 주인 아님' },
      { from: '없는 일정', owner: '은사슴 1학년', day: '목', slot: '오후', value: 'x' },
    ] }), usage: { prompt_tokens: 900, completion_tokens: 60 } }; },
    parseJsonObject: real.parseJsonObject,
  });
  const wd = s.getWorld(w.worldId);
  s.updateWorld(w.worldId, { revision: wd.revision, auto: { ...wd.auto, connectionId: 'c1' } });
  s.applyAuto(w.worldId, [
    { type: 'schedule', name: '금요일 아침 별자리학', fields: { when: '금요일 아침', who: '은사슴 1학년' } },
    { type: 'schedule', name: '비행 수업', fields: { when: '학기 첫 주 목요일 오후', who: '1학년' } },
    { type: 'schedule', name: '쇼핑', fields: { when: '토요일 오후 두 시', who: '하윤과 친구들' } },
  ]);
  const r = await service.gatherTimetables(w.worldId);
  assert.equal(r.calls, 1);
  assert.deepEqual(r.tokens, { prompt_tokens: 900, completion_tokens: 60 });
  assert.ok(asked[0].includes('[이미 있는 시간표]\n- 은사슴 1학년: 금 아침 별자리학'), 'the code-made sheet is shown to the model');
  assert.deepEqual(r.moved.map((m) => [m.name, !!m.byModel]), [['금요일 아침 별자리학', false], ['비행 수업', true]]);
  assert.deepEqual(r.left, ['쇼핑']);
  assert.equal(sheet('은사슴 1학년').timetable.cells['목|오후'].value, '비행술');
});
