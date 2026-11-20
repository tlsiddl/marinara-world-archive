'use strict';
// v0.6.3 (사령탑): when the server part cannot load (v0.6.2 restart 88: a file missing from install.sh), {{세계}} and
// {{세계외형}} become empty text — never an error in the reply being made.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('a service that does not load: {{세계}} · {{세계외형}} render empty, the macro does not throw', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-fc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.copyFileSync(path.join(__dirname, '../world-archive/marinara-world-archive-runtime.cjs'), path.join(dir, 'runtime.cjs'));
  fs.writeFileSync(path.join(dir, 'lib/service.cjs'), "require('./missing-file.cjs');\n");
  const before = globalThis.__marinaraWorldArchive;
  t.after(() => { globalThis.__marinaraWorldArchive = before; });
  delete globalThis.__marinaraWorldArchive;
  const env = process.env.WORLD_ARCHIVE_ANY_PROCESS;
  process.env.WORLD_ARCHIVE_ANY_PROCESS = '1'; // install as if this were the Marinara server process
  const write = process.stderr.write;
  process.stderr.write = () => true; // the runtime's 「hook registered」 · 「service unavailable」 lines
  try { require(path.join(dir, 'runtime.cjs')); } finally {
    process.stderr.write = write;
    if (env === undefined) delete process.env.WORLD_ARCHIVE_ANY_PROCESS; else process.env.WORLD_ARCHIVE_ANY_PROCESS = env;
  }
  const g = globalThis.__marinaraWorldArchive;
  assert.equal(g.render({ chatId: 'room' }), '');
  assert.equal(g.renderLooks({ chatId: 'room' }), '');
  // the macro-engine patch: the same replace the runtime puts into Marinara
  const { PATCHES } = require(path.join(dir, 'runtime.cjs'));
  const insert = PATCHES.find((p) => p.name === 'macro').insert;
  assert.match(insert, /try \{ return globalThis\.__marinaraWorldArchive\?\.render\?\.\(ctx\) \?\? ""; \} catch \{ return ""; \}/);
  const out = '앞 {{세계}} 뒤 {{world_looks}}'
    .replace(/\{\{(?:세계|world)\}\}/gi, () => { try { return globalThis.__marinaraWorldArchive?.render?.({}) ?? ''; } catch { return ''; } })
    .replace(/\{\{(?:세계외형|world_looks)\}\}/gi, () => { try { return globalThis.__marinaraWorldArchive?.renderLooks?.({}) ?? ''; } catch { return ''; } });
  assert.equal(out, '앞  뒤 ');
});
