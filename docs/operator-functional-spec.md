# Agent Mesh Platform: 운영자 기능 목록 및 UX 동선 명세서
(Operator Functional Specification & UX Flow Diagrams)

**문서 버전**: 2.2.0 (Live Test Harness 실측 검증 및 전수 정합성 보정 완료)  
**작성자**: `platform-fe-antigravity` (Admin Frontend)  
**검증 방식**: Live E2E Harness cURL 전수 실측 및 `packages/http`, `packages/hub` 소스 레벨 전수 대조  
**수신자**: User (Project Lead)

---

## 1. 시스템 컴포넌트별 라우트 맵 및 보안 경계

```mermaid
graph TD
    User([사용자 / 브라우저]) -->|Admin Session: mesh_token| HTTPServer[Agent Mesh HTTP Server :3000]
    User -->|GitHub OAuth / Public| HTTPServer
    HTTPServer -->|Readonly SQLite| HubDB[(hub.db / inbox.db)]
    HTTPServer -->|Readonly SQLite| AuditDB[(audit.db)]
    HTTPServer -->|Read-Write SQLite| AgentsDB[(agents.db)]
    HTTPServer -->|Proxy Socket| HubServer[Agent Mesh Hub :3100]

    subgraph "HTTP Server (:3000) - 관리자 & 사용자 인터페이스"
        R_Auth["POST /auth/local (admin / admin)"]
        R_Pending["GET /api/v1/admin/keys/pending"]
        R_Approve["POST /api/v1/admin/keys/approve"]
        R_Deny["POST /api/v1/admin/keys/deny"]
        R_Revoke["POST /api/v1/admin/keys/revoke"]
        R_InboxAdmin["GET /api/v1/admin/inbox"]
        R_InboxAgent["GET /api/v1/admin/inbox/:identity"]
        R_Teardown["DELETE /api/v1/admin/agents/:identity"]
        R_Audit["GET /api/v1/audit/events"]
        R_Msg["POST /api/v1/messages"]
    end

    subgraph "Hub Server (:3100) - 무인증 에이전트 라우트"
        R_Cap["GET /api/v1/capabilities (surface.version: 2)"]
        R_Health["GET /health (online_agents)"]
        R_Provision["POST /api/v1/agents (신원 등록 & 키 제안)"]
        R_Keys["GET /api/v1/agents/:identity/keys"]
    end
```

---

## 2. 상세 기능 목록 (SEE & DO Matrix, 실측 엔드포인트 전수 반영)

### [A] 플랫폼 관리자 (Platform Operator / Admin)

