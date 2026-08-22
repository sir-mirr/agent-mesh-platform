/**
 * The admission screen, and the four different things it can mean by "nothing".
 *
 * Two independent reads land on this page — the roster of local accounts and
 * the queue of people asking to be let in — and each of them can be *still
 * reading*, *refused*, *unanswered* or *answered with nothing*. Every one of
 * those is a different sentence to the operator, and folding any two of them
 * together is this console's recurring defect: the module's own comment records
 * that this queue's failure branch once kept `[]` instead of `null`, so a
 * backend that never answered told every operator that nobody was waiting.
 *
 * So each state is asserted as *which of the four*, in one object, rather than
 * as the presence of the right one. A test that only checks the unreachable
 * notice is there passes on a screen that draws the empty notice beside it, and
 * "beside it" is how the defect reads on a real page.
 *
 * The two panels are driven from a per-URL fetch map rather than one global
 * failure, because the interesting cases are the mixed ones: the queue refused
 * while the roster answers is what a session holding a narrower grant actually
 * sees, and a page with one shared error flag draws it wrong.
 *
 * `failureKind` / `refusedCapability` are what separate *refused* from
 * *unreachable*, so the refusal fixtures below carry the capability in § 11.3's
 * field with a sentence that does not repeat it — a screen parsing the message
 * cannot pass those, which is the point of asserting them.
 *
 * The words compared against are `DICTIONARY.en`'s: this tree is held at zero
 * Korean characters, so the page renders inside `I18nProvider` (English by
 * default) and the expectations come out of the dictionary rather than out of
 * the Korean fallbacks compiled into the component.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Registered once for the process and never unregistered: bun runs every test
// file's top level before any test, so a register/unregister pair would swap
// the document out from under whichever file is still using it.
if (!(globalThis as { document?: unknown }).document) GlobalRegistrator.register();

// `await import`, not a statement: a static import is hoisted above the
// registration above and would load React's DOM entry into a process with no
// document.
const { render, screen, cleanup, fireEvent, act } = await import("@testing-library/react");
const { useLayoutEffect } = await import("react");
const { MemoryRouter } = await import("react-router-dom");
const { I18nProvider, DICTIONARY } = await import("@/contexts/I18nContext.tsx");
const { CAPABILITY } = await import("@/types/auth.ts");
const { UserAdminPage } = await import("./UserAdminPage.tsx");

const en = (key: string) => DICTIONARY.en[key]!;

const USERS = "/api/v1/admin/users";
const TENANT_DIRECTORY = "/api/v1/admin/tenants/directory";
/** People waiting to be admitted. */
const QUEUE = "/api/v1/admin/pending";
/** Keys waiting to be approved — a different queue, one path segment away. */
const KEY_QUEUE = "/api/v1/admin/keys/pending";

// Taken from the contract rather than typed as a string: a capability name this
// mesh does not define is as wrong in a fixture as in a screen, because it
// makes the test agree with a server that does not exist.
const ADMIT = CAPABILITY.USER_ADMIT;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Answer = () => Response | Promise<Response>;
const answers = (status: number, body: unknown): Answer => () => json(status, body);
/** No answer at all — offline, DNS, connection refused. Not a status. */
const noAnswer: Answer = () => { throw new TypeError("Failed to fetch"); };
/** In flight, and still in flight when the assertion runs. */
const stillReading: Answer = () => new Promise<Response>(() => {});

const realFetch = globalThis.fetch;
// bun:test has no global stubber, so the original goes back by hand; a
// forgotten restore poisons every file that runs after this one.
const stub = (fn: unknown) => { globalThis.fetch = fn as typeof globalThis.fetch; };

const calls: Array<{ url: string; method: string; body: string | null }> = [];

/**
 * happy-dom's storage belongs to the whole run, not to this file.
 *
 * Another file in this package leaves the saved language set to Korean, and
 * left there it would make every dictionary comparison below fail for a reason
 * that has nothing to do with this screen. So the key is cleared per test — and
 * whatever was in it before this file ran is put back, because clearing
 * somebody else's value is the same cross-file damage in the other direction.
 */
