import React, { createContext, useContext } from "react";
import { useAuth } from "./AuthContext.tsx";
import type { Capability } from "@/types/auth.ts";

/**
 * `role` used to sit here beside these two and nothing ever read it.
 *
 * It is worth naming rather than deleting quietly: authorisation on this screen
 * layer is capability-only — `GuardedRoute` and the sidebar both ask
 * `hasCapability`, and neither has ever asked the role. A role exposed from the
 * RBAC context reads as though it were part of that decision.
 */
interface RbacContextType {
  capabilities: Capability[];
  hasCapability: (capability: Capability) => boolean;
}

const RbacContext = createContext<RbacContextType | null>(null);

export function RbacProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();

  const capabilities = user?.capabilities || [];

  const hasCapability = (capability: Capability): boolean => {
    if (!user) return false;
    return capabilities.includes(capability);
  };



  return (
    <RbacContext.Provider
      value={{
        capabilities,
        hasCapability,
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

