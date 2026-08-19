import React, { createContext, useContext, useState, useEffect } from "react";
import type { User, UserRole, Capability } from "@/types/auth.ts";
import { ApiError, apiClient } from "@/api/client.ts";

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  /**
   * Why there is no user — refused, or never asked successfully.
   *
   * `null` while a session exists. `"unauthenticated"` when `/auth/me` answered
   * and said no. `"unreachable"` when it did not answer: a `502` from the
   * deployment's proxy, a `504`, or no connection at all. Those used to share
   * one branch, and sharing it signs people out of a running deployment the
   * moment the backend restarts — measured on nginx in front of a real build,
   * where every screen became the login form and logging in did nothing.
   */
  authFailure: "unauthenticated" | "unreachable" | null;
  /**
   * The server says this account must set a password before it may do anything
   * else. `null` while nothing has been asked yet — the screen must not decide
   * "no" on its own, because the server answers `403` to every other route and
   * a page that guessed wrong would show an operator a dashboard of errors.
   */
  mustChangePassword: boolean | null;
  /** Ask `/auth/me` again — used after a password change, so the screen learns
   *  the flag cleared from the server rather than assuming it did. */
  refreshSession: () => Promise<void>;
  loginWithLocal: (id: string, pass: string) => Promise<void>;
  loginWithGitHub: () => void;
  logout: () => void;
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
          // A `roleKey` defaulting to `PLATFORM_ADMIN` used to be computed here
          // and never used — the identifier below is a different scope. It was
          // deleted rather than left: dead code that reads as fail-open costs
          // every later audit the minutes it takes to prove it is dead, and
          // agent-mesh-local-pm nearly filed "authentication opens at the
          // highest role" as a P0 before following it three lines further.
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
  const [authFailure, setAuthFailure] = useState<"unauthenticated" | "unreachable" | null>(null);
  const [mustChangePassword, setMustChangePassword] = useState<boolean | null>(null);

  // Validate session on mount via /auth/me
  useEffect(() => {
    async function checkSession() {
      try {
        const me = await fetchAuthMe();
        if (me && me.github_login) {
          setUser((prev) => {
            // `prev?.role` was the fallback here, which is what let a role the
            // screen had picked survive a reload. With the picker gone there is
            // nothing for it to carry but the server's own answer, so it is
            // computed from `me` every time and the client keeps no role of its own.
            const roleKey: UserRole =
              (me.role === "admin" || me.github_login === "admin" || me.github_login === "platform-admin")
                ? "PLATFORM_ADMIN"
                : "AGENT_OPERATOR";
            const resolvedCaps = capabilitiesFrom(me.capabilities);
            setMustChangePassword(me.must_change_password === true);

            return {
              id: `usr_${me.github_login}`,
              // The server said `github_login`. Appending a Korean noun to it made
              // the sidebar say "admin (운영자)" in English mode, and made the
              // client the author of a title nobody granted.
              name: me.github_login,
              role: roleKey,
              capabilities: resolvedCaps,
              tenantId: "tenant_default",
              authProvider: "local",
            };
          });
        } else {
          setUser(null);
          setAuthFailure("unauthenticated");
        }
      } catch (err) {
        // **Not every failure here is "not authenticated".** That phrase was
        // this comment while the branch under it also caught a proxy's `502`,
        // and on a deployment that means a backend restart signs every operator
        // out — measured with nginx in front of a real build: all thirteen
        // screens became the login form, and logging in did nothing.
        setUser(null);
        setAuthFailure(err instanceof ApiError && err.refused ? "unauthenticated" : "unreachable");
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

  /**
   * **The role comes from the account, not from the form.**
   *
   * This took a `role` argument, defaulting to `PLATFORM_ADMIN`, and the login
   * page passed whatever a `<select>` labelled 시뮬레이션 역할 was set to. It
   * granted nothing — `GuardedRoute` and the sidebar both ask `hasCapability`,
   * and `POST /auth/local` reads only the username and password — but the
   * sidebar drew the choice as the person's title, so a screen deployed to a
   * real server showed a self-declared 플랫폼 관리자.
   */
  const refreshSession = async (): Promise<void> => {
    try {
      const me = await fetchAuthMe();
      setMustChangePassword(me.must_change_password === true);
    } catch {
      setMustChangePassword(null);
    }
  };

  const loginWithLocal = async (id: string, pass: string) => {
    setIsLoading(true);
    try {
      const res = await loginLocalApi(id, pass);
      const mappedRole: UserRole =
        res.user.role === "admin" ? "PLATFORM_ADMIN" : "AGENT_OPERATOR";
      const resolvedCaps = capabilitiesFrom(res.user.capabilities);

      const newUser: User = {
        id: `usr_${res.user.github_login}`,
        name: res.user.github_login,
        role: mappedRole,
        capabilities: resolvedCaps,
        tenantId: "tenant_acme",
        authProvider: "local",
      };
      setUser(newUser);
      // **The login response does not carry it.** Measured against the running
      // server: `POST /auth/local` answers `{ok, user:{…}}` and nothing else,
      // so the flag has to be asked for. Reading it from a field that is not
      // there would leave `mustChangePassword` false and walk a locked session
      // into a dashboard where every panel is a 403.
      try {
        const me = await fetchAuthMe();
        setMustChangePassword(me.must_change_password === true);
      } catch {
        setMustChangePassword(null);
      }
    } catch (err: any) {
      setUser(null);
      setMustChangePassword(null);
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
    // **The cookie is the session, and it is the server's.** Clearing local
    // state alone sent the browser to `/login` still signed in — measured on
    // the running product: `mesh_token` survived, `/auth/me` answered `200`,
    // and `/dashboard` opened again.
    void apiClient("/auth/logout", { method: "POST" }).catch(() => {});
    setUser(null);
    setMustChangePassword(null);
    setAuthFailure(null);
    localStorage.removeItem("agent_mesh_user");
  };



  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated: !!user,
        isLoading,
        authFailure: user ? null : authFailure,
        mustChangePassword,
        refreshSession,
        loginWithLocal,
        loginWithGitHub,
        logout,
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
