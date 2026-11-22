#!/usr/bin/env node
'use strict';
/**
 * 화면 확인 · 스크린샷용 시험대 (지어낸 세계 「은사슴 학교」만). 실서버 · 진짜 채팅에 닿지 않는다.
 *   node tools/demo-server.cjs [port=18740]
 *   /           설정집 단독 화면(떠 있는 버튼 → 창)
 *   /embedded   기억 서재의 「세계관」 칸처럼 끼워 넣은 화면(기억 서재 틀은 흉내만)
 *   /api/world-archive/*  이 컴퓨터 임시 폴더의 설정집 서버 코드 그대로(쓰기도 됨, 끄면 사라짐)
 * 스크린샷: 브라우저가 찍은 JPG를 /shot?f=<경로>로 읽고 캔버스로 WEBP를 만들어 /save-webp?name=로 보내면 docs/screenshots/에 저장.
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const REPO = path.join(__dirname, '..');
const service = require(path.join(REPO, 'world-archive/lib/service.cjs'));
const { Archive } = require(path.join(REPO, 'world-archive/lib/store.cjs'));

const port = Number(process.argv[2] || 18740);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-demo-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
process.on('SIGINT', () => process.exit(0));
const s = new Archive(dir);
service._test.useStore(s);

// ------------------------------------------------------------------ the made-up world
const ROOM = 'demo-room';
const w = s.createWorld({ name: '[시험] 은사슴 학교', description: '산 위의 마법 기숙학교와 그 아래 마을. 지어낸 세계(시험용).', injectChars: 3000, injectMode: 'scene' });
s.updateWorld(w.worldId, { revision: s.getWorld(w.worldId).revision, yearStart: 9 });
const W = w.worldId;
const P = (name, fields = {}, more = {}) => ({ type: 'place', name, fields, ...more });
s.applyAuto(W, [
  P('은사슴 학교', { use: '산 위의 마법 기숙학교' }, { memo: '산 위의 마법 기숙학교.' }),
  P('별시계탑', { use: '천문 관측 · 별자리학 교실' }), P('대식당', { use: '세 끼 식사 · 연회' }), P('은사슴 기숙사', { use: '은사슴 학생들의 기숙사' }),
  P('1학년 침실', { layout: '침대 다섯 개가 창가에' }), P('약초 온실'), P('지하 마법약 교실'), P('운동장'), P('대강의실'), P('2층 교실'),
  P('하르트 저택', { use: '하르트 가문의 저택' }), P('저택 서재'), P('장미 정원'), P('별빛 시장', { use: '마을 장터' }), P('지팡이 가게'), P('찻집 「은방울」'),
]);
const id = (n) => s.listEntities(W).find((e) => e.name === n).entityId;
const inside = [['별시계탑', '은사슴 학교'], ['대식당', '은사슴 학교'], ['은사슴 기숙사', '은사슴 학교'], ['1학년 침실', '은사슴 기숙사'], ['약초 온실', '은사슴 학교'], ['지하 마법약 교실', '은사슴 학교'], ['운동장', '은사슴 학교'], ['대강의실', '은사슴 학교'], ['2층 교실', '은사슴 학교'], ['저택 서재', '하르트 저택'], ['장미 정원', '하르트 저택'], ['지팡이 가게', '별빛 시장'], ['찻집 「은방울」', '별빛 시장']];
s.applyRelations(W, inside.map(([a, b]) => ({ from: id(a), to: id(b), type: '위치', note: '', evidence: '' })));
s.applyAuto(W, [
  { type: 'group', name: '은사슴 기숙사생', aliases: ['은사슴'], fields: { kind: '기숙사', size: '40명' } },
  { type: 'group', name: '은사슴 1학년', fields: { kind: '학년', size: '12명', members: '남학생 일곱 명, 여학생 다섯 명' } },
  { type: 'group', name: '하르트 가문', fields: { kind: '가문' } },
  { type: 'group', name: '별빛 시장 상인회', fields: { kind: '상인 조합', size: '9명' } },
]);
s.setBase(W, id('은사슴 기숙사생'), id('은사슴 기숙사'), {}, { force: true });
s.setBase(W, id('하르트 가문'), id('하르트 저택'), {}, { force: true });
s.setBase(W, id('별빛 시장 상인회'), id('별빛 시장'), {}, { force: true });
const person = (name, fields, more = {}) => ({ type: 'person', name, fields, ...more });
s.applyAuto(W, [
  person('하람 윤', { gender: '여', affiliation: '은사슴 1학년', appearance: '짧은 은발, 둥근 안경', personality: '조용하지만 고집이 셈' }),
  person('테오 마렌', { gender: '남', affiliation: '은사슴 1학년' }), person('리아 소넷', { gender: '여', affiliation: '은사슴 1학년' }),
  person('쌍둥이 중 한 명', { affiliation: '은사슴 1학년' }), person('노엘 바스', { gender: '남', affiliation: '은사슴 1학년' }),
  person('미라 엘든', { gender: '여', affiliation: '은사슴 1학년' }), person('카이 로웰', { gender: '남', affiliation: '은사슴 1학년' }),
  person('벨로나 하르트', { gender: '여', affiliation: '은사슴 기숙사생 사감, 하르트 가문' }), person('에밀 그랑', { gender: '남', affiliation: '은사슴 기숙사생 5학년 반장' }),
  person('세라핀 은사슴', { gender: '여', affiliation: '은사슴 기숙사생 창립자' }), person('오스윈 하르트', { gender: '남', affiliation: '하르트 가문' }),
  person('솜뭉치', { species: '고양이', appearance: '흰 털, 한쪽 귀 끝이 검음' }), person('지팡이 가게 주인', { affiliation: '별빛 시장 상인회' }),
]);
s.linkSubgroups(W); s.linkAffiliations(W);
// people who know each other from the start (연동 v2: 기억 서재 「인물별」 카드의 관계)
s.applyRelations(W, [['하람 윤', '테오 마렌', '친구', ''], ['하람 윤', '벨로나 하르트', '스승·제자', '기숙사 사감'], ['하람 윤', '솜뭉치', '가족', '반려동물']].map(([a, b, type, note]) => ({ from: id(a), to: id(b), type, note, evidence: '' })));
for (const [n, room] of [['하람 윤', '1학년 침실'], ['리아 소넷', '1학년 침실']]) s.setRoom(W, id(n), id(room), {}, { force: true });
const rule = (name, memo, where, type = 'rule') => ({ type, name, memo, ...(where ? { appliesTo: where === 'world' ? 'world' : id(where) } : {}) });
s.applyAuto(W, [
  rule('통금', '밤 10시 이후 복도 출입 금지', '은사슴 학교'), rule('기숙사 암호', '매주 월요일 바뀜 · 사감이 알려 줌', '은사슴 기숙사'), rule('점수 제도', '기숙사별 점수, 학기 말 우승컵', '은사슴 학교', 'system'),
  rule('지팡이 없는 마법', '지팡이 없이 쓰면 힘이 흩어진다', 'world', 'system'), rule('화폐', '은화 하나는 동화 스물', 'world', 'system'), rule('머글 앞 마법 금지', '마법을 모르는 사람 앞에서 마법을 쓰지 않는다', 'world'),
  rule('부엉이 우편', '편지는 부엉이로 보낸다', 'world', 'system'), rule('미성년 마법 제한', '방학 중 학교 밖 마법 금지', 'world'), rule('달밤의 늑대', '보름달 밤에는 숲에 가지 않는다', 'world'),
  rule('저택 정원 출입', '하르트 가문 허락이 있어야 함', '하르트 저택'), rule('장날', '매주 토요일 장이 선다', '별빛 시장'),
  rule('흥정 예절', '값을 두 번 넘게 깎으면 무례로 여긴다', '별빛 시장'), rule('시장 은화 저울', '은화는 상인회 저울로 달아 받는다', '별빛 시장', 'system'), rule('상인회 유래', '백 년 전 떠돌이 상인들이 모여 만든 모임에서 시작됐다', '별빛 시장'),
  rule('지팡이 고르는 법', '손님이 고르지 않고 지팡이가 주인을 고른다 — 맞는 지팡이를 쥐면 끝에서 불꽃이 인다', '지팡이 가게', 'system'), rule('지팡이 가게 영업시간', '해 질 녘에 문을 닫고 장날에는 늦게까지 연다', '지팡이 가게'),
  rule('찻집 조용히', '안쪽 자리에서는 큰 소리로 말하지 않는다', '찻집 「은방울」'), rule('찻값', '차 한 잔에 동화 셋, 점심때는 과자 하나가 딸려 나온다', '찻집 「은방울」'),
  rule('은사슴의 맹세', '입학 때 하는 맹세 — 어디 것인지 모름'), rule('손목 리본', '1학년은 은색 리본을 단다'),
]);
// v0.7.0 5: 주제 — most set (the reader's), a few left for 「주제 채우기」
for (const [n, t] of [['통금', '금지·예절'], ['기숙사 암호', '방법·기술'], ['점수 제도', '그 밖'], ['지팡이 없는 마법', '방법·기술'], ['화폐', '돈·거래'], ['머글 앞 마법 금지', '금지·예절'], ['부엉이 우편', '방법·기술'], ['미성년 마법 제한', '금지·예절'], ['저택 정원 출입', '금지·예절'], ['장날', '시간·영업'], ['흥정 예절', '금지·예절'], ['시장 은화 저울', '돈·거래'], ['상인회 유래', '유래·역사'], ['지팡이 고르는 법', '방법·기술'], ['지팡이 가게 영업시간', '시간·영업'], ['찻집 조용히', '금지·예절'], ['찻값', '돈·거래']]) s.setTopic(W, id(n), t, { by: 'reader' });
// v0.7.0 3: settings written in English (an English room's reading) — 「보기: 한국어」 shows them in Korean
const EN_KO = {
  'Edwin Ashcombe': '에드윈 애시컴',
  'Tall, with ink-stained fingers and a grey wool scarf he never takes off.': '키가 크고, 손가락에 잉크 얼룩이 있으며 절대 벗지 않는 회색 털목도리를 두른다.',
  'Quiet and patient; answers a question with another question.': '조용하고 참을성이 많다. 질문에 질문으로 답한다.',
  'Keeper of the Starclock archive since the old librarian retired.': '옛 사서가 물러난 뒤로 별시계 기록 보관소를 맡고 있다.',
  'archivist': '기록 보관인',
  'Quiet and patient; fond of tea.': '조용하고 참을성이 많다. 차를 좋아한다.',
  'Archive hours': '기록 보관소 이용 시간',
  'The archive opens at dawn and closes when the tower bell rings nine. Candles are not allowed inside.': '기록 보관소는 새벽에 열고 탑의 종이 아홉 번 울리면 닫는다. 안에서는 촛불을 켤 수 없다.',
};
s.applyAuto(W, [
  person('Edwin Ashcombe', { appearance: 'Tall, with ink-stained fingers and a grey wool scarf he never takes off.', personality: 'Quiet and patient; answers a question with another question.', background: 'Keeper of the Starclock archive since the old librarian retired.', affiliation: 'archivist' }),
  { type: 'rule', name: 'Archive hours', description: 'The archive opens at dawn and closes when the tower bell rings nine. Candles are not allowed inside.', appliesTo: id('별시계탑') },
]);
s.setTopic(W, id('Archive hours'), '시간·영업', { by: 'reader' });
s.updateWorld(W, { revision: s.getWorld(W).revision, auto: { connectionId: 'demo' } });
service._test.useEngine({
  model: async (cid) => ({ id: cid }),
  // the made-up translator: each numbered line of [글] from EN_KO (Korean → English for 되돌리기), else marked
  askModel: async (m, messages) => {
    const lines = String(messages[1].content).split('[글]\n')[1].split('\n').map((l) => l.replace(/^\d+\.\s*/, ''));
    const back = Object.fromEntries(Object.entries(EN_KO).map(([a, b]) => [b, a]));
    const t = lines.map((l) => EN_KO[l] || back[l] || (/[가-힣]/.test(l) ? `(EN) ${l}` : `(한국어) ${l}`));
    return { content: JSON.stringify({ t }), usage: {} };
  },
  parseJsonObject: (t) => { try { return JSON.parse(t); } catch { return null; } },
  chatMessages: async () => ({ messages: [], cast: [] }),
});
s.applyTimetable(W, [
  ['월', '1교시', '별자리학', '별시계탑'], ['월', '2교시', '마법 역사', '대강의실'], ['화', '1교시', '약초학', '약초 온실', 2], ['수', '1교시', '변환술', '2층 교실', 2],
  ['목', '1교시', '별자리학', '별시계탑'], ['목', '2교시', '비행', '운동장'], ['금', '1교시', '마법약', '지하 마법약 교실', 2], ['수', '밤', '천문 관측 23:00', '별시계탑'],
].map(([day, slot, value, place, hours]) => ({ ownerId: id('은사슴 1학년'), day, slot, value, subject: value.replace(/ \d.*$/, ''), place, placeId: id(place), ...(hours ? { hours } : {}) })), { by: 'person', year: '1891–92' });
// one cell changed later (「이전」)
s.applyTimetable(W, [{ ownerId: id('은사슴 1학년'), day: '금', slot: '1교시', value: '변환술', subject: '변환술', place: '2층 교실' }], { year: '1891–92' });
s.applyTimetable(W, [{ ownerId: id('은사슴 1학년'), day: '금', slot: '1교시', value: '마법약', subject: '마법약', place: '지하 마법약 교실', hours: 2 }], { year: '1891–92' });
const ev = (date, name, place, who, more = {}) => ({ ownerId: id('은사슴 학교'), date, name, place, who, ...more });
s.applyCalendar(W, [
  ev('1890-09-01', '입학식 · 기숙사 배정', '대식당', '1학년 전체'), ev('1891-06-20', '학년 말 우승컵', '대식당', '전교생'),
  ev('1891-09-01', '입학식 · 기숙사 배정', '대식당', '1학년 전체'), ev('1891-09-14', '첫 비행 수업 시험', '운동장', '1학년'),
  ev('1891-10-24', '가을밤 연회', '대식당', '전교생'), ev('1891-10-22', '별빛 시장 견학', '별빛 시장', '1학년'),
  ev('1891-11-12', '첫 비행 경기 · 은사슴 대 청매', '운동장', ''), ev('1891-12-20', '겨울 방학', '', '', { end: '1892-01-06' }),
  ev('1892-09-01', '입학식 · 기숙사 배정', '대식당', '1학년 전체'), ev('--05-01', '은사슴 축제', '운동장', '전교생'),
], { yearStart: 9 });
s.applyCalendar(W, [ev('1891-10-31', '가을밤 연회', '대식당', '전교생'), ev('1891-10-22', '별빛 시장 견학', '별빛 시장', '1학년', { cancelled: true })], { yearStart: 9 });
s.linkRoom(ROOM, W);
s.setRoomStory(ROOM, { date: '1891-10-26', weekday: '월' });

