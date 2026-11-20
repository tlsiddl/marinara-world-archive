'use strict';
// v0.6.2 — ① a place whose 위치 칸 names a group is in that group (its rules are 「여기」 in a scene there);
// ③ the scene's status lines never back a lasting field, and recheck takes back what they wrote;
// ④ 「아직 드러나지 않음」 field by field; ⑦ evidence without HTML tags. Made-up world only (별시계 학원).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Archive, groupOfPlace } = require('../world-archive/lib/store.cjs');
const X = require('../world-archive/lib/extract.cjs');
const I = require('../world-archive/lib/inject.cjs');

let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const ent = (type, name, extra = {}) => ({ entityId: id(), type, name, aliases: [], description: '', fields: {}, extra: [], pinned: false, status: 'confirmed', revision: 1, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', ...extra });

test('① a place whose 위치 names a group (or the group without 마법학교) is in it; its rules come with the scene', () => {
  const school = ent('group', '별시계 마법학교');
  const office = ent('place', '학장실', { fields: { location: '별시계 성 3층' } });
  const hall = ent('place', '대강당', { fields: { location: '별시계' } });
  const inn = ent('place', '은사슴 여관', { fields: { location: '별시계 마을' } });
  const village = ent('place', '별시계 마을');
  const E = [school, office, hall, inn, village, ent('rule', '복도에서 뛰지 않는다', { appliesTo: school.entityId })];
  assert.equal(groupOfPlace(office, E)?.name, '별시계 마법학교');
  assert.equal(groupOfPlace(hall, E)?.name, '별시계 마법학교');
  assert.equal(groupOfPlace(inn, E), null, 'a place with that name is where it is, not the group');
  assert.equal(groupOfPlace(ent('place', '별시계 성'), E)?.name, '별시계 마법학교', 'the group\'s name and a building word');
  assert.equal(groupOfPlace(ent('place', '별시계 급행열차'), E), null, 'not every place that starts with the name');
  const r = I.assembleWorld({ name: '별시계', description: '', injectMode: 'scene' }, E, 5000, { scene: new Set([office.entityId]), relations: [] });
  assert.match(r.text, /복도에서 뛰지 않는다/);
});

test('③ status lines are marked; ⑦ evidence has no HTML tags', () => {
  const t = '§RP | 1988-07-19 (화) | 16:15 | 학장실 | 맑음§\n윤하윤: 잠옷 차림 | 침대에 누움 | 졸림\n윤하윤은 <font color="red">은빛 머리</font>를 묶었다.';
  const b = X.segmentBlocks(t);
  assert.deepEqual(b.blocks, ['status', 'status', null]);
  const [part] = X.batches([{ id: 'm1', speaker: '서하', role: 'assistant', content: t }], 0);
  const reply = JSON.stringify({ items: [{ type: 'person', name: '윤하윤', evidence: [{ n: '1.3' }],
    fields: { appearance: { v: '잠옷 차림', n: '1.2' }, state: { v: '졸림', n: '1.2' }, gender: { v: '여성', n: '1.3' } } }] });
  const out = X.checkItems(JSON.parse(reply), part, []);
  const it = out.items[0];
  assert.equal(it.fields.appearance, undefined, 'a status line does not back 외형');
  assert.equal(it.fields.state, '졸림', 'it does back 지금 상태');
  assert.ok(out.droppedFields.some((d) => d.key === 'appearance' && d.why === 'a status line only'));
  assert.doesNotMatch(it.evidence, /<font|<\/font>/);
});

test('④ hidden field by field: a profile-only field is hidden, one the story also says is not', () => {
  const t = '<npc_profile>\n- Name: 윤하윤\n- Age: 11살\n- Appearance: 은빛 머리\n</npc_profile>\n윤하윤은 은빛 머리를 묶었다.';
  const [part] = X.batches([{ id: 'm1', speaker: '서하', role: 'assistant', content: t }], 0);
  const b = X.segmentBlocks(t);
  const num = (re) => `1.${b.sentences.findIndex((x) => re.test(x)) + 1}`;
  const reply = { items: [{ type: 'person', name: '윤하윤', evidence: [{ n: num(/Name/) }],
    fields: { age: { v: '11살', n: num(/Age/) }, appearance: { v: '은빛 머리', n: [num(/Appearance/), num(/묶었다/)] } } }] };
  const it = X.checkItems(reply, part, []).items[0];
  assert.equal(it.hidden.age, true);
  assert.equal(it.hidden.appearance, undefined);
});

test('③ ④ recheck: a status-line change goes back (logged, undoable, a person\'s field untouched); hidden recomputed', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-062-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new Archive(dir);
  const w = s.createWorld({ name: '별시계 학원' });
  s.applyAuto(w.worldId, [{ type: 'person', name: '윤하윤', fields: { appearance: '은빛 머리', personality: '차분함', age: '11살' }, hidden: { age: true }, evidence: '윤하윤은 차분하다' }]);
  s.applyAuto(w.worldId, [{ type: 'person', name: '윤하윤', fields: { appearance: '잠옷 차림', personality: '졸림' }, fieldEvidence: { appearance: '윤하윤: 잠옷 차림 | 침대에 누움 | 졸림', personality: '윤하윤: 잠옷 차림 | 침대에 누움 | 졸림' } }]);
  const e0 = s.listEntities(w.worldId).find((e) => e.name === '윤하윤');
  // the person writes 성격 themselves: never taken back
  s.updateEntity(w.worldId, e0.entityId, { revision: e0.revision, fields: { ...e0.fields, personality: '조용함' } });
  const check = { isStatus: (x) => X.STATUS_LINE.test(x.trim()), says: X.saysValue, story: ['윤하윤은 11살이 되던 해 입학했다.'], profile: [] };
  const out = s.recheckFields(w.worldId, check);
  const e = s.listEntities(w.worldId).find((x) => x.name === '윤하윤');
  assert.equal(e.fields.appearance, '은빛 머리');
  assert.equal(e.fields.personality, '조용함');
  const back = out.find((c) => c.key === 'appearance');
  assert.equal(back.why, '상태줄 근거라 되돌림');
  assert.ok(!out.some((c) => c.key === 'personality' && c.action === 'field'));
  assert.equal(e.hidden?.age, undefined, 'the story says 11살 — not hidden any more');
  assert.ok(out.some((c) => c.action === 'reveal' && c.key === 'age' && c.why === '본문에 나옴'));
  // undoable
  s.undoChange(w.worldId, back.id);
  assert.equal(s.listEntities(w.worldId).find((x) => x.name === '윤하윤').fields.appearance, '잠옷 차림');
  // run again: nothing more (the reverted change is not taken back twice)
  assert.equal(s.recheckFields(w.worldId, check).filter((c) => c.key === 'appearance').length, 0);
});

test('④ recheck: a field written only from profile sentences is marked hidden', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-062-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new Archive(dir);
  const w = s.createWorld({ name: '별시계 학원' });
  s.applyAuto(w.worldId, [{ type: 'person', name: '하르트 공작', fields: { gender: '남성' }, evidence: '하르트 공작이 들어왔다.' }]);
  s.applyAuto(w.worldId, [{ type: 'person', name: '하르트 공작', fields: { age: '58살' }, fieldEvidence: { age: '- Age: 58' } }]);
  const out = s.recheckFields(w.worldId, { isStatus: (x) => X.STATUS_LINE.test(x.trim()), says: X.saysValue, story: ['하르트 공작이 들어왔다.'], profile: ['- Age: 58'] });
  const e = s.listEntities(w.worldId).find((x) => x.name === '하르트 공작');
  assert.equal(e.hidden?.age, true);
  assert.equal(e.hidden?.gender, undefined);
  assert.ok(out.some((c) => c.action === 'hide' && c.key === 'age'));
});

