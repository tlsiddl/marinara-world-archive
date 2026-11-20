'use strict';
// install.sh against a server laid out like the user's: several compose files, the shell's file last and setting
// NODE_OPTIONS for every preload. Uses a stand-in docker CLI; downloads come from this checkout.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const SHELL_FILE = fs.readFileSync(path.join(__dirname, 'fixtures', 'docker-compose.shell-lite.yml'), 'utf8');
const BEFORE = SHELL_FILE.match(/NODE_OPTIONS: "(.*)"/)[1];

function server(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-srv-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'Marinara-Engine');
  fs.mkdirSync(path.join(dir, 'packages', 'server'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docker-compose.yml'), 'services:\n  marinara:\n    image: marinara\n');
  fs.writeFileSync(path.join(dir, 'docker-compose.persona-vision.yml'), `services:\n  marinara:\n    environment:\n      NODE_OPTIONS: "--require=/app/old-only.cjs"\n`);
  fs.writeFileSync(path.join(dir, 'docker-compose.shell-lite.yml'), SHELL_FILE);
  const configs = ['docker-compose.yml', 'docker-compose.persona-vision.yml', 'docker-compose.shell-lite.yml'].map((f) => path.join(dir, f));
  const fake = path.join(root, 'fake');
  fs.mkdirSync(path.join(fake, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(fake, 'state.json'), JSON.stringify({ name: 'marinara-engine-marinara-1', dir, configs, nodeOptions: BEFORE }));
  fs.symlinkSync(path.join(__dirname, 'fixtures', 'fake-docker.cjs'), path.join(fake, 'bin', 'docker'));
  const run = (action = '') =>
    execFileSync('sh', [path.join(REPO, 'install.sh'), ...(action ? [action] : [])], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${path.join(fake, 'bin')}:${process.env.PATH}`, FAKE_DOCKER_DIR: fake, WORLD_ARCHIVE_BASE: `file://${REPO}` },
    });
  const state = () => JSON.parse(fs.readFileSync(path.join(fake, 'state.json'), 'utf8'));
  return { dir, run, state };
}
const requires = (s) => (s.match(/--require=[^ "]+/g) || []).sort();

test('install goes into the file whose NODE_OPTIONS wins, keeps every other preload, and uninstall takes only it out', (t) => {
  const { dir, run, state } = server(t);
  const out = run();
  assert.match(out, /docker-compose\.shell-lite\.yml 에 World Archive 두 줄을 넣었어/);
  const after = state().nodeOptions;
  assert.deepEqual(requires(after), [...requires(BEFORE), '--require=/app/world-archive/marinara-world-archive-runtime.cjs'].sort());
  const shell = fs.readFileSync(path.join(dir, 'docker-compose.shell-lite.yml'), 'utf8');
  assert.match(shell, new RegExp(`- ${dir.replace(/[/.]/g, '\\$&')}/world-archive:/app/world-archive:ro`));
  assert.equal(fs.readFileSync(path.join(dir, 'docker-compose.persona-vision.yml'), 'utf8').includes('world-archive'), false);
  assert.equal(fs.existsSync(path.join(dir, 'docker-compose.override.yml')), false, 'no override file is made');
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('docker-compose.shell-lite.yml.before-world-archive-')));
  assert.ok(fs.existsSync(path.join(dir, 'world-archive', 'lib', 'vendor', 'sentences.cjs')));

  assert.match(run(), /이미 연결돼 있어/, 'second run: update only');

  run('uninstall');
  assert.deepEqual(requires(state().nodeOptions), requires(BEFORE));
  assert.equal(fs.readFileSync(path.join(dir, 'docker-compose.shell-lite.yml'), 'utf8'), SHELL_FILE, 'shell file back exactly as it was');
});

test('when the shell replaces its file (World Archive line gone), running install again puts it back', (t) => {
  const { dir, run, state } = server(t);
  run();
  fs.writeFileSync(path.join(dir, 'docker-compose.shell-lite.yml'), SHELL_FILE);
  const s = state();
  s.nodeOptions = BEFORE;
  fs.writeFileSync(path.join(path.dirname(dir), 'fake', 'state.json'), JSON.stringify(s));
  run();
  assert.ok(requires(state().nodeOptions).includes('--require=/app/world-archive/marinara-world-archive-runtime.cjs'));
  assert.deepEqual(requires(state().nodeOptions).filter((r) => !r.includes('world-archive')), requires(BEFORE));
});
