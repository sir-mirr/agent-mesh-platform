/**
 * Why there is no user, and whether the account may do anything yet.
 *
 * Two of the three things this provider hands a screen are decisions taken from
 * an exception rather than data read out of a body. `authFailure` splits *the
 * server said no* from *the server never answered* — sharing one branch signed
 * every operator out of a running deployment the moment nginx answered `502`,
 * and the login form it sent them to was behind the same proxy. `mustChangePassword`
 * splits *the server said no* from *nobody has asked yet*, and a `false`
 * invented for the second case walks a locked account into a console that
 * refuses every request.
 *
 * Neither distinction is reachable from a browser test. A Playwright page can
 * be signed out; it cannot be told which kind of not-signed-in it is looking
 * at, because that is decided by which exception `fetch` raised. So the four
 * shapes `/auth/me` can fail in are supplied here by hand.
 *
 * ## What a test here has to start from
 *
 * Most of what this provider does on a failure is *clear* something, and a
 * cleared field reads the same as one that was never set. A test that mounts
 * into an empty `localStorage` and then asserts "no user, no role, no flag" is
 * asserting the `useState` defaults: `setUser(null)`, `setAuthFailure(null)`
 * and `setMustChangePassword(null)` can each be deleted from the branch they
 * live in and the file stays green. Six assertions here were exactly that, and
 * a mutation run found them by deleting the lines they named.
 *
 * So every clearing branch below is entered from a state that contradicts it —
 * a remembered session in storage, a live session from a successful mount, a
 * flag the server already answered `true` or `false` for. The setup is the
 * test; without it the assertion is a screenshot of the defaults.
 *
 * ## No copies of the same read
 *
 * A `Probe` used to render `authFailure`, `mustChangePassword` and `user.name`
 * into three `data-testid` list items, and eight assertions read them back.
 * They discriminated nothing: `latest.value` is assigned during the same render
 * that produces those nodes, so both sides are one field of one object, and no
 * change to the provider can fail the DOM read without failing the object read
 * first. They are gone. The probe still renders — mounting a real React tree is
 * what makes `useEffect` and the state updates run at all — it just does not
 * pretend that reading its own output twice is two checks.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { registerDom } from "../register-dom";

// Registered once for the process and never unregistered: bun runs every test
// file's top level before it runs any test, so a register/unregister pair swaps
// the document out from under whichever file is still using it.
registerDom();

// `await import`, not a statement: a static import is hoisted above the
// registration above and would load React's DOM entry into a process with no
// document.
const { render, cleanup, act } = await import("@testing-library/react");
const { AuthProvider, useAuth } = await import("./AuthContext.tsx");
const { ALL_CAPABILITIES, CAPABILITY } = await import("@/types/auth.ts");
const { ApiError } = await import("@/api/client.ts");

const STORAGE_KEY = "agent_mesh_user";
const ME = "/auth/me";
const LOCAL = "/auth/local";
const LOGOUT = "/auth/logout";

// Taken from the contract rather than typed as strings: a capability name this
// mesh does not define is a failure in a fixture for the same reason it is one
// in a screen — it makes the test agree with a server that does not exist.
const META = CAPABILITY.AUDIT_READ_METADATA;
const DEPTH = CAPABILITY.MAILBOX_READ_DEPTH;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const realFetch = globalThis.fetch;
/** bun:test has no global stubber, so the original goes back by hand in
 *  `afterEach`; a forgotten restore poisons every file that runs after this one. */
const stub = (fn: unknown) => { globalThis.fetch = fn as typeof globalThis.fetch; };

type Reply = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;
const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
let reply: Reply = () => { throw new TypeError("Failed to fetch"); };

beforeEach(() => {
  calls.length = 0;
  // The provider hydrates from this key at mount, so a leftover session from
  // one test would be a signed-in user in the next one.
  localStorage.clear();
  reply = () => { throw new TypeError("Failed to fetch"); };
  stub(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return await reply(String(input), init);
  });
});

// happy-dom's `localStorage` belongs to the process, not to this file, so what
// is written here has to be taken back out of it — after each test for the
// file's own neighbours, and once at the end for every other file in the run.
afterEach(() => { cleanup(); localStorage.clear(); globalThis.fetch = realFetch; });
afterAll(() => { localStorage.clear(); globalThis.fetch = realFetch; });

