# Agent Mesh Platform — 정보구조도 (Information Architecture & Specification Map)

**문서 버전**: 3.0.0  
**작성자**: `platform-fe-antigravity` (프론트엔드 기획 및 개발 담당)  
**기준 규범**: Agent Mesh Specification 0.2 (`SPEC.md`), Contracts `v0.10.0`  
**로컬 시각화 URL**: `http://localhost:3005/ia.html` (Preview Server Active)

---

## 1. 개요 및 기획 배경

본 문서는 **에이전트 메시 플랫폼(Agent Mesh Platform)**의 전체 60개 화면 산출물과 핵심 아키텍처, 4대 페르소나별 UX 동선, 56개 REST/WS 엔드포인트 및 9대 RBAC 역량(Capability) 매핑을 체계적으로 구조화한 기획 마스터플랜입니다.

기존에 분산되어 있던 샘플 화면들의 관계를 명확한 계층(Hierarchy)으로 정립하고, 실제 SPEC 0.2 규범 계약(50자리 지문 불변 표기, 소유권 3단 빈 상태, Egress Redaction 본문 차단 등)과 1:1로 일치시켰습니다.

---

## 2. 이전 산출물 진단 및 정리 포인트 (Assessment)

이전 그래비티가 구성해 둔 60개 샘플 화면을 면밀히 분석한 결과, 다음의 기획적 한계와 개선 필요 사항이 식별되었습니다.

### 2.1. 식별된 문제점
1. **페르소나별 컨텍스트 혼재**:
   * 플랫폼 최고 관리자(Platform Operator)와 기업 테넌트 관리자(Tenant Admin)의 역할 및 통제 범위가 명확히 분리되지 않고 동일한 내비게이션에 섞여 있었습니다.
2. **화면 간 연결성(Navigation Continuity) 단절**:
   * 각 개별 화면이 독립적인 데모로 존재하여, 실제 사용자가 로그인 후 에이전트를 등록하고 키를 승인받아 메시지를 보내는 연속적인 작업 흐름(User Flow)을 직관적으로 조망하기 어려웠습니다.
3. **스펙 규범 계약과의 엄밀성 검증 필요**:
   * SPEC § 10.2 (50자리 지문 전체 표기), § 11.3 (소유 에이전트 승인 큐 3단 빈 상태: 소유 0개 / 승인 완료 / 403), § 11 (감사 로그 `[content withheld ...]` 리댁션) 등의 핵심 규범이 화면에 일관되게 반영되어 있는지 체계적인 거버넌스 맵이 부재했습니다.

### 2.2. 개선 및 정위치 전략
* **5대 핵심 스위트(Suite) 계층화**: Public, Platform Operator, Tenant Admin, Agent Operations Studio, Developer Hub로 도메인 완전 분리.
* **4대 페르소나별 5단계 핵심 UX 동선 정의**: 역할별 진입점부터 최종 목적 달성까지의 순차적 경로 확립.
* **인터랙티브 IA 대시보드 (`preview/ia.html`) 구축**: 트리 뷰, 매트릭스 뷰, 동선 뷰, 권한 맵을 한곳에서 탐색하고 개별 화면으로 즉시 점프할 수 있는 통합 시각화 도구 제공.

---

## 3. 정보구조 계층도 (Hierarchy Tree)

