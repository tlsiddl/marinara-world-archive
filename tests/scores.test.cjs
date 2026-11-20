'use strict';
// 할 일 11 — 방별 점수판: the model gives events, code adds them up; the same sentence counts once; points of a
// rerolled / deleted message leave the totals (kept, marked gone); hand additions and undo; {{세계}} shows totals.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-score-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new Archive(dir);
}

test('totals are added up by code; same sentence once; a gone message leaves the totals; hand points and undo', (t) => {
  const s = temp(t);
  // 지어낸 학교: 은사슴 · 붉은여우 기숙사
  const w = s.createWorld({ name: '별빛 학원', scoreboard: { name: '기숙사 점수', unit: '점' } });
  s.applyAuto(w.worldId, [{ type: 'group', name: '은사슴 기숙사', aliases: ['은사슴'] }]);
  s.linkRoom('r1', w.worldId);
  const a = s.addScores('r1', [
    { target: '은사슴', delta: 10, reason: '정답', evidence: '은사슴에 10점.', messageId: 'm1', sentence: 1 },
    { target: '붉은여우', delta: -5, reason: '지각', evidence: '붉은여우 5점 감점.', messageId: 'm1', sentence: 2 },
    { target: '은사슴', delta: 10, reason: '정답', evidence: '은사슴에 10점.', messageId: 'm1', sentence: 1 }, // same sentence again
  ]);
  assert.equal(a.length, 2);
  assert.equal(s.addScores('r1', [{ target: '은사슴', delta: 10, evidence: '은사슴에 10점.', messageId: 'm1', sentence: 1 }]).length, 0, 'a later reading of the same sentence adds nothing');
  let b = s.getScores('r1');
  assert.deepEqual(b.board, { name: '기숙사 점수', unit: '점' });
  assert.deepEqual(b.totals, [{ target: '은사슴 기숙사', total: 10 }, { target: '붉은여우', total: -5 }], 'summed under the setting\'s name');
  s.addScores('r1', [{ target: '은사슴 기숙사', delta: 5, evidence: '은사슴 기숙사에 5점.', messageId: 'm2', sentence: 1 }]);
  assert.equal(s.getScores('r1').totals[0].total, 15);
  // m2 was rerolled: its sentence is no longer there
  assert.equal(s.markGoneScores('r1', [{ id: 'm1', content: '은사슴에 10점. 붉은여우 5점 감점.' }, { id: 'm2', content: '아무 일도 없었다.' }]), 1);
  b = s.getScores('r1');
  assert.equal(b.totals[0].total, 10);
  assert.equal(b.events.find((e) => e.messageId === 'm2').gone, true, 'kept, marked gone');
  // by hand, and undo
  const h = s.addScoreByHand('r1', { target: '붉은여우', delta: 3, reason: '청소' });
  assert.equal(h.source, 'manual');
  assert.equal(s.getScores('r1').totals.find((x) => x.target === '붉은여우').total, -2);
  s.undoScore('r1', h.eventId);
  assert.equal(s.getScores('r1').totals.find((x) => x.target === '붉은여우').total, -5);
  assert.throws(() => s.addScoreByHand('r1', { target: '은사슴', delta: 1.5 }), (e) => e.status === 400);
  assert.throws(() => s.addScoreByHand('nolink', { target: '은사슴', delta: 1 }), (e) => e.status === 400);
});

test('only a world with a board asks the model for points; checkScores keeps events with evidence', () => {
  const [part] = X.batches([{ id: 'm1', speaker: '나', role: 'assistant', content: '교수가 은사슴에 10점을 주었다. 붉은여우는 웃었다.' }], 0);
  const [sys] = X.buildPrompt({ name: 'A', scoreboard: { name: '기숙사 점수', unit: '점' } }, [], part, []);
  assert.match(sys.content, /점수\(기숙사 점수\)/);
  assert.doesNotMatch(X.buildPrompt({ name: 'A' }, [], part, [])[0].content, /scores/);
  const ev = X.checkScores({ scores: [
    { target: '은사슴', delta: 10, reason: '대답', evidence: [{ n: '1.1' }] },
    { target: '붉은여우', delta: '-3', evidence: [{ n: '9.9', q: '없는 말' }] },
    { target: '은사슴', delta: 2.5, evidence: [{ n: '1.1' }] },
  ] }, part);
  assert.deepEqual(ev.map((x) => [x.target, x.delta, x.messageId, x.sentence]), [['은사슴', 10, 'm1', 1]]);
});

test('runRoom adds the reply\'s points; {{세계}} shows the totals line', async (t) => {
  const s = temp(t);
  service._test.useStore(s);
  const messages = [0, 1, 2, 3, 4, 5].map((i) => ({ id: 'm' + i, speaker: i % 2 ? '서술' : '나', role: i % 2 ? 'assistant' : 'user', content: i === 1 ? '은사슴에 10점을 주었다.' : '글 ' + i }));
  service._test.useEngine({
    model: async () => ({}), chatMessages: async () => ({ messages, cast: [] }), glossary: async () => null, listConnections: async () => [],
    askModel: async () => ({ content: JSON.stringify({ items: [], relations: [], scores: [{ target: '은사슴', delta: 10, evidence: [{ n: '2.1' }] }] }) }),
    parseJsonObject: real.parseJsonObject,
  });
  service._test.jobs.clear();
  const w = s.createWorld({ name: '별빛 학원', scoreboard: { name: '기숙사 점수', unit: '점' }, auto: { enabled: true, connectionId: 'c1', every: 2 } });
  s.linkRoom('room', w.worldId);
  s.setRoomRead('room', { lastId: null, count: 0 }); // linked while the chat was empty: read from its first message (v0.4.2)
  const job = await service.runRoom('room', { all: true });
  assert.equal(job.scores, 1);
  assert.match(service.preview('room').text, /\[점수\] 기숙사 점수: 은사슴 10점/);
  const out = assembleWorld({ name: 'A', description: '' }, [], 3000, { scores: { board: { name: 'B', unit: '' }, totals: [{ target: 'x', total: 3 }] } });
  assert.match(out.text, /\[점수\] B: x 3$/);
});

test('이전 값도 프롬프트에: off by default, then 「(과거: ○○)」 after the field', (t) => {
  const s = temp(t);
  const w = s.createWorld({ name: 'A' });
  s.applyAuto(w.worldId, [{ type: 'person', name: '하람', fields: { affiliation: '서쪽 분교' } }]);
  s.applyAuto(w.worldId, [{ type: 'person', name: '하람', fields: { affiliation: '별빛 학원' } }]);
  let e = s.listEntities(w.worldId)[0];
  assert.doesNotMatch(assembleWorld(s.getWorld(w.worldId), [e]).text, /과거/);
  e = s.updateEntity(w.worldId, e.entityId, { pastInPrompt: { affiliation: true }, revision: e.revision });
  assert.match(assembleWorld(s.getWorld(w.worldId), [e]).text, /소속: 별빛 학원 \(과거: 서쪽 분교\)/);
});
