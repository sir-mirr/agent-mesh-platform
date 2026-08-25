/**
 * The audit screen: the four things it can say about the log, and the one
 * thing it must never claim about a signature.
 *
 * ## Four states, not one error
 *
 * One read feeds this page, and it can be *still reading*, *refused*,
 * *unanswered*, or *answered with nothing*. Those are four different sentences
 * to an operator and this console's recurring defect is folding two of them
 * together — "no audit entries are recorded" drawn about a backend that never
 * answered sends someone to look for a quiet mesh that is actually a dead one.
 * `api/client.ts` already splits them (`failureKind`, `refusedCapability`), so
 * each state is asserted as *which of the four*, in one object: a test naming
 * only the state it wants passes on a screen drawing a second one beside it,
 * and "beside it" is what the defect looks like on a real page.
 *
 * The refusal fixtures carry the capability in § 11.3's `capability` field with
 * a message that does not repeat it, so a screen parsing the sentence instead
 * of reading the field cannot pass.
 *
 * ## The badge that was drawn from nothing
 *
 * This screen used to render a signature verdict from `signature_verified` — a
 * field with zero occurrences in hub, http, store, contracts or SPEC. Presence
 * of an attestation was painted as proof of verification, and a boolean could
 * not have carried that answer anyway: a rotated key's row is deleted
 * (`keys.ts` DELETE FROM agent_keys), so *unverifiable because rotated* and
 * *forged* would share one `false`. What is measured is
 * `integrity.digest_matches`, recomputed in `audit-query.ts` over the bytes
 * actually stored — and its third state, absent, means **nobody checked**,
 * which is not `false`. Both halves are pinned below: the three verdicts stay
 * apart, and a row carrying the phantom field renders identically to one that
 * does not.
 *
 * ## Providers
 *
 * The real `AuthProvider`/`RbacProvider` with a stubbed `fetch`, not a mocked
 * context: `mock.module` is global to the process and every context here has
 * its own test file that would receive the mock. The capability the § 11.0
 * boundary turns on therefore arrives the way it does in the product — out of
 * `/auth/me` — and the router is the real `MemoryRouter`, because the page
 * mounts `<Breadcrumbs />` and a module-level stub of react-router-dom would
 * reach every other file in the run.
 *
 * Words come from `DICTIONARY.en` rather than from the Korean fallbacks
 * compiled into the component: this tree is held at zero Korean characters, and
 * `I18nProvider` defaults to English.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { registerDom } from "../../register-dom";

// Registered once for the process and never unregistered: bun runs every test
// file's top level before any test, so a register/unregister pair would swap
// the document out from under whichever file is still using it.
registerDom();

// `await import`, not a statement: a static import is hoisted above the
// registration above and would load React's DOM entry into a process with no
// document.
const { render, screen, cleanup, fireEvent, act } = await import("@testing-library/react");
const { useLayoutEffect } = await import("react");
const { MemoryRouter } = await import("react-router-dom");
const { I18nProvider, DICTIONARY } = await import("@/contexts/I18nContext.tsx");
const { AuthProvider } = await import("@/contexts/AuthContext.tsx");
const { RbacProvider } = await import("@/contexts/RbacContext.tsx");
const { CAPABILITY } = await import("@/types/auth.ts");
const { AuditLogsPage } = await import("./AuditLogsPage.tsx");

const en = (key: string): string => DICTIONARY.en[key]!;

/**
 * The words this screen should say, bound to names one key to a line.
 *
 * Not inlined into the assertions, and the reason is a checker rather than
 * taste: a translation key is shaped exactly like a capability name, and
 * `capability-prose.test.ts` reads any quoted string that is not the first on
 * its line as text shown to a person. `toBe(en("audit.signed"))` would be
 * reported as a screen displaying a capability the contract does not define —
 * which is a rule worth keeping, so the keys stay where it can tell them apart.
 */
