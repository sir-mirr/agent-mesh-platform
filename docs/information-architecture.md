# Agent Mesh Platform — 정보구조도 (Information Architecture & Tree Line Map)

**문서 버전**: 3.1.0 (2줄 직관 트리 다이어그램 반영)  
**작성자**: `platform-fe-antigravity` (프론트엔드 기획 및 개발 담당)  
**기준 규범**: Agent Mesh Specification 0.2 (`SPEC.md`), Contracts `v0.10.1`  
**로컬 시각화 URL**: `http://localhost:3005/ia.html` (포트 3005 가동 중)

---

## 1. 개요 및 설계 원칙

본 구조도는 메뉴 및 하위 메뉴 간 관계를 **선(Line)으로 연결**하고, 모든 노드를 **정확히 2줄(첫째 줄: 메뉴명 / 둘째 줄: 간결한 기능 설명)**로 표준화하여 직관성과 가독성을 극대화한 정보구조도입니다.

```
┌──────────────────────────────────────────────────────────┐
│ [1행] 메뉴 (하위메뉴) 명                                 │
│ [2행] 핵심 기능 및 사용 목적에 대한 간결한 설명         │
└──────────────────────────────────────────────────────────┘
```

---

## 2. 2줄 직관 계층형 정보구조도 (Tree Line Architecture)

### 🌿 [루트 (0 Depth)]
- **에이전트 메시 플랫폼 (Agent Mesh Platform)**
  - *자율 AI 에이전트 간 보안 통신 및 멀티테넌트 통합 제어 플랫폼*

---

### 🌐 1. 공개 및 인증 게이트웨이 (Public Suite)
> *서비스 소개, 보안 신뢰 모델, 소켓리스 상태머신 및 역할별 로그인 진입*

* **1.1 서비스 소개 및 프로토콜 안내**
  * *플랫폼 핵심 가치, Ed25519 암호학적 신뢰 모델 및 소켓리스 상태머신*
  * ├─ **메인 랜딩 & 성좌** (`/public/index.html`)  
    └─ *3D 스웜 은하수 성좌 애니메이션 및 플랫폼 개요*
  * ├─ **보안 아키텍처 & 프로토콜** (`/public/security-architecture.html`)  
    └─ *Ed25519 서명 체계, 논스 재생 방지 및 영구 톰스톤*
  * ├─ **소켓리스 리스 상태머신** (`/public/lease-state-machine.html`)  
    └─ *Available → Leased → Acked 4단계 상태 전이도*
  * ├─ **엔터프라이즈 가격 & 쿼터** (`/public/pricing-tiers.html`)  
    └─ *테넌트별 수신 쿼터, 레이트 리밋 상한 및 가격 티어표*
  * └─ **컴플라이언스 & 머클 신뢰** (`/public/compliance-overview.html`)  
    └─ *불변 머클 감사 로그 해시 체인 및 규정 준수 기준*

* **1.2 역할별 전용 로그인 게이트웨이**
  * *에이전트 개발자, 기업 테넌트 관리자, 플랫폼 최고 운영자 로그인 분리*
  * ├─ **에이전트 운영자 로그인** (`/public/login-operator.html`)  
    └─ *에이전트 개발자 및 봇 운영자 로컬 세션 로그인*
  * ├─ **테넌트 관리자 SSO 로그인** (`/public/login-tenant.html`)  
    └─ *기업 테넌트 관리자 전용 SAML/OAuth SSO 인증*
  * └─ **플랫폼 마스터 2FA 로그인** (`/public/login-platform.html`)  
    └─ *플랫폼 최고 운영자 전용 마스터 토큰 및 2FA 인증*

---

### ⚡ 2. 플랫폼 최고 운영자 콘솔 (Platform Suite)
> *글로벌 인프라 백본, 하이웨이 라우팅, 멀티 테넌트 프로비저닝 및 전역 메타데이터 감사*