/** What `/auth/me` answers for a signed-in member on this source. */
const SESSION = {
  github_id: 7,
  github_login: "operator-1",
  role: "member",
  approved: true,
  tenant: "tenant_default",
  capabilities: [META],
  created_at: "2026-01-01T00:00:00Z",
};

/** What `POST /auth/local` answers: `{ok, user}` and no flag of any kind. */
const loginAnswer = (user: Record<string, unknown>) => json(200, { ok: true, user });

/** `/auth/me` answers `body`; anything else answers `{ok:true}`. */
const meAnswers = (body: unknown, status = 200) => {
  reply = (url) => (url.endsWith(ME) ? json(status, body) : json(200, { ok: true }));
};

/** `/auth/me` gets no answer at all — offline, DNS, connection refused. */
const meNeverReached = () => {
  reply = (url) => {
    if (url.endsWith(ME)) throw new TypeError("Failed to fetch");
    return json(200, { ok: true });
  };
};

/** `/auth/me` has been asked and has not answered: the window at mount. */
const meStillOut = () => {
  reply = (url) => (url.endsWith(ME) ? new Promise<Response>(() => {}) : json(200, { ok: true }));
};

/** The last visit's session, as the browser kept it. */
const remember = (user: unknown) => { localStorage.setItem(STORAGE_KEY, JSON.stringify(user)); };

/** What is in storage now, or `null` — the write side of the same key. */
const rememberedNow = (): { name?: string; role?: string; capabilities?: unknown } | null =>
  JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");

type Auth = ReturnType<typeof useAuth>;
const latest: { value: Auth | null } = { value: null };
/** The context as the last render handed it to a child. */
const auth = (): Auth => latest.value!;

function Probe() {
  latest.value = useAuth();
  // Rendered, because the effects and state updates under test only run inside
  // a mounted tree — but nothing is read back out of the DOM. See the header.
  return <div data-testid="probe" />;
}

const settle = async () => {
  // `/auth/me` resolves over several microtasks (the fetch, then `.json()`,
  // then the awaits in `checkSession`), so a bare `await act(async () => {})`
  // has not always drained them.
  await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
};

/** Mounted and left mid-flight, with the mount read still outstanding. */
const mountPending = () => { render(<AuthProvider><Probe /></AuthProvider>); };
const mount = async () => { mountPending(); await settle(); };

