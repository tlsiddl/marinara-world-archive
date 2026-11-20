'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Archive, ArchiveError, TYPES, FIELDS } = require('../world-archive/lib/store.cjs');

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

test('history and system kinds: their own fields, validated like the rest; rule keeps only its category', (t) => {
  const s = temp(t);
  assert.deepEqual(TYPES, ['person', 'place', 'group', 'rule', 'system', 'schedule', 'history', 'custom']);
  assert.deepEqual(FIELDS.history.map((f) => [f.key, f.kind]), [['when', 'line'], ['where', 'line'], ['who', 'line'], ['result', 'text']]);
  assert.deepEqual(FIELDS.system.map((f) => [f.key, f.kind]), [['category', 'line'], ['how', 'text'], ['limits', 'text']]);
  assert.deepEqual(FIELDS.rule.map((f) => f.key), ['category']);
  assert.doesNotMatch(FIELDS.rule[0].hint, /능력|점수|세계 법칙/, 'abilities and points are systems now');
  const w = s.createWorld({ name: 'A' });
  const h = s.createEntity(w.worldId, {
    type: 'history', name: '북부 전쟁',
    fields: { when: ' 100년 전 ', where: '북쪽 국경', who: '두 왕국', result: '  국경이 강으로 정해졌다\n휴전 조약  ' },
  });
  assert.deepEqual(h.fields, { when: '100년 전', where: '북쪽 국경', who: '두 왕국', result: '국경이 강으로 정해졌다\n휴전 조약' });
  const m = s.createEntity(w.worldId, { type: 'system', name: '마법', fields: { category: '마법', how: '지팡이로 힘을 모은다', limits: '쓰면 지친다' } });
  assert.equal(m.fields.how, '지팡이로 힘을 모은다');
  assert.throws(() => s.createEntity(w.worldId, { type: 'history', name: 'x', fields: { category: '전쟁' } }), status(400));
  assert.throws(() => s.createEntity(w.worldId, { type: 'system', name: 'x', fields: { result: '결과' } }), status(400));
  assert.throws(() => s.createEntity(w.worldId, { type: 'system', name: 'x', fields: { how: 'ㄱ'.repeat(2001) } }), status(400));
  assert.throws(() => s.createEntity(w.worldId, { type: 'history', name: 'x', fields: { when: 100 } }), status(400));
  const r = s.updateEntity(w.worldId, m.entityId, { type: 'rule', revision: 1 });
  assert.deepEqual(r.fields, { category: '마법' }, 'system → rule keeps only the shared category');
  const sc = s.updateEntity(w.worldId, h.entityId, { type: 'schedule', revision: 1 });
  assert.deepEqual(sc.fields, { when: '100년 전', where: '북쪽 국경', who: '두 왕국' });
  const back = new Archive(s.dir);
  assert.deepEqual(back.listEntities(w.worldId).map((e) => e.type).sort(), ['rule', 'schedule']);
  const k = s.createEntity(w.worldId, { type: 'system', name: '기숙사 점수' });
  assert.equal(new Archive(s.dir).listEntities(w.worldId).find((e) => e.entityId === k.entityId).type, 'system', 'new kinds survive a restart');
  assert.deepEqual(s.countEntities(w.worldId), { person: 0, place: 0, group: 0, rule: 1, system: 1, schedule: 1, history: 0, custom: 0 });
});

test('a settings file written before history and system existed still loads and counts', (t) => {
  const s = temp(t);
  const w = s.createWorld({ name: 'A' });
  const a = s.createEntity(w.worldId, { type: 'rule', name: '통금', fields: { category: '능력 체계' } });
  s.createEntity(w.worldId, { type: 'custom', name: '별자리 점' });
  const raw = JSON.parse(fs.readFileSync(s.entityFile(w.worldId), 'utf8'));
  fs.writeFileSync(s.entityFile(w.worldId), JSON.stringify(raw)); // the old shape: only the six old kinds
  const again = new Archive(s.dir);
  assert.deepEqual(again.listEntities(w.worldId).map((e) => [e.type, e.name]), [['rule', '통금'], ['custom', '별자리 점']]);
  assert.equal(again.listEntities(w.worldId)[0].fields.category, '능력 체계', 'old rules stay rules: nothing is moved');
  assert.deepEqual(again.countEntities(w.worldId), { person: 0, place: 0, group: 0, rule: 1, system: 0, schedule: 0, history: 0, custom: 1 });
  assert.equal(again.updateEntity(w.worldId, a.entityId, { description: '밤 10시', revision: 1 }).revision, 2);
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
    // v0.6.2 ⑤: a lone role word (「반장」) is not an other name any more — 「여름이」 is
    { type: 'person', name: '한여름', aliases: ['반장', '여름이'], fields: { gender: '남', age: '17세' }, evidence: '반장은 열일곱이었다' },
    { type: 'place', name: '옥상 정원', fields: { location: '본관 5층 위' }, memo: '열쇠는 사감실', evidence: '옥상 정원' },
    { type: 'dragon', name: 'x' },
    { type: 'person', name: '   ' },
  ], { roomId: 'r1', messageIds: ['m1'] });
  assert.deepEqual(c1.map((c) => c.action).sort(), ['alias', 'create', 'field']);
  const [p] = s.listEntities(w.worldId).filter((e) => e.name === '한여름');
  assert.equal(p.fields.gender, '여', 'hand-written field stays');
  assert.equal(p.fields.age, '17세');
  assert.deepEqual(p.aliases, ['여름이']);
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
  assert.equal(hist.filter((c) => c.by !== 'person').at(-1).roomId, 'r1');
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