test('⑨ profile blocks read by code: parse both shapes', () => {
  const P = require('../world-archive/lib/profile.cjs');
  const t = '<npc_profile>\n- Name: Rowan "Ro" Hart / Age: 11 / Gender: Female\n- Appearance and clothing: Silver hair, star-pinned robe.\n- Demeanor and key personality traits: Quiet, stubborn.\n- Other noteworthy details: Only daughter of the Hart family.\n</npc_profile>\n<npc_profile>\n이름/나이/성별: 노을 하르트 / 마흔둘 / 남\n외형과 옷차림: 은테 안경, 회색 망토\n</npc_profile>\n<world_profile>\n- Subject: Silverstag First-Year Timetable\n- Type: Schedule\n- Established information: Monday 1st period Astronomy; Tuesday 1st period Herbology; Wednesday 2nd period Flying.\n</world_profile>';
  const [a, b, c] = P.parseProfiles(t);
  assert.equal(a.name, 'Rowan Hart');
  assert.equal(a.nick, 'Ro');
  assert.deepEqual(Object.keys(a.fields).sort(), ['age', 'appearance', 'background', 'gender', 'personality']);
  assert.equal(P.tidyValue('age', a.fields.age), '11살');
  assert.equal(P.tidyValue('gender', a.fields.gender), '여성');
  assert.equal(b.name, '노을 하르트');
  assert.equal(b.fields.age, '마흔둘');
  assert.equal(b.fields.appearance, '은테 안경, 회색 망토');
  assert.equal(c.kind, 'world');
  assert.equal(P.kindOfType(c.type), 'schedule');
  assert.deepEqual(P.parseProfiles('<npc_profile>\n- Name: Gringotts silver-door goblin\n</npc_profile>')[0].nameless, true);
});

