'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Archive, ArchiveError } = require('../world-archive/lib/store.cjs');

const temp = (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-store-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return new Archive(path.join(base, 'world-archive'));
};
const status = (code) => (e) => e instanceof ArchiveError && e.status === code;

test('worlds: create, list, update, delete with revisions', (t) => {
  const s = temp(t);
  assert.deepEqual(s.listWorlds(), []);
  const a = s.createWorld({ name: '  별빛   학원  ', description: '1988년, 산 위의 기숙학교' });
  assert.equal(a.name, '별빛 학원');
  assert.equal(a.injectChars, 3000);
  const b = s.updateWorld(a.worldId, { name: '별빛 학원 1988', revision: 1 });
  assert.equal(b.revision, 2);
  assert.throws(() => s.updateWorld(a.worldId, { name: 'x', revision: 1 }), status(409));
  assert.throws(() => s.updateWorld(a.worldId, { revision: 2 }), status(400));
  assert.throws(() => s.updateWorld(a.worldId, { injectChars: 10, revision: 2 }), status(400));
  assert.equal(s.deleteWorld(a.worldId, 2).deleted, true);
  assert.equal(s.listWorlds().length, 0);
});

test('data survives a new Archive instance (restart)', (t) => {
  const s = temp(t);
  const w = s.createWorld({ name: 'A' });
  s.createEntity(w.worldId, { type: 'person', name: '한여름', description: '3학년 반장' });
  s.linkRoom('room_1', w.worldId);
  const again = new Archive(s.dir);
  assert.equal(again.listEntities(w.worldId)[0].name, '한여름');
  assert.equal(again.roomWorldId('room_1'), w.worldId);
});

test('same names stay separate worlds and entities', (t) => {
  const s = temp(t);
  const a = s.createWorld({ name: '별빛 학원' });
  const b = s.createWorld({ name: '별빛 학원' });
  assert.notEqual(a.worldId, b.worldId);
  const x = s.createEntity(a.worldId, { type: 'person', name: '서준' });
  const y = s.createEntity(a.worldId, { type: 'person', name: '서준' });
  assert.notEqual(x.entityId, y.entityId);
  assert.equal(s.listEntities(b.worldId).length, 0);
});

test('entities: validation, aliases, revisions, delete', (t) => {
  const s = temp(t);
  const w = s.createWorld({ name: 'A' });
  assert.throws(() => s.createEntity(w.worldId, { type: 'dragon', name: 'x' }), status(400));
  assert.throws(() => s.createEntity(w.worldId, { type: 'person', name: '   ' }), status(400));
  assert.throws(() => s.createEntity(w.worldId, { type: 'person', name: 'x', pinned: 'yes' }), status(400));
  const e = s.createEntity(w.worldId, { type: 'person', name: '윤도하', aliases: ['도하', 'Doha', '도하', '윤도하'] });
  assert.deepEqual(e.aliases, ['도하', 'Doha']);
  assert.equal(e.status, 'confirmed');
  assert.deepEqual(e.provenance, { source: 'manual' });
  const e2 = s.updateEntity(w.worldId, e.entityId, { name: '도하', revision: 1 });
  assert.deepEqual(e2.aliases, ['Doha'], 'an alias equal to the new name is dropped');
  assert.equal(e2.type, 'person');
  assert.throws(() => s.updateEntity(w.worldId, e.entityId, { name: 'z', revision: 1 }), status(409));
  assert.throws(() => s.deleteEntity(w.worldId, e.entityId, 1), status(409));
  assert.equal(s.deleteEntity(w.worldId, e.entityId, 2).deleted, true);
  assert.throws(() => s.listEntities('not-an-id'), status(400));
});

