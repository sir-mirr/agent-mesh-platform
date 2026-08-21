/**
 * The gate, and the four things it can say about a sign-in.
 *
 * This screen is the one page a signed-out browser can reach, so it is also the
 * only page reachable when the backend behind it is down — and the two look
 * identical to anyone who is only reading the form. The distinction this
 * console keeps re-learning:
 *
 *     loading      the credential is out and nothing has come back
 *     refused      the server answered, and said no
 *     unreachable  there was no answer to read
 *     empty        the server answered 200 and named nobody
 *
 * `AuthContext` already pays for collapsing two of them: nginx in front of a
 * real build answered `502` while the backend restarted, `/auth/me` was read as
 * a signed-out session, all thirteen screens became this form — and this form
 * posts through the same proxy, so signing in did nothing. `ApiError.refused`
 * is 4xx and nothing else, which is what makes `502` and `401` different
 * sentences here. Every test below asserts both halves: which sentence the box
 * draws, and which of the others it does **not**.
 *
 * The page's own comments name two more failures it has already had, and both
 * are pinned:
 *
 *   - the fields came up as `useState("admin")` beside a role picker, so the
 *     working credential for the platform administrator was printed on the
 *     login screen of a real deployment;
 *   - the rejection escaped `handleSubmit`, `navigate` never ran, and the form
 *     sat there having said nothing at all.
 *
 * ## Why the real providers, and `fetch` at the bottom
 *
 * `AuthContext` and `I18nContext` each have their own test file that imports
 * the real module at top level, and `mock.module` is installed on the process —
 * a fake put in here would be handed to them. So the seam is `fetch`, answered
 * from a per-path map, which is also the only way to have `/auth/local` refuse
 * while `/auth/me` is doing something else.
 *
 * `MemoryRouter` is real for the same reason: a stubbed `react-router-dom`
 * leaks into every file that loads after this one. `/dashboard` is a marker
 * element, so "the console opened" is a fact about the router rather than about
 * a spy — which is what makes an un-awaited `loginWithLocal` visible.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Registered once for the process and never unregistered: bun runs every test
// file's top level before it runs any test, so a register/unregister pair swaps
// the document out from under whichever file is still using it.
if (!(globalThis as { document?: unknown }).document) GlobalRegistrator.register();

// `await import`, never a static import: a static one is hoisted above the
// registration and would load React's DOM entry into a process with no document.
const { render, screen, cleanup, fireEvent, act } = await import("@testing-library/react");
const { MemoryRouter, Routes, Route } = await import("react-router-dom");
const { AuthProvider } = await import("@/contexts/AuthContext.tsx");
const { I18nProvider, DICTIONARY } = await import("@/contexts/I18nContext.tsx");
const { LoginPage } = await import("./LoginPage.tsx");

const ME = "/auth/me";
const LOCAL = "/auth/local";
const LANG_KEY = "agent_mesh_lang";

/**
 * The word this screen would draw, or a failure naming the key.
 *
 * `DICTIONARY.en[key]!` on a key that has been renamed is `undefined`, and an
 * assertion comparing against it either passes vacuously or fails somewhere
 * that does not say why. This names the key that went missing.
 */
