/**
 * DashboardPage — Phase 1 MVP 대시보드.
 *
 * 에이전트 운영자: 내 에이전트 목록 + 큐 상태.
 * 테넌트 관리자: 플릿 현황 위젯 추가.
 * 플랫폼 운영자: 서버 헬스 메트릭 추가.
 */
export function DashboardPage() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div>
        <h1
          style={{
            fontSize: "1.6rem",
            fontWeight: 800,
            letterSpacing: "-0.03em",
          }}
        >
          대시보드
        </h1>
        <p
          style={{
            fontSize: "0.9rem",
            color: "var(--color-text-secondary)",
            marginTop: 4,
          }}
        >
          에이전트 메시 플랫폼 Phase 1 MVP 통합 운영 콘솔
        </p>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          gap: 16,
        }}
      >
        <KpiCard label="등록 에이전트" value="—" color="var(--color-primary)" />
        <KpiCard label="온라인 소켓" value="—" color="var(--color-success)" />
        <KpiCard label="인박스 적체" value="—" color="var(--color-warning)" />
        <KpiCard label="라우팅 건수" value="—" color="var(--color-text-muted)" />
      </div>

      <div
        style={{
          background: "var(--color-bg-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-xl)",
          padding: 24,
          minHeight: 300,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--color-text-muted)",
          fontSize: "0.92rem",
        }}
      >
        Phase 1 기능 구현 예정 — API 연동 후 실시간 데이터가 표시됩니다.
      </div>
    </div>
  );
}

function KpiCard({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: string;
}) {
  return (
    <div
      style={{
        background: "var(--color-bg-surface)",
        border: "1px solid var(--color-border)",
        borderRadius: "var(--radius-lg)",
        padding: "18px 20px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        boxShadow: "var(--shadow-xs)",
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "1.8rem",
          fontWeight: 800,
          color,
          letterSpacing: "-0.02em",
        }}
      >
        {value}
      </span>
      <span
        style={{
          fontSize: "0.78rem",
          fontWeight: 600,
          color: "var(--color-text-secondary)",
          textTransform: "uppercase",
          letterSpacing: "0.04em",
        }}
      >
        {label}
      </span>
    </div>
  );
}