const LANG_KEY = "agent_mesh_lang";
const LANG_BEFORE = localStorage.getItem(LANG_KEY);
const restoreLanguage = () => {
  if (LANG_BEFORE === null) localStorage.removeItem(LANG_KEY);
  else localStorage.setItem(LANG_KEY, LANG_BEFORE);
};

let usersRoute: Answer;
let queueRoute: Answer;
let admitRoute: Answer;
let keyQueueRoute: Answer;
let tenantRoute: Answer;

beforeEach(() => {
  calls.length = 0;
  localStorage.removeItem(LANG_KEY);
  usersRoute = answers(200, { ok: true, users: [] });
  queueRoute = answers(200, { ok: true, users: [] });
  admitRoute = answers(201, { ok: true, user: { username: "someone" }, temporary_password: "unused" });
  keyQueueRoute = answers(200, { ok: true, keys: [] });
  tenantRoute = answers(200, {
    ok: true,
    tenant: "default",
    tenants: [
      { id: "default", name: "\uD50C\uB7AB\uD3FC", created_at: "now", deleted_at: null },
      { id: "tenant-b", name: "Tenant B", created_at: "now", deleted_at: null },
      { id: "deleted", name: "Deleted", created_at: "then", deleted_at: "now" },
    ],
  });
  stub(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method, body: typeof init?.body === "string" ? init.body : null });
    // One route can fail while the others answer — that separation is what
    // tells a refused panel from a backend that is down.
    if (url.endsWith(KEY_QUEUE)) return await keyQueueRoute();
    if (url.endsWith(QUEUE)) return await queueRoute();
    if (url.endsWith(TENANT_DIRECTORY)) return await tenantRoute();
    if (url.endsWith(USERS)) return method === "POST" ? await admitRoute() : await usersRoute();
    throw new TypeError("Failed to fetch");
  });
});

afterEach(() => {
  cleanup();
  restoreLanguage();
  globalThis.fetch = realFetch;
});
afterAll(() => {
  restoreLanguage();
  globalThis.fetch = realFetch;
});

const settle = async () => {
  // A mount read resolves over several microtasks (fetch, then `.json()`, then
  // the state writes), so a bare `await act(async () => {})` has not always
  // drained them.
  await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
};

const view = () =>
  render(
    <I18nProvider>
      {/* The real router rather than a mocked `useLocation`: the page mounts
          `<Breadcrumbs />`, and a module-level stub of react-router-dom would
          be installed for the whole process and reach every other file. */}
      <MemoryRouter initialEntries={["/platform/users"]}>
        <UserAdminPage />
      </MemoryRouter>
    </I18nProvider>,
  );

const mount = async () => { view(); await settle(); };

/**
 * The screen as it is committed, before either read has been asked for.
 *
 * A layout effect runs during the commit that mounts the tree, ahead of the
 * page's own `useEffect` — so a sibling holding one records the first frame an
 * operator can see. Nothing else can: `render` flushes the passive effects
 * before returning, and by then both reads are in flight and both loading flags
 * have been set from inside the handlers rather than from the initial state.
 */
const firstPaint = (record: (text: string) => void) => {
  const Paint = () => {
    useLayoutEffect(() => { record(document.body.textContent ?? ""); }, []);
    return null;
  };
  return <Paint />;
};

const shows = (testId: string) => screen.queryByTestId(testId) !== null;
const textOf = (testId: string): string | null => screen.queryByTestId(testId)?.textContent ?? null;

const queueText = () => screen.getByTestId("admission-queue").textContent ?? "";
/** The `DataTable`'s wrapper — its rows and its one state sentence. */
const rosterText = () => document.querySelector("table")?.parentElement?.textContent ?? "";

/**
 * Which of the four the admission queue is drawing, and what is under it.
 *
 * Asserted as one object so that "it says it could not read" and "it also says
 * nobody is waiting" cannot both be true and still pass — folding two of these
 * together is the defect, and a test naming only the state it wants sees
 * nothing wrong with a second one beside it.
 */
