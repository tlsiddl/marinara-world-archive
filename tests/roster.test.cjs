'use strict';
// v0.5.0 A — 구성원 명단: gathered by code from 소속 (never stored, never written by the model); a smaller group's
// people are in the bigger group's list; the list follows 소속 칸 changes; adding / taking off = changing the 소속 칸.
// Made-up world only (별시계 학원), no RP content.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Archive } = require('../world-archive/lib/store.cjs');
const { rosterOf } = require('../world-archive/lib/roster.cjs');

function world(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-roster-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new Archive(dir);
  const w = s.createWorld({ name: '별시계 학원' });
  s.applyAuto(w.worldId, [
    { type: 'group', name: '은사슴 기숙사', aliases: ['은사슴'] },
    { type: 'group', name: '은사슴 1학년' },
    { type: 'group', name: '청매 기숙사', aliases: ['청매'] },
    { type: 'person', name: '하윤', fields: { affiliation: '은사슴 1학년' } },
    { type: 'person', name: '도겸', fields: { affiliation: '은사슴 1학년' } },
    { type: 'person', name: '서림', fields: { affiliation: '은사슴 기숙사 5학년 반장' } },
    { type: 'person', name: '무진' },
  ]);
  const id = (n) => s.listEntities(w.worldId).find((e) => e.name === n).entityId;
  s.linkSubgroups(w.worldId);
  s.linkAffiliations(w.worldId);
  return { s, w, id, list: (g) => s.roster(w.worldId, id(g)).members.map((m) => (m.via ? `${m.name}·${m.via}` : m.name)) };
}

test('a group\'s list is its people and the people of the smaller groups in it, from 소속 by code', (t) => {
  const { s, w, id, list } = world(t);
  const rel = s.listRelations(w.worldId).find((r) => r.from === id('은사슴 1학년'));
  assert.equal(rel?.to, id('은사슴 기숙사'), '「은사슴 1학년」 is in 「은사슴 기숙사」 by its name');
  assert.equal(rel.evidence, '이름: 은사슴 1학년');
  assert.deepEqual(list('은사슴 1학년'), ['도겸', '하윤']);
  assert.deepEqual(list('은사슴 기숙사'), ['도겸·은사슴 1학년', '하윤·은사슴 1학년', '서림'], 'members first (the people of the smaller group), then 서림 — 「반장」 is 맡은 사람');
  assert.deepEqual(list('청매 기숙사'), []);
  assert.deepEqual(s.roster(w.worldId, id('은사슴 기숙사')).groups.map((g) => g.name), ['은사슴 1학년']);
  assert.throws(() => s.roster(w.worldId, id('하윤')), (e) => e.status === 404, 'only a group has a list');
  // Nothing about the list is stored on the group.
  assert.equal(s.listEntities(w.worldId).find((e) => e.name === '은사슴 기숙사').fields.members, undefined);
});

test('「○○ 기숙사」 is the same group as 「○○」, not one inside it; a loop of 소속 does not hang the walk', (t) => {
  const { s, w, id } = world(t);
  const a = s.createEntity(w.worldId, { type: 'group', name: '금빛' });
  const b = s.createEntity(w.worldId, { type: 'group', name: '금빛 기숙사' });
  s.createEntity(w.worldId, { type: 'group', name: '금빛 2학년' });
  s.linkSubgroups(w.worldId);
  const joined = (x) => s.listRelations(w.worldId).filter((r) => r.type === '소속' && [r.from, r.to].includes(x)).map((r) => [r.from, r.to].includes(id('금빛 2학년')));
  assert.deepEqual(joined(b.entityId), [], '「금빛 기숙사」 is not inside 「금빛」');
  assert.deepEqual(joined(a.entityId), [true], 'only 「금빛 2학년」 is inside 「금빛」');
  const ents = s.listEntities(w.worldId);
  const loop = [
    { type: '소속', from: id('은사슴 1학년'), to: id('은사슴 기숙사') },
    { type: '소속', from: id('은사슴 기숙사'), to: id('은사슴 1학년') },
    { type: '소속', from: id('하윤'), to: id('은사슴 1학년') },
  ];
  assert.deepEqual(rosterOf(ents, loop, id('은사슴 기숙사')).members.map((m) => m.name), ['하윤']);
});