test('⑨ applyProfiles: empty fields only, a person made, a second profile\'s other age is 「서로 다른 말을 해요」, a timetable kept', (t) => {
  const P = require('../world-archive/lib/profile.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-062-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new Archive(dir);
  const w = s.createWorld({ name: '별시계 학원' });
  s.applyAuto(w.worldId, [{ type: 'person', name: '로완 하트', fields: { personality: '말수가 적다' } }]);
  const e0 = s.listEntities(w.worldId)[0];
  s.updateEntity(w.worldId, e0.entityId, { revision: e0.revision, fields: { ...e0.fields, background: '직접 쓴 배경' } });
  const pairs = [{ from: 'Rowan Hart', to: '로완 하트' }, { from: 'Silverstag First-Year Timetable', to: '은사슴 1학년 시간표' }];
  const first = P.parseProfiles('<npc_profile>\n- Name: Rowan Hart / Age: 11 / Gender: Female\n- Demeanor and key personality traits: Quiet.\n- Other noteworthy details: Heir.\n</npc_profile>\n<npc_profile>\n- Name: Madam Velloy / Age: 60 / Gender: Female\n</npc_profile>\n<world_profile>\n- Subject: Silverstag First-Year Timetable\n- Type: Schedule\n- Established information: Monday 1st period Astronomy; Tuesday 1st period Herbology.\n</world_profile>\n<world_profile>\n- Subject: Unknown Hall\n- Type: Location\n- Established information: A hall.\n</world_profile>');
  const ch = s.applyProfiles(w.worldId, first, { pairs, story: ['로완 하트는 열한 살이다.'], says: X.saysValue });
  let E = s.listEntities(w.worldId);
  const rowan = E.find((x) => x.name === '로완 하트');
  assert.equal(rowan.fields.age, '11살');
  assert.equal(rowan.fields.gender, '여성');
  assert.equal(rowan.fields.personality, '말수가 적다', 'a field with a value stays');
  assert.equal(rowan.fields.background, '직접 쓴 배경', 'the person\'s own field is never touched');
  assert.equal(rowan.hidden?.gender, true, 'only the profile says it');
  assert.ok(E.some((x) => x.name === 'Madam Velloy' && x.fields.age === '60살'), 'a person the reader left out is made');
  const sheet = E.find((x) => x.name === '은사슴 1학년 시간표');
  assert.equal(sheet.type, 'schedule');
  assert.match(sheet.fields.when, /Monday/);
  assert.ok(!E.some((x) => x.name === 'Unknown Hall'), 'an English-only setting the glossary does not name is not made');
  assert.ok(ch.every((c) => c.why === '프로필 블록'));
  // a second profile with another age
  s.applyProfiles(w.worldId, P.parseProfiles('<npc_profile>\n- Name: Rowan Hart / Age: 12 / Gender: Female\n</npc_profile>'), { pairs });
  E = s.listEntities(w.worldId);
  const again = E.find((x) => x.name === '로완 하트');
  assert.equal(again.fields.age, '11살', 'not written over');
  assert.equal(again.differs.age.value, '12살');
  // undo of a field filled
  const filled = ch.find((c) => c.action === 'field' && c.key === 'gender');
  s.undoChange(w.worldId, filled.id);
  assert.equal(s.listEntities(w.worldId).find((x) => x.name === '로완 하트').fields.gender, undefined);
});

test('② 「한 번 나옴」: a rule one batch spoke of stays out of {{세계}} (not pinned · written · a law by name); recheck counts again', (t) => {
  const { onceOnly } = I;
  const r1 = ent('rule', '복도에서는 오른쪽으로', { seen: { n: 1, last: 'm1' }, appliesTo: 'world' });
  const r2 = ent('rule', '통금', { seen: { n: 2, last: 'm9' }, appliesTo: 'world' });
  const r3 = ent('rule', '비밀 유지법', { seen: { n: 1, last: 'm1' }, appliesTo: 'world' });
  const r4 = ent('system', '은화와 금화', { seen: { n: 1, last: 'm1' }, pinned: true, appliesTo: 'world' });
  const r5 = ent('rule', '사감이 정한 일', { seen: { n: 1, last: 'm1' }, sources: { description: 'manual' }, appliesTo: 'world' });
  const r6 = ent('rule', '아주 옛날 것', { appliesTo: 'world' });
  assert.deepEqual([r1, r2, r3, r4, r5, r6].map(onceOnly), [true, false, false, false, false, false]);
  const text = I.assembleWorld({ name: '별시계', description: '' }, [r1, r2, r3, r4, r5, r6], 5000, {}).text;
  assert.doesNotMatch(text, /복도에서는 오른쪽으로/);
  for (const n of ['통금', '비밀 유지법', '은화와 금화', '사감이 정한 일', '아주 옛날 것']) assert.match(text, new RegExp(n));
  // recheck: the history's batches
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-062-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new Archive(dir);
  const w = s.createWorld({ name: '별시계 학원' });
  s.applyAuto(w.worldId, [{ type: 'rule', name: '복도에서는 오른쪽으로', memo: '' }], { messageIds: ['m1'] });
  s.applyAuto(w.worldId, [{ type: 'rule', name: '복도에서는 오른쪽으로', fields: { category: '학교 규칙' } }], { messageIds: ['m1'] });
  const e = s.listEntities(w.worldId)[0];
  assert.equal(e.seen.n, 1);
  const doc = s.readEntities(w.worldId);
  doc.entities[0].seen = { n: 1, last: 'm1' };
  const h = s.readHistory(w.worldId);
  h.changes.push({ id: 'x', at: '2026-11-21T00:00:00Z', by: 'reader', roomId: null, messageIds: ['m7'], entityId: e.entityId, name: e.name, type: 'rule', action: 'alias', after: '오른쪽 통행' });
  s.writeJson(s.historyFile(w.worldId), h);
  assert.equal(s.recountSeen(w.worldId), 1);
  assert.equal(s.listEntities(w.worldId)[0].seen.n, 2);
});

test('② rules and systems: 「같은 것일 수 있음」 across the two kinds, merged into the kept one\'s; 「서로 다른 말을 해요」 by topic', (t) => {
  const { thingPairs, topicGroups } = require('../world-archive/lib/same.cjs');
  const a = ent('rule', '애니마구스 등록');
  const b = ent('system', '애니마구스 등록', { fields: { how: '마법부 명부에 적는다' } });
  const pairs = thingPairs([a, b]);
  assert.equal(pairs.length, 1);
  assert.match(pairs[0].why, /규칙과 시스템/);
  const g = topicGroups([ent('place', '말킨 옷가게'), ent('rule', '옷에 지팡이 주머니를 달 때는 오른팔에'), ent('system', '교복의 지팡이 주머니는 손목 위에'), ent('rule', '말킨 옷가게 영업시간'), ent('rule', '말킨 옷가게 휴일')]);
  assert.deepEqual(g.map((x) => x.topic), ['지팡이 주머니'], 'a place\'s name is where, not a topic');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-062-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new Archive(dir);
  const w = s.createWorld({ name: '별시계 학원' });
  s.applyAuto(w.worldId, [{ type: 'rule', name: '애니마구스 등록' }, { type: 'system', name: '애니마구스 등록부', fields: { how: '마법부 명부에 적는다' } }]);
  const [x, y] = s.listEntities(w.worldId);
  s.mergeEntities(w.worldId, { keepId: x.entityId, dropId: y.entityId, keepRevision: x.revision, dropRevision: y.revision });
  const kept = s.listEntities(w.worldId);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].type, 'rule');
  assert.match(kept[0].description, /작동 방식: 마법부 명부에 적는다/);
});