const LOADING = en("table.loading");
const REFUSED = en("common.refusedRead");
const UNREACHABLE = en("audit.error");
const EMPTY = en("audit.empty");
const REFRESH_BUTTON = en("audit.refreshBtn");
const SIGNED = en("audit.signed");
const UNSIGNED = en("audit.unsigned");
const ALG_UNKNOWN = en("auditAlgUnknown");
const INTACT = en("audit.intact");
const TAMPERED = en("audit.tampered");
const UNMEASURED = en("audit.unmeasured");
const BANNER_HELD = en("audit.status.has");
const BANNER_WITHHELD = en("audit.status.none");
const COL_EVENT = en("audit.col.event");
const COL_ORIGINAL = en("audit.col.original");
const SHOW_ORIGINAL = en("audit.original.show");

const AUDIT = "/api/v1/audit/events";
const ME = "/auth/me";
/** `<Breadcrumbs />` mounts the bell, which reads its own queue on the way past. */
const KEY_QUEUE = "/api/v1/admin/keys/pending";

// Taken from the contract rather than typed as strings: a capability name this
// mesh does not define is as wrong in a fixture as it is in a screen, because
// it makes the test agree with a server that does not exist.
const METADATA = CAPABILITY.AUDIT_READ_METADATA;
const CONTENT = CAPABILITY.AUDIT_READ_CONTENT;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Answer = () => Response | Promise<Response>;
const answers = (status: number, body: unknown): Answer => () => json(status, body);
/** No answer at all — offline, DNS, connection refused. Not a status. */
const noAnswer: Answer = () => { throw new TypeError("Failed to fetch"); };
/** Asked, and still out when the assertion runs. */
const stillReading: Answer = () => new Promise<Response>(() => {});

const realFetch = globalThis.fetch;
// bun:test has no global stubber, so the original goes back by hand; a
// forgotten restore poisons every file that runs after this one.
const stub = (fn: unknown) => { globalThis.fetch = fn as typeof globalThis.fetch; };

const calls: Array<{ url: string; method: string }> = [];

/**
 * happy-dom's storage belongs to the whole run, not to this file.
 *
 * `AuthProvider` hydrates a session from `agent_mesh_user` at mount, so a
 * leftover one is a signed-in operator in the next test — and another file in
 * this package leaves the language set, which would make every dictionary
 * comparison below fail for a reason that has nothing to do with this screen.
 * Both are cleared per test, and whatever was in them before this file ran is
 * put back, because clobbering someone else's value is the same cross-file
 * damage in the other direction.
 */
const USER_KEY = "agent_mesh_user";
const LANG_KEY = "agent_mesh_lang";
const USER_BEFORE = localStorage.getItem(USER_KEY);
const LANG_BEFORE = localStorage.getItem(LANG_KEY);
const restoreStorage = () => {
  for (const [key, before] of [[USER_KEY, USER_BEFORE], [LANG_KEY, LANG_BEFORE]] as const) {
    if (before === null) localStorage.removeItem(key);
    else localStorage.setItem(key, before);
  }
};

let auditRoute: Answer;
let meRoute: Answer;
let keyQueueRoute: Answer;

/** What `/auth/me` answers for a session holding `capabilities`. */
const session = (capabilities: string[]) =>
  answers(200, {
    github_id: 7,
    github_login: "operator-1",
    role: "member",
    approved: true,
    tenant: "tenant_default",
    capabilities,
    created_at: "2026-01-01T00:00:00Z",
  });

beforeEach(() => {
  calls.length = 0;
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(LANG_KEY);
  // Metadata-only by default: the § 11.0 state this screen advertises in its
  // own subtitle, and the one an operator on a platform account actually has.
  meRoute = session([METADATA]);
  auditRoute = answers(200, { ok: true, events: [] });
  keyQueueRoute = answers(200, { ok: true, keys: [] });
  stub(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: (init?.method ?? "GET").toUpperCase() });
    // Answered per-URL so one route can fail while the others succeed — a
    // refusal on the audit read is told from the backend being down only when
    // the session route is still answering.
    if (url.endsWith(KEY_QUEUE)) return await keyQueueRoute();
    if (url.endsWith(ME)) return await meRoute();
    if (url.endsWith(AUDIT)) return await auditRoute();
    throw new TypeError("Failed to fetch");
  });
});

afterEach(() => {
  cleanup();
  restoreStorage();
  globalThis.fetch = realFetch;
});
afterAll(() => {
  restoreStorage();
  globalThis.fetch = realFetch;
});

