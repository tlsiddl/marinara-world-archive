'use strict';
// v0.8.2 추천 글자 수: the preview says how many rules · systems did not fit in {{세계}} and the smallest step they all
// fit in ('pin' when not even 12,000), and the step to recommend for the language the world is organized in.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Archive } = require('../world-archive/lib/store.cjs');
const service = require('../world-archive/lib/service.cjs');

function world(t, { lang, rules = 30, ruleLen = 120 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-082-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new Archive(dir);
  service._test.useStore(s);
  const w = s.createWorld({ name: 'Harbour', injectChars: 3000 }).worldId;
  if (lang) s.updateWorld(w, { revision: s.getWorld(w).revision, summaryLang: lang });
  const filler = 'x'.repeat(ruleLen);
  s.applyAuto(w, [
    ...Array.from({ length: 12 }, (_, i) => ({ type: 'person', name: `Person ${i}`, fields: { appearance: 'y'.repeat(200) } })),
    ...Array.from({ length: rules }, (_, i) => ({ type: 'rule', name: `Rule ${i}`, memo: filler, appliesTo: 'world' })),
  ]);
  s.linkRoom('roomBudget00000000001', w);
  return { s, w };
}

test('preview: rules · systems that did not fit, and the smallest step that fits them all', (t) => {
  const { s, w } = world(t);
  const p = service.preview('roomBudget00000000001');
  assert.equal(p.budget, 3000);
  assert.ok(p.lawOmitted > 0, 'some rules did not fit in 3,000');
  assert.ok([5000, 6000, 8000, 12000].includes(p.suggest), `a step: ${p.suggest}`);
  s.updateWorld(w, { revision: s.getWorld(w).revision, injectChars: p.suggest });
  const q = service.preview('roomBudget00000000001');
  assert.equal(q.lawOmitted, 0, 'at the suggested step they all fit');
  assert.equal(q.suggest, null);
});

test('preview: not even 12,000 → 「pin」; the recommended step follows the organizing language', (t) => {
  const { s, w } = world(t, { rules: 400, ruleLen: 160 }); // v0.8.3: steps up to 30,000 and short forms — many more to not fit
  const p = service.preview('roomBudget00000000001');
  assert.equal(p.suggest, 'pin');
  assert.equal(p.lang, 'ko');
  assert.equal(p.recommended, 3000);
  s.updateWorld(w, { revision: s.getWorld(w).revision, summaryLang: 'en' });
  const q = service.preview('roomBudget00000000001');
  assert.deepEqual([q.lang, q.recommended], ['en', 6000]);
});