test('fields per kind: validated, trimmed, empty ones dropped, kept across kind changes only when they fit', (t) => {
  const s = temp(t);
  const w = s.createWorld({ name: 'A' });
  const e = s.createEntity(w.worldId, {
    type: 'person', name: '윤서하',
    fields: { gender: ' 여 ', age: '', affiliation: '도서부\n  2학년', personality: '  조용함\n고집 셈  ' },
    extra: [{ label: '좋아하는 것', value: '비' }, { label: '', value: '' }],
  });
  assert.deepEqual(e.fields, { gender: '여', affiliation: '도서부 2학년', personality: '조용함\n고집 셈' });
  assert.deepEqual(e.extra, [{ label: '좋아하는 것', value: '비' }]);
  assert.throws(() => s.createEntity(w.worldId, { type: 'place', name: 'x', fields: { gender: '여' } }), status(400));
  assert.throws(() => s.createEntity(w.worldId, { type: 'person', name: 'x', fields: { age: 5 } }), status(400));
  assert.throws(() => s.createEntity(w.worldId, { type: 'person', name: 'x', extra: [{ label: '', value: '값만' }] }), status(400));
  assert.throws(() => s.createEntity(w.worldId, { type: 'person', name: 'x', fields: { appearance: 'ㄱ'.repeat(2001) } }), status(400));
  const g = s.updateEntity(w.worldId, e.entityId, { type: 'group', revision: 1 });
  assert.deepEqual(g.fields, {}, 'person fields do not fit a group');
  const p = s.updateEntity(w.worldId, e.entityId, { fields: { kind: '동아리' }, revision: 2 });
  assert.deepEqual(p.fields, { kind: '동아리' });
});

test('settings saved before fields existed still read and update', (t) => {
  const s = temp(t);
  const w = s.createWorld({ name: 'A' });
  const e = s.createEntity(w.worldId, { type: 'person', name: '옛 인물', description: '메모만' });
  const raw = JSON.parse(fs.readFileSync(s.entityFile(w.worldId), 'utf8'));
  delete raw.entities[0].fields;
  delete raw.entities[0].extra;
  fs.writeFileSync(s.entityFile(w.worldId), JSON.stringify(raw));
  const [old] = s.listEntities(w.worldId);
  assert.deepEqual(old.fields, {});
  assert.deepEqual(old.extra, []);
  assert.equal(s.updateEntity(w.worldId, e.entityId, { fields: { gender: '남' }, revision: 1 }).fields.gender, '남');
});

test('rooms: link, relink, unlink, branch inheritance', (t) => {
  const s = temp(t);
  const a = s.createWorld({ name: 'A' });
  const b = s.createWorld({ name: 'B' });
  assert.equal(s.getRoom('r1').worldId, null);
  s.linkRoom('r1', a.worldId);
  s.linkRoom('r1', b.worldId);
  assert.equal(s.roomWorldId('r1'), b.worldId);
  assert.equal(s.inheritRoom('r1', 'r2'), true);
  assert.equal(s.roomWorldId('r2'), b.worldId);
  s.linkRoom('r3', a.worldId);
  assert.equal(s.inheritRoom('r1', 'r3'), false, 'an existing link is never replaced');
  assert.equal(s.roomWorldId('r3'), a.worldId);
  s.linkRoom('r1', null);
  assert.equal(s.roomWorldId('r1'), null);
  assert.throws(() => s.linkRoom('../x', a.worldId), status(400));
  assert.throws(() => s.linkRoom('r9', '00000000-0000-4000-8000-000000000000'), status(404));
  assert.equal(s.roomWorldId('../../etc'), null);
});

test('deleting a world keeps a copy in trash and unlinks its rooms', (t) => {
  const s = temp(t);
  const w = s.createWorld({ name: '지울 세계' });
  s.createEntity(w.worldId, { type: 'place', name: '옥상 정원' });
  s.linkRoom('r1', w.worldId);
  const out = s.deleteWorld(w.worldId, 1);
  assert.equal(out.unlinkedRooms, 1);
  assert.equal(s.roomWorldId('r1'), null);
  assert.equal(fs.existsSync(s.entityFile(w.worldId)), false);
  const [bin] = fs.readdirSync(s.trashDir);
  const saved = JSON.parse(fs.readFileSync(path.join(s.trashDir, bin, 'world.json'), 'utf8'));
  assert.equal(saved.world.name, '지울 세계');
  assert.equal(saved.entities[0].name, '옥상 정원');
  assert.deepEqual(saved.rooms, ['r1']);
});