// ------------------------------------------------------------------ 공지 그림용 더하기 (notice/pages 브랜치, 지어낸 것만)
{
  const ent = (n, w = W) => s.listEntities(w).find((e) => e.name === n);
  s.updateWorld(W, { revision: s.getWorld(W).revision, personFields: ['house', 'year'] });
  // v0.7.6 · v0.8.1: 머리색 · 눈색 · 기숙사 · 학년 (읽기가 채운 것처럼)
  s.applyAuto(W, [
    person('하람 윤', { hair: '은발', eyes: '회색', house: '은사슴', year: '1', age: '11' }, { match: '하람 윤' }),
    person('테오 마렌', { hair: '갈색 곱슬', eyes: '초록', house: '은사슴', year: '1', age: '11', appearance: '갈색 곱슬머리에 초록 눈, 늘 소매를 걷어 올림' }, { match: '테오 마렌' }),
    person('리아 소넷', { hair: '붉은', eyes: '갈색', house: '은사슴', year: '1' }, { match: '리아 소넷' }),
    person('에밀 그랑', { hair: '검은', eyes: '푸른', house: '은사슴', year: '5' }, { match: '에밀 그랑' }),
    person('벨로나 하르트', { hair: '잿빛', eyes: '회색', appearance: '잿빛 머리를 단단히 틀어 올리고 은테 안경을 씀', personality: '엄하지만 공정함' }, { match: '벨로나 하르트' }),
    person('솜뭉치', { hair: '흰' }, { match: '솜뭉치' }),
  ]);
  // 덧칸(직접 이름 붙인 칸) · 사람이 고친 칸 — 기록에 「직접 고침」으로 남음
  let e = ent('하람 윤');
  s.updateEntity(W, e.entityId, { revision: e.revision, extra: [{ label: '지팡이', value: '벚나무 · 11인치 · 유니콘 털', source: 'manual' }, { label: '좋아하는 과목', value: '별자리학', source: 'manual' }] });
  const doc = s.readEntities(W);
  const at = new Date().toISOString();
  const d = (n) => doc.entities.find((x) => x.name === n);
  // 「아직 드러나지 않음」: 프로필 블록에만 있고 이야기에는 아직 안 나온 칸
  d('하람 윤').hidden = { personality: true };
  d('벨로나 하르트').hidden = { personality: true };
  // 「서로 다른 말을 해요」: 칸 — 테오 나이 11 ↔ 12
  d('테오 마렌').differs = { age: { value: '12', evidence: '「테오는 지난주에 열두 살이 됐어.」 미라가 말했다.', at } };
  // 「서로 다른 말을 해요」: 위치 관계 — 찻집이 시장 안 ↔ 시장이 찻집 안
  const cafe = d('찻집 「은방울」').entityId, market = d('별빛 시장').entityId;
  const rel = doc.relations.find((r) => r.type === '위치' && r.from === cafe && r.to === market);
  if (rel) rel.differs = { from: market, to: cafe, evidence: '찻집 「은방울」 안쪽 계단으로 내려가면 별빛 시장 지하 장터가 나온다.', by: 'reader', at };
  s.writeJson(s.entityFile(W), doc);
  // 「같은 것일 수 있음」: 「소넷」이 「리아 소넷」일 수도
  s.applyAuto(W, [person('소넷', { gender: '여', affiliation: '은사슴 1학년' })]);
  s.markMaybe(W, ent('소넷').entityId, ent('리아 소넷').entityId, '「소넷이 손을 들었다」 — 성만 나옴');
  // 정리 후보 두 줄: ① 한때의 설정 · 칸 ② 한 번만 나왔어요(오래 읽은 세계에서만 — 방 하나를 150메시지 읽은 것으로)
  s.applyAuto(W, [rule('3층 복도 물바다', '어제 3층 복도가 물에 잠겨 하루 동안 막혔다', '은사슴 학교'), rule('부엉이 집 청소 당번표', '이번 주 부엉이 집 청소는 노엘', '은사슴 학교')], { messageIds: ['m1'] });
  s.setRoomRead(ROOM, { lastId: 'm150', count: 150 });
  { const d2 = s.readEntities(W); for (const n of ['부엉이 집 청소 당번표', '손목 리본']) { const x = d2.entities.find((y) => y.name === n); if (x) x.seen = { n: 1, last: 'b1' }; } s.writeJson(s.entityFile(W), d2); }
  s.saveTidy(W, { at, items: [{ entityId: ent('3층 복도 물바다').entityId, name: '3층 복도 물바다', type: 'rule', why: '하루 동안의 일이에요' }], fields: [{ entityId: ent('테오 마렌').entityId, name: '테오 마렌', key: 'appearance', value: '갈색 곱슬머리에 초록 눈, 늘 소매를 걷어 올림', why: '「오늘은」 소매를 걷어 올린 것 같아요' }] });
  // 기록: 자동으로 바뀐 것 하나를 사람이 되돌림
  const ch = s.listHistory(W).find((c) => c.action === 'field' && c.name === '리아 소넷' && c.key === 'hair');
  if (ch) s.undoChange(W, ch.id);
}

