import { useState } from "react";
import { Outlet, useNavigate } from "react-router-dom";
import { Sidebar } from "@/components/index.ts";
import { useAuth } from "@/contexts/AuthContext.tsx";
import { useI18n } from "@/contexts/I18nContext.tsx";
import { useRbac } from "@/contexts/RbacContext.tsx";

/**
 * RootLayout — 인증 후 공통 셸 레이아웃.
 *
 * 단일 ID 기반 RBAC 역할 제어에 따라
 * 사이드바 메뉴가 동적으로 활성/은닉됩니다.
 */
export function RootLayout() {
  const navigate = useNavigate();
  const { user, logout, isLoggingOut } = useAuth();
  const { t } = useI18n();
  const { capabilities } = useRbac();
  const [logoutFailed, setLogoutFailed] = useState(false);

  const handleLogout = async () => {
    setLogoutFailed(false);
    if (await logout()) {
      navigate("/login", { replace: true });
      return;
    }
    setLogoutFailed(true);
  };

  return (
    <div style={{ display: "flex", minHeight: "100dvh" }}>
      <Sidebar
        userName={user?.name ?? ""}
        userRole={user?.role || "AGENT_OPERATOR"}
        userCapabilities={capabilities}
        isLoggingOut={isLoggingOut}
        onLogout={() => { void handleLogout(); }}
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

      {logoutFailed && (
        <div
          role="alert"
          data-testid="logout-error"
          style={{
            position: "fixed",
            top: 20,
            right: 20,
            zIndex: 1000,
            maxWidth: 420,
            padding: "12px 14px",
            border: "1px solid var(--color-danger, #EF4444)",
            borderRadius: "var(--radius-md)",
            background: "var(--color-bg-surface, #FFFFFF)",
            color: "var(--color-danger, #EF4444)",
            boxShadow: "var(--shadow-md)",
            fontSize: "0.85rem",
          }}
        >
          {t(
            "auth.logoutFailed",
            "로그아웃하지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.",
          )}
        </div>
      )}
    </div>
  );
}
