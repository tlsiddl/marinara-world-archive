'use strict';
// v0.5.1 T — the two last lines of {{세계}} (no new macro): 「[이미 있는 인물] … 외 N명」 and 「[균형] 반복 등장 인물 N명:
// 여 a · 남 b / …」, counted by code. Each can be turned off; they take their room right after the pinned ones. Made-up
// world only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Archive } = require('../world-archive/lib/store.cjs');
const X = require('../world-archive/lib/extract.cjs');
const I = require('../world-archive/lib/inject.cjs');
const service = require('../world-archive/lib/service.cjs');
const real = require('../world-archive/lib/vendor/engine.cjs');

const msg = (i, content, speaker = i % 2 ? '서하' : '나') => ({ id: `m${i}`, speaker, role: i % 2 ? 'assistant' : 'user', content });
let n = 0;
const person = (name, fields = {}, more = {}) => ({ entityId: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, type: 'person', name, aliases: [], description: '', fields, extra: [], status: 'confirmed', pinned: false, updatedAt: `2026-11-2${n % 10}T00:00:00Z`, ...more });

test('[이미 있는 인물]: the latest first, up to 600 letters, the rest 「외 N명」; off when turned off', () => {
  const many = Array.from({ length: 120 }, (_, i) => person(`인물${String(i).padStart(3, '0')}`, {}, { updatedAt: `2026-01-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z` }));
  const t = I.tailLines({ name: 'w' }, many, {});
  assert.ok(t.lines[0].startsWith('[이미 있는 인물] 인물119, 인물118'), 'the latest first');
  assert.ok(t.lines[0].length <= I.CAST_CHARS);
  const shown = t.lines[0].replace('[이미 있는 인물] ', '').replace(/ 외 \d+명$/, '').split(', ').length;
  assert.match(t.lines[0], new RegExp(` 외 ${120 - shown}명$`));
  assert.equal(I.tailLines({ name: 'w', tail: { cast: false } }, many, {}).lines.filter((l) => l.startsWith('[이미')).length, 0);
  assert.deepEqual(I.tailLines({ name: 'w' }, [], {}).lines, [], 'no people: no lines');
});

test('[균형]: only people who come back (two batches or pinned); 성별 by default (여 · 남 · 모름); a world\'s own 칸 from the 추가 칸', () => {
  const ps = [
    person('하윤', { gender: '여' }, { seen: { n: 3 } }),
    person('서윤', { gender: '여성' }, { seen: { n: 2 } }),
    person('도윤', { gender: '남자' }, { seen: { n: 2 }, extra: [{ label: '혈통 편견', value: '있음' }] }),
    person('노을', {}, { pinned: true, extra: [{ label: '혈통 편견', value: '없음' }] }),
    person('지나가던 사람', { gender: '남' }, { seen: { n: 1 } }),
  ];
  assert.equal(I.tailLines({ name: 'w' }, ps, {}).lines[1], '[균형] 반복 등장 인물 4명: 여 2 · 남 1 · 모름 1');
  assert.equal(I.tailLines({ name: 'w', balance: ['성별', '혈통 편견'] }, ps, {}).lines[1], '[균형] 반복 등장 인물 4명: 여 2 · 남 1 · 모름 1 / 혈통 편견: 있음 1 · 없음 1 · 모름 2');
  assert.equal(I.tailLines({ name: 'w', balance: ['소속'] }, ps, {}).lines[1], '[균형] 반복 등장 인물 4명: 소속: 모름 4', 'a person field by its label');
  assert.equal(I.tailLines({ name: 'w', tail: { balance: false } }, ps, {}).lines.length, 1);
  // the service's count (history for settings from before) wins over the setting's own
  assert.match(I.tailLines({ name: 'w' }, ps, { recurring: new Set([ps[4].entityId]) }).lines[1], /반복 등장 인물 1명: 남 1/);
});

test('budget: the two lines come right after the pinned ones and stay last in the text; a small budget keeps what fits', () => {
  const ps = [person('하윤', { gender: '여' }, { pinned: true, description: '반장' }), ...Array.from({ length: 30 }, (_, i) => person(`학생${i}`, { gender: i % 2 ? '남' : '여', background: '긴 배경 '.repeat(20) }, { seen: { n: 2 } }))];
  const w = { name: '별시계 학원', description: '', injectChars: 1200 };
  const out = I.assembleWorld(w, ps, 1200, {});
  const parts = out.text.split('\n\n');
  assert.match(parts.at(-1), /^\[이미 있는 인물\] .*\n\[균형\] 반복 등장 인물 31명: 여 16 · 남 15$/s, 'last, both');
  assert.ok(out.text.includes('- 하윤'), 'the pinned one first');
  assert.ok(out.omitted.length > 0, 'the others give way');
  assert.ok(out.chars <= 1200);
  const tiny = I.assembleWorld(w, ps, 200, {});
  assert.ok(tiny.chars <= 200 + 20);
});

