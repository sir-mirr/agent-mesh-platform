# Agent Mesh Platform 디자인 시스템 (Light Theme Design System)

**문서 버전**: 2.0.0 (Light Theme Re-architecture)  
**작성자**: `platform-fe-antigravity`  
**대상 서비스**: Agent Mesh Platform Web (`agent-mesh-http` :3000)

---

## 1. 디자인 철학 및 기본 원칙

1. **초고선명 라이트 테마 (Ultra-Clean Light Theme)**:
   * 깨끗한 오프화이트 캔버스(`#F8FAFC`)와 순백색 카드(`#FFFFFF`), 절제된 테두리(`#E2E8F0`), 그리고 정교한 그림자 레이어를 통해 Linear/Stripe 수준의 최고급 SaaS 인터페이스를 구현합니다.
2. **명확한 타이포그래피 위계 (Clear Typographic Hierarchy)**:
   * `Plus Jakarta Sans` / `Pretendard` 기반의 현대적 폰트와 자간 조정(`letter-spacing: -0.015em`)을 적용하여 가독성을 극대화합니다.
3. **암호학적 엄격성 & 데이터 가시성 (Cryptographic Rigor)**:
   * 키 지문은 `JetBrains Mono` 고정폭 폰트로 43자리 전체를 투명하게 노출하며, 인박스 적체 상태는 `Leased (임대 중)`와 `Pending (대기 중)`을 선명한 듀얼톤 배지로 구분합니다.
4. **역할 기반 분리 (Role-Based Views)**:
   * **플랫폼 관리자(Admin Console)**: 승인 대기열, 키 지문 대조, 인박스 적체 감시, Teardown 모달
   * **에이전트 생성자(Creator Dashboard)**: 내 에이전트 상태, 메시지 테스트 콘솔, 인박스 타임라인

---

## 2. 디자인 토큰 (Design Tokens)

```css
:root {
  /* --- Light Theme Surfaces --- */
  --bg-app:          #F8FAFC; /* 캔버스 배경 */
  --bg-surface:      #FFFFFF; /* 카드 및 패널 */
  --bg-surface-sub:  #F1F5F9; /* 보조 영역 / 코드 박스 배경 */
  --bg-input:        #FFFFFF; /* 인풋 배경 */

  /* --- Borders --- */
  --border-subtle:   #F1F5F9;
  --border-default:  #E2E8F0;
  --border-strong:   #CBD5E1;
  --border-focus:    #3B82F6;

  /* --- Primary Brand (Vibrant Royal Blue) --- */
  --primary:         #2563EB;
  --primary-hover:   #1D4ED8;
  --primary-light:   #EFF6FF;
  --primary-border:  #BFDBFE;
  --primary-text:    #1D4ED8;

  /* --- Status Colors --- */
  --status-success:      #059669;
  --status-success-bg:   #ECFDF5;
  --status-success-br:   #A7F3D0;

  --status-warning:      #D97706;
  --status-warning-bg:   #FFFBEB;
  --status-warning-br:   #FDE68A;

  --status-danger:       #DC2626;
  --status-danger-bg:    #FEF2F2;
  --status-danger-br:    #FECACA;

  --status-leased:       #0284C7;
  --status-leased-bg:    #F0F9FF;
  --status-leased-br:    #BAE6FD;

  /* --- Text Colors --- */
  --text-primary:    #0F172A; /* 딥 슬레이트 블랙 */
  --text-secondary:  #475569; /* 뮤트 슬레이트 */
  --text-muted:      #94A3B8; /* 라이트 슬레이트 */

  /* --- Fonts & Radius --- */
  --font-ui:   "Plus Jakarta Sans", -apple-system, BlinkMacSystemFont, "Pretendard", sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, Menlo, monospace;
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 16px;
  --radius-full: 9999px;
}
```

---

## 3. 화면별 구성 명세

1. **홈 & 듀얼 로그인 (`/`)**:
   * Hero 헤드라인 + 실시간 네트워크 상태 인디케이터
   * **GitHub OAuth 로그인 카드** (`Continue with GitHub` 대형 버튼)
   * **로컬 ID/PW 로그인 카드** (`admin/admin` 부트스트랩 로그인)
   * 3대 핵심 기능 소개 카드 (소켓리스 전송, 키 검증, 불변 감사 로그)
2. **플랫폼 관리자 콘솔 (`/admin`)**:
   * 상단 글로벌 통계 리본 (승인 대기, 큐 적체 전체 vs Leased 수량, 활성 에이전트, AI 쿼터)
   * **키 지문 검증 뷰 (SPEC § 10.2)**: 43자리 전체 지문 박스 + 원클릭 복사 + 지문 기준 원자적 승인/거부
   * **인박스 적체 감시**: `Leased`와 `Pending` 분리 배지
   * **불가역 Teardown 모달 (SPEC § 9.3)**: 영구 재등록 불가 명시적 경고 다이얼로그
3. **에이전트 생성자 대시보드 (`/dashboard`)**:
   * 내 등록 에이전트 목록 (WebSocket 온라인 / 소켓리스 풀 모드 구분)
   * 대화형 메시지 송수신 플레이그라운드 콘솔 및 배달 영수증

---

## 4. 로컬 프리뷰 실행

```bash
bun scripts/serve-preview.ts 3005
```
👉 브라우저에서 `http://localhost:3005` 접속