// ---------------------------------------------------------------- 같은 사람일 수 있음

const SAME = require('../world-archive/lib/same.cjs');
const G = require('../world-archive/lib/vendor/glossary.cjs');
const P = (name, aliases = []) => ({ entityId: name, type: 'person', name, aliases, fields: {}, description: '', createdAt: '' });

test('same person: names, other names and titles; a shared surname alone is not enough', () => {
  const yes = [
    [P('세베루스 스네이프'), P('스네이프', ['Professor Snape'])],
    [P('젬마 페얼리', ['prefect']), P('젬마')],
    [P('젬마 페얼리', ['prefect']), P('슬리데린 5학년 반장', ['prefect'])],
    [P('스네이프 교수'), P('스네이프교수님')],
    [P('Mr. Filch'), P('Argus Filch')],
    [P('마담 폼프리'), P('포피 폼프리')],
    [P('해리 포터'), P('해리 제임스 포터')],
    [P('지은'), P('박지은')],
    [P('세베루스스네이프'), P('세베루스 스네이프')],
  ];
  for (const [a, b] of yes) assert.ok(SAME.whySame(a, b), `${a.name} · ${b.name}`);
  assert.equal(SAME.whySame(P('세베루스 스네이프'), P('스네이프')), '「스네이프」 · 「세베루스 스네이프」의 일부');
  assert.equal(SAME.whySame(P('젬마 페얼리', ['prefect']), P('슬리데린 5학년 반장', ['prefect'])), '같은 이름 「prefect」');
  const no = [
    [P('캐서린 베인'), P('줄리안 베인')],
    [P('캐서린 베인'), P('베인 공작')],
    [P('줄리안 베인'), P('베인 공작')],
    [P('해리'), P('해리엇')],
    [P('민경'), P('민')],
    [P('젬마'), P('슬리데린 5학년 반장', ['prefect'])],
    [P('A', ['교수']), P('B', ['Professor'])], // nothing but a title is no name
  ];
  for (const [a, b] of no) assert.equal(SAME.whySame(a, b), null, `${a.name} · ${b.name}`);
  assert.deepEqual(SAME.words('Professor Snape'), ['snape']);
  assert.deepEqual(SAME.words('스네이프 교수님'), ['스네이프']);
});

test('same person: the Harry Potter room — exactly the three pairs, family members left alone', (t) => {
  const s = temp(t);
  const w = s.createWorld({ name: '호그와트' });
  const id = {};
  for (const [name, aliases] of [
    ['세베루스 스네이프', []], ['스네이프', ['Professor Snape']],
    ['젬마 페얼리', ['prefect']], ['젬마', []], ['슬리데린 5학년 반장', ['prefect']],
    ['캐서린 베인', []], ['줄리안 베인', []], ['베인 공작', []],
  ]) id[name] = s.createEntity(w.worldId, { type: 'person', name, aliases }).entityId;
  s.createEntity(w.worldId, { type: 'place', name: '스네이프' }); // only people are compared
  const name = Object.fromEntries(Object.entries(id).map(([k, v]) => [v, k]));
  const got = s.listDuplicates(w.worldId).map((p) => [name[p.a], name[p.b]].sort().join(' · ')).sort();
  assert.deepEqual(got, ['세베루스 스네이프 · 스네이프', '슬리데린 5학년 반장 · 젬마 페얼리', '젬마 · 젬마 페얼리']);
  for (const p of s.listDuplicates(w.worldId)) assert.equal(typeof p.why, 'string');
});

test('same person: different family names are two people, even with a shared other name; whole words only', () => {
  const no = [
    [P('줄리안 에이버리', ['Julian']), P('줄리안 베인', ['Julian'])],
    [P('바너비 파이', ['Barnaby']), P('바너비 윌크스', ['Barnaby'])],
    [P('Julian Avery', ['Julian']), P('Julian Bane', ['Julian'])],
    [P('줄리안 에이버리', ['줄리안']), P('줄리안 베인', ['줄리안'])],
    [P('공작'), P('공작부인')],
    [P('공작'), P('베인 공작부인')],
    [P('베인 공작'), P('베인 공작부인')],
  ];
  for (const [a, b] of no) assert.equal(SAME.whySame(a, b), null, `${a.name} · ${b.name}`);
  const yes = [
    [P('스네이프'), P('세베루스 스네이프')],
    [P('젬마'), P('젬마 페얼리')],
    [P('줄리안 에이버리', ['Julian Avery']), P('Julian Avery')], // one family name in Latin letters on both
    [P('젬마 페럴리', ['Gemma Farley']), P('젬마 페얼리', ['Gemma Farley'])], // two spellings of one name
    [P('스네이프부인'), P('스네이프')], // a title written onto a name is still taken off
  ];
  for (const [a, b] of yes) assert.ok(SAME.whySame(a, b), `${a.name} · ${b.name}`);
  assert.deepEqual(SAME.words('공작부인'), ['공작부인']);
});