test('the list follows the 소속 칸: a transfer moves the person; the reader\'s old 소속 goes when the old value named it', (t) => {
  const { s, w, id, list } = world(t);
  // the reader also said 도겸 is in 은사슴 (a relation of its own, not from the 소속 칸)
  s.applyRelations(w.worldId, [{ from: id('도겸'), to: id('은사슴 기숙사'), type: '소속', evidence: '도겸은 은사슴 학생이다.' }]);
  const was = s.listEntities(w.worldId).find((e) => e.name === '도겸').fields.affiliation;
  const changes = s.applyAuto(w.worldId, [{ type: 'person', match: '도겸', name: '도겸', fields: { affiliation: '청매 기숙사 1학년' } }]);
  assert.equal(changes.find((c) => c.key === 'affiliation')?.before, was);
  const out = s.linkAffiliations(w.worldId, null, { was: { [id('도겸')]: was } });
  assert.deepEqual(out.filter((c) => c.action === 'relation-remove').map((c) => c.why), ['affiliation changed', 'affiliation changed']);
  assert.deepEqual(list('청매 기숙사'), ['도겸']);
  assert.deepEqual(list('은사슴 기숙사'), ['하윤·은사슴 1학년', '서림']);
  // the removals are in the history and can be undone one by one
  const h = s.listHistory(w.worldId).filter((c) => c.action === 'relation-remove');
  assert.equal(h.length, 2);
});

test('a 소속 the person made by hand stays even when the 소속 칸 changes', (t) => {
  const { s, w, id, list } = world(t);
  s.createRelation(w.worldId, { from: id('무진'), to: id('청매 기숙사'), type: '소속', note: '명예 회원' });
  s.applyAuto(w.worldId, [{ type: 'person', match: '무진', name: '무진', fields: { affiliation: '은사슴 기숙사' } }]);
  s.linkAffiliations(w.worldId, null, { was: { [id('무진')]: '' } });
  assert.deepEqual(list('청매 기숙사'), ['무진']);
  assert.ok(list('은사슴 기숙사').includes('무진'));
});

test('adding to / taking off a list is changing the 소속 칸 (recorded as the person\'s edit, undoable)', (t) => {
  const { s, w, id, list } = world(t);
  const add = s.setMember(w.worldId, id('청매 기숙사'), id('무진'), true);
  assert.deepEqual(add.affiliation, { before: '', after: '청매 기숙사' });
  assert.deepEqual(list('청매 기숙사'), ['무진']);
  const p = s.listEntities(w.worldId).find((e) => e.name === '무진');
  assert.equal(p.sources.affiliation, 'manual', 'the person\'s own value from now on');

  const off = s.setMember(w.worldId, id('은사슴 기숙사'), id('서림'), false);
  assert.deepEqual(off.affiliation, { before: '은사슴 기숙사 5학년 반장', after: '5학년 반장' });
  assert.deepEqual(list('은사슴 기숙사'), ['도겸·은사슴 1학년', '하윤·은사슴 1학년']);
  // a value that names two groups keeps the other one
  s.setMember(w.worldId, id('청매 기숙사'), id('하윤'), true);
  assert.equal(s.listEntities(w.worldId).find((e) => e.name === '하윤').fields.affiliation, '은사슴 1학년, 청매 기숙사');
  s.setMember(w.worldId, id('은사슴 1학년'), id('하윤'), false);
  assert.equal(s.listEntities(w.worldId).find((e) => e.name === '하윤').fields.affiliation, '청매 기숙사');
  assert.deepEqual(list('은사슴 1학년'), ['도겸']);

  // undo of 서림's edit: the 소속 칸 comes back (the service then runs linkAffiliations — the list follows)
  const edit = s.listHistory(w.worldId).find((c) => c.action === 'edit' && c.name === '서림');
  s.undoChange(w.worldId, edit.id);
  s.linkAffiliations(w.worldId, [id('서림')], { by: 'undo' });
  assert.ok(list('은사슴 기숙사').includes('서림'));
});