describe("why there is no user", () => {
  it("calls a session the server refused signed out", async () => {
    meAnswers({ error: "Unauthorized" }, 401);
    await mount();
    expect(auth().authFailure).toBe("unauthenticated");
    expect(auth().isAuthenticated).toBe(false);
    // The mount read is finished either way; a screen left on "checking" would
    // never draw the login form at all.
    expect(auth().isLoading).toBe(false);
  });

  it("does not call a broken proxy a signed-out session", async () => {
    // The measured defect this branch exists for: nginx in front of a real
    // build answered `502` while the backend restarted, all thirteen screens
    // became the login form, and the form posted through the same proxy — so
    // signing in did nothing. A 5xx is the server failing, not refusing.
    meAnswers({ error: "Bad Gateway" }, 502);
    await mount();
    expect(auth().authFailure).toBe("unreachable");
  });

  it("does not call a gateway timeout one either", async () => {
    // `504` is the same reading as `502` and a different one from `401`; a
    // check written as `status === 502` would pass the test above and fail here.
    meAnswers({ error: "Gateway Timeout" }, 504);
    await mount();
    expect(auth().authFailure).toBe("unreachable");
  });

  it("reads no answer at all as unreachable rather than as a refusal", async () => {
    meNeverReached();
    await mount();
    // `apiClient` reports this as `status: null`, which is not zero and not a
    // 4xx. Anything that treats a missing status as falsy lands on "refused".
    expect(auth().authFailure).toBe("unreachable");
    expect(auth().isAuthenticated).toBe(false);
  });

  it("calls a 403 an answer, because the server did answer", async () => {
    meAnswers({ error: "not allowed" }, 403);
    await mount();
    expect(auth().authFailure).toBe("unauthenticated");
  });

  it("drops the remembered session when a 200 names nobody, and says the server refused", async () => {
    // Entered from a remembered session on purpose. With storage empty the user
    // is already `null` when this branch runs, so the `setUser(null)` in it can
    // be deleted and nothing here notices — and the deletion is a browser that
    // keeps showing the last visit's console after the cookie expired, which is
    // exactly the shape below: storage still has a user, `/auth/me` answers 200
    // and names nobody.
    remember({ id: "usr_operator-1", name: "operator-1", role: "AGENT_OPERATOR", capabilities: [META], tenantId: "tenant_default", authProvider: "local" });
    meAnswers({ ok: true });
    await mount();
    expect(auth().user).toBe(null);
    expect(auth().isAuthenticated).toBe(false);
    // `github_login` is what makes an answer a session. The route replied, so
    // "cannot reach the backend" would send an operator to check a healthy
    // network for a session that has simply expired.
    expect(auth().authFailure).toBe("unauthenticated");
  });

  it("reports no failure at all while a session exists", async () => {
    meAnswers(SESSION);
    await mount();
    expect(auth().authFailure).toBe(null);
    expect(auth().isAuthenticated).toBe(true);
  });

  it("says it is still checking rather than answering before the route did", () => {
    meStillOut();
    mountPending();
    // Absent has to look absent. Between mount and the first reply there is no
    // reason for there being no user, and `"unauthenticated"` here is a login
    // form flashed at a session that turns out to be live.
    expect(auth().isLoading).toBe(true);
    expect(auth().authFailure).toBe(null);
    expect(auth().mustChangePassword).toBe(null);
  });

  it("stops reporting the earlier failure once someone signs in", async () => {
    meAnswers({ error: "Unauthorized" }, 401);
    await mount();
    expect(auth().authFailure).toBe("unauthenticated");
    reply = (url) => (url.endsWith(LOCAL)
      ? loginAnswer({ github_id: 7, github_login: "operator-1", role: "member", capabilities: [] })
      : json(200, SESSION));
    await act(async () => { await auth().loginWithLocal("operator-1", "pw"); });
    // Nothing on the login path resets the stored reason; the provider withholds
    // it while a user exists. A guard reading a stale `"unauthenticated"` beside
    // a live session would bounce the person it had just let in.
    expect(auth().isAuthenticated).toBe(true);
    expect(auth().authFailure).toBe(null);
  });
});

describe("whether the account may do anything yet", () => {
  it("leaves the lock unknown, not unlocked, when the backend never answered", async () => {
    meNeverReached();
    await mount();
    // The screen must not decide "no" on its own: while the flag is set the
    // server answers 403 to every route but three, so a guessed `false` is a
    // dashboard where every panel is a refusal and nothing says why.
    expect(auth().mustChangePassword).toBe(null);
  });

  it("is true when the server said the account is locked to the password change", async () => {
    meAnswers({ ...SESSION, must_change_password: true });
    await mount();
    expect(auth().mustChangePassword).toBe(true);
  });

  it("is false when the server answered and did not say it", async () => {
    meAnswers(SESSION);
    await mount();
    // Answered-and-not-locked is a third state from never-asked, and it is the
    // only one of the two that may open the rest of the console.
    expect(auth().mustChangePassword).toBe(false);
  });

  it("learns the lock cleared from the server rather than assuming it did", async () => {
    meAnswers({ ...SESSION, must_change_password: true });
    await mount();
    expect(auth().mustChangePassword).toBe(true);

    // The refresh that must NOT clear it. The password screen calls
    // `refreshSession` after what it believes was a successful change; if the
    // server still says the account is locked — the change was rejected, or it
    // landed on a different account — then the answer is still `true`. Without
    // this step the only refresh asserted is one the server answers `false` to,
    // and "read it out of the body" and "set it to false afterwards" are the
    // same observation.
    await act(async () => { await auth().refreshSession(); });
    expect(auth().mustChangePassword).toBe(true);

    meAnswers({ ...SESSION, must_change_password: false });
    await act(async () => { await auth().refreshSession(); });
    expect(auth().mustChangePassword).toBe(false);
  });

  it("forgets the lock rather than clearing it when the refresh did not arrive", async () => {
    meAnswers({ ...SESSION, must_change_password: true });
    await mount();
    meNeverReached();
    await act(async () => { await auth().refreshSession(); });
    // `false` here is a still-locked account let through because one request
    // dropped — the flag would read exactly as it does after a real change.
    expect(auth().mustChangePassword).toBe(null);
    // And a refresh that failed is not a logout: the session it could not ask
    // about is the session it still has.
    expect(auth().isAuthenticated).toBe(true);
    expect(auth().authFailure).toBe(null);
  });
});

