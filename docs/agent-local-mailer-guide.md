# 📬 Agent-Local-Mailer 사용 가이드 & Antigravity 초기 세션 프롬프트

로컬 멀티 에이전트 환경간에 비동기 메시지를 주고받는 **Agent Local Mailer**의 연동 규약 및 Antigravity 세션 시작 가이드입니다.

---

## 🚀 1. Antigravity 첫 대화 프롬프트 (Copy & Paste)

> **💡 사용법:** 새 대화(세션)를 시작할 때 아래 블록 전체를 복사하여 Antigravity 첫 메시지로 입력하세요. 에이전트가 알아서 감시 스크립트를 생성하고 백그라운드 데몬을 즉시 가동합니다.

````markdown
당신은 xxx 에이전트 입니다.
당신의 메일러에 사용할 당신의 에이전트 ID를 사용자에게 알려주세요.

1. **메일함 확인 및 무소음 감시 데몬 가동**:
   - 내 에이전트 ID: `{agentId}`
   - 메일 서버 주소: `http://localhost:3300`
   - 먼저 최근 도착한 메일을 확인하세요:
     `curl -s http://localhost:3300/api/mail?agentId={agentId}`
   - 메일이 없을 때 매분 LLM을 깨워 토큰을 낭비하는 `schedule` cron을 절대 사용하지 마세요.
   - 대신 아래 코드로 `scripts/watch-mail.ts`를 생성하고 `run_command(IsDaemon=true, CommandLine="bun scripts/watch-mail.ts")`로 백그라운드 실행하세요:

```typescript
// scripts/watch-mail.ts
console.log("🟢 [watch-mail] Started monitoring mailbox (http://localhost:3300/api/mail)...");

let lastKnownMaxId = 0;

// 1. Initialize with current highest ID on server
try {
  const initRes = await fetch("http://localhost:3300/api/mail?agentId=platform-fe-antigravity");
  if (initRes.ok) {
    const list: any[] = await initRes.json();
    if (list.length > 0) {
      lastKnownMaxId = Math.max(...list.map(m => m.id));
      console.log(`🟢 [watch-mail] Initialized with latest message #${lastKnownMaxId}`);
    }
  }
} catch (e: any) {
  console.error("🔴 [watch-mail] Failed to connect to mail server:", e.message);
}

// 2. Poll every 5s silently and print only when a higher ID message arrives
while (true) {
  try {
    const res = await fetch("http://localhost:3300/api/mail?agentId=platform-fe-antigravity");
    if (res.ok) {
      const messages: any[] = await res.json();
      const newMails = messages.filter((m: any) => m.id > lastKnownMaxId);
      if (newMails.length > 0) {
        for (const mail of newMails) {
          console.log(`\n📬 [NEW MAIL #${mail.id}] From: ${mail.from}\n${mail.body}\n`);
        }
        lastKnownMaxId = Math.max(...messages.map((m: any) => m.id));
      }
    }
  } catch {}
  await Bun.sleep(5000);
}
```

2. **협업 에이전트 및 통신 규칙 예시**:
아래 내용은 예시입니다. 받드시 당신의 사용자에게 협업 에이전트id와 역할을 문의하세요.
   - 백엔드 플랫폼 에이전트: `{platformAgentId}`
   - 클라이언트 에이전트: `{clientAgentId}`
   - 백엔드 팀과 스펙, 계약(contracts), 라우트 변경 논의 시 `POST http://localhost:3300/api/mail`로 메일을 주고받으세요.
````

---

## 📡 2. 핵심 REST API 엔드포인트

메일 서버는 로컬 `http://localhost:3300`에서 가동 중입니다.

### 📥 1) 내 메일함 조회 (수신)
```bash
curl -s http://localhost:3300/api/mail?agentId={agentId}
```
- **응답 예시**:
```json
[
  {
    "id": 248,
    "from": "platform-claude",
    "to": "{agentId}",
    "body": "GET /api/v1/admin/keys/stream (SSE) 배포 완료...",
    "createdAt": 1786955622464,
    "isRead": false
  }
]
```

### 📤 2) 상대방에게 메일 발신 (전송)
```bash
curl -s -X POST http://localhost:3300/api/mail \
  -H "Content-Type: application/json" \
  -d '{
    "from": "{yourAgentId}",
    "to": "{targetAgentId}",
    "body": "프론트엔드 작업 완료 및 라우트 동기화 회신입니다."
  }'
```

---

## 🔇 3. 토큰 절약형 무소음 감시 데몬 (`watch-mail.ts`)

### ⚠️ 왜 `schedule` cron을 쓰지 않나요?
- `schedule` cron(`* * * * *`)을 사용하면 메일이 없어도 매 분마다 LLM 시스템 메시지가 발생하여 **불필요한 토큰과 비용이 지속적으로 소모**됩니다.

### ✅ 무소음 데몬의 장점
- `scripts/watch-mail.ts` 데몬을 백그라운드로 실행하면:
  1. **유휴 상태 (새 메일 없음)**: 프로세스가 조용히 대기하며 **토큰 소모량 0 (Zero Token)**.
  2. **새 메일 도착 시**: 즉시 터미널 출력을 발생시켜 Antigravity를 깨우고 새 메시지 내용을 브리핑합니다.

### 📜 데몬 스크립트 코드 (`scripts/watch-mail.ts`)
```typescript
/**
 * Silent Mail Watcher Daemon
 */
let lastKnownMaxId = 0;

// 1. 초기 최대 ID 확인
try {
  const initRes = await fetch("http://localhost:3300/api/mail?agentId={agentId}");
  if (initRes.ok) {
    const list: any[] = await initRes.json();
    if (list.length > 0) lastKnownMaxId = Math.max(...list.map(m => m.id));
  }
} catch {}

// 2. 10초 주기로 무소음 폴링
while (true) {
  try {
    const res = await fetch("http://localhost:3300/api/mail?agentId={agentId}");
    if (res.ok) {
      const messages: any[] = await res.json();
      const newMails = messages.filter((m: any) => !m.isRead && m.id > lastKnownMaxId);
      if (newMails.length > 0) {
        for (const mail of newMails) {
          console.log(`\n📬 [NEW MAIL #${mail.id}] From: ${mail.from}\n${mail.body}\n`);
        }
        lastKnownMaxId = Math.max(...messages.map((m: any) => m.id));
      }
    }
  } catch {}
  await Bun.sleep(10000);
}
```

---

## 🤝 4. 주요 협업 대상 에이전트 목록

아래 목록은 예시입니다. 받드시 당신의 사용자에게 협업 에이전트id와 역할을 문의하세요.

| 에이전트 ID | 역할 | 주 통신 주제 |
|---|---|---|
| `platform-fe-antigravity` | 프론트엔드 React/Vite/TypeScript 개발 (나) | UI/UX, 대시보드, 에이전트 스튜디오, 거버넌스 콘솔 |
| `platform-claude` | 백엔드 허브 & Hono HTTP 서버 개발 | REST 라우트, `@agent-mesh/contracts`, Mailbox 분리, RBAC/ACL |
| `client-claude` | 클라이언트 AI 런타임 & SDK 개발 | 에이전트 연동, 페어링 코드 리딤, E2E 시나리오 |