test('same person: a family with full names is never paired through a one-word other name or the family name', (t) => {
  const edward = P('에드워드 베인', ['Edward Vane', 'Vane', 'Duke', 'His Grace', '공작']);
  const no = [
    [edward, P('캐서린 베인', ['Catherine Vane', 'Vane', 'Duchess'])], // a shared one-word other name
    [edward, P('줄리언 베인', ['Julian Vane', 'Duke', 'His Grace'])], // a shared title, a way of addressing
    [edward, P('클라라 베인', ['Clara Vane', '베인'])], // the family name alone, a whole word of the other's name
    [P('에드워드 베인'), P('줄리언 베인', ['베인', 'Vane'])],
    [P('다프네의 언니'), P('다프네의 누나')], // as before
    [P('다프네의 언니', ['언니']), P('다프네의 누나', ['언니'])],
  ];
  for (const [a, b] of no) assert.equal(SAME.whySame(a, b), null, `${a.name} · ${b.name}`);
  const yes = [
    [P('에드워드 베인'), P('에드워드 앨버트 베인')], // the given names match too
    [P('에드워드 베인', ['Edward Vane']), P('에드워드 바인', ['Edward Vane'])], // a whole name of several words
    [edward, P('베인', ['Vane'])], // one of them has only a one-word name
    [P('스네이프'), P('세베루스 스네이프')],
    [P('젬마'), P('젬마 페얼리')],
    [P('젬마 페얼리', ['prefect']), P('슬리데린 5학년 반장', ['prefect'])], // a role is not a given and a family name
  ];
  for (const [a, b] of yes) assert.ok(SAME.whySame(a, b), `${a.name} · ${b.name}`);

  const s = temp(t);
  const w = s.createWorld({ name: '호그와트' });
  const id = {};
  for (const [name, aliases] of [
    ['에드워드 베인', ['Edward Vane', 'Vane', 'Duke', 'His Grace']], ['캐서린 베인', ['Catherine Vane', 'Vane']],
    ['줄리언 베인', ['Julian Vane', 'Vane', 'His Grace']], ['클라라 베인', ['Clara Vane', '베인', 'Vane']],
    ['세베루스 스네이프', []], ['스네이프', ['Professor Snape']], ['젬마 페얼리', []], ['젬마', []],
  ]) id[name] = s.createEntity(w.worldId, { type: 'person', name, aliases }).entityId;
  const name = Object.fromEntries(Object.entries(id).map(([k, v]) => [v, k]));
  const got = s.listDuplicates(w.worldId).map((p) => [name[p.a], name[p.b]].sort().join(' · ')).sort();
  assert.deepEqual(got, ['세베루스 스네이프 · 스네이프', '젬마 · 젬마 페얼리']);
});

// ---------------------------------------------------------------- names from the translation glossary

