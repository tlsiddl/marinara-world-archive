'use strict';
const path = require('node:path');
const { timingSafeEqual } = require('node:crypto');
const { WorldStore, ArchiveError } = require('./store.cjs');
const PREFIX = '/api/world-archive';
const compareToken = (got, expected) => {
  const a = Buffer.from(got || '', 'utf8'), b = Buffer.from(expected || '', 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
};
/** Experimental API: requires its own token even if Marinara has auth configured. */
function attach(app, options = {}) {
  const token = options.token || process.env.WORLD_ARCHIVE_ADMIN_TOKEN || '';
  if (token.length < 24) throw new Error('WORLD_ARCHIVE_ADMIN_TOKEN must have at least 24 characters');
  const dir = options.dataDir || path.join(process.env.DATA_DIR || path.join(process.cwd(), 'data'), 'world-archive');
  const store = options.store || new WorldStore(dir);
  const guard = (action) => async (req, reply) => {
    const auth = req.headers?.authorization || '';
    if (!auth.startsWith('Bearer ') || !compareToken(auth.slice(7), token)) {
      return reply.code(401).send({ error: 'World Archive 인증이 필요해.' });
    }
    try { return await action(req, reply); }
    catch (e) {
      const code = e instanceof ArchiveError ? e.status : 500;
      if (code === 500) app.log?.error?.({ err: e }, 'world-archive error');
      return reply.code(code).send({ error: code === 500 ? '세계관 저장 중 오류가 발생했어.' : e.message });
    }
  };
  app.get(PREFIX + '/worlds', guard(() => ({ worlds: store.list() })));
  app.post(PREFIX + '/worlds', guard(req => store.create(req.body || {})));
  app.patch(PREFIX + '/worlds/:worldId', guard(req => store.update(req.params.worldId, req.body || {})));
  app.delete(PREFIX + '/worlds/:worldId', guard(req => store.delete(req.params.worldId, req.body?.revision)));
  return { store };
}
module.exports = { attach, PREFIX };
