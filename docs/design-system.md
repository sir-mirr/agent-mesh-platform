# Agent Mesh Platform 디자인 시스템 (Design System Specification)

**문서 버전**: 1.0.0  
**작성자**: `platform-fe-antigravity`  
**대상 서비스**: Agent Mesh Platform Web (`agent-mesh-http` :3000)

---

## 1. 디자인 철학 및 기본 원칙

1. **기능 중심의 명확성 (Function-Driven Clarity)**:
   * 미학적 장식보다 운영자가 필요한 데이터(키 지문, 큐 상태, 감사 로그 등)를 1초 내에 파악할 수 있는 시각적 위계를 최우선으로 합니다.
2. **신뢰성과 암호학적 엄격성 (Cryptographic Rigor)**:
   * Ed25519 공개키 지문, 트랜잭션 해시, 타임스탬프는 왜곡이나 말줄임 없이 원문 그대로 정밀하게 렌더링합니다.
3. **역할 기반 분리 (Role-Separated Focus)**:
   * **플랫폼 어드민(Platform Admin)**: 시스템 인프라, 키 승인, 인박스 적체, 영구 Teardown, 전역 감사 로그에 집중
   * **에이전트 생성/일반 사용자(Agent Creator)**: 본인이 등록한 에이전트 상태, 인/아웃바운드 메시지 송수신, 개인 API 키 관리에 집중
4. **빌드리스 경량 아키텍처 (No-Build Lightweight Delivery)**:
   * 바닐라 CSS 변수(Custom Properties)와 시맨틱 HTML5 구조를 사용하여 번들러 없이 최고 속도의 로딩과 렌더링을 제공합니다.

---

## 2. 디자인 토큰 (Design Tokens)

### 2.1. 컬러 팔레트 (Color Palette)

```css
:root {
  /* --- Base Backgrounds (Deep Slate Dark Theme) --- */
  --bg-app:          #0b0f19; /* 최하단 캔버스 배경 */
  --bg-surface:      #111827; /* 기본 카드 및 패널 배경 */
  --bg-surface-elev: #1f2937; /* 호버, 모달, 드롭다운 배경 */
  --bg-input:        #0f172a; /* 입력 필드 및 코드 블록 배경 */

  /* --- Borders & Dividers --- */
  --border-subtle:   #1e293b; /* 미세 구분선 */
  --border-default:  #334155; /* 표준 컴포넌트 테두리 */
  --border-strong:   #475569; /* 포커스 및 활성 테두리 */

  /* --- Brand / Primary Accents (Refined Azure) --- */
  --primary:         #0284c7; /* 메인 액션 버튼 */
  --primary-hover:   #0369a1;
  --primary-light:   #38bdf8;
  --primary-glow:    rgba(2, 132, 199, 0.15);

  /* --- Semantic Status Colors --- */
  --status-success:       #10b981; /* 승인됨, 정상, 온라인 */
  --status-success-bg:    rgba(16, 185, 129, 0.12);
  --status-warning:       #f59e0b; /* 승인 대기, 윈도우 경고 */
  --status-warning-bg:    rgba(245, 158, 11, 0.12);
  --status-danger:        #ef4444; /* 거부됨, 폐기, Teardown */
  --status-danger-bg:     rgba(239, 68, 68, 0.12);
  --status-leased:        #06b6d4; /* 인박스 임대 중 (Leased) */
  --status-leased-bg:     rgba(6, 182, 212, 0.12);
  --status-offline:       #64748b; /* 오프라인, 비활성 */
  --status-offline-bg:    rgba(100, 116, 139, 0.12);

  /* --- Typography --- */
  --text-primary:    #f8fafc; /* 주요 제목 및 본문 */
  --text-secondary:  #94a3b8; /* 설명, 메타데이터 */
  --text-muted:      #64748b; /* 비활성, 보조 힌트 */
  --text-inverse:    #ffffff;
}
```

### 2.2. 타이포그래피 (Typography)

* **UI 폰트 스택**: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Pretendard Variable", sans-serif`
* **코드/해시/지문 폰트 스택**: `ui-monospace, "SF Mono", "Fira Code", "Cascadia Code", Menlo, monospace`

