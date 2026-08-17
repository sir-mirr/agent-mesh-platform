import React, { createContext, useContext, useState, useEffect } from "react";
import type { User, UserRole, Capability } from "@/types/auth.ts";

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  loginWithLocal: (id: string, pass: string, role?: UserRole) => Promise<void>;
  loginWithGitHub: () => void;
  logout: () => void;
  switchRole: (role: UserRole) => void;
}

const ROLE_CAPABILITIES: Record<UserRole, Capability[]> = {
  AGENT_OPERATOR: [
    "audit.read_metadata",
  ],
  GROUP_ADMIN: [
    "group.manage",
    "audit.read_metadata",
  ],
  TENANT_ADMIN: [
    "key.approve",
    "agent.teardown",
    "group.manage",
    "policy.send_restrict",
    "audit.read_content",
    "audit.read_metadata",
    "role.assign",
  ],
  PLATFORM_ADMIN: [
    "key.approve",
    "agent.teardown",
    "group.manage",
    "policy.send_restrict",
    "audit.read_content",
    "audit.read_metadata",
    "server.inspect",
    "role.assign",
    "admin.all",
  ],
};

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(() => {
    const saved = localStorage.getItem("agent_mesh_user");
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch {
        return null;
      }
    }
    // Default initial mock session for development
    return {
      id: "usr_admin",
      name: "관리자 (Operator)",
      role: "PLATFORM_ADMIN",
      capabilities: ROLE_CAPABILITIES.PLATFORM_ADMIN,
      tenantId: "tenant_default",
      authProvider: "local",
    };
  });

  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (user) {
      localStorage.setItem("agent_mesh_user", JSON.stringify(user));
    } else {
      localStorage.removeItem("agent_mesh_user");
    }
  }, [user]);

  const loginWithLocal = async (id: string, _pass: string, role: UserRole = "PLATFORM_ADMIN") => {
    setIsLoading(true);
    try {
      const newUser: User = {
        id: `usr_${id}`,
        name: `${id} (운영자)`,
        role,
        capabilities: ROLE_CAPABILITIES[role],
        tenantId: "tenant_acme",
        authProvider: "local",
      };
      setUser(newUser);
    } finally {
      setIsLoading(false);
    }
  };

  const loginWithGitHub = () => {
    // In production redirects to /auth/github
    const newUser: User = {
      id: "usr_gh_octocat",
      name: "GitHub User (@octocat)",
      role: "PLATFORM_ADMIN",
      capabilities: ROLE_CAPABILITIES.PLATFORM_ADMIN,
      tenantId: "tenant_acme",
      authProvider: "github",
    };
    setUser(newUser);
  };

  const logout = () => {
    setUser(null);
  };

  const switchRole = (role: UserRole) => {
    if (!user) return;
    setUser({
      ...user,
      role,
      capabilities: ROLE_CAPABILITIES[role],
    });
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated: !!user,
        isLoading,
        loginWithLocal,
        loginWithGitHub,
        logout,
        switchRole,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
