import React, { createContext, useContext } from "react";
import { useAuth } from "./AuthContext.tsx";
import type { Capability, UserRole } from "@/types/auth.ts";

interface RbacContextType {
  capabilities: Capability[];
  role: UserRole | null;
  hasCapability: (capability: Capability) => boolean;
}

const RbacContext = createContext<RbacContextType | null>(null);

export function RbacProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();

  const capabilities = user?.capabilities || [];
  const role = user?.role || null;

  const hasCapability = (capability: Capability): boolean => {
    if (!user) return false;
    return capabilities.includes(capability);
  };



  return (
    <RbacContext.Provider
      value={{
        capabilities,
        role,
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

