'use strict';
// v0.8.4 정리 모델 고르기 찾기 쉽게: the 새 세계관 form sends the model and 자동 반영 together (no model is fine —
// the screen shows a band then); the stored shape is the same as before.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Archive } = require('../world-archive/lib/store.cjs');

function store(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-084-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new Archive(dir);
}

test('create with a model and 자동 반영 on', (t) => {
  const s = store(t);
  const w = s.createWorld({ name: '은사슴', description: '', auto: { enabled: true, connectionId: 'conn_A-1' } });
  assert.deepEqual([w.auto.enabled, w.auto.connectionId, w.auto.every], [true, 'conn_A-1', 6]);
  assert.deepEqual(s.getWorld(w.worldId).auto, w.auto);
});

test('create with 자동 반영 on but no model yet: saved as is (the band asks later), and old bodies stay off', (t) => {
  const s = store(t);
  const a = s.createWorld({ name: 'A', auto: { enabled: true, connectionId: null } });
  assert.deepEqual([a.auto.enabled, a.auto.connectionId], [true, null]);
  const b = s.createWorld({ name: 'B' });
  assert.deepEqual([b.auto.enabled, b.auto.connectionId], [false, null]);
  assert.throws(() => s.createWorld({ name: 'C', auto: { enabled: true, connectionId: 'bad id!' } }), /연결 ID/);
});

test('the screen: the band text, the picker in 새 세계관, the line in 자동 반영', () => {
  const src = fs.readFileSync(path.join(__dirname, '../extension/extension.js'), 'utf8');
  assert.match(src, /정리할 모델을 아직 안 골랐어요 — 기억 서재와 따로 골라요/);
  assert.match(src, /id="nw-auto" checked/);
  assert.match(src, /connSelectHtml\('nw-conn', '', true\)/);
  assert.match(src, /기억 서재가 쓰는 모델과 따로입니다\. 같은 걸 골라도 돼요\./);
  assert.doesNotMatch(src, /자동 반영에 쓸 연결을 골라 주세요\.<\/span>/, 'the small line is the band now');
});
