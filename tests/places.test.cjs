'use strict';
// v0.5.0 E — 장소 위치 · 본거지: places put inside places by their 「위치·소속」 칸 (code), the rest asked once (model);
// a group's 본거지 (made from its place-like other name when it has none); 「규칙 적용되는 곳 채우기」. Made-up world.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Archive } = require('../world-archive/lib/store.cjs');
const I = require('../world-archive/lib/inject.cjs');
const service = require('../world-archive/lib/service.cjs');
const real = require('../world-archive/lib/vendor/engine.cjs');

function world(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-pl-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new Archive(dir);
  service._test.useStore(s);
  const w = s.createWorld({ name: '별시계 학원', auto: { connectionId: 'c1' } });
  s.applyAuto(w.worldId, [
    { type: 'group', name: '별시계 학원', aliases: ['별시계', '별시계 성', 'Starclock Castle'] },
    { type: 'place', name: '별시계 지하', fields: { location: '별시계' } },
    { type: 'place', name: '은사슴 휴게실', fields: { location: '별시계 지하, 옛 회랑 끝' } },
    { type: 'place', name: '거울 호수', fields: { location: '별시계 성 아래 산기슭' } },
    { type: 'place', name: '별시계 급행 객실', fields: { location: '별시계 급행 3호차' } },
    { type: 'system', name: '별시계 급행 노선' },
    { type: 'place', name: '하르트 저택' },
    { type: 'place', name: '장미 온실' },
    { type: 'place', name: '은화 은행' },
  ]);
  const id = (n) => s.listEntities(w.worldId).find((e) => e.name === n)?.entityId;
  const up = (n) => s.listRelations(w.worldId).filter((r) => r.type === '위치' && r.from === id(n)).map((r) => s.listEntities(w.worldId).find((e) => e.entityId === r.to)?.name);
  return { s, w, id, up };
}

test('by code: the 「위치·소속」 칸 begins with a place (or a group: its 본거지, made from its other name); near is not in', (t) => {
  const { s, w, id, up } = world(t);
  const r = s.linkPlaces(w.worldId);
  assert.deepEqual(up('은사슴 휴게실'), ['별시계 지하']);
  assert.deepEqual(up('별시계 지하'), ['별시계 성'], 'in the group 별시계 학원: its 본거지, made from 「별시계 성」');
  const g = s.listEntities(w.worldId).find((e) => e.name === '별시계 학원');
  assert.equal(g.base, id('별시계 성'));
  assert.deepEqual(g.aliases, ['별시계'], 'the place-like other names moved to the new place');
  assert.deepEqual(s.listEntities(w.worldId).find((e) => e.name === '별시계 성').aliases, ['Starclock Castle']);
  assert.deepEqual(up('거울 호수'), [], '「아래 산기슭」: near, not in');
  assert.deepEqual(up('별시계 급행 객실'), [], '「별시계 급행 …」 is something else the world has (the train), not the school');
  assert.ok(r.left.includes(id('하르트 저택')) && r.left.includes(id('장미 온실')));
  // recorded and undoable: the 본거지
  const h = s.listHistory(w.worldId);
  assert.ok(h.some((c) => c.action === 'create' && c.name === '별시계 성'));
  assert.equal(h.filter((c) => c.action === 'alias-move').length, 2);
  const base = h.find((c) => c.action === 'base');
  s.undoChange(w.worldId, base.id);
  assert.equal(s.listEntities(w.worldId).find((e) => e.name === '별시계 학원').base, undefined);
});

test('「장소 위치 채우기」: code first, then the model once for what is left; a group named as outside means its 본거지', async (t) => {
  const { s, w, id, up } = world(t);
  // v0.7.2 B: joined only when the place's own text (위치 · 용도 · 설명 · 근거) names the outer one and says inside
  s.applyAuto(w.worldId, [{ type: 'place', name: '저택 서재', memo: '하르트 저택 안 2층 서재' }, { type: 'place', name: '시계 공방', memo: '별시계 학원 안의 작은 공방' }]);
  const asked = [];
  service._test.useEngine({
    model: async (cid) => ({ id: cid }),
    askModel: async (m, messages) => { asked.push(messages[1].content); return { content: JSON.stringify({ places: [
      { name: '장미 온실', in: '하르트 저택' },
      { name: '은화 은행', in: '없는 곳' },
      { name: '거울 호수', in: '별시계 학원' },
      { name: '저택 서재', in: '하르트 저택' },
      { name: '시계 공방', in: '별시계 학원' },
    ] }), usage: { prompt_tokens: 500, completion_tokens: 40 } }; },
    parseJsonObject: real.parseJsonObject,
  });
  const r = await service.fillPlaces(w.worldId);
  assert.equal(r.calls, 1);
  assert.ok(r.byCode.length >= 2);
  assert.deepEqual(r.byModel.map((x) => [x.name, x.in]), [['저택 서재', '하르트 저택'], ['시계 공방', '별시계 학원']]);
  assert.deepEqual(up('저택 서재'), ['하르트 저택']);
  assert.deepEqual(up('시계 공방'), ['별시계 성'], 'the group → its 본거지');
  assert.deepEqual(up('장미 온실'), [], 'a guess from the names alone is not taken');
  assert.deepEqual(up('거울 호수'), [], '「성 아래 산기슭」 does not say inside');
  assert.match(asked[0], /\[혼자인 장소\][\s\S]*은화 은행/);
  assert.match(asked[0], /설명: 하르트 저택 안 2층 서재/);
  assert.ok(r.left.includes('은화 은행') && r.left.includes('하르트 저택'));
  assert.equal(r.big, r.left.length);
  void id;
});