test('⑤ ⑩ other names: a small phrase, a lone title, another setting\'s name (「같은 것일 수 있음」), another animal go; glossary words in values', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-062-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new Archive(dir);
  const w = s.createWorld({ name: '별시계 학원' });
  s.applyAuto(w.worldId, [
    { type: 'person', name: '로웨나 셀린', aliases: ['Rowena Selin'] },
    { type: 'person', name: '보보', fields: { species: '니즐' } },
    { type: 'person', name: '은빛 불사조', fields: { species: '불사조' } },
    { type: 'place', name: '여관 1층 바', fields: { location: '은사슴 여관 east wing' } },
  ]);
  // what an older reading left (written straight into the file)
  const doc = s.readEntities(w.worldId);
  const by = (n) => doc.entities.find((e) => e.name === n);
  by('보보').aliases = ['로웨나 셀린', 'Kneazle'];
  by('은빛 불사조').aliases = ['은색 표범', 'Phoenix'];
  by('여관 1층 바').aliases = ['the bar', 'Professor'];
  s.writeJson(s.entityFile(w.worldId), doc);
  const off = s.tidyAliases(w.worldId);
  const E = s.listEntities(w.worldId);
  const of = (n) => E.find((e) => e.name === n);
  assert.deepEqual(of('보보').aliases, ['Kneazle'], 'its own animal in English stays');
  assert.deepEqual(of('은빛 불사조').aliases, ['Phoenix']);
  assert.deepEqual(of('여관 1층 바').aliases, []);
  assert.ok(off.some((c) => c.alias === '은색 표범' && /다른 동물/.test(c.why)));
  assert.ok((of('보보').maybe || []).some((m) => m.id === of('로웨나 셀린').entityId), '「같은 것일 수 있음」');
  // a reading that names it so again does not put it back
  s.applyAuto(w.worldId, [{ type: 'person', name: '보보', match: '보보', aliases: ['로웨나 셀린', 'the little one'] }]);
  assert.deepEqual(s.listEntities(w.worldId).find((e) => e.name === '보보').aliases, ['Kneazle']);
  // ⑤ glossary words in a Korean value
  const g = s.glossaryValues(w.worldId, [{ from: 'east wing', to: '동쪽 별채' }]);
  assert.equal(g.length, 1);
  assert.equal(s.listEntities(w.worldId).find((e) => e.name === '여관 1층 바').fields.location, '은사슴 여관 동쪽 별채');
});

