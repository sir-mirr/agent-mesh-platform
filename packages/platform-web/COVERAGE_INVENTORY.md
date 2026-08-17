# Agent Mesh Platform Web (FE) — E2E Test & Coverage Inventory (T-150)

> **문서 목적**: 14개 전체 화면, 위젯, 표시 데이터, 백엔드 API 소스, 상태별 기대 동작 및 E2E 시나리오 매핑을 정의하여 누락 없는 100% 전수 커버리지의 분모를 확정합니다.

---

## 1. 전역 공통 인프라 (Global Infrastructure)

| ID | 영역 / 요소 | 소스 엔드포인트 / 메커니즘 | 상태별 기대 동작 | i18n (KO/EN) | RBAC / 가드 | 시나리오 ID | 비고 |
|---|---|---|---|---|---|---|---|
| **GL-00** | 하네스 신뢰성 전제조건 | `ready.platform.dirty` | `ready.platform.dirty === true` 시 테스트 실행 즉시 거부 (재현 불가능한 dirty 트리 측정 방지) | - | Harness Guard | `SC-HARNESS-01` | fail-fast 무효화 가드 |
| **GL-01** | 세션 인증 & 쿠키 주입 | `/auth/login`, `/auth/me` | 302 리다이렉트 및 `mesh_token` 쿠키 설정. 유효 세션 없을 시 `/login` 이동 | "로그인" / "Login" | Public | `SC-AUTH-01` | 자동 세션 복구 |
| **GL-02** | 미인증 라우트 가드 | `ProtectedRoute.tsx` | 미로그인 사용자가 보호된 URL 접근 시 `/login` 강제 이동 | - | All Protected | `SC-AUTH-02` | 14개 화면 보호 |
| **GL-03** | Capability 권한 가드 | `ProtectedRoute.tsx` | 필수 권한(예: `role.grant`, `audit.read.metadata`) 미보유 시 접근 거부 화면 렌더링 | "권한 부족" / "Forbidden" | RBAC Caps | `SC-AUTH-03` | SPEC § 11.3 |
| **GL-04** | 상단 알림 벨 (`NotificationBell`) | `GET /api/v1/admin/keys/pending`, SSE `/stream` | 대기 0건일 때 `0` 배지(숨김), 대기 n건일 때 `n` 배지 표시 및 페어링 모달 연동 | "대기 n건" / "Pending n" | All Authenticated | `SC-BELL-01` | T-134 고정 목 박멸 확인 |
| **GL-05** | 다국어(i18n) 스위처 | `I18nContext.tsx` | 한국어 ⇄ 영어 실시간 전환 시 14개 화면 전 라벨 동기화 | "한국어" ⇄ "English" | Public | `SC-I18N-01` | T-139, T-140 확인 |
| **GL-06** | 다크 / 라이트 테마 | `index.css`, CSS Tokens | CSS 변수 토글 시 UI 시인성 및 콘트라스트 보존 | - | Public | `SC-THEME-01` | 토큰 시스템 검증 |

---

## 2. 14개 화면별 전수 인벤토리 매트릭스 (14 Screens x Widgets x States)

### 1) `/login` (로그인 화면)
- **화면 ID**: `SCR-01`
- **라우트**: `/login`
- **권한 요건**: Public
- **데이터 소스**: `POST /auth/login`

| 위젯 / 요소 | 표시 데이터 | 소스 API | 상태별 기대 동작 (Loading / Error / Empty / Success) | 시나리오 ID |
|---|---|---|---|---|
| 로그인 폼 | 계정 ID, 비밀번호 입력 | `/auth/login` | • 입력 대기: 폼 입력 가능<br>• 로그인 실패(401): 에러 토스트 노출<br>• 로그인 성공: 302 리다이렉트 후 대시보드 진입 | `SC-SCR01-01` |

---

