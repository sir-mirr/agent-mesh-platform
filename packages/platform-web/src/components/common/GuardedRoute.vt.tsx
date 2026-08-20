/**
 * Where the guard sends a person, and the one case where it must not.
 *
 * `authFailure: "unreachable"` is not being signed out. A `502` from the proxy
 * in front of `/auth/me` used to land in the same branch as a `401` and send
 * operators to a login form that could not log them in, because the same proxy
 * was in front of `/auth/local`. The branch exists; until this file the only
 * thing exercising it was a browser, and only for the states a browser could be
 * driven into.
 *
 * `Navigate` is mocked rather than routed, because the assertion here is *where
 * it sends you* — a real router would answer that question by rendering
 * whatever happens to be mounted at the destination.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { GuardedRoute } from "./GuardedRoute.tsx";

const auth = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const rbac = vi.hoisted(() => ({ held: new Set<string>() }));

vi.mock("@/contexts/AuthContext.tsx", () => ({ useAuth: () => auth.value }));
vi.mock("@/contexts/RbacContext.tsx", () => ({
  useRbac: () => ({ hasCapability: (c: string) => rbac.held.has(c) }),
}));
vi.mock("@/contexts/I18nContext.tsx", () => ({
  useI18n: () => ({ t: (_k: string, fallback?: string) => fallback ?? _k }),
}));
vi.mock("react-router-dom", () => ({
  Navigate: ({ to }: { to: string }) => <div data-testid="sent-to">{to}</div>,
}));

const signedIn = {
  isAuthenticated: true, isLoading: false, authFailure: null, mustChangePassword: false,
};

// `globals: false`, so testing-library does not register its own afterEach and
// every render would otherwise pile into one document — five tests failed on
// finding two of the thing they had each rendered once.
afterEach(cleanup);
beforeEach(() => { auth.value = { ...signedIn }; rbac.held = new Set(); });

const show = () =>
  render(<GuardedRoute><div data-testid="content">the page</div></GuardedRoute>);

const sentTo = () => screen.queryByTestId("sent-to")?.textContent ?? null;

describe("GuardedRoute", () => {
  it("shows the page to a signed-in person with nothing required", () => {
    show();
    expect(screen.queryByTestId("content")).not.toBe(null);
    expect(sentTo()).toBe(null);
  });

  it("says it is still checking rather than deciding early", () => {
    auth.value = { ...signedIn, isAuthenticated: false, isLoading: true };
    show();
    expect(sentTo()).toBe(null);
    expect(screen.queryByTestId("content")).toBe(null);
  });

  it("does not call an unreachable backend a signed-out session", () => {
    auth.value = { ...signedIn, isAuthenticated: false, authFailure: "unreachable" };
    show();
    // The defect this branch exists for: not /login, and not the page either.
    expect(sentTo()).toBe(null);
    expect(screen.queryByTestId("auth-unreachable")).not.toBe(null);
  });

  it("sends an unauthenticated person to the login form", () => {
    auth.value = { ...signedIn, isAuthenticated: false, authFailure: "unauthenticated" };
    show();
    expect(sentTo()).toBe("/login");
  });

  it("sends a locked session to the password change before anything else", () => {
    auth.value = { ...signedIn, mustChangePassword: true };
    rbac.held = new Set(["agent.provision"]);
    render(
      <GuardedRoute requiredCapability={"agent.provision" as never}>
        <div data-testid="content">the page</div>
      </GuardedRoute>,
    );
    expect(sentTo()).toBe("/change-password");
  });

  it("sends a person without the capability to the fallback, not to login", () => {
    render(
      <GuardedRoute requiredCapability={"key.approve" as never}>
        <div data-testid="content">the page</div>
      </GuardedRoute>,
    );
    // Signed in and refused is a different answer from not signed in.
    expect(sentTo()).toBe("/dashboard");
  });

  it("honours a redirectTo that is not the dashboard", () => {
    render(
      <GuardedRoute requiredCapability={"key.approve" as never} redirectTo="/creator">
        <div data-testid="content">the page</div>
      </GuardedRoute>,
    );
    expect(sentTo()).toBe("/creator");
  });

  it("shows the page once the capability is held", () => {
    rbac.held = new Set(["key.approve"]);
    render(
      <GuardedRoute requiredCapability={"key.approve" as never}>
        <div data-testid="content">the page</div>
      </GuardedRoute>,
    );
    expect(screen.queryByTestId("content")).not.toBe(null);
  });
});
