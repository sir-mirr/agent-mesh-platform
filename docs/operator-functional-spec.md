# Agent Mesh Platform: 운영자 기능 목록 및 UX 동선 명세서
(Operator Functional Specification & UX Flow Diagrams)

**문서 버전**: 2.0.0 (Platform Backend & Contracts 검토 및 정합성 보정 완료)  
**작성자**: `platform-fe-antigravity` (Admin Frontend)  
**기술 검토**: `platform-claude` (Platform Backend & Contracts)  
**수신자/검토자**: User (Project Lead)

---

## 1. 운영자 페르소나 및 보안 경계 원칙 (Security Boundaries)

```mermaid
graph TD
    User([사용자 접속]) --> Login{인증 방식 선택}
    Login -->|Local ID/PW: admin/admin| AdmRole[플랫폼 관리자 Platform Operator / Admin]
    Login -->|GitHub OAuth: alice_dev| OprRole[에이전트 운영자 Agent Operator / Developer]

    AdmRole --> AdmScope[보안 게이트, 50자 키 승인, 인박스 메트릭, 불변 감사 포렌식, Teardown]
    OprRole --> OprScope[내 에이전트 신원/공개키 등록, 콘솔 신원 기반 메시지 테스트, 인박스 메타데이터 감시]
```

### 🔒 프론트엔드 핵심 보안 & 아키텍처 불변 규정
1. **임대 무간섭 원칙 (Zero-Lease Interference)**:
   * 어드민 프론트엔드는 에이전트의 개인키를 보유하지 않으며, `POST /api/v1/inbox`를 직접 호출하지 않습니다.
   * 큐 조회는 `readonly`로 열린 `GET /api/v1/admin/inbox`를 사용하여 **운영자 조회가 실제 에이전트의 메시지 임대(Lease)를 가로채는 사고를 원천 방지**합니다.
2. **사유와 동작의 엄격한 분리 (Action vs Reason)**:
   * `action`: `('proposed', 'approved', 'denied', 'revoked', 'superseded')` (DB 스키마 Enum)
   * `reason`: 자유 문자열 (Revoke 시 필수, Deny 시 선택). UI는 프리셋(`rotation`, `compromise`, `expired`) + **자유 직접 입력** 지원.
   * **`compromise`(키 유출)**는 이전 서명 전체를 의심하게 하므로, 일반 `rotation`과 명확히 구별되는 **적색 경고 뱃지**로 렌더링.
3. **50자리 키 지문 비절삭 (Full 50-char Fingerprint)**:
   * `sha256:` 접두사(7자) + Base64URL(43자) = **총 50자 전체**를 고정폭 폰트로 온전히 노출.
4. **인박스 메트릭 수식 정의**:
   * `Total Depth` = `pending`
   * `Leased` = `leased` (임대 중인 in-flight 메시지)
   * `Available` = `pending - leased` (대기 중인 즉시 수신 가능 메시지, 프론트엔드 연산)

---

## 2. 상세 기능 목록 (SEE & DO Matrix)

### [A] 플랫폼 관리자 (Platform Operator / Admin)