| 토큰 | 크기 | 행간(Line-Height) | 굵기(Weight) | 용도 |
|---|---|---|---|---|
| `--font-display` | 32px (2.0rem) | 1.2 | 700 | 홈 헤드라인, 주요 대시보드 타이틀 |
| `--font-h1` | 24px (1.5rem) | 1.3 | 600 | 화면 섹션 헤더 |
| `--font-h2` | 18px (1.125rem)| 1.4 | 600 | 카드 및 서브섹션 헤더 |
| `--font-body` | 14px (0.875rem)| 1.5 | 400 / 500 | 기본 본문, 테이블 텍스트 |
| `--font-small` | 12px (0.75rem) | 1.4 | 400 / 500 | 배지, 메타데이터, 타임스탬프 |
| `--font-mono` | 13px (0.8125rem)| 1.4 | 500 | 공개키 지문, JSON-RPC 데이터 |

### 2.3. 레이아웃 & 엘리베이션 (Elevation & Radius)

* **Radius Scale**:
  * `--radius-sm`: `4px` (배지, 인디케이터)
  * `--radius-md`: `8px` (버튼, 인풋, 작은 카드)
  * `--radius-lg`: `12px` (대형 카드, 패널, 모달)
* **Shadows**:
  * `--shadow-sm`: `0 1px 2px 0 rgba(0, 0, 0, 0.3)`
  * `--shadow-md`: `0 4px 6px -1px rgba(0, 0, 0, 0.4), 0 2px 4px -2px rgba(0, 0, 0, 0.3)`
  * `--shadow-lg`: `0 10px 15px -3px rgba(0, 0, 0, 0.5), 0 4px 6px -4px rgba(0, 0, 0, 0.4)`

---

## 3. 화면별 UI 시안 구조 (Screen Blueprints)

### 3.1. 첫 화면: 홈 & 듀얼 로그인 (Home & Dual Authentication)

#### [헤더 & Hero 섹션]
* **브랜드 로고**: Agent Mesh 심볼 + "Agent Mesh Platform"
* **플랫폼 라이브 상태 스트립**: 허브 상태(`Online`), 활성 에이전트 수, 감사 메시지 누적 통계 간략 요약
* **Hero 카피**: "Autonomous Multi-Agent Communication & Verification Fabric" (에이전트 간 비동기 소켓/인박스 전송 및 암호학적 신원 검증 플랫폼)

#### [듀얼 로그인 패널 (홈 중앙 배치)]
* **옵션 A: GitHub OAuth 로그인 (권장)**
  * 대형 소셜 로그인 버튼: "Continue with GitHub"
  * 클릭 시 `/auth/github` OAuth 플로우 진입
  * 승인 전 사용자는 "대기 화면"으로 부드럽게 안내
* **옵션 B: ID / Password 로컬 로그인**
  * 직관적인 입력 폼: `Username`, `Password`, `Login` 버튼
  * 로컬 관리자/테스트 계정(`admin/admin` 등) 즉시 로그인 지원
* **하단 피처 카드 3종**:
  1. *Signed Socketless Transport*: 프로세스 없는 에이전트를 위한 Ed25519 서명 인박스
  2. *Cryptographic Verification*: SHA-256 지문 대조 기반의 철저한 키 승인 절차
  3. *Immutable Audit Log*: 삭제되지 않는 영구 메시지 감사 스트림

---

### 3.2. 플랫폼 어드민 대시보드 (Platform Admin Console)

**타깃**: 시스템 총괄 운영자 (`role: 'admin'`)  
**목적**: 플랫폼 신원 보안, 인프라 큐, 시스템 감사, 전역 리소스 통제

#### [상단 글로벌 통계 바]
* 대기 중인 승인 요청(사용자 N건 / 키 M건), 총 인박스 적체 수, SSE 실시간 연결 상태 표시

#### [어드민 주요 탭 구성]
1. **Approval Queue (승인 대기열)**:
   * **사용자 승인**: GitHub OAuth 신규 사용자 승인/반려
   * **키 승인 (SPEC § 10.2)**: 43자리 SHA-256 지문 전체를 모노스페이스로 원문 표시 + 1:1 복사 버튼 + 승인/거부 액션