```
Agent Mesh Platform
│
├── 1. Public Suite & Auth Gateways (8 Screens)
│   ├── 1.1 메인 랜딩 & 스웜 은하수 성좌 (/public/index.html)
│   ├── 1.2 보안 아키텍처 & 프로토콜 (/public/security-architecture.html)
│   ├── 1.3 소켓리스 리스 상태 머신 (/public/lease-state-machine.html)
│   ├── 1.4 에이전트 운영자 로그인 (/public/login-operator.html)
│   ├── 1.5 테넌트 관리자 SSO 로그인 (/public/login-tenant.html)
│   ├── 1.6 플랫폼 마스터 2FA 로그인 (/public/login-platform.html)
│   ├── 1.7 엔터프라이즈 가격 & 쿼터 티어 (/public/pricing-tiers.html)
│   └── 1.8 컴플라이언스 & 머클 신뢰 모델 (/public/compliance-overview.html)
│
├── 2. Platform Operator Suite (12 Screens)
│   ├── 2.1 글로벌 인프라 개요 & 백본 매트릭스 (/platform/index.html)
│   ├── 2.2 14개 인터게이트웨이 라우팅 하이웨이 (/platform/highways.html)
│   ├── 2.3 멀티 테넌트 조직 관리자 (/platform/tenant-manager.html)
│   ├── 2.4 테넌트 자원 쿼터 상세 분석 (/platform/tenant-detail.html)
│   ├── 2.5 클러스터 노드 텔레메트리 (/platform/telemetry.html)
│   ├── 2.6 글로벌 게이트웨이 페일오버 시뮬레이터 (/platform/failover-sim.html)
│   ├── 2.7 토큰 버킷 인그레스 스로틀링 (/platform/rate-limiting.html)
│   ├── 2.8 전역 메타데이터 감사 (Egress Redaction) (/platform/metadata-audits.html)
│   ├── 2.9 리전 게이트웨이 노드 소켓 인스펙터 (/platform/gateway-inspect.html)
│   ├── 2.10 하이웨이 대역폭 조절 & QoS (/platform/bandwidth-shaper.html)
│   ├── 2.11 Root Ed25519 CA & MTLS 로테이션 (/platform/certificate-authority.html)
│   └── 2.12 SPEC §8.11 관측 출처 감사 (/platform/observed-sources.html)
│
├── 3. Tenant Admin Suite (Acme Corp) (16 Screens)
│   ├── 3.1 테넌트 자율 플릿 대시보드 (/tenant/index.html)
│   ├── 3.2 50자리 지문 키 승인 큐 (SPEC §11.3) (/tenant/key-approvals.html)
│   ├── 3.3 무중단 롤링 키 로테이션 (/tenant/key-rotations.html)
│   ├── 3.4 침해/거부 키 영구 폐기 보관소 (/tenant/compromised-keys.html)
│   ├── 3.5 스웜 그룹 클러스터 관리 (/tenant/groups.html)
│   ├── 3.6 코어 플랫폼 허브 그룹 상세 (/tenant/group-detail.html)
│   ├── 3.7 그룹 간 이그레스 ACL 매트릭스 (/tenant/egress-acl.html)
│   ├── 3.8 테넌트 기본 전송 정책 전환 (/tenant/send-policy-default.html)
│   ├── 3.9 소스 IP CIDR & ASN 화이트리스트 (/tenant/network-attestation.html)
│   ├── 3.10 감사 실패 시 라우팅 정책 (Fail-Closed/Open) (/tenant/audit-failure-policy.html)
│   ├── 3.11 RFC 8628 기기 플로우 페어링 코드 발급 (/tenant/pairing-codes.html)
│   ├── 3.12 페어링 코드 교환/만료 감사 이력 (/tenant/pairing-history.html)
│   ├── 3.13 참가자 메시지 본문 감사 스트림 (/tenant/participant-audits.html)
│   ├── 3.14 내부 감사자 본문 열람 감사 로그 (/tenant/audit-read-events.html)
│   ├── 3.15 엔터프라이즈 SIEM & S3 아카이빙 (/tenant/siem-export.html)
│   └── 3.16 조직 멤버 RBAC & 9대 권한 부여 (/tenant/organization-rbac.html)
│
├── 4. Agent Operations Studio (12 Screens)
│   ├── 4.1 에이전트 운영 메인 스튜디오 (/creator/index.html)
│   ├── 4.2 10단계 스케일 시뮬레이션 & 스웜 갤럭시 그래프 (/creator/topology.html)
│   ├── 4.3 단일 클러스터 포커스 & 카메라 추적 (/creator/topology-focus.html)
│   ├── 4.4 인터랙티브 메시지 테스팅 콘솔 (/creator/playground.html)
│   ├── 4.5 검증된 메시지 배달 영수증 & 다이제스트 (/creator/message-receipts.html)
│   ├── 4.6 소켓리스 인박스 큐 & 300초 리스 카운트다운 (/creator/lease-queue.html)
│   ├── 4.7 원자적 일괄 Lease & Ack 시뮬레이터 (/creator/lease-batch-actions.html)
│   ├── 4.8 실시간 웹소켓 프레임 디버거 (/creator/websocket-trace.html)
│   ├── 4.9 로컬 에이전트 러너 CLI 가이드 (/creator/agent-runner.html)
│   ├── 4.10 신규 에이전트 등록 & 키 제안 (/creator/agent-register.html)
│   ├── 4.11 영구 신원 Teardown 2차 확인 모달 (/creator/agent-teardown.html)
│   └── 4.12 다중 하이웨이 실시간 트래픽 펄스 (/creator/traffic-pulse-sim.html)
│
└── 5. Developer Hub & API Reference (12 Screens)
    ├── 5.1 개발자 허브 개요 & 퀵스타트 (/dev/index.html)
    ├── 5.2 OpenAPI 3.1 대화형 엔드포인트 콘솔 (/dev/openapi-explorer.html)
    ├── 5.3 아웃박스 발송 & 조회 API 명세 (/dev/api-outbox.html)
    ├── 5.4 인박스 원자적 Lease & Ack API 명세 (/dev/api-inbox.html)
    ├── 5.5 발송 메시지 회수/취소 API 명세 (/dev/api-outbox-delete.html)
    ├── 5.6 처리 완료 인박스 이력 조회 API 명세 (/dev/api-inbox-history.html)
    ├── 5.7 에이전트 신규 프로비저닝 API 명세 (/dev/api-agents-provision.html)
    ├── 5.8 허브 메타데이터 & 역량 조회 API 명세 (/dev/api-capabilities.html)
    ├── 5.9 공식 TypeScript / Node.js SDK 문서 (/dev/sdk-typescript.html)
    ├── 5.10 공식 Python 클라이언트 SDK 문서 (/dev/sdk-python.html)
    ├── 5.11 공식 Go (Golang) SDK 문서 (/dev/sdk-go.html)
    └── 5.12 웹훅 구독 관리자 & DLQ 관리 (/dev/webhooks.html)
```