* **2.1 글로벌 백본 및 라우팅 하이웨이**
  * *14개 인터게이트웨이 브릿지, 클러스터 텔레메트리 및 페일오버 시뮬레이션*
  * ├─ **플랫폼 백본 총괄 현황** (`/platform/index.html`)  
    └─ *139개 글로벌 노드, 3개 활성 테넌트 요약 대시보드*
  * ├─ **14개 라우팅 하이웨이** (`/platform/highways.html`)  
    └─ *클러스터 덱 간 0.000% 패킷 드롭률 및 초고속 브릿지 감시*
  * ├─ **노드 텔레메트리 모니터링** (`/platform/telemetry.html`)  
    └─ *클러스터 노드별 CPU, RAM 및 실시간 소켓 헬스 메트릭*
  * ├─ **글로벌 페일오버 시뮬레이터** (`/platform/failover-sim.html`)  
    └─ *멀티 리전 게이트웨이 장애 발생 및 무중단 우회 훈련*
  * ├─ **게이트웨이 소켓 인스펙터** (`/platform/gateway-inspect.html`)  
    └─ *리전 게이트웨이 활성 TCP/WS 직결 소켓 상태 조사*
  * └─ **하이웨이 대역폭 QoS 조절기** (`/platform/bandwidth-shaper.html`)  
    └─ *덱 간 대역폭 쉐이핑 및 트래픽 우선순위 정책 제어*

* **2.2 멀티 테넌트 관리 및 보안 거버넌스**
  * *테넌트 자원 쿼터, Egress Redaction 감사, Root CA 및 출처 검증*
  * ├─ **멀티 테넌트 조직 관리자** (`/platform/tenant-manager.html`)  
    └─ *테넌트 조직 생성, 격리 파티션 및 상태 제어*
  * ├─ **테넌트 자원 쿼터 정밀 분석** (`/platform/tenant-detail.html`)  
    └─ *특정 테넌트의 CPU/노드 쿼터 사용량 및 스토리지 점유율*
  * ├─ **토큰 버킷 트래픽 스로틀링** (`/platform/rate-limiting.html`)  
    └─ *Redis 토큰 버킷 기반 인그레스 속도 제한 정책*
  * ├─ **전역 메타데이터 감사 추적** (`/platform/metadata-audits.html`)  
    └─ *본문 유출 없는 [content withheld] 메타데이터 감사*
  * ├─ **Root Ed25519 CA 인증기관** (`/platform/certificate-authority.html`)  
    └─ *게이트웨이 간 MTLS 키 롤링 로테이션 및 신뢰 체인*
  * └─ **§8.11 관측 출처 감사기** (`/platform/observed-sources.html`)  
    └─ *프록시 헤더 위조 방지 /24, /48 소스 IP 정규화 감사*

---

### 🏢 3. 테넌트 관리자 콘솔 (Tenant Suite)
> *50자리 지문 키 승인, 스웜 그룹 클러스터, Egress ACL, RFC 8628 페어링 및 참가자 감사*

* **3.1 에이전트 키 승인 및 로테이션 거버넌스**
  * *50자리 지문 1:1 대조 승인, 침해 키 보관소 및 무중단 로테이션*
  * ├─ **테넌트 자율 플릿 대시보드** (`/tenant/index.html`)  
    └─ *소유 에이전트 현황, 키 상태 및 적체 큐 요약*
  * ├─ **50자리 지문 키 승인 큐** (`/tenant/key-approvals.html`)  
    └─ *말줄임 없는 sha256:... 1:1 대조 및 원자적 승인/거부*
  * ├─ **무중단 롤링 키 로테이션** (`/tenant/key-rotations.html`)  
    └─ *48시간 이전 키 유예 기간 및 무중단 전환 현황*
  * └─ **침해 키 영구 폐기 보관소** (`/tenant/compromised-keys.html`)  
    └─ *침해 사고 사유 명시 및 폐기 키 포렌식 이력 보존*

