'use strict';
// Marinara World Archive — server preload for Marinara Engine 2.5.1 / 2.5.2.
// Loaded with  node --require <this file>  (NODE_OPTIONS). Engine files on disk are never changed:
// two engine files are patched in memory while they load, and only when the anchor appears exactly once.
//   - shared/dist/utils/macro-engine.js : {{세계}} / {{world}}, {{세계외형}} / {{world_looks}}
//   - server/dist/app.js                : /api/world-archive routes
// The anchors are the same ones the Memory Module (기억 서재) uses. Both insert *after* the anchor, so the anchor
// stays exactly once and the two preloads can run together in either order (checked in tests/coexist.test.cjs).
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { registerHooks } = require('node:module');

const VERSION = '0.6.4';
const TESTED_MARINARA = ['2.5.1', '2.5.2'];
const TAG = '[world-archive]';

const PATCHES = [
  {
    name: 'macro',
    target: /[\\/]packages[\\/]shared[\\/]dist[\\/]utils[\\/]macro-engine\.js$/,
    anchor: 'result = result.replace(/\\{\\{chatId\\}\\}/gi, ctx.chatId ?? "");',
    insert:
      '\n    result = result.replace(/\\{\\{(?:세계|world)\\}\\}/gi, () => { try { return globalThis.__marinaraWorldArchive?.render?.(ctx) ?? ""; } catch { return ""; } });' +
      '\n    result = result.replace(/\\{\\{(?:세계외형|world_looks)\\}\\}/gi, () => { try { return globalThis.__marinaraWorldArchive?.renderLooks?.(ctx) ?? ""; } catch { return ""; } });',
    ok: '{{세계}} · {{세계외형}} macro',
  },
  {
    name: 'app',
    target: /[\\/]packages[\\/]server[\\/]dist[\\/]app\.js$/,
    anchor: 'app.decorate("db", db);',
    insert:
      '\n    try { globalThis.__marinaraWorldArchive?.attach?.(app); } catch (error) { process.stderr.write("[world-archive] attach failed: " + (error?.message || error) + "\\n"); }',
    ok: 'API at /api/world-archive',
  },
];

function log(message) {
  process.stderr.write(`${TAG} ${message}\n`);
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

/** Patched source; the same source when already patched; null when the anchor is not there exactly once. */
function patchSource(source, patch = PATCHES[1]) {
  if (source.includes(patch.insert)) return source;
  if (count(source, patch.anchor) !== 1) return null;
  return source.replace(patch.anchor, patch.anchor + patch.insert);
}

let service = null;
function loadService() {
  if (service === null) {
    try {
      service = require('./lib/service.cjs');
    } catch (error) {
      log('service unavailable: ' + (error?.message || error));
      service = false;
    }
  }
  return service || null;
}

function render(ctx) {
  return loadService()?.render(ctx) ?? '';
}

function renderLooks(ctx) {
  return loadService()?.renderLooks?.(ctx) ?? '';
}

function attach(app) {
  loadService()?.attach(app);
}

function install() {
  if (typeof registerHooks !== 'function') {
    log('this Node.js has no module.registerHooks (need 22.15+); World Archive off, Marinara unchanged');
    return;
  }
  const patches = {};
  globalThis.__marinaraWorldArchive = { version: VERSION, testedMarinara: TESTED_MARINARA, patches, render, renderLooks, attach };
  registerHooks({
    load(url, context, nextLoad) {
      if (!url.startsWith('file:')) return nextLoad(url, context);
      let filename;
      try {
        filename = fileURLToPath(url);
      } catch {
        return nextLoad(url, context);
      }
      const matching = PATCHES.filter((p) => p.target.test(filename));
      if (!matching.length) return nextLoad(url, context);
      const result = nextLoad(url, context);
      const source =
        result.source == null
          ? fs.readFileSync(filename, 'utf8')
          : typeof result.source === 'string'
            ? result.source
            : Buffer.from(result.source).toString('utf8');
      let output = source;
      for (const patch of matching) {
        const patched = patchSource(output, patch);
        if (patched == null) {
          patches[patch.name] = 'failed';
          log(`fail closed (${patch.name}): this Marinara version does not match; that part is off, Marinara unchanged`);
          continue;
        }
        patches[patch.name] = 'ok';
        output = patched;
        log(`v${VERSION} applied: ${patch.ok}`);
      }
      return output === source ? result : { ...result, source: output, shortCircuit: true };
    },
  });
  log(`v${VERSION} hook registered (no Marinara files changed)`);
}

/** Only the Marinara server process itself — not the launcher, pnpm or build steps that share NODE_OPTIONS. */
function isServerProcess() {
  if (process.env.WORLD_ARCHIVE_ANY_PROCESS === '1') return true;
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
  return /[\\/]packages[\\/]server[\\/]dist[\\/]index\.js$/i.test(entry);
}

if (process.env.WORLD_ARCHIVE_OFF === '1') log('WORLD_ARCHIVE_OFF=1; not installed');
else if (!globalThis.__marinaraWorldArchive && isServerProcess()) {
  try {
    install();
  } catch (error) {
    log('not installed: ' + (error?.message || error));
  }
}

module.exports = { patchSource, PATCHES, VERSION, TESTED_MARINARA };