test('the store: batches counted once each (반복 등장); 균형 볼 칸 the world added — from the reader with evidence, never over the person\'s; undo; settings', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-tail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new Archive(dir);
  const w = s.createWorld({ name: '별시계 학원', auto: { enabled: true, connectionId: 'c1', every: 4 } });
  const wd = s.updateWorld(w.worldId, { revision: w.revision, tail: { cast: true, balance: true }, balance: ['성별', '혈통 편견'] });
  assert.deepEqual([wd.tail, wd.balance], [{ cast: true, balance: true }, ['성별', '혈통 편견']]);
  assert.throws(() => s.updateWorld(w.worldId, { revision: wd.revision, balance: ['a', 'b', 'c', 'd', 'e'] }), /4개까지/);
  assert.throws(() => s.updateWorld(w.worldId, { revision: wd.revision, tail: { cast: 'yes' } }), /켜기\/끄기/);
  s.applyAuto(w.worldId, [{ type: 'person', name: '하윤' }], { messageIds: ['m1', 'm2'] });
  s.applyAuto(w.worldId, [{ type: 'person', name: '하윤' }], { messageIds: ['m1', 'm2'] });
  const by = (x) => s.listEntities(w.worldId).find((e) => e.name === x);
  assert.equal(by('하윤').seen.n, 1, 'the same batch again is not another');
  assert.ok(!s.recurringIds(w.worldId).has(by('하윤').entityId));
  s.applyAuto(w.worldId, [{ type: 'person', name: '하윤', balance: { '혈통 편견': '있음', '모르는 칸': 'x' } }], { messageIds: ['m5'], balance: ['혈통 편견'] });
  assert.equal(by('하윤').seen.n, 2);
  assert.ok(s.recurringIds(w.worldId).has(by('하윤').entityId), 'two batches: comes back');
  assert.deepEqual(by('하윤').extra, [{ label: '혈통 편견', value: '있음', source: 'auto' }], 'only the world\'s 칸');
  const c = s.readHistory(w.worldId).changes.find((x) => x.action === 'extra');
  s.undoChange(w.worldId, c.id);
  assert.deepEqual(by('하윤').extra, []);
  // the person's own 추가 칸 stays
  const e = by('하윤');
  s.updateEntity(w.worldId, e.entityId, { revision: e.revision, extra: [{ label: '혈통 편견', value: '없음' }] });
  s.applyAuto(w.worldId, [{ type: 'person', name: '하윤', balance: { '혈통 편견': '있음' } }], { messageIds: ['m9'], balance: ['혈통 편견'] });
  assert.equal(by('하윤').extra[0].value, '없음');
  // settings from before v0.5.1 (no count): their history's batches
  const old = s.applyAuto(w.worldId, [{ type: 'person', name: '서윤' }], { messageIds: ['m1'] });
  const doc = s.readEntities(w.worldId);
  delete doc.entities.find((x) => x.name === '서윤').seen;
  s.writeJson(s.entityFile(w.worldId), doc);
  const h = s.readHistory(w.worldId);
  h.changes.push({ ...old[0], id: '11111111-1111-4111-8111-111111111111', messageIds: ['m7'], action: 'alias', after: '윤' });
  s.writeJson(s.historyFile(w.worldId), h);
  assert.ok(s.recurringIds(w.worldId).has(by('서윤').entityId));
});

test('the reader: a 균형 볼 칸 the world added is asked for (only then) and kept only with its evidence', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-tail2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new Archive(dir);
  service._test.useStore(s);
  const messages = [msg(0, '안녕'), msg(1, '하윤은 머글 태생을 업신여긴다. 서윤은 늘 웃는다.'), msg(2, '그래?'), msg(3, '응.'), msg(4, '내일 봐.'), msg(5, '잘 자.')];
  let asked = '';
  const reply = JSON.stringify({ items: [
    { type: 'person', name: '하윤', balance: { '혈통 편견': { v: '머글 태생을 업신여김', n: ['2.1'] } }, evidence: [{ n: '2.1', q: '하윤은' }] },
    { type: 'person', name: '서윤', balance: { '혈통 편견': { v: '순혈 우월주의', n: ['2.2'] } }, evidence: [{ n: '2.2', q: '서윤은' }] },
  ] });
  service._test.useEngine({
    model: async (cid) => ({ id: cid }),
    chatMessages: async () => ({ messages, cast: ['서하', '나'] }),
    askModel: async (m, msgs) => { asked = msgs[0].content; return { content: reply }; },
    parseJsonObject: real.parseJsonObject,
    listConnections: async () => [],
  });
  service._test.jobs.clear();
  const w = s.createWorld({ name: '별시계 학원', auto: { enabled: true, connectionId: 'c1', every: 4 } });
  s.updateWorld(w.worldId, { revision: w.revision, balance: ['성별', '혈통 편견'] });
  s.linkRoom('room', w.worldId);
  s.setRoomRead('room', { lastId: null, count: 0 });
  assert.equal((await service.runRoom('room')).state, 'done');
  assert.match(asked, /인물의 균형 볼 칸\(근거가 있을 때만, 없으면 적지 않는다\): 혈통 편견/);
  const by = (x) => s.listEntities(w.worldId).find((e) => e.name === x);
  assert.deepEqual(by('하윤').extra, [{ label: '혈통 편견', value: '머글 태생을 업신여김', source: 'auto' }]);
  assert.deepEqual(by('서윤').extra, [], 'not in its sentence');
  assert.doesNotMatch(X.buildPrompt({ name: 'x' }, [], X.batches([msg(1, '가.')], 0)[0], [])[0].content, /균형 볼 칸/, 'a world without its own 칸: the prompt as before');
});