const settle = async () => {
  // The mount reads resolve over several microtasks (fetch, then `.json()`,
  // then the mapping and the state writes), and two of them race here, so a
  // bare `await act(async () => {})` has not always drained them.
  await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
};

const page = (
  <I18nProvider>
    <AuthProvider>
      <RbacProvider>
        {/* The real router: the page mounts `<Breadcrumbs />`, which calls
            `useLocation`, and a module-level stub of react-router-dom would be
            installed for the whole process. */}
        <MemoryRouter initialEntries={["/tenant/audits"]}>
          <AuditLogsPage />
        </MemoryRouter>
      </RbacProvider>
    </AuthProvider>
  </I18nProvider>
);

const mount = async () => { render(page); await settle(); };

const bodyText = () => document.body.textContent ?? "";
/**
 * The `DataTable`'s one state sentence — the sibling it draws in place of rows.
 *
 * Empty while rows are on screen, which is itself the assertion that a screen
 * showing data is not also saying something about not having any.
 */
const tableStateText = () => document.querySelector("table")?.nextElementSibling?.textContent ?? "";

/**
 * Which of the four the log panel is drawing, and how much is under it.
 *
 * One object, compared whole: "it says it could not read" and "it also says
 * nothing is recorded" must not both be able to pass.
 */
const logState = () => {
  const text = tableStateText();
  return {
    loading: text.includes(LOADING),
    refused: text.includes(REFUSED),
    unreachable: text.includes(UNREACHABLE),
    empty: text.includes(EMPTY),
    rows: document.querySelectorAll("tbody tr").length,
  };
};
const quiet = { loading: false, refused: false, unreachable: false, empty: false };

const auditReads = () => calls.filter((c) => c.method === "GET" && c.url.endsWith(AUDIT));

const refresh = async () => {
  fireEvent.click(screen.getByText(REFRESH_BUTTON));
  await settle();
};

/**
 * One row, found by the identity in its human summary.
 *
 * `bodyText()` holds every value wherever it landed, so a body-wide
 * `toContain` passes with two facts in each other's slots. The row is looked up
 * by the sender it names, and its cells are then read through their column
 * headings rather than by index — a length printed under "Signature" is still a
 * sentence the screen made up, out of words the server really sent.
 */
const rowOf = (sender: string): HTMLElement => {
  const row = [...document.querySelectorAll("tbody tr")]
    .find((candidate) => candidate.querySelector("[data-testid='audit-summary']")?.textContent?.includes(sender));
  if (!row) throw new Error(`no row names ${sender} as its sender`);
  return row as HTMLElement;
};

const cellUnder = (sender: string, header: string): string => {
  const headings = [...document.querySelectorAll("thead th")].map((th) => th.textContent ?? "");
  const index = headings.indexOf(header);
  if (index < 0) throw new Error(`no column is headed ${header}`);
  return [...rowOf(sender).querySelectorAll("td")][index]?.textContent ?? "";
};

const signatureOf = (sender: string): string =>
  rowOf(sender).querySelector("[data-testid='audit-signature']")?.textContent ?? "";
const integrityTextOf = (sender: string): string =>
  rowOf(sender).querySelector("[data-testid='audit-integrity']")?.textContent ?? "";
const digestOf = (sender: string): string | null =>
  rowOf(sender).querySelector("[data-testid='audit-integrity']")?.getAttribute("data-digest") ?? null;
const summaryOf = (subject: string): string =>
  rowOf(subject).querySelector("[data-testid='audit-summary']")?.textContent ?? "";
const openOriginal = (subject: string): HTMLElement => {
  const button = [...rowOf(subject).querySelectorAll("button")]
    .find((candidate) => candidate.textContent === SHOW_ORIGINAL);
  if (!button) throw new Error(`no original-record button for ${subject}`);
  fireEvent.click(button);
  return rowOf(subject);
};

/**
 * One audit row as `audit-query.ts` shapes it: the message under
 * `payload.message`, the digest verdict under `integrity`, and the attestation
 * returned so a reader can check it themselves rather than be told it passed.
 */
