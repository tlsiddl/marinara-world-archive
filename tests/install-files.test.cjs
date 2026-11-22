'use strict';
// v0.6.3: install.sh copies a fixed list of files — every server file the runtime needs must be on it (v0.6.2 went out
// without lib/profile.cjs and the server part did not start).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('install.sh copies every file of world-archive/lib (and vendor) and the runtime', () => {
  const root = path.join(__dirname, '..');
  const m = fs.readFileSync(path.join(root, 'install.sh'), 'utf8').match(/^FILES="([^"]+)"/m);
  assert.ok(m, 'FILES line');
  const listed = new Set(m[1].split(/\s+/).filter(Boolean));
  const need = ['world-archive/marinara-world-archive-runtime.cjs'];
  for (const dir of ['world-archive/lib', 'world-archive/lib/vendor']) {
    for (const f of fs.readdirSync(path.join(root, dir))) if (f.endsWith('.cjs')) need.push(`${dir}/${f}`);
  }
  assert.deepEqual(need.filter((f) => !listed.has(f)), []);
  for (const f of listed) assert.ok(fs.existsSync(path.join(root, f)), f);
});

// install.ps1 (Windows) copies the same files as install.sh.
test('install.ps1 copies the same files as install.sh', () => {
  const root = path.join(__dirname, '..');
  const sh = fs.readFileSync(path.join(root, 'install.sh'), 'utf8').match(/^FILES="([^"]+)"/m)[1].split(/\s+/).filter(Boolean);
  const ps = fs.readFileSync(path.join(root, 'install.ps1'), 'utf8');
  const block = ps.match(/^\$files = @\(([\s\S]*?)^\)/m);
  assert.ok(block, '$files block');
  const listed = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual([...listed].sort(), [...sh].sort());
});