describe("signing in", () => {
  const loginRefused = { error: "invalid username or password" };

  it("asks the server for the lock instead of reading it off the login answer", async () => {
    meAnswers({ error: "Unauthorized" }, 401);
    await mount();
    const before = calls.length;
    reply = (url) => (url.endsWith(LOCAL)
      ? loginAnswer({ github_id: -3, github_login: "locked-1", role: "member", capabilities: [] })
      : json(200, { ...SESSION, github_login: "locked-1", must_change_password: true }));
    await act(async () => { await auth().loginWithLocal("locked-1", "pw"); });
    const after = calls.slice(before);
    // Measured against the running server, the login response carried no flag
    // at all; a client reading it there finds `undefined`, takes that for
    // `false`, and walks the locked account straight past the guard.
    expect(after[0]!.url.endsWith(LOCAL)).toBe(true);
    expect(after[1]!.url.endsWith(ME)).toBe(true);
    expect(auth().mustChangePassword).toBe(true);
  });

  it("does not answer no about the lock when the follow-up read failed", async () => {
    // Signed in first, against a server that answered the flag. That is what
    // makes the assertion at the end mean anything: mounted into an empty
    // storage the flag is already `null` from `useState`, and the whole inner
    // `catch` can be emptied without this test noticing. Here it holds the
    // previous session's `false`, and carrying that `false` forward is a locked
    // account walked past the guard by a dropped request.
    meAnswers(SESSION);
    await mount();
    expect(auth().mustChangePassword).toBe(false);

    reply = (url) => {
      if (url.endsWith(LOCAL)) {
        return loginAnswer({ github_id: 7, github_login: "operator-1", role: "member", capabilities: [META] });
      }
      throw new TypeError("Failed to fetch");
    };
    await act(async () => { await auth().loginWithLocal("operator-1", "pw"); });
    // The password was accepted, so the person is signed in; what is unknown is
    // only the flag, and unknown is what it must say.
    expect(auth().isAuthenticated).toBe(true);
    expect(auth().mustChangePassword).toBe(null);
  });

  it("signs the previous session out when the credentials were refused, and hands the error back", async () => {
    // A live session first. A refused login from a signed-out console leaves
    // everything at its default, so `setUser(null)` and `setMustChangePassword(null)`
    // in the catch can both be deleted invisibly — and this is the case that
    // matters anyway: a second person at a shared console typing the wrong
    // password must not be left holding the first one's session.
    meAnswers(SESSION);
    await mount();
    expect(auth().isAuthenticated).toBe(true);
    expect(auth().mustChangePassword).toBe(false);
    expect(rememberedNow()?.name).toBe("operator-1");

    reply = (url) => (url.endsWith(LOCAL) ? json(401, loginRefused) : json(200, SESSION));
    const failure: { value: unknown } = { value: null };
    await act(async () => {
      failure.value = await auth().loginWithLocal("operator-1", "wrong").then(() => null, (e: unknown) => e);
    });
    // The login page tells "wrong password" from "no server" by asking this
    // error which it was; swallowing it here left the form sitting silent.
    expect(failure.value).toBeInstanceOf(ApiError);
    expect((failure.value as InstanceType<typeof ApiError>).status).toBe(401);
    expect((failure.value as InstanceType<typeof ApiError>).refused).toBe(true);
    expect(auth().isAuthenticated).toBe(false);
    expect(auth().mustChangePassword).toBe(null);
    // The `finally` clause: a spinner left up is a login page that cannot be
    // used a second time.
    expect(auth().isLoading).toBe(false);
    // And the browser must not still be holding the session it just signed out
    // of — a reload would show it again.
    expect(localStorage.getItem(STORAGE_KEY)).toBe(null);
  });

  it("calls the person what the server called them, with nothing appended", async () => {
    meAnswers(SESSION);
    await mount();
    // A Korean noun used to be appended here, so the sidebar read `admin (...)`
    // in English mode and the client was the author of a title nobody granted.
    // `toBe` is the whole check: anything appended, in any script, fails it.
    expect(auth().user?.name).toBe("operator-1");
  });
});

