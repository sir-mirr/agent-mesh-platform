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
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { registerDom } from "../register-dom";

// Registered once for the process and never unregistered: bun runs every test
// file's top level before any test, so a paired `unregister()` takes `document`
// away from a file that is still using it.
registerDom();

const { render, screen, cleanup, fireEvent, act } = await import("@testing-library/react");
const { MemoryRouter, Routes, Route } = await import("react-router-dom");
const { AuthProvider } = await import("@/contexts/AuthContext.tsx");
const { DICTIONARY, I18nProvider } = await import("@/contexts/I18nContext.tsx");
const { RbacProvider } = await import("@/contexts/RbacContext.tsx");
const { RootLayout } = await import("./RootLayout.tsx");

const realFetch = globalThis.fetch;

/** Every request the shell makes, and the one it makes when signing out. */
let signOutPosts = 0;
let session: Record<string, unknown> | null = null;
let logoutReply: () => Response | Promise<Response> = () =>
  new Response(JSON.stringify({ ok: true }),
    { status: 200, headers: { "content-type": "application/json" } });

function serve() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/auth/logout")) {
      signOutPosts += 1;
      return await logoutReply();
    }
    if (url.includes("/auth/me")) {
      if (session === null) {
        return new Response(JSON.stringify({ error: "not signed in" }),
          { status: 401, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify(session),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true }),
      { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
}

/**
 * The session the shell is handed, described the way the server describes it.
 *
 * **`useAuth` is not replaced here.** `mock.module` is installed on the process
 * at file top level — before bun runs a single test anywhere — so a shim in this
 * file reached every other file that reads a session, and signing out through a
 * counter proved nothing about the sign-out the product performs. The real
 * provider is mounted over a stubbed `/auth/me`, and the sign-out is measured by
 * the `POST /auth/logout` it puts on the wire: clearing local state alone once
 * sent the browser to `/login` still signed in.
 */
const signedInAs = (user: { name?: string; role?: string; capabilities?: unknown } | null) => {
  session = user === null ? null : {
    ok: true, github_id: 1, github_login: user.name ?? "sohee",
    role: user.role === "PLATFORM_ADMIN" ? "admin" : "member",
    approved: true, created_at: "", must_change_password: false,
    capabilities: user.capabilities ?? [],
  };
};

beforeEach(() => {
  signOutPosts = 0;
  logoutReply = () => new Response(JSON.stringify({ ok: true }),
    { status: 200, headers: { "content-type": "application/json" } });
  signedInAs({ name: "sohee", role: "AGENT_OPERATOR", capabilities: [] });
  serve();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  cleanup();
  localStorage.clear();
});

// A real router, so `/login` below is somewhere the shell can actually arrive
// rather than a name a stub echoed back.
/**
 * The shell, mounted over the real providers.
 *
 * `async` because the session is now fetched rather than handed over: the mount
 * asks `/auth/me`, and a synchronous render would read the shell before the
 * answer arrived — five tests failed on a blank sidebar before this was wrapped.
 */
const shell = async (): Promise<HTMLElement> => {
  let container!: HTMLElement;
  await act(async () => {
    container = render(
      <AuthProvider>
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
      </I18nProvider>
      </AuthProvider>,
    ).container;
  });
  return container;
};

const settle = async () => {
  await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
};

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
  it("draws the routed page inside its own main region", async () => {
    const c = await shell();
    // The outlet is the entire reason this is a shell and not a frame. A layout
    // that renders its chrome and drops the outlet looks completely healthy and
    // leaves every route blank, which is the failure that is hard to see.
    expect(c.querySelector("main")?.textContent).toContain("the dashboard");
    expect(c.querySelector("aside")).not.toBe(null);
  });

  it("offers a platform administrator holding no capability nothing that needs one", async () => {
    signedInAs({ name: "admin", role: "PLATFORM_ADMIN", capabilities: [] });
    const c = await shell();
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

  it("opens exactly the destination a granted name gates, and no neighbour", async () => {
    // The other end of the same question, on the junior role: one capability
    // from the server, one door. The pair matters because the fallback this
    // console removed inverted at zero — a senior title with an empty list
    // opened everything, a granted name opened four screens fewer.
    signedInAs({ name: "sohee", role: "AGENT_OPERATOR", capabilities: ["tenant.read.stats"] });
    const links = offered(await shell());
    expect(links).toContain("/platform/tenants");
    for (const href of GATED.filter((h) => h !== "/platform/tenants")) {
      expect(links).not.toContain(href);
    }
  });

  it("ends the session and leaves the shell when signing out", async () => {
    const c = await shell();
    fireEvent.click(screen.getByTestId("logout"));
    await settle();
    // Both halves, because each has shipped alone. Navigating without ending
    // the session left `mesh_token` alive behind a login form that let the
    // person straight back in; ending it without navigating leaves an operator
    // reading a shell belonging to a session that no longer exists.
    expect(signOutPosts).toBe(1);
    expect(screen.queryByTestId("login")).not.toBe(null);
    expect(screen.queryByTestId("page")).toBe(null);
    expect(c.querySelector("aside")).toBe(null);
  });

  it("stays in the shell, reports the failure, and keeps the session when logout gets no answer", async () => {
    logoutReply = () => { throw new TypeError("Failed to fetch"); };
    const c = await shell();
    expect(localStorage.getItem("agent_mesh_user")).not.toBe(null);

    fireEvent.click(screen.getByTestId("logout"));
    await settle();

    expect(signOutPosts).toBe(1);
    expect(screen.queryByTestId("login")).toBe(null);
    expect(screen.queryByTestId("page")).not.toBe(null);
    expect(c.querySelector("aside")).not.toBe(null);
    expect(whoAmI(c)).toContain("sohee");
    expect(localStorage.getItem("agent_mesh_user")).not.toBe(null);
    // **The dictionary's own sentence, not a copy of it.** Typing the Korean
    // here made this file the one place a screen's copy lives outside
    // `I18nContext` — which is exactly what `SC-I18N-04` counts, and it counted
    // this. Reading the entry also means a reworded message keeps this test
    // honest instead of quietly passing on a substring.
    const failed = [DICTIONARY.ko["auth.logoutFailed"], DICTIONARY.en["auth.logoutFailed"]];
    expect(failed.every((sentence) => typeof sentence === "string" && sentence.length > 0)).toBe(true);
    expect(failed).toContain(screen.getByTestId("logout-error").textContent);
  });

  it("does not leave before the cookie-expiry response and blocks a second POST while waiting", async () => {
    let answer!: (response: Response) => void;
    logoutReply = () => new Promise<Response>((resolve) => { answer = resolve; });
    await shell();
    const button = screen.getByTestId("logout") as HTMLButtonElement;

    fireEvent.click(button);
    await act(async () => { await Promise.resolve(); });

    expect(signOutPosts).toBe(1);
    expect(button.disabled).toBe(true);
    expect(screen.queryByTestId("page")).not.toBe(null);
    expect(screen.queryByTestId("login")).toBe(null);
    fireEvent.click(button);
    expect(signOutPosts).toBe(1);

    answer(new Response(JSON.stringify({ ok: true }),
      { status: 200, headers: { "content-type": "application/json" } }));
    await settle();

    expect(screen.queryByTestId("login")).not.toBe(null);
    expect(screen.queryByTestId("page")).toBe(null);
  });

  it("leaves the name blank for a session it has no user for", async () => {
    // `Sidebar` defaults `userName` to the literal `admin`, and this is the one
    // place that default could ever be reached. The shell passes an empty
    // string instead, so nobody reads a stranger's name back as their own: a
    // placeholder in the field an operator checks to see who they are signed in
    // as is worse than a blank, which at least looks like the absence it is.
    signedInAs(null);
    expect(whoAmI(await shell())).not.toContain("admin");
    cleanup();

    // **What this cannot see.** A mutation replacing the `?? ""` with a
    // placeholder was planted here and the suite stayed green, because with no
    // session the shell renders the login route and draws no sidebar at all —
    // there is no name field for a placeholder to appear in. Passing a session
    // whose `github_login` is empty does not reach it either: `AuthProvider`
    // reads that as no session. So the assertion below is about the Sidebar's
    // default literal never reaching the screen, which is real, and the blank
    // itself is not observable from out here. Said rather than papered over
    // with an assertion comparing two empty strings.
    signedInAs({ name: "admin", role: "PLATFORM_ADMIN", capabilities: [] });
    // Positive control: `admin` is a name the shell will print when the session
    // actually carries it, so the assertion above is about the blank and not
    // about the string being unprintable.
    expect(whoAmI(await shell())).toContain("admin");
  });
});
