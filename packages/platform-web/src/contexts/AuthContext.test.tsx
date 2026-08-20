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
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Registered once for the process and never unregistered: bun runs every test
// file's top level before it runs any test, so a register/unregister pair swaps
// the document out from under whichever file is still using it.
if (!(globalThis as { document?: unknown }).document) GlobalRegistrator.register();

// `await import`, not a statement: a static import is hoisted above the
// registration above and would load React's DOM entry into a process with no
// document.
const { render, screen, cleanup, act } = await import("@testing-library/react");
const { AuthProvider, useAuth } = await import("./AuthContext.tsx");
const { ALL_CAPABILITIES } = await import("@/types/auth.ts");
const { ApiError } = await import("@/api/client.ts");

const STORAGE_KEY = "agent_mesh_user";
const ME = "/auth/me";
const LOCAL = "/auth/local";
const LOGOUT = "/auth/logout";

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

afterEach(() => { cleanup(); globalThis.fetch = realFetch; });

/** What `/auth/me` answers for a signed-in member on this source. */
const SESSION = {
  github_id: 7,
  github_login: "operator-1",
  role: "member",
  approved: true,
  tenant: "tenant_default",
  capabilities: ["audit.read.metadata"],
  created_at: "2026-01-01T00:00:00Z",
};

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

type Auth = ReturnType<typeof useAuth>;
const latest: { value: Auth | null } = { value: null };
/** The context as the last render handed it to a child. */
const auth = (): Auth => latest.value!;

