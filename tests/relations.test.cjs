'use strict';
// Relations between settings (사령탑 할 일 3): stored by id, read with evidence, renewed / ended by the reader,
// 소속 칸 → 소속 관계 by code, and carried along by merge, delete and undo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Archive } = require('../world-archive/lib/store.cjs');
const X = require('../world-archive/lib/extract.cjs');
const service = require('../world-archive/lib/service.cjs');
const real = require('../world-archive/lib/vendor/engine.cjs');
const { assembleWorld } = require('../world-archive/lib/inject.cjs');

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-rel-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new Archive(dir);
}
const status = (code) => (e) => e.status === code;

function world(t) {
  const s = temp(t);
  const w = s.createWorld({ name: '호그와트' });
  s.applyAuto(w.worldId, [
    { type: 'person', name: '해나', fields: { affiliation: '후플푸프 기숙사' } },
    { type: 'person', name: '어니' },
    { type: 'group', name: '후플푸프', aliases: ['Hufflepuff'] },
    { type: 'place', name: '부엌' },
    { type: 'place', name: '호그와트 성' },
  ]);
  const id = (n) => s.listEntities(w.worldId).find((e) => e.name === n).entityId;
  return { s, w, id };
}

test('the reader adds a relation only between two settings; same pair and kind renews the note; an ended one leaves 「과거에는」', (t) => {
  const { s, w, id } = world(t);
  let c = s.applyRelations(w.worldId, [
    { from: id('해나'), to: id('어니'), type: '연인', note: '사귐', evidence: '둘은 사귄다.' },
    { from: id('해나'), to: '00000000-0000-4000-8000-000000000000', type: '친구' }, // the other end does not exist
    { from: id('해나'), to: id('해나'), type: '친구' }, // itself
    { from: id('해나'), to: id('어니'), type: '원수' }, // not a kind
  ]);
  assert.deepEqual(c.map((x) => x.action), ['relation-add']);
  assert.equal(s.listRelations(w.worldId).length, 1);
  c = s.applyRelations(w.worldId, [{ from: id('어니'), to: id('해나'), type: '연인', note: '오래 사귐' }]);
  assert.deepEqual(c.map((x) => [x.action, x.before, x.after]), [['relation-note', '사귐', '오래 사귐']], 'unordered pair, same kind: note only');
  c = s.applyRelations(w.worldId, [{ from: id('해나'), to: id('어니'), type: '친구', note: '헤어진 뒤 친구', was: '연인' }]);
  assert.deepEqual(c.map((x) => x.action), ['relation-remove', 'relation-add']);
  const [r] = s.listRelations(w.worldId);
  assert.deepEqual([r.type, r.note], ['친구', '헤어진 뒤 친구 · 과거에는 연인']);
});

test('relations the person made are never changed by the reader; manual CRUD is validated and recorded', (t) => {
  const { s, w, id } = world(t);
  const r = s.createRelation(w.worldId, { from: id('해나'), to: id('어니'), type: '가족', note: '남매' });
  assert.equal(r.source, 'manual');
  assert.throws(() => s.createRelation(w.worldId, { from: id('어니'), to: id('해나'), type: '가족' }), status(409), 'same pair and kind');
  assert.throws(() => s.createRelation(w.worldId, { from: id('해나'), to: id('해나'), type: '가족' }), status(400));
  assert.throws(() => s.createRelation(w.worldId, { from: id('해나'), to: id('어니'), type: '원수' }), status(400));
  assert.equal(s.applyRelations(w.worldId, [{ from: id('해나'), to: id('어니'), type: '가족', note: '쌍둥이' }]).length, 0);
  assert.equal(s.applyRelations(w.worldId, [{ from: id('해나'), to: id('어니'), type: '친구', was: '가족' }]).filter((c) => c.action === 'relation-remove').length, 0, 'a manual relation is not ended');
  assert.equal(s.listRelations(w.worldId).find((x) => x.type === '가족').note, '남매');
  const u = s.updateRelation(w.worldId, r.relationId, { note: '쌍둥이 남매' });
  assert.equal(u.note, '쌍둥이 남매');
  s.deleteRelation(w.worldId, r.relationId);
  const h = s.listHistory(w.worldId);
  assert.equal(h[0].action, 'relation-remove');
  s.undoChange(w.worldId, h[0].id);
  assert.equal(s.listRelations(w.worldId).find((x) => x.relationId === r.relationId).note, '쌍둥이 남매', 'undo brings it back');
});