test('glossary names: renamed with the original kept, places too, a hand-typed name only gets a suggestion', (t) => {
  const s = temp(t);
  const w = s.createWorld({ name: '호그와트' });
  s.applyAuto(w.worldId, [
    { type: 'person', name: '마가렛', aliases: ['Margaret', '마거릿 '] },
    { type: 'place', name: 'Hogwarts' },
    { type: 'person', name: '스네이프' },
    { type: 'person', name: 'Severus Snape' },
  ]);
  const hand = s.createEntity(w.worldId, { type: 'person', name: '젬마 페럴리', aliases: ['Gemma Farley'] });
  const pairs = [
    { from: 'Margaret', to: '마거릿' }, { from: 'Hogwarts', to: '호그와트' },
    { from: 'Severus Snape', to: '세베루스 스네이프' }, { from: 'Gemma Farley', to: '젬마 페얼리' },
  ];
  const changes = s.alignGlossary(w.worldId, pairs, { roomId: 'room' });
  const by = (n) => s.listEntities(w.worldId).find((e) => e.name === n);
  assert.deepEqual(by('마거릿').aliases, ['Margaret', '마가렛'], 'the glossary form leaves the other names, the old name joins them');
  assert.deepEqual(by('호그와트').aliases, ['Hogwarts']);
  assert.deepEqual(by('세베루스 스네이프').aliases, ['Severus Snape']);
  assert.ok(by('스네이프'), 'a surname alone stays as it is');
  const g = s.listEntities(w.worldId).find((e) => e.entityId === hand.entityId);
  assert.deepEqual([g.name, g.glossaryName], ['젬마 페럴리', '젬마 페얼리']);
  assert.deepEqual(changes.map((c) => c.action), ['rename', 'rename', 'rename']);
  assert.ok(changes.every((c) => c.by === 'glossary' && c.roomId === 'room' && /^번역 단어장: /.test(c.evidence)));
  assert.deepEqual(s.alignGlossary(w.worldId, pairs, {}), [], 'twice: nothing');
  const [h] = s.listHistory(w.worldId);
  assert.equal(h.action, 'rename');

  // another setting already has the glossary's name: both stay (the same-person list shows them)
  const w2 = s.createWorld({ name: 'B' });
  s.createEntity(w2.worldId, { type: 'person', name: '세베루스 스네이프' });
  s.applyAuto(w2.worldId, [{ type: 'person', name: '스네이프', aliases: ['Severus Snape'] }]);
  assert.deepEqual(s.alignGlossary(w2.worldId, pairs, {}).map((c) => [c.action, c.name, c.after]), [['alias', '세베루스 스네이프', 'Severus Snape']],
    'the one already named so only gains the original form');
  assert.deepEqual(s.listEntities(w2.worldId).map((e) => e.name), ['세베루스 스네이프', '스네이프']);
  assert.equal(s.listDuplicates(w2.worldId).length, 1);
  // only the settings asked for
  const w3 = s.createWorld({ name: 'C' });
  const [a, b] = s.applyAuto(w3.worldId, [{ type: 'person', name: 'Margaret' }, { type: 'place', name: 'Hogwarts' }]);
  assert.deepEqual(s.alignGlossary(w3.worldId, pairs, { ids: [b.entityId] }).map((c) => c.entityId), [b.entityId]);
  assert.equal(s.listEntities(w3.worldId).find((e) => e.entityId === a.entityId).name, 'Margaret');
});

test('glossary names: undo a rename; a name typed by hand stays the person\'s through other edits and merges', (t) => {
  const s = temp(t);
  const w = s.createWorld({ name: '호그와트' });
  const [c] = s.applyAuto(w.worldId, [{ type: 'person', name: 'Margaret', fields: { age: '17세' } }]);
  const pairs = [{ from: 'Margaret', to: '마거릿' }];
  const [r] = s.alignGlossary(w.worldId, pairs, {});
  let e = s.listEntities(w.worldId)[0];
  assert.deepEqual([e.name, e.aliases, e.revision], ['마거릿', ['Margaret'], 2]);
  // renamed again by the person after the glossary: the glossary's rename is not undone over it
  const typed = s.updateEntity(w.worldId, e.entityId, { name: '메기', revision: e.revision });
  assert.equal(typed.sources.name, 'manual');
  assert.throws(() => s.undoChange(w.worldId, r.id), status(409));
  const again = s.updateEntity(w.worldId, e.entityId, { name: '마거릿', revision: typed.revision });
  assert.equal(s.undoChange(w.worldId, r.id).undone, true);
  e = s.listEntities(w.worldId)[0];
  assert.deepEqual([e.name, e.aliases], ['Margaret', []]);
  assert.ok(e.revision > again.revision);
  // a field edit keeps the name the person's
  const f = s.updateEntity(w.worldId, e.entityId, { name: 'Maggie', revision: e.revision });
  const g = s.updateEntity(w.worldId, e.entityId, { fields: { age: '18세' }, revision: f.revision });
  assert.equal(g.sources.name, 'manual');
  assert.deepEqual(s.alignGlossary(w.worldId, [{ from: 'Maggie', to: '매기' }], {}), []);
  assert.equal(s.listEntities(w.worldId)[0].glossaryName, '매기');
  // merged into another: the kept one's name stays the person's
  const other = s.createEntity(w.worldId, { type: 'person', name: '매기 벨' });
  const cur = s.listEntities(w.worldId).find((x) => x.entityId === e.entityId);
  const m = s.mergeEntities(w.worldId, { keepId: cur.entityId, dropId: other.entityId, keepRevision: cur.revision, dropRevision: other.revision });
  assert.equal(m.sources.name, 'manual');
  void c;
});

