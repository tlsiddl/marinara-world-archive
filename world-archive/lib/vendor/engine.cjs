'use strict';
// Reading chats and calling a model through Marinara's own code.
// Copied from the Memory Module (tlsiddl/marinara-memory-module, main 165d488, memory-module/lib/service.cjs):
//   serverDist, engine, parseExtra, characterName, connectionWithKey, connectionProvider, memoryCallOptions (as
//   callOptions), askModel, and ledger.cjs parseJsonObject. Changes: only the storages World Archive needs, messages
//   without the Memory Module's language/tracker steps, World Archive's own error wording, no usage bookkeeping.
//   The glossary reader at the end is World Archive's own (the Memory Module reads it in the browser).
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODEL_TIMEOUT_MS = 5 * 60_000;

function serverDist() {
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
  if (!/[\\/]packages[\\/]server[\\/]dist[\\/]index\.js$/i.test(entry)) throw Error(`unexpected server entry ${entry}`);
  return path.dirname(entry);
}

let enginePromise = null;
function engine() {
  enginePromise ??= (async () => {
    const dist = serverDist();
    const load = (rel) => import(pathToFileURL(path.join(dist, rel)).href);
    const [db, chats, characters, connections, registry, baseUrl] = await Promise.all([
      load('db/connection.js'),
      load('services/storage/chats.storage.js'),
      load('services/storage/characters.storage.js'),
      load('services/storage/connections.storage.js'),
      load('services/llm/provider-registry.js'),
      load('services/generation/connection-base-url.js'),
    ]);
    const handle = await db.getDB();
    return {
      chats: chats.createChatsStorage(handle),
      characters: characters.createCharactersStorage(handle),
      connections: connections.createConnectionsStorage(handle),
      createLLMProvider: registry.createLLMProvider,
      resolveBaseUrl: baseUrl.resolveBaseUrl,
    };
  })();
  enginePromise.catch(() => (enginePromise = null));
  return enginePromise;
}

function parseExtra(value) {
  if (value && typeof value === 'object') return value;
  try {
    return JSON.parse(value || '{}');
  } catch {
    return {};
  }
}

const nameCache = new Map();
async function characterName(e, id) {
  if (!id) return null;
  if (nameCache.has(id)) return nameCache.get(id);
  let name = null;
  try {
    const row = await e.characters.getById(id);
    name = row ? JSON.parse(row.data || '{}').name || null : null;
  } catch {}
  nameCache.set(id, name);
  return name;
}

/**
 * The story messages of a chat, oldest first: { id, speaker, role, content }. Messages hidden from the AI are left
 * out, except those Marinara's own chat summary hid (they are still the story). Also the names that already have
 * their own card in this chat (its characters and the user's persona), which the archive does not need to copy.
 */
async function chatMessages(chatId) {
  const e = await engine();
  const rows = await e.chats.listMessages(chatId);
  const chat = await e.chats.getById(chatId);
  const meta = parseExtra(chat?.metadata);
  const summarized = new Set();
  for (const entry of Array.isArray(meta.summaryEntries) ? meta.summaryEntries : []) for (const id of entry?.hiddenMessageIds || []) summarized.add(id);
  const cast = new Set();
  let ids = chat?.characterIds;
  if (typeof ids === 'string') ids = parseExtra(ids);
  for (const id of Array.isArray(ids) ? ids : []) {
    const n = await characterName(e, id);
    if (n) cast.add(n);
  }
  const messages = [];
  for (const row of rows) {
    if (!['user', 'assistant', 'narrator'].includes(row.role)) continue;
    const extra = parseExtra(row.extra);
    if ((extra.hiddenFromAI === true && !summarized.has(row.id)) || !String(row.content || '').trim()) continue;
    const persona = extra.personaSnapshot?.name;
    if (row.role === 'user' && persona) cast.add(persona);
    const speaker = row.role === 'user' ? persona || 'User' : row.role === 'narrator' ? 'Narrator' : (await characterName(e, row.characterId)) || 'Character';
    messages.push({ id: row.id, speaker, role: row.role, content: String(row.content) });
  }
  return { messages, cast: [...cast] };
}

async function connectionWithKey(e, row) {
  const conn = await e.connections.getWithKey(row.id);
  if (conn) return conn;
  let reason = null;
  try {
    reason = (await e.connections.unavailableReason?.(row.id))?.reason || null;
  } catch {}
  const why = {
    deleted: '이 연결이 지워졌습니다',
    review: '가져온 연결이라 마리나라에서 아직 검토(확인)를 기다리고 있습니다',
    off: '이 연결이 속한 연결 계정이 꺼져 있습니다',
    needs_key: '이 연결이 속한 연결 계정에 API 키가 없습니다',
  }[reason] || '마리나라가 이 연결을 지금 쓸 수 없다고 합니다';
  throw Error(`연결 "${row.name}"을(를) 쓸 수 없습니다: ${why}. 마리나라의 연결 설정을 확인하거나, 세계관 정보에서 다른 연결을 골라 주세요.`);
}