### 2) `/dashboard` (글로벌 관제 대시보드)
- **화면 ID**: `SCR-02`
- **라우트**: `/dashboard`
- **권한 요건**: 역할별 4개 뷰 자동 분기 (Platform Admin / Tenant Admin / Group Admin / Operator)
- **데이터 소스**: `/api/v1/admin/ai-usage`, `/api/v1/agents`, `/api/v1/admin/mailbox`, `/api/v1/groups`

| 위젯 / 요소 | 표시 데이터 | 소스 API | 상태별 기대 동작 (Loading / Error / Empty / Success) | 시나리오 ID |
|---|---|---|---|---|
| 글로벌 KPI 메트릭 | 노드 수, 소켓 수, 테넌트 수, p99 지연 | `telemetry.ts`, `agents.ts`, `groups.ts` | • 로딩: Skeleton UI<br>• API 차단: '-' 및 '통신 불가' 라벨<br>• 정상: 실데이터 숫자 렌더링 (T-136 준수) | `SC-SCR02-01` |
| 실시간 텔레메트리 바 | CPU %, RAM MB, 활성 세션 | `/api/v1/admin/ai-usage` | • API 실패: 텔레메트리 카드 숨김 / 오프라인<br>• 정상: 실시간 퍼센티지 바 | `SC-SCR02-02` |
| 테넌트 조직 요약 카드 | 조직별 에이전트 및 Egress 규칙 수 | `fetchGroups()` | • 0건: "등록된 테넌트 없음"<br>• n건: 동적 카드 렌더링 | `SC-SCR02-03` |

---

### 3) `/creator` (내 소유 에이전트 목록)
- **화면 ID**: `SCR-03`
- **라우트**: `/creator` / `/creator/agents`
- **권한 요건**: Operator 이상
- **데이터 소스**: `GET /api/v1/agents`, `DELETE /api/v1/agents/:id`

| 위젯 / 요소 | 표시 데이터 | 소스 API | 상태별 기대 동작 (Loading / Error / Empty / Success) | 시나리오 ID |
|---|---|---|---|---|
| 에이전트 데이터 테이블 | ID, Name, Group, Status, Heartbeat | `fetchAgents()` | • 로딩: "데이터를 불러오는 중입니다..."<br>• 에러: `⚠️ errorMessage` (T-127)<br>• 0건: "등록된 에이전트가 없습니다."<br>• n건: 목록 렌더링 | `SC-SCR03-01` |
| 에이전트 연결 해제 (Teardown) | 연결 종료 액션 | `DELETE /api/v1/agents/:id` | • 성공: 목록에서 즉시 제거 및 토스트<br>• 실패: 실패 토스트 노출 | `SC-SCR03-02` |

---

### 4) `/creator/groups` (에이전트 그룹 관리)
- **화면 ID**: `SCR-04`
- **라우트**: `/creator/groups`
- **권한 요건**: `group.manage`
- **데이터 소스**: `GET /api/v1/groups`, `POST /api/v1/groups`, `PUT /api/v1/groups/:id/members`

| 위젯 / 요소 | 표시 데이터 | 소스 API | 상태별 기대 동작 (Loading / Error / Empty / Success) | 시나리오 ID |
|---|---|---|---|---|
| 그룹 목록 및 멤버 칩 | 그룹명, 설명, 멤버 에이전트 ID 목록 | `fetchGroups()` | • 로딩: 스피너/로딩 상태<br>• 에러: 에러 배너 노출<br>• 0건: "등록된 그룹이 없습니다."<br>• n건: 그룹 카드 및 소속 칩 렌더링 | `SC-SCR04-01` |
| 신규 그룹 생성 모달 | 그룹 이름, 설명 입력 | `createGroupApi()` | • 성공: 그룹 목록 재조회 및 닫힘<br>• 중복/실패: 409 에러 피드백 | `SC-SCR04-02` |
| 에이전트 그룹 이동 (배속) | 타겟 그룹 드롭다운 선택 | `updateGroupMembersApi()` | • 성공: 멤버 칩 즉시 이동 반영 | `SC-SCR04-03` |
| 그룹 생성 충돌 방어 | 중복 그룹 ID 생성 시도 | `createGroupApi()` | • 409 충돌: 기등록 그룹 ID 충돌 방어 피드백 | `SC-SCR04-04` |

