import React from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext.tsx";
import { useRbac } from "@/contexts/RbacContext.tsx";
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
  const { isAuthenticated, isLoading } = useAuth();
  const { hasCapability } = useRbac();

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
        인증 상태를 확인하는 중입니다...
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  if (requiredCapability && !hasCapability(requiredCapability)) {
    return <Navigate to={redirectTo} replace />;
  }


  return <>{children}</>;
}