test('the reader is told not to list names in 구성원 and to write the smallest group in 소속', () => {
  const text = fs.readFileSync(path.join(__dirname, '../world-archive/lib/extract.cjs'), 'utf8');
  assert.match(text, /members\(구성원\)에는 규모·구성/);
  assert.match(text, /가장 작은 집단까지/);
});

// v0.5.0 A-2 — groups the 소속 칸 name that are not there yet, by code.
function houses(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-fill-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new Archive(dir);
  const w = s.createWorld({ name: '별시계 학원' });
  s.applyAuto(w.worldId, [
    { type: 'group', name: '별시계 학원', aliases: ['별시계'] },
    { type: 'rule', name: '별시계 학원은 세 기숙사로 나뉜다', aliases: ['은사슴 기숙사', '청매 기숙사', 'Silver Stag'] },
    { type: 'place', name: '은사슴 1학년 남학생 기숙사' },
    { type: 'person', name: '하윤', fields: { affiliation: '별시계 은사슴 1학년' } },
    { type: 'person', name: '도겸', fields: { affiliation: '별시계 은사슴 1학년' } },
    { type: 'person', name: '서림', fields: { affiliation: '은사슴 5학년 반장' } },
    { type: 'person', name: '무진', fields: { affiliation: '은사슴 1학년 남학생 기숙사' } },
    { type: 'person', name: '이안', fields: { affiliation: '은사슴 1학년 남학생 기숙사' } },
    { type: 'person', name: '가람', fields: { affiliation: '청매 기숙사 3학년' } },
  ]);
  const id = (n) => s.listEntities(w.worldId).find((e) => e.name === n)?.entityId;
  return { s, w, id };
}

test('A-2: a group two 소속 칸 name is made — from a rule\'s other name (taken off the rule), and a piece that reads as a group', (t) => {
  const { s, w, id } = houses(t);
  const out = s.fillGroups(w.worldId);
  assert.deepEqual(out.created.sort(), ['은사슴 1학년', '은사슴 기숙사']);
  assert.deepEqual(out.moved, [{ from: '별시계 학원은 세 기숙사로 나뉜다', alias: '은사슴 기숙사' }]);
  const rule = s.listEntities(w.worldId).find((e) => e.type === 'rule');
  assert.deepEqual(rule.aliases, ['청매 기숙사', 'Silver Stag'], 'only the one made into a group leaves the rule; the rule stays');
  const g = s.listEntities(w.worldId).find((e) => e.name === '은사슴 기숙사');
  assert.deepEqual(g.aliases, ['은사슴']);
  assert.equal(g.provenance.source, 'auto');
  const up = (n) => s.listRelations(w.worldId).filter((r) => r.type === '소속' && r.from === id(n)).map((r) => s.listEntities(w.worldId).find((e) => e.entityId === r.to).name);
  assert.deepEqual(up('은사슴 기숙사'), ['별시계 학원'], 'the bigger group the rule names');
  assert.equal(s.listRelations(w.worldId).find((r) => r.from === id('은사슴 기숙사')).evidence, '별시계 학원은 세 기숙사로 나뉜다');
  assert.deepEqual(up('은사슴 1학년'), ['은사슴 기숙사'], 'by its name');
  assert.equal(id('은사슴 1학년 남학생 기숙사') && s.listEntities(w.worldId).find((e) => e.name === '은사슴 1학년 남학생 기숙사').type, 'place', 'a place stays a place');
  const names = (n) => s.roster(w.worldId, id(n)).members.map((m) => m.name + (m.via ? '·' + m.via : ''));
  assert.deepEqual(names('은사슴 기숙사'), ['도겸·은사슴 1학년', '무진·은사슴 1학년', '이안·은사슴 1학년', '하윤·은사슴 1학년', '서림'], 'the place 「은사슴 1학년 남학생 기숙사」 in their 소속 칸 names 은사슴 1학년');
  assert.ok(names('별시계 학원').includes('서림·은사슴 기숙사'), 'the school list has the house people too');
  // 청매: one person only → offered, not made
  const plan = s.planGroups(s.readEntities(w.worldId));
  assert.deepEqual(plan.suggest.map((o) => `${o.name}:${o.peopleNames.join(',')}`).sort(), ['청매 기숙사 3학년:가람', '청매 기숙사:가람'], 'not 「은사슴 5학년 반장」 (a role, not a group)');
  assert.equal(id('청매 기숙사'), undefined);
  // again: nothing new
  assert.deepEqual(s.fillGroups(w.worldId).created, []);
});

