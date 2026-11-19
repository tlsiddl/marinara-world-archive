'use strict';
// The preload's in-memory patches. The anchor lines below are copied from Marinara Engine 2.5.2
// (packages/shared/dist/utils/macro-engine.js, packages/server/dist/app.js).
// Coexistence with the Memory Module is checked against its real runtime when MEMORY_MODULE_RUNTIME points to
// marinara-memory-runtime.cjs, and against its anchor+insert shape otherwise.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { PATCHES, patchSource } = require('../world-archive/marinara-world-archive-runtime.cjs');

const macro = PATCHES.find((p) => p.name === 'macro');
const app = PATCHES.find((p) => p.name === 'app');
const MACRO_SRC = 'function x(result, ctx) {\n    result = result.replace(/\\{\\{chatId\\}\\}/gi, ctx.chatId ?? "");\n    return result;\n}';
const APP_SRC = 'async function build() {\n    const db = await getDB();\n    app.decorate("db", db);\n    other();\n}';

test('each patch applies to its 2.5.2 anchor exactly once and is idempotent', () => {
  for (const [p, src] of [[macro, MACRO_SRC], [app, APP_SRC]]) {
    const once = patchSource(src, p);
    assert.ok(once && once.includes(p.insert));
    assert.equal(patchSource(once, p), once);
  }
});

test('fail closed: a missing or repeated anchor leaves the file alone', () => {
  assert.equal(patchSource('different engine', app), null);
  assert.equal(patchSource(APP_SRC + APP_SRC, app), null);
  assert.equal(patchSource('nothing', macro), null);
});

test('the macro patch evaluates {{세계}} and {{world}} through the global hook', () => {
  const patched = patchSource(MACRO_SRC, macro);
  const fn = new Function(`${patched}; return x;`)();
  globalThis.__marinaraWorldArchive = { render: (ctx) => `W:${ctx.chatId}` };
  try {
    assert.equal(fn('a {{세계}} b {{WORLD}} {{chatId}}', { chatId: 'c1' }), 'a W:c1 b W:c1 c1');
    globalThis.__marinaraWorldArchive = { render: () => { throw new Error('boom'); } };
    assert.equal(fn('[{{세계}}]', { chatId: 'c1' }), '[]', 'a failing render gives an empty macro');
    delete globalThis.__marinaraWorldArchive;
    assert.equal(fn('[{{세계}}]', { chatId: 'c1' }), '[]', 'no World Archive: empty');
  } finally {
    delete globalThis.__marinaraWorldArchive;
  }
});

const memoryRuntime = process.env.MEMORY_MODULE_RUNTIME;
const memoryShape = [
  { target: macro.target, apply: (s) => s.replace(macro.anchor, macro.anchor + '\n    result = result.replace(/\\{\\{(?:기억|memory)\\}\\}/gi, () => "M");') },
  { target: app.target, apply: (s) => s.replace(app.anchor, app.anchor + '\n    try { globalThis.__marinaraMemory?.attach?.(app); } catch {}') },
];

test('coexists with the Memory Module in either order', { skip: false }, () => {
  let mm = null;
  if (memoryRuntime && fs.existsSync(memoryRuntime)) {
    process.env.MEMORY_MODULE_HOOK_TEST = '1';
    mm = require(memoryRuntime);
  }
  const files = [
    ['macro-engine', '/x/packages/shared/dist/utils/macro-engine.js', MACRO_SRC, macro],
    ['app', '/x/packages/server/dist/app.js', APP_SRC, app],
  ];
  for (const [label, file, src, ours] of files) {
    const memApply = mm
      ? (s) => mm.patchSource(s, mm.PATCHES.find((p) => p.target.test(file)))
      : memoryShape.find((m) => m.target.test(file)).apply;
    const memFirst = patchSource(memApply(src), ours);
    const oursFirst = memApply(patchSource(src, ours));
    assert.ok(memFirst, `${label}: memory then world archive`);
    assert.ok(oursFirst, `${label}: world archive then memory`);
    assert.ok(memFirst.includes(ours.insert) && oursFirst.includes(ours.insert));
  }
});
