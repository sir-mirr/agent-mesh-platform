import React from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext.tsx";
import { useRbac } from "@/contexts/RbacContext.tsx";
import { useI18n } from "@/contexts/I18nContext.tsx";
import type { Capability } from "@/types/auth.ts";

export interface GuardedRouteProps {
  children: React.ReactNode;
  requiredCapability?: Capability;
  redirectTo?: string;
}

export function GuardedRoute({
  children,
  requiredCapability,
  redirectTo = "/dashboard",
}: GuardedRouteProps) {
  const { isAuthenticated, isLoading, authFailure, mustChangePassword } = useAuth();
  const { hasCapability } = useRbac();
  const { t } = useI18n();

  if (isLoading) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "50vh",
          color: "var(--color-text-muted)",
        }}
      >
        {t("guard.checking", "인증 상태를 확인하는 중입니다...")}
      </div>
    );
  }

  // **Being unable to ask is not being signed out.** `/auth/me` answering `502`
  // used to land here and send the person to a login form that could not log
  // them in, because the same proxy was in front of `/auth/local`. The screen
  // said "sign in" about a backend that was restarting.
  if (!isAuthenticated && authFailure === "unreachable") {
    return (
      <div
        data-testid="auth-unreachable"
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "50vh",
          gap: 10,
          color: "var(--color-text-muted)",
          textAlign: "center",
        }}
      >
        <span style={{ fontSize: "2rem" }}>🔌</span>
        <strong>{t("guard.unreachable", "서버에 연결할 수 없습니다")}</strong>
        <span>{t("guard.unreachableWhy", "지금은 로그인 상태를 확인할 수 없습니다. 서버가 돌아오면 새로고침하십시오.")}</span>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  // **The server is already refusing everything else.** This redirect does not
  // create the restriction — `403 { must_change_password: true }` comes back
  // from every other route while the flag is set — it stops the person from
  // reading a dashboard of refusals and having to work out why. A screen that
  // only redirected would be a guard that guards nothing; the check that says
  // otherwise is the one calling the API with the cookie and no browser.
  if (mustChangePassword === true) {
    return <Navigate to="/change-password" replace />;
  }

  if (requiredCapability && !hasCapability(requiredCapability)) {
    return <Navigate to={redirectTo} replace />;
  }


  return <>{children}</>;
}