function Probe() {
  const value = useAuth();
  latest.value = value;
  // Rendered as well as captured, so the assertions are about what a child is
  // given rather than only about an object. `null` gets a word of its own in
  // both fields because the whole subject of this file is that it is neither
  // `false` nor `"unauthenticated"`.
  return (
    <ul>
      <li data-testid="failure">{value.authFailure ?? "no-failure"}</li>
      <li data-testid="must">
        {value.mustChangePassword === null ? "not-asked" : String(value.mustChangePassword)}
      </li>
      <li data-testid="name">{value.user?.name ?? "no-user"}</li>
    </ul>
  );
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
    expect(screen.getByTestId("failure").textContent).toBe("unauthenticated");
  });

  it("does not call a broken proxy a signed-out session", async () => {
    // The measured defect this branch exists for: nginx in front of a real
    // build answered `502` while the backend restarted, all thirteen screens
    // became the login form, and the form posted through the same proxy — so
    // signing in did nothing. A 5xx is the server failing, not refusing.
    meAnswers({ error: "Bad Gateway" }, 502);
    await mount();
    expect(auth().authFailure).toBe("unreachable");
    expect(auth().authFailure).not.toBe("unauthenticated");
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

  it("treats a 200 that names nobody as signed out, not as a backend that is down", async () => {
    // `github_login` is what makes an answer a session. The route replied, so
    // "cannot reach the backend" would send an operator to check a healthy
    // network for a session that has simply expired.
    meAnswers({ ok: true });
    await mount();
    expect(auth().authFailure).toBe("unauthenticated");
  });

  it("reports no failure at all while a session exists", async () => {
    meAnswers(SESSION);
    await mount();
    expect(auth().authFailure).toBe(null);
    expect(auth().isAuthenticated).toBe(true);
    expect(screen.getByTestId("failure").textContent).toBe("no-failure");
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
      ? json(200, { ok: true, user: { github_id: 7, github_login: "operator-1", role: "member", capabilities: [] } })
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
    expect(auth().mustChangePassword).not.toBe(false);
    expect(screen.getByTestId("must").textContent).toBe("not-asked");
  });

  it("is true when the server said the account is locked to the password change", async () => {
    meAnswers({ ...SESSION, must_change_password: true });
    await mount();
    expect(auth().mustChangePassword).toBe(true);
    expect(screen.getByTestId("must").textContent).toBe("true");
  });

  it("is false when the server answered and did not say it", async () => {
    meAnswers(SESSION);
    await mount();
    // Answered-and-not-locked is a third state from never-asked, and it is the
    // only one of the two that may open the rest of the console.
    expect(auth().mustChangePassword).toBe(false);
    expect(screen.getByTestId("must").textContent).toBe("false");
  });

  it("learns the lock cleared from the server rather than assuming it did", async () => {
    meAnswers({ ...SESSION, must_change_password: true });
    await mount();
    expect(auth().mustChangePassword).toBe(true);
    meAnswers({ ...SESSION, must_change_password: false });
    await act(async () => { await auth().refreshSession(); });
    // The password screen calls this after a successful change. Clearing the
    // flag locally instead would be the client deciding it had been unlocked.
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
      ? json(200, { ok: true, user: { github_id: -3, github_login: "locked-1", role: "member", capabilities: [] } })
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
    reply = (url) => {
      if (url.endsWith(LOCAL)) {
        return json(200, { ok: true, user: { github_id: 7, github_login: "operator-1", role: "member", capabilities: ["audit.read.metadata"] } });
      }
      throw new TypeError("Failed to fetch");
    };
    await mount();
    await act(async () => { await auth().loginWithLocal("operator-1", "pw"); });
    // The password was accepted, so the person is signed in; what is unknown is
    // only the flag, and unknown is what it must say.
    expect(auth().isAuthenticated).toBe(true);
    expect(auth().mustChangePassword).toBe(null);
  });

  it("signs nobody in when the credentials were refused, and hands the error back", async () => {
    meAnswers({ error: "Unauthorized" }, 401);
    await mount();
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
    expect(localStorage.getItem(STORAGE_KEY)).toBe(null);
  });

  it("calls the person what the server called them, with nothing appended", async () => {
    meAnswers(SESSION);
    await mount();
    // A Korean noun used to be appended here, so the sidebar read `admin (...)`
    // in English mode and the client was the author of a title nobody granted.
    expect(auth().user?.name).toBe("operator-1");
    expect(screen.getByTestId("name").textContent).toBe("operator-1");
    expect(screen.getByTestId("name").textContent).not.toContain("(");
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
    // The floor that makes the line above mean something: there is a table of
    // names this could have fallen back to, and it is not empty.
    expect(ALL_CAPABILITIES.length).toBeGreaterThan(0);
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
    meAnswers({ ...SESSION, capabilities: ["audit.read.metadata"] });
    await mount();
    expect(auth().user?.capabilities).toEqual(["audit.read.metadata"]);
  });

  it("applies the same rule to the names in the login answer", async () => {
    meAnswers({ error: "Unauthorized" }, 401);
    await mount();
    reply = (url) => (url.endsWith(LOCAL)
      ? json(200, { ok: true, user: { github_id: 7, github_login: "operator-1", role: "member", capabilities: ["audit.read.metadata"] } })
      : json(200, SESSION));
    await act(async () => { await auth().loginWithLocal("operator-1", "pw"); });
    // Two paths build a `User`, and a rule applied on one of them only is a
    // session that means something different before and after a reload.
    expect(auth().user?.capabilities).toEqual(["audit.read.metadata"]);
  });

  it("takes the role from the server's word rather than from the screen's", async () => {
    meAnswers({ ...SESSION, role: "member" });
    await mount();
    // `prev?.role` used to be the fallback here, which let a role the screen
    // had picked in a `<select>` survive a reload as though the server had said
    // it. The dashboard still branches on this value.
    expect(auth().user?.role).toBe("AGENT_OPERATOR");
  });
});

describe("a session remembered from the last visit", () => {
  const remember = (user: unknown) => { localStorage.setItem(STORAGE_KEY, JSON.stringify(user)); };

  it("is shown while /auth/me is still out, rather than a login form", async () => {
    remember({ id: "usr_operator-1", name: "operator-1", role: "AGENT_OPERATOR", capabilities: ["audit.read.metadata"], tenantId: "tenant_default", authProvider: "local" });
    meStillOut();
    mountPending();
    // Without this every reload shows the signed-out console for as long as
    // `/auth/me` takes, and the cookie was valid the whole time.
    expect(auth().isAuthenticated).toBe(true);
    expect(auth().user?.name).toBe("operator-1");
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
    expect(screen.getByTestId("failure").textContent).toBe("unreachable");
  });
});

describe("logging out", () => {
  const signedIn = async () => {
    meAnswers(SESSION);
    await mount();
    expect(auth().isAuthenticated).toBe(true);
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
    await signedIn();
    await act(async () => { auth().logout(); });
    // Signing out on purpose is not the backend refusing and not the backend
    // being down; a leftover `"unreachable"` here would put the disconnected
    // panel in front of someone who simply left.
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
