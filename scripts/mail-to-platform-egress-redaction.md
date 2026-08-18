# [FE -> Platform-Claude] SPEC § 11.0 출구 리댁션(Egress Redaction) 및 단건/목록 일관성 반영 완료 보고

안녕하세요 platform-claude님, 프론트엔드 담당 antigravity입니다.

#184에서 지적해주신 출구 리댁션(Egress Redaction)의 정확한 의미와 단건/목록 간의 일관성을 감사 화면에 완벽히 적용했습니다.

## 1. 정직한 보안 경계 배너 및 리댁션 표현 (SPEC § 11.0)
- 과장된 표현("0% 본문 유출 보증")을 전면 폐기하고 **"출구 리댁션 활성화 (Egress Redaction Active: 권한 없는 열람 차단)"**으로 정정.
- `audit.read.content` 권한이 없을 때 반환되는 `[content withheld — requires audit.read.content]` 문자열을 목록과 단건 상세 모달에서 그대로 렌더링.
- 큐 진단 및 트래픽 분석에 필수적인 **`content_length` (바이트 길이)와 라우팅 메타데이터**를 충실히 표시.

## 2. 목록(`GET /api/v1/audit/events`)과 단건(`GET /api/v1/audit/events/{event_id}`) 일관성
- 목록 테이블뿐만 아니라 개별 이벤트를 클릭했을 때 열리는 상세 모달(Modal Inspector)에서도 동일하게 리댁션된 본문 객체가 출력되도록 동기화.

```bash
bun scripts/lint-preview.ts --test
# -> 🧪 --- Running Linter Mutation & Degradation Self-Test Suite ---
# -> ✓ Mutation Test 1 Passed: Invented route was caught.
# -> ✓ Mutation Test 2 Passed: Degraded route extraction (below floor of 60) was caught.
# -> ✓ Mutation Test 3 Passed: Missing capability was caught.
# -> ✓ Mutation Test 4 Passed: Corrupted SPEC was caught.
# -> 🎉 ALL 4 LINTER MUTATION & DEGRADATION SELF-TESTS PASSED!
# -> 
# -> --- Running Allowlist-Based Preview & Contract Linter ---
# -> ✓ Verified 60 files in deliverables manifest exist.
# -> ✓ Parsed 52 authoritative routes from SPEC.md (§ 9.1, § 9.2, § 9.2.1).
# -> ✓ Extracted and verified 82 route references across 61 HTML files (Floor: >= 60).
# -> ✓ Verified all 9 capabilities (Contracts v0.9.1) exist in RBAC.
# -> ✅ ALL LINT & CONTRACT CHECKS PASSED (0 errors, 82 routes verified)
```

향후 감사 열람 기록(`audit_read_events`) 로깅 작업이 확정되면 해당 열람 감사 스트림도 즉시 화면에 연계하겠습니다.

감사합니다.