const event = (over: Record<string, unknown> = {}) => ({
  event_id: "evt-1",
  schema_version: 1,
  event_type: "channel.message.received",
  occurred_at: "2026-02-03T04:05:06.000Z",
  identity: "sender-a",
  producer_id: "hub-1",
  payload: { message: { from: "sender-a", to: "recipient-b", content: "hello" } },
  payload_digest: "d".repeat(64),
  attestation: null,
  stored_at: "2026-02-03T04:05:07.000Z",
  attachments: [],
  ...over,
});

/** A message whose body is only ever this screen's to withhold or to show. */
const SECRET = "body-secret-9f3a";
const withBody = (from: string, body: string, extra: Record<string, unknown> = {}) =>
  event({
    event_id: `evt-${from}`,
    identity: from,
    payload: { message: { from, to: "recipient-b", content: body } },
    ...extra,
  });

describe("the four things the screen can say about the log", () => {
  it("says it is still reading, and says it again the second time it reads", async () => {
    auditRoute = stillReading;
    await mount();
    // A read that has not come back is not an empty log and not a failed one.
    // Every other state here is a claim about an answer that does not exist yet.
    expect(logState()).toEqual({ ...quiet, loading: true, rows: 0 });

    // An answer, so that the state below is one the screen has to take back
    // rather than one it never left.
    auditRoute = answers(200, { ok: true, events: [] });
    await refresh();
    expect(logState()).toEqual({ ...quiet, empty: true, rows: 0 });

    auditRoute = stillReading;
    await refresh();
    // The second read is out and the first one's answer is no longer known to
    // be true. A screen that raises the flag only on mount goes on showing the
    // previous answer — or, with the failure flags cleared underneath it, an
    // empty log — for as long as the new read takes.
    expect(logState()).toEqual({ ...quiet, loading: true, rows: 0 });
  });

  it("accuses nothing in the first frame an operator can see", async () => {
    auditRoute = stillReading;
    const painted: string[] = [];
    const Paint = () => {
      // A layout effect runs during the commit that mounts the tree, ahead of
      // the page's own `useEffect` — so this records the first frame that
      // exists. Nothing else can: `render` flushes passive effects before it
      // returns, and by then the read is already in flight.
      useLayoutEffect(() => { painted.push(document.body.textContent ?? ""); }, []);
      return null;
    };
    render(
      <I18nProvider>
        <AuthProvider>
          <RbacProvider>
            <MemoryRouter initialEntries={["/tenant/audits"]}>
              <AuditLogsPage />
              <Paint />
            </MemoryRouter>
          </RbacProvider>
        </AuthProvider>
      </I18nProvider>,
    );
    await settle();
    expect(painted.length).toBe(1);
    const first = painted[0] ?? "";
    // The loading flag is initialised rather than set from inside the read, and
    // that is the whole difference: started at "not loading", the first
    // committed frame tells the operator the audit log is empty before a single
    // request has left the browser.
    expect(first).toContain(LOADING);
    expect(first).not.toContain(EMPTY);
    expect(first).not.toContain(UNREACHABLE);
  });

  it("calls a refusal a refusal without exposing the server's machine key", async () => {
    // § 11.3's refusal carries the name in a field. The message here deliberately
    // does not repeat it, so a screen regexing the sentence — or reciting a
    // capability typed into its own copy — cannot pass this.
    auditRoute = answers(403, { error: "not allowed", capability: METADATA });
    await mount();
    expect(logState()).toEqual({ ...quiet, refused: true, rows: 0 });
    expect(tableStateText()).toContain(`${REFUSED}.`);
    expect(tableStateText()).not.toContain(METADATA);
  });

  it("keeps a different refusal key out of the same operator sentence", async () => {
    // The same read refused for a different grant. A screen holding its own
    // copy of the requirement was right on the day it was written and says the
    // wrong name the day the route changes.
    auditRoute = answers(403, { error: "not allowed", capability: CONTENT });
    await mount();
    const text = tableStateText();
    expect(text).toContain(`${REFUSED}.`);
    expect(text).not.toContain(CONTENT);
    expect(text).not.toContain(METADATA);
  });

  it("names no capability at all when the server named none", async () => {
    auditRoute = answers(403, { error: "not allowed" });
    await mount();
    expect(logState()).toEqual({ ...quiet, refused: true, rows: 0 });
    // The refusal sentence carries a name only in parentheses, so a screen
    // guessing one — from the route, from a role table, from the old hardcoded
    // copy — shows up here as a bracket that should not exist.
    expect(tableStateText()).not.toContain("(");
  });

  it("says the server did not answer when there was no answer", async () => {
    auditRoute = noAnswer;
    await mount();
    // `apiClient` reports this as `status: null`, which is not zero and not a
    // 4xx; anything treating a missing status as falsy lands on "refused" and
    // tells an operator to go and ask for a permission they already hold.
    expect(logState()).toEqual({ ...quiet, unreachable: true, rows: 0 });
  });

  it("does not call a broken proxy a refusal", async () => {
    // A `5xx` is the server failing, not the server saying no — the line the
    // 502-read-as-signed-out defect crossed elsewhere in this console.
    auditRoute = answers(502, { error: "Bad Gateway" });
    await mount();
    expect(logState()).toEqual({ ...quiet, unreachable: true, rows: 0 });
  });

  it("says the log is empty only when the server said so", async () => {
    auditRoute = answers(200, { ok: true, events: [] });
    await mount();
    expect(logState()).toEqual({ ...quiet, empty: true, rows: 0 });
  });
});

