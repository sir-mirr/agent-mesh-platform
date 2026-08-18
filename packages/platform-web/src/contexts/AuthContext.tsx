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

/**
 * What the server said this session may do.
 *
 * **An empty array is an answer.** Every one of these sites used to read
 * `length > 0 ? server : ROLE_CAPABILITIES[role]`, which sends "the server says
 * you hold nothing" down the same branch as "the server did not say" — and that
 * branch resolved to a role table, which for `admin` is every capability there
 * is. Holding one capability locked four screens; holding none opened them.
 * The direction was inverted exactly at zero, which is why narrowing the list
 * never found it: it only appears at the end point.
 *
 * Measured before choosing, **against a mesh started from this source** —
 * which is not the same claim as "the server does this". A deployment running
 * an older build does not send the field at all: the standing stack was started
 * at 23:04 and the line that adds it landed at 04:18 the next morning, five
 * hours later, so `/auth/me` there answers without `capabilities` and every
 * session reads as holding nothing.
 *
 * On this source:
 *
 *   admin                 12 names
 *   audit.read.metadata   ["audit.read.metadata"]
 *   nobody                []          <- present, and empty
 *
 * So absent and empty are not two server states to tell apart; empty is what
 * the server says, and it is authoritative. An array is taken as given.
 *
 * **This makes the front end depend on a backend that sends the field**, and
 * that is a deployment order, not a detail: backend first, front end second.
 * Reversed, a full administrator sees nine of thirteen links and is bounced
 * from four screens, with no error and nothing in a log — the screen quietly
 * shows less. The fallback that used to hide this hid it by being wrong in the
 * other direction, which is not a reason to keep it.
 *
 * When the field is genuinely missing — an older server, a body that failed to
 * parse — the answer is nothing rather than everything. A screen that shows too
 * little is a complaint; one that shows too much is this defect. The API refuses
 * either way: a zero-capability session gets 403 from every gated route,
 * measured, so what was at stake here was what the screen offers, not what it
 * can reach.
 */
function capabilitiesFrom(value: unknown): Capability[] {
  return Array.isArray(value) ? (value as Capability[]) : [];
}

// `ROLE_CAPABILITIES` is gone. It was a table mapping roles to capabilities —
// the second copy of a list the server owns, which is what D-125 removed from
// the guards and left here. Nothing reads it now that an array from the server
// is taken as given, and the count in it was the source of the "9" the screen
// used to quote at people while the server handed out twelve.

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
            capabilities: capabilitiesFrom(parsed.capabilities),
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
            const resolvedCaps = capabilitiesFrom(me.capabilities);

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
      const resolvedCaps = capabilitiesFrom(res.user.capabilities);

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
      // The label changes; what the session may do does not. Capabilities come
      // from the server, and a control in the browser cannot grant any.
      capabilities: user.capabilities,
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
