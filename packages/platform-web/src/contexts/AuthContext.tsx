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

import { ALL_CAPABILITIES } from "@/types/auth.ts";

const ROLE_CAPABILITIES: Record<UserRole, Capability[]> = {
  AGENT_OPERATOR: [
    "audit.read.metadata",
    "mailbox.read.depth",
  ],
  GROUP_ADMIN: [
    "group.manage",
    "audit.read.metadata",
    "mailbox.read.depth",
  ],
  TENANT_ADMIN: [
    "key.approve",
    "agent.teardown",
    "agent.provision",
    "group.manage",
    "audit.read.content",
    "audit.read.metadata",
    "mailbox.read.depth",
    "tenant.read.stats",
    "role.grant",
  ],
  PLATFORM_ADMIN: ALL_CAPABILITIES as Capability[],
};

const AuthContext = createContext<AuthContextType | null>(null);

import { loginLocalApi, fetchAuthMe } from "@/api/auth.ts";

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(() => {
    const saved = localStorage.getItem("agent_mesh_user");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed) {
          const roleKey: UserRole = parsed.role || "PLATFORM_ADMIN";
          return {
            ...parsed,
            capabilities: parsed.capabilities || ROLE_CAPABILITIES[roleKey],
          };
        }
      } catch {
        return null;
      }
    }
    return null;
  });

  const [isLoading, setIsLoading] = useState(true);

  // Validate session on mount via /auth/me
  useEffect(() => {
    async function checkSession() {
      try {
        const me = await fetchAuthMe();
        if (me && me.github_login) {
          setUser((prev) => {
            const roleKey: UserRole =
              (me.role === "admin" || me.github_login === "admin" || me.github_login === "platform-admin")
                ? "PLATFORM_ADMIN"
                : (prev?.role || "AGENT_OPERATOR");
            const resolvedCaps = Array.isArray(me.capabilities) && me.capabilities.length > 0
              ? me.capabilities
              : ROLE_CAPABILITIES[prev?.role || roleKey];

            return {
              id: `usr_${me.github_login}`,
              name: `${me.github_login} (운영자)`,
              role: prev?.role || roleKey,
              capabilities: resolvedCaps,
              tenantId: "tenant_default",
              authProvider: "local",
            };
          });
        } else {
          setUser(null);
        }
      } catch {
        // Not authenticated
        setUser(null);
      } finally {
        setIsLoading(false);
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
      const res = await loginLocalApi(id, pass);
      const mappedRole: UserRole =
        res.user.role === "admin" ? "PLATFORM_ADMIN" : role;
      const resolvedCaps = Array.isArray(res.user.capabilities) && res.user.capabilities.length > 0
        ? res.user.capabilities
        : ROLE_CAPABILITIES[mappedRole];

      const newUser: User = {
        id: `usr_${res.user.github_login}`,
        name: `${res.user.github_login} (운영자)`,
        role: mappedRole,
        capabilities: resolvedCaps,
        tenantId: "tenant_acme",
        authProvider: "local",
      };
      setUser(newUser);
    } catch (err: any) {
      setUser(null);
      throw err;
    } finally {
      setIsLoading(false);
    }
  };

  const loginWithGitHub = () => {
    // Redirect to backend OAuth endpoint
    window.location.href = "/auth/github";
  };

  const logout = () => {
    setUser(null);
    localStorage.removeItem("agent_mesh_user");
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