// ------------------------------------------------------------------ 학교가 아닌 지어낸 세계: 헌터물(한국어), 방 demo-room-2
const ROOM2 = 'demo-room-2';
{
  const w2 = s.createWorld({ name: '[시험] 백랑 — 헌터 협회', description: '게이트와 던전이 열리는 도시. 지어낸 세계(시험용).', injectChars: 3000, injectMode: 'scene' }).worldId;
  const id2 = (n) => s.listEntities(w2).find((e) => e.name === n).entityId;
  s.applyAuto(w2, [
    P('헌터 협회 본관', { use: '각성자 등록 · 감정 · 정산' }), P('감정실', { use: '아이템 · 등급 감정' }), P('등록 창구'), P('정산 창구'),
    P('백랑 길드 사무실'), P('서쪽 게이트 입구 광장', { use: '게이트 앞 집결지' }, { memo: '던전으로 들어가는 입구 앞 광장 — 던전 안은 아님' }), P('안개 늪 던전', { use: 'D급 게이트 너머 던전' }),
    { type: 'group', name: '백랑 길드', fields: { kind: '헌터 길드', size: '23명' } }, { type: 'group', name: '헌터 협회', fields: { kind: '공공 기관' } },
    person('서진우', { gender: '남', affiliation: '무소속', state: 'S급 헌터 · 원정대를 이끄는 중', hair: '검은', eyes: '짙은 갈색', appearance: '검은 머리를 짧게 자르고 왼쪽 눈썹에 흉터' }),
    person('백도경', { gender: '여', affiliation: '백랑 길드 마스터', hair: '흰', eyes: '회색', appearance: '흰 머리를 하나로 묶은 장신' }),
    person('장미라', { gender: '여', affiliation: '헌터 협회 감정사' }), person('권태오', { gender: '남', affiliation: '백랑 길드', state: 'A급 헌터' }),
    person('박은서', { gender: '여', affiliation: '헌터 협회 등록 창구' }, { aliases: ['협회 창구 직원'] }),
  ]);
  s.applyRelations(w2, [['감정실', '헌터 협회 본관'], ['등록 창구', '헌터 협회 본관'], ['정산 창구', '헌터 협회 본관']].map(([a, b]) => ({ from: id2(a), to: id2(b), type: '위치', note: '', evidence: '' })));
  s.applyRelations(w2, [['백도경', '백랑 길드', '소속', '길드 마스터'], ['권태오', '백랑 길드', '소속', ''], ['장미라', '헌터 협회', '소속', '감정사'], ['박은서', '헌터 협회', '소속', '창구']].map(([a, b, type, note]) => ({ from: id2(a), to: id2(b), type, note, evidence: '' })));
  s.setBase(w2, id2('백랑 길드'), id2('백랑 길드 사무실'), {}, { force: true });
  s.setBase(w2, id2('헌터 협회'), id2('헌터 협회 본관'), {}, { force: true });
  const r2 = (name, memo, where, type = 'rule') => ({ type, name, memo, ...(where ? { appliesTo: where === 'world' ? 'world' : id2(where) } : {}) });
  s.applyAuto(w2, [
    r2('각성자 등록 의무', '각성 뒤 7일 안에 협회에 등록해야 한다', 'world'), r2('게이트 브레이크 규정', '열린 게이트를 24시간 안에 닫지 못하면 근처 주민을 대피시킨다', 'world'),
    r2('게이트 등급', 'E급부터 S급까지, 협회 측정기로 정한다', 'world', 'system'), r2('상태창', '각성자는 이름 · 등급 · 레벨 · 스킬이 적힌 창을 본다', 'world', 'system'),
    r2('보상 분배와 협회 수수료', '기여도에 따라 나누고 협회가 10%를 뗀다', '헌터 협회', 'system'), r2('정기 정산일', '매달 25일 정산 창구에서 보상을 받는다', '정산 창구'),
    r2('길드 가입 조건', '등록증과 D급 이상, 또는 마스터 면접', '백랑 길드'), r2('광장 일반인 출입 금지', '게이트가 열린 동안 입구 광장은 헌터만 들어간다', '서쪽 게이트 입구 광장'),
  ]);
  for (const [n, t] of [['각성자 등록 의무', '금지·예절'], ['게이트 브레이크 규정', '금지·예절'], ['게이트 등급', '방법·기술'], ['상태창', '방법·기술'], ['보상 분배와 협회 수수료', '돈·거래'], ['정기 정산일', '시간·영업'], ['길드 가입 조건', '그 밖'], ['광장 일반인 출입 금지', '금지·예절']]) s.setTopic(w2, id2(n), t, { by: 'reader' });
  s.linkRoom(ROOM2, w2);
}