const en = (key: string): string => {
  const word = DICTIONARY.en[key];
  if (word === undefined) throw new Error(`the dictionary has no English for ${key}`);
  return word;
};
/** The same, in the other language the switcher offers. */
const ko = (key: string): string => {
  const word = DICTIONARY.ko[key];
  if (word === undefined) throw new Error(`the dictionary has no Korean for ${key}`);
  return word;
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The server answered, and said no. `refused` is true for these and only these. */
const refuses = (status: number, body: unknown) => () => json(status, body);
/** The server failed rather than refusing — a proxy in front of a restarting backend. */
const proxyBroke = (status: number, text: string) => () => json(status, { error: text });
/** No answer at all: offline, DNS, connection refused. Not a status. */
const noAnswer = (): Response => { throw new TypeError("Failed to fetch"); };
/** Asked, and still out — the window between the click and the verdict. */
const stillOut = (): Promise<Response> => new Promise<Response>(() => {});
const answers = (body: unknown) => () => json(200, body);

/** Nobody is signed in, which is the real state of a browser on this page. */
const NO_SESSION = refuses(401, { error: "unauthenticated" });
/** What `/auth/me` answers once the credential was accepted. */
const SESSION = {
  github_id: 7,
  github_login: "operator-1",
  role: "member",
  approved: true,
  tenant: "tenant_default",
  capabilities: [],
  created_at: "2026-01-01T00:00:00Z",
};
/** What `POST /auth/local` answers: `{ok, user}` and nothing else. */
const ACCEPTED = answers({
  ok: true,
  user: { github_id: 7, github_login: "operator-1", role: "member", capabilities: [] },
});

type Answer = Response | Promise<Response>;
type Route = [path: string, make: () => Answer];

const realFetch = globalThis.fetch;
/** bun:test has no global stubber, so the original goes back by hand in
 *  `afterEach`; a forgotten restore poisons every file that runs after this. */
const stub = (fn: unknown) => { globalThis.fetch = fn as typeof globalThis.fetch; };

const calls: Array<{ url: string; body: string }> = [];
let routes: Route[] = [];
const posted = (path: string) => calls.filter((c) => c.url.endsWith(path));

beforeEach(() => {
  calls.length = 0;
  // happy-dom's storage belongs to the process, not to this file. A remembered
  // session would sign the browser in behind the form, and `agent_mesh_lang`
  // decides which language every assertion below is written in.
  localStorage.clear();
  routes = [];
  stub(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: typeof init?.body === "string" ? init.body : "" });
    for (const [path, make] of routes) if (url.endsWith(path)) return make();
    // Anything a scenario did not name answers an empty body, so a route left
    // out cannot masquerade as a refusal or as an outage.
    return json(200, { ok: true });
  });
});

afterEach(() => { cleanup(); localStorage.clear(); globalThis.fetch = realFetch; });
afterAll(() => { localStorage.clear(); globalThis.fetch = realFetch; });

const settle = async () => {
  // A sign-in is `fetch` then `.json()` on `/auth/local`, then the same again
  // on `/auth/me` inside `loginWithLocal`, and the state writes land in later
  // turns still. One microtask drain has not finished that.
  for (let turn = 0; turn < 3; turn++) {
    await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
  }
};