test('glossary names: only a pair that is the whole name renames; parts and related terms never do', (t) => {
  const s = temp(t);
  const pairs = G.parseGlossary([
    'Irina = 이리나', 'Irina Vane = 이리나 베인', 'Gaspard = 가스파르', 'Fleet = 플릿', 'Slytherin = 슬리데린',
    'Hufflepuff = 후플푸프', 'Sorting Hat = 기숙사 배정 모자', 'Bea = 비아', 'Potions = 마법약', 'Hogwarts = 호그와트',
  ].join('\n'));
  // three worlds, so that settings sharing an other name are not read into one
  const [w, w2, w3] = ['호그와트', 'B', 'C'].map((name) => s.createWorld({ name }));
  // createEntity marks the name the person's; applyAuto stands for a reading
  const read = (world, type, name, aliases) => {
    const [c] = s.applyAuto(world.worldId, [{ type, name, aliases }]);
    assert.equal(c.action, 'create', name);
    return c.entityId;
  };
  const id = {
    gaspard: read(w, 'person', '가스파르 셀윈', ['Gaspard Selwyn', 'Gaspard']),
    gaspard2: read(w2, 'person', '가스파르 르블랑', ['Gaspard']), // the given name the only romanized name: still not the name
    fleet: read(w, 'person', '크리스핀 플리트', ['Crispin Fleet', 'Fleet']),
    fleet2: read(w2, 'person', '오스왈드 플리트', ['Fleet']),
    dungeon: read(w, 'place', '호그와트 지하 기숙사', ['Slytherin']),
    slytherin: s.createEntity(w.worldId, { type: 'group', name: '슬리데린', aliases: ['Slytherin'] }).entityId,
    huff: read(w, 'group', '후플푸프 기숙사', ['Hufflepuff']),
    sorting: read(w, 'history', '호그와트 기숙사 배정', ['Sorting Hat']),
    sorting2: read(w2, 'group', '호그와트 기숙사 배정식', ['Sorting Hat', 'Hogwarts Sorting Ceremony']),
    potions: read(w, 'schedule', '마법약 수업(금요일 아침)', ['Potions']),
    castle: read(w, 'place', '호그와트 성', ['Hogwarts']), // a one-word pair: an other name only
    castle2: read(w2, 'place', '호그와트성', ['Hogwarts']), // one word, the whole romanized name, but the Korean is a part: never shortened
    bea: read(w, 'person', '베아트리스 베인', ['Beatrice Vane', 'Bea']),
    irina: read(w, 'person', '이리나', ['Irina Vane']), // two pairs name it: the one with the most words
    hat: read(w3, 'person', 'Sorting Hat', []), // a romanized name that is the whole pair
  };
  const all = () => [w, w2, w3].flatMap((x) => s.listEntities(x.worldId));
  const before = Object.fromEntries(Object.entries(id).map(([k, v]) => [k, all().find((e) => e.entityId === v)]));
  const changes = [w, w2, w3].flatMap((x) => s.alignGlossary(x.worldId, pairs, { roomId: 'room' }));
  const by = (k) => all().find((e) => e.entityId === id[k]);
  for (const k of ['gaspard', 'gaspard2', 'fleet', 'fleet2', 'dungeon', 'slytherin', 'huff', 'sorting', 'sorting2', 'potions', 'castle', 'castle2', 'bea'])
    assert.equal(by(k).name, before[k].name, `${before[k].name} keeps its name`);
  assert.deepEqual(changes.filter((c) => c.action === 'rename').map((c) => [c.before, c.after]), [['이리나', '이리나 베인'], ['Sorting Hat', '기숙사 배정 모자']]);
  // one-word pairs of names of several words: other names only (never one that is another setting's name)
  assert.deepEqual(by('gaspard').aliases, ['Gaspard Selwyn', 'Gaspard', '가스파르']);
  assert.deepEqual(by('gaspard2').aliases, ['Gaspard', '가스파르']);
  assert.deepEqual(by('fleet').aliases, ['Crispin Fleet', 'Fleet', '플릿']);
  assert.deepEqual(by('bea').aliases, ['Beatrice Vane', 'Bea', '비아']);
  assert.deepEqual(by('dungeon').aliases, ['Slytherin'], '「슬리데린」 is another setting\'s name');
  assert.deepEqual(by('huff').aliases, ['Hufflepuff', '후플푸프']);
  for (const k of ['sorting', 'potions']) assert.deepEqual(by(k).aliases, before[k].aliases, `${before[k].type}: the glossary never names it`);
  assert.deepEqual(by('sorting2').aliases, before.sorting2.aliases);
  assert.deepEqual(by('castle').aliases, ['Hogwarts', '호그와트']);
  assert.deepEqual(by('castle2').aliases, ['Hogwarts']);
  assert.deepEqual(by('irina').aliases, ['Irina Vane', '이리나']);
  assert.ok(changes.filter((c) => c.action === 'alias').every((c) => c.by === 'glossary' && /^번역 단어장: /.test(c.evidence)));
  for (const x of [w, w2, w3]) assert.deepEqual(s.alignGlossary(x.worldId, pairs, {}), [], 'twice: nothing');
  // the rename is undone as before, and the alias too
  const rename = changes.find((c) => c.after === '이리나 베인');
  assert.equal(s.undoChange(w.worldId, rename.id).undone, true);
  assert.deepEqual([by('irina').name, by('irina').aliases, by('irina').glossaryName], ['이리나', ['Irina Vane'], '이리나 베인']);
  const alias = changes.find((c) => c.action === 'alias' && c.after === '플릿');
  assert.equal(s.undoChange(w.worldId, alias.id).undone, true);
  assert.deepEqual(by('fleet').aliases, ['Crispin Fleet', 'Fleet']);
});