2. **Registry & Teardown (에이전트 레지스트리)**:
   * 에이전트 타입(`human`, `ai-claude`, `ai-codex`, `ai-gemini`, `service`) 관리
   * 등록된 신원 목록 및 상태
   * **영구 Teardown 액션**: "되돌릴 수 없는 영구 삭제" 경고 2차 모달
3. **Inbox Backlog Monitor (인박스 적체 감시)**:
   * 신원별 큐 깊이 바 차트
   * **전체 적체 vs. Leased(소비 중) 수량 분리 시각화**
4. **Chat Audits & Stream (실시간 메시지 감사)**:
   * SSE 실시간 스트림 피드, From/To 다차원 필터링, 본문 검색, 스마트 하단 스크롤(Pill 알림)
5. **AI Quota & Usage Monitor (AI 계정 자원 상황)**:
   * 공급자별 5단계 리스크 레벨 카드, 5시간/7일 윈도우 게이지, KST 기준 실시간 상대 시간 갱신

---

### 3.3. 일반 사용자 / 에이전트 생성자 대시보드 (Agent Creator Dashboard)

**타깃**: 에이전트 생성자, 개발자, 일반 참가자 (`role: 'user'` 또는 승인된 계정)  
**목적**: 본인 에이전트 관리, 메시지 송수신 테스트, 개인 인박스 및 API 키 모니터링

#### [내 에이전트 현황 (My Agents)]
* 내가 등록한 에이전트 목록 카드 (`identity`, `type`, `status`)
* 소켓 연결 상태: `Connected (Online)` / `Socketless (Pull Mode)` / `Pending Key Approval`
* 신규 에이전트 등록 가이드 및 Ed25519 키 생성 CLI 명령어 안내

#### [메시지 송수신 & 테스트 콘솔 (Message Playground)]
* 대상 에이전트 지정(`to: ...`), 메시지 본문 작성, 첨부파일 업로드
* 송신 후 배달 상태 즉시 확인 (`delivered` vs `queued in inbox`)
* 본인 에이전트 대화 내역 타임라인

#### [내 인박스 & 키 현황 (My Inbox & Credentials)]
* 내 인박스에 대기 중인 메시지 수 및 리스 상태
* 내 에이전트의 현재 승인된 키 지문 및 제안 상태

---

## 4. 컴포넌트 표준 규격

### 4.1. 공개키 지문 컴포넌트 (`.key-fingerprint`)
```html
<div class="key-fingerprint-box">
  <span class="fingerprint-prefix">sha256:</span>
  <code class="fingerprint-hash">43자리의_전체_해시_문자열_말줄임표_없이_전체_표시</code>
  <button class="btn-icon" title="지문 복사">📋</button>
</div>
```
* 고정폭 글꼴 적용, 줄바꿈 방지(`white-space: nowrap`), 1클릭 복사 제공.

### 4.2. 인박스 Leased 상태 배지 (`.badge-leased`)
* `전체 5건 대기` 중 `2건 임대 중(Leased)`일 때:
  * `[ 5 Queued ]` (슬레이트 배지) + `[ 2 Leased ⚡ ]` (사이언 배지)

### 4.3. Teardown 경고 모달 (`.modal-teardown`)
* 배경 딤(Dim) + 위험 경고 아이콘 + "신원 `demo-agent`를 삭제하시겠습니까? 삭제된 신원은 영구적으로 재등록할 수 없으며 복구할 수 없습니다." 경고 문구 + 입력 확인창.

---

## 5. 향후 UI 구현 계획

1. **Step 1**: 홈 화면 및 듀얼 로그인 인터페이스 구현
2. **Step 2**: 역할별 라우팅 분기 (Admin Dashboard vs Creator Dashboard)
3. **Step 3**: 어드민 대시보드 컴포넌트 고도화 (키 지문 검증 뷰, Leased 인박스 뷰어)
4. **Step 4**: 일반 사용자 대시보드 (에이전트 관리 및 메시지 플레이그라운드) 구현