describe("what the server said this session may do", () => {
  it("takes an empty capability list as the answer it is", async () => {
    meAnswers({ ...SESSION, github_login: "root-1", role: "admin", capabilities: [] });
    await mount();
    // The direction inverted exactly at zero: `length > 0 ? server : roleTable`
    // gave an admin the server had granted nothing every capability there is.
    // Only the end point shows it, which is why narrowing the list never did.
    expect(auth().user?.capabilities).toEqual([]);
    expect(auth().user?.role).toBe("PLATFORM_ADMIN");
  });

  it("does not turn an administrator-looking account name into an administrator role", async () => {
    meAnswers({
      ...SESSION,
      github_login: "platform-admin",
      role: "member",
      capabilities: [],
    });
    await mount();
    // T-026 renames the seeded account, but the durable rule is still the role
    // field. A member can be named either the old or new seed spelling and must
    // not gain the platform-only tenant screen from that string.
    expect(auth().user?.name).toBe("platform-admin");
    expect(auth().user?.role).toBe("AGENT_OPERATOR");
  });

  it("hands a member every name in the table when that is what the server sent", async () => {
    // The other end point, and the one that says the client keeps no table of
    // its own to check the answer against. A member the server has granted
    // everything holds everything; anything here that narrows by role — the
    // shape of the fallback that was removed — fails only this test, because
    // every other session in this file is a member holding one audit name.
    const granted = [...ALL_CAPABILITIES];
    expect(granted.length, "the contract exports no capabilities, so this asserts nothing").toBeGreaterThan(1);
    meAnswers({ ...SESSION, role: "member", capabilities: granted });
    await mount();
    expect(auth().user?.capabilities).toEqual(granted);
    expect(auth().user?.role).toBe("AGENT_OPERATOR");
  });

  it("reads a missing capability list as nothing rather than as everything", async () => {
    // An older deployment does not send the field at all — the standing stack
    // was started five hours before the line that adds it landed.
    meAnswers({
      github_id: 9, github_login: "root-1", role: "admin",
      approved: true, tenant: null, created_at: "2026-01-01T00:00:00Z",
    });
    await mount();
    // A screen that offers too little is a complaint; one that offers an
    // administrator's thirteen links to a session the server has not granted is
    // the defect.
    expect(auth().user?.capabilities).toEqual([]);
  });

  it("repeats the names the server sent, and only those", async () => {
    meAnswers({ ...SESSION, capabilities: [META] });
    await mount();
    expect(auth().user?.capabilities).toEqual([META]);
  });

  it("applies the same three rules to the login answer, both roles", async () => {
    meAnswers({ error: "Unauthorized" }, 401);
    await mount();

    const admin = { github_id: 9, github_login: "root-1", role: "admin", capabilities: [DEPTH] };
    reply = (url) => (url.endsWith(LOCAL) ? loginAnswer(admin) : json(200, { ...SESSION, ...admin }));
    await act(async () => { await auth().loginWithLocal("root-1", "pw"); });
    // Two paths build a `User`, and a rule applied on one of them only is a
    // session that means something different before and after a reload. All
    // three rules, not only the list: the list as given, the role from the
    // server's word, and the name with nothing appended to it. The list is a
    // mailbox name here rather than the audit one every other session in this
    // file holds, so a login path that ignored the answer and copied a fixture
    // would show.
    expect(auth().user?.capabilities).toEqual([DEPTH]);
    expect(auth().user?.role).toBe("PLATFORM_ADMIN");
    expect(auth().user?.name).toBe("root-1");

    const member = { github_id: 4, github_login: "root-2", role: "member", capabilities: [META] };
    reply = (url) => (url.endsWith(LOCAL) ? loginAnswer(member) : json(200, { ...SESSION, ...member }));
    await act(async () => { await auth().loginWithLocal("root-2", "pw"); });
    // The second role, in the same test, because one of them alone passes for a
    // mapping that answers the same word to everything.
    expect(auth().user?.role).toBe("AGENT_OPERATOR");
    expect(auth().user?.name).toBe("root-2");
    expect(auth().user?.capabilities).toEqual([META]);
  });

  it("takes the role from the server's word rather than from the screen's", async () => {
    // The remembered session is the test. `prev?.role` was the fallback in this
    // branch, and with storage empty there is no `prev` for it to read — the
    // defect it guards against cannot appear, and restoring the fallback leaves
    // the file green. What it produced on a real console: a role the screen had
    // picked in a `<select>` survived a reload as though the server had said it,
    // and the dashboard branches on this value.
    remember({ id: "usr_operator-1", name: "operator-1", role: "PLATFORM_ADMIN", capabilities: [DEPTH], tenantId: "tenant_default", authProvider: "local" });
    meAnswers({ ...SESSION, role: "member", capabilities: [META] });
    await mount();
    expect(auth().user?.role).toBe("AGENT_OPERATOR");
    // Same line, same defect: what the browser remembers is not evidence about
    // what the account holds either.
    expect(auth().user?.capabilities).toEqual([META]);
  });
});