function snapes(s) {
  const w = s.createWorld({ name: '호그와트' });
  const keep = s.createEntity(w.worldId, { type: 'person', name: '세베루스 스네이프', fields: { gender: '남성', affiliation: '슬리데린 기숙사장' }, description: '마법약 교수' });
  s.applyAuto(w.worldId, [{ type: 'person', name: '세베루스 스네이프', fields: { appearance: '검은 머리', personality: '냉정함' } }]);
  s.applyAuto(w.worldId, [{ type: 'person', name: '스네이프', aliases: ['Professor Snape'], fields: { affiliation: '호그와트', age: '38세', gender: '남' }, memo: '어둠의 마법 방어술 자리를 원함' }]);
  const d0 = s.listEntities(w.worldId).find((e) => e.name === '스네이프');
  s.updateEntity(w.worldId, d0.entityId, { fields: { affiliation: '호그와트', age: '38세', gender: '남자', personality: '사실은 다정함' }, extra: [{ label: '좋아하는 것', value: '마법약' }], revision: d0.revision });
  const all = s.listEntities(w.worldId);
  return { w, keep: all.find((e) => e.entityId === keep.entityId), drop: all.find((e) => e.entityId === d0.entityId) };
}
const mergeBody = (keep, drop, more = {}) => ({ keepId: keep.entityId, dropId: drop.entityId, keepRevision: keep.revision, dropRevision: drop.revision, ...more });

test('merge: names become other names, empty fields filled, hand-written fields of the kept one never replaced', (t) => {
  const s = temp(t);
  const { w, keep, drop } = snapes(s);
  assert.equal(keep.sources.appearance, 'auto');
  assert.equal(drop.sources.personality, 'manual');
  assert.equal(drop.sources.affiliation, 'auto');

  const files = () => [s.entityFile(w.worldId), s.historyFile(w.worldId)].map((f) => fs.readFileSync(f, 'utf8'));
  const before = files();
  const pv = s.mergeEntities(w.worldId, mergeBody(keep, drop, { preview: true }));
  assert.deepEqual(files(), before, 'a preview saves nothing');

  const m = s.mergeEntities(w.worldId, mergeBody(keep, drop));
  assert.deepEqual({ ...m, updatedAt: null }, { ...pv, updatedAt: null }, 'the preview is what the merge does');
  assert.equal(m.name, '세베루스 스네이프');
  assert.deepEqual(m.aliases, ['스네이프', 'Professor Snape']);
  assert.equal(m.fields.gender, '남성', 'hand-written on both: the kept one stays');
  assert.equal(m.fields.affiliation, '슬리데린 기숙사장', 'hand-written on the kept one: an automatic one does not replace it');
  assert.equal(m.fields.age, '38세', 'empty: filled');
  assert.equal(m.sources.age, 'auto', 'and still automatic');
  assert.equal(m.fields.appearance, '검은 머리');
  assert.equal(m.fields.personality, '사실은 다정함', 'hand-written on the dropped one wins over an automatic one');
  assert.equal(m.sources.personality, 'manual');
  assert.equal(m.description, '마법약 교수\n\n어둠의 마법 방어술 자리를 원함', 'a different memo is added below');
  assert.equal(m.sources.description, 'manual');
  assert.deepEqual(m.extra, [{ label: '좋아하는 것', value: '마법약' }]);
  assert.equal(m.revision, keep.revision + 1);
  assert.equal(m.provenance.merged[0].entityId, drop.entityId);
  const people = s.listEntities(w.worldId);
  assert.deepEqual(people.map((e) => e.name), ['세베루스 스네이프'], 'the dropped one is gone');
  const [h] = s.listHistory(w.worldId);
  assert.equal(h.action, 'merge');
  assert.equal(h.by, 'person');
  assert.equal(h.dropName, '스네이프');
  assert.equal(s.listDuplicates(w.worldId).length, 0);

  // later automatic reading never writes over what came from the person's side
  s.applyAuto(w.worldId, [{ type: 'person', name: '스네이프', fields: { personality: '음침함', age: '40세' } }]);
  const after = s.listEntities(w.worldId)[0];
  assert.equal(after.fields.personality, '사실은 다정함');
  assert.equal(after.fields.age, '40세', 'an automatic field stays automatic');
});

test('merge: refused for a stale revision, the same setting, different kinds; aliases stop at the limit', (t) => {
  const s = temp(t);
  const { w, keep, drop } = snapes(s);
  assert.throws(() => s.mergeEntities(w.worldId, mergeBody(keep, drop, { dropRevision: drop.revision - 1 })), status(409));
  assert.throws(() => s.mergeEntities(w.worldId, mergeBody(keep, keep)), status(400));
  assert.throws(() => s.mergeEntities(w.worldId, { keepId: keep.entityId, dropId: drop.entityId }), status(400));
  const place = s.createEntity(w.worldId, { type: 'place', name: '지하 감옥' });
  assert.throws(() => s.mergeEntities(w.worldId, mergeBody(keep, place)), status(400));
  const many = s.createEntity(w.worldId, { type: 'person', name: '많은 이름', aliases: Array.from({ length: 19 }, (_, i) => `이름${i}`) });
  const m = s.mergeEntities(w.worldId, mergeBody(many, drop));
  assert.equal(m.aliases.length, 20);
  assert.equal(m.aliases.at(-1), '스네이프');
});

