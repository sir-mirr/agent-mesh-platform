/**
 * The one screen a locked session can reach, and the four things it can say
 * about the change it just tried.
 *
 * While `must_change_password` is set the server answers `403` to every other
 * route, so this page is not a polite suggestion — it is the whole console for
 * that session, and the only place the person can be told anything at all. The
 * distinction this repository keeps re-finding:
 *
 *     loading      the change is out and nothing has come back
 *     refused      the server answered, and said no
 *     unreachable  there was no answer to read
 *     nothing asked  the browser stopped it here; the server never saw it
 *
 * The fourth is this screen's version of "the server said nothing is there":
 * the confirmation mismatch is decided in the browser, and an idle form has no
 * verdict to draw. What makes it worth pinning is what a wrong answer costs
 * here — a `next` sent while the person is told the change failed is the
 * account's new password, known to nobody.
 *
 * `ApiError.refused` is 4xx and nothing else, which is what makes `502` and
 * `403` different sentences: the page reads `err instanceof ApiError &&
 * !err.refused`, the same split `failureKind()` makes, rather than matching on
 * the message. Every test below asserts both halves — which sentence the box
 * draws, and which of the others it does **not**.
 *
 * ## Why the real providers, and `fetch` at the bottom
 *
 * `AuthContext` and `I18nContext` each have their own test file that imports
 * the real module at top level, and `mock.module` is installed on the process —
 * a fake put in here would be handed to them instead. So the seam is `fetch`,
 * answered from a per-path map, which is also the only way to have
 * `/auth/local/password` refuse while `/auth/me` is doing something else.
 *
 * `MemoryRouter` is real for the same reason: a stubbed `react-router-dom`
 * leaks into every file that loads after this one. `/dashboard` and `/login`
 * are marker elements, so "the console opened" and "the session ended" are
 * facts about the router rather than about a spy.
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
const { ChangePasswordPage } = await import("./ChangePasswordPage.tsx");

const ME = "/auth/me";
const CHANGE = "/auth/local/password";
const LOGOUT = "/auth/logout";
const LANG_KEY = "agent_mesh_lang";
const SESSION_KEY = "agent_mesh_user";

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
/** The same, in the other language the console is read in. */
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
/** Asked, and still out — the window between the press and the verdict. */
const stillOut = (): Promise<Response> => new Promise<Response>(() => {});
const answers = (body: unknown) => () => json(200, body);

/** What `/auth/me` answers for the account this screen exists for. */
const LOCKED = {
  github_id: 7,
  github_login: "operator-1",
  role: "member",
  approved: true,
  tenant: "tenant_default",
  capabilities: [],
  created_at: "2026-01-01T00:00:00Z",
  must_change_password: true,
};
const LOCKED_SESSION = answers(LOCKED);
/** The same account after the server accepted a password. */
const FREE_SESSION = answers({ ...LOCKED, must_change_password: false });
/** What `POST /auth/local/password` answers when it worked. */
const ACCEPTED = answers({ ok: true, must_change_password: false });

type Answer = Response | Promise<Response>;
type Wire = [path: string, make: () => Answer];

const realFetch = globalThis.fetch;
/** bun:test has no global stubber, so the original goes back by hand in
 *  `afterEach`; a forgotten restore poisons every file that runs after this. */
const stub = (fn: unknown) => { globalThis.fetch = fn as typeof globalThis.fetch; };

const calls: Array<{ url: string; method: string; body: string }> = [];
let wires: Wire[] = [];
const sentTo = (path: string) => calls.filter((c) => c.url.endsWith(path));

beforeEach(() => {
  calls.length = 0;
  // happy-dom's storage belongs to the process, not to this file. A remembered
  // session would put a different user behind the form, and `agent_mesh_lang`
  // decides which language every assertion below is written in.
  localStorage.clear();
  wires = [];
  stub(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: typeof init?.method === "string" ? init.method : "GET",
      body: typeof init?.body === "string" ? init.body : "",
    });
    for (const [path, make] of wires) if (url.endsWith(path)) return make();
    // Anything a scenario did not name answers an empty body, so a route left
    // out cannot masquerade as a refusal or as an outage.
    return json(200, { ok: true });
  });
});