| 기능 ID | 기능명 | 운영자가 **봐야 하는 것 (SEE)** | 운영자가 **해야 하는 것 (DO)** | 실측 엔드포인트 & 페이로드 |
| :--- | :--- | :--- | :--- | :--- |
| **F-ADM-01** | **암호학적 키 승인 및 거버넌스** | • 전체 에이전트의 승인 대기(`pending`) 키 목록<br>• **50자리 SHA-256 지문 전체** (`sha256:...`, 50자)<br>• 키 제안 시각(`proposed_at`), 공개키(`public_key`)<br>• 거부/취소 사유 및 `compromise` 위험 상태 배지 | • 50자리 지문 원클릭 복사<br>• 지문 기준 원자적 승인<br>• 사유 명시 거부/취소 (프리셋 선택 + 자유 텍스트 직접 입력) | `GET /api/v1/admin/keys/pending`<br>`POST /api/v1/admin/keys/approve` `{ fingerprint }`<br>`POST /api/v1/admin/keys/deny` `{ fingerprint, reason? }`<br>`POST /api/v1/admin/keys/revoke` `{ fingerprint, reason }` |
| **F-ADM-02** | **인박스 적체 및 임대 감시** | • 에이전트별 인박스 메트릭<br>• **`Total Depth (pending)` vs `Leased (leased)` vs `Available (pending - leased)`**<br>• `capabilities`의 `receive_lease_seconds` 기반 임대 시효 만료 안내<br>• 개별 메시지 메타데이터 (`id`, `from`, `ts`, `size`, `leased`) | • `readonly` 인박스 메트릭 조회 (임대 미발생 보증)<br>• **접근 분리 원칙**: 큐 조회 시 메시지 본문 미노출 확인 | `GET /api/v1/admin/inbox`<br>`GET /api/v1/admin/inbox/:identity`<br>`GET /api/v1/capabilities` |
| **F-ADM-03** | **실시간 불변 감사 포렌식** | • 실시간 감사 이벤트 스트림 (`GET /api/v1/audit/events`)<br>• 발신 주체 분리 표기 (**`from: alice_dev`, `sent_by: http-server` vs 에이전트 Ed25519 서명**)<br>• 메시지 시퀀스 ID, 타임스탬프, 첨부 블롭 해시 | • 송수신 에이전트별 / 시간대별 필터링<br>• 커서 기반 페이지네이션 (`next_cursor`) 및 블롭 해시 대조 | `GET /api/v1/audit/events?limit=50&cursor=...` |
| **F-ADM-04** | **영구 신원 Teardown 통제** | • 등록된 신원 목록 및 활성/삭제 상태 (`deleted: true/false`)<br>• 삭제된 신원의 톰스톤(Tombstone) 상태 | • 2단계 경고 모달을 통한 영구 삭제 실행 (`DELETE /api/v1/admin/agents/:identity`)<br>• 동일 신원 재등록 시도 시 `409 IDENTITY_DELETED` 에러 처리 보증 | `DELETE /api/v1/admin/agents/:identity`<br>(SPEC § 9.3 관리자 세션 필수) |
| **F-ADM-05** | **허브 메타데이터 & 헬스체크** | • `capabilities` 메타데이터 (`surface.version: 2`)<br>• WebSocket 온라인 에이전트 수 (`online_agents`)<br>• 지원 스펙 버전 (`agent_mesh_spec: "0.2"`) | • 허브 무서명 헬스체크 및 실시간 온라인 상태 모니터링 | `GET /api/v1/capabilities`<br>`GET /health` |

---

### [B] 에이전트 운영자 (Agent Operator / Workspace)

| 기능 ID | 기능명 | 운영자가 **봐야 하는 것 (SEE)** | 운영자가 **해야 하는 것 (DO)** | 실측 엔드포인트 & 페이로드 |
| :--- | :--- | :--- | :--- | :--- |
| **F-OPR-01** | **에이전트 신원 등록 및 키 제안/로테이션** | • 내가 소유한 등록 에이전트 목록<br>• 등록된 공개키 50자리 지문 및 승인/대기/취소 상태<br>• 온라인 WebSocket 연결 여부 | • 외부 에이전트 신원 신규 등록 및 최초 공개키 제안<br>• 새 Ed25519 공개키 제안(Key Rotation) 제출 | `POST /api/v1/agents`<br>`{ identity, type, public_key }`<br>`GET /api/v1/agents/:identity/keys` |
| **F-OPR-02** | **콘솔 메시지 테스트 (Playground)** | • 메시지 수신 가능한 활성/승인 에이전트 디렉토리<br>• 페이로드 편집기 (JSON/Text) 및 블롭 첨부 UI<br>• **즉각 배달 영수증** (`Delivered to WebSocket` / `Queued in Inbox #seq`) | • 콘솔 운영자 신원(`alice_dev`, via `http-server` 프록시)으로 테스트 메시지 전송<br>• 전송 레이턴시 및 배달 영수증 확인 | `POST /api/v1/messages`<br>`{ to, body }` (JWT 인증) |
| **F-OPR-03** | **에이전트 인박스 메타데이터 감시** | • 내 에이전트의 인박스 적체 메타데이터 (`Total Depth`, `Leased`, `Available`)<br>• 메시지 발신자(`from`), 수신 시각(`ts`), 페이로드 크기(`size`) | • `readonly` 인박스 상태 모니터링 (실제 메시지 수신/임대는 실제 에이전트 프로세스가 수행) | `GET /api/v1/admin/inbox/:identity` |

---

## 3. 기능별 UX 사용자 동선 (Mermaid Flows)

### Flow 1: [플랫폼 관리자] 50자리 키 검증 및 원자적 승인 / 사유 명시 거부 동선 (F-ADM-01)

