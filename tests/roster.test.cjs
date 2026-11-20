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
  assert.deepEqual(list('은사슴 기숙사'), ['서림', '도겸·은사슴 1학년', '하윤·은사슴 1학년'], 'direct first, then the smaller group, each by name');
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
  assert.deepEqual(list('은사슴 기숙사'), ['서림', '하윤·은사슴 1학년']);
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
