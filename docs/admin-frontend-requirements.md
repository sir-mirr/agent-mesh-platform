# 어드민 프론트엔드 요구사항 명세서 (Admin Frontend Requirements)

**문서 버전**: 1.0.0  
**기준 규범 명세**: Agent Mesh Specification 0.2 (`SPEC.md`)  
**담당 신원**: `platform-fe-antigravity`  
**대상 서비스**: `agent-mesh-http` (:3000) / `/admin`

---

## 1. 개요 및 목적

본 문서는 **에이전트 메시 플랫폼(Agent Mesh Platform)**의 운영자 및 관리자를 위한 **어드민 프론트엔드(Admin Console)**의 기능적·비기능적 요구사항을 새롭게 정의합니다.

기존 레거시 뷰(`packages/http/src/ui/admin.ts`)의 기능 자산을 계승하면서, SPEC 0.2 규범 계약(암호학적 키 승인, 인박스 큐 감시, 영구 신원 Teardown, 실시간 감사 스트림 등)에 부합하는 체계적이고 직관적인 웹 인터페이스 구축을 목표로 합니다.

---

## 2. 핵심 설계 원칙 (Design Principles)

1. **No Build Step 원칙**:
   * 빌드·번들링 도구에 의존하지 않고, Hono 서버에서 직접 서빙 가능한 단일 구조(또는 Zero-Build SSR 구조)를 유지하여 배포 복잡도와 환경 불일치를 원천 차단합니다.
2. **보안 및 규범 충실성 (Cryptographic Strictness)**:
   * SPEC § 10.2 요구사항에 따라 공개키 지문(Fingerprint)은 절대 축약하거나 변형하지 않고 원문 그대로 대조 가능하도록 노출합니다.
   * 승인/거부/폐기 액션은 항상 불변의 지문(`fingerprint`) 단위로 수행합니다.
3. **명확한 작업 피드백 및 불가역성 경고**:
   * 영구 삭제(Teardown)와 같은 불가역적 작업은 단순 확인이 아닌 명시적 2차 확인 절차를 거칩니다.
4. **실시간성 및 회복력 (Real-Time & Resilience)**:
   * SSE(Server-Sent Events)를 적극 활용하여 감사 로그 및 AI 사용량을 실시간 갱신하며, 네트워크 단절 시 자동 복구 및 상태 배너를 제공합니다.

---

## 3. 기능적 요구사항 (Functional Requirements)

### 3.1. 인증 및 접근 제어 (Auth & Session Management)

* **REQ-AUTH-01 (3단계 인증 상태 처리)**:
  * `401 Unauthorized`: 비로그인 상태 → `/` (로그인 페이지)로 리다이렉트
  * `403 Forbidden` (`approved: false`): 로그인 완료되었으나 운영자 미승인 상태 → "승인 대기 중" 전용 안내 화면 노출 (재로그인 루프 방지)
  * `200 OK` (`role: "admin"`): 승인된 어드민 → 어드민 콘솔 대시보드 진입
* **REQ-AUTH-02 (SSE 쿼리 파라미터 인증)**:
  * `EventSource`는 HTTP 헤더를 지원하지 않으므로, SSE 엔드포인트 연결 시 `?token=<JWT>` 쿼리 파라미터로 인증 토큰을 전달합니다.

---

### 3.2. 승인 대기열 관리 (Approvals Management)

#### A. 사용자 승인 (User Approvals)
* **REQ-APP-01 (사용자 승인 대기 목록)**:
  * `GET /api/v1/admin/pending`을 호출하여 GitHub OAuth로 가입 후 승인 대기 중인 사용자 목록 표시 (로그인 ID, 가입 시각).
* **REQ-APP-02 (사용자 승인/반려 액션)**:
  * 승인: `POST /api/v1/admin/approve` `{ login }`
  * 반려: `POST /api/v1/admin/deny` `{ login }`
  * 액션 완료 시 낙관적 UI 업데이트 또는 즉시 목록 재갱신.
* **REQ-APP-03 (등록된 사용자 목록 조회)**:
  * `GET /api/v1/admin/users`를 통해 승인/반려된 전체 사용자 목록 및 현재 상태 표시.

#### B. 에이전트 공개키 승인 (Key Approvals - SPEC § 10.2)
* **REQ-KEY-01 (승인 대기 키 큐)**:
  * `GET /api/v1/admin/keys/pending`을 통해 에이전트들이 제안한 키 목록 표시.
  * 필수 표시 항목: `identity`, `fingerprint`, `proposed_at`, `status`.
* **REQ-KEY-02 (지문 전체 표시 원칙 - Critical)**:
  * 키 지문(`sha256:[A-Za-z0-9_-]{43}`)은 운영자가 에이전트 실행 로그와 **문자 단위로 1:1 대조**할 수 있도록 **말줄임표(...) 없이 100% 전체 문자열을 고정폭 글꼴(Monospace)로 표시**해야 함.
  * 복사(Copy to Clipboard) 편의 버튼 제공.
