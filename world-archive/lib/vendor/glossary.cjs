'use strict';
// The room's glossary of the 「번역 프리셋·단어장」 personal extension ("Severus Snape = 세베루스 스네이프" lines).
// Copied from the Memory Module (tlsiddl/marinara-memory-module, main 165d488):
//   memory-module/lib/translate.cjs  parseGlossary (with tidyName, foreignOnly, hangulOnly)
//   extension/runtime.js             syncGlossary: the extension found by its name, its storage's
//                                    config.chats[roomId].glossary, else config.defaults.glossary
// Changes: the storage is read on the server (see vendor/engine.cjs glossaryStorage) instead of from the browser;
// nothing is posted anywhere; World Archive's own names.
const GLOSSARY_EXTENSION = '번역 프리셋·단어장';

// Chinese characters (CJK unified ideographs and extension A). Hangul and Latin are counted apart.
const HAN = /[㐀-䶿一-鿿]/;
const tidyName = (s) => String(s ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
const hangulOnly = (s) => /[가-힣]/.test(s) && !/[A-Za-z]/.test(s);
/** A name or term written only in Latin letters or Chinese characters (no Hangul). */
const foreignOnly = (s) => (/[A-Za-z]/.test(s) || HAN.test(s)) && !/[가-힣]/.test(s);

/**
 * "A = B" lines → [{ from, to }] with the foreign side (Latin letters or Chinese characters) first. Only pairs of a
 * foreign and a Korean form are kept; anything else (two Korean words, a note) is left out.
 */
function parseGlossary(raw) {
  const out = [];
  const seen = new Set();
  const lines = Array.isArray(raw) ? raw.map((p) => (p && typeof p === 'object' ? `${p.from ?? p.left ?? p.original ?? ''} = ${p.to ?? p.right ?? p.translation ?? ''}` : String(p))) : String(raw || '').split(/\r?\n/);
  for (const line of lines) {
    const at = line.indexOf('=');
    if (at < 1) continue;
    const a = tidyName(line.slice(0, at));
    const b = tidyName(line.slice(at + 1));
    if (!a || !b || a.length > 60 || b.length > 60) continue;
    const pair = foreignOnly(a) && hangulOnly(b) ? { from: a, to: b } : foreignOnly(b) && hangulOnly(a) ? { from: b, to: a } : null;
    if (!pair || seen.has(pair.from.toLowerCase())) continue;
    seen.add(pair.from.toLowerCase());
    out.push(pair);
    if (out.length >= 300) break;
  }
  return out;
}

/** The extension among Marinara's personal extensions: the original and the 「(기억 서재 호환)」 edition both count. */
const findExtension = (list) => (Array.isArray(list) ? list : []).find((e) => typeof e?.name === 'string' && e.name.startsWith(GLOSSARY_EXTENSION)) || null;

/**
 * The glossary text for a room from the extension's stored value ({ config: { chats, defaults } }), or null when there
 * is none. A missing or unreadable config is not an empty glossary: null, never ''.
 */
function glossaryText(value, roomId) {
  const config = value?.config;
  if (!config || typeof config !== 'object') return null;
  const scope = config.chats?.[roomId] || config.defaults;
  return typeof scope?.glossary === 'string' ? scope.glossary : null;
}

module.exports = { GLOSSARY_EXTENSION, parseGlossary, findExtension, glossaryText, foreignOnly, hangulOnly };
