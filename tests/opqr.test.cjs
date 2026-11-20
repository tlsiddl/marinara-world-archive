'use strict';
// v0.5.0 O · P · Q · R — other names are names; passing things are not kept and old ones are only offered; 성격 ·
// 메모 without a scene's events; a described name its sentence does not back is marked. Made-up world only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Archive, nameLike } = require('../world-archive/lib/store.cjs');
const X = require('../world-archive/lib/extract.cjs');
const service = require('../world-archive/lib/service.cjs');
const real = require('../world-archive/lib/vendor/engine.cjs');

const msg = (i, content, speaker = i % 2 ? '서하' : '나') => ({ id: `m${i}`, speaker, role: i % 2 ? 'assistant' : 'user', content });
function world(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-op-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new Archive(dir);
  service._test.useStore(s);
  const w = s.createWorld({ name: '별시계 학원', auto: { connectionId: 'c1' } });
  return { s, w, by: (n) => s.listEntities(w.worldId).find((e) => e.name === n) };
}

test('O: names, not pieces of sentences — new ones filtered, old ones taken off by 「관계 다시 보기」 (not the person\'s), undoable', async (t) => {
  for (const ok of ['Starclock School of Stars and Bells', "Madam Rue's Robes for All Occasions", '은사슴', 'Rue Makers since 382 B.C.', 'Madam Rue']) assert.ok(nameLike(ok), ok);
  // v0.6.2 ⑤ (사령탑): a phrase that starts small (「the bar」 · 「third shelf」 — 「the dungeons」 too now) and a lone title or common word are not names
  for (const no of ['the dungeons', 'the bar', 'third shelf', 'charm for it', 'Professor', 'Goblin', 'Madam']) assert.ok(!nameLike(no), no);
  for (const no of ['Professor Noel pulls the bolt back', 'oil the pivot pin', 'Kneazles know when someone\'s lying', 'tiny, high-walled brick courtyard', '키 큰 검은 머리에 은색 배지를 단 소녀', '"그만해."']) assert.ok(!nameLike(no), no);
  const { s, w, by } = world(t);
  s.applyAuto(w.worldId, [{ type: 'person', name: '노을 교수', aliases: ['Professor Noel', 'Professor Noel pulls the bolt back'] }]);
  assert.deepEqual(by('노을 교수').aliases, ['Professor Noel']);
  // old data (made before O) and the person's own
  const doc = s.readEntities(w.worldId);
  doc.entities.find((e) => e.name === '노을 교수').aliases.push('oil the pivot pin');
  s.writeJson(s.entityFile(w.worldId), doc);
  s.applyAuto(w.worldId, [{ type: 'place', name: '탑 계단' }]);
  const stair = by('탑 계단');
  s.updateEntity(w.worldId, stair.entityId, { revision: stair.revision, aliases: ['the stairs that move, slowly'] });
  const r = await (async () => { const f = s.tidyAliases(w.worldId); return f; })();
  assert.deepEqual(r.map((c) => c.alias), ['oil the pivot pin']);
  assert.deepEqual(by('탑 계단').aliases, ['the stairs that move, slowly'], 'the person\'s: kept');
  s.undoChange(w.worldId, r[0].id);
  assert.ok(by('노을 교수').aliases.includes('oil the pivot pin'));
});

test('P: a passing thing is not kept (lasting false); 「잡다한 설정 정리」 offers candidates only — nothing deleted', async (t) => {
  const [part] = X.batches([msg(1, '기숙사 암호는 2주마다 바뀐다. 노을 교수가 첫 질문을 했다.')], 0);
  const r = X.checkItems({ items: [
    { type: 'rule', name: '기숙사 암호는 2주마다 바뀐다', lasting: true, evidence: [{ n: '1.1', q: '기숙사 암호는' }] },
    { type: 'system', name: '첫 수업의 질문', lasting: false, evidence: [{ n: '1.2', q: '첫 질문을' }] },
  ] }, part, ['서하', '나']);
  assert.deepEqual(r.items.map((i) => i.name), ['기숙사 암호는 2주마다 바뀐다']);
  assert.deepEqual(r.dropped.map((d) => d.why), ['not lasting']);
  const p = X.buildPrompt({ name: 'x' }, [], part, [])[0].content;
  assert.match(p, /lasting을 적는다/);
  assert.match(p, /personality\(성격\)에는 버릇 · 기질만/, 'Q');
  const { s, w, by } = world(t);
  s.applyAuto(w.worldId, [
    { type: 'system', name: '욕실 수도꼭지', fields: { how: '돌리면 물이 나온다' } },
    { type: 'rule', name: '기숙사 암호', fields: { category: '출입' } },
    { type: 'person', name: '노을 교수', fields: { personality: '하윤에게 겁을 줌' } },
  ]);
  let asked = '';
  service._test.useEngine({
    model: async (cid) => ({ id: cid }),
    askModel: async (m, messages) => { asked = messages[1].content; return { content: JSON.stringify({ items: [{ name: '욕실 수도꼭지', keep: false, why: '한 번 스침' }], fields: [{ name: '노을 교수', key: 'personality', why: '그 장면의 행동' }] }) }; },
    parseJsonObject: real.parseJsonObject,
  });
  const out = await service.tidyCandidates(w.worldId);
  assert.deepEqual([out.items.map((x) => x.name), out.fields.map((x) => [x.name, x.key])], [['욕실 수도꼭지'], [['노을 교수', 'personality']]]);
  assert.match(asked, /욕실 수도꼭지[\s\S]*노을 교수 :: 성격/);
  assert.ok(by('욕실 수도꼭지') && by('노을 교수').fields.personality, 'nothing deleted');
  assert.equal(s.readTidy(w.worldId).items.length, 1, 'kept for the person to pick');
  s.keepTidy(w.worldId, by('욕실 수도꼭지').entityId);
  assert.equal(s.readTidy(w.worldId).items.length, 0, '「남기기」');
  const e = by('노을 교수');
  s.updateEntity(w.worldId, e.entityId, { revision: e.revision, fields: { ...e.fields, personality: '' } });
  assert.equal(s.readTidy(w.worldId).fields.length, 0, 'an emptied field is no longer offered');
});

test('R: 「○○의 누나」 whose sentence names another person the world has is marked 「이름 확인 필요」; renaming takes it off', async (t) => {
  const people = [{ name: '은하 블레어', aliases: ['Eunha'] }, { name: '가람 셀린', aliases: ['Garam'] }];
  assert.deepEqual(X.whoseCheck('가람의 5학년 누나', 'Having grown up with an older brother and a fifth-year sister, Eunha knew', people), { said: '은하 블레어' });
  assert.equal(X.whoseCheck('가람의 5학년 누나', 'Garam and his fifth-year sister', people), null, 'it says 가람 (Garam): agrees');
  assert.equal(X.whoseCheck('가람의 누나', '가람의 누나가 왔다', people), null);
  assert.equal(X.whoseCheck('하윤', 'Eunha', people), null, 'not a described name');
  const { s, w, by } = world(t);
  s.applyAuto(w.worldId, [{ type: 'person', name: '가람의 5학년 누나', nameCheck: { said: '은하 블레어' } }]);
  const e = by('가람의 5학년 누나');
  assert.deepEqual(e.nameCheck, { said: '은하 블레어' });
  s.updateEntity(w.worldId, e.entityId, { revision: e.revision, name: '은하의 5학년 언니' });
  assert.equal(by('은하의 5학년 언니').nameCheck, undefined);
});