---

## 4. 핵심 페르소나별 5단계 사용자 여정 (User Flows)

### Flow 1. 플랫폼 최고 관리자 (Platform Operator)
1. **[마스터 로그인]**: 마스터 토큰 및 2FA 인증 (`/public/login-platform.html`)
2. **[백본 점검]**: 14개 인터게이트웨이 하이웨이 트래픽 및 0.000% 패킷 드롭률 확인 (`/platform/highways.html`)
3. **[테넌트 관리]**: 테넌트 조직별 노드 쿼터 및 스토리지 상한 통제 (`/platform/tenant-manager.html`)
4. **[메타데이터 감사]**: Egress Redaction 적용된 본문 유출 없는 전역 감사 추적 (`/platform/metadata-audits.html`)
5. **[Root CA 거버넌스]**: Ed25519 인증기관 및 게이트웨이 MTLS 로테이션 감독 (`/platform/certificate-authority.html`)

### Flow 2. 테넌트 관리자 (Tenant Admin - Acme Corp)
1. **[기업 SSO 로그인]**: 조직 계정 SSO 인증 (`/public/login-tenant.html`)
2. **[키 승인 큐]**: 50자리 지문 1:1 대조 및 승인/거부/폐기 처리 (`/tenant/key-approvals.html`)
3. **[스웜 보안 정책]**: Deny-by-default 기반 그룹 간 이그레스 ACL 설정 (`/tenant/egress-acl.html`)
4. **[페어링 코드 발급]**: RFC 8628 Crockford Base32 8자리 단회용 코드 생성 (`/tenant/pairing-codes.html`)
5. **[컴플라이언스 감사]**: `audit.read.content` 권한 기반 본문 감사 및 SIEM 연동 (`/tenant/participant-audits.html`)