test('merge: undo brings both back as they were, only while the kept one has not changed since', (t) => {
  const s = temp(t);
  const { w, keep, drop } = snapes(s);
  const strip = (e) => ({ ...e, revision: null, updatedAt: null });
  s.mergeEntities(w.worldId, mergeBody(keep, drop));
  const [h] = s.listHistory(w.worldId);
  assert.equal(s.undoChange(w.worldId, h.id).undone, true);
  const back = s.listEntities(w.worldId);
  assert.deepEqual(back.map((e) => e.entityId), [keep.entityId, drop.entityId], 'in their old places');
  assert.deepEqual(strip(back[0]), strip(keep), 'the kept one as it was');
  assert.equal(back[0].revision, keep.revision + 2, 'its revision moves on, never back');
  assert.deepEqual(back[1], drop, 'the dropped one exactly as it was');
  assert.throws(() => s.undoChange(w.worldId, h.id), status(409), 'twice');
  assert.equal(s.listDuplicates(w.worldId).length, 1, 'suggested again');

  // merged again, then the kept one is changed: the merge is not undone
  const now = s.listEntities(w.worldId);
  const m = s.mergeEntities(w.worldId, mergeBody(now[0], now[1]));
  s.updateEntity(w.worldId, m.entityId, { pinned: true, revision: m.revision });
  const h2 = s.listHistory(w.worldId).find((c) => c.action === 'merge');
  assert.equal(h2.action, 'merge');
  assert.throws(() => s.undoChange(w.worldId, h2.id), (e) => e.status === 409 && /합친 뒤에 다시 바뀌어서/.test(e.message));
  assert.equal(s.listEntities(w.worldId).length, 1, 'nothing changed');

  // an automatic change to the kept one after a merge also stops it
  const fresh = s.createEntity(w.worldId, { type: 'person', name: '젬마' });
  const gemma = s.createEntity(w.worldId, { type: 'person', name: '젬마 페얼리' });
  s.mergeEntities(w.worldId, mergeBody(gemma, fresh));
  const [h3] = s.listHistory(w.worldId);
  s.applyAuto(w.worldId, [{ type: 'person', name: '젬마 페얼리', fields: { age: '16세' } }]);
  assert.throws(() => s.undoChange(w.worldId, h3.id), status(409));
});

test('same person: 「다른 사람이에요」 keeps a pair from being suggested again, also after a restart', (t) => {
  const s = temp(t);
  const w = s.createWorld({ name: 'A' });
  const a = s.createEntity(w.worldId, { type: 'person', name: '젬마 페얼리', aliases: ['prefect'] });
  const b = s.createEntity(w.worldId, { type: 'person', name: '젬마' });
  const c = s.createEntity(w.worldId, { type: 'person', name: '슬리데린 5학년 반장', aliases: ['prefect'] });
  assert.equal(s.listDuplicates(w.worldId).length, 2);
  assert.deepEqual(s.dismissPair(w.worldId, c.entityId, a.entityId), { dismissed: true, a: c.entityId, b: a.entityId });
  s.dismissPair(w.worldId, a.entityId, c.entityId); // twice is the same
  const left = new Archive(s.dir).listDuplicates(w.worldId);
  assert.deepEqual(left.map((p) => [p.a, p.b].sort()), [[a.entityId, b.entityId].sort()]);
  assert.equal(JSON.parse(fs.readFileSync(s.dismissFile(w.worldId), 'utf8')).pairs.length, 1);
  assert.throws(() => s.dismissPair(w.worldId, a.entityId, a.entityId), status(400));
  assert.throws(() => s.dismissPair(w.worldId, a.entityId, '00000000-0000-4000-8000-000000000000'), status(404));
  assert.throws(() => s.dismissPair(w.worldId, a.entityId, 'x'), status(400));
});

