'use strict';
// v0.7.0 — 기억 서재 0.38.2 날짜 맞추기: storydate.cjs is the Memory Module's (8a310e0); years that are not 20xx and a story
// that goes back read the same; the Memory Module's story date (hand fixes included) comes first when it is on.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const CAL = require('../world-archive/lib/calendar.cjs');
const { Archive } = require('../world-archive/lib/store.cjs');

const m = (content) => ({ content });

test('이야기 속 오늘: 1891 · 1988 as written, and a story that goes back is followed', () => {
  assert.equal(CAL.storyToday([m('§RP | 1891-10-26 (월) | 11:15 | 대강당 | 맑음§')]).date, '1891-10-26');
  const back = CAL.storyToday([m('§RP | 1988-07-19 (화) | 16:15 | 거리 | 흐림§'), m('§RP | 1988-07-15 (금) | 09:00 | 저택 | 맑음§')]);
  assert.equal(back.date, '1988-07-15', 'the last one, not the latest date');
  assert.equal(back.weekday, '금');
});

test('the Memory Module\'s date first (when on), the room\'s own text otherwise', async (t) => {
  const service = require('../world-archive/lib/service.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-070-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new Archive(dir);
  service._test.useStore(s);
  const w = s.createWorld({ name: '별시계 학원' });
  s.linkRoom('room-d', w.worldId);
  service._test.useEngine({ chatMessages: async () => ({ messages: [{ id: 'a', content: '§RP | 1891-10-26 (월) | 11:15 | 대강당§' }], cast: [] }) });
  const before = globalThis.__marinaraMemory;
  t.after(() => { globalThis.__marinaraMemory = before; service._test.useApp(null); });
  globalThis.__marinaraMemory = { version: '0.38.2' };
  let answer = { enabled: true, storyDate: '1891-11-02' };
  service._test.useApp({ inject: async ({ url }) => ({ statusCode: 200, body: JSON.stringify(url.endsWith('/room-d') ? answer : {}) }) });
  await service._test.updateScene('room-d');
  const st = s.getRoom('room-d').story;
  assert.deepEqual([st.date, st.weekday], ['1891-11-02', '월']);
  // off in the Memory Module: the room's own header
  answer = { enabled: false, storyDate: '1891-11-02' };
  service._test.useApp({ inject: async () => ({ statusCode: 200, body: JSON.stringify(answer) }) });
  await service._test.updateScene('room-d');
  assert.equal(s.getRoom('room-d').story.date, '1891-10-26');
  // no Memory Module at all
  delete globalThis.__marinaraMemory;
  service._test.useApp({ inject: async () => { throw Error('never asked'); } });
  await service._test.updateScene('room-d');
  assert.equal(s.getRoom('room-d').story.date, '1891-10-26');
});