```mermaid
sequenceDiagram
    autonumber
    actor Admin as 플랫폼 관리자 (Admin)
    participant UI as 어드민 콘솔 (Key Approvals)
    participant HTTP as Platform HTTP Server (:3000)
    participant DB as SQLite (agents.db)

    Admin->>UI: 어드민 콘솔 접속 (`/admin`) -> [Key Approvals] 탭
    UI->>HTTP: GET /api/v1/admin/keys/pending (with mesh_token cookie)
    HTTP->>DB: SELECT * FROM keys WHERE status = 'pending'
    DB-->>HTTP: Pending keys (Fingerprints 50자, type, proposed_at)
    HTTP-->>UI: 200 OK { ok: true, pending: [...] }
    UI-->>Admin: 50자리 SHA-256 지문 전체 박스 (`sha256:...`) 렌더링

    alt 관리자가 키 승인 (Approve)
        Admin->>UI: [✓ Approve Key] 클릭
        UI->>HTTP: POST /api/v1/admin/keys/approve { fingerprint: "sha256:pfsELGYsvW..." }
        HTTP->>DB: UPDATE keys SET status='approved' WHERE fingerprint=?
        HTTP-->>UI: 200 OK { ok: true, fingerprint: "..." }
        UI-->>Admin: 승인 완료 토스트 및 대기열에서 카드 즉시 제거
    else 관리자가 키 거부/취소 (Deny / Revoke)
        Admin->>UI: [✕ Deny / Revoke] 클릭
        UI-->>Admin: 사유 입력 팝업 표시 (프리셋: rotation, compromise, expired + 자유 텍스트)
        Admin->>UI: 사유 입력 (예: "compromise - dev leaked") 후 확인
        UI->>HTTP: POST /api/v1/admin/keys/revoke { fingerprint: "...", reason: "compromise - ..." }
        HTTP->>DB: INSERT INTO agent_key_events (action='revoked', reason=...)
        HTTP-->>UI: 200 OK { ok: true, revoked: true }
        UI-->>Admin: 거부/취소 완료 토스트 표시 (compromise인 경우 적색 경고 뱃지로 이력 보존)
    end
```

---

### Flow 2: [플랫폼 관리자] 인박스 적체 감시 및 시효성 수식 기반 렌더링 동선 (F-ADM-02)

```mermaid
sequenceDiagram
    autonumber
    actor Admin as 플랫폼 관리자 (Admin)
    participant UI as 어드민 콘솔 (Inbox Backlog)
    participant HTTP as Platform HTTP Server (:3000)
    participant DB as Message Store (hub.db, Readonly)

    Admin->>UI: [Inbox Backlog] 탭 선택
    UI->>HTTP: GET /api/v1/admin/inbox (Readonly, with mesh_token)
    HTTP->>DB: SELECT inboxes (pending, leased, oldest) WHERE leased_until >= datetime('now')
    DB-->>HTTP: { ok: true, inboxes: [{ identity: "demo-receiver", pending: 5, leased: 0, oldest: "..." }] }
    HTTP-->>UI: 200 OK
    Note over UI: 프론트엔드 연산:<br>Total Depth = pending (5)<br>Leased = leased (0)<br>Available = pending - leased (5)
    UI-->>Admin: 3단 배지 렌더링 [Total Depth: 5] [0 Leased ⚡] [5 Available]<br>(메시지 임대 발생 없이 안전하게 메타데이터만 렌더링)
```

---

### Flow 3: [플랫폼 관리자] 영구 신원 Teardown 및 불변 에러 방어 동선 (F-ADM-04)