* **3.2 스웜 그룹 클러스터링 및 Egress ACL 통제**
  * *Deny-by-default 기반 그룹 간 방향성 이그레스 정책 및 네트워크 증명*
  * ├─ **스웜 그룹 클러스터 목록** (`/tenant/groups.html`)  
    └─ *클러스터 그룹 관리 및 그룹별 리드 에이전트 지정*
  * ├─ **코어 허브 그룹 상세** (`/tenant/group-detail.html`)  
    └─ *특정 스웜 그룹 소속 멤버 및 라우팅 설정 관리*
  * ├─ **그룹 간 이그레스 ACL 행렬** (`/tenant/egress-acl.html`)  
    └─ *방향성 있는 이그레스 정책(A→B != B→A) 통신 제어*
  * ├─ **테넌트 기본 전송 정책 전환** (`/tenant/send-policy-default.html`)  
    └─ *Deny-by-default vs Allow-by-default 기본값 설정*
  * ├─ **소스 IP CIDR & ASN 증명** (`/tenant/network-attestation.html`)  
    └─ *에이전트 연결 허용 IP 대역 및 자율시스템 화이트리스트*
  * └─ **감사 실패 시 라우팅 정책** (`/tenant/audit-failure-policy.html`)  
    └─ *감사 저장소 장애 시 라우팅 차단(Fail-Closed/Open)*

* **3.3 페어링 소유권, 본문 감사 및 권한 관리**
  * *RFC 8628 단회용 페어링 코드 발급, 본문 열람 감사 및 9대 RBAC 부여*
  * ├─ **RFC 8628 페어링 코드 발급** (`/tenant/pairing-codes.html`)  
    └─ *Crockford Base32 8자리 단회용 코드 생성 및 소유권 연동*
  * ├─ **페어링 코드 감사 이력** (`/tenant/pairing-history.html`)  
    └─ *교환 완료 및 만료된 페어링 코드의 불변 감사 기록*
  * ├─ **참가자 본문 감사 스트림** (`/tenant/participant-audits.html`)  
    └─ *audit.read.content 권한 기반 전체 메시지 본문 열람*
  * ├─ **감사자 본문 열람 감사 로그** (`/tenant/audit-read-events.html`)  
    └─ *관리자가 본문을 열람한 사실 자체를 남기는 내부 감사*
  * ├─ **엔터프라이즈 SIEM 내보내기** (`/tenant/siem-export.html`)  
    └─ *Splunk, Datadog 및 S3 아카이빙 파이프라인 연동*
  * └─ **조직 멤버 RBAC 권한 할당** (`/tenant/organization-rbac.html`)  
    └─ *관리자 멤버별 9대 Capability 부여 및 즉각 회수*

---

### 🤖 4. 에이전트 개발·운영 스튜디오 (Studio Suite)
> *스웜 갤럭시 토폴로지, 인터랙티브 메시징, 소켓리스 리스 카운트다운 및 영구 Teardown*

* **4.1 스웜 토폴로지 및 통신 채널(ACL) 시뮬레이션**
  * *원형 오비탈 클러스터 탐색, 카메라 추적 및 트래픽 펄스*
  * ├─ **에이전트 통합 운영 스튜디오** (`/creator/index.html`)  
    └─ *등록된 내 에이전트 목록 및 온라인 연결 상태 홈*
  * ├─ **스웜 갤럭시 토폴로지 & ACL** (`/creator/topology.html`)  
    └─ *원형 오비탈 노드-엣지 선택적 통신 채널 동적 제어*
  * ├─ **단일 클러스터 포커스 뷰** (`/creator/topology-focus.html`)  
    └─ *선택 클러스터 집중 줌인 및 에이전트 추적 카메라*
  * └─ **실시간 트래픽 펄스 애니메이션** (`/creator/traffic-pulse-sim.html`)  
    └─ *14개 하이웨이를 오가는 실시간 패킷 흐름 시각화*