test('할 일 5: what the person does by hand is recorded and can be undone — a new setting, an edit, a delete', (t) => {
  const s = temp(t);
  const w = s.createWorld({ name: 'A' });
  const e = s.createEntity(w.worldId, { type: 'person', name: '마르타', fields: { age: '50대' } });
  const u = s.updateEntity(w.worldId, e.entityId, { fields: { age: '60대', gender: '여' }, name: '마르타 그린', revision: e.revision });
  const [edit, create] = s.listHistory(w.worldId);
  assert.deepEqual([create.action, create.by, edit.action, edit.by], ['create', 'person', 'edit', 'person']);
  assert.deepEqual(edit.keys.sort(), ['age', 'gender', 'name']);
  s.undoChange(w.worldId, edit.id);
  const back = s.listEntities(w.worldId)[0];
  assert.deepEqual([back.name, back.fields.age, back.fields.gender, back.revision], ['마르타', '50대', undefined, u.revision + 1]);
  const again = s.updateEntity(w.worldId, back.entityId, { description: '사서', revision: back.revision });
  const e2 = s.listHistory(w.worldId)[0];
  s.updateEntity(w.worldId, back.entityId, { description: '사서장', revision: again.revision });
  assert.throws(() => s.undoChange(w.worldId, e2.id), status(409), 'changed again since');
  const cur = s.listEntities(w.worldId)[0];
  s.deleteEntity(w.worldId, cur.entityId, cur.revision);
  s.undoChange(w.worldId, s.listHistory(w.worldId)[0].id);
  assert.equal(s.listEntities(w.worldId)[0].description, '사서장', 'the delete is undone');
  const d2 = s.listEntities(w.worldId)[0];
  s.deleteEntity(w.worldId, d2.entityId, d2.revision);
  assert.equal(s.listEntities(w.worldId).length, 0);
  const s2 = s.createEntity(w.worldId, { type: 'place', name: '옥상' });
  s.undoChange(w.worldId, s.listHistory(w.worldId)[0].id);
  assert.equal(s.listEntities(w.worldId).some((x) => x.entityId === s2.entityId), false, 'a hand-made setting can be undone even though its fields are the person\'s');
});

test('할 일 10: a newer value replaces the old one, which stays as 「이전」; a hand-written field gets 「대화에서는 ○○」 and [적용]', (t) => {
  const s = temp(t);
  const w = s.createWorld({ name: '별빛 학원' });
  // 지어낸 인물: 신입생 하람 — 기숙사 미정 → 배정
  s.applyAuto(w.worldId, [{ type: 'person', name: '하람', fields: { affiliation: '기숙사 미정' } }]);
  const [c] = s.applyAuto(w.worldId, [{ type: 'person', name: '하람', fields: { affiliation: '은사슴 기숙사' }, fieldEvidence: { affiliation: '모자가 은사슴을 외쳤다.' } }]);
  let e = s.listEntities(w.worldId)[0];
  assert.equal(e.fields.affiliation, '은사슴 기숙사', 'the field holds the current value only');
  assert.deepEqual(e.past.affiliation.map((x) => x.value), ['기숙사 미정']);
  s.undoChange(w.worldId, c.id);
  e = s.listEntities(w.worldId)[0];
  assert.deepEqual([e.fields.affiliation, e.past?.affiliation], ['기숙사 미정', undefined], 'undo takes the 「이전」 entry back too');
  s.applyAuto(w.worldId, [{ type: 'person', name: '하람', fields: { affiliation: '은사슴 기숙사' } }]);
  for (let i = 1; i <= 4; i++) s.applyAuto(w.worldId, [{ type: 'person', name: '하람', fields: { affiliation: `${i}학년 반장` } }]);
  assert.equal(s.listEntities(w.worldId)[0].past.affiliation.length, 3, 'at most three earlier values');

  // the person writes the field: later readings only suggest
  e = s.listEntities(w.worldId)[0];
  s.updateEntity(w.worldId, e.entityId, { fields: { ...e.fields, affiliation: '학생회장' }, revision: e.revision });
  assert.deepEqual(s.applyAuto(w.worldId, [{ type: 'person', name: '하람', fields: { affiliation: '퇴학' } }]), []);
  e = s.listEntities(w.worldId)[0];
  assert.deepEqual([e.fields.affiliation, e.pending.affiliation.value], ['학생회장', '퇴학'], 'waits as 「대화에서는 퇴학이 됐어요」');
  const applied = s.applyPending(w.worldId, e.entityId, 'affiliation', e.revision);
  assert.deepEqual([applied.fields.affiliation, applied.sources.affiliation, applied.pending.affiliation, applied.past.affiliation[0].value], ['퇴학', 'auto', undefined, '학생회장']);
  const h = s.listHistory(w.worldId)[0];
  assert.deepEqual([h.action, h.by, h.before, h.after], ['field', 'person', '학생회장', '퇴학']);
  s.undoChange(w.worldId, h.id);
  assert.equal(s.listEntities(w.worldId)[0].fields.affiliation, '학생회장');

  // 무시: the suggestion goes, nothing else changes
  const m = s.listEntities(w.worldId)[0];
  s.updateEntity(w.worldId, m.entityId, { fields: { ...m.fields, affiliation: '학생회장' }, revision: m.revision });
  s.applyAuto(w.worldId, [{ type: 'person', name: '하람', fields: { affiliation: '휴학' } }]);
  const p = s.listEntities(w.worldId)[0];
  const d = s.applyPending(w.worldId, p.entityId, 'affiliation', p.revision, { discard: true });
  assert.deepEqual([d.fields.affiliation, d.pending.affiliation], ['학생회장', undefined]);
  assert.throws(() => s.applyPending(w.worldId, p.entityId, 'affiliation', d.revision), status(404));
});
