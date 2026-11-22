'use strict';
// v0.8.1 (프리셋 생성 지침 비교 뒤): 머리색 · 눈색을 외형 글에서 코드로 — 색 낱말만, 같은 마디 안에서만,
// 비어 있는 칸만 · 사람 것은 그대로 · 외형이 숨김이면 같이 숨김 · 기록에서 되돌리기.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Archive, looksFrom } = require('../world-archive/lib/store.cjs');

test('looksFrom: the colour words right before hair · eyes, in the same clause; nothing that is not a colour', () => {
  const cases = [
    ['Short silver-blond hair, pale, watery eyes', 'hair', 'silver-blond'],
    ['Short silver-blond hair, pale, watery eyes', 'eyes', 'pale'],
    ['grey eyes and black hair', 'hair', 'black'],
    ['her dark brown hair', 'hair', 'dark brown'],
    ['A tall man with long dark braided hair', 'hair', 'dark'],
    ['Red-gold plumage', 'hair', 'red-gold'],
    ['검은 머리, 푸른 눈', 'hair', '검은'],
    ['검은 머리, 푸른 눈', 'eyes', '푸른'],
    ['hair that needs cutting', 'hair', null],
    ['tired eyes', 'eyes', null],
    ['eyes the colour of rain', 'eyes', null],
    ['', 'hair', null],
  ];
  for (const [t, k, want] of cases) assert.equal(looksFrom(t, k), want, `${k}: ${t}`);
});

test('fillLooksFromAppearance: empty fields only, never the person\'s; hidden with a hidden 외형; undoable', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-081-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new Archive(dir);
  const w = s.createWorld({ name: 'Diagon' }).worldId;
  s.applyAuto(w, [
    { type: 'person', name: 'Old Wick', fields: { appearance: 'Stooped, with white hair and pale, watery eyes' } },
    { type: 'person', name: 'Wren', fields: { appearance: 'Mouse-brown hair, hazel eyes', hair: 'mousy' } },
    { type: 'person', name: 'Ada', fields: { appearance: 'Black hair in a plait, grey eyes' } },
  ]);
  const ent = (n) => s.listEntities(w).find((e) => e.name === n);
  const ada = ent('Ada');
  s.updateEntity(w, ada.entityId, { revision: ada.revision, fields: { eyes: 'storm-grey' } });
  const doc = s.readEntities(w);
  doc.entities.find((e) => e.name === 'Old Wick').hidden = { appearance: true };
  s.writeJson(s.entityFile(w), doc);
  const ch = s.fillLooksFromAppearance(w);
  assert.deepEqual([ent('Old Wick').fields.hair, ent('Old Wick').fields.eyes], ['white', 'pale']);
  assert.deepEqual(ent('Old Wick').hidden, { appearance: true, hair: true, eyes: true }, 'a profile-only 외형 keeps its colours hidden too');
  assert.equal(ent('Wren').fields.hair, 'mousy', 'a filled field stays');
  assert.equal(ent('Wren').fields.eyes, 'hazel');
  assert.equal(ent('Ada').fields.hair, 'black');
  assert.equal(ent('Ada').fields.eyes, 'storm-grey', 'the person\'s stays');
  assert.ok(ch.every((c) => c.by === 'looks' && c.action === 'field'));
  s.undoChange(w, ch.find((c) => c.name === 'Ada' && c.key === 'hair').id);
  assert.equal(ent('Ada').fields.hair, undefined);
  assert.deepEqual(s.fillLooksFromAppearance(w), [], 'what the person undid is not filled again at the next reading');
});