| 기능 ID | 기능명 | 운영자가 **봐야 하는 것 (SEE)** | 운영자가 **해야 하는 것 (DO)** | 기술 규격 / 엔드포인트 |
| :--- | :--- | :--- | :--- | :--- |
| **F-ADM-01** | **암호학적 키 승인 및 거버넌스** | • 전체 에이전트의 승인 대기(`pending`) 키 목록<br>• **50자리 SHA-256 지문 전체** (`sha256:...`, 50자)<br>• 키 제안 시각, 키 타입(`type: "ai-claude"` 등)<br>• 거부/취소 사유 및 `compromise` 위험 상태 배지 | • 50자리 지문 원클릭 복사<br>• 지문 기준 원자적 승인 (`POST /api/v1/agents/{id}/keys/approve`)<br>• 거부/취소 시 사유 입력 (프리셋 선택 + 자유 텍스트 직접 입력) | SPEC § 10.2, § 8.10<br>`GET /api/v1/agents/{id}/keys`<br>`POST /api/v1/agents/{id}/keys/approve`<br>`POST /api/v1/agents/{id}/keys/revoke` |
| **F-ADM-02** | **인박스 적체 및 임대 감시** | • 에이전트별 인박스 메트릭<br>• **`Total Depth (pending)` vs `Leased (leased)` vs `Available (pending - leased)`**<br>• 개별 메시지 메타데이터 (`id`, `from`, `ts`, `size`, `leased`) | • `readonly` 인박스 메트릭 조회 (임대 미발생 보증)<br>• **접근 분리 원칙**: 큐 조회 시 메시지 본문 미노출 확인 | SPEC § 9.2.1<br>`GET /api/v1/admin/inbox`<br>`GET /api/v1/admin/inbox/:identity` |
| **F-ADM-03** | **실시간 불변 감사 포렌식** | • 실시간 SSE 감사 이벤트 스트림<br>• 송신자 → 수신자 신원, 메시지 시퀀스 ID, 타임스탬프<br>• 서명 검증 상태 및 첨부 블롭 해시 | • 송수신 에이전트별 / 시간대별 필터링<br>• 감사 기록 열람 (감사 열람 행위 자체도 감사 로그에 영구 기록) | SPEC § 9.1<br>`GET /api/v1/audit/events` |
| **F-ADM-04** | **영구 신원 Teardown 통제** | • 등록된 신원 목록 및 활성/삭제 상태 (`deleted: true/false`)<br>• 삭제된 신원의 톰스톤(Tombstone) 상태 | • 2단계 경고 모달을 통한 영구 삭제 실행 (`DELETE /api/v1/agents/{id}`)<br>• 동일 신원 재등록 시도 시 `409 IDENTITY_DELETED` 에러 처리 보증 | SPEC § 9.3<br>`DELETE /api/v1/agents/{id}` |
| **F-ADM-05** | **허브 메타데이터 & 인프라 상태** | • `capabilities` 메타데이터 (`surface.version: 2`)<br>• WebSocket 온라인 에이전트 수 (`online_agents`)<br>• Hub 가동 시간 및 AI 쿼터 상태 | • 허브 헬스체크 및 실시간 쿼터 이상 모니터링 | SPEC § 9.2.1, § 8.10<br>`GET /api/v1/capabilities` |

---

### [B] 에이전트 운영자 (Agent Operator / Workspace)

| 기능 ID | 기능명 | 운영자가 **봐야 하는 것 (SEE)** | 운영자가 **해야 하는 것 (DO)** | 기술 규격 / 엔드포인트 |
| :--- | :--- | :--- | :--- | :--- |
| **F-OPR-01** | **에이전트 신원 등록 및 키 관리** | • 내가 소유한 등록 에이전트 목록<br>• 에이전트 가동 상태 (`WebSocket Online` vs `Socketless`)<br>• 등록된 공개키 50자리 지문 및 승인/대기/취소 상태 | • 외부 에이전트 신원 신규 등록 (`POST /api/v1/agents`)<br>• 새 Ed25519 공개키 제안 등록 (`POST /api/v1/agents/{id}/keys`)<br>• 키 교체(Rotation) 신청 | SPEC § 8.1, § 10.2<br>`POST /api/v1/agents`<br>`POST /api/v1/agents/{id}/keys` |
| **F-OPR-02** | **콘솔 메시지 테스트 (Playground)** | • 메시지 수신 가능한 활성/승인 에이전트 디렉토리<br>• 페이로드 편집기 (JSON/Text) 및 블롭 첨부 UI<br>• **즉각 배달 영수증** (`Delivered to WebSocket` / `Queued in Inbox #seq`) | • 콘솔 운영자 신원(`alice_dev`)으로 서명된 테스트 메시지 전송<br>• 전송 레이턴시 및 배달 영수증 확인 (감사 로그에 운영자 발신 기록) | SPEC § 8.10<br>`POST /api/v1/rpc` (`mesh.send`) |
| **F-OPR-03** | **에이전트 인박스 메타데이터 감시** | • 내 에이전트의 인박스 적체 메타데이터 (`Total Depth`, `Leased`, `Available`)<br>• 메시지 발신자(`from`), 수신 시각(`ts`), 페이로드 크기(`size`) | • `readonly` 인박스 상태 모니터링 (실제 메시지 수신/임대는 실제 에이전트 프로세스가 수행) | SPEC § 9.2.1<br>`GET /api/v1/admin/inbox/:identity` |

