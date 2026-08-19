import { Outlet, useNavigate } from "react-router-dom";
import { Sidebar } from "@/components/index.ts";
import { useAuth } from "@/contexts/AuthContext.tsx";
import { useRbac } from "@/contexts/RbacContext.tsx";

/**
 * RootLayout — 인증 후 공통 셸 레이아웃.
 *
 * 단일 ID 기반 RBAC 역할 제어에 따라
 * 사이드바 메뉴가 동적으로 활성/은닉됩니다.
 */
export function RootLayout() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const { capabilities } = useRbac();

  return (
    <div style={{ display: "flex", minHeight: "100dvh" }}>
      <Sidebar
        userName={user?.name ?? ""}
        userRole={user?.role || "AGENT_OPERATOR"}
        userCapabilities={capabilities}
        onLogout={() => {
          logout();
          navigate("/login");
        }}
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