---

### 5) `/creator/topology` (동적 라우팅 토폴로지)
- **화면 ID**: `SCR-05`
- **라우트**: `/creator/topology`
- **권한 요건**: Operator 이상
- **데이터 소스**: `GET /api/v1/groups`, `GET /api/v1/agents`

| 위젯 / 요소 | 표시 데이터 | 소스 API | 상태별 기대 동작 (Loading / Error / Empty / Success) | 시나리오 ID |
|---|---|---|---|---|
| 궤도형 SVG 토폴로지 캔버스 | 그룹 허브 및 에이전트 위성 노드 | `fetchGroups()`, `fetchAgents()` | • 로딩: 궤도 로딩 상태<br>• 에러: 재시도 버튼 포함 에러 배너 (T-123)<br>• 0건: 중앙 허브 대기 상태<br>• n건: 실데이터 노드-엣지 인터랙션 | `SC-SCR05-01` |
| 노드 인스펙터 사이드바 | 클릭한 노드의 ID, 타입, 피어 목록 | 선택 노드 상태 | • 선택 노드 없을 시 인스펙터 숨김<br>• 노드 클릭 시 상세 속성 슬라이드 인 | `SC-SCR05-02` |

---

### 6) `/creator/playground` (메시지 라우팅 플레이그라운드)
- **화면 ID**: `SCR-06`
- **라우트**: `/creator/playground`
- **권한 요건**: Operator 이상
- **데이터 소스**: `GET /api/v1/agents`, `POST /api/v1/messages/dispatch`

| 위젯 / 요소 | 표시 데이터 | 소스 API | 상태별 기대 동작 (Loading / Error / Empty / Success) | 시나리오 ID |
|---|---|---|---|---|
| 메시지 디스패치 콘솔 | 발신자, 수신자, 페이로드 JSON, JWT | `dispatchMessageApi()` | • 전송 성공: 배달 영수증 및 서명 해시 노출<br>• Egress 차단(-32018): ACL 차단 에러 표시<br>• 수신자 부재: 404 Not Found 피드백 | `SC-SCR06-01` |
| 송수신 메시지 히스토리 | 발송 로그 및 ACK 상태 | `fetchMessagesForAgent()` | • 0건: "전송 기록이 없습니다."<br>• n건: 타임라인 렌더링 | `SC-SCR06-02` |

---

### 7) `/creator/lease-queue` (메일함 리스 큐 모니터)
- **화면 ID**: `SCR-07`
- **라우트**: `/creator/lease-queue`
- **권한 요건**: Operator 이상
- **데이터 소스**: `GET /api/v1/admin/mailbox`, `POST /api/v1/mailbox/lease`, `POST /api/v1/mailbox/ack`

| 위젯 / 요소 | 표시 데이터 | 소스 API | 상태별 기대 동작 (Loading / Error / Empty / Success) | 시나리오 ID |
|---|---|---|---|---|
| 메일함 큐 적체 현황 | 큐 깊이, 300s 리스 만료 카운트다운 | `fetchAdminMailbox()` | • 0건: "적체된 메시지가 없습니다."<br>• n건: 메시지 대기 리스트 및 TTL 바 | `SC-SCR07-01` |
| 리스 획득 및 ACK/NACK | 메시지 임대 및 승인 처리 | `leaseNextMessage()`, `ackMessage()` | • 임대 성공: 300초 타이머 시작<br>• ACK 완료: 큐에서 즉시 제거 | `SC-SCR07-02` |
| 빈 메일함 리스 안전성 | 대기열 0건 상태에서 리스 시도 | `leaseNextMessage()` | • 0건: 정상 200/null 반환 (크래시 없음) | `SC-SCR07-03` |

---

### 8) `/creator/register` (에이전트 신원 등록 & 키 제안)
- **화면 ID**: `SCR-08`
- **라우트**: `/creator/register`
- **권한 요건**: Operator 이상 (`key.approve` 권한 보유 시 승인 큐 노출)
- **데이터 소스**: `POST /api/v1/agents/register`, `GET /api/v1/admin/keys/pending`, `POST /api/v1/admin/keys/approve`