describe("reading it again", () => {
  it("asks the route once on mount and once more for the refresh", async () => {
    auditRoute = answers(200, { ok: true, events: [event()] });
    await mount();
    expect(auditReads().length).toBe(1);
    await refresh();
    // A button that only re-renders leaves an operator watching a snapshot from
    // whenever the tab was opened, on the one screen where staleness is the
    // question being asked.
    expect(auditReads().length).toBe(2);
  });

  it("takes the refusal back down when a later read succeeds", async () => {
    auditRoute = answers(403, { error: "not allowed", capability: METADATA });
    await mount();
    expect(logState().refused).toBe(true);
    // The grant landed between the two reads, and the log really is empty. This
    // is the case that separates "the flag was cleared" from "rows arrived on
    // top of it": a stale failure flag is invisible while there is data to draw
    // over it, and shows an operator a refusal about a request that succeeded
    // the moment there is not.
    auditRoute = answers(200, { ok: true, events: [] });
    await refresh();
    expect(logState()).toEqual({ ...quiet, empty: true, rows: 0 });
  });

  it("does not keep the last read's rows on screen when the refresh never arrived", async () => {
    auditRoute = answers(200, { ok: true, events: [event()] });
    await mount();
    expect(logState().rows).toBe(1);
    auditRoute = noAnswer;
    await refresh();
    // Rows left up after a failed refresh are indistinguishable from rows that
    // were just fetched, and on an audit screen "this is the log as of now" is
    // the entire claim. Saying so out loud is the alternative, and this screen
    // clears them and says it.
    expect(logState()).toEqual({ ...quiet, unreachable: true, rows: 0 });
  });
});

