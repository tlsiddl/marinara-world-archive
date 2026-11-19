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
    '[세계관] 별빛 학원\n산 위의 기숙학교. 1988년.\n\n[인물]\n- 한여름 (다른 이름: 여름, Summer)\n  메모: 3학년 반장\n\n[장소]\n- 옥상 정원\n\n[규칙]\n- 통금\n  메모: 밤 10시',
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

test('fields: short ones share a line, long ones and extras get their own, in schema order', () => {
  const p = ent('person', '윤서하', '사서 선생님과 친함', {
    fields: { personality: '조용하지만 고집이 세다', gender: '여', affiliation: '도서부', state: '왼팔 깁스 (3장)', age: '16' },
    extra: [{ label: '좋아하는 것', value: '비 오는 날\n따뜻한 우유' }],
  });
  const out = assembleWorld(world, [p]);
  assert.equal(
    out.text.split('[인물]\n')[1],
    '- 윤서하\n  성별: 여 / 나이·생일: 16 / 소속: 도서부\n  성격: 조용하지만 고집이 세다\n  지금 상태: 왼팔 깁스 (3장)\n  좋아하는 것: 비 오는 날 / 따뜻한 우유\n  메모: 사서 선생님과 친함',
  );
  const c = ent('custom', '별자리 점', '매일 아침 게시판에 붙는다');
  assert.match(assembleWorld(world, [c]).text, /- 별자리 점\n {2}매일 아침 게시판에 붙는다$/);
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

test('scene order: pinned first, then settings named in the scene, then by kind', () => {
  const rule = ent('rule', '통금', '밤 10시');
  const a = ent('person', '가람');
  const b = ent('person', '나래');
  const pin = ent('place', '옥상', '', { pinned: true });
  const out = assembleWorld(world, [rule, a, b, pin], 3000, { scene: new Set([b.entityId, rule.entityId]) });
  assert.deepEqual(out.included, [pin.entityId, b.entityId, rule.entityId, a.entityId]);
  assert.equal(out.skipped, 0, 'mode all: nothing is left out for the scene');
  const tight = assembleWorld(world, [a, b], 42, { scene: new Set([b.entityId]) });
  assert.deepEqual([tight.included, tight.omitted], [[b.entityId], [a.entityId]], 'short on space: the one in the scene wins');
});

test('scene mode: pinned and rules always, the rest only when named in the scene', () => {
  const w = { ...world, injectMode: 'scene' };
  const rule = ent('rule', '통금');
  const pin = ent('person', '교장', '', { pinned: true });
  const here = ent('person', '한여름');
  const away = ent('place', '도서관');
  const draft = ent('person', '후보', '', { status: 'pending' });
  const all = [rule, pin, here, away, draft];
  const out = assembleWorld(w, all, 3000, { scene: new Set([here.entityId]) });
  assert.deepEqual(out.included.slice().sort(), [rule.entityId, pin.entityId, here.entityId].sort());
  assert.equal(out.skipped, 1, 'only confirmed settings are counted');
  assert.doesNotMatch(out.text, /도서관/);
  const fresh = assembleWorld(w, all, 3000);
  assert.equal(fresh.included.length, 4, 'no scene information yet: everything is a candidate');
  assert.equal(fresh.skipped, 0);
  assert.equal(assembleWorld(w, all, 3000, { scene: new Set() }).skipped, 2, 'an empty scene keeps only pinned and rules');
});
