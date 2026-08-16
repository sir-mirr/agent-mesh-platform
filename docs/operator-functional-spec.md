# Agent Mesh Platform: 운영자 기능 목록 및 UX 동선 명세서
(Operator Functional Specification & UX Flow Diagrams)

**문서 버전**: 1.0.0  
**작성자**: `platform-fe-antigravity` (Admin Frontend)  
**수신자/검토자**: `platform-claude` (Platform Backend & Contracts)  
**목적**: 플랫폼 관리자(Platform Admin) 및 에이전트 운영자(Agent Operator)가 수행해야 하는 기능 목록(SEE & DO) 도출 및 UX 동선 합의

---

## 1. 운영자 페르소나 및 역할 분리 (Operator Roles)

```mermaid
graph TD
    User([사용자 접속]) --> Login{인증 방식 선택}
    Login -->|Local ID/PW: admin/admin| AdmRole[플랫폼 관리자 Platform Operator / Admin]
    Login -->|GitHub OAuth: alice_dev| OprRole[에이전트 운영자 Agent Operator / Developer]

    AdmRole --> AdmScope[인프라 보안 게이트, 키 승인 거버넌스, 인박스 적체 감시, 영구 감사, Teardown]
    OprRole --> OprScope[내 에이전트 신원 등록, 키 제안/로테이션, 메시지 테스트 콘솔, 인박스 수신 타임라인]
```

---

## 2. 상세 기능 목록 (SEE & DO Matrix)

### [A] 플랫폼 관리자 (Platform Operator / Admin)

| 기능 ID | 기능명 | 운영자가 **봐야 하는 것 (SEE)** | 운영자가 **해야 하는 것 (DO)** | 관련 SPEC / 엔드포인트 |
| :--- | :--- | :--- | :--- | :--- |
| **F-ADM-01** | **암호학적 키 승인 및 거버넌스** | • 전체 에이전트의 승인 대기(Pending) 키 목록<br>• **43자리 SHA-256 지문 전체(생략 금지)** (`sha256:...`)<br>• 키 제안 시각, 키 타입(`ai-claude` 등), 상태(`pending/approved/denied/revoked`) | • 43자리 지문 원클릭 클립보드 복사<br>• 지문 기준 원자적 승인 (`POST /api/v1/agents/{id}/keys/approve`)<br>• 거부 및 취소 사유 코드 명시 거부 (`revoked`, `compromised`, `expired`) | SPEC § 10.2, § 8.10<br>`GET /api/v1/agents/{id}/keys` |
| **F-ADM-02** | **인박스 적체 및 임대 감시** | • 에이전트별 큐 적체 깊이(Depth)<br>• **`Total Queued` vs `Leased (임대 중)` vs `Available (대기 중)`** 분리 표시<br>• 임대 만료 카운트다운 (`receive_lease_seconds: 300`) | • 실시간 큐 상태 새로고침<br>• **접근 분리 원칙(Separation of Access)** 준수: 큐 조회 시 메시지 본문 미노출 확인 | SPEC § 9.2.1<br>`GET /api/v1/agents/{id}/inbox/metrics` |
| **F-ADM-03** | **실시간 불변 감사 포렌식** | • 실시간 SSE 감사 이벤트 스트림<br>• 송신자 → 수신자 신원, 메시지 시퀀스 ID, 타임스탬프<br>• Ed25519 서명 검증 상태 및 첨부 블롭 해시 | • 송수신 에이전트별 / 시간대별 필터링<br>• 메시지 페이로드 및 블롭 본문 열람 및 포렌식 대조 | SPEC § 9.1<br>`GET /api/v1/audit/events` |
| **F-ADM-04** | **영구 신원 Teardown 통제** | • 등록된 신원 목록 및 활성/삭제 상태 (`deleted: true/false`)<br>• 삭제된 신원의 톰스톤(Tombstone) 및 재등록 영구 금지 상태 | • 2단계 경고 모달을 통한 영구 삭제 실행 (`DELETE /api/v1/agents/{id}`)<br>• 동일 신원 재등록 금지 규칙 UI 보증 | SPEC § 9.3<br>`DELETE /api/v1/agents/{id}` |
| **F-ADM-05** | **허브 메타데이터 & AI 쿼터** | • `GET /api/v1/capabilities` 응답 메타데이터 (`surface.version: 2`)<br>• WebSocket 상주 에이전트 vs 소켓리스 풀 에이전트 연결 비율<br>• AI 토큰 사용량 및 쿼터 상태 | • 허브 헬스체크 및 실시간 쿼터 이상 모니터링 | SPEC § 9.2.1, § 8.10<br>`GET /api/v1/capabilities` |

---

### [B] 에이전트 운영자 (Agent Operator / Workspace)

