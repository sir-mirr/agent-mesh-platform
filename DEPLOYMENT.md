# Agent Mesh Platform Deployment & Operations Guide

> **목적**: `agent-mesh-hub`, `agent-mesh-http`, `platform-web` 3개 서비스를 누구나 처음 보는 상태에서도 100% 정상 기동하고 운영할 수 있도록 명확한 단계별 실행 절차를 제공합니다.

---

## 1. 아키텍처 및 포트 구성

```
[ 브라우저 / 오퍼레이터 ]
        │
        ▼ (HTTP / Web)
┌─────────────────────────────────────────────────────────┐
│ 1. packages/platform-web (Vite Dev / Nginx / Static)     │
│    - 기본 포트: 3005 (개발) / 80, 443 (운영)              │
│    - 프록시 대상: AGENT_MESH_HTTP_URL (기본 http://127.0.0.1:3000)│
└──────────────────────────┬──────────────────────────────┘
                           │
        ┌──────────────────┴──────────────────┐
        ▼ (REST / SSE)                        ▼ (WS / JSON-RPC)
┌──────────────────────────────┐   ┌──────────────────────────────┐
│ 2. packages/http             │   │ 3. packages/hub              │
│    - 포트: 3000              │   │    - 포트: 3100              │
│    - 역할: Admin REST, Auth, │   │    - 역할: WebSocket 브로커,  │
│      RBAC, Egress, Audits    │   │      메시지 라우팅, Ed25519 서명│
└──────────────┬───────────────┘   └──────────────┬───────────────┘
               │                                  │
               └───────────────┬──────────────────┘
                               ▼
               ┌───────────────────────────────┐
               │ Shared SQLite DB (WAL Mode)   │
               │ - `agents.db`, `hub.db`       │
               │ - 기본 경로: /var/lib/agent-mesh│
               │   (개발: ./data or $STATE_DIR) │
               └───────────────────────────────┘
```

| 서비스 | 디렉토리 / 패키지 | 기본 포트 | 프로토콜 | 설명 |
|---|---|:---:|:---:|---|
| **`agent-mesh-hub`** | `packages/hub` | `3100` | WS / HTTP | 메시지 라우팅 브로커, 에이전트 등록 및 Ed25519 서명 검증 |
| **`agent-mesh-http`** | `packages/http` | `3000` | HTTP / SSE | 웹 관리자 REST API, 세션 인증, RBAC, 감사 로그 |
| **`platform-web`** | `packages/platform-web` | `3005` | HTTP | 관리자 프론트엔드 콘솔 SPA (React 19 + TypeScript) |

---

## 2. 로컬 개발 환경 1분 빠른 실행 가이드

### 1단계: 의존성 설치 및 사전 검증
```bash
# 모노레포 루트에서 1회 실행
bun install
bun run typecheck
```

### 2단계: 3개 서비스 동시 실행 (각각 별도 터미널 탭)

#### 터미널 1: `agent-mesh-hub` (포트 3100)
```bash
bun run start:hub
# 또는 직접 실행:
# bun --cwd packages/hub src/main.ts
```
> **정상 기동 로그**: `[hub] listening on ws://127.0.0.1:3100 and http://127.0.0.1:3100`

#### 터미널 2: `agent-mesh-http` (포트 3000)
```bash
bun run start:http
# 또는 직접 실행:
# bun --cwd packages/http src/main.ts
```
> **정상 기동 로그**: `[http-server] listening on http://127.0.0.1:3000`

#### 터미널 3: `platform-web` (포트 3005)
```bash
# 기본적으로 http://127.0.0.1:3000 으로 API 요청을 프록시합니다.
API_PROXY_TARGET=http://127.0.0.1:3000 bun --cwd packages/platform-web dev
```
> **접속 URL**: [http://localhost:3005](http://localhost:3005)

---

## 3. 프로덕션 빌드 및 배포

### 1) 프론트엔드 정적 번들 빌드
```bash
bun run build:web
```
- 결과물 생성 위치: `packages/platform-web/dist/`
- Nginx 또는 Cloudflare Pages/S3 등 정적 호스팅에 배포 가능.

### 2) Nginx 프록시 설정 예시 (`/etc/nginx/sites-available/agent-mesh.conf`)
```nginx
server {
    listen 80;
    server_name mesh.example.com;

    # SPA 정적 파일 서빙
    location / {
        root /var/www/agent-mesh/packages/platform-web/dist;
        index index.html;
        try_files $uri $uri/ /index.html;
    }

    # Admin REST API & SSE 스트림 프록시
    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 86400s;
    }

    # Hub WebSocket 라우팅 프록시
    location /ws {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host $host;
    }
}
```

---

## 4. 헬스 체크 및 동작 검증

기동 후 아래 명령어로 3개 컴포넌트의 정상 연동을 즉시 확인할 수 있습니다:

```bash
# 1. 허브 헬스체크 (온라인 소켓 수 및 liveness 확인)
curl -i http://127.0.0.1:3100/health
# HTTP/1.1 200 OK {"status":"ok","online_sockets":0}

# 2. 허브 Capabilities & Provenance 확인 (Dirty 상태 아님을 검증)
curl -i http://127.0.0.1:3100/api/v1/capabilities

# 3. HTTP 서버 관리자 로그인 테스트
curl -i -X POST http://127.0.0.1:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"handle": "admin", "password": "..."}'

# 4. 프론트엔드 로컬 접속
open http://localhost:3005
```

---

## 5. 주요 환경변수 레퍼런스

| 환경변수 | 기본값 | 사용 서비스 | 설명 |
|---|---|---|---|
| `AGENT_MESH_HUB_PORT` | `3100` | `hub` | 허브 바인딩 포트 |
| `AGENT_MESH_HTTP_PORT` | `3000` | `http` | 관리자 HTTP API 포트 |
| `API_PROXY_TARGET` | `http://127.0.0.1:3000` | `platform-web` | Vite 개발 서버가 백엔드 API를 포워딩할 대상 주소 |
| `STATE_DIR` | `/var/lib/agent-mesh` | `hub`, `http` | SQLite 데이터베이스 저장소 디렉토리 |
| `NODE_ENV` | `development` | 전 서비스 | 실행 환경 (`development` / `production`) |