test('소속 칸 → 소속 관계 by code, once, from the name or another name of a group', (t) => {
  const { s, w, id } = world(t);
  const c = s.linkAffiliations(w.worldId);
  assert.deepEqual(c.map((x) => [x.action, x.by, x.relation.type, x.relation.from, x.relation.to]), [['relation-add', 'affiliation', '소속', id('해나'), id('후플푸프')]]);
  assert.equal(s.linkAffiliations(w.worldId).length, 0, 'not twice');
  const e = s.listEntities(w.worldId).find((x) => x.name === '어니');
  s.updateEntity(w.worldId, e.entityId, { fields: { affiliation: 'Hufflepuff' }, revision: e.revision });
  assert.equal(s.linkAffiliations(w.worldId, [e.entityId]).length, 1, 'another name counts');
});

test('merge moves relations to the kept setting (no self-link, no double) and undo puts them back', (t) => {
  const { s, w, id } = world(t);
  s.applyAuto(w.worldId, [{ type: 'person', name: '해나 애벗' }]);
  const full = s.listEntities(w.worldId).find((e) => e.name === '해나 애벗');
  s.applyRelations(w.worldId, [
    { from: id('해나'), to: id('어니'), type: '친구' },
    { from: full.entityId, to: id('어니'), type: '친구' }, // becomes a double after the merge
    { from: full.entityId, to: id('부엌'), type: '기타', note: '자주 감' },
    { from: id('해나'), to: full.entityId, type: '가족' }, // becomes a self-link
  ]);
  const keep = s.listEntities(w.worldId).find((e) => e.name === '해나');
  const before = JSON.stringify(s.listRelations(w.worldId).map((r) => [r.from, r.to, r.type]).sort());
  s.mergeEntities(w.worldId, { keepId: keep.entityId, dropId: full.entityId, keepRevision: keep.revision, dropRevision: full.revision });
  const after = s.listRelations(w.worldId);
  assert.deepEqual(after.map((r) => [r.type, r.from === keep.entityId || r.to === keep.entityId]).sort(), [['기타', true], ['친구', true]]);
  const m = s.listHistory(w.worldId).find((c) => c.action === 'merge');
  s.undoChange(w.worldId, m.id);
  assert.equal(JSON.stringify(s.listRelations(w.worldId).map((r) => [r.from, r.to, r.type]).sort()), before);
});

test('deleting a setting takes its relations along; undo of the delete brings both back; undoing a creation waits for its relations', (t) => {
  const { s, w, id } = world(t);
  s.applyRelations(w.worldId, [{ from: id('해나'), to: id('어니'), type: '친구' }, { from: id('부엌'), to: id('호그와트 성'), type: '위치' }]);
  const ernie = s.listEntities(w.worldId).find((e) => e.name === '어니');
  const res = s.deleteEntity(w.worldId, ernie.entityId, ernie.revision);
  assert.equal(res.relations, 1);
  assert.equal(s.listRelations(w.worldId).length, 1);
  const del = s.listHistory(w.worldId)[0];
  assert.equal(del.action, 'delete');
  s.undoChange(w.worldId, del.id);
  assert.ok(s.listEntities(w.worldId).some((e) => e.entityId === ernie.entityId));
  assert.equal(s.listRelations(w.worldId).length, 2);
  const create = s.listHistory(w.worldId, 1000).find((c) => c.action === 'create' && c.name === '부엌');
  assert.throws(() => s.undoChange(w.worldId, create.id), (e) => e.status === 409 && /그 뒤 자동으로 1번/.test(e.message));
});