test('A-2: 「집단으로 만들기」 makes the offered one (the person\'s); undo puts the other name back on the rule', (t) => {
  const { s, w, id } = houses(t);
  s.fillGroups(w.worldId);
  const made = s.fillGroups(w.worldId, {}, '청매 기숙사');
  assert.deepEqual(made.created, ['청매 기숙사']);
  const g = s.listEntities(w.worldId).find((e) => e.name === '청매 기숙사');
  assert.equal(g.provenance.source, 'manual');
  assert.deepEqual(s.roster(w.worldId, g.entityId).members.map((m) => m.name), ['가람']);
  assert.throws(() => s.fillGroups(w.worldId, {}, '없는 이름'), (e) => e.status === 404);
  const mv = s.listHistory(w.worldId).find((c) => c.action === 'alias-move' && c.alias === '청매 기숙사');
  s.undoChange(w.worldId, mv.id);
  assert.ok(s.listEntities(w.worldId).find((e) => e.type === 'rule').aliases.includes('청매 기숙사'));
  void id;
});

test('A-2: the reader is told to make the group a 소속 칸 names when it is not there', () => {
  const text = fs.readFileSync(path.join(__dirname, '../world-archive/lib/extract.cjs'), 'utf8');
  assert.match(text, /affiliation에 적은 집단이 \[이미 있는 항목\]에 없으면 그 집단도 집단 항목으로 같이 만든다/);
});

test('the list in three parts — 구성원 · 맡은 사람 · 지난 구성원 — and 「(이름 모름)」 for a name that is a description', (t) => {
  const { s, w, id } = world(t);
  s.applyAuto(w.worldId, [
    { type: 'person', name: '노을 교수', fields: { affiliation: '은사슴 기숙사 사감' } },
    { type: 'person', name: '청운', fields: { affiliation: '은사슴 기숙사 출신, 학원 창립자' } },
    { type: 'person', name: '도겸의 사촌', fields: { affiliation: '은사슴 1학년' } },
    { type: 'person', name: '쌍둥이 중 한 명', fields: { affiliation: '은사슴 1학년' } },
  ]);
  s.linkAffiliations(w.worldId);
  const r = s.roster(w.worldId, id('은사슴 기숙사'));
  const by = (k) => r.members.filter((m) => m.kind === k).map((m) => m.name);
  assert.deepEqual(by('staff').sort(), ['노을 교수', '서림'].sort(), '사감 · 반장');
  assert.deepEqual(by('past'), ['청운'], '출신 · 창립자');
  assert.deepEqual(r.members.filter((m) => m.unnamed).map((m) => m.name).sort(), ['도겸의 사촌', '쌍둥이 중 한 명'].sort());
  assert.equal(r.counts.named, r.members.length - 2, 'a description is not a name known');
  assert.deepEqual(by('member').sort(), ['도겸', '도겸의 사촌', '쌍둥이 중 한 명', '하윤'].sort());
});