function connectionProvider(e, conn, baseUrl, apiKey = conn.apiKey) {
  return e.createLLMProvider(conn.provider, baseUrl, apiKey, conn.maxContext, conn.openrouterProvider, null,
    conn.claudeFastMode === 'true', conn.treatAsLocalEndpoint === 'true', conn.defaultParameters, conn.id || undefined);
}

/** DeepSeek thinks before answering unless told not to; reading and filing needs no thinking. */
function callOptions(conn, baseUrl) {
  const host = String(baseUrl || '').replace(/^https?:\/\//, '').split('/')[0].toLowerCase();
  const deepseek = conn.provider === 'deepseek' || /(^|\.)deepseek\.com(:\d+)?$/.test(host);
  const own = JSON.stringify(conn.defaultParameters ?? '');
  if (!deepseek || /thinking|reasoning/i.test(own)) return {};
  return { customParameters: { thinking: { type: 'disabled' } } };
}

async function model(connectionId) {
  const e = await engine();
  if (!connectionId) throw Error('자동 반영에 쓸 연결이 정해지지 않았습니다. 세계관 정보에서 연결을 골라 주세요.');
  const list = await e.connections.list();
  const row = list.find((c) => c.id === connectionId);
  if (!row) throw Error('자동 반영에 쓰던 연결을 찾지 못했습니다. 세계관 정보에서 연결을 다시 골라 주세요.');
  const conn = await connectionWithKey(e, row);
  const baseUrl = e.resolveBaseUrl(conn);
  if (!baseUrl) throw Error(`연결 "${row.name}"에 주소(base URL)가 없습니다.`);
  return { provider: connectionProvider(e, conn, baseUrl), model: conn.model, name: row.name, extra: callOptions(conn, baseUrl) };
}

async function askModel(m, messages, { maxTokens = 4096 } = {}) {
  const signal = AbortSignal.timeout(MODEL_TIMEOUT_MS);
  const base = { model: m.model, maxTokens, temperature: 0.2, signal, ...(m.extra || {}) };
  let reply;
  try {
    reply = await m.provider.chatComplete(messages, { ...base, responseFormat: { type: 'json_object' } });
  } catch (error) {
    if (!/response_format|json_object|responseFormat/i.test(String(error?.message))) throw error;
    reply = await m.provider.chatComplete(messages, base);
  }
  const content = reply?.content;
  if (!String(content ?? '').trim()) {
    throw Error(`모델(${m.name || m.model})이 빈 답을 보냈습니다. 생각(추론) 모드가 켜진 모델이면 연결 설정에서 생각 모드를 끄거나 다른 모델을 골라 주세요.`);
  }
  return { content: String(content), usage: reply?.usage || null };
}

/** The first complete JSON object in a model reply (code fences and <think> blocks ignored). */
function parseJsonObject(text) {
  const cleaned = String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json)?/gi, '');
  for (let start = cleaned.indexOf('{'); start !== -1; start = cleaned.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        try {
          return JSON.parse(cleaned.slice(start, i + 1));
        } catch {
          break;
        }
      }
    }
  }
  return null;
}

async function listConnections() {
  const e = await engine();
  return (await e.connections.list()).map((c) => ({ id: c.id, name: c.name, model: c.model, provider: c.provider }));
}

// ---------------------------------------------------------------- the 번역 프리셋·단어장 glossary (World Archive's own)
// Read in-process the way Marinara's own GET /api/personal-extensions/:id/storage reads it
// (packages/server/src/routes/personal-extensions.routes.ts): the extension from personal-extension-storage.service,
// its stored value from personal-extension-settings.service over app-settings.storage. Only an enabled, approved
// browser extension counts, as for that route. READ ONLY: nothing here writes to any extension or its storage.
const G = require('./glossary.cjs');

let extPromise = null;
function extensions() {
  extPromise ??= (async () => {
    const dist = serverDist();
    const load = (rel) => import(pathToFileURL(path.join(dist, rel)).href);
    const [db, installed, settings, appSettings] = await Promise.all([
      load('db/connection.js'),
      load('services/extensions/personal-extension-storage.service.js'),
      load('services/extensions/personal-extension-settings.service.js'),
      load('services/storage/app-settings.storage.js'),
    ]);
    const handle = await db.getDB();
    return {
      installed: installed.createPersonalExtensionsStorage(handle),
      settings: settings.createPersonalExtensionSettingsStorage(appSettings.createAppSettingsStorage(handle)),
    };
  })();
  extPromise.catch(() => (extPromise = null));
  return extPromise;
}

/**
 * The room's glossary text ("A = B" lines): config.chats[roomId].glossary, else config.defaults.glossary. null when the
 * extension is not installed, cannot be read, or has no glossary field — never '' for a failure.
 */
async function glossary(roomId) {
  try {
    const x = await extensions();
    const list = (await x.installed.list()).filter((e) => e?.runtime === 'client' && e.enabled && e.approvedHash === e.contentHash);
    const ext = G.findExtension(list);
    if (!ext) return null;
    return G.glossaryText(await x.settings.get(ext.id), roomId);
  } catch {
    return null;
  }
}

module.exports = { engine, chatMessages, model, askModel, parseJsonObject, listConnections, glossary };