test('⑥ roster: 유모 · 가정교사 are 맡은 사람, an animal is 「함께 사는 동물」; a 소속 칸 naming a shop is 「일하는 곳」', (t) => {
  const Ro = require('../world-archive/lib/roster.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-062-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new Archive(dir);
  const w = s.createWorld({ name: '별시계 학원' });
  s.applyAuto(w.worldId, [
    { type: 'group', name: '하르트 가문' },
    { type: 'place', name: '은사슴 지팡이 가게' },
    { type: 'person', name: '하윤', fields: { affiliation: '하르트 가문' } },
    { type: 'person', name: '메이', fields: { affiliation: '하르트 가문 유모' } },
    { type: 'person', name: '핀', fields: { affiliation: '하르트 가문 가정교사' } },
    { type: 'person', name: '솜뭉치', fields: { affiliation: '하르트 가문', species: '고양이' } },
    { type: 'person', name: '노인 장인', fields: { affiliation: '은사슴 지팡이 가게 주인' } },
  ]);
  const ch = s.linkAffiliations(w.worldId);
  const doc = s.readEntities(w.worldId);
  const g = doc.entities.find((e) => e.name === '하르트 가문');
  const r = Ro.rosterOf(doc.entities, doc.relations, g.entityId);
  const kind = (n) => r.members.find((m) => m.name === n)?.kind;
  assert.deepEqual(['하윤', '메이', '핀', '솜뭉치'].map(kind), ['member', 'staff', 'staff', 'animal']);
  assert.equal(r.counts.animal, 1);
  const shop = doc.entities.find((e) => e.name === '은사슴 지팡이 가게');
  const old = doc.entities.find((e) => e.name === '노인 장인');
  assert.equal(old.work, shop.entityId);
  assert.ok(!doc.entities.some((e) => e.type === 'group' && /지팡이 가게/.test(e.name)), 'not a group');
  const c = ch.find((x) => x.action === 'work');
  s.undoChange(w.worldId, c.id);
  assert.equal(s.listEntities(w.worldId).find((e) => e.name === '노인 장인').work, undefined);
});

test('⑦ a 학사일정 entry for one person becomes that person\'s 일정 (undoable); one for a group stays', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-062-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new Archive(dir);
  const w = s.createWorld({ name: '별시계 학원' });
  s.applyAuto(w.worldId, [{ type: 'group', name: '별시계 학원' }, { type: 'person', name: '하윤' }]);
  const school = s.listEntities(w.worldId).find((e) => e.type === 'group');
  s.applyCalendar(w.worldId, [
    { ownerId: school.entityId, date: '1891-07-31', name: '입학 답장 마감', who: '하윤', evidence: '하윤은 31일까지 답장을 보내야 했다.' },
    { ownerId: school.entityId, date: '1891-09-01', name: '입학식', who: '1학년 전체', evidence: '9월 1일 입학식.' },
  ], { yearStart: 9 });
  const ch = s.personalEvents(w.worldId);
  const E = s.listEntities(w.worldId);
  const own = E.find((e) => e.type === 'schedule' && e.name === '입학 답장 마감');
  assert.equal(own.fields.who, '하윤');
  assert.match(own.fields.when, /1891-07-31/);
  const cal = E.find((e) => e.calendar);
  assert.deepEqual(Object.values(cal.calendar.events).map((x) => x.name), ['입학식']);
  const moved = ch.find((c) => c.action === 'event');
  s.undoChange(w.worldId, moved.id);
  assert.equal(Object.values(s.listEntities(w.worldId).find((e) => e.calendar).calendar.events).length, 2);
});