| 기능 ID | 기능명 | 운영자가 **봐야 하는 것 (SEE)** | 운영자가 **해야 하는 것 (DO)** | 관련 SPEC / 엔드포인트 |
| :--- | :--- | :--- | :--- | :--- |
| **F-OPR-01** | **에이전트 신원 등록 및 키 관리** | • 내가 소유한 등록 에이전트 목록<br>• 에이전트 가동 모드 (WebSocket Online vs Socketless Pull)<br>• 등록된 공개키 43자리 지문 및 승인/대기 상태 | • 외부 에이전트 신원 신규 등록 (`POST /api/v1/agents`)<br>• 새 Ed25519 공개키 제안 등록 (`POST /api/v1/agents/{id}/keys`)<br>• 키 교체(Rotation) 신청 | SPEC § 8.1, § 10.2 |
| **F-OPR-02** | **메시지 테스트 콘솔 (Playground)** | • 메시지 수신 가능한 활성/승인 에이전트 디렉토리<br>• 페이로드 편집기 (JSON/Text) 및 블롭 첨부 UI<br>• **즉각 배달 영수증** (`Delivered to WebSocket` / `Queued in Inbox #seq`) | • 수신 대상 선택 후 서명된 테스트 메시지 즉시 전송<br>• 전송 레이턴시 및 전달 영수증 확인 | SPEC § 8.10<br>`POST /api/v1/rpc` |
| **F-OPR-03** | **에이전트 인박스 수신 타임라인** | • 내 에이전트가 수신한 메시지 목록<br>• 송신자 서명 검증 배지, 수신 시각, 임대(Leased) 상태 | • 소켓리스 에이전트 수신 큐 수동 폴링 (`mesh.inbox.receive`)<br>• 메시지 처리 완료 응답 (`mesh.inbox.ack`) | SPEC § 9.2.1 |

---

## 3. 기능별 UX 사용자 동선 (UX Flow Diagrams)

### Flow 1: [플랫폼 관리자] 키 검증 및 원자적 승인 / 거부 동선 (F-ADM-01)

```mermaid
sequenceDiagram
    autonumber
    actor Admin as 플랫폼 관리자 (Admin)
    participant UI as 어드민 콘솔 (Key Approvals)
    participant Hub as Platform Hub (:3100)
    participant DB as SQLite (agents.db)

    Admin->>UI: 어드민 콘솔 접속 (`/admin`) -> [Key Approvals] 탭 선택
    UI->>Hub: GET /api/v1/agents/{id}/keys (Unapproved Keys)
    Hub->>DB: SELECT * FROM keys WHERE status = 'pending'
    DB-->>Hub: Pending keys list (Fingerprints, type, created_at)
    Hub-->>UI: 200 OK { keys: [...] }
    UI-->>Admin: 43자리 SHA-256 지문 전체 박스 & [Approve] / [Deny] 버튼 렌더링

    alt 관리자가 키 승인 (Approve)
        Admin->>UI: [✓ Approve Key] 클릭
        UI->>Hub: POST /api/v1/agents/{id}/keys/approve { fingerprint: "sha256:4t7XmK..." }
        Hub->>DB: UPDATE keys SET status='approved' WHERE fingerprint=?
        DB-->>Hub: Updated (1 row)
        Hub-->>UI: 200 OK { approved: true, fingerprint: "..." }
        UI-->>Admin: 승인 완료 토스트 표시 및 대기열에서 카드 즉시 제거 (WebSocket/RPC 즉시 활성화)
    else 관리자가 키 거부 (Deny)
        Admin->>UI: [✕ Deny Key] 클릭
        UI-->>Admin: 거부 사유 선택 팝업 (revoked / compromised / expired)
        Admin->>UI: 사유 선택 및 확인
        UI->>Hub: POST /api/v1/agents/{id}/keys/deny { fingerprint: "...", reason: "compromised" }
        Hub->>DB: UPDATE keys SET status='denied', revocation_reason=? WHERE fingerprint=?
        Hub-->>UI: 200 OK { denied: true }
        UI-->>Admin: 거부 상태 갱신 토스트 및 거부 이력 탭으로 이동
    end
```

---

### Flow 2: [플랫폼 관리자] 인박스 적체 감시 및 임대 분리 동선 (F-ADM-02)

```mermaid
sequenceDiagram
    autonumber
    actor Admin as 플랫폼 관리자 (Admin)
    participant UI as 어드민 콘솔 (Inbox Backlog)
    participant Hub as Platform Hub (:3100)
    participant Store as Message Store (inbox.db)

    Admin->>UI: [Inbox Backlog] 탭 선택
    UI->>Hub: GET /api/v1/agents/demo-receiver/inbox/metrics
    Hub->>Store: SELECT count(*), count(leased_until > now()) FROM inbox WHERE agent_id=?
    Store-->>Hub: { total: 5, leased: 2, pending: 3, oldest_age_sec: 140 }
    Hub-->>UI: 200 OK { total: 5, leased: 2, pending: 3 }
    UI-->>Admin: 듀얼톤 배지 렌더링 [2 Leased (In Flight) ⚡] [3 Pending]<br>(메시지 본문은 보안 분리 원칙에 따라 미노출)
```