const queueState = () => ({
  loading: shows("admission-queue-loading"),
  refused: shows("admission-queue-refused"),
  unreachable: shows("admission-queue-unreachable"),
  empty: shows("admission-queue-empty"),
  rows: [...document.querySelectorAll('[data-testid^="admission-row-"]')].map((el) => el.textContent ?? ""),
});

/** The same four for the accounts table, which says them in sentences. */
const rosterState = () => {
  const text = rosterText();
  return {
    loading: text.includes(en("table.loading")),
    refused: text.includes(en("common.refusedRead")),
    unreachable: text.includes(en("users.error")),
    empty: text.includes(en("users.empty")),
    rows: [...document.querySelectorAll('[data-testid^="user-row-"]')].map((el) => el.textContent ?? ""),
  };
};

/**
 * One account's value from the column with a given heading.
 *
 * Read through the heading rather than by column index, so that a value landing
 * under the wrong label fails: every cell holds a word the server sent, and a
 * tenant printed under "Role" is still a sentence the screen made up.
 */
const cellUnder = (username: string, header: string): string => {
  const table = document.querySelector("table")!;
  const headings = [...table.querySelectorAll("th")].map((th) => th.textContent ?? "");
  const index = headings.indexOf(header);
  if (index < 0) throw new Error(`no column is headed ${header}`);
  const row = screen.getByTestId(`user-row-${username}`).closest("tr");
  if (!row) throw new Error(`no row renders ${username}`);
  return [...row.querySelectorAll("td")][index]?.textContent ?? "";
};

const typeInto = (testId: string, value: string) => {
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
};
const submitButton = () => screen.getByTestId("admit-submit") as HTMLButtonElement;
const admit = async (username: string, displayName = "", tenant?: string) => {
  typeInto("admit-username", username);
  typeInto("admit-display", displayName);
  if (tenant) fireEvent.change(screen.getByTestId("admit-tenant"), { target: { value: tenant } });
  fireEvent.submit(screen.getByTestId("admit-form"));
  await settle();
};
const posts = () => calls.filter((c) => c.method === "POST" && c.url.endsWith(USERS));
const rosterReads = () => calls.filter((c) => c.method === "GET" && c.url.endsWith(USERS));

/** What `GET /api/v1/admin/users` answers with — flags as numbers, as the server sends them. */
const ROSTER = [
  { username: "ada", display_name: "Ada L", role: "member", tenant: "tenant-a", must_change_password: 1 },
  { username: "grace", role: "admin", tenant: "tenant-b", must_change_password: 0 },
];