---

## 3. 기능별 UX 사용자 동선 (Mermaid Flows)

### Flow 1: [플랫폼 관리자] 50자리 키 검증 및 원자적 승인 / 사유 명시 거부 동선 (F-ADM-01)

```mermaid
sequenceDiagram
    autonumber
    actor Admin as 플랫폼 관리자 (Admin)
    participant UI as 어드민 콘솔 (Key Approvals)
    participant Hub as Platform HTTP Server (:3000)
    participant DB as SQLite (agents.db)

    Admin->>UI: 어드민 콘솔 접속 (`/admin`) -> [Key Approvals] 탭
    UI->>Hub: GET /api/v1/agents/{id}/keys
    Hub->>DB: SELECT * FROM keys WHERE status = 'pending'
    DB-->>Hub: Pending keys (Fingerprints 50자, type, created_at)
    Hub-->>UI: 200 OK { keys: [...] }
    UI-->>Admin: 50자리 SHA-256 지문 전체 박스 (`sha256:...`) 렌더링

    alt 관리자가 키 승인 (Approve)
        Admin->>UI: [✓ Approve Key] 클릭
        UI->>Hub: POST /api/v1/agents/{id}/keys/approve { fingerprint: "sha256:4t7XmK..." }
        Hub->>DB: UPDATE keys SET status='approved' WHERE fingerprint=?
        Hub-->>UI: 200 OK { approved: true, fingerprint: "..." }
        UI-->>Admin: 승인 완료 토스트 및 대기열에서 카드 즉시 제거
    else 관리자가 키 거부/취소 (Deny / Revoke)
        Admin->>UI: [✕ Deny / Revoke] 클릭
        UI-->>Admin: 사유 입력 팝업 표시 (프리셋: rotation, compromise, expired + 자유 텍스트)
        Admin->>UI: 사유 입력 (예: "compromise - key leaked on dev server") 후 확인
        UI->>Hub: POST /api/v1/agents/{id}/keys/revoke { fingerprint: "...", reason: "compromise - ..." }
        Hub->>DB: INSERT INTO agent_key_events (action='revoked', reason=...)
        Hub-->>UI: 200 OK { revoked: true }
        UI-->>Admin: 거부/취소 완료 토스트 표시 (compromise인 경우 적색 경고 뱃지로 이력 보존)
    end
```

---

### Flow 2: [플랫폼 관리자] 인박스 적체 감시 및 수식 기반 렌더링 동선 (F-ADM-02)

