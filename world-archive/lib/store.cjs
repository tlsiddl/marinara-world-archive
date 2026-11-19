'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const SCHEMA = 1;
const NAME_MAX = 120;
const DESC_MAX = 2000;
const ID_RE = /^[0-9a-f-]{36}$/i;

class ArchiveError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clean = (v, max) => {
  if (typeof v !== 'string') throw new ArchiveError(400, '문자열을 입력해야 해.');
  const x = v.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (!x || x.length > max) throw new ArchiveError(400, `내용은 1~${max}자여야 해.`);
  return x;
};
function validate(doc) {
  if (!isObject(doc) || doc.schemaVersion !== SCHEMA || !Array.isArray(doc.worlds)) {
    throw new ArchiveError(409, '지원하지 않거나 손상된 세계관 파일이야. 덮어쓰지 않았어.');
  }
  const ids = new Set();
  for (const w of doc.worlds) {
    if (!isObject(w) || typeof w.worldId !== 'string' || !ID_RE.test(w.worldId) ||
      typeof w.name !== 'string' || typeof w.description !== 'string' ||
      typeof w.createdAt !== 'string' || typeof w.updatedAt !== 'string' ||
      !Number.isSafeInteger(w.revision) || w.revision < 1 || ids.has(w.worldId)) {
      throw new ArchiveError(409, '세계관 파일이 손상된 것 같아. 덮어쓰지 않았어.');
    }
    ids.add(w.worldId);
  }
  return doc;
}
class WorldStore {
  constructor(dir) {
    this.dir = path.resolve(dir);
    this.file = path.join(this.dir, 'worlds.json');
  }
  read() {
    let raw;
    try { raw = fs.readFileSync(this.file, 'utf8'); }
    catch (e) {
      if (e.code === 'ENOENT') return { schemaVersion: SCHEMA, worlds: [] };
      throw e;
    }
    if (Buffer.byteLength(raw, 'utf8') > 4 * 1024 * 1024) throw new ArchiveError(409, '세계관 파일이 너무 커. 덮어쓰지 않았어.');
    try { return validate(JSON.parse(raw)); }
    catch (e) {
      if (e instanceof ArchiveError) throw e;
      throw new ArchiveError(409, '세계관 파일을 읽을 수 없어. 덮어쓰지 않았어.');
    }
  }
  write(doc) {
    validate(doc);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(this.dir, `.${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fs.renameSync(tmp, this.file);
    } finally {
      try { fs.unlinkSync(tmp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  }
  list() { return this.read().worlds; }
  create({ name, description = '' }) {
    name = clean(name, NAME_MAX);
    if (typeof description !== 'string' || description.length > DESC_MAX) throw new ArchiveError(400, '설명이 너무 길어.');
    const doc = this.read();
    const now = new Date().toISOString();
    const world = { worldId: randomUUID(), name, description: description.trim(), revision: 1, createdAt: now, updatedAt: now };
    doc.worlds.push(world);
    this.write(doc);
    return world;
  }
  update(id, { name, description, revision }) {
    if (!ID_RE.test(id || '')) throw new ArchiveError(400, '세계관 ID가 올바르지 않아.');
    if (!Number.isSafeInteger(revision) || revision < 1) throw new ArchiveError(400, 'revision이 필요해.');
    const doc = this.read(), world = doc.worlds.find(x => x.worldId === id);
    if (!world) throw new ArchiveError(404, '세계관을 찾지 못했어.');
    if (world.revision !== revision) throw new ArchiveError(409, '다른 곳에서 수정됐어. 목록을 새로 불러와.');
    if (name === undefined && description === undefined) throw new ArchiveError(400, '수정할 항목이 없어.');
    if (name !== undefined) world.name = clean(name, NAME_MAX);
    if (description !== undefined) {
      if (typeof description !== 'string' || description.length > DESC_MAX) throw new ArchiveError(400, '설명이 너무 길어.');
      world.description = description.trim();
    }
    world.revision++;
    world.updatedAt = new Date().toISOString();
    this.write(doc);
    return world;
  }
  delete(id, revision) {
    if (!ID_RE.test(id || '')) throw new ArchiveError(400, '세계관 ID가 올바르지 않아.');
    if (!Number.isSafeInteger(revision) || revision < 1) throw new ArchiveError(400, 'revision이 필요해.');
    const doc = this.read(), index = doc.worlds.findIndex(x => x.worldId === id);
    if (index < 0) throw new ArchiveError(404, '세계관을 찾지 못했어.');
    if (doc.worlds[index].revision !== revision) throw new ArchiveError(409, '변경된 항목이야. 목록을 새로 불러와.');
    doc.worlds.splice(index, 1);
    this.write(doc);
    return { deleted: true, worldId: id };
  }
}
module.exports = { WorldStore, ArchiveError, SCHEMA };
