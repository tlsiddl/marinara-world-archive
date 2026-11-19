'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assembleWorld, sanitize } = require('../world-archive/lib/inject.cjs');

let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const ent = (type, name, description = '', extra = {}) => ({
  entityId: id(), type, name, aliases: [], description, status: 'confirmed', pinned: false, ...extra,
});
const world = { worldId: id(), name: '별빛 학원', description: '산 위의 기숙학교. 1988년.', injectChars: 3000 };

test('groups by kind in a fixed order with names and aliases', () => {
  const out = assembleWorld(world, [
    ent('rule', '통금', '밤 10시'),
    ent('person', '한여름', '3학년 반장', { aliases: ['여름', 'Summer'] }),
    ent('place', '옥상 정원'),
  ]);
  assert.equal(
    out.text,
    '[세계관] 별빛 학원\n산 위의 기숙학교. 1988년.\n\n[인물]\n- 한여름 (다른 이름: 여름, Summer) — 3학년 반장\n\n[장소]\n- 옥상 정원\n\n[규칙]\n- 통금 — 밤 10시',
  );
  assert.equal(out.chars, out.text.length);
  assert.equal(out.included.length, 3);
});

test('never goes over the budget; whole items only; smaller ones still fit', () => {
  const big = ent('person', '긴 설명', 'ㄱ'.repeat(200));
  const small = ent('person', '짧음', '한 줄');
  const out = assembleWorld(world, [big, small], 80);
  assert.ok(out.chars <= 80, `${out.chars} > 80`);
  assert.deepEqual(out.omitted, [big.entityId]);
  assert.deepEqual(out.included, [small.entityId]);
  for (const budget of [40, 60, 100, 150, 300, 1000]) {
    const r = assembleWorld(world, [big, small, ent('place', '도서관', '지하 1층')], budget);
    assert.ok(r.chars <= budget, `budget ${budget}: ${r.chars}`);
  }
});

test('pinned first: a pinned rule beats unpinned people when space is short', () => {
  const people = Array.from({ length: 10 }, (_, i) => ent('person', `학생${i}`, '평범한 학생'));
  const rule = ent('rule', '금지 구역', '북쪽 숲', { pinned: true });
  const out = assembleWorld(world, [...people, rule], 120);
  assert.ok(out.included.includes(rule.entityId));
});

test('only confirmed settings are injected', () => {
  const out = assembleWorld(world, [ent('person', '후보', '', { status: 'pending' }), ent('person', '확정')]);
  assert.doesNotMatch(out.text, /후보/);
  assert.match(out.text, /확정/);
});

test('settings cannot smuggle in macros', () => {
  const out = assembleWorld({ ...world, name: '{{user}}' }, [ent('person', '{{char}}', '{{기억}} {{세계}}')]);
  assert.doesNotMatch(out.text, /\{\{/);
  assert.doesNotMatch(out.text, /\}\}/);
  assert.equal(sanitize('{{a}}'), '{​{a}​}');
});

test('a world description larger than the budget is cut at a line break', () => {
  const w = { ...world, description: '첫 줄\n' + 'ㄴ'.repeat(500) };
  const out = assembleWorld(w, [], 60);
  assert.ok(out.chars <= 60);
  assert.equal(out.text, '[세계관] 별빛 학원\n첫 줄');
});

test('no world gives empty text', () => {
  assert.equal(assembleWorld(null, []).text, '');
});
