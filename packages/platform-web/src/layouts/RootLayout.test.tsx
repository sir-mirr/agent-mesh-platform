/**
 * The shell every signed-in screen is drawn inside, and the three things it
 * decides on its own.
 *
 * It renders no data of its own, so what is worth pinning is what it *hands
 * on*: which menu the sidebar is built from, what it says about the person
 * holding the session, and where signing out leaves them. Each of those has a
 * wrong version this repository has already paid for once.
 *
 * The sidebar and the router here are real. A mocked sidebar would answer
 * "which props were passed", and the question is which destinations an operator
 * is offered — a capability list that reaches the sidebar and is then filtered
 * against the wrong vocabulary offers the same nothing as one that never
 * arrived. So the assertions read the `href`s that actually got drawn, and the
 * one mock is `useAuth`: the session is the input, not the thing under test.
 * `RbacProvider` is the real one, so the chain from the server's array to the
 * rendered menu is the chain being checked.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Registered once for the process and never unregistered: bun runs every test
// file's top level before any test, so a paired `unregister()` takes `document`
// away from a file that is still using it.
if (!(globalThis as { document?: unknown }).document) GlobalRegistrator.register();

const auth: { value: Record<string, unknown> } = { value: {} };

// Spread and restored, because `mock.module` is global to the process: a
// replacement exporting only `useAuth` would leave whichever file runs next
// importing an `AuthContext` with no `AuthProvider` in it.
const realAuth = await import("@/contexts/AuthContext.tsx");
mock.module("@/contexts/AuthContext.tsx", () => ({ ...realAuth, useAuth: () => auth.value }));

const { render, screen, cleanup, fireEvent } = await import("@testing-library/react");
const { MemoryRouter, Routes, Route } = await import("react-router-dom");
const { I18nProvider } = await import("@/contexts/I18nContext.tsx");
const { RbacProvider } = await import("@/contexts/RbacContext.tsx");
const { RootLayout } = await import("./RootLayout.tsx");

let loggedOut = 0;

/** The session the shell is handed. `null` is a person the shell has no user for. */
const signedInAs = (user: unknown) => {
  auth.value = { user, logout: () => { loggedOut += 1; } };
};

beforeEach(() => {
  loggedOut = 0;
  signedInAs({ name: "sohee", role: "AGENT_OPERATOR", capabilities: [] });
});
afterEach(cleanup);
afterAll(() => {
  mock.module("@/contexts/AuthContext.tsx", () => realAuth);
});

// A real router, so `/login` below is somewhere the shell can actually arrive
// rather than a name a stub echoed back.
const shell = (): HTMLElement =>
  render(
    <I18nProvider>
      <RbacProvider>
        <MemoryRouter initialEntries={["/dashboard"]}>
          <Routes>
            <Route element={<RootLayout />}>
              <Route path="/dashboard" element={<div data-testid="page">the dashboard</div>} />
            </Route>
            <Route path="/login" element={<div data-testid="login">the login form</div>} />
          </Routes>
        </MemoryRouter>
      </RbacProvider>
    </I18nProvider>,
  ).container;

/** Every destination the shell is currently offering. */
const offered = (c: HTMLElement): (string | null)[] =>
  [...c.querySelectorAll("a[href]")].map((a) => a.getAttribute("href"));

/** The strip at the bottom of the sidebar: who this is, and the way out. */
const whoAmI = (c: HTMLElement): string =>
  c.querySelector("aside")?.lastElementChild?.textContent ?? "";

/** Destinations that exist only for someone holding the matching capability. */
const GATED = [
  "/platform/tenants",
  "/platform/users",
  "/tenant/egress-acl",
  "/tenant/audits",
  "/tenant/rbac",
];

describe("RootLayout", () => {
  it("draws the routed page inside its own main region", () => {
    const c = shell();
    // The outlet is the entire reason this is a shell and not a frame. A layout
    // that renders its chrome and drops the outlet looks completely healthy and
    // leaves every route blank, which is the failure that is hard to see.
    expect(c.querySelector("main")?.textContent).toContain("the dashboard");
    expect(c.querySelector("aside")).not.toBe(null);
  });

  it("offers a platform administrator holding no capability nothing that needs one", () => {
    signedInAs({ name: "admin", role: "PLATFORM_ADMIN", capabilities: [] });
    const c = shell();
    const links = offered(c);
    // The open pages are still there: the menu is not empty, it is exactly as
    // wide as the pages that ask for nothing. `/platform` is deliberately among
    // them — its routes gate on a session and no more, and a menu stricter than
    // the route hides a page from somebody allowed to open it.
    expect(links).toContain("/dashboard");
    expect(links).toContain("/creator");
    expect(links).toContain("/platform");
    for (const href of GATED) expect(links).not.toContain(href);
    // And the title is still printed beside the name. That is the point: it is
    // a label the shell repeats, and it opened not one of the five above.
    expect(whoAmI(c)).toContain("PLATFORM_ADMIN");
  });

  it("opens exactly the destination a granted name gates, and no neighbour", () => {
    // The other end of the same question, on the junior role: one capability
    // from the server, one door. The pair matters because the fallback this
    // console removed inverted at zero — a senior title with an empty list
    // opened everything, a granted name opened four screens fewer.
    signedInAs({ name: "sohee", role: "AGENT_OPERATOR", capabilities: ["tenant.read.stats"] });
    const links = offered(shell());
    expect(links).toContain("/platform/tenants");
    for (const href of GATED.filter((h) => h !== "/platform/tenants")) {
      expect(links).not.toContain(href);
    }
  });

  it("ends the session and leaves the shell when signing out", () => {
    const c = shell();
    fireEvent.click(screen.getByTestId("logout"));
    // Both halves, because each has shipped alone. Navigating without ending
    // the session left `mesh_token` alive behind a login form that let the
    // person straight back in; ending it without navigating leaves an operator
    // reading a shell belonging to a session that no longer exists.
    expect(loggedOut).toBe(1);
    expect(screen.queryByTestId("login")).not.toBe(null);
    expect(screen.queryByTestId("page")).toBe(null);
    expect(c.querySelector("aside")).toBe(null);
  });

  it("leaves the name blank for a session it has no user for", () => {
    // `Sidebar` defaults `userName` to the literal `admin`, and this is the one
    // place that default could ever be reached. The shell passes an empty
    // string instead, so nobody reads a stranger's name back as their own: a
    // placeholder in the field an operator checks to see who they are signed in
    // as is worse than a blank, which at least looks like the absence it is.
    signedInAs(null);
    expect(whoAmI(shell())).not.toContain("admin");
    cleanup();
    signedInAs({ name: "admin", role: "PLATFORM_ADMIN", capabilities: [] });
    // Positive control: `admin` is a name the shell will print when the session
    // actually carries it, so the assertion above is about the blank and not
    // about the string being unprintable.
    expect(whoAmI(shell())).toContain("admin");
  });
});
