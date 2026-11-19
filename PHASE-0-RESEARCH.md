# 0단계 조사 보고서 — 기존 코드 재사용 및 설계 경계

**조사일:** 2026-11-19
**대상:** Marinara World Archive 0단계
**결론:** 초기 정적 조사 완료. 독립 제품 설계 방향 제안. **실제 엔진·라이선스·운영 환경 검증은 미완료**. 기존 NPC/World 에이전트 소스는 미확인이나, 신규 확장이 이들을 대체하며 해당 소스 확보는 착수의 전제 조건이 아니다.
**상태:** 1단계 구현 착수 승인 대기

## 1. 확인한 근거

- [World Archive 개발 계획](DEVELOPMENT-PLAN.md) 및 [AGENTS.md](AGENTS.md).
- [기억 서재 main](https://github.com/tlsiddl/marinara-memory-module/tree/main)과 [refactor/modular](https://github.com/tlsiddl/marinara-memory-module/tree/refactor/modular): [MODULES.md](https://github.com/tlsiddl/marinara-memory-module/blob/refactor/modular/MODULES.md), [REFACTOR-STATUS.md](https://github.com/tlsiddl/marinara-memory-module/blob/refactor/modular/REFACTOR-STATUS.md), [REFACTOR-PLAN.md](https://github.com/tlsiddl/marinara-memory-module/blob/refactor/modular/REFACTOR-PLAN.md), `vectors.cjs`, `aliases.cjs`, `names.cjs`, `places.cjs`, `backup.cjs`, `features.cjs` 소스. 리팩터링과 main의 파일 수준 차이도 앞서 확인했음.
- [세계 중계판(World Board)](https://github.com/tlsiddl/marinara-world-board): `README.txt`, `manifest.json`, `extension.js` 시작부.
- 연결된 GitHub 설치 저장소 이름 및 `npc_profile`, `world_profile` 문자열의 일부 코드 검색 결과. 검색 결과는 NPC/World 생성 에이전트의 실제 구현 소스를 특정하지 못함.

**주의:** 세계 중계판은 별도 패널에서 세계 활동을 생성하는 클라이언트 확장이지, World Archive의 설정 데이터베이스나 사용자가 말한 NPC/World 생성 에이전트라는 증거가 없다. 이 셋을 혼동하지 않는다.

### 확정된 제품 방향 (2026-11-19)

- World Archive 완성 후 **기존 NPC 생성 에이전트와 World 에이전트는 사용하지 않는다**.
- NPC 프로필 추출·신규 생성·정보 갱신과 장소·조직·규칙·일정의 설정 추출·변경 제안 기능을 **5단계의 필수 구현 목표**로 둔다.
- 기존 에이전트 소스·코드는 참고 가능할 때만 살피며 필수 종속성으로 도입하지 않는다.
- 가능하면 한 번의 분석으로 인물 및 세계 정보 후보를 얻어 분류·중복 검사·승인 처리하고, 모델 호출이 추가될 때 비용을 검증한다.
- 기억 서재(Memory Module)는 독립 유지한다. 향후 기존 장면 정리 결과를 입력으로 활용할 수 있지만 초기 설치·실행의 필수 조건은 아니다.
- 기존 로어북 가져오기·자동 동기화는 계속 제외한다.

## 2. 코드 재사용 판단

| 출처 | 확인한 현재 책임 | 판단 | 필요한 조정 |
| --- | --- | --- | --- |
| `lib/vectors.cjs` | 장면·이벤트·수첩 조각의 해시 기반 부분 색인, 모델 접두사, 벡터 직렬화·유사도 | **순수 계산 일부 선택적 재사용** | `sceneDocs`/`noteDocs`는 세계관 엔티티 문서화로 교체. Qwen3 장면 회상 전용 query 지침 재사용 금지. 독립 색인 버전·모델 변경 처리 |
| `lib/aliases.cjs` | 채팅방별 인물 canonical name·별칭 테이블, AsyncLocalStorage로 방 문맥 주입 | **이름 정규화 원칙만 선별 재사용** | 전역/세계관별 `worldId + entityId` 기반 인덱스 새 설계. 장소·조직도 포함. 방 종속 `setLoader`·`using` 그대로 이식하지 않음 |
| `lib/names.cjs` | 장면·장부 전체에서 인물명 변경 미리보기·적용·되돌리기, `ledger`·`scenes` 의존 | **패턴 참고** | 월드 엔티티 필드와 관계 참조에만 적용하는 변경/되돌리기 로직 신규 작성. 통파일 복사 비추천 |
| `lib/places.cjs` | 방별 장면에서 장소 정보를 모아 접기, 별칭·잠금·직접 편집 오버레이 | **정규화·보호 정책 참고** | 장면 유래/방별 `places`와 월드 공통 정적 공간 엔티티 분리. `MAX_PLACES=80` 등 기존 상한 그대로 사용하지 않음 |
| `lib/features.cjs` | 전역 기본값과 방별 on/off, 레거시 설정 호환 | **설정 등록/선택 기능 패턴 참고** | World Archive 자체 설정 네임스페이스와 월드별 옵션 신규 설계; 기억 서재 설정 직접 변경 금지 |
| `lib/backup.cjs` | 방별 메모리 파일 묶음, 형식·해시·노드 수 검증 | **백업 검증 원칙 참고** | 세계관별 독립 백업 형식과 복구 안전 규칙 신규 정의; 기억 서재 FILES 및 내부 파일 형식 복제 금지 |
| `extension/search.js` | 장면/인물별 UI 검색 및 필터·이벤트 | **UI 패턴 참고** | World Archive 항목 종류·세계관 단위 검색으로 재설계 |
| `extension/runtime.js`, `build.py` | 단일 개인 확장 JS 번들 생성, UI 공통 상태 | **빌드/화면 구조 참고** | 독립 manifest·CSS·JS 및 네임스페이스. 기억 서재 번들에 코드를 직접 삽입하지 않음 |
| `tracker-routes.cjs` | 트래커 API 등록·검증·service 의존성 주입 | **라우트 경계 패턴 참고** | World Archive 전용 API, 인증·권한·에러 처리. 메모리 API를 직접 재사용하지 않음 |
| World Board `extension.js` | 마리나라 클라이언트 확장; 채팅·모델·숨김 메시지 API 호출 | **플랫폼 연동 패턴 참고** | World Archive는 영구적인 서버 측 데이터 관리가 중심. 로컬스토리지 단독 정본 방식 채택 금지 |
| NPC/World 생성 에이전트 | 소스 위치 및 실제 저장 인터페이스 **미확인** | **필수 의존/재사용 대상 아님** | 기존 코드 확보 없이 독립 구현. 확인 가능한 경우 출력 스키마 등 참고만 하며 기존 에이전트 사용을 전제로 하지 않음 |

모든 재사용 판단은 현재 조사 범위의 **설계 제안**이며 컴파일·실행 검증이나 사용 권한/라이선스 승인을 뜻하지 않는다.

## 3. 제안하는 독립 구조

```text
Marinara World Archive (독립 프로젝트)
├── client extension / UI
│   ├── 세계관 선택·관리
│   ├── 인물·장소·조직·규칙·일정 편집
│   └── 검색·검토·백업 화면
├── server module / API
│   ├── 인증 및 요청 경계
│   ├── 세계관·엔티티 서비스
│   ├── 별칭·관계 인덱스
│   ├── 키워드 검색 / 선택적 벡터 검색
│   ├── 변경 이력·잠금·제안
│   ├── AI 인물·세계 설정 추출(가능하면 단일 분석)
│   ├── 항목 유형별 후보 분류·중복 검사·승인
│   └── 저장·백업·복구
└── data (기억 서재와 완전히 별도)
    ├── worlds / entities
    ├── search indexes
    └── history / backups
```

실제 경로 및 API는 공식 엔진 확장 설치·데이터 보존 계약을 검증한 후 확정한다. 0단계에서 엔진 파일 패치 방식이 필수인지 확정하지 않는다.

### 최소 데이터 계약 초안 (제안, 미구현)

- World: `{ schemaVersion, worldId, name, description, setting, updatedAt }`
- Entity: `{ schemaVersion, worldId, entityId, type, name, aliases:[], fields:{}, relations:[], status, revision, provenance, updatedAt }`
- Relation: `{ type, targetEntityId, validFrom?, validTo? }` — 관계 대상은 같은 월드의 유효한 ID
- Change proposal: `{ proposalId, worldId, entityId?, fieldChanges:[], source, status, createdAt }`
- 향후 방 연결: `{ roomId, worldId }` — 방별 변경은 공통 세계관을 자동 수정하지 않음
- Index: `{ indexVersion, model, worldId, docs }`; 인덱스는 원본 데이터를 대신하지 않으며 재생성 가능해야 함

내부 ID는 명칭 변경 후에도 유지한다. 삭제·병합은 참조 무결성과 이력 복구 가능성을 확인한다. 임베딩 모델에 따른 접두사와 검색 텍스트는 실제 모델별 테스트 후 정한다.

### API 경계 초안 (제안, 미구현)

- `GET/POST /api/world-archive/worlds`
- `GET/PATCH/DELETE /api/world-archive/worlds/:worldId`
- `GET/POST /api/world-archive/worlds/:worldId/entities`
- `GET/PATCH/DELETE /api/world-archive/worlds/:worldId/entities/:entityId`
- `GET /api/world-archive/worlds/:worldId/search`
- 추후: `POST /api/world-archive/worlds/:worldId/proposals`, 승인·거절, 백업·복원 및 외부 조회

정확한 라우트·메서드·권한은 1단계 착수 전 엔진 서버 설치·요청 보안에 맞춰 확정한다. API 제공 사실을 의미하지 않는다.

## 4. 핵심 의존성과 경계

1. **메모리 모듈 직접 의존 금지:** World Archive는 Memory Module 설치 유무와 무관하게 CRUD·검색이 동작해야 한다.
2. **정본 분리:** 세계의 고정 설정은 World Archive, 작중 사건·인물의 경험은 Memory Module. 설정 변경은 승인 가능한 제안으로만 외부에 전달.
3. **방/월드 구분:** `worldId` 정본 설정과 `roomId`별 스토리 상태를 혼합하지 않음.
4. **추출과 색인 분리:** 저장된 엔티티가 정본이고 임베딩은 파생 데이터. 색인 실패가 원본 저장을 막지 않도록 함.
5. **주입 비용:** 추후 기억 서재와 통합하더라도 두 확장이 중복으로 같은 내용을 프롬프트에 넣지 않는 계약 필요. 실제 통합 구현은 현 계획 범위 밖.
6. **권한:** 클라이언트 접근 권한·관리자 권한·서버 CSRF 및 Origin을 현재 엔진 버전으로 검증해야 함. World Board의 과거 엔진 API 표기를 2.5.2의 보증으로 보지 않음.
7. **확장 업데이트 시 보존:** World Board 문서에는 확장 삭제·재설치 시 서버 저장소 삭제 위험을 경고함. 독립 서버 저장소의 생명주기·백업 방식은 구현 전에 실증 검증 필요.

## 5. 단계별 신규 작성 범위

- **1단계 신규:** World Archive 전용 서버 진입점, 저장 레이어, API·UI 골격, 설치/업데이트·시험 체계.
- **2단계 신규:** 월드 및 5종 엔티티 스키마, 참조·CRUD·검증 UI/API.
- **3단계 일부 재사용:** 해시·벡터 직렬화·유사도 계산·부분 색인 아이디어. 신규 엔티티 문서 생성·정확 일치·관계 검색.
- **4단계 신규:** 필드 단위 변경 제안·수동 잠금·충돌·이력. 기억 서재 기존 수동 보호 원칙만 참조.
- **5단계 필수 신규:** 외부 NPC/World 에이전트를 대체하는 AI 추출 파이프라인. 가능하면 단일 분석으로 NPC와 세계 설정 후보를 함께 추출하고 타입별 분류·중복/충돌 검토·제안 승인. 기존 에이전트 코드는 선택적 참고만 하며 필수 의존성이 아님.
- **6단계 신규:** 버전 명시된 읽기·변경 제안 API 계약 문서. 기억 서재 파일은 수정하지 않음.

## 6. 테스트 계획과 승인 게이트

### 단위 테스트

- 동명이인, 한/영 별칭, 잘못된 ID, 월드 간 같은 이름, 인물/장소/집단 ID 분리
- 수동 수정 보호, 필드 변경 이력, 중복 후보/모순 구분, 취소·되돌리기
- 잘못된 JSON, 지원하지 않는 미래 스키마, 부분 쓰기, 삭제 및 참조 복구
- 임베딩 모델 변경, 부분 재색인, 키워드 전용 검색, 실패·타임아웃

### 통합 테스트

- 공식 Marinara Engine **2.5.2** 격리 설치의 설치·API·인증·Origin/CSRF
- 가상 세계관과 가상 채팅방으로 월드·방 분리 검증
- 실제 UI에서 편집·검색·모바일·방 전환·재시작
- Memory Module 설치 유무를 바꾼 상태의 독립 동작
- 확장 업데이트/제거 시 원본 데이터 보존 및 백업→복원
- 다수 엔티티에서 메모리·검색 시간·모델 호출 수 측정
- NPC·World 에이전트 없이 인물·세계 정보를 한 번의 분석에서 구분해 제안할 수 있는지, 동일 원문 재처리·중복 제안·추가 모델 호출을 방지하는지 검증

### 중단 조건

기존 메모리 데이터 수정 필요, 예상 밖 엔진 API 변경, 백업 불능, 직접 수정 덮어쓰기, 테스트 신규 실패, 실제 서버 접근 필요, 불명확한 권한 경계 발견 시 구현 중단 및 보고.

## 7. 미검증 및 1단계 착수 전 결정 사항

1. NPC/World 에이전트 실제 소스 위치는 특정하지 못함. **선택적 참고 자료**이며 소스 확보 및 재사용률 산정은 1단계 시작의 선행 조건이 아니다. World Archive는 기존 에이전트를 대체하도록 독립 구현한다.
2. World Archive 신규 모듈의 실제 Marinara 2.5.2 서버 플러그인 설치·권한·업데이트 경로는 격리 실행으로 검증하지 않음.
3. 기존 소스 재사용에 대한 라이선스 및 서드파티 의존성 재검토 필요.
4. 성능 수치·개발 시간·코드 재사용 비율은 실측되지 않음.
5. 서버 파일 데이터 구조와 API는 **초안**이며 구현 전에 확정·검증해야 함.
6. 실제 운영·사용자 데이터·본체·Memory Module 리팩터링 브랜치는 미접근·미변경.

## 8. 권고

0단계 조사 결과를 먼저 검토·승인하고, **1단계에서는 월드 생성·저장·선택·삭제가 되는 독립 골격에만 집중**한다. AI 기반 NPC/세계 설정 추출은 **전체 프로젝트 필수 요건이지만 5단계에서 구현**한다. 로어북 가져오기와 기억 서재 연동은 1단계에 추가하지 않는다. 처음부터 벡터 검색·외부 동기화를 끼워 넣지 않는다.
