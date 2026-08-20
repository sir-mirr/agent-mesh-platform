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
 * **Two things are ordered here rather than declared.** `GlobalRegistrator`
 * has to install `document` before `@testing-library/react` is loaded, and
 * `mock.module` is not hoisted the way vitest's `vi.mock` is — so the module
 * under test is imported after its dependencies have been replaced, not before.
 * Both are why the imports below are `await import` instead of statements.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// **Registered once for the process, and never unregistered.** Bun executes
// every matching file's top level before it runs any test, so two files each
// calling `register()` swap the document out from under one another, and the
// first `afterAll` to fire takes it away from the file still using it — seven
// failures that appeared only when the two ran together, and none when either
// ran alone.
if (!(globalThis as { document?: unknown }).document) GlobalRegistrator.register();

const auth: { value: Record<string, unknown> } = { value: {} };
const rbac: { held: Set<string> } = { held: new Set() };

// **`mock.module` is global to the process and does not end with this file.**
// A replacement that exported only `useI18n` left the *dictionary's own* test,
// which runs later, importing a module with no `DICTIONARY` in it — seven
// failures that appeared only when the two files ran together. So each mock
// spreads the real module and overrides one export, and each is put back at the
// end. Neither half alone is enough: the spread keeps the file honest while it
// runs, the restore keeps it honest afterwards.
const realAuth = await import("@/contexts/AuthContext.tsx");
const realRbac = await import("@/contexts/RbacContext.tsx");
const realI18n = await import("@/contexts/I18nContext.tsx");

mock.module("@/contexts/AuthContext.tsx", () => ({ ...realAuth, useAuth: () => auth.value }));
mock.module("@/contexts/RbacContext.tsx", () => ({
  ...realRbac,
  useRbac: () => ({ hasCapability: (c: string) => rbac.held.has(c) }),
}));
mock.module("@/contexts/I18nContext.tsx", () => ({
  ...realI18n,
  useI18n: () => ({ t: (k: string, fallback?: string) => fallback ?? k }),
}));
// Mocked rather than routed: the assertion is *where it sends you*, and a real
// router answers that by rendering whatever is mounted at the destination.
mock.module("react-router-dom", () => ({
  Navigate: ({ to }: { to: string }) => <div data-testid="sent-to">{to}</div>,
}));

const { render, screen, cleanup } = await import("@testing-library/react");
const { GuardedRoute } = await import("./GuardedRoute.tsx");

const signedIn = {
  isAuthenticated: true, isLoading: false, authFailure: null, mustChangePassword: false,
};

beforeEach(() => { auth.value = { ...signedIn }; rbac.held = new Set(); });
afterEach(cleanup);
afterAll(() => {
  mock.module("@/contexts/AuthContext.tsx", () => realAuth);
  mock.module("@/contexts/RbacContext.tsx", () => realRbac);
  mock.module("@/contexts/I18nContext.tsx", () => realI18n);
});

const show = (props: Record<string, unknown> = {}) =>
  render(<GuardedRoute {...props}><div data-testid="content">the page</div></GuardedRoute>);

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
    show({ requiredCapability: "agent.provision" });
    expect(sentTo()).toBe("/change-password");
  });

  it("sends a person without the capability to the fallback, not to login", () => {
    show({ requiredCapability: "key.approve" });
    // Signed in and refused is a different answer from not signed in.
    expect(sentTo()).toBe("/dashboard");
  });

  it("honours a redirectTo that is not the dashboard", () => {
    show({ requiredCapability: "key.approve", redirectTo: "/creator" });
    expect(sentTo()).toBe("/creator");
  });

  it("shows the page once the capability is held", () => {
    rbac.held = new Set(["key.approve"]);
    show({ requiredCapability: "key.approve" });
    expect(screen.queryByTestId("content")).not.toBe(null);
  });
});