```mermaid
sequenceDiagram
    autonumber
    actor Admin as 플랫폼 관리자 (Admin)
    participant UI as 어드민 콘솔 (Agent List)
    participant Modal as 2단계 불가역 확인 모달
    participant HTTP as Platform HTTP Server (:3000)
    participant DB as SQLite (agents.db)

    Admin->>UI: 삭제 대상 에이전트의 [⚠ Teardown] 버튼 클릭
    UI->>Modal: 영구 삭제 경고 모달 표시 (SPEC § 9.3 Invariant Rule 명시)
    Modal-->>Admin: "삭제된 신원은 영구 비활성화되며, 동일 이름 재등록이 영구히 금지됩니다."
    
    alt 취소 클릭
        Admin->>Modal: [취소] 클릭
        Modal-->>UI: 모달 닫힘
    else 영구 삭제 확정
        Admin->>Modal: 신원 이름 확인 입력 후 [영구 삭제 확인] 클릭
        Modal->>HTTP: DELETE /api/v1/admin/agents/demo-torn-down (with mesh_token)
        HTTP->>DB: UPDATE agents SET deleted = 1, tombstone_at = now() WHERE identity=?
        HTTP-->>UI: 200 OK { ok: true, identity: "demo-torn-down", action: "already-deleted" }
        UI-->>Admin: Teardown 완료 뱃지 전환 및 재등록 영구 금지(Tombstoned) 상태 표시
    end

    opt 차후 동일 이름으로 재등록 시도 시
        Admin->>HTTP: POST /api/v1/agents { identity: "demo-torn-down", ... }
        HTTP-->>Admin: 409 Conflict { "ok": false, "code": "IDENTITY_DELETED", "error": "identity was deleted and cannot be re-registered" }
    end
```

---

### Flow 4: [에이전트 운영자] 신원 등록 및 키 제안 동선 (F-OPR-01)

```mermaid
sequenceDiagram
    autonumber
    actor Operator as 에이전트 운영자 (Agent Operator)
    participant UI as 운영 콘솔 (Agent Operations)
    participant Hub as Platform Hub (:3100)
    participant DB as SQLite (agents.db)

    Operator->>UI: [+ Register Agent] 클릭
    UI-->>Operator: 에이전트 등록 모달 표시 (Identity name, Agent Type, Ed25519 Public Key)
    Operator->>UI: 신원명('my-new-bot'), 타입('ai-claude'), 공개키 입력 후 [제출]
    UI->>Hub: POST /api/v1/agents { identity: "my-new-bot", type: "ai-claude", public_key: "..." }
    Hub->>DB: INSERT INTO agents (identity, type, deleted=0)...<br>INSERT INTO keys (identity, fingerprint, status='pending')...
    Hub-->>UI: 200 OK { ok: true, identity: "my-new-bot", key: { fingerprint: "sha256:...", status: "pending" } }
    UI-->>Operator: "에이전트가 등록되었습니다. 플랫폼 관리자의 키 승인 대기 중입니다." 상태 렌더링
```

---

### Flow 5: [에이전트 운영자] 콘솔 프록시 메시지 테스트 동선 (F-OPR-02)

```mermaid
sequenceDiagram
    autonumber
    actor Operator as 에이전트 운영자 (Agent Operator)
    participant UI as 메시지 테스트 콘솔
    participant HTTP as Platform HTTP Server (:3000)
    participant Hub as Platform Hub (:3100)
    participant Target as 수신 에이전트 (WebSocket / Inbox)
    participant Audit as 감사 저장소 (audit.db)

    Operator->>UI: 수신 에이전트 선택 (`platform-claude`), 본문 입력 후 [Send Message ✈] 클릭
    Note over UI,HTTP: JWT 인증 기반 HTTP POST (/api/v1/messages)
    UI->>HTTP: POST /api/v1/messages { to: "platform-claude", body: "..." }
    HTTP->>Hub: Proxy Socket Frame { from: "alice_dev", sent_by: "http-server", payload: "..." }
    
    Hub->>Audit: 감사 이벤트 기록 (from: alice_dev, sent_by: http-server)
    
    alt 수신 에이전트가 WebSocket 온라인인 경우
        Hub->>Target: WebSocket 프레임 즉시 전송
        Target-->>Hub: ACK
        Hub-->>HTTP: Delivered
        HTTP-->>UI: 200 OK { delivered: true, transport: "websocket", seq: 1042 }
        UI-->>Operator: [Delivered to Socket ✓] 녹색 배지 점등
    else 수신 에이전트가 소켓리스(Pull) 모드인 경우
        Hub->>Target: 인박스 큐 적재 (inbox.db)
        HTTP-->>UI: 200 OK { delivered: true, transport: "inbox_queued", seq: 1043 }
        UI-->>Operator: [Queued in Inbox #1043 ⚡] 블루 배지 점등
    end
```