afterEach(() => { cleanup(); localStorage.clear(); globalThis.fetch = realFetch; });
afterAll(() => { localStorage.clear(); globalThis.fetch = realFetch; });

const settle = async () => {
  // A change is `fetch` then `.json()` on `/auth/local/password`, then the same
  // again on `/auth/me` inside `refreshSession`, and the navigation lands in a
  // later turn still. One microtask drain has not finished that.
  for (let turn = 0; turn < 3; turn++) {
    await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
  }
};

const mount = async () => {
  render(
    <MemoryRouter initialEntries={["/change-password"]}>
      <I18nProvider>
        <AuthProvider>
          <Routes>
            <Route path="/change-password" element={<ChangePasswordPage />} />
            {/* The console and the door, reduced to the one fact worth
                asserting about either: that the router got there. Nothing else
                on this page can put them on screen. */}
            <Route path="/dashboard" element={<div data-testid="console-opened" />} />
            <Route path="/login" element={<div data-testid="signed-out" />} />
          </Routes>
        </AuthProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
  await settle();
};

/**
 * The input a label introduces.
 *
 * Read through the label rather than by position, because the position is not
 * the claim: what has to be true is that the value typed under *this* sentence
 * is the one that leaves in *that* field of the request.
 */
const fieldLabelled = (text: string): HTMLInputElement => {
  const label = [...document.querySelectorAll("label")].find((l) => l.textContent === text);
  const input = label?.parentElement?.querySelector("input");
  if (!input) throw new Error(`the form has no field labelled ${text}`);
  return input as HTMLInputElement;
};
/** The same, named by dictionary key, on a page being read in English. */
const field = (key: string): HTMLInputElement => fieldLabelled(en(key));

const fillLabelled = (say: (key: string) => string) =>
  (current: string, next: string, confirm: string) => {
    fireEvent.change(fieldLabelled(say("pwchg.current")), { target: { value: current } });
    fireEvent.change(fieldLabelled(say("pwchg.next")), { target: { value: next } });
    fireEvent.change(fieldLabelled(say("pwchg.confirm")), { target: { value: confirm } });
  };
const fill = fillLabelled(en);

const submitControl = (): HTMLButtonElement => {
  const button = document.querySelector('button[type="submit"]');
  if (!button) throw new Error("the form has no submit control");
  return button as HTMLButtonElement;
};

/** Press the button, exactly as an operator would, and let the answer land. */
const press = async () => {
  fireEvent.click(submitControl());
  await settle();
};

const change = async (current: string, next: string, confirm: string) => {
  fill(current, next, confirm);
  await press();
};

/** Everything the page says about the last attempt, or `null` when it says nothing. */
const verdict = (): string | null => screen.queryByTestId("change-password-error")?.textContent ?? null;
const consoleOpened = (): boolean => screen.queryByTestId("console-opened") !== null;
const signedOut = (): boolean => screen.queryByTestId("signed-out") !== null;
const stillOnTheForm = (): boolean => screen.queryByTestId("change-password") !== null;
const bodyText = (): string => document.body.textContent ?? "";

describe("the form a locked session is given", () => {
  it("asks for the current password again, masked, with nothing typed in on the person's behalf", async () => {
    wires = [[ME, LOCKED_SESSION]];
    await mount();
    // The cookie is already good enough to reach this page — that is the whole
    // point of the flag. Asking for `current` again is what keeps an unattended
    // screen from being enough to take the account, so the field existing is
    // the check, not a detail of the layout.
    expect(field("pwchg.current").value).toBe("");
    expect(field("pwchg.next").value).toBe("");
    expect(field("pwchg.confirm").value).toBe("");
    // All three masked. A `type="text"` here is a credential readable over the
    // shoulder of anyone at a shared console — and this screen is reached by
    // accounts still holding the password the deployment printed.
    expect(field("pwchg.current").type).toBe("password");
    expect(field("pwchg.next").type).toBe("password");
    expect(field("pwchg.confirm").type).toBe("password");
    // Three fields and no fourth: anything else collecting input on this form
    // is not part of the change and is not asserted anywhere.
    expect(document.querySelectorAll("input").length).toBe(3);
  });

  it("says the refusal is the server's before anything has been tried", async () => {
    wires = [[ME, LOCKED_SESSION]];
    await mount();
    // Every other route answers 403 to this session, and the sidebar is not
    // drawn here. Without this sentence the person is on a screen they did not
    // ask for, with a product that has started refusing them, and no statement
    // of which of the two is happening.
    expect(bodyText()).toContain(en("pwchg.title"));
    expect(bodyText()).toContain(en("pwchg.why"));
    // Absent has to look absent: nothing has been asked yet, so there is no
    // verdict to draw and none of the three sentences below is true.
    expect(verdict()).toBe(null);
    expect(submitControl().disabled).toBe(false);
    expect(submitControl().textContent).toBe(en("pwchg.submit"));
  });
});

describe("what leaves the browser when the button is pressed", () => {
  it("sends the current password with the new one, each out of the field it was typed into", async () => {
    wires = [[ME, LOCKED_SESSION], [CHANGE, ACCEPTED]];
    await mount();
    await change("the-seeded-one", "chosen-by-the-operator", "chosen-by-the-operator");
    const sent = sentTo(CHANGE);
    expect(sent.length).toBe(1);
    expect(sent[0]!.method).toBe("POST");
    // `toEqual` on the whole body rather than two `toContain`s: both values are
    // in the request either way, and a call written `changePasswordApi(next,
    // current)` would send the new password as proof of the old one — which the
    // server rejects, leaving an operator retyping a password that was right.
    // The confirmation is not a third field on the wire; it never leaves.
    expect(JSON.parse(sent[0]!.body)).toEqual({
      current: "the-seeded-one",
      next: "chosen-by-the-operator",
    });
  });

  it("does not send a password the person has not confirmed", async () => {
    wires = [[ME, LOCKED_SESSION], [CHANGE, ACCEPTED]];
    await mount();
    await change("the-seeded-one", "chosen-by-the-operator", "chosen-by-the-oprator");
    // The worst outcome available on this screen. Sending `next` here and then
    // drawing the mismatch would set the account's password to a string the
    // person believes was rejected — nobody knows it, and the account is locked
    // out of a console that is already refusing every other route.
    expect(sentTo(CHANGE).length).toBe(0);
    expect(verdict()).toBe(en("pwchg.mismatch"));
    // The browser stopped this, so neither sentence about the server is true.
    expect(bodyText()).not.toContain(en("pwchg.unreachable"));
    expect(bodyText()).not.toContain(en("pwchg.failed"));
    expect(consoleOpened()).toBe(false);
    expect(stillOnTheForm()).toBe(true);
    // And the form is still usable: a mismatch that left the button spinning
    // would mean one typo ends the only screen the session can reach.
    expect(submitControl().disabled).toBe(false);
  });
});

describe("a refused change and an unreachable backend are different sentences", () => {
  it("repeats what the server said when the server refused the change", async () => {
    wires = [[ME, LOCKED_SESSION], [CHANGE, refuses(400, { error: "current password is incorrect" })]];
    await mount();
    await change("wrong-old-one", "chosen-by-the-operator", "chosen-by-the-operator");
    // The server answered. Telling this person the backend is down sends them
    // to check a healthy network for a password they simply mistyped, on the
    // one screen their session is allowed to open.
    expect(verdict()).toBe("current password is incorrect");
    expect(bodyText()).not.toContain(en("pwchg.unreachable"));
    // A refused change is not a change: the flag is still set on the server, so
    // opening the console here would be a dashboard of 403s.
    expect(consoleOpened()).toBe(false);
    expect(stillOnTheForm()).toBe(true);
    // `setBusy(false)` on the failing path — without it the button never comes
    // back and a single wrong old password ends the session for good.
    expect(submitControl().disabled).toBe(false);
    expect(submitControl().textContent).toBe(en("pwchg.submit"));
  });

  it("calls a 403 an answer too, because the server did answer", async () => {
    wires = [[ME, LOCKED_SESSION], [CHANGE, refuses(403, { error: "this password was used before" })]];
    await mount();
    await change("the-seeded-one", "chosen-by-the-operator", "chosen-by-the-operator");
    // `refused` is the whole 4xx range, not one status. A classifier written as
    // `status === 400` passes the test above and tells this person the network
    // is broken about a policy decision the server has already made.
    expect(verdict()).toBe("this password was used before");
    expect(bodyText()).not.toContain(en("pwchg.unreachable"));
    expect(consoleOpened()).toBe(false);
  });

  it("says the server could not be reached when there was no answer at all", async () => {
    wires = [[ME, LOCKED_SESSION], [CHANGE, noAnswer]];
    await mount();
    await change("the-seeded-one", "chosen-by-the-operator", "chosen-by-the-operator");
    // `apiClient` reports this as `status: null`, which is not zero and not a
    // 4xx — anything treating a missing status as falsy lands on "refused", and
    // the sentence a refusal draws here is about what the person typed.
    expect(verdict()).toBe(en("pwchg.unreachable"));
    // The sentence is the dictionary's, not the exception's. `toBe` above
    // already forbids it; this names what the wrong branch would have shown —
    // a `fetch` internal, in English on a Korean screen and untranslatable
    // either way.
    expect(bodyText()).not.toContain("Failed to fetch");
    expect(consoleOpened()).toBe(false);
    expect(submitControl().disabled).toBe(false);
  });

  it("does not read a broken proxy as a wrong password", async () => {
    wires = [[ME, LOCKED_SESSION], [CHANGE, proxyBroke(502, "Bad Gateway")]];
    await mount();
    await change("the-seeded-one", "chosen-by-the-operator", "chosen-by-the-operator");
    // The measured defect one layer over: nginx answered `502` while the
    // backend restarted. A person told their old password is wrong retypes it
    // — here, on the only screen they can open, against a server that never
    // saw the request.
    expect(verdict()).toBe(en("pwchg.unreachable"));
    expect(bodyText()).not.toContain("Bad Gateway");
    expect(consoleOpened()).toBe(false);
  });

  it("does not read a gateway timeout as one either", async () => {
    wires = [[ME, LOCKED_SESSION], [CHANGE, proxyBroke(504, "Gateway Timeout")]];
    await mount();
    await change("the-seeded-one", "chosen-by-the-operator", "chosen-by-the-operator");
    // `504` is the same reading as `502` and a different one from `403`; a check
    // written as `status === 502` passes the test above and fails here.
    expect(verdict()).toBe(en("pwchg.unreachable"));
    expect(bodyText()).not.toContain("Gateway Timeout");
  });

  it("draws the failure in the language the page is being read in", async () => {
    // The page passes an English fallback to `t("pwchg.unreachable", …)`, so in
    // English mode a sentence written into the component and one read from the
    // dictionary are the same string and nothing can tell them apart. Korean is
    // where that separates: a hardcoded copy, or a key the dictionary lost,
    // shows here as the one sentence on the screen the reader cannot read.
    localStorage.setItem(LANG_KEY, "ko");
    wires = [[ME, LOCKED_SESSION], [CHANGE, noAnswer]];
    await mount();
    // Found by the Korean labels, because that is what the page is drawing —
    // and a form whose labels did not follow the switch would fail here first.
    fillLabelled(ko)("the-seeded-one", "chosen-by-the-operator", "chosen-by-the-operator");
    await press();
    expect(verdict()).toBe(ko("pwchg.unreachable"));
    expect(verdict()).not.toBe(en("pwchg.unreachable"));
  });

  it("does not open the console on a 200 nobody could read", async () => {
    // A gateway that answers `200` with something that is not the route's body
    // — a captive portal, a cached page, an SSO shim. Nothing here says a
    // password was changed, and the flag is still set on the server, so the
    // console must stay shut and the form must say something rather than sit
    // there having done nothing.
    wires = [[ME, LOCKED_SESSION], [CHANGE, () => new Response("<html>not the api</html>", {
      status: 200, headers: { "content-type": "text/html" },
    })]];
    await mount();
    await change("the-seeded-one", "chosen-by-the-operator", "chosen-by-the-operator");
    expect(consoleOpened()).toBe(false);
    expect(verdict()).not.toBe(null);
    expect(stillOnTheForm()).toBe(true);
    // **What the box actually says here is not pinned.** `apiClient` parses the
    // body outside its own `try`, so this arrives as a `SyntaxError` rather
    // than an `ApiError` and the page prints the parser's message where a
    // server's refusal goes — which is neither of the two sentences it owns.
    // That is a defect of the page, reported in the notes returned with this
    // file, not a property to pin green.
  });
});

describe("what the page says before the server has said anything", () => {
  it("does not answer for the server while the change is still out", async () => {
    wires = [[ME, LOCKED_SESSION], [CHANGE, stillOut]];
    await mount();
    await change("the-seeded-one", "chosen-by-the-operator", "chosen-by-the-operator");
    // The request left and has not come back. None of the three sentences is
    // true yet, and there is a fourth mistake available that is worse than all
    // of them: an un-awaited change navigates on the spot, and the console
    // opens on a password the server has not accepted.
    expect(sentTo(CHANGE).length).toBe(1);
    expect(consoleOpened()).toBe(false);
    expect(verdict()).toBe(null);
    // The wait is said, and the control is closed while it lasts — this is what
    // stops a second press from sending a second change, and the button is the
    // only way the form can be submitted.
    expect(submitControl().textContent).toBe(en("pwchg.busy"));
    expect(submitControl().disabled).toBe(true);
  });

  it("takes the last attempt's verdict down when the next one goes out", async () => {
    wires = [[ME, LOCKED_SESSION], [CHANGE, refuses(400, { error: "current password is incorrect" })]];
    await mount();
    await change("wrong-old-one", "chosen-by-the-operator", "chosen-by-the-operator");
    // The precondition the absence below is measured against. Without it, a
    // page that never draws a verdict at all reads exactly like one that
    // cleared it.
    expect(verdict()).toBe("current password is incorrect");

    wires = [[ME, LOCKED_SESSION], [CHANGE, stillOut]];
    fill("the-right-one", "chosen-by-the-operator", "chosen-by-the-operator");
    await press();
    // A stale refusal standing over a request that is still out tells the
    // person the old password they just corrected is wrong — about the attempt
    // they can see is still running.
    expect(sentTo(CHANGE).length).toBe(2);
    expect(verdict()).toBe(null);
  });

  it("can be used again after a failure the person can do nothing about", async () => {
    wires = [[ME, LOCKED_SESSION], [CHANGE, noAnswer]];
    await mount();
    await change("the-seeded-one", "chosen-by-the-operator", "chosen-by-the-operator");
    expect(verdict()).toBe(en("pwchg.unreachable"));

    // The server comes back. A `busy` left set on the failing path would leave
    // the button closed for ever, and this session cannot open any other screen
    // to try from — the only exit left would be signing out.
    let changed = false;
    wires = [
      [ME, () => (changed ? FREE_SESSION() : LOCKED_SESSION())],
      [CHANGE, () => { changed = true; return ACCEPTED(); }],
    ];
    await press();
    expect(sentTo(CHANGE).length).toBe(2);
    expect(consoleOpened()).toBe(true);
  });
});

describe("a change the server accepted", () => {
  it("asks the server what it now says, and only then opens the console", async () => {
    let changed = false;
    wires = [
      // The flag as the server holds it: set until the change lands, cleared
      // after — which is the order a real browser sees it in.
      [ME, () => (changed ? FREE_SESSION() : LOCKED_SESSION())],
      [CHANGE, () => { changed = true; return ACCEPTED(); }],
    ];
    await mount();
    const before = calls.length;
    await change("the-seeded-one", "chosen-by-the-operator", "chosen-by-the-operator");
    // The response to the change carries `must_change_password` and the page
    // does not read it: it asks `/auth/me` again, so what the guard on every
    // other route sees is the server's answer rather than this screen's
    // assumption that its own write worked. Deleting the `refreshSession()`
    // call leaves the console opening on nothing but optimism, and that shows
    // here as the missing second request.
    const after = calls.slice(before).map((c) => c.url);
    expect(after.filter((url) => url.endsWith(CHANGE) || url.endsWith(ME)).length).toBe(2);
    expect(after[0]!.endsWith(CHANGE)).toBe(true);
    expect(after[1]!.endsWith(ME)).toBe(true);
    expect(consoleOpened()).toBe(true);
    // **No `expect(verdict()).toBe(null)` here.** It reads like the other half
    // of the check and is worth nothing: the navigation unmounted this page, so
    // the box it asks about cannot exist whatever the page did with it. The
    // sentence-beside-a-success case is caught where the page is still on
    // screen — by the clearing test above.
  });

  /*
    **The case where the server disagrees is deliberately not here.** Walked
    with `/auth/local/password` answering 200 while `/auth/me` still reports
    `must_change_password: true` — and again with the refresh itself
    unanswered — the page opens the console either way: it awaits
    `refreshSession()` and then navigates without reading what came back. A
    test asserting that would pin the defect green. It is in the notes returned
    with this file instead.
  */
});

describe("the way out", () => {
  it("signs out through the server and leaves for the login form", async () => {
    wires = [[ME, LOCKED_SESSION]];
    await mount();
    const exit = screen.getByTestId("pwchg-signout");
    // The precondition the `toBe(null)` below is a transition *from*: the
    // session is in the browser's storage before the click, so its absence
    // after is something this button did rather than something that was never
    // written.
    expect(localStorage.getItem(SESSION_KEY)).not.toBe(null);
    const before = calls.length;
    fireEvent.click(exit);
    await settle();
    // Every other route answers 403 to this session and the sidebar is not
    // drawn here, so without this control the only exit is closing the browser
    // — which on a shared machine left `mesh_token` alive and the next visitor
    // signed in as this account. The request is the only observable proof the
    // page called `logout()` at all rather than just navigating away from a
    // session that is still open.
    const out = calls.slice(before).filter((c) => c.url.endsWith(LOGOUT));
    expect(out.length).toBe(1);
    expect(out[0]!.method).toBe("POST");
    expect(signedOut()).toBe(true);
    expect(stillOnTheForm()).toBe(false);
    expect(localStorage.getItem(SESSION_KEY)).toBe(null);
  });

  it("does not change the password on the way out", async () => {
    wires = [[ME, LOCKED_SESSION], [CHANGE, ACCEPTED]];
    await mount();
    fill("the-seeded-one", "chosen-by-the-operator", "chosen-by-the-operator");
    fireEvent.click(screen.getByTestId("pwchg-signout"));
    await settle();
    // A control inside a `<form>` submits it unless it says otherwise, so
    // without `type="button"` this button sets the password to whatever is in
    // the fields and *then* signs out — the account changed by the one action
    // the person took to avoid changing it.
    expect(sentTo(CHANGE).length).toBe(0);
    expect(signedOut()).toBe(true);
    expect(consoleOpened()).toBe(false);
  });
});