const mount = async () => {
  render(
    <MemoryRouter initialEntries={["/login"]}>
      <I18nProvider>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            {/* The console, reduced to the one fact worth asserting about it:
                that the router got here. Nothing else on this page can put it
                on screen. */}
            <Route path="/dashboard" element={<div data-testid="console-opened" />} />
          </Routes>
        </AuthProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
  await settle();
};

const field = (autocomplete: string): HTMLInputElement => {
  const input = document.querySelector(`input[autocomplete="${autocomplete}"]`);
  if (!input) throw new Error(`the form has no ${autocomplete} field`);
  return input as HTMLInputElement;
};

/** Type a credential and press the button, exactly as an operator would. */
const signIn = async (user: string, pass: string) => {
  fireEvent.change(field("username"), { target: { value: user } });
  fireEvent.change(field("current-password"), { target: { value: pass } });
  const form = document.querySelector("form");
  if (!form) throw new Error("the page draws no sign-in form");
  fireEvent.submit(form);
  await settle();
};

/** Everything the page says about the last attempt, or `null` when it says nothing. */
const verdict = (): string | null => screen.queryByTestId("login-error")?.textContent ?? null;
/** The request that has left but has no verdict yet, or `null`. */
const pending = (): string | null => screen.queryByTestId("login-pending")?.textContent ?? null;
const submitButton = (): HTMLButtonElement => screen.getByTestId("login-submit") as HTMLButtonElement;
const consoleOpened = (): boolean => screen.queryByTestId("console-opened") !== null;
const stillOnTheForm = (): boolean => document.querySelector("form") !== null;
const bodyText = (): string => document.body.textContent ?? "";

describe("the credential the form comes up with", () => {
  it("has typed nothing into either field on the operator's behalf", async () => {
    routes = [[ME, NO_SESSION]];
    await mount();
    // These arrived as `useState("admin")`. The form came up with a working
    // credential already in it and one click signed whoever reached the page in
    // as the platform administrator — on a deployment that is the account name
    // and the password printed on the login screen.
    expect(field("username").value).toBe("");
    expect(field("current-password").value).toBe("");
    // The other half of the same change: a picker that let the visitor declare
    // which role they were signing in as. It granted nothing, and the sidebar
    // drew the choice as the person's title anyway.
    expect(document.querySelectorAll("select").length).toBe(0);
    // And the password is masked. A `type="text"` here is the credential
    // readable over the shoulder of anyone signing in to a real server.
    expect(field("current-password").type).toBe("password");
    // A signed-out session is the resting form, not an attempt already running.
    expect(pending()).toBe(null);
    expect(verdict()).toBe(null);
    expect(submitButton().disabled).toBe(false);
    expect(submitButton().getAttribute("aria-busy")).toBe("false");
  });

  it("sends what was typed rather than a credential of its own", async () => {
    routes = [[ME, NO_SESSION], [LOCAL, refuses(401, { error: "invalid username or password" })]];
    await mount();
    await signIn("operator-1", "hunter2");
    // Reading the state back off the inputs would pass on a form whose values
    // never reach the request. This is the wire: the username in the body is
    // the one the person typed, and nothing else.
    const sent = posted(LOCAL);
    expect(sent.length).toBe(1);
    expect(new URLSearchParams(sent[0]!.body).get("username")).toBe("operator-1");
    expect(new URLSearchParams(sent[0]!.body).get("password")).toBe("hunter2");
  });
});

describe("a refused credential and an unreachable backend are different sentences", () => {
  it("repeats what the server said when the server refused the credential", async () => {
    routes = [[ME, NO_SESSION], [LOCAL, refuses(401, { error: "invalid username or password" })]];
    await mount();
    await signIn("operator-1", "wrong");
    // The server answered. Telling this person the backend is down sends them
    // to check a healthy network for a password they simply mistyped.
    expect(verdict()).toBe("invalid username or password");
    expect(pending()).toBe(null);
    expect(bodyText()).not.toContain(en("login.unreachable"));
    // And a refused credential is not a session: the console stays shut.
    expect(consoleOpened()).toBe(false);
    expect(stillOnTheForm()).toBe(true);
  });

  it("calls a 403 an answer too, because the server did answer", async () => {
    routes = [[ME, NO_SESSION], [LOCAL, refuses(403, { error: "this account is not approved" })]];
    await mount();
    await signIn("operator-1", "pw");
    // `refused` is the whole 4xx range, not `401`. A classifier written as
    // `status === 401` passes the test above and tells this person the network
    // is broken about an account decision the server has already made.
    expect(verdict()).toBe("this account is not approved");
    expect(bodyText()).not.toContain(en("login.unreachable"));
    expect(consoleOpened()).toBe(false);
  });

  it("does not read a broken proxy as a wrong password", async () => {
    routes = [[ME, NO_SESSION], [LOCAL, proxyBroke(502, "Bad Gateway")]];
    await mount();
    await signIn("operator-1", "correct-horse");
    // The measured defect one layer over, at the door instead of at `/auth/me`:
    // nginx answered `502` while the backend restarted. A person told their
    // password is wrong retypes it; a person told the server is not answering
    // waits, which is the only one of the two that ends.
    expect(verdict()).toBe(en("login.unreachable"));
    expect(pending()).toBe(null);
    // `toBe` above is the check — this names what the wrong branch would have
    // shown, which is a proxy's word for its own failure read as a verdict on
    // a credential the backend never saw.
    expect(bodyText()).not.toContain("Bad Gateway");
    expect(consoleOpened()).toBe(false);
  });

  it("does not read a gateway timeout as one either", async () => {
    routes = [[ME, NO_SESSION], [LOCAL, proxyBroke(504, "Gateway Timeout")]];
    await mount();
    await signIn("operator-1", "correct-horse");
    // `504` is the same reading as `502` and a different one from `401`; a check
    // written as `status === 502` passes the test above and fails here.
    expect(verdict()).toBe(en("login.unreachable"));
    expect(bodyText()).not.toContain("Gateway Timeout");
  });

  it("says the same when there was no answer at all", async () => {
    routes = [[ME, NO_SESSION], [LOCAL, noAnswer]];
    await mount();
    await signIn("operator-1", "correct-horse");
    // `apiClient` reports this as `status: null`, which is not zero and not a
    // 4xx — anything treating a missing status as falsy lands on "refused".
    expect(verdict()).toBe(en("login.unreachable"));
    // And the sentence is the dictionary's, not the exception's. `toBe` above
    // already forbids it; this says what "it" is — a `fetch` internal shown to
    // an operator, in English on a Korean screen and untranslatable either way.
    expect(bodyText()).not.toContain("Failed to fetch");
    expect(consoleOpened()).toBe(false);
  });

  it("draws the failure in the language the page is being read in", async () => {
    routes = [[ME, NO_SESSION], [LOCAL, noAnswer]];
    await mount();
    await signIn("operator-1", "pw");
    // The page passes a Korean fallback to `t("login.unreachable", …)`, and a
    // fallback is what shows when the key is missing. In English mode the two
    // differ, so this is where a dictionary that lost the key would surface —
    // as the one sentence on the screen the reader cannot read.
    expect(verdict()).toBe(en("login.unreachable"));
    expect(verdict()).not.toBe(ko("login.unreachable"));
  });
});

describe("what the page says before the server has said anything", () => {
  it("shows an in-flight credential as pending in its own place", async () => {
    routes = [[ME, NO_SESSION], [LOCAL, stillOut]];
    await mount();
    await signIn("operator-1", "pw");
    // The request left and has not come back. Neither of the other two
    // sentences is true yet, and there is a third mistake available here that
    // is worse than both: an un-awaited `loginWithLocal` runs `navigate` on the
    // spot, and the console opens on a credential nobody has checked.
    expect(posted(LOCAL).length).toBe(1);
    expect(consoleOpened()).toBe(false);
    expect(verdict()).toBe(null);
    expect(pending()).toBe(en("login.pending"));
    expect(submitButton().disabled).toBe(true);
    expect(submitButton().getAttribute("aria-busy")).toBe("true");
    expect(bodyText()).not.toContain(en("login.unreachable"));
    expect(bodyText()).not.toContain(en("login.failed"));
    expect(stillOnTheForm()).toBe(true);

    // A second submit event while the first request is pending does not put a
    // second credential on the wire. The disabled button covers pointer input;
    // the handler guard covers submit events produced another way.
    fireEvent.submit(document.querySelector("form")!);
    await settle();
    expect(posted(LOCAL).length).toBe(1);
  });

  it("takes the last attempt's verdict down when the next one goes out", async () => {
    routes = [[ME, NO_SESSION], [LOCAL, refuses(401, { error: "invalid username or password" })]];
    await mount();
    await signIn("operator-1", "wrong");
    // The precondition the absence below is measured against. Without it, a
    // page that never draws a verdict at all reads exactly like one that
    // cleared it.
    expect(verdict()).toBe("invalid username or password");

    routes = [[ME, NO_SESSION], [LOCAL, stillOut]];
    await signIn("operator-1", "the-right-one");
    // A stale refusal standing over a request that is still out tells the
    // person their new password is wrong before the server has read it — and
    // they are being told it about the attempt they can see failing.
    expect(posted(LOCAL).length).toBe(2);
    expect(verdict()).toBe(null);
    expect(pending()).toBe(en("login.pending"));
    expect(consoleOpened()).toBe(false);
  });
});

describe("an answer that carried no session", () => {
  it("does not open the console on a 200 that named nobody", async () => {
    routes = [[ME, NO_SESSION], [LOCAL, answers({ ok: true })]];
    await mount();
    await signIn("operator-1", "pw");
    // A gateway that answers `200` with a body that is not a session — an SSO
    // shim, a cached page, a route that moved. Nothing here proved an identity,
    // so nothing may open, and this is the failure mode that would open it
    // silently: the answer was not an error.
    expect(consoleOpened()).toBe(false);
    // The recorded defect on this screen: the throw left through `handleSubmit`,
    // `navigate` never ran, and the form sat there having said nothing. On a
    // deployment this is the only page reachable, and pressing the button on it
    // did nothing at all.
    expect(verdict()).not.toBe(null);
    expect(pending()).toBe(null);
    // The server did answer. "Cannot reach the backend" would send an operator
    // to look at a network that is working.
    expect(verdict()).not.toBe(en("login.unreachable"));
  });
});

describe("a credential the server accepted", () => {
  it("opens the console on the answer, having asked exactly once", async () => {
    // `/auth/me` refuses until the credential is accepted, which is the order a
    // real browser sees it in: the page mounts signed out, and the session
    // exists only after `POST /auth/local`.
    let signedIn = false;
    routes = [
      [ME, () => (signedIn ? json(200, SESSION) : json(401, { error: "unauthenticated" }))],
      [LOCAL, () => { signedIn = true; return ACCEPTED(); }],
    ];
    await mount();
    await signIn("operator-1", "correct-horse");
    expect(consoleOpened()).toBe(true);
    // One credential was checked, once. Whether the browser then remembers the
    // session is `AuthContext`'s contract and is asserted in its own file; what
    // belongs here is that this screen asked once and stopped.
    expect(posted(LOCAL).length).toBe(1);
    // **No `expect(verdict()).toBe(null)` here.** It reads like the other half
    // of the check and is worth nothing: the navigation unmounted this page, so
    // the box it asks about cannot exist whatever the page did with it. A
    // mutation setting an error on the success path leaves it green. The
    // sentence-beside-a-success case is caught where the page is still on
    // screen — by the clearing test above.
  });
});

describe("the ambient network behind the form", () => {
  it("runs the product-defined canvas frame and cancels it when the page leaves", async () => {
    routes = [[ME, NO_SESSION]];

    const canvasPrototype = HTMLCanvasElement.prototype;
    const getContextDescriptor = Object.getOwnPropertyDescriptor(canvasPrototype, "getContext");
    const realRequestAnimationFrame = globalThis.requestAnimationFrame;
    const realCancelAnimationFrame = globalThis.cancelAnimationFrame;
    const frames: FrameRequestCallback[] = [];
    const cancelled: number[] = [];
    const draws = { clear: 0, line: 0, arc: 0, fill: 0, stroke: 0 };

    const context = {
      clearRect: () => { draws.clear += 1; },
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => { draws.line += 1; },
      closePath: () => {},
      fill: () => { draws.fill += 1; },
      save: () => {},
      setLineDash: () => {},
      stroke: () => { draws.stroke += 1; },
      restore: () => {},
      arc: () => { draws.arc += 1; },
      fillStyle: "",
      strokeStyle: "",
      globalAlpha: 1,
      lineWidth: 1,
      lineDashOffset: 0,
      shadowColor: "",
      shadowBlur: 0,
    } as unknown as CanvasRenderingContext2D;

    Object.defineProperty(canvasPrototype, "getContext", {
      configurable: true,
      value: () => context,
    });
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = (id: number) => { cancelled.push(id); };

    try {
      await mount();
      const first = frames.shift();
      if (!first) throw new Error("the login ambient canvas did not schedule its first frame");
      await act(async () => { first(performance.now() + 16); });

      // The second frame takes the already-sized-canvas branch. Together the
      // two frames exercise the moving nodes, both edge styles, packets, and
      // the connected and isolated dot styles declared by the product data.
      const second = frames.shift();
      if (!second) throw new Error("the login ambient canvas did not continue its animation");
      await act(async () => { second(performance.now() + 32); });

      if (draws.clear < 2 || draws.line === 0 || draws.arc === 0 || draws.fill === 0 || draws.stroke === 0) {
        throw new Error("the login ambient canvas did not draw its product-defined network");
      }

      cleanup();
      expect(cancelled.length).toBeGreaterThan(0);
    } finally {
      cleanup();
      if (getContextDescriptor) {
        Object.defineProperty(canvasPrototype, "getContext", getContextDescriptor);
      }
      globalThis.requestAnimationFrame = realRequestAnimationFrame;
      globalThis.cancelAnimationFrame = realCancelAnimationFrame;
    }
  });
});

describe("the switcher, which is the only control here that is not the form", () => {
  it("comes up in English and redraws the page in the language chosen", async () => {
    routes = [[ME, NO_SESSION]];
    await mount();
    const trigger = screen.getByTestId("lang-trigger");
    // The sidebar holds this control everywhere else, and the sidebar is behind
    // the login — so a visitor who cannot read this form could not otherwise
    // reach the thing that would translate it.
    expect(bodyText()).toContain(en("login.subtitle"));
    expect(trigger.getAttribute("aria-label")).toBe(en("login.lang.aria"));

    fireEvent.click(trigger);
    const other = document.querySelector('[data-lang="ko"]');
    if (!other) throw new Error("the switcher offers no second language");
    fireEvent.click(other);

    // The whole page, not the trigger: a switcher that only relabels itself is
    // the same screen the visitor already could not read.
    expect(bodyText()).toContain(ko("login.subtitle"));
    expect(bodyText()).not.toContain(en("login.subtitle"));
    // And the aria label names the language now in force, rather than a
    // constant — it is what a screen reader announces the control as.
    expect(screen.getByTestId("lang-trigger").getAttribute("aria-label")).toBe(ko("login.lang.aria"));
    // Remembered, or the next page load is the unreadable one again.
    expect(localStorage.getItem(LANG_KEY)).toBe("ko");
  });
});

describe("the GitHub button", () => {
  it("hands off to the server without sending the form's credential", async () => {
    routes = [[ME, NO_SESSION]];
    await mount();
    fireEvent.change(field("username"), { target: { value: "operator-1" } });
    fireEvent.change(field("current-password"), { target: { value: "hunter2" } });
    const github = [...document.querySelectorAll("button")]
      .find((b) => (b.textContent ?? "").includes(en("login.github")));
    if (!github) throw new Error("the page offers no GitHub sign-in");
    fireEvent.click(github);
    await settle();
    // The OAuth handshake belongs to the server, and the password typed into
    // the form beside it is not part of it. A button wired to `loginWithLocal`
    // would send a credential the person did not choose to send with it.
    expect(posted(LOCAL).length).toBe(0);
    // And the handshake is a navigation the browser makes, not a request this
    // page makes: `/auth/github` answers with a redirect to GitHub, which only
    // a top-level navigation can follow. Asked with `fetch` it does nothing an
    // operator can complete, and the button would appear simply not to work.
    expect(calls.map((c) => c.url).some((url) => url.endsWith("/auth/github"))).toBe(false);
    // **Nothing is asserted about the page here.** The click leaves this
    // screen, so every "it does not say" about the login form is answered by
    // the form being gone rather than by anything the page decided. What that
    // navigation is, and why it is wrong, is in the notes returned with this
    // file — it is a defect of the page, not a property to pin green.
  });
});