test('broken or newer files are never overwritten', (t) => {
  const s = temp(t);
  const w = s.createWorld({ name: 'Safe' });
  fs.writeFileSync(s.worldsFile, '{broken json', 'utf8');
  assert.throws(() => s.createWorld({ name: 'x' }), status(409));
  assert.equal(fs.readFileSync(s.worldsFile, 'utf8'), '{broken json');
  fs.writeFileSync(s.worldsFile, '{"schemaVersion":99,"worlds":[]}', 'utf8');
  assert.throws(() => s.createWorld({ name: 'x' }), status(409));
  assert.match(fs.readFileSync(s.worldsFile, 'utf8'), /99/);

  const s2 = temp(t);
  const w2 = s2.createWorld({ name: 'B' });
  fs.mkdirSync(s2.entityDir, { recursive: true });
  fs.writeFileSync(s2.entityFile(w2.worldId), '{"schemaVersion":1,"worldId":"other","entities":[]}');
  assert.throws(() => s2.createEntity(w2.worldId, { type: 'person', name: 'x' }), status(409));
  assert.throws(() => s2.deleteWorld(w2.worldId, 1), status(409), 'a world whose settings cannot be read is not deleted');
  assert.equal(s2.listWorlds().length, 1);
  void w;
});

test('no temporary files are left behind', (t) => {
  const s = temp(t);
  const w = s.createWorld({ name: 'A' });
  s.createEntity(w.worldId, { type: 'rule', name: '통금', description: '밤 10시' });
  s.linkRoom('r1', w.worldId);
  const all = [...fs.readdirSync(s.dir), ...fs.readdirSync(s.entityDir)];
  assert.equal(all.filter((f) => f.endsWith('.tmp')).length, 0);
});

test('auto: creates, fills empty fields, replaces its own, never touches hand-written ones', (t) => {
  const s = temp(t);
  const w = s.createWorld({ name: 'A' });
  assert.deepEqual(s.getWorld(w.worldId).auto, { enabled: false, connectionId: null, every: 6 });
  const hand = s.createEntity(w.worldId, { type: 'person', name: '한여름', fields: { gender: '여' } });
  assert.deepEqual(hand.sources, { gender: 'manual' });

  const c1 = s.applyAuto(w.worldId, [
    { type: 'person', name: '한여름', aliases: ['반장'], fields: { gender: '남', age: '17세' }, evidence: '반장은 열일곱이었다' },
    { type: 'place', name: '옥상 정원', fields: { location: '본관 5층 위' }, memo: '열쇠는 사감실', evidence: '옥상 정원' },
    { type: 'dragon', name: 'x' },
    { type: 'person', name: '   ' },
  ], { roomId: 'r1', messageIds: ['m1'] });
  assert.deepEqual(c1.map((c) => c.action).sort(), ['alias', 'create', 'field']);
  const [p] = s.listEntities(w.worldId).filter((e) => e.name === '한여름');
  assert.equal(p.fields.gender, '여', 'hand-written field stays');
  assert.equal(p.fields.age, '17세');
  assert.deepEqual(p.aliases, ['반장']);
  assert.deepEqual(p.sources, { gender: 'manual', age: 'auto' });
  const place = s.listEntities(w.worldId).find((e) => e.name === '옥상 정원');
  assert.equal(place.provenance.source, 'auto');
  assert.equal(place.description, '열쇠는 사감실');

  const c2 = s.applyAuto(w.worldId, [{ type: 'person', name: '여름', match: '한여름', fields: { age: '18세' } }]);
  assert.equal(c2.length, 2, 'own field replaced, 여름 added as another name');
  assert.equal(s.listEntities(w.worldId).find((e) => e.name === '한여름').fields.age, '18세');

  // the person edits age by hand: from now on it is theirs
  const cur = s.listEntities(w.worldId).find((e) => e.name === '한여름');
  s.updateEntity(w.worldId, cur.entityId, { fields: { ...cur.fields, age: '열여덟' }, revision: cur.revision });
  assert.equal(s.applyAuto(w.worldId, [{ type: 'person', name: '한여름', fields: { age: '19세' } }]).length, 0);

  const hist = s.listHistory(w.worldId);
  assert.equal(hist[0].roomId, null);
  assert.equal(hist.at(-1).roomId, 'r1');
});