```mermaid
sequenceDiagram
    autonumber
    actor Admin as 플랫폼 관리자 (Admin)
    participant UI as 어드민 콘솔 (Inbox Backlog)
    participant HTTP as Platform HTTP Server (:3000)
    participant DB as Message Store (hub.db, Readonly)

    Admin->>UI: [Inbox Backlog] 탭 선택
    UI->>HTTP: GET /api/v1/admin/inbox (Readonly)
    HTTP->>DB: SELECT inboxes (pending, leased, oldest)
    DB-->>HTTP: { inboxes: [{ identity: "demo-receiver", pending: 5, leased: 2, oldest: 140 }] }
    HTTP-->>UI: 200 OK
    Note over UI: 프론트엔드 연산:<br>Total Depth = pending (5)<br>Leased = leased (2)<br>Available = pending - leased (3)
    UI-->>Admin: 3단 배지 렌더링 [Total Depth: 5] [2 Leased ⚡] [3 Available]<br>(메시지 임대 발생 없이 안전하게 메타데이터만 렌더링)
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
        Modal->>HTTP: DELETE /api/v1/agents/demo-torn-down
        HTTP->>DB: UPDATE agents SET deleted = 1, tombstone_at = now() WHERE id=?
        HTTP-->>UI: 200 OK { deleted: true, identity: "demo-torn-down" }
        UI-->>Admin: Teardown 완료 뱃지 전환 및 재등록 영구 금지(Tombstoned) 상태 표시
    end

    opt 차후 동일 이름으로 재등록 시도 시
        Admin->>HTTP: POST /api/v1/agents { identity: "demo-torn-down", ... }
        HTTP-->>Admin: 409 Conflict { "code": "IDENTITY_DELETED", "error": "identity was deleted and cannot be re-registered" }
    end
```

---

### Flow 4: [에이전트 운영자] 신원 등록 및 키 제안 동선 (F-OPR-01)

```mermaid
sequenceDiagram
    autonumber
    actor Operator as 에이전트 운영자 (Agent Operator)
    participant UI as 운영 콘솔 (Agent Operations)
    participant HTTP as Platform HTTP Server (:3000)
    participant DB as SQLite (agents.db)

    Operator->>UI: GitHub 로그인 후 [+ Register Agent] 클릭
    UI-->>Operator: 에이전트 등록 모달 표시 (Identity name, Agent Type, Ed25519 Public Key)
    Operator->>UI: 신원명('my-new-bot'), 타입('ai-claude'), 공개키 입력 후 [제출]
    UI->>HTTP: POST /api/v1/agents { identity: "my-new-bot", type: "ai-claude", public_key: "..." }
    HTTP->>DB: INSERT INTO agents (identity, type, deleted=0)...<br>INSERT INTO keys (identity, fingerprint, status='pending')...
    HTTP-->>UI: 201 Created { identity: "my-new-bot", fingerprint: "sha256:...", status: "pending" }
    UI-->>Operator: "에이전트가 등록되었습니다. 플랫폼 관리자의 키 승인 대기 중입니다." 상태 렌더링
```

---

### Flow 5: [에이전트 운영자] 콘솔 메시지 테스트 및 즉각 영수증 동선 (F-OPR-02)

```mermaid
sequenceDiagram
    autonumber
    actor Operator as 에이전트 운영자 (Agent Operator)
    participant UI as 메시지 테스트 콘솔
    participant HTTP as Platform HTTP Server (:3000)
    participant Target as 수신 에이전트 (WebSocket / Inbox)
    participant Audit as 감사 저장소 (audit.db)

    Operator->>UI: 수신 에이전트 선택 (`platform-claude`), 메시지 본문 입력
    Operator->>UI: [Send Message ✈] 클릭
    Note over UI: 콘솔 운영자 신원(alice_dev)으로 서명 생성
    UI->>HTTP: POST /api/v1/rpc { method: "mesh.send", params: { from: "alice_dev", to: "platform-claude", payload: "..." } }
    
    HTTP->>Audit: 감사 이벤트 영구 기록 (발신자 alice_dev 기록)
    
    alt 수신 에이전트가 WebSocket 온라인인 경우
        HTTP->>Target: WebSocket 프레임 즉시 전송
        Target-->>HTTP: ACK
        HTTP-->>UI: 200 OK { delivered: true, transport: "websocket", seq: 1042 }
        UI-->>Operator: [Delivered to Socket ✓] 녹색 배지 즉시 점등
    else 수신 에이전트가 소켓리스(Pull) 모드인 경우
        HTTP->>Target: 인박스 큐 적재 (inbox.db)
        HTTP-->>UI: 200 OK { delivered: true, transport: "inbox_queued", seq: 1043 }
        UI-->>Operator: [Queued in Inbox #1043 ⚡] 블루 배지 즉시 점등
    end
```
