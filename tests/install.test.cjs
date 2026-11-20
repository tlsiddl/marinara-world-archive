'use strict';
// install.sh's override editing, run through /bin/sh with the functions only (no Docker, no network).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'install.sh');
const sh = (body) =>
  execFileSync('/bin/sh', ['-c', `WORLD_ARCHIVE_FUNCTIONS_ONLY=1 . "${SCRIPT}"; ${body}`], { encoding: 'utf8' });

// Exactly what the Memory Module's install.sh writes (main 165d488), for a container that had no NODE_OPTIONS.
const MEMORY_OVERRIDE = `# 기억 서재 (기억 모듈) — install.sh가 만든 파일. 지우면 기억 모듈이 꺼집니다.
services:
  marinara:
    volumes:
      - ./memory-module:/app/memory-module:ro
    environment:
      NODE_OPTIONS: "--require=/app/memory-module/marinara-memory-runtime.cjs"
`;

function tmp(t, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-install-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, 'docker-compose.override.yml');
  if (content != null) fs.writeFileSync(f, content);
  return f;
}
const rc = (body) => Number(sh(`RC=0; ${body} || RC=$?; printf %s "$RC"`));

test('adds World Archive to the Memory Module override, then takes exactly that out again', (t) => {
  const f = tmp(t, MEMORY_OVERRIDE);
  assert.equal(rc(`merge_override "${f}" marinara`), 0);
  const merged = fs.readFileSync(f, 'utf8');
  assert.equal(
    merged,
    MEMORY_OVERRIDE.replace(
      '      - ./memory-module:/app/memory-module:ro\n',
      '      - ./memory-module:/app/memory-module:ro\n      - ./world-archive:/app/world-archive:ro\n',
    ).replace(
      'marinara-memory-runtime.cjs"',
      'marinara-memory-runtime.cjs --require=/app/world-archive/marinara-world-archive-runtime.cjs"',
    ),
  );
  assert.equal(rc(`merge_override "${f}" marinara`), 4, 'second run: already there, unchanged');
  assert.equal(fs.readFileSync(f, 'utf8'), merged);
  sh(`unmerge_override "${f}"`);
  assert.equal(fs.readFileSync(f, 'utf8'), MEMORY_OVERRIDE);
});

test('keeps NODE_OPTIONS that were there before the Memory Module', (t) => {
  const f = tmp(t, MEMORY_OVERRIDE.replace('"--require', '"--max-old-space-size=2048 --require'));
  assert.equal(rc(`merge_override "${f}" marinara`), 0);
  assert.match(fs.readFileSync(f, 'utf8'), /NODE_OPTIONS: "--max-old-space-size=2048 --require=\/app\/memory-module\/marinara-memory-runtime\.cjs --require=\/app\/world-archive\/marinara-world-archive-runtime\.cjs"\n/);
});

test('an override it does not understand is left alone', (t) => {
  for (const odd of [
    'services:\n  marinara:\n    environment:\n      - NODE_OPTIONS=--require=/x.cjs\n',
    'services:\n  a:\n    volumes:\n      - ./x:/x\n    environment:\n      NODE_OPTIONS: "a"\n  b:\n    volumes:\n      - ./y:/y\n    environment:\n      NODE_OPTIONS: "b"\n',
    'services:\n  marinara:\n    environment:\n      NODE_OPTIONS: "--require=/x.cjs"\n',
  ]) {
    const f = tmp(t, odd);
    assert.equal(rc(`merge_override "${f}" marinara`), 3);
    assert.equal(fs.readFileSync(f, 'utf8'), odd);
  }
});

test('a new override keeps the container NODE_OPTIONS', (t) => {
  const f = tmp(t, null);
  sh(`new_override "${f}" marinara "--max-old-space-size=2048"`);
  const text = fs.readFileSync(f, 'utf8');
  assert.match(text, /^# World Archive/);
  assert.match(text, /NODE_OPTIONS: "--max-old-space-size=2048 --require=\/app\/world-archive\/marinara-world-archive-runtime\.cjs"/);
  assert.match(text, /- \.\/world-archive:\/app\/world-archive:ro/);
});

test('the plain-install launcher also starts the Memory Module when it is there', (t) => {
  const dir = path.dirname(tmp(t, ''));
  sh(`write_launcher "${dir}"`);
  const text = fs.readFileSync(path.join(dir, 'start-world-archive.sh'), 'utf8');
  assert.match(text, /memory-module\/marinara-memory-runtime\.cjs/);
  assert.match(text, /world-archive\/marinara-world-archive-runtime\.cjs/);
  execFileSync('bash', ['-n', path.join(dir, 'start-world-archive.sh')]);
});

test('requires_kept: every other preload must survive; World Archive present or absent as asked', () => {
  const before = '--require=/app/a.cjs --require=/app/memory-module/marinara-memory-runtime.cjs';
  const ok = `NODE_OPTIONS: ${before} --require=/app/world-archive/marinara-world-archive-runtime.cjs`;
  const lost = 'NODE_OPTIONS: --require=/app/memory-module/marinara-memory-runtime.cjs --require=/app/world-archive/marinara-world-archive-runtime.cjs';
  const code = (args) => Number(sh(`RC=0; requires_kept ${args} 2>/dev/null || RC=$?; printf %s "$RC"`));
  assert.equal(code(`"${before}" "${ok}" with`), 0);
  assert.equal(code(`"${before}" "${lost}" with`), 1, 'a.cjs would be lost');
  assert.equal(code(`"${before}" "NODE_OPTIONS: ${before}" with`), 1, 'World Archive missing');
  assert.equal(code(`"${before} --require=/app/world-archive/marinara-world-archive-runtime.cjs" "NODE_OPTIONS: ${before}" without`), 0);
});

test('options_file picks the last compose file that sets NODE_OPTIONS', (t) => {
  const dir = path.dirname(tmp(t, ''));
  const a = path.join(dir, 'a.yml'), b = path.join(dir, 'b.yml'), c = path.join(dir, 'c.yml');
  fs.writeFileSync(a, 'x: 1\n');
  fs.writeFileSync(b, '      NODE_OPTIONS: "--require=/b.cjs"\n');
  fs.writeFileSync(c, '      NODE_OPTIONS: "--require=/c.cjs"\n');
  assert.equal(sh(`options_file "${a},${b},${c}"`), c);
  assert.equal(sh(`options_file "${a},${c},${b}"`), b);
  assert.equal(sh(`options_file "${a}"`), '');
});