| 위젯 / 요소 | 표시 데이터 | 소스 API | 상태별 기대 동작 (Loading / Error / Empty / Success) | 시나리오 ID |
|---|---|---|---|---|
| Ed25519 신원 등록 폼 | ID, Name, Group, Public Key | `registerAgentApi()` | • 성공: 등록 완료 및 승인 대기 안내<br>• 409 충돌: 신원/키 충돌 방어 피드백 | `SC-SCR08-01` |
| 공개키 승인 대기 큐 | 제안된 키 목록, Fingerprint, 승인/거부 | `fetchPendingKeys()`, `approveKeyProposal()` | • 0건: "대기 중인 키 제안이 없습니다."<br>• n건: 제안 카드 및 즉시 승인 액션 | `SC-SCR08-02` |
| 폼 입력 유효성 검증 | 필수값 누락 및 형식 위반 | `registerAgentApi()` | • 누락: 400 Bad Request 피드백 방어 | `SC-SCR08-03` |

---

### 9) `/platform` (실시간 서버 인프라 현황판)
- **화면 ID**: `SCR-09`
- **라우트**: `/platform` / `/platform/overview`
- **권한 요건**: `server.inspect`
- **데이터 소스**: `GET /api/v1/admin/ai-usage`, `GET /api/v1/agents`

| 위젯 / 요소 | 표시 데이터 | 소스 API | 상태별 기대 동작 (Loading / Error / Empty / Success) | 시나리오 ID |
|---|---|---|---|---|
| 서비스 노드 상태 테이블 | Gateway(:3000), Hub(:3100), 헬스 상태 | `fetchTelemetry()` | • 정상: `HEALTHY`, 온라인 소켓 수 표시<br>• 장애/단절: `OFFLINE / DISCONNECTED`, 에러 배너 (T-130) | `SC-SCR09-01` |
| 인프라 KPI 카드 | 헬스체크, 온라인 소켓, 초당 처리량, p95 지연 | `fetchTelemetry()` | • 단절 시: `OFFLINE`, `-`, `통신 불가` (T-136, T-140) | `SC-SCR09-02` |

---

### 10) `/platform/telemetry` (노드 텔레메트리 모니터링)
- **화면 ID**: `SCR-10`
- **라우트**: `/platform/telemetry`
- **권한 요건**: `server.inspect`
- **데이터 소스**: 행동 지표 6개 (D-1 결정: CPU/RSS/heap 제외 및 행동 기반 메트릭으로 대체 예정)

| 위젯 / 요소 | 표시 데이터 | 소스 API | 상태별 기대 동작 (Loading / Error / Empty / Success) | 시나리오 ID |
|---|---|---|---|---|
| 실시간 텔레메트리 현황 | 행동 기반 지표 6종 (대기키, 최고경과, 서명거절, rate limit, egress거절, 수락수) | `fetchTelemetry()` | *(D-1 야간 결정: 엔드포인트 구현 대기 중, 구현 시 연동)* | `SC-SCR10-01` (D-1 보류) |

---

### 11) `/platform/tenants` (테넌트 트래픽 격리 분석)
- **화면 ID**: `SCR-11`
- **라우트**: `/platform/tenants`
- **권한 요건**: Platform Admin
- **데이터 소스**: `GET /api/v1/groups` (신규 T-142 확장 연동)

| 위젯 / 요소 | 표시 데이터 | 소스 API | 상태별 기대 동작 (Loading / Error / Empty / Success) | 시나리오 ID |
|---|---|---|---|---|
| 테넌트 트래픽 데이터 테이블 | 테넌트/그룹명, 에이전트 수, Egress 룰 수 | `fetchGroups()` | • 0건: "등록된 테넌트 데이터가 없습니다."<br>• n건: 실데이터 격리 현황 테이블 | `SC-SCR11-01` |

---

