# Agent Mesh Platform Deployment & Operations Guide

> **단일 출처(Source of Truth)**: 로컬 개발 환경 실행 및 통합 기동 절차는 [`docs/running-locally.md`](docs/running-locally.md)를 참조하십시오. 해당 문서는 `env -i` 및 동적 포트 할당 환경에서 3차에 걸쳐 실측 검증되었습니다.

---

## 1. 아키텍처 및 서비스 구성

Agent Mesh Platform은 다음과 같은 3계층 컴포넌트로 구성됩니다:

```
[ 브라우저 / 오퍼레이터 ]
        │
        ▼ (HTTP)
┌─────────────────────────────────────────────────────────┐
│ packages/platform-web (Frontend SPA)                     │
│ - Vite 개발 서버 프록시 대상: $API_PROXY_TARGET          │
└──────────────────────────┬──────────────────────────────┘
                           │
        ┌──────────────────┴──────────────────┐
        ▼ (Admin REST / SSE)                  ▼ (WS / JSON-RPC)
┌──────────────────────────────┐   ┌──────────────────────────────┐
│ packages/http (Admin API)    │   │ packages/hub (Broker)        │
│ - 바인딩 포트: $AGENT_MESH_HTTP_PORT│ - 바인딩 포트: $AGENT_MESH_HUB_PORT│
└──────────────┬───────────────┘   └──────────────┬───────────────┘
               │                                  │
               └───────────────┬──────────────────┘
                               ▼
               ┌───────────────────────────────┐
               │ Shared SQLite DB (WAL Mode)   │
               │ - `agents.db`, `hub.db`       │
               │ - 저장소 경로: $STATE_DIR    │
               └───────────────────────────────┘
```

---

## 2. 빠른 기동 절차

상세한 사전 준비 및 단계별 기동 방법은 [`docs/running-locally.md`](docs/running-locally.md)에 기술되어 있으며, 프론트엔드 기동은 §8에 정의되어 있습니다:

```bash
# 1. 의존성 설치 및 타입 검증
bun install
bun run typecheck

# 2. 허브 및 HTTP 서버 기동 (docs/running-locally.md 참조)
# 3. 프론트엔드 기동 (HTTP 서버 포트로 API_PROXY_TARGET 설정)
API_PROXY_TARGET=http://127.0.0.1:<HTTP_PORT> bun --cwd packages/platform-web dev
```

---

## 3. 환경 변수 레퍼런스

| 환경변수 | 사용 패키지 | 설명 |
|---|---|---|
| `AGENT_MESH_HUB_PORT` | `packages/hub` | 허브 바인딩 포트 (기본값: 3100) |
| `AGENT_MESH_HTTP_PORT` | `packages/http` | 어드민 HTTP 서버 포트 (기본값: 3000) |
| `API_PROXY_TARGET` | `packages/platform-web` | Vite 프록시 백엔드 대상 URL |
| `STATE_DIR` | `hub`, `http` | SQLite 데이터베이스 저장소 디렉토리 |