describe("the integrity verdict, and the one it never had", () => {
  it("keeps the three verdicts apart, and calls unmeasured neither intact nor tampered", async () => {
    auditRoute = answers(200, { ok: true, events: [
      withBody("sender-intact", "a", { integrity: { digest_matches: true } }),
      withBody("sender-broken", "b", { integrity: { digest_matches: false } }),
      // No `integrity` at all — an older row, or a route that did not compute
      // it. Nobody checked, which is a third state.
      withBody("sender-unmeasured", "c"),
    ] });
    await mount();
    expect({
      intact: digestOf("sender-intact"),
      broken: digestOf("sender-broken"),
      unmeasured: digestOf("sender-unmeasured"),
    }).toEqual({ intact: "matches", broken: "broken", unmeasured: "unmeasured" });

    // `digestMatches === null` read as `false` is this screen's own historical
    // defect wearing a different field: it accuses a row nobody measured of
    // tampering. Read as `true` it is worse — a pass nobody issued.
    const unmeasured = integrityTextOf("sender-unmeasured");
    expect(unmeasured).toBe(UNMEASURED);
    expect(unmeasured).not.toBe(TAMPERED);
    expect(unmeasured).not.toBe(INTACT);
    expect(integrityTextOf("sender-intact")).toBe(INTACT);
    expect(integrityTextOf("sender-broken")).toBe(TAMPERED);
  });

  it("does not read a signature_verified this mesh has never sent", async () => {
    // `signature_verified` has zero occurrences in hub, http, store, contracts
    // or SPEC — platform-claude counted them. The two rows below are identical
    // except for that phantom field, so anything the screen draws from it shows
    // up as a difference between them, whatever words it chose. Pinning a
    // literal instead would only pin today's wording; being readable at all is
    // the thing that is wrong.
    const sig = { sig: { alg: "ed25519", kid: "kid-1" } };
    auditRoute = answers(200, { ok: true, events: [
      withBody("sender-claimed", "a", { attestation: sig, signature_verified: true }),
      withBody("sender-denied", "b", { attestation: sig, signature_verified: false }),
    ] });
    await mount();
    expect(signatureOf("sender-claimed")).toBe(signatureOf("sender-denied"));
    expect(integrityTextOf("sender-claimed")).toBe(integrityTextOf("sender-denied"));
    // And neither of them turns into a measured verdict: a rotated key's row is
    // deleted, so *unverifiable* and *forged* would share one `false` and no
    // boolean here could ever have meant what the badge said it did.
    expect({ claimed: digestOf("sender-claimed"), denied: digestOf("sender-denied") })
      .toEqual({ claimed: "unmeasured", denied: "unmeasured" });
  });

  it("does not let the phantom field dress an unsigned row as a signed one", async () => {
    auditRoute = answers(200, { ok: true, events: [
      withBody("sender-a", "a", { attestation: null, signature_verified: true }),
    ] });
    await mount();
    // Compared whole rather than by absence: `"unsigned"` contains `"signed"`,
    // so a `not.toContain` here would pass on a cell reading "unsigned VERIFIED".
    expect(signatureOf("sender-a")).toBe(UNSIGNED);
  });
});

describe("what a signature cell may claim", () => {
  it("reports arrival, with the algorithm and key the attestation carried", async () => {
    auditRoute = answers(200, { ok: true, events: [
      withBody("sender-a", "a", { attestation: { sig: { alg: "ed25519", kid: "kid-1" } } }),
    ] });
    await mount();
    // Present, and what it was signed with — measured facts. The sentence stops
    // there on purpose; this route does not re-verify and says so at the line
    // that returns the attestation.
    expect(signatureOf("sender-a")).toBe(`${SIGNED} · ed25519 · kid-1`);
  });

  it("does not name an algorithm the attestation did not carry", async () => {
    auditRoute = answers(200, { ok: true, events: [
      withBody("sender-a", "a", { attestation: { sig: { kid: "kid-1" } } }),
    ] });
    await mount();
    // A default algorithm would be the screen answering a question the record
    // left open — and `ed25519` is a name an operator would check a key against.
    expect(signatureOf("sender-a")).toBe(`${SIGNED} · ${ALG_UNKNOWN} · kid-1`);
  });

  it("leaves the key out rather than printing an empty slot for it", async () => {
    auditRoute = answers(200, { ok: true, events: [
      withBody("sender-a", "a", { attestation: { sig: { alg: "ed25519" } } }),
    ] });
    await mount();
    expect(signatureOf("sender-a")).toBe(`${SIGNED} · ed25519`);
  });

  it("calls an unsigned row unsigned rather than unknown", async () => {
    auditRoute = answers(200, { ok: true, events: [withBody("sender-a", "a")] });
    await mount();
    expect(signatureOf("sender-a")).toBe(UNSIGNED);
  });
});

