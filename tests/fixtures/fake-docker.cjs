#!/usr/bin/env node
'use strict';
// A stand-in for the docker CLI, enough for install.sh: one compose-started container whose NODE_OPTIONS comes from the
// last compose file (in -f order) that sets it, like real compose. State lives in $FAKE_DOCKER_DIR.
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.FAKE_DOCKER_DIR;
const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
const save = () => fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));
const argv = process.argv.slice(2);
const fmt = argv[argv.indexOf('-f') + 1] || '';
fs.appendFileSync(path.join(dir, 'calls.log'), argv.join(' ') + '\n');
const nodeOptions = (files) => {
  let v = null;
  for (const f of files) {
    const m = fs.readFileSync(f, 'utf8').match(/^\s*NODE_OPTIONS:\s*"(.*)"\s*$/m);
    if (m) v = m[1];
  }
  return v;
};
const filesFrom = (args) => args.flatMap((a, i) => (a === '-f' ? [path.resolve(state.dir, args[i + 1])] : []));
if (argv[0] === 'ps') {
  if (argv.includes('--format')) console.log(fmt.includes('Image') ? `${state.name}\tmarinara\tmarinara\tmarinara-engine` : state.name);
  process.exit(0);
}
if (argv[0] === 'inspect') {
  const name = argv[argv.length - 1];
  if (name !== state.name) process.exit(1);
  if (fmt.includes('com.docker.compose.project.working_dir')) console.log(state.dir);
  else if (fmt.includes('com.docker.compose.service')) console.log('marinara');
  else if (fmt.includes('com.docker.compose.project.config_files')) console.log(state.configs.join(','));
  else if (fmt.includes('.Config.Env')) console.log(`NODE_OPTIONS=${state.nodeOptions}\nDATA_DIR=/app/data`);
  else if (fmt.includes('.Path')) console.log('node packages/server/dist/index.js');
  process.exit(0);
}
if (argv[0] === 'restart') { state.restarts = (state.restarts || 0) + 1; save(); process.exit(0); }
if (argv[0] === 'compose') {
  const files = filesFrom(argv);
  if (argv.includes('config')) {
    for (const f of files) if (!fs.existsSync(f)) process.exit(1);
    console.log(`services:\n  marinara:\n    environment:\n      NODE_OPTIONS: ${nodeOptions(files)}`);
    process.exit(0);
  }
  if (argv.includes('up')) { state.nodeOptions = nodeOptions(files); state.ups = (state.ups || 0) + 1; save(); process.exit(0); }
}
if (argv[0] === 'exec') process.exit(0);
process.exit(0);