describe("the admission queue, in the four states it can be in", () => {
  it("accuses nobody in the frame before either read has been asked for", async () => {
    queueRoute = stillReading;
    usersRoute = stillReading;
    const painted: string[] = [];
    render(
      <I18nProvider>
        <MemoryRouter initialEntries={["/platform/users"]}>
          <UserAdminPage />
          {firstPaint((text) => painted.push(text))}
        </MemoryRouter>
      </I18nProvider>,
    );
    await settle();
    // Both panels set their loading flag inside the read, which is a passive
    // effect — so whatever the initial state says is what the operator sees
    // first. Initialised to "not loading", the first committed frame reports a
    // failed read and an empty account list before a single request has left:
    // the whole defect this screen is about, lasting one frame.
    expect(painted.length).toBe(1);
    const first = painted[0] ?? "";
    expect(first).toContain(en("users.queue.loading"));
    expect(first).not.toContain(en("users.queue.unreachable"));
    expect(first).not.toContain(en("users.queue.empty"));
    expect(first).toContain(en("table.loading"));
    expect(first).not.toContain(en("users.empty"));
    expect(first).not.toContain(en("users.error"));
  });

  it("says it is still reading, and does not yet say nobody is waiting", async () => {
    queueRoute = stillReading;
    await mount();
    // A queue whose read has not come back knows nothing about who is waiting.
    expect(queueState()).toEqual({ loading: true, refused: false, unreachable: false, empty: false, rows: [] });
    expect(queueText()).toContain(en("users.queue.loading"));
  });

  it("draws the people the server said are waiting, and invents no arrival time", async () => {
    queueRoute = answers(200, {
      ok: true,
      users: [
        { github_login: "waiting-1", requested_at: "2026-08-01T09:00:00Z" },
        { github_login: "waiting-2" },
      ],
    });
    await mount();
    // The read has to happen at all: before this panel existed nothing in this
    // front end asked for this queue, which is the same claim as an empty one
    // made silently.
    expect(calls.filter((c) => c.url.endsWith(QUEUE)).length).toBe(1);
    // The second request carried no timestamp, and its row is exactly its
    // login. A stand-in there would be a time an operator sorts a decision
    // queue by that no server ever sent — the same family as the invented
    // `created_at` on the registry screen.
    expect(queueState()).toEqual({
      loading: false,
      refused: false,
      unreachable: false,
      empty: false,
      rows: ["waiting-1 · 2026-08-01T09:00:00Z", "waiting-2"],
    });
  });

  it("says the queue is empty only because the server said so", async () => {
    queueRoute = answers(200, { ok: true, users: [] });
    // The other decision queue, one path segment away, is not empty. A panel
    // reading that one would draw its rows here, under a heading about people
    // asking for accounts.
    keyQueueRoute = answers(200, { ok: true, keys: [{ identity: "key-queue-row", fingerprint: "sha256:abcdef01" }] });
    await mount();
    expect(queueState()).toEqual({ loading: false, refused: false, unreachable: false, empty: true, rows: [] });
    expect(queueText()).toContain(en("users.queue.empty"));
    expect(queueText()).not.toContain("key-queue-row");
  });

  it("does not call a queue it could not read a queue with nobody in it", async () => {
    queueRoute = noAnswer;
    usersRoute = answers(200, { ok: true, users: ROSTER });
    await mount();
    // **The defect this file exists for.** The failure branch kept `[]`, which
    // falls through to the length check and draws "Nobody is waiting" about a
    // backend that never answered — an operator reads that as a decided queue
    // and stops looking.
    expect(queueState()).toEqual({ loading: false, refused: false, unreachable: true, empty: false, rows: [] });
    expect(queueText()).toContain(en("users.queue.unreachable"));
    expect(queueText()).not.toContain(en("users.queue.empty"));
    // And the roster answered on its own route. One panel failing is not the
    // backend being down, so a page holding a single failure flag blanks this
    // table too.
    expect(rosterState().rows.length).toBe(2);
    expect(rosterState().unreachable).toBe(false);
  });

  it("calls a refusal a refusal, and names the capability the server named", async () => {
    // The sentence does not repeat the capability, so only a screen reading
    // § 11.3's `capability` field can print it. One parsing the message would
    // have nothing to print, and would be indistinguishable here from one with
    // the name hand-typed into its own copy — which is what nine screens did.
    queueRoute = answers(403, { error: "not allowed", capability: ADMIT });
    await mount();
    // The server answered. Saying it did not sends the operator to check a
    // network for a permission they simply do not hold.
    expect(queueState()).toEqual({ loading: false, refused: true, unreachable: false, empty: false, rows: [] });
    expect(textOf("admission-queue-refused")).toBe(`${en("common.refusedRead")}.`);
    expect(queueText()).not.toContain(en("users.queue.unreachable"));
    expect(queueText()).not.toContain(en("users.queue.empty"));
  });

  it("says only that it is not allowed when the server named nothing", async () => {
    queueRoute = answers(403, { error: "not allowed" });
    await mount();
    // A capability printed here that the server did not send is a guess about
    // what the route requires, and guesses go stale the moment a route's
    // requirement changes.
    expect(textOf("admission-queue-refused")).toBe(`${en("common.refusedRead")}.`);
  });

  it("does not call a broken proxy a refusal", async () => {
    // A `5xx` is the server failing, not the server saying no — the line the
    // 502-read-as-signed-out defect crossed elsewhere in this console. Anything
    // discriminating on `status !== null` rather than on the 4xx range fails.
    queueRoute = answers(502, { error: "bad gateway" });
    await mount();
    expect(queueState()).toEqual({ loading: false, refused: false, unreachable: true, empty: false, rows: [] });
    expect(queueText()).not.toContain(en("common.refusedRead"));
  });

  it("reads the queue out of the name the rename left it under", async () => {
    // `D-689` moved this route from `{ pending }` to `{ users }` precisely so a
    // reader holding a response could tell which of the two admin queues it
    // had. Accepting the old name too restores the ambiguity by the back door,
    // and nothing about the body would look wrong.
    queueRoute = answers(200, { ok: true, pending: [{ github_login: "pre-rename-row" }] });
    await mount();
    expect(queueState().rows).toEqual([]);
    expect(queueText()).not.toContain("pre-rename-row");
  });
});