test('checkRelations keeps kinds with evidence and skips card characters', () => {
  const [part] = X.batches([{ id: 'm1', speaker: '나', role: 'assistant', content: '해나와 어니는 남매다. 해리는 웃었다.' }], 0);
  const { relations, dropped } = X.checkRelations({
    relations: [
      { from: '해나', to: '어니', type: '가족', note: '남매', evidence: [{ n: '1.1' }] },
      { from: '해나', to: '해리', type: '친구', evidence: [{ n: '1.2' }] },
      { from: '해나', to: '어니', type: '원수', evidence: [{ n: '1.1' }] },
      { from: '해나', to: '어니', type: '친구', evidence: [{ n: '9.9', q: '없는 말' }] },
    ],
  }, part, ['해리']);
  assert.deepEqual(relations.map((r) => [r.from, r.to, r.type, r.note, r.evidence]), [['해나', '어니', '가족', '남매', '해나와 어니는 남매다.']]);
  assert.deepEqual(dropped.map((d) => d.why), ['card', 'relation type', 'no evidence sentence']);
});

test('runRoom: relations from the reply are added when both ends are settings, plus 소속 from the field', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-relrun-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new Archive(dir);
  service._test.useStore(s);
  const messages = [0, 1, 2, 3, 4, 5].map((i) => ({ id: 'm' + i, speaker: i % 2 ? '서술' : '나', role: i % 2 ? 'assistant' : 'user', content: i === 1 ? '해나는 후플푸프 학생이다. 해나와 어니는 남매다.' : '글 ' + i }));
  const reply = JSON.stringify({
    items: [
      { type: 'person', name: '해나', fields: { affiliation: { v: '후플푸프', n: ['2.1'] } }, evidence: [{ n: '2.1' }] },
      { type: 'person', name: '어니', evidence: [{ n: '2.2' }] },
      { type: 'group', name: '후플푸프', evidence: [{ n: '2.1' }] },
    ],
    relations: [
      { from: '해나', to: '어니', type: '가족', note: '남매', evidence: [{ n: '2.2' }] },
      { from: '해나', to: '없는 사람', type: '친구', evidence: [{ n: '2.2' }] },
    ],
  });
  service._test.useEngine({
    model: async () => ({}), chatMessages: async () => ({ messages, cast: [] }),
    askModel: async () => ({ content: reply }), parseJsonObject: real.parseJsonObject, listConnections: async () => [], glossary: async () => null,
  });
  service._test.jobs.clear();
  const w = s.createWorld({ name: '호그와트', auto: { enabled: true, connectionId: 'c1', every: 2 } });
  s.linkRoom('room', w.worldId);
  const job = await service.runRoom('room', { all: true });
  assert.equal(job.state, 'done');
  assert.equal(job.relations, 2);
  assert.deepEqual(s.listRelations(w.worldId).map((r) => r.type).sort(), ['가족', '소속']);
});

test('scene mode puts one line per relation whose both ends are in the scene, within the budget', () => {
  const e = (id, name, type) => ({ entityId: id, name, type, aliases: [], fields: {}, status: 'confirmed', pinned: false, description: '' });
  const ents = [e('a', '해나', 'person'), e('b', '어니', 'person'), e('c', '세드릭', 'person')];
  const relations = [{ from: 'a', to: 'b', type: '가족', note: '남매' }, { from: 'a', to: 'c', type: '친구', note: '' }];
  const world = { name: '호그와트', description: '', injectMode: 'scene' };
  const out = assembleWorld(world, ents, 3000, { scene: new Set(['a', 'b']), relations });
  assert.match(out.text, /\[관계\]\n- 해나 — 어니: 남매$/);
  assert.doesNotMatch(out.text, /세드릭/);
  assert.doesNotMatch(assembleWorld({ ...world, injectMode: 'all' }, ents, 3000, { scene: new Set(['a', 'b']), relations }).text, /\[관계\]/, 'only in scene mode');
});

test('relationFits: 위치 joins places, 소속 a person and a group, family kinds people; a person at a place is no relation', () => {
  const f = X.relationFits;
  assert.equal(f('위치', 'place', 'place'), true);
  assert.equal(f('위치', 'person', 'place'), false);
  assert.equal(f('소속', 'person', 'group'), true);
  assert.equal(f('소속', 'group', 'person'), true);
  assert.equal(f('소속', 'person', 'place'), false);
  assert.equal(f('가족', 'person', 'person'), true);
  assert.equal(f('연인', 'person', 'group'), false);
  assert.equal(f('적대', 'group', 'group'), true);
  assert.equal(f('기타', 'person', 'place'), false);
  assert.equal(f('기타', 'group', 'place'), true);
});
