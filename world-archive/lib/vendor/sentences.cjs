'use strict';
// Numbered sentences and evidence by number, as the Memory Module does it.
// Copied from tlsiddl/marinara-memory-module main 165d488, memory-module/lib/ledger.cjs:
//   segment, splitSentences, splitSentencesWith, squash, resolveEvidence (unchanged), indexBatch (keyed by message
//   number and sentence, without the Memory Module's message fields).

/** Split one message into numbered sentences. Paragraph breaks always split; sentence ends split inside a paragraph. */
function segment(text, strict = false) {
  const out = [];
  for (const paragraph of String(text || '').split(/\n+/)) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;
    for (const part of splitSentences(trimmed, strict)) {
      const sentence = part.trim();
      if (sentence) out.push(sentence);
    }
  }
  return out;
}

const OPENERS = { '“': '”', '「': '」', '『': '』', '(': ')' };
const ENDERS = new Set(['.', '!', '?', '…', '。', '？', '！']);
const CLOSERS_AFTER_END = new Set(['”', '"', '’', "'", ')', ']', '」', '』']);

/** Split at sentence ends followed by a space, but never inside a quote or parentheses. */
function splitSentences(paragraph, strictOnly = false) {
  const strict = splitSentencesWith(paragraph, false);
  // strictOnly: the reading before v0.11.48, kept so lines saved from it can be recognised (never used to number).
  if (strictOnly || !strict.unclosed) return strict.parts;
  // Only a paragraph the strict reading leaves with an unclosed quote is read again, with " “ ” as one kind of
  // quote mark (a model opens with one and closes with another) and an inch mark (5") ignored. Any other
  // paragraph keeps exactly the split it always had, so saved sentence numbers do not move.
  const mixed = splitSentencesWith(paragraph, true);
  return mixed.unclosed ? strict.parts : mixed.parts;
}

function splitSentencesWith(paragraph, mixed) {
  const parts = [];
  const stack = [];
  let straightOpen = false;
  let start = 0;
  for (let i = 0; i < paragraph.length; i++) {
    const ch = paragraph[i];
    if (mixed && (ch === '“' || ch === '”')) straightOpen = !straightOpen;
    else if (ch === '"') {
      if (!(mixed && /\d/.test(paragraph[i - 1] || ''))) straightOpen = !straightOpen;
    } else if (OPENERS[ch] && !(mixed && ch === '“')) stack.push(OPENERS[ch]);
    else if (stack.length && ch === stack[stack.length - 1]) stack.pop();
    if (stack.length || straightOpen) continue;
    if (ENDERS.has(ch) || (CLOSERS_AFTER_END.has(ch) && ENDERS.has(paragraph[i - 1]))) {
      let j = i + 1;
      while (j < paragraph.length && CLOSERS_AFTER_END.has(paragraph[j]) && paragraph[j] !== '"') j++;
      if (j < paragraph.length && /\s/.test(paragraph[j])) {
        parts.push(paragraph.slice(start, j));
        start = j;
        i = j;
      }
    }
  }
  const rest = paragraph.slice(start);
  // An unclosed quote would swallow the rest of the paragraph: split that rest plainly instead.
  const unclosed = straightOpen || stack.length > 0;
  if (unclosed) parts.push(...rest.split(/(?<=[.!?…。？！])\s+(?=\S)/u));
  else parts.push(rest);
  return { parts, unclosed };
}

function squash(text) {
  return String(text || '').replace(/[\s"'“”‘’.,!?…~·()\[\]<>|]/g, '').toLowerCase();
}

function resolveEvidence(items, batchIndex) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(items) ? items : []) {
    const number = String(typeof raw === 'object' && raw ? raw.n ?? raw.id ?? '' : raw).replace(/[\[\]\s#]/g, '');
    const phrase = typeof raw === 'object' && raw ? squash(raw.q) : '';
    let pointer = batchIndex.get(number) || null;
    if (phrase.length >= 2 && !(pointer && squash(pointer.text).includes(phrase))) {
      const found = [...batchIndex.values()].find((p) => squash(p.text).includes(phrase));
      if (found) pointer = found;
    }
    const key = pointer && `${pointer.number}.${pointer.sentence}`;
    if (pointer && !seen.has(key)) {
      seen.add(key);
      out.push(pointer);
    }
  }
  return out;
}

/** batch: [{ id, number, sentences }] → Map('12.3' → { messageId, number, sentence, text }). */
function indexBatch(batch) {
  const index = new Map();
  for (const message of batch) {
    message.sentences.forEach((text, i) => {
      index.set(`${message.number}.${i + 1}`, { messageId: message.id, number: message.number, sentence: i + 1, text });
    });
  }
  return index;
}

module.exports = { segment, squash, resolveEvidence, indexBatch };