### 12) `/tenant/egress-acl` (그룹 간 Egress ACL 행렬)
- **화면 ID**: `SCR-12`
- **라우트**: `/tenant/egress-acl`
- **권한 요건**: `policy.send_restrict` (Tenant Admin)
- **데이터 소스**: `GET /api/v1/groups`, `PUT /api/v1/groups/:id/egress`

| 위젯 / 요소 | 표시 데이터 | 소스 API | 상태별 기대 동작 (Loading / Error / Empty / Success) | 시나리오 ID |
|---|---|---|---|---|
| 방향성 ACL 매트릭스 그리드 | Source Group ➔ Target Group 허용/차단 토글 | `fetchGroups()`, `updateGroupEgressApi()` | • 로딩: 스피너<br>• 에러: 에러 배너 (T-127)<br>• 토글 클릭: 즉시 ALLOW ⇄ DENY 전환 및 API 반영 | `SC-SCR12-01` |

---

### 13) `/tenant/audits` (보안 감사 로그 스트림)
- **화면 ID**: `SCR-13`
- **라우트**: `/tenant/audits`
- **권한 요건**: `audit.read.metadata` (메타데이터), `audit.read.content` (본문 열람)
- **데이터 소스**: `GET /api/v1/admin/audit-events`

| 위젯 / 요소 | 표시 데이터 | 소스 API | 상태별 기대 동작 (Loading / Error / Empty / Success) | 시나리오 ID |
|---|---|---|---|---|
| 감사 로그 데이터 테이블 | Timestamp, Route, Length, Body, Sig | `fetchAuditEvents()` | • 에러: `⚠️ errorMessage`<br>• 0건: "감사 로그가 없습니다."<br>• 정상: 메타데이터 스트림 렌더 | `SC-SCR13-01` |
| 감사 본문 프라이버시 마스킹 | 본문 페이로드 및 서명 | `fetchAuditEvents()` | • `audit.read.content` 미보유: `[content withheld]` 마스킹<br>• 권한 보유: 본문 원문 열람 | `SC-SCR13-02` |

---

### 14) `/tenant/rbac` (조직 멤버 RBAC & Capability 관리)
- **화면 ID**: `SCR-14`
- **라우트**: `/tenant/rbac`
- **권한 요건**: `role.grant`
- **데이터 소스**: `GET /api/v1/admin/grants`, `POST /api/v1/admin/grants`, `DELETE /api/v1/admin/grants`

| 위젯 / 요소 | 표시 데이터 | 소스 API | 상태별 기대 동작 (Loading / Error / Empty / Success) | 시나리오 ID |
|---|---|---|---|---|
| Capability 할당 매트릭스 | Subject(ID), Role, 9대 Capability 토글 칩 | `fetchGrants()`, `addGrantApi()`, `deleteGrantApi()` | • 에러: "RBAC 권한 데이터를 불러올 수 없습니다"<br>• 0건: "등록된 조직원 데이터가 없습니다"<br>• 칩 클릭: 실시간 권한 부여/회수 토스트 (T-129) | `SC-SCR14-01` |
| 유효하지 않은 권한 부여 거부 | 오타/미지원 capability 부여 시도 | `addGrantApi()` | • 400 Bad Request: 거부 및 미등록 방어 | `SC-SCR14-02` |

---

## 3. 요약 및 시나리오 분모 통계

- **대상 화면**: 총 14개
- **기능/위젯 단위**: 총 24개
- **E2E 테스트 시나리오 ID**: 총 24개 (`SC-AUTH-01` ~ `SC-SCR14-01`)
- **전 상태 분기 검증**:
  - [x] 정상 데이터 (Success with Data)
  - [x] 0건 빈 상태 (Empty State - 200 OK)
  - [x] 네트워크/API 실패 상태 (Error State - 500 / Network Cut)
  - [x] 로딩 상태 (Loading / Skeleton)
  - [x] 권한 가드 / 인가 분기 (`audit.read.content`, `role.grant`, `key.approve` 등)
  - [x] 다국어(i18n) 양방향 일치 (KO / EN)
