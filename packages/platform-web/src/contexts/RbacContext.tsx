import React, { createContext, useContext } from "react";
import { useAuth } from "./AuthContext.tsx";
import type { Capability, UserRole } from "@/types/auth.ts";

interface RbacContextType {
  capabilities: Capability[];
  role: UserRole | null;
  hasCapability: (capability: Capability) => boolean;
  hasAnyCapability: (capabilities: Capability[]) => boolean;
  hasRole: (role: UserRole | UserRole[]) => boolean;
}

const RbacContext = createContext<RbacContextType | null>(null);

export function RbacProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();

  const capabilities = user?.capabilities || [];
  const role = user?.role || null;

  const hasCapability = (capability: Capability): boolean => {
    if (!user) return false;
    if (capabilities.includes("admin.all")) return true;
    return capabilities.includes(capability);
  };

  const hasAnyCapability = (reqCapabilities: Capability[]): boolean => {
    if (!user) return false;
    if (capabilities.includes("admin.all")) return true;
    return reqCapabilities.some((cap) => capabilities.includes(cap));
  };

  const hasRole = (roles: UserRole | UserRole[]): boolean => {
    if (!role) return false;
    if (Array.isArray(roles)) {
      return roles.includes(role);
    }
    return role === roles;
  };

  return (
    <RbacContext.Provider
      value={{
        capabilities,
        role,
        hasCapability,
        hasAnyCapability,
        hasRole,
      }}
    >
      {children}
    </RbacContext.Provider>
  );
}

export function useRbac() {
  const context = useContext(RbacContext);
  if (!context) {
    throw new Error("useRbac must be used within an RbacProvider");
  }
  return context;
}

/**
 * Can — Capability 기반 조건부 렌더링 헬퍼 컴포넌트
 */
export function Can({
  capability,
  children,
  fallback = null,
}: {
  capability: Capability | Capability[];
  children: React.ReactNode;
  fallback?: React.ReactNode;
}) {
  const { hasCapability, hasAnyCapability } = useRbac();

  const allowed = Array.isArray(capability)
    ? hasAnyCapability(capability)
    : hasCapability(capability);

  if (!allowed) {
    return <>{fallback}</>;
  }

  return <>{children}</>;
}
