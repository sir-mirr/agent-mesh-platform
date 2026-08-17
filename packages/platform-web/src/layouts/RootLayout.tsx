import { Outlet } from "react-router-dom";

/**
 * RootLayout — 인증 후 공통 셸 레이아웃.
 *
 * 단일 ID 기반 RBAC 역할 제어에 따라
 * 사이드바 메뉴가 동적으로 활성/은닉됩니다.
 */
export function RootLayout() {
  return (
    <div style={{ display: "flex", minHeight: "100dvh" }}>
      {/* TODO: <Sidebar /> — RBAC 기반 동적 메뉴 */}
      <aside
        style={{
          width: 260,
          borderRight: "1px solid var(--color-border)",
          background: "var(--color-bg-surface)",
          padding: "20px 16px",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div
          style={{
            fontWeight: 800,
            fontSize: "1.05rem",
            letterSpacing: "-0.02em",
            marginBottom: 16,
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <div
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              background: "linear-gradient(135deg, #2563EB, #1D4ED8)",
              color: "white",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "0.85rem",
              fontWeight: 900,
            }}
          >
            M
          </div>
          Agent Mesh
        </div>

        <NavItem label="대시보드" href="/dashboard" />
        <NavItem label="에이전트 관리" href="/agents" disabled />
        <NavItem label="스웜 그룹" href="/groups" disabled />
        <NavItem label="토폴로지" href="/topology" disabled />
        <NavItem label="인박스 큐" href="/inbox" disabled />
        <NavItem label="메시지 테스트" href="/playground" disabled />

        <div
          style={{
            marginTop: "auto",
            fontSize: "0.75rem",
            color: "var(--color-text-muted)",
          }}
        >
          Phase 1 MVP · SPEC 0.2
        </div>
      </aside>

      <main style={{ flex: 1, padding: 28, overflow: "auto" }}>
        <Outlet />
      </main>
    </div>
  );
}

function NavItem({
  label,
  href,
  disabled,
}: {
  label: string;
  href: string;
  disabled?: boolean;
}) {
  return (
    <a
      href={disabled ? undefined : href}
      style={{
        display: "block",
        padding: "8px 12px",
        borderRadius: "var(--radius-md)",
        fontSize: "0.88rem",
        fontWeight: 600,
        color: disabled
          ? "var(--color-text-muted)"
          : "var(--color-text-secondary)",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
        textDecoration: "none",
      }}
    >
      {label}
    </a>
  );
}