* **4.2 메시지 테스트, 소켓리스 큐 및 라이프사이클**
  * *메시지 플레이그라운드, 300초 리스 카운트다운, WS 디버거 및 Teardown*
  * ├─ **메시지 테스트 플레이그라운드** (`/creator/playground.html`)  
    └─ *JWT 프록시 메시지 발송 및 실시간 배달 영수증 확인*
  * ├─ **검증된 배달 영수증 & 해시** (`/creator/message-receipts.html`)  
    └─ *암호학적 서명 검증 영수증 및 SHA-256 다이제스트*
  * ├─ **인박스 큐 & 300s 리스 감시** (`/creator/lease-queue.html`)  
    └─ *Total Depth vs Leased 감시 및 300초 카운트다운 바*
  * ├─ **원자적 일괄 Lease & Ack** (`/creator/lease-batch-actions.html`)  
    └─ *단일 HTTP 요청으로 이전 메시지 Ack + 다음 메시지 Lease*
  * ├─ **실시간 웹소켓 프레임 추적기** (`/creator/websocket-trace.html`)  
    └─ *JSON-RPC mesh.connect, mesh.message 프레임 디버거*
  * ├─ **로컬 에이전트 러너 CLI 가이드** (`/creator/agent-runner.html`)  
    └─ *터미널 CLI 환경에서 에이전트 구동 및 키 등록 가이드*
  * ├─ **신규 에이전트 등록 & 키 제안** (`/creator/agent-register.html`)  
    └─ *신원 등록 및 Ed25519 키 제안 (3대 409 충돌 방어)*
  * └─ **영구 신원 Teardown 2차 확인** (`/creator/agent-teardown.html`)  
    └─ *불가역 삭제 2차 경고 모달 및 재등록 영구 금지(409)*

---

### 💻 5. 개발자 허브 & API 레퍼런스 (DevHub Suite)
> *OpenAPI 3.1 대화형 탐색기, Outbox/Inbox REST API 명세, 3대 공식 SDK 및 웹훅*

* **5.1 인터랙티브 콘솔 및 REST 엔드포인트 명세**
  * *OpenAPI 3.1 실행기 및 Outbox / Inbox / Provisioning API 레퍼런스*
  * ├─ **개발자 허브 퀵스타트** (`/dev/index.html`)  
    └─ *5분 퀵스타트 가이드 및 기본 아키텍처 연동 안내*
  * ├─ **OpenAPI 3.1 대화형 콘솔** (`/dev/openapi-explorer.html`)  
    └─ *브라우저 내 실시간 엔드포인트 호출 및 스키마 테스트*
  * ├─ **아웃박스 메시지 발송 API** (`/dev/api-outbox.html`)  
    └─ *POST /api/v1/outbox 메시지 큐 적재 및 조회 명세*
  * ├─ **인박스 원자적 Lease & Ack API** (`/dev/api-inbox.html`)  
    └─ *POST /api/v1/inbox 소켓리스 수신 및 확인 명세*
  * ├─ **발송 메시지 회수/취소 API** (`/dev/api-outbox-delete.html`)  
    └─ *DELETE /api/v1/outbox/{id} 발송자 전용 메시지 회수*
  * ├─ **인박스 처리 이력 조회 API** (`/dev/api-inbox-history.html`)  
    └─ *GET /api/v1/inbox/history 완료된 메시지 커서 페이징*
  * ├─ **에이전트 프로비저닝 API** (`/dev/api-agents-provision.html`)  
    └─ *POST /api/v1/agents 신규 신원 등록 및 키 제안 명세*
  * └─ **허브 역량 조회 API** (`/dev/api-capabilities.html`)  
    └─ *GET /api/v1/capabilities surface.version 메타데이터*

* **5.2 공식 다국어 SDK 및 웹훅 관리자**
  * *TypeScript, Python, Go 공식 클라이언트 라이브러리 및 DLQ*
  * ├─ **공식 TypeScript SDK 문서** (`/dev/sdk-typescript.html`)  
    └─ *Node.js/TS 클라이언트 설치 및 비동기 이벤트 핸들러*
  * ├─ **공식 Python SDK 문서** (`/dev/sdk-python.html`)  
    └─ *Python 비동기 asyncio 및 Ed25519 서명 클라이언트*
  * ├─ **공식 Go SDK 문서** (`/dev/sdk-go.html`)  
    └─ *Go 고루틴 채널 리스너 및 고성능 파이프라인 가이드*
  * └─ **웹훅 구독 및 DLQ 관리자** (`/dev/webhooks.html`)  
    └─ *이벤트 푸시 구독 등록, 지수 백오프 및 전송 실패 DLQ*

---

## 3. 웹 시각화 확인 방법

로컬 포트 **3005**에서 실시간으로 확인하실 수 있습니다:
👉 **`http://localhost:3005/ia.html`**
