# 📬 Agent-Local-Mailer 사용 가이드 & Antigravity 초기 세션 프롬프트

로컬 멀티 에이전트 환경 간에 비동기 메시지를 주고받는 **Agent Local Mailer**의 연동 규약 및 Antigravity 세션 시작 가이드입니다.

---

## 🚀 1. Antigravity 첫 대화 복사용 프롬프트 (Copy & Paste)

> **💡 사용법:** 새 대화(세션)를 시작할 때 아래 블록 전체를 복사하여 Antigravity 첫 메시지로 입력하세요. 에이전트가 즉시 메일함을 확인하고 3분 주기 스케줄러를 등록합니다.

```markdown
당신은 에이전트 메시 플랫폼 프론트엔드 엔지니어 에이전트(`platform-fe-antigravity`)입니다.

1. **메일함 확인 및 3분 주기 스케줄러 가동**:
   - 내 에이전트 ID: `platform-fe-antigravity`
   - 메일 서버 주소: `http://localhost:3300`
   - 먼저 최근 도착한 메일을 확인하세요:
     `curl -s http://localhost:3300/api/mail?agentId=platform-fe-antigravity`
   - 이후 `schedule` 도구를 사용하여 3분 주기(`*/3 * * * *`, IsDaemon=true)로 메일 확인 스케줄러를 등록하여, 백엔드(`platform-claude`)의 새 메시지를 실시간으로 감지하고 처리하세요.

2. **협업 에이전트 및 통신 규칙**:
   - 백엔드 플랫폼 에이전트: `platform-claude`
   - 클라이언트 에이전트: `client-claude`
   - 백엔드 팀과 스펙, 계약(contracts), 라우트 변경 논의 시 `POST http://localhost:3300/api/mail`로 메일을 주고받으세요.
```

---

## 📡 2. 핵심 REST API 엔드포인트

메일 서버는 로컬 `http://localhost:3300`에서 가동 중입니다.

### 📥 1) 내 메일함 조회 (수신)
```bash
curl -s http://localhost:3300/api/mail?agentId=platform-fe-antigravity
```
- **응답 예시**:
```json
[
  {
    "id": 252,
    "from": "platform-claude",
    "to": "platform-fe-antigravity",
    "body": "핑 확인. 받았습니다. 프론트엔드는 HTTP 3000번 포트(Vite 프록시 및 SSE)만 사용하시면 됩니다.",
    "createdAt": 1786956891235,
    "isRead": true
  }
]
```

### 📤 2) 상대방에게 메일 발신 (전송)
```bash
curl -s -X POST http://localhost:3300/api/mail \
  -H "Content-Type: application/json" \
  -d '{
    "from": "platform-fe-antigravity",
    "to": "platform-claude",
    "body": "프론트엔드 작업 완료 및 라우트 동기화 회신입니다."
  }'
```

---

## ⏱️ 3. `schedule` 도구를 활용한 대화 세션 자동 주입

Antigravity 환경에서는 백그라운드 프로세스의 표준 출력이 대화창을 직접 깨우지 못하므로, **`schedule` 도구를 사용하여 주기적으로 대화 세션에 알림을 주입하는 것이 공식 권장 방식**입니다.

### 📜 스케줄러 등록 예시 (`schedule` 도구 호출)
```json
{
  "CronExpression": "*/3 * * * *",
  "IsDaemon": true,
  "Prompt": "3분 주기 메일함 확인: platform-fe-antigravity 메일함을 확인하고 도착한 새 메시지가 있으면 처리하세요. (GET http://localhost:3300/api/mail?agentId=platform-fe-antigravity)"
}
```

- **동작 주기**: `*/3 * * * *` (매 3분마다 자동 실행)
- **효과**: 백엔드 팀(`platform-claude`)으로부터 새로운 스펙 및 공지가 오면 3분 이내에 세션에 자동 반영되어 즉각 대응이 가능합니다.

---

## 🤝 4. 주요 협업 대상 에이전트 목록

| 에이전트 ID | 역할 | 주 통신 주제 |
|---|---|---|
| `platform-fe-antigravity` | 프론트엔드 React/Vite/TypeScript 개발 (나) | UI/UX, 대시보드, 에이전트 스튜디오, 거버넌스 콘솔 |
| `platform-claude` | 백엔드 허브 & Hono HTTP 서버 개발 | REST 라우트, `@agent-mesh/contracts`, Mailbox 분리, RBAC/ACL |
| `client-claude` | 클라이언트 AI 런타임 & SDK 개발 | 에이전트 연동, 페어링 코드 리딤, E2E 시나리오 |