// ------------------------------------------------------------------ routes (the server's own code, no Fastify)
const table = [];
const make = (prefix) => { const add = (method) => (p, fn) => table.push({ method, parts: (prefix + p).split('/'), fn }); return { get: add('GET'), post: add('POST'), patch: add('PATCH'), put: add('PUT'), delete: add('DELETE') }; };
const pending = [];
service.attach({ register: (plugin, opts) => pending.push(plugin(make(opts.prefix))), addHook: () => {} });
async function call(method, url, body) {
  await Promise.all(pending);
  const [p, q = ''] = url.split('?');
  const parts = p.split('/');
  for (const r of table) {
    if (r.method !== method || r.parts.length !== parts.length) continue;
    const params = {};
    if (!r.parts.every((x, i) => (x.startsWith(':') ? ((params[x.slice(1)] = decodeURIComponent(parts[i])), true) : x === parts[i]))) continue;
    const reply = { statusCode: 200, code(n) { this.statusCode = n; return this; }, send(d) { return d; }, header() { return this; } };
    try { return { status: reply.statusCode, data: await r.fn({ params, body, query: Object.fromEntries(new URLSearchParams(q)), headers: {} }, reply) }; } catch (e) { return { status: e.status || 500, data: { error: e.message } }; }
  }
  return { status: 404, data: { error: 'no route' } };
}