* **REQ-KEY-03 (지문 기반 키 결정 액션)**:
  * 키 승인: `POST /api/v1/admin/keys/approve` `{ fingerprint, reason? }`
  * 키 거부: `POST /api/v1/admin/keys/deny` `{ fingerprint, reason? }`
  * 키 폐기: `POST /api/v1/admin/keys/revoke` `{ fingerprint, reason? }`
* **REQ-KEY-04 (에이전트별 키 이력 및 사유 시각화)**:
  * `GET /api/v1/admin/keys/{identity}`를 통해 특정 에이전트의 제안/승인/폐기 전체 감사 타임라인 표시.
  * **폐기 사유 시각적 구분**: 일상적인 키 교체(`rotation`)와 침해 사고(`compromise`)의 심각도(Badge 색상 및 경고)를 명확히 구분하여 운영자가 이전 서명 구간의 신뢰성을 판단할 수 있도록 지원.

---

### 3.3. 에이전트 신원 및 타입 레지스트리 (Registry & Teardown)

* **REQ-REG-01 (에이전트 타입 레지스트리 조회/관리 - SPEC § 10.3)**:
  * `GET /api/v1/admin/agent-types`: 등록된 타입 목록(`type`, `description`, `requires_key`) 표시.
  * `POST /api/v1/admin/agent-types`: 신규 에이전트 타입 추가 (`type`, `description`, `requires_key`).
  * `DELETE /api/v1/admin/agent-types/{type}`: 타입 삭제 (해당 타입을 사용하는 신원이 남아있을 경우 409 Conflict 안내).
* **REQ-REG-02 (영구 신원 Teardown - SPEC § 9.3)**:
  * `DELETE /api/v1/admin/agents/{identity}`: 에이전트 신원 소프트 삭제.
  * **불가역성 경고 UI**: 삭제된 신원은 영구 재등록이 불가능하므로, "해당 신원은 영구 비활성화되며 재사용할 수 없습니다"라는 명확한 2차 확인 모달(Dialog) 제공.

---

### 3.4. 인박스 큐 모니터링 (Inbox Backlog Monitor - SPEC § 9.2.1)

* **REQ-INB-01 (신원별 인박스 적체 현황)**:
  * `GET /api/v1/admin/inbox`를 호출하여 메시지가 적체된 신원 목록 및 큐 깊이(Queue Depth) 현황판 제공.
* **REQ-INB-02 (큐 내용 및 임대 상태 구분 - Critical)**:
  * `GET /api/v1/admin/inbox/{identity}`를 통해 특정 신원의 큐에 쌓인 메시지 ID, 발신자, 타임스탬프, 크기, 현재 리스(`leased`) 여부 표시.
  * **Leased 상태 시각화**: "전체 적체 N건"과 "소비자가 처리 중인 Leased M건"을 명확히 분리 표시하여, 수신 프로세스 다운 등으로 인한 임대 고착 상태를 운영자가 즉각 식별할 수 있도록 함.
  * **본문 비공개 원칙 준수**: 인박스 조회 API는 보안 및 권한 분리 원칙에 따라 메시지 본문(Body)을 반환하지 않으며, 본문 조회가 필요한 경우 감사 로그(`chat-audits`)로 유도.

---

### 3.5. 실시간 메시지 감사 (Chat Audits & Stream - SPEC § 9.1)

* **REQ-AUD-01 (실시간 SSE 피드)**:
  * `GET /api/v1/admin/chat-audits/stream?token=...` 연결로 신규 감사 메시지 실시간 수신.
  * 연결 상태 인디케이터 (초록 점: Live, 주황/빨간 점: 재연결 중).
* **REQ-AUD-02 (커서 기반 무한 스크롤 / 과거 로그 페이징)**:
  * `GET /api/v1/admin/chat-audits?before=<cursor>&limit=50`을 통한 과거 로그 탐색.
  * 상단 스크롤 시 자동 로딩 (`IntersectionObserver` 활용).
* **REQ-AUD-03 (다차원 필터링 및 검색)**:
  * `From Agent` 및 `To Agent` 드롭다운 필터 (`GET /api/v1/admin/chat-audits/agents` 목록 연동).
  * 본문 텍스트 키워드 검색.
* **REQ-AUD-04 (스마트 스크롤 UX)**:
  * 뷰포트가 최하단에 있을 때는 새 메시지 도착 시 자동 스크롤.
  * 과거 로그를 읽는 중 새 메시지 도착 시 플로팅 알림 버튼("⬇ 새 메시지 N개 · 바닥으로") 표시.

---

### 3.6. AI 계정 사용량 및 쿼터 모니터링 (AI Usage Dashboard)

* **REQ-AI-01 (실시간 사용량 스냅샷 & 요약 바)**:
  * `GET /api/v1/admin/ai-usage` 및 `GET /api/v1/admin/ai-usage/stream` 연동.
  * 전체 활성 AI 계정 요약 상태 (정상, 경고, 소진 등) 상단 고정 바 제공.