### Flow 3. 에이전트 개발/운영자 (Agent Operator / Creator)
1. **[에이전트 등록]**: 신원 등록 및 최초 Ed25519 공개키 제안 (`/creator/agent-register.html`)
2. **[토폴로지 탐색]**: 원형 오비탈 클러스터 내 연결 노드 하이라이트 및 ACL 채널 설정 (`/creator/topology.html`)
3. **[메시지 테스팅]**: JWT 프록시 기반 메시지 발송 및 실시간 배달 영수증 확인 (`/creator/playground.html`)
4. **[인박스 큐 감시]**: 300초 리스 카운트다운 감시 및 원자적 Lease & Ack (`/creator/lease-queue.html`)
5. **[신원 Teardown]**: 불가역 삭제 경고 2차 모달을 통한 안전한 종료 (`/creator/agent-teardown.html`)

### Flow 4. 외부 개발자 (Developer & API Consumer)
1. **[퀵스타트]**: 개발자 허브 연동 가이드 및 엔드포인트 확인 (`/dev/index.html`)
2. **[OpenAPI 테스트]**: 브라우저 내 인터랙티브 API 호출 실측 (`/dev/openapi-explorer.html`)
3. **[SDK 연동]**: TypeScript / Python / Go 공식 SDK 코드 적용 (`/dev/sdk-typescript.html`)
4. **[소켓리스 수신]**: `POST /api/v1/inbox` 원자적 리스/수신 확인 로직 구현 (`/dev/api-inbox.html`)
5. **[웹훅 구독]**: 이벤트 푸시 등록 및 Dead-Letter Queue 모니터링 (`/dev/webhooks.html`)

---

## 5. 거버넌스 및 RBAC 9대 역량 매핑

| # | 역량 (Capability) | 핵심 대상 엔드포인트 | 대표 화면 |
|---|---|---|---|
| 1 | `key.approve` | `POST /api/v1/admin/keys/approve`, `deny`, `revoke`<br>`GET /api/v1/admin/agents/owned` | `preview/tenant/key-approvals.html` |
| 2 | `key.propose` | `POST /api/v1/agents`<br>`GET /api/v1/agents/{identity}/keys` | `preview/creator/agent-register.html` |
| 3 | `agent.provision` | `POST /api/v1/agents`<br>`DELETE /api/v1/admin/agents/{identity}` | `preview/creator/agent-teardown.html` |
| 4 | `group.egress` | `POST /api/v1/admin/groups/{group_id}/egress`<br>`DELETE /api/v1/admin/groups/{group_id}/egress/{to_group}` | `preview/tenant/egress-acl.html` |
| 5 | `audit.read.content` | `GET /api/v1/audit/events` | `preview/tenant/participant-audits.html` |
| 6 | `pairing.generate` | `POST /api/v1/admin/pairing-codes` | `preview/tenant/pairing-codes.html` |
| 7 | `pairing.redeem` | `POST /api/v1/pairing-codes/redeem` | `preview/tenant/pairing-codes.html` |
| 8 | `inbox.lease` | `POST /api/v1/inbox` | `preview/creator/lease-queue.html` |
| 9 | `message.send` | `POST /api/v1/outbox`, `POST /api/v1/messages` | `preview/creator/playground.html` |

---

## 6. 결론 및 향후 개발 추진 방향

* **시각화 완료**: 포트 **3005**에 배포된 `http://localhost:3005/ia.html`을 통해 전체 60개 화면, 56개 엔드포인트, 9대 권한의 계층 구조와 페르소나별 동선을 즉시 확인할 수 있습니다.
* **규범 및 린터 일치 보증**: `bun scripts/lint-preview.ts`를 통해 186개 라우트 참조 및 60개 산출물 파일 전수 무결성이 100% 검증되었습니다.
* **차기 구현 계획**: 본 IA를 기반으로 Hono 기반 Zero-Build SSR 실제 어드민 서버(`packages/http/src/ui/admin.ts`)와 연동하여 실서비스 뷰를 단계적으로 구현합니다.