describe("the roster of local accounts tells the same four apart", () => {
  it("says it is still reading, and claims nothing about who has an account", async () => {
    usersRoute = stillReading;
    await mount();
    expect(rosterState()).toEqual({ loading: true, refused: false, unreachable: false, empty: false, rows: [] });
  });

  it("puts each account's own values under the headings they belong to", async () => {
    usersRoute = answers(200, { ok: true, users: ROSTER });
    await mount();
    expect(rosterState().rows.length).toBe(2);
    expect(cellUnder("ada", en("users.col.role"))).toBe("member");
    expect(cellUnder("ada", en("users.col.tenant"))).toBe("tenant-a");
    expect(cellUnder("ada", en("users.col.display"))).toBe("Ada L");
    // The roster is the only place this console learns a role or a name. A
    // stand-in for one the server did not send — `Operator` beside every
    // subject — is the defect `/tenant/rbac` shipped.
    expect(cellUnder("grace", en("users.col.display"))).toBe("—");
    expect(cellUnder("grace", en("users.col.tenant"))).toBe("tenant-b");
    expect(rosterState().empty).toBe(false);
  });

  it("says a password is still the temporary one when the server says it must change", async () => {
    usersRoute = answers(200, { ok: true, users: ROSTER });
    await mount();
    // The server sends `must_change_password` as `0`/`1`, so anything comparing
    // it against `true` calls every un-activated account's password chosen —
    // and "chosen" is the state in which an operator stops chasing the person.
    expect(textOf("user-state-ada")).toBe(en("users.state.temp"));
    expect(textOf("user-state-grace")).toBe(en("users.state.chosen"));
  });

  it("says there are no accounts only when the server answered with none", async () => {
    usersRoute = answers(200, { ok: true, users: [] });
    await mount();
    expect(rosterState()).toEqual({ loading: false, refused: false, unreachable: false, empty: true, rows: [] });
  });

  it("does not call an unanswered roster an empty one", async () => {
    usersRoute = noAnswer;
    queueRoute = answers(200, { ok: true, users: [{ github_login: "waiting-1" }] });
    await mount();
    expect(rosterState()).toEqual({ loading: false, refused: false, unreachable: true, empty: false, rows: [] });
    expect(rosterText()).toContain(en("users.error"));
    // The queue answered on its own route and keeps its row.
    expect(queueState().rows).toEqual(["waiting-1"]);
  });

  it("tells a refused roster from an unanswered one, and names the capability", async () => {
    usersRoute = answers(403, { error: "not allowed", capability: ADMIT });
    await mount();
    // The measured defect: every list on this console caught its error and drew
    // one sentence about the server not answering, at a server that had
    // answered `403`.
    expect(rosterState()).toEqual({ loading: false, refused: true, unreachable: false, empty: false, rows: [] });
    expect(rosterText()).toContain(`${en("common.refusedRead")}.`);
    expect(rosterText()).not.toContain(ADMIT);
  });

  it("does not call a broken proxy a refused roster", async () => {
    usersRoute = answers(502, { error: "bad gateway" });
    await mount();
    expect(rosterState()).toEqual({ loading: false, refused: false, unreachable: true, empty: false, rows: [] });
  });
});