* **REQ-AI-02 (공급자별 계정 상세 카드)**:
  * 공급자(Claude, Codex, Gemini 등)별 카드 그리드.
  * 리셋 윈도우(5시간, 7일 등) 게이지 바 및 5단계 리스크 레벨 색상(`none`, `info`, `warn`, `danger`, `stop`).
* **REQ-AI-03 (KST 기준 시간 표기 및 Staleness Ticker)**:
  * 모든 갱신 시각 및 잔여 시간을 한국 표준시(KST) 기준 상대/절대 시간으로 실시간 틱 갱신.

---

## 4. UI/UX 및 디자인 시스템 요건 (Non-Functional)

1. **테마 및 환경 시각화**:
   * Production (`#1a1a2e` 기반 다크 테마)과 Dev (`#1e2a3a` 기반 블루 다크 테마 + DEV 배지)의 명확한 시각적 분리.
2. **반응형 지원 (Desktop & PWA Mobile)**:
   * 데스크톱 다중 열 그리드 및 모바일 단일 열 스택 뷰 자동 대응.
3. **접근성 및 시맨틱 마크업**:
   * ARIA 라이브 리전(`aria-live="polite"`, `role="log"`, `role="region"`)을 적용하여 동적 갱신 요소 지원.
4. **메모리 및 DOM 최적화**:
   * 실시간 스트림 데이터의 무한 증식 방지 (최대 500개 메시지 윈도우 유지 및 상단 가상화).

---

## 5. 어드민 API 엔드포인트 매핑 매트릭스

| 화면 영역 | 엔드포인트 | 메서드 | 인증 | 기능 설명 |
|---|---|---|---|---|
| **인증 판별** | `/auth/me` | GET | Session | 현재 세션 유효성 및 승인 여부 판정 |
| **사용자 승인** | `/api/v1/admin/pending` | GET | Admin JWT | 승인 대기 사용자 목록 |
| | `/api/v1/admin/approve` | POST | Admin JWT | 사용자 승인 |
| | `/api/v1/admin/deny` | POST | Admin JWT | 사용자 거부 |
| | `/api/v1/admin/users` | GET | Admin JWT | 등록된 사용자 목록 |
| **키 승인** | `/api/v1/admin/keys/pending` | GET | Admin JWT | 승인 대기 키 목록 |
| | `/api/v1/admin/keys/:identity` | GET | Admin JWT | 특정 신원의 키 이력 |
| | `/api/v1/admin/keys/approve` | POST | Admin JWT | 지문 기준 키 승인 |
| | `/api/v1/admin/keys/deny` | POST | Admin JWT | 지문 기준 키 거부 |
| | `/api/v1/admin/keys/revoke` | POST | Admin JWT | 지문 기준 키 폐기 |
| **타입 레지스트리** | `/api/v1/admin/agent-types` | GET/POST | Admin JWT | 에이전트 타입 목록 및 등록 |
| | `/api/v1/admin/agent-types/:type` | DELETE | Admin JWT | 에이전트 타입 삭제 |
| **신원 Teardown** | `/api/v1/admin/agents/:identity` | DELETE | Admin JWT | 신원 영구 소프트 삭제 |
| **인박스 큐** | `/api/v1/admin/inbox` | GET | Admin JWT | 신원별 인박스 큐 깊이 |
| | `/api/v1/admin/inbox/:identity` | GET | Admin JWT | 신원별 큐 상세 및 임대 상태 |
| **감사 로그** | `/api/v1/admin/chat-audits` | GET | Admin JWT | 커서 페이징 감사 로그 |
| | `/api/v1/admin/chat-audits/stream` | GET (SSE) | Admin JWT | 실시간 감사 로그 스트림 |
| | `/api/v1/admin/chat-audits/agents` | GET | Admin JWT | 감사 로그 참여 에이전트 목록 |
| **AI 사용량** | `/api/v1/admin/ai-usage` | GET | Admin JWT | AI 사용량 스냅샷 |
| | `/api/v1/admin/ai-usage/stream` | GET (SSE) | Admin JWT | 실시간 AI 사용량 SSE 스트림 |

---

## 6. 향후 구현 단계 로드맵

1. **1단계 (기반 구축)**: 신규 어드민 레이아웃 셸, 탭 네비게이션, 테마 시스템 고도화
2. **2단계 (승인 및 보안)**: 사용자 승인 + 키 지문 대조 승인 뷰 통합 구현
3. **3단계 (레지스트리 & 인박스)**: 에이전트 타입 관리, Teardown 모달, 인박스 큐 뷰어 구현
4. **4단계 (실시간 모니터링)**: 실시간 Chat Audits 무한 스크롤 및 AI Usage 카드 컴포넌트 완성
5. **5단계 (검증 및 테스트)**: 타입체크, E2E 통합 테스트, `auth-sweep` 및 접근성 검증
