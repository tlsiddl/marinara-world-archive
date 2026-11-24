'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const looks = require('../world-archive/lib/illustration-looks.cjs');
const service = require('../world-archive/lib/service.cjs');
const runtime = require('../world-archive/marinara-world-archive-runtime.cjs');
const fs = require('node:fs');
const path = require('node:path');

const person = (id, name, hair, eyes) => ({ entityId: id, name, aliases: [], type: 'person', status: 'confirmed', fields: { hair, eyes } });
const text = '§RP | 2026.01.01 | 10:00 | [시험] | Clear§\n- Mira: coat | standing | calm\n- Tovin: coat | standing | calm';
const people = [person('a', 'Mira', 'black', 'blue'), person('b', 'Tovin', 'blonde', 'green')];

test('scene-specific appearances retain names, colours and independent safety', () => {
  const out = looks.worldLooksParts(text, people, {}, [], [], { label: true });
  assert.match(out.text, /Mira — hair: black hair \/ eyes: blue eyes/);
  assert.match(out.text, /Tovin — hair: blonde hair \/ eyes: green eyes/);
  assert.match(out.text, /@Name/);
  const fixed = looks.looksFixRun('@Mira, 1girl, blonde hair, green eyes | @Tovin, 1boy, black hair, blue eyes', out.cast).prompt;
  assert.match(fixed, /black hair/);
  assert.match(fixed, /blonde hair/);
  assert.doesNotMatch(fixed, /@Mira|@Tovin/);
});

test('linked rooms inject automatically, absent rooms and shell coexist fail closed', () => {
  service._test.useStore({ roomWorldId: (id) => id === 'test' ? 'world' : null, readEntities: () => ({ entities: people, relations: [] }) });
  const ctx = { chatId: 'test', mainResponse: text, recentMessages: [], characters: [] };
  try {
    assert.match(service.illustratorLooks(ctx, true), /Mira/);
    assert.match(service.illustratorFix('test', '@Mira, 1girl, blonde hair'), /black hair/);
    const noTracker = service.illustratorLooks({ ...ctx, mainResponse: 'Mira opens the door.' }, false);
    assert.match(noTracker, /Mira/);
    assert.doesNotMatch(noTracker, /Tovin/);
    assert.equal(service.illustratorLooks({ ...ctx, chatId: 'unlinked' }), '');
    globalThis.__shellWorldLooks = {};
    assert.equal(service.illustratorLooks(ctx), '');
    assert.equal(service.illustratorFix('test', '@Mira, blonde hair'), '@Mira, blonde hair');
  } finally { delete globalThis.__shellWorldLooks; service._test.useStore(null); }
});

test('illustrator hooks fail closed on changed or repeated engine anchors and are idempotent', () => {
  for (const patch of runtime.PATCHES.filter((p) => p.name.startsWith('illustrator'))) {
    const source = `before\n${patch.anchor}\nafter`;
    const first = runtime.patchSource(source, patch);
    assert.ok(first, patch.name);
    assert.equal(runtime.patchSource(first, patch), first);
    assert.equal(runtime.patchSource('no anchor', patch), null);
    assert.equal(runtime.patchSource(`${source}\n${patch.anchor}`, patch), null);
  }
});

test('appearance falls back to the saved description and honours image overrides', () => {
  const chars = [person('a', 'Mira', '', '')];
  chars[0].fields.appearance = 'black hair, blue eyes';
  const context = '§RP | 1 | 2 | 3 | 4§\n- Mira: coat | bench | quiet';
  const out = looks.worldLooksParts(context, chars, {}, [], []);
  assert.match(out.text, /black hair/);
  assert.match(out.text, /blue eyes/);
  const override = looks.worldLooksParts(context, chars, { mira: 'red hair' }, [], []);
  assert.doesNotMatch(override.text, /black hair/);
  assert.match(override.text, /blue eyes/);
});

test('normal reply and retry hooks execute, while existing manual appearance is not duplicated', () => {
  const hook = runtime.PATCHES.find((p) => p.name === 'illustrator');
  const source = 'return (context, options, contextAgentTypes, finalParts) => { finalParts.push(`</assistant_response>`); return finalParts; };';
  const fn = new Function(runtime.patchSource(source, hook))();
  globalThis.__marinaraWorldArchive = { illustratorLooks: () => '<world_archive_looks>test</world_archive_looks>' };
  try {
    assert.equal(fn({}, {}, ['illustrator'], []).filter((v) => v.includes('world_archive_looks')).length, 1);
    assert.equal(fn({}, {}, [], []).filter((v) => v.includes('world_archive_looks')).length, 0);
    assert.equal(fn({}, {}, ['illustrator'], ['[외형]\nexisting']).filter((v) => v.includes('world_archive_looks')).length, 0);
  } finally { delete globalThis.__marinaraWorldArchive; }
  const retry = runtime.PATCHES.find((p) => p.name === 'illustratorFixRetry');
  const retrySource = 'return (chatId, illData) => { const imagePrompt = (illData.prompt ?? "").trim(); return imagePrompt; };';
  const retryFn = new Function(runtime.patchSource(retrySource, retry))();
  globalThis.__marinaraWorldArchive = { illustratorFix: (_chat, value) => value.replace('red hair', 'blue hair') };
  try { assert.equal(retryFn('test', { prompt: 'red hair' }), 'blue hair'); }
  finally { delete globalThis.__marinaraWorldArchive; }
});

test('Windows and Unix installers include the illustration module', () => {
  for (const name of ['install.sh', 'install.ps1']) {
    assert.match(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'), /world-archive\/lib\/illustration-looks\.cjs/);
  }
});