describe("the one temporary password", () => {
  const ISSUED = { ok: true, user: { username: "newbie" }, temporary_password: "correct-horse-battery" };

  it("shows the password the server issued, under the name the server confirmed", async () => {
    admitRoute = answers(201, ISSUED);
    await mount();
    await admit("Newbie", "New Bie");
    expect(textOf("issued-value")).toBe(ISSUED.temporary_password);
    // The account the password belongs to is the one the server created, not
    // the string that was typed — labelling it with the typed name names an
    // account that may not exist.
    expect(textOf("issued-password")).toContain(ISSUED.user.username);
    expect(textOf("issued-password")).toContain(en("users.issued.once"));
    // The sentence used to end by telling the operator to admit the person
    // again for a new one, and admitting an existing account answers `409` —
    // the screen was instructing them to do the one thing the server refuses.
    expect(textOf("issued-password") ?? "").not.toMatch(/admit .*again/i);
  });

  it("sends the trimmed username, and omits a display name nobody typed", async () => {
    admitRoute = answers(201, ISSUED);
    await mount();
    await admit("  newbie  ", "   ");
    // A username created with a leading space is an account whose holder
    // cannot sign in, and nothing on this screen would show the difference.
    expect(JSON.parse(posts()[0]?.body ?? "null")).toEqual({ username: "newbie", tenant: "default" });
  });

  it("defaults to the signed-in account's active tenant and sends the selected tenant", async () => {
    admitRoute = answers(201, ISSUED);
    await mount();
    const select = screen.getByTestId("admit-tenant") as HTMLSelectElement;
    expect(select.value).toBe("default");
    expect([...select.options].map((option) => option.value)).toEqual(["default", "tenant-b"]);
    expect(select.textContent).toContain("\uD50C\uB7AB\uD3FC (default)");
    expect(select.textContent).not.toContain("Deleted");

    await admit("newbie", "", "tenant-b");
    expect(JSON.parse(posts()[0]?.body ?? "null")).toEqual({ username: "newbie", tenant: "tenant-b" });
  });

  it("does not guess a tenant or admit when the directory could not be read", async () => {
    tenantRoute = noAnswer;
    await mount();
    expect(screen.queryByTestId("admit-tenants-unreachable")).not.toBe(null);
    expect((screen.getByTestId("admit-tenant") as HTMLSelectElement).disabled).toBe(true);
    expect(submitButton().disabled).toBe(true);
    await admit("newbie");
    expect(posts()).toHaveLength(0);
  });

  it("loses the password on a reload, and never puts it in storage", async () => {
    admitRoute = answers(201, ISSUED);
    usersRoute = answers(200, { ok: true, users: [{ username: "newbie", role: "member", must_change_password: 1 }] });
    await mount();
    await admit("newbie");
    expect(textOf("issued-value")).toBe(ISSUED.temporary_password);

    const stored = [...Array(localStorage.length).keys()]
      .map((i) => `${localStorage.key(i) ?? ""}=${localStorage.getItem(localStorage.key(i) ?? "") ?? ""}`)
      .join("\n");
    // "Once" is only true if the value lives in component state and nowhere
    // else. A copy in storage survives the reload, survives the session, and is
    // readable by anything else running on this origin.
    expect(stored).not.toContain(ISSUED.temporary_password);

    cleanup();
    await mount();
    // The reload `SC-USER-D1` performs. The account is on the roster; the
    // password is gone, and the server will not repeat it.
    expect(rosterState().rows.length).toBe(1);
    expect(textOf("issued-password")).toBe(null);
    expect(document.body.textContent ?? "").not.toContain(ISSUED.temporary_password);
  });

  it("re-reads the roster so the new account is on it", async () => {
    admitRoute = answers(201, ISSUED);
    usersRoute = answers(200, { ok: true, users: [] });
    await mount();
    expect(rosterState().empty).toBe(true);
    usersRoute = answers(200, { ok: true, users: [{ username: "newbie", role: "member", must_change_password: 1 }] });
    await admit("newbie");
    // Without the re-read the operator is looking at a list that says the
    // account they just created does not exist.
    expect(rosterReads().length).toBe(2);
    expect(shows("user-row-newbie")).toBe(true);
  });

  it("shows the server's own sentence when the admission is refused", async () => {
    admitRoute = answers(409, { ok: false, error: "a local account named 'ada' already exists" });
    await mount();
    await admit("ada");
    // The server's words, not a friendlier invention: the duplicate-name case
    // states a fact this screen does not hold, and rewording it would make the
    // screen the author of that fact.
    expect(textOf("admit-error")).toBe("a local account named 'ada' already exists");
    // Nothing was created, so nothing may look like a password to hand over.
    expect(textOf("issued-password")).toBe(null);
  });

  it("says nothing was created when the write never reached the server", async () => {
    admitRoute = noAnswer;
    await mount();
    await admit("newbie");
    // A refusal and a request that never arrived are different facts about the
    // account: one exists and was rejected, the other has an unknown outcome.
    // `ApiError.status === null` is the only thing separating them, and the raw
    // transport message tells an operator nothing about whether an account now
    // exists.
    expect(textOf("admit-error")).toBe(en("users.unreachable"));
    expect(textOf("issued-password")).toBe(null);
  });

  it("does not leave a password on screen beside the next refusal", async () => {
    admitRoute = answers(201, ISSUED);
    await mount();
    await admit("newbie");
    expect(textOf("issued-value")).toBe(ISSUED.temporary_password);

    admitRoute = answers(409, { ok: false, error: "a local account named 'newbie' already exists" });
    await admit("newbie");
    // Entered from a state that contradicts the assertion, or it would only be
    // reading the initial `null`. A password left standing over a failed
    // admission is one an operator hands out for an account that was never
    // created.
    expect(textOf("issued-password")).toBe(null);
    expect(textOf("admit-error")).toContain("already exists");
  });

  it("takes the refusal down when the next admission works", async () => {
    admitRoute = answers(409, { ok: false, error: "a local account named 'ada' already exists" });
    await mount();
    await admit("ada");
    expect(textOf("admit-error")).toContain("already exists");

    admitRoute = answers(201, ISSUED);
    await admit("newbie");
    // A stale refusal beside a fresh password reads as the password having been
    // refused.
    expect(textOf("admit-error")).toBe(null);
    expect(textOf("issued-value")).toBe(ISSUED.temporary_password);
  });

  it("does not admit a username nobody typed", async () => {
    await mount();
    fireEvent.submit(screen.getByTestId("admit-form"));
    await settle();
    typeInto("admit-username", "   ");
    fireEvent.submit(screen.getByTestId("admit-form"));
    await settle();
    // A blank or whitespace-only name is refused by the server with a `400`
    // about the identity pattern, and the operator reads that as a mistake in a
    // field they can see is empty.
    expect(posts().length).toBe(0);
    expect(textOf("admit-error")).toBe(null);
  });

  it("holds the form while the write is in flight, and sends it once", async () => {
    admitRoute = stillReading;
    await mount();
    typeInto("admit-username", "newbie");
    fireEvent.submit(screen.getByTestId("admit-form"));
    expect(submitButton().disabled).toBe(true);
    expect(submitButton().textContent).toBe(en("users.admitting"));

    fireEvent.submit(screen.getByTestId("admit-form"));
    await settle();
    // Admission is not idempotent: a second write answers `409`, so the screen
    // would show a refusal for the account it just created, with the first
    // password still on screen beside it.
    expect(posts().length).toBe(1);
    expect(submitButton().disabled).toBe(true);
  });

  it("hands the form back when the write finishes", async () => {
    admitRoute = answers(201, ISSUED);
    await mount();
    await admit("newbie");
    // A form still disabled after a completed write means the next person
    // cannot be admitted without a reload — which is also the reload that
    // destroys the password just issued.
    expect(submitButton().disabled).toBe(false);
    expect(submitButton().textContent).toBe(en("users.admit"));
  });
});