describe("SPEC § 11.0's content boundary", () => {
  it("withholds the body from a session that does not hold the content grant", async () => {
    // What the route actually answers a metadata-only reader: `stripContent`
    // replaces the body and keeps its length, because how much was said is
    // metadata and what was said is not.
    meRoute = session([METADATA]);
    auditRoute = answers(200, { ok: true, events: [event({
      payload: { message: {
        from: "sender-a", to: "recipient-b",
        content: "[content withheld — requires audit.read.content]",
        content_length: 4096,
      } },
    }) ] });
    await mount();
    // No record body is painted by default. The measured length remains in the
    // summary, and opening the record draws operator prose rather than the
    // server's machine sentinel.
    expect(summaryOf("sender-a")).toContain("4096 B");
    expect(screen.queryByTestId("audit-withheld")).toBe(null);
    expect(screen.queryByTestId("audit-raw-json")).toBe(null);
    openOriginal("sender-a");
    expect(screen.queryByTestId("audit-withheld")?.textContent).toBe(en("audit.held"));
    expect(screen.queryByTestId("audit-raw-json")).toBe(null);
    expect(bodyText()).not.toContain("[content withheld");
    expect(bodyText()).toContain(BANNER_WITHHELD);
    expect(bodyText()).not.toContain(BANNER_HELD);
  });

  it("shows the body only after a content reader opens the original record", async () => {
    meRoute = session([METADATA, CONTENT]);
    auditRoute = answers(200, { ok: true, events: [withBody("sender-a", SECRET)] });
    await mount();
    expect(bodyText()).not.toContain(SECRET);
    expect(screen.queryByTestId("audit-raw-json")).toBe(null);
    openOriginal("sender-a");
    expect(screen.getByTestId("audit-raw-json").textContent).toContain(SECRET);
    expect(screen.queryByTestId("audit-withheld")).toBe(null);
    expect(bodyText()).toContain(BANNER_HELD);
  });

  it("maps the server's redaction token to operator language even for a content reader", async () => {
    meRoute = session([METADATA, CONTENT]);
    auditRoute = answers(200, { ok: true, events: [withBody("sender-a", "[content withheld]")] });
    await mount();
    expect(bodyText()).not.toContain("[content withheld]");
    openOriginal("sender-a");
    expect(screen.queryByTestId("audit-withheld")?.textContent).toBe(en("audit.held"));
    expect(bodyText()).not.toContain("[content withheld]");
  });

  it("withholds it when the session's capability list says nothing is held", async () => {
    // Not hypothetical: `AuthContext` records deployments whose backend predates
    // the field, where `/auth/me` answers without `capabilities` and every
    // session reads as holding none while the server still serves content to
    // the grant it can see. The screen must fall closed on its own list.
    meRoute = session([]);
    auditRoute = answers(200, { ok: true, events: [withBody("sender-a", SECRET)] });
    await mount();
    expect(bodyText()).not.toContain(SECRET);
    openOriginal("sender-a");
    expect(screen.queryByTestId("audit-withheld")).not.toBe(null);
    expect(screen.queryByTestId("audit-raw-json")).toBe(null);
    expect(bodyText()).not.toContain(SECRET);
  });

  it("withholds it while it does not yet know what the session may read", async () => {
    // The window between mount and `/auth/me` answering. A screen that opens
    // the body first and redacts once the answer lands has already shown it.
    meRoute = stillReading;
    auditRoute = answers(200, { ok: true, events: [withBody("sender-a", SECRET)] });
    await mount();
    expect(bodyText()).not.toContain(SECRET);
    openOriginal("sender-a");
    expect(screen.queryByTestId("audit-withheld")).not.toBe(null);
    expect(bodyText()).not.toContain(SECRET);
  });

  it("still shows the metadata it is allowed to show", async () => {
    meRoute = session([METADATA]);
    auditRoute = answers(200, { ok: true, events: [withBody("sender-a", "[content withheld]", {
      attestation: { sig: { alg: "ed25519", kid: "kid-1" } },
      integrity: { digest_matches: true },
    }) ] });
    await mount();
    // Metadata-only is a reading of the log, not a refusal of it: a screen that
    // draws the redaction as an error takes the whole audit trail away from the
    // account § 11.0 wrote the mode for.
    expect(logState()).toEqual({ ...quiet, rows: 1 });
    expect(summaryOf("sender-a")).toContain("sender-a → recipient-b");
    expect(digestOf("sender-a")).toBe("matches");
    expect(signatureOf("sender-a")).toBe(`${SIGNED} · ed25519 · kid-1`);
  });
});