test('auto: undo one change at a time, only while it is still there', (t) => {
  const s = temp(t);
  const w = s.createWorld({ name: 'A' });
  const [create] = s.applyAuto(w.worldId, [{ type: 'group', name: '천문부', fields: { kind: '동아리' } }]);
  const [field] = s.applyAuto(w.worldId, [{ type: 'group', name: '천문부', fields: { members: '네 명' } }]);
  assert.equal(s.undoChange(w.worldId, field.id).undone, true);
  assert.equal(s.listEntities(w.worldId)[0].fields.members, undefined);
  assert.throws(() => s.undoChange(w.worldId, field.id), status(409), 'twice');
  const [again] = s.applyAuto(w.worldId, [{ type: 'group', name: '천문부', fields: { members: '다섯 명' } }]);
  s.applyAuto(w.worldId, [{ type: 'group', name: '천문부', fields: { members: '여섯 명' } }]);
  assert.throws(() => s.undoChange(w.worldId, again.id), status(409), 'changed again since');
  const e = s.listEntities(w.worldId)[0];
  s.updateEntity(w.worldId, e.entityId, { description: '직접 쓴 메모', revision: e.revision });
  assert.throws(() => s.undoChange(w.worldId, create.id), status(409), 'hand-edited setting is not removed');
});

test('auto: undoing a creation waits until what was read into it later is undone', (t) => {
  const s = temp(t);
  const w = s.createWorld({ name: 'A' });
  const [create] = s.applyAuto(w.worldId, [{ type: 'person', name: '수위', fields: { affiliation: '등대' } }]);
  const later = s.applyAuto(w.worldId, [{ type: 'person', name: '수위', aliases: ['등대지기'], fields: { state: '다리를 다침' } }]);
  assert.equal(later.length, 2);
  assert.throws(() => s.undoChange(w.worldId, create.id), (e) => e.status === 409 && /그 뒤 자동으로 2번 바뀌었어요/.test(e.message));
  assert.equal(s.listEntities(w.worldId).length, 1, 'nothing removed');
  for (const c of later) s.undoChange(w.worldId, c.id);
  assert.equal(s.undoChange(w.worldId, create.id).undone, true, 'newest first, then the creation');
  assert.equal(s.listEntities(w.worldId).length, 0);
});

test('auto: a field change is recorded with that field\'s own evidence when there is one', (t) => {
  const s = temp(t);
  const w = s.createWorld({ name: 'A' });
  const [c] = s.applyAuto(w.worldId, [{ type: 'person', name: '사자', fields: { age: '노인' }, fieldEvidence: { age: '늙은 생선 장수였다.' }, evidence: '사자가 웃었다.' }]);
  assert.equal(c.evidence, '사자가 웃었다.', 'a creation keeps the item evidence');
  const [f] = s.applyAuto(w.worldId, [{ type: 'person', name: '사자', fields: { gender: '남성' }, fieldEvidence: { gender: '그는 고개를 들었다.' }, evidence: '다른 문장.' }]);
  assert.equal(f.evidence, '그는 고개를 들었다.');
});

