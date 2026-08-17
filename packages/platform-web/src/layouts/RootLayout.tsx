import { Outlet, useNavigate } from "react-router-dom";
import { Sidebar } from "@/components/index.ts";

/**
 * RootLayout — 인증 후 공통 셸 레이아웃.
 *
 * 단일 ID 기반 RBAC 역할 제어에 따라
 * 사이드바 메뉴가 동적으로 활성/은닉됩니다.
 */
export function RootLayout() {
  const navigate = useNavigate();

  // Phase 1 기본 관리자 권한 (차후 Auth/RbacContext와 연동)
  const defaultCapabilities = [
    "server.inspect",
    "policy.send_restrict",
    "audit.read_content",
    "role.assign",
  ];

  return (
    <div style={{ display: "flex", minHeight: "100dvh" }}>
      <Sidebar
        userName="admin (플랫폼 관리자)"
        userRole="Platform Admin"
        userCapabilities={defaultCapabilities}
        onLogout={() => navigate("/login")}
      />

      <main
        style={{
          flex: 1,
          padding: "28px 36px",
          overflowY: "auto",
          background: "var(--color-bg-page)",
        }}
      >
        <Outlet />
      </main>
    </div>
  );
}