---

### Flow 3: [플랫폼 관리자] 영구 신원 Teardown 실행 동선 (F-ADM-04)

```mermaid
sequenceDiagram
    autonumber
    actor Admin as 플랫폼 관리자 (Admin)
    participant UI as 어드민 콘솔 (Agent List)
    participant Modal as 2단계 불가역 확인 모달
    participant Hub as Platform Hub (:3100)
    participant DB as SQLite (agents.db)

    Admin->>UI: 삭제 대상 에이전트의 [⚠ Teardown] 버튼 클릭
    UI->>Modal: 영구 삭제 경고 모달 표시 (SPEC § 9.3 Invariant Rule 강조)
    Modal-->>Admin: "삭제된 신원은 영구 비활성화되며, 동일 이름 재등록이 영구히 금지됩니다."
    
    alt 취소 클릭
        Admin->>Modal: [취소] 클릭
        Modal-->>UI: 모달 닫힘 (상태 변경 없음)
    else 영구 삭제 확정
        Admin->>Modal: 신원 이름 확인 입력 후 [영구 삭제 확인] 클릭
        Modal->>Hub: DELETE /api/v1/agents/demo-torn-down
        Hub->>DB: UPDATE agents SET deleted = 1, tombstone_at = now() WHERE id=?
        DB-->>Hub: Updated (Soft Deleted)
        Hub-->>UI: 200 OK { deleted: true, identity: "demo-torn-down" }
        UI-->>Admin: Teardown 완료 뱃지 전환 및 재등록 금지(Tombstoned) 상태 표시
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

    Operator->>UI: GitHub 로그인 후 [+ Register Agent] 클릭
    UI-->>Operator: 에이전트 등록 모달 표시 (Identity name, Agent Type, Ed25519 Public Key)
    Operator->>UI: 신원명('my-new-bot'), 타입('ai-claude'), 공개키 입력 후 [제출]
    UI->>Hub: POST /api/v1/agents { identity: "my-new-bot", type: "ai-claude", public_key: "..." }
    Hub->>DB: INSERT INTO agents (identity, type, deleted=0)...<br>INSERT INTO keys (identity, fingerprint, status='pending')...
    DB-->>Hub: Success
    Hub-->>UI: 201 Created { identity: "my-new-bot", fingerprint: "sha256:...", status: "pending" }
    UI-->>Operator: "에이전트가 등록되었습니다. 플랫폼 관리자의 키 승인 대기 중입니다." 상태 렌더링
```

---

### Flow 5: [에이전트 운영자] 메시지 테스트 콘솔 및 즉각 영수증 동선 (F-OPR-02)

```mermaid
sequenceDiagram
    autonumber
    actor Operator as 에이전트 운영자 (Agent Operator)
    participant UI as 메시지 테스트 콘솔
    participant Hub as Platform Hub (:3100)
    participant Target as 수신 에이전트 (WebSocket / Inbox)
    participant Audit as 감사 저장소 (audit.db)

    Operator->>UI: 수신 에이전트 선택 (`platform-claude`), 메시지 본문 입력
    Operator->>UI: [Send Message ✈] 클릭
    UI->>Hub: POST /api/v1/rpc { method: "mesh.send", params: { to: "platform-claude", payload: "..." } }
    
    Hub->>Audit: 감사 이벤트 영구 기록 (audit.db Append)
    
    alt 수신 에이전트가 WebSocket 온라인인 경우
        Hub->>Target: WebSocket 프레임 즉시 전송
        Target-->>Hub: ACK
        Hub-->>UI: 200 OK { delivered: true, transport: "websocket", seq: 1042 }
        UI-->>Operator: [Delivered to Socket ✓] 녹색 배지 즉시 점등
    else 수신 에이전트가 소켓리스(Pull) 모드인 경우
        Hub->>Target: 인박스 큐 적재 (inbox.db)
        Hub-->>UI: 200 OK { delivered: true, transport: "inbox_queued", seq: 1043 }
        UI-->>Operator: [Queued in Inbox #1043 ⚡] 블루 배지 즉시 점등
    end
```

---

## 4. 검토 요청 사항 (for `platform-claude`)

1. **키 거부/취소 사유 코드**: `revoked`, `compromised`, `expired` 3가지 enum이 백엔드/컨트랙트 스키마와 완벽히 부합하는지 확인
2. **인박스 적체 카운트 엔드포인트**: `total_depth`와 `leased_count`를 단일 호출로 제공하는 메트릭 경로 규격 검토
3. **영구 Teardown(SPEC § 9.3) 에러 처리**: 삭제된 신원으로 재등록 시도 시 `-32015 IdentityTornDown` 에러 반환 스펙 확인
