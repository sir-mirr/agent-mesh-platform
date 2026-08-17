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

import { loginLocalApi, fetchAuthMe } from "@/api/auth.ts";

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
    // Default initial session for development
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

  // Validate session on mount if user exists
  useEffect(() => {
    async function checkSession() {
      try {
        const me = await fetchAuthMe();
        if (me && me.github_login) {
          const roleKey: UserRole =
            me.role === "admin" ? "PLATFORM_ADMIN" : "AGENT_OPERATOR";
          setUser((prev) => ({
            id: `usr_${me.github_login}`,
            name: `${me.github_login} (운영자)`,
            role: prev?.role || roleKey,
            capabilities: ROLE_CAPABILITIES[prev?.role || roleKey],
            tenantId: "tenant_default",
            authProvider: "local",
          }));
        }
      } catch {
        // Dev offline or token expired, keep current state or fallback
      }
    }
    checkSession();
  }, []);

  useEffect(() => {
    if (user) {
      localStorage.setItem("agent_mesh_user", JSON.stringify(user));
    } else {
      localStorage.removeItem("agent_mesh_user");
    }
  }, [user]);

  const loginWithLocal = async (id: string, pass: string, role: UserRole = "PLATFORM_ADMIN") => {
    setIsLoading(true);
    try {
      try {
        // Attempt real backend authentication
        const res = await loginLocalApi(id, pass);
        const mappedRole: UserRole =
          res.user.role === "admin" ? "PLATFORM_ADMIN" : role;

        const newUser: User = {
          id: `usr_${res.user.github_login}`,
          name: `${res.user.github_login} (운영자)`,
          role: mappedRole,
          capabilities: ROLE_CAPABILITIES[mappedRole],
          tenantId: "tenant_acme",
          authProvider: "local",
        };
        setUser(newUser);
      } catch (err: any) {
        // Fallback for mock/local offline dev
        console.warn("[Auth] Backend login returned error or offline, fallback to local:", err.message);
        const newUser: User = {
          id: `usr_${id}`,
          name: `${id} (운영자)`,
          role,
          capabilities: ROLE_CAPABILITIES[role],
          tenantId: "tenant_acme",
          authProvider: "local",
        };
        setUser(newUser);
      }
    } finally {
      setIsLoading(false);
    }
  };

  const loginWithGitHub = () => {
    // In production redirects to /auth/github (GitHub OAuth will be enabled later)
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