test('auto settings and read progress', (t) => {
  const s = temp(t);
  const w = s.createWorld({ name: 'A' });
  const u = s.updateWorld(w.worldId, { auto: { enabled: true, connectionId: 'conn_1' }, revision: 1 });
  assert.deepEqual(u.auto, { enabled: true, connectionId: 'conn_1', every: 6 });
  assert.throws(() => s.updateWorld(w.worldId, { auto: { every: 1 }, revision: 2 }), status(400));
  assert.throws(() => s.updateWorld(w.worldId, { auto: { connectionId: '../x' }, revision: 2 }), status(400));
  s.linkRoom('r1', w.worldId);
  s.setRoomRead('r1', { lastId: 'm9', count: 9 });
  s.linkRoom('r1', w.worldId);
  assert.equal(s.getRoom('r1').read.count, 9, 'relinking the same world keeps progress');
  s.inheritRoom('r1', 'r2');
  assert.deepEqual([s.getRoom('r2').read.lastId, s.getRoom('r2').read.count], [null, 9]);
  const w2 = s.createWorld({ name: 'B' });
  s.linkRoom('r1', w2.worldId);
  assert.equal(s.getRoom('r1').read, null, 'another world starts from the beginning');
  s.setRoomRead('r1', { lastId: 'm3', count: 3 });
  s.setRoomRead('r1', null);
  assert.equal(s.getRoom('r1').read, null, '「처음부터 다시 읽기」 forgets the place');
  assert.equal(s.getRoom('r1').worldId, w2.worldId, 'and keeps the link');
});

test('injectMode: all by default, scene on request, anything else refused; old worlds read as all', (t) => {
  const s = temp(t);
  const a = s.createWorld({ name: 'A' });
  assert.equal(a.injectMode, 'all');
  assert.equal(s.createWorld({ name: 'B', injectMode: 'scene' }).injectMode, 'scene');
  assert.throws(() => s.createWorld({ name: 'C', injectMode: 'some' }), status(400));
  assert.throws(() => s.createWorld({ name: 'C', injectMode: null }), status(400));
  assert.equal(s.listWorlds().length, 2, 'a refused world is not saved');
  assert.equal(s.updateWorld(a.worldId, { injectMode: 'scene', revision: 1 }).injectMode, 'scene');
  assert.throws(() => s.updateWorld(a.worldId, { injectMode: 'SCENE', revision: 2 }), status(400));
  assert.equal(s.getWorld(a.worldId).injectMode, 'scene');
  const raw = JSON.parse(fs.readFileSync(s.worldsFile, 'utf8'));
  for (const w of raw.worlds) delete w.injectMode;
  fs.writeFileSync(s.worldsFile, JSON.stringify(raw));
  assert.deepEqual(s.listWorlds().map((w) => w.injectMode), ['all', 'all']);
  assert.equal(s.updateWorld(a.worldId, { name: 'A2', revision: 2 }).injectMode, 'all', 'an old world updates without the field');
  raw.worlds[0].injectMode = 'other';
  fs.writeFileSync(s.worldsFile, JSON.stringify(raw));
  assert.throws(() => s.listWorlds(), status(409), 'an unknown mode in the file is not guessed at');
});

test('auto: history records who wrote a change (reader by default, a module by name)', (t) => {
  const s = temp(t);
  const w = s.createWorld({ name: 'A' });
  const [a] = s.applyAuto(w.worldId, [{ type: 'place', name: '도서관' }]);
  assert.equal(a.by, 'reader');
  const [b] = s.applyAuto(w.worldId, [{ type: 'place', name: '도서관', fields: { use: '책' } }], { by: 'memory-module' });
  assert.equal(b.by, 'memory-module');
  const [c] = s.applyAuto(w.worldId, [{ type: 'place', name: '강당' }], { by: '../Bad Name' });
  assert.equal(c.by, 'reader', 'a name that is not a plain id falls back to reader');
  assert.equal(s.listEntities(w.worldId).find((e) => e.name === '도서관').provenance.by, 'reader');
});