describe("message event summaries", () => {
  it("puts route, action, length, and time in one readable event line", async () => {
    meRoute = session([METADATA, CONTENT]);
    auditRoute = answers(200, { ok: true, events: [withBody("sender-a", SECRET)] });
    await mount();
    expect(cellUnder("sender-a", COL_EVENT)).toBe(
      `sender-a → recipient-b · ${en("audit.event.messageReceived")} · ${SECRET.length} B · 2026-02-03T04:05:06.000Z`,
    );
    expect(cellUnder("sender-a", COL_ORIGINAL)).toBe(SHOW_ORIGINAL);
    expect(bodyText()).not.toContain(SECRET);
  });

  it("does not invent a time for a row that carried none", async () => {
    auditRoute = answers(200, { ok: true, events: [{
      event_id: "evt-1",
      identity: "sender-a",
      payload: { message: { from: "sender-a", to: "recipient-b", content: "hello" } },
    }] });
    await mount();
    expect(summaryOf("sender-a")).toContain(en("audit.event.timeMissing"));
    expect(summaryOf("sender-a")).not.toContain("2026-");
  });

  it("names a carrier only when something else carried the message", async () => {
    auditRoute = answers(200, { ok: true, events: [
      event({ event_id: "evt-proxied", identity: "gateway-x", payload: { message: {
        from: "sender-proxied", to: "recipient-b", sent_by: "gateway-x", content: "hello",
      } } }),
      // Delivered by the sender itself, which is every row on a mesh where
      // nothing is proxied.
      event({ event_id: "evt-direct", identity: "sender-direct", payload: { message: {
        from: "sender-direct", to: "recipient-b", content: "hello",
      } } }),
    ] });
    await mount();
    expect(summaryOf("sender-proxied")).toContain(`${en("audit.event.carrier")} gateway-x`);
    // § 8.2 keeps the sender and the carrier as separate facts. A screen that
    // dropped the comparison would print "(carried by …)" on every row and
    // claim a proxy on a mesh that has never had one — compared whole, because
    // the carrier's name here is the sender's.
    expect(summaryOf("sender-direct")).not.toContain(en("audit.event.carrier"));
  });

  it("does not turn a recipient-less event into an unknown-to-unknown message", async () => {
    auditRoute = answers(200, { ok: true, events: [{ event_id: "evt-1", payload: {} }] });
    await mount();
    const summary = screen.getByTestId("audit-summary").textContent ?? "";
    expect(summary).toContain(en("audit.event.recorded"));
    expect(summary).not.toContain("unknown");
    expect(summary).not.toContain("→");
  });
});

describe("event-shaped audit rows", () => {
  it("describes an audit read without a fake recipient and reveals its JSON only on request", async () => {
    meRoute = session([METADATA, CONTENT]);
    const payload = {
      schema_version: 1,
      event_id: "evt-read-1",
      event_type: "mesh.identity.audit_read",
      occurred_at: "2026-08-25T03:04:05.000Z",
      correlation_id: "platform-admin",
      identity: "platform-admin",
      actor: "platform-admin",
      change: { read: "list", query: {} },
    };
    auditRoute = answers(200, { ok: true, events: [event({
      event_id: "evt-read-1",
      event_type: "mesh.identity.audit_read",
      occurred_at: "2026-08-25T03:04:05.000Z",
      identity: "platform-admin",
      payload,
    })] });

    await mount();

    expect(bodyText()).toContain("platform-admin read the audit list · 2026-08-25T03:04:05.000Z");
    expect(bodyText()).not.toContain("unknown");
    expect(bodyText()).not.toContain(JSON.stringify(payload));
    expect(screen.queryByTestId("audit-raw-json")).toBe(null);

    fireEvent.click(screen.getByRole("button", { name: "View original JSON" }));
    expect(screen.getByTestId("audit-raw-json").textContent).toContain('"event_type": "mesh.identity.audit_read"');
  });

  it("describes an identity type transition without a message route", async () => {
    auditRoute = answers(200, { ok: true, events: [event({
      event_id: "evt-type-1",
      event_type: "mesh.identity.type_changed",
      identity: "worker-1",
      payload: {
        event_type: "mesh.identity.type_changed",
        identity: "worker-1",
        change: { from: "agent", to: "service" },
      },
    })] });

    await mount();

    expect(summaryOf("worker-1")).toBe(
      `worker-1 · ${en("audit.event.identityTypeChanged")} · agent → service · 2026-02-03T04:05:06.000Z`,
    );
    expect(summaryOf("worker-1")).not.toContain("unknown");
  });
});
