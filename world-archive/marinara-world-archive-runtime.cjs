'use strict';
// Experimental opt-in preload for Marinara Engine 2.5.2.
// Hooks only an exact, known app.js anchor and leaves engine files untouched.
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { registerHooks } = require('node:module');
const VERSION = '0.1.0-dev';
const TAG = '[world-archive]';
const ENTRY = /[\\/]packages[\\/]server[\\/]dist[\\/]index\.js$/i;
const TARGET = /[\\/]packages[\\/]server[\\/]dist[\\/]app\.js$/i;
const ANCHOR = '    app.decorate("db", db);';
const INJECT = '\n    globalThis.__marinaraWorldArchive?.attach?.(app);';
function patchSource(source) {
  if (source.includes(INJECT)) return source;
  if (source.split(ANCHOR).length !== 2) return null;
  return source.replace(ANCHOR, ANCHOR + INJECT);
}
function install() {
  if (typeof registerHooks !== 'function') throw new Error('Node.js 22.15+ required for registerHooks');
  globalThis.__marinaraWorldArchive = {
    version: VERSION,
    attach(app) {
      try { require('./lib/api.cjs').attach(app); }
      catch (e) { process.stderr.write(TAG + ' disabled: ' + e.message + '\n'); }
    },
  };
  registerHooks({
    load(url, context, nextLoad) {
      if (!url.startsWith('file:')) return nextLoad(url, context);
      let file;
      try { file = fileURLToPath(url); } catch { return nextLoad(url, context); }
      if (!TARGET.test(file)) return nextLoad(url, context);
      const result = nextLoad(url, context);
      const source = result.source == null ? fs.readFileSync(file, 'utf8') : Buffer.from(result.source).toString('utf8');
      const patched = patchSource(source);
      if (patched == null) {
        process.stderr.write(TAG + ' app anchor mismatch; API disabled\n');
        return result;
      }
      return patched === source ? result : { ...result, source: patched, shortCircuit: true };
    },
  });
}
if (process.env.WORLD_ARCHIVE_ENABLE === '1' &&
    process.env.WORLD_ARCHIVE_ADMIN_TOKEN?.length >= 24 &&
    ENTRY.test(path.resolve(process.argv[1] || ''))) {
  try { install(); } catch (e) { process.stderr.write(TAG + ' unavailable: ' + e.message + '\n'); }
}
module.exports = { patchSource, VERSION };