describe("a session remembered from the last visit", () => {
  it("is shown while /auth/me is still out, rather than a login form", async () => {
    remember({ id: "usr_operator-1", name: "operator-1", role: "AGENT_OPERATOR", capabilities: [META], tenantId: "tenant_default", authProvider: "local" });
    meStillOut();
    mountPending();
    // Without this every reload shows the signed-out console for as long as
    // `/auth/me` takes, and the cookie was valid the whole time.
    expect(auth().isAuthenticated).toBe(true);
    expect(auth().user?.name).toBe("operator-1");
  });

  it("is written down in the first place, or there is nothing to remember", async () => {
    meAnswers(SESSION);
    await mount();
    // Nothing else in this file reads the write. The tests around it put the key
    // there by hand and the logout tests assert it is gone — which it is, just
    // as much, when nothing ever wrote it. Deleting the persist effect ships a
    // build where every reload is a login form until `/auth/me` answers, and it
    // ships green.
    expect(rememberedNow()?.name).toBe("operator-1");
    expect(rememberedNow()?.role).toBe("AGENT_OPERATOR");
    expect(rememberedNow()?.capabilities).toEqual([META]);
  });

  it("does not trust a remembered capability list that is not a list", async () => {
    remember({ id: "usr_x", name: "x", role: "PLATFORM_ADMIN", capabilities: "PLATFORM_ADMIN", tenantId: "t", authProvider: "local" });
    meStillOut();
    mountPending();
    // This value is read back out of storage a person can edit, and the only
    // shape it is allowed to have is an array of names. Anything else is not an
    // answer, and not-an-answer is nothing.
    expect(auth().user?.capabilities).toEqual([]);
  });

  it("treats remembered state it cannot parse as no session at all", async () => {
    localStorage.setItem(STORAGE_KEY, "{not json");
    meStillOut();
    mountPending();
    // The alternative is a module-scope throw inside `useState`, which in a
    // browser is a blank page and a console line nobody is watching.
    expect(auth().isAuthenticated).toBe(false);
    expect(auth().user).toBe(null);
  });

  it("does not turn an unreachable backend into a logout for it", async () => {
    remember({ id: "usr_operator-1", name: "operator-1", role: "AGENT_OPERATOR", capabilities: [], tenantId: "tenant_default", authProvider: "local" });
    meAnswers({ error: "Bad Gateway" }, 502);
    await mount();
    // The word is what the guard reads, and this word keeps the person on a
    // "the server is not answering" panel instead of a login form that cannot
    // sign them in. The remembered session is dropped because `/auth/me` is the
    // authority on whether there is one — but dropping it is not the same claim
    // as the server having refused.
    expect(auth().authFailure).toBe("unreachable");
    expect(auth().isAuthenticated).toBe(false);
  });
});

