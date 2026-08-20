/**
 * Where the guard sends a person, and the one case where it must not.
 *
 * `authFailure: "unreachable"` is not being signed out. A `502` from the proxy
 * in front of `/auth/me` used to land in the same branch as a `401` and send
 * operators to a login form that could not log them in, because the same proxy
 * was in front of `/auth/local`.
 *
 * **Nothing here is mocked, and that is the point of the rewrite.** The first
 * version replaced `useAuth`, `useRbac` and `react-router-dom` with shims. Each
 * `mock.module` is installed on the *process* at file top level — which bun
 * runs before any test in the whole suite — so those three shims reached every
 * other file: `ChangePasswordPage` lost `refreshSession`, and every page that
 * routes lost its router. 435 failures, none of which appeared when a file ran
 * alone, and all of which this file caused.
 *
 * So the state comes from where the app gets it: a stubbed `/auth/me`, the real
 * `AuthProvider`, the real `RbacProvider` (which reads the user's capabilities),
 * and a real `MemoryRouter` whose destinations are marked. That also makes the
 * assertions stronger — the chain from *what the server answered* to *where the
 * person lands* is the thing being claimed, and now it is the thing being run.
 */
import { describe, it, expect, afterEach, mock } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// **Registered once for the process, and never unregistered.** Bun executes
// every matching file's top level before it runs any test, so two files each
// calling `register()` swap the document out from under one another, and the
// first `afterAll` to fire takes it away from the file still using it.
if (!(globalThis as { document?: unknown }).document) GlobalRegistrator.register();

const { render, screen, cleanup, act } = await import("@testing-library/react");
const { MemoryRouter, Routes, Route } = await import("react-router-dom");
const { AuthProvider } = await import("@/contexts/AuthContext.tsx");
const { RbacProvider } = await import("@/contexts/RbacContext.tsx");
const { GuardedRoute } = await import("./GuardedRoute.tsx");

const realFetch = globalThis.fetch;
const stub = (fn: unknown) => { globalThis.fetch = fn as typeof globalThis.fetch; };

afterEach(() => {
  globalThis.fetch = realFetch;
  cleanup();
  // `AuthProvider` seeds itself from here, so a session left behind would sign
  // the next test in — in this file and in every file after it.
  localStorage.clear();
});

/** What `/auth/me` answers, which is the only thing the session is built from. */
type Session =
  | { kind: "session"; body: Record<string, unknown> }
  | { kind: "refused" }
  | { kind: "unreachable" };

function answering(session: Session) {
  stub(mock(async () => {
    if (session.kind === "unreachable") throw new TypeError("Failed to fetch");
    if (session.kind === "refused") {
      return new Response(JSON.stringify({ error: "not signed in" }),
        { status: 401, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(session.body),
      { status: 200, headers: { "content-type": "application/json" } });
  }));
}

const DESTINATIONS = ["/login", "/change-password", "/dashboard", "/creator"];

async function show(session: Session, props: Record<string, unknown> = {}) {
  answering(session);
  await act(async () => {
    render(
      <MemoryRouter initialEntries={["/guarded"]}>
        <AuthProvider>
          <RbacProvider>
            <Routes>
              <Route
                path="/guarded"
                element={
                  <GuardedRoute {...props}>
                    <div data-testid="content">the page</div>
                  </GuardedRoute>
                }
              />
              {DESTINATIONS.map((to) => (
                <Route key={to} path={to} element={<div data-testid={`at:${to}`} />} />
              ))}
            </Routes>
          </RbacProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
  });
}

/** Where the person ended up, read off the router rather than off a shim. */
const landedOn = () =>
  DESTINATIONS.find((to) => screen.queryByTestId(`at:${to}`) !== null) ?? null;

const signedIn = (extra: Record<string, unknown> = {}): Session => ({
  kind: "session",
  body: { ok: true, github_id: 1, github_login: "operator", role: "member",
          approved: true, created_at: "", must_change_password: false, ...extra },
});

describe("GuardedRoute", () => {
  it("shows the page to a signed-in person with nothing required", async () => {
    await show(signedIn());
    expect(screen.queryByTestId("content")).not.toBe(null);
    expect(landedOn()).toBe(null);
  });

  it("sends an unauthenticated person to the login form", async () => {
    await show({ kind: "refused" });
    expect(landedOn()).toBe("/login");
    expect(screen.queryByTestId("content")).toBe(null);
  });

  it("does not call an unreachable backend a signed-out session", async () => {
    await show({ kind: "unreachable" });
    // The defect this branch exists for: not /login, and not the page either.
    // A login form is useless when the same proxy is in front of /auth/local.
    expect(landedOn()).toBe(null);
    expect(screen.queryByTestId("auth-unreachable")).not.toBe(null);
    expect(screen.queryByTestId("content")).toBe(null);
  });

  it("sends a locked session to the password change before anything else", async () => {
    await show(signedIn({ must_change_password: true, capabilities: ["agent.provision"] }),
               { requiredCapability: "agent.provision" });
    // Ahead of the capability check, which this session passes: the server is
    // already answering 403 to every other route while the flag is set.
    expect(landedOn()).toBe("/change-password");
  });

  it("sends a person without the capability to the fallback, not to login", async () => {
    await show(signedIn({ capabilities: [] }), { requiredCapability: "key.approve" });
    // Signed in and refused is a different answer from not signed in.
    expect(landedOn()).toBe("/dashboard");
  });

  it("honours a redirectTo that is not the dashboard", async () => {
    await show(signedIn({ capabilities: [] }),
               { requiredCapability: "key.approve", redirectTo: "/creator" });
    expect(landedOn()).toBe("/creator");
  });

  it("shows the page once the server says the capability is held", async () => {
    await show(signedIn({ capabilities: ["key.approve"] }), { requiredCapability: "key.approve" });
    // The whole chain: the answer carried the name, RbacProvider read it off
    // the session, and the guard let the page through.
    expect(screen.queryByTestId("content")).not.toBe(null);
    expect(landedOn()).toBe(null);
  });
});