test('「규칙 적용되는 곳 채우기」: once for the empty ones; 세계 전체 · a place · a group; the person\'s untouched; unknown stays', async (t) => {
  const { s, w, id } = world(t);
  s.applyAuto(w.worldId, [{ type: 'rule', name: '마법은 지팡이로' }, { type: 'rule', name: '지하에서는 소등' }, { type: 'rule', name: '누구 것인지 모름' }, { type: 'rule', name: '직접 정한 규칙' }]);
  const mine = s.listEntities(w.worldId).find((e) => e.name === '직접 정한 규칙');
  s.setAppliesTo(w.worldId, mine.entityId, id('하르트 저택'), {}, { force: true });
  let prompt = '';
  service._test.useEngine({
    model: async (cid) => ({ id: cid }),
    askModel: async (m, messages) => { prompt = messages[1].content; return { content: JSON.stringify({ rules: [
      { name: '마법은 지팡이로', where: '세계 전체' }, { name: '지하에서는 소등', where: '별시계 지하' }, { name: '직접 정한 규칙', where: '세계 전체' },
    ] }) }; },
    parseJsonObject: real.parseJsonObject,
  });
  const r = await service.fillApplies(w.worldId);
  assert.equal(r.asked, 4, 'three rules and the train system, not the person\'s one');
  assert.doesNotMatch(prompt, /직접 정한 규칙/);
  const by = (n) => s.listEntities(w.worldId).find((e) => e.name === n);
  assert.equal(by('마법은 지팡이로').appliesTo, 'world');
  assert.equal(by('지하에서는 소등').appliesTo, id('별시계 지하'));
  assert.equal(by('누구 것인지 모름').appliesTo, undefined);
  assert.equal(by('직접 정한 규칙').appliesTo, id('하르트 저택'));
  assert.ok(s.listHistory(w.worldId).some((c) => c.action === 'applies' && c.by === 'applies-fill'));
});

test('{{세계}} scene: a group\'s 본거지 is here, and so are the groups whose 본거지 is a place of the scene', (t) => {
  const { s, w, id } = world(t);
  s.linkPlaces(w.worldId);
  s.applyAuto(w.worldId, [{ type: 'rule', name: '학원 안에서는 망토', appliesTo: id('별시계 학원') }, { type: 'rule', name: '저택에서는 하인이 문을', appliesTo: id('하르트 저택') }]);
  const E = s.listEntities(w.worldId);
  const R = s.listRelations(w.worldId);
  const names = (scene) => I.assembleWorld({ ...s.getWorld(w.worldId), injectMode: 'scene' }, E, 5000, { scene: new Set(scene), relations: R }).included.map((x) => E.find((e) => e.entityId === x).name);
  const inHall = names([id('은사슴 휴게실')]);
  assert.ok(inHall.includes('학원 안에서는 망토'), 'the room → 별시계 지하 → 별시계 성, the 본거지 of 별시계 학원 → its rule');
  assert.ok(!inHall.includes('저택에서는 하인이 문을'));
});

test('base by hand is theirs; merging a place moves the 본거지 along', (t) => {
  const { s, w, id } = world(t);
  s.setBase(w.worldId, id('별시계 학원'), id('하르트 저택'), {}, { force: true });
  assert.equal(s.setBase(w.worldId, id('별시계 학원'), id('장미 온실'), { by: 'reader' }), null);
  const keep = s.listEntities(w.worldId).find((e) => e.name === '장미 온실');
  const drop = s.listEntities(w.worldId).find((e) => e.name === '하르트 저택');
  s.mergeEntities(w.worldId, { keepId: keep.entityId, dropId: drop.entityId, keepRevision: keep.revision, dropRevision: drop.revision });
  assert.equal(s.listEntities(w.worldId).find((e) => e.name === '별시계 학원').base, keep.entityId);
  assert.throws(() => s.setBase(w.worldId, id('별시계 학원'), id('별시계 학원')), (e) => e.status === 400);
});

test('underground under a building is in it (「지하 선착장 · 성 기초 바로 아래」); under a bridge or a cliff is not', (t) => {
  const { s, w, up } = world(t);
  s.applyAuto(w.worldId, [
    { type: 'place', name: '별시계 지하 선착장', fields: { location: '별시계 성 기초 바로 아래, 절벽 밑 수로 끝' } },
    { type: 'place', name: '돌다리 밑 지하 동굴', fields: { location: '거울 호수 아래 절벽' } },
  ]);
  s.linkPlaces(w.worldId);
  assert.deepEqual(up('별시계 지하 선착장'), ['별시계 성']);
  assert.deepEqual(up('돌다리 밑 지하 동굴'), [], 'a lake is not a building');
});