describe("logging out", () => {
  const signedIn = async () => {
    meAnswers(SESSION);
    await mount();
    expect(auth().isAuthenticated).toBe(true);
    // The precondition every `toBe(null)` below is a transition *from*. Without
    // it those assertions pass on a provider that never persisted anything.
    expect(rememberedNow()?.name).toBe("operator-1");
  };

  it("tells the server, because the cookie is the server's", async () => {
    await signedIn();
    const before = calls.length;
    await act(async () => { auth().logout(); });
    // Measured on the running product: clearing local state alone left
    // `mesh_token` alive, `/auth/me` answered 200, and `/dashboard` opened
    // again on the next visit. The person had not signed out of anything.
    const logout = calls.slice(before).find((c) => c.url.endsWith(LOGOUT));
    expect(logout).not.toBe(undefined);
    expect(logout!.init?.method).toBe("POST");
    expect(auth().isAuthenticated).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(null);
  });

  it("clears the session even when the call to the server failed", async () => {
    await signedIn();
    reply = () => { throw new TypeError("Failed to fetch"); };
    await act(async () => { auth().logout(); });
    // The local half must not wait on the network half. A logout that leaves
    // the console signed in because the request failed is the worse of the two
    // wrong answers on a shared machine.
    expect(auth().user).toBe(null);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(null);
  });

  it("leaves no reason behind for there being no user", async () => {
    // The reason has to have been set for this to check anything, and a mount
    // that succeeded never sets one — so this session starts against a backend
    // that was down, signs in once the backend answers, and only then leaves.
    // `"unreachable"` is the value sitting in state the whole time, hidden by
    // the provider only while a user exists.
    meAnswers({ error: "Bad Gateway" }, 502);
    await mount();
    expect(auth().authFailure).toBe("unreachable");

    reply = (url) => (url.endsWith(LOCAL)
      ? loginAnswer({ github_id: 7, github_login: "operator-1", role: "member", capabilities: [META] })
      : json(200, SESSION));
    await act(async () => { await auth().loginWithLocal("operator-1", "pw"); });
    expect(auth().isAuthenticated).toBe(true);
    expect(auth().mustChangePassword).toBe(false);

    await act(async () => { auth().logout(); });
    // Signing out on purpose is not the backend refusing and not the backend
    // being down; the stored word comes back the instant the user goes, and a
    // leftover "unreachable" puts the disconnected panel in front of someone
    // who simply left.
    expect(auth().authFailure).toBe(null);
    expect(auth().mustChangePassword).toBe(null);
  });
});

describe("useAuth outside a provider", () => {
  it("throws rather than answering that nobody is signed in", () => {
    // A default context object would make every guard in the tree read
    // "signed out" for a wiring mistake, which is the same sentence as a real
    // expired session and is repairable by no operator.
    expect(() => render(<Probe />)).toThrow(/AuthProvider/);
  });
});

describe("the two roles a session can be", () => {
  /**
   * **The mapping is total, and two whole screens rest on that.**
   *
   * `DashboardPage` switches on four roles and 227 of its lines — the tenant
   * and group panels — are behind the two this can never produce. Its comment
   * says so; nothing measured it, so the sentence and the code were free to
   * drift apart, and the drift would show up as two panels nobody can reach
   * being maintained as though somebody could.
   *
   * Asserted as a negative on purpose. `admin -> PLATFORM_ADMIN` is already
   * pinned above and would stay green if the `else` started passing the
   * server's own string through — which is exactly the change that would make
   * those panels reachable from a server that started sending a role name.
   */
  const SERVER_MIGHT_SEND = [
    "admin",
    "member",
    "",
    // Names the client has words for and the server does not send. If one of
    // these ever survives the mapping, a screen appears that no route, no
    // capability and no test knows about.
    "TENANT_ADMIN",
    "GROUP_ADMIN",
    "PLATFORM_ADMIN",
    "in-process-unknown-role",
  ];

  it("resolves every role the server could send to one of two", async () => {
    const seen: string[] = [];
    for (const role of SERVER_MIGHT_SEND) {
      meAnswers({ ...SESSION, role, capabilities: [] });
      await mount();
      seen.push(String(auth().user?.role));
      cleanup();
      localStorage.clear();
    }
    expect([...new Set(seen)].sort()).toEqual(["AGENT_OPERATOR", "PLATFORM_ADMIN"]);
  });

  it("never resolves to a role the dashboard has a panel for but nothing can reach", async () => {
    for (const role of ["TENANT_ADMIN", "GROUP_ADMIN"]) {
      meAnswers({ ...SESSION, role, capabilities: [] });
      await mount();
      // A server that starts sending these must not light up a panel by
      // accident. Adding those roles is a decision; inheriting them from a
      // string is not.
      expect({ sent: role, became: auth().user?.role }).toEqual({ sent: role, became: "AGENT_OPERATOR" });
      cleanup();
      localStorage.clear();
    }
  });
});