// ------------------------------------------------------------------ pages
const ext = () => fs.readFileSync(path.join(REPO, 'extension/extension.js'), 'utf8');
const head = (title) => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>`;
const setRoom = `<script>try{localStorage.setItem('marinara-active-chat-id',new URLSearchParams(location.search).get('room')||'${ROOM}');localStorage.removeItem('world-archive-world')}catch{}</script>`;
// ?clicks=sel1|sel2: click those, one after another, inside any shadow root (for a screenshot of one screen)
const clicker = `<script>(async()=>{const list=(new URLSearchParams(location.search).get('clicks')||'').split('|').filter(Boolean);const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));const find=(sel)=>{let hit=null;const walk=(root)=>{if(hit)return;try{hit=root.querySelector(sel);}catch{}if(hit)return;for(const el of root.querySelectorAll('*'))if(el.shadowRoot)walk(el.shadowRoot);};walk(document);return hit;};const byText=(t)=>{let hit=null;const walk=(root)=>{if(hit)return;for(const el of root.querySelectorAll('[data-act]'))if(!hit&&el.textContent.trim().includes(t))hit=el;for(const el of root.querySelectorAll('*'))if(el.shadowRoot)walk(el.shadowRoot);};walk(document);return hit;};await sleep(1200);for(const sel of list){if(sel.startsWith('set:')){const [,q,...v]=sel.split(':');const x=find(q);if(x){x.value=v.join(':');x.dispatchEvent(new Event('input',{bubbles:true}));}continue;}if(sel.startsWith('@')){for(let i=0;i<20&&!find(sel.slice(1));i++)await sleep(150);find(sel.slice(1))?.scrollIntoView({block:'start'});await sleep(300);continue;}const get=()=>sel.startsWith('~')?byText(sel.slice(1)):find(sel);for(let i=0;i<20&&!get();i++)await sleep(150);get()?.click();await sleep(900);}})();</script>`;
const standalone = `${head('설정집 단독 화면')}<style>body{margin:0;min-height:100vh;background:#1d1b19}</style></head><body>${setRoom}<script>try{localStorage.setItem('world-archive-theme',new URLSearchParams(location.search).get('theme')==='dark'?'dark':'light');localStorage.setItem('world-archive-view',new URLSearchParams(location.search).get('view')==='ko'?'ko':'orig')}catch{}</script><script src="/extension.js"></script><script>setTimeout(()=>document.querySelector('#marinara-world-archive-root')?.shadowRoot?.querySelector('#launch')?.click(),300)</script>${clicker}</body></html>`;
// 기억 서재 틀 흉내: 왼쪽 메뉴 · 위 · 오른쪽 「이 세계관」 칸(설정집 패널의 rail() 내용). 진짜 틀은 기억 서재 쪽.
const frameCss = `body{margin:0;background:#141414;font:14px/1.6 "Pretendard","Noto Sans KR",system-ui,sans-serif}
#frame{--im-ink:#151515;--im-paper:#f4f1ea;--im-canvas:#ebe7dd;--im-line:#15151526;--im-muted:#6d685f;--im-field:#faf8f3;--im-soft:#e4dfd3;display:grid;grid-template-columns:192px minmax(0,1fr) 224px;height:100vh;max-width:1280px;margin:0 auto;background:var(--im-paper);color:var(--im-ink)}
#frame[data-theme=dark]{--im-ink:#ece8df;--im-paper:#1b1a18;--im-canvas:#131312;--im-line:#ece8df2b;--im-muted:#a39d92;--im-field:#222120;--im-soft:#2a2826}
.f-side{background:#151515;color:#ece8df;padding:26px 14px;font-size:13px}.f-side b{font:700 18px Georgia,serif;display:block;margin:0 0 30px}.f-side div{padding:9px 12px;opacity:.8}.f-side div.on{background:#ece8df;color:#151515;opacity:1;font-weight:700;border-radius:2px}
.f-work{display:flex;flex-direction:column;min-width:0}.f-top{display:flex;align-items:center;gap:12px;padding:16px 28px;border-bottom:1.5px solid var(--im-ink)}.f-top span{border:1px solid var(--im-line);padding:6px 12px;background:var(--im-field);min-width:300px}
#worldMount{flex:1;min-height:0}.f-rail{border-left:1.5px solid var(--im-ink);padding:26px 18px;overflow:auto}
.rail-title{font:12px ui-monospace,monospace;letter-spacing:2px;margin:6px 0 16px}.rail-stat{display:flex;align-items:center;gap:14px;padding:8px 0}.rail-stat b{flex:none;width:64px;height:64px;border-radius:50%;display:grid;place-items:center;font:700 15px Georgia,serif;color:#151515;background:radial-gradient(circle,#151515 0 1.6px,#f4f1ea 2.2px 14px,#151515 14.5px 15.5px,#0000 16px),repeating-radial-gradient(circle,#151515 0 1.1px,#2a2a2a 1.5px 2.4px);box-shadow:0 3px 8px #0004}.rail-stat span{font-size:13px;line-height:1.5}.rail-stat small{display:block;font-size:11px;color:var(--im-muted)}.rail-divider{border-top:1.5px dashed var(--im-line);margin:18px 0}.rail-note h3{font:700 13px Georgia,serif;margin:0 0 6px}.rail-note p{font-size:11px;color:var(--im-muted);margin:0;line-height:1.8}
@media(max-width:720px){#frame{grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr)}.f-side,.f-rail{display:none}.f-top span{min-width:0;flex:1}}`;
const embedded = (theme) => `${head('기억 서재 · 세계관 칸')}<style>${frameCss}</style></head><body>${setRoom}
<div id="frame" data-theme="${theme}"><aside class="f-side"><b>기억 서재</b><div>한눈에</div><div>이야기</div><div>인물</div><div>할 일</div><div>검색</div><div>주입 확인</div><div class="on">세계관</div><div>설정</div></aside>
<div class="f-work"><div class="f-top"><span>[시험] 은사슴 학교</span></div><div id="worldMount"></div></div><aside class="f-rail" id="rail"></aside></div>
<script>(()=>{const __WORLD_ARCHIVE_EMBEDDED__=true;\n${'/*EXT*/'}\n})();
const inst=globalThis.__memoryWorldPanel.start(document.getElementById('worldMount'),{theme:'${theme}'});
const fill=()=>{const r=document.getElementById('rail');if(inst.railHtml)r.innerHTML=inst.railHtml();};setInterval(fill,800);</script>${clicker}</body></html>`;

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(standalone);
  if (u.pathname === '/embedded') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(embedded(u.searchParams.get('theme') === 'dark' ? 'dark' : 'light').replace('/*EXT*/', () => ext()));
  if (u.pathname === '/extension.js') return res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }).end(ext());
  // a page in a box of a set size (headless Chrome will not make a window narrower than ~500px: a phone goes in an iframe)
  if (u.pathname === '/frame') {
    const w = Number(u.searchParams.get('w')) || 390, h = Number(u.searchParams.get('h')) || 844, src = u.searchParams.get('u') || '/embedded';
    return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><body style="margin:0;background:#777"><iframe src="${src.replace(/"/g, '')}" style="width:${w}px;height:${h}px;border:0;display:block"></iframe></body>`);
  }
  // PNG → WEBP in the browser: cut to the given width, drop the empty rows at the bottom, save in docs/screenshots/
  if (u.pathname === '/convert') {
    const q = (k) => JSON.stringify(u.searchParams.get(k) || '');
    return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><body><script>
(async()=>{const f=${q('f')},name=${q('name')},w0=Number(${q('w')})||0;const img=new Image();img.src='/shot?f='+encodeURIComponent(f);await img.decode();
const w=w0||img.width;const c=document.createElement('canvas');c.width=w;c.height=img.height;const x=c.getContext('2d');x.drawImage(img,0,0);
const d=x.getImageData(0,0,w,img.height).data;const px=(i)=>d[i]+','+d[i+1]+','+d[i+2];const col=Math.floor(w*0.55);const base=px(((img.height-1)*w+col)*4);
let y=img.height-1;for(;y>0;y--){let same=true;for(let k=Math.floor(w*0.2);k<w*0.95;k+=7){if(px((y*w+k)*4)!==base){same=false;break}}if(!same)break}
const h=Math.min(img.height,y+40);const o=document.createElement('canvas');o.width=w;o.height=h;o.getContext('2d').drawImage(c,0,0);
const blob=await new Promise((r)=>o.toBlob(r,'image/webp',0.9));const r=await fetch('/save-webp?name='+encodeURIComponent(name)+'&dir='+encodeURIComponent(${q('dir')}),{method:'POST',body:blob});document.title='saved '+(await r.text())+' '+w+'x'+h;})();
</script></body>`);
  }
  if (u.pathname === '/shot') return res.writeHead(200, { 'content-type': 'image/jpeg' }).end(fs.readFileSync(u.searchParams.get('f')));
  if (u.pathname === '/save-webp' && req.method === 'POST') {
    const name = String(u.searchParams.get('name') || 'shot').replace(/[^a-z0-9가-힣-]/gi, '');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    return req.on('end', () => {
      const out = path.join(REPO, u.searchParams.get('dir') === 'notice' ? 'docs/공지' : 'docs/screenshots', name + '.webp');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, Buffer.concat(chunks));
      res.writeHead(200).end(out);
    });
  }
  if (u.pathname.startsWith('/api/chats/')) { const cid = decodeURIComponent(u.pathname.split('/')[3] || ROOM); return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: cid, name: cid === ROOM2 ? '[시험] 백랑 — 헌터 협회' : '[시험] 은사슴 학교' })); }
  if (u.pathname.startsWith('/api/world-archive')) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    return req.on('end', async () => {
      let body = {};
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch {}
      // 공지 그림: 「잡다한 설정 정리」는 모델 대신 미리 넣어 둔 후보를 보여 줌(시험대만)
      const tidyAsk = req.method === 'POST' && /\/worlds\/[^/]+\/tidy$/.test(u.pathname);
      const r = await call(tidyAsk ? 'GET' : req.method, u.pathname + u.search, body);
      if (tidyAsk && r.data) r.data.calls = 0;
      // without Marinara's runtime the module has no version: say the repo's (기억 서재 looks for it)
      if (u.pathname === '/api/world-archive/status' && r.data && !r.data.version) r.data.version = require(path.join(REPO, 'package.json')).version;
      res.writeHead(r.status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(r.data ?? null));
    });
  }
  res.writeHead(404).end();
}).listen(port, '127.0.0.1', () => console.log(`demo on http://127.0.0.1:${port}/ · /embedded · world ${W}`));
