# @agent-mesh/platform-web

Agent Mesh Platform 관리 콘솔 — **React 19 + TypeScript 7 + Vite 6** 기반 SPA.

## 기술 스택

| 항목 | 버전 | 용도 |
|------|------|------|
| React | 19.x | UI 프레임워크 |
| TypeScript | 7.0.2 | 타입 안정성 (모노레포 공용) |
| Vite | 6.x | 번들러 및 개발 서버 |
| react-router-dom | 7.x | 클라이언트 사이드 라우팅 |

## 디렉터리 구조

```
packages/platform-web/
├── index.html              ← Vite HTML 엔트리 포인트
├── package.json
├── tsconfig.json           ← TS7, react-jsx, strict, @/ 별칭
├── vite.config.ts          ← 포트 3005, API 프록시 → :3100
├── vite-env.d.ts
└── src/
    ├── main.tsx            ← React 루트 마운트
    ├── App.tsx             ← BrowserRouter & 라우트 정의
    ├── styles/
    │   └── index.css       ← 글로벌 CSS 토큰 & 리셋
    ├── layouts/
    │   └── RootLayout.tsx  ← 사이드바 + Outlet 셸 레이아웃
    └── pages/
        ├── LoginPage.tsx   ← 통합 단일 로그인 (GitHub / ID·PW)
        └── DashboardPage.tsx ← Phase 1 MVP 대시보드
```

## 시작하기

```bash
# 의존성 설치 (모노레포 루트에서)
bun install

# 개발 서버 실행 (포트 3005)
bun --filter @agent-mesh/platform-web dev

# 또는 패키지 디렉터리에서 직접
cd packages/platform-web
bun run dev
```

## API 프록시

개발 서버는 `/api/*` 및 `/auth/*` 요청을 자동으로 `http://localhost:3100` (HTTP 서버)으로 프록시합니다.

## 설계 원칙

1. **단일 계정(Single ID) RBAC**: 하나의 로그인 진입점에서 세션에 부여된 역할/역량(Capabilities)에 따라 메뉴를 동적으로 활성화/은닉.
2. **Phase 1 집중**: 핵심 에이전트 등록/관리, 스웜 그룹 배속, 메시지 테스트, 소켓리스 큐 감시에 집중.
3. **디자인 토큰 공유**: `src/styles/index.css`의 CSS 커스텀 프로퍼티로 색상, 타이포, 반경, 그림자를 통일 관리.
