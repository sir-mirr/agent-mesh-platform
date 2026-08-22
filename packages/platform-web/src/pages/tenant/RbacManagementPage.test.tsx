/**
 * The capability matrix: where its columns come from, and the four different
 * things an empty one can mean.
 *
 * ## The columns are the server's list, not a copy
 *
 * `GET /api/v1/admin/grants` answers the cells **and the vocabulary** — the
 * route's own comment says a screen building a matrix needs the columns as much
 * as the cells, "which is how a capability added here would quietly never
 * appear there". So the test that matters is not that chips render; it is that
 * the chips are exactly the names the answer carried, and that a name the
 * contract defines but this answer withheld draws nothing. A screen holding
 * `ALL_CAPABILITIES` passes every count-the-chips assertion and fails those two.
 *
 * ## Two reads, and each of them can fail on its own
 *
 * The map is one route; the roles beside it are another (`/api/v1/admin/users`,
 * gated on a different capability), asked separately and allowed to fail — a
 * viewer who may read grants but not accounts still gets the table. That is
 * only true if the second read's failure stays inside the second read, so the
 * fixtures below drive the two routes independently. A page with one shared
 * error flag draws the mixed case wrong, and the mixed case is what a narrower
 * session actually sees.
 *
 * ## The four
 *
 * *loading*, *refused*, *unreachable*, *empty* are four different sentences
 * about the backend and this console's recurring defect is collapsing them —
 * "nobody is here" drawn about a server that never answered. `failureKind` and
 * `refusedCapability` are what separate the middle two, so the refusal fixtures
 * carry § 11.3's `capability` field with a sentence that does **not** repeat the
 * name. The running route's sentence does repeat it (`Missing capability: …`),
 * so a fixture copying the real body could not tell a field read from a regex
 * over the message. That is the whole point of these fixtures, so they diverge.
 *
 * Each state is asserted as *which of the four*, in one object, rather than as
 * the presence of the right one: a test naming only the notice it wants sees
 * nothing wrong with a second one drawn beside it, and "beside it" is how the
 * defect reads on a real page.
 *
 * The words compared against are `DICTIONARY.en`'s. This tree is held at zero
 * Korean characters, so the page renders inside `I18nProvider` (English by
 * default) and the expectations come from the dictionary rather than from the
 * Korean fallbacks compiled into the component.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Registered once for the process and never unregistered: bun runs every test
// file's top level before it runs any test, so a register/unregister pair swaps
// the document out from under whichever file is still using it.
if (!(globalThis as { document?: unknown }).document) GlobalRegistrator.register();

// `await import`, never a statement: a static import is hoisted above the
// registration above and would load React's DOM entry with no document present.
const { render, screen, cleanup, fireEvent, act } = await import("@testing-library/react");
const { useLayoutEffect } = await import("react");
const { MemoryRouter } = await import("react-router-dom");
const { I18nProvider, DICTIONARY } = await import("@/contexts/I18nContext.tsx");
const { AuthProvider } = await import("@/contexts/AuthContext.tsx");
const { RbacProvider } = await import("@/contexts/RbacContext.tsx");
const { CAPABILITY, ALL_CAPABILITIES } = await import("@/types/auth.ts");
const { RbacManagementPage, capabilityLabel } = await import("./RbacManagementPage.tsx");

const ME = "/auth/me";
const GRANTS = "/api/v1/admin/grants";
/** The roles beside the map — a second route, behind a different capability. */
const USERS = "/api/v1/admin/users";
/** The bell inside `<Breadcrumbs>`; it must keep answering while a panel fails. */
const BELL = "/api/v1/admin/keys/pending";

// Taken from the contract rather than typed as strings: a capability name this
// mesh does not define is as wrong in a fixture as on a screen, because it makes
// the test agree with a server that does not exist.
const GRANT = CAPABILITY.ROLE_GRANT;
const PROVISION = CAPABILITY.AGENT_PROVISION;
const META = CAPABILITY.AUDIT_READ_METADATA;
const CONTENT = CAPABILITY.AUDIT_READ_CONTENT;
const ADMIT = CAPABILITY.USER_ADMIT;

/**
 * The columns this fixture's server sends — deliberately a strict subset.
 *
 * If it were the whole contract, a screen drawing `ALL_CAPABILITIES` would be
 * indistinguishable from one drawing the answer, and that is the single thing
 * this screen's comment says it is for.
 */
const VOCABULARY: string[] = [GRANT, PROVISION, META];

const LOADING = DICTIONARY.en["table.loading"]!;
const EMPTY = DICTIONARY.en["rbac.empty"]!;
const UNREACHABLE = DICTIONARY.en["rbac.error"]!;
const REFUSED = DICTIONARY.en["common.refusedRead"]!;
const HEADING_UNREACHABLE = DICTIONARY.en["common.unreachable"]!;
const GRANTED = DICTIONARY.en["rbac.toast.granted"]!;
const REVOKED = DICTIONARY.en["rbac.toast.revoked"]!;
const WRITE_FAILED = DICTIONARY.en["rbac.toast.failed"]!;
const NEEDS_GRANT = DICTIONARY.en["rbac.needs.grant"]!;
/** What the role cell says when it has no role to say: an em dash. */
const NO_ROLE = "—";
/** The mark a chip wears when the subject holds the capability. */
const HELD_MARK = "✓";
/** The separator the toast puts between subject and capability. */
const DOT = "·";
const friendly = (capability: string): string =>
  capabilityLabel((key, fallback) => DICTIONARY.en[key] ?? fallback, capability);

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Answer = () => Response | Promise<Response>;
const answers = (status: number, body: unknown): Answer => () => json(status, body);
/** No answer at all — offline, DNS, connection refused. Not a status. */
const noAnswer: Answer = () => { throw new TypeError("Failed to fetch"); };
/** Asked, and still out when the assertion runs. */
const stillReading: Answer = () => new Promise<Response>(() => {});

const realFetch = globalThis.fetch;
/** bun:test has no global stubber, so the original goes back by hand — a
 *  forgotten restore poisons every file that runs after this one. */
const stub = (fn: unknown) => { globalThis.fetch = fn as typeof globalThis.fetch; };

const calls: Array<{ url: string; method: string; body: string | null }> = [];

/** What `/auth/me` says this session holds. */
let held: string[] = [GRANT];
/** What each successive `GET /api/v1/admin/grants` answers; the last one repeats. */
let mapReads: Answer[] = [];
let mapReadCount = 0;
let writeGrant: Answer;
let removeGrant: Answer;
let readAccounts: Answer;

const session = (capabilities: string[]) => ({
  github_id: 3,
  github_login: "operator-1",
  role: "member",
  approved: true,
  tenant: "tenant_default",
  capabilities,
  created_at: "2026-01-01T00:00:00Z",
});

/** One cell of the map, in the shape the route flattens its rows into. */
const cell = (subject: string, capability: string) => ({ subject, capability, scope: "*" });

/** The whole answer: the cells, and the columns to draw them under. */
const mapOf = (grants: ReturnType<typeof cell>[]) =>
  ({ ok: true, capabilities: VOCABULARY, grants });

/** `ada` holds one thing; `svc-runner` holds another and has no account. */
const CELLS = [cell("ada", GRANT), cell("svc-runner", PROVISION)];
/** The accounts the roster route knows about — `grace` holds no grant at all. */
const ROSTER = [
  { username: "ada", display_name: "Ada L", role: "admin" },
  { username: "grace", role: "member" },
];

beforeEach(() => {
  calls.length = 0;
  held = [GRANT];
  mapReadCount = 0;
  mapReads = [answers(200, mapOf(CELLS))];
  writeGrant = answers(201, { ok: true });
  removeGrant = answers(200, { ok: true, action: "deleted" });
  readAccounts = answers(200, { ok: true, users: ROSTER });
  // `AuthProvider` hydrates from storage and `I18nProvider` reads a saved
  // language out of it; happy-dom's storage belongs to the process, so a
  // leftover from another file would be a signed-in user or a second language.
  localStorage.clear();
  stub(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method, body: typeof init?.body === "string" ? init.body : null });
    if (url.endsWith(ME)) return json(200, session(held));
    if (url.endsWith(BELL)) return json(200, { ok: true, keys: [] });
    // Answered per route, so one can fail while the others succeed — that
    // separation is what tells a refused panel from a backend that is down.
    if (url.endsWith(USERS)) return await readAccounts();
    if (url.endsWith(GRANTS)) {
      if (method === "POST") return await writeGrant();
      if (method === "DELETE") return await removeGrant();
      const answer = mapReads[Math.min(mapReadCount, mapReads.length - 1)]!;
      mapReadCount += 1;
      return await answer();
    }
    throw new TypeError("Failed to fetch");
  });
});

afterEach(() => { cleanup(); localStorage.clear(); globalThis.fetch = realFetch; });
// What this file wrote into process-wide storage comes back out for everyone
// else in the run, not just for the next test in here.
afterAll(() => { localStorage.clear(); globalThis.fetch = realFetch; });

const settle = async () => {
  // A mount read resolves over several microtasks (fetch, then `.json()`, then
  // the grouping) and `/auth/me` writes state after its own, so a bare
  // `await act(async () => {})` has not always drained them.
  await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
};

const tree = (extra?: React.ReactNode) => (
  // The real router, at the path the page is mounted at: `<Breadcrumbs>` reads
  // `useLocation`, and a module-level stub of react-router-dom would be
  // installed for the whole process and reach every other file.
  <MemoryRouter initialEntries={["/tenant/rbac"]}>
    <I18nProvider>
      <AuthProvider>
        <RbacProvider>
          <RbacManagementPage />
          {extra}
        </RbacProvider>
      </AuthProvider>
    </I18nProvider>
  </MemoryRouter>
);

const mount = async () => { render(tree()); await settle(); };

/**
 * The screen as it is committed, before either read has been asked for.
 *
 * A layout effect runs during the commit that mounts the tree, ahead of the
 * page's own `useEffect` — so a sibling holding one records the first frame an
 * operator can see. Nothing else can: `render` flushes the passive effects
 * before returning, and by then both reads are in flight.
 */
const firstPaint = (record: (text: string) => void) => {
  const Paint = () => {
    useLayoutEffect(() => { record(document.body.textContent ?? ""); }, []);
    return null;
  };
  return <Paint />;
};

const tableEl = (): HTMLElement => {
  const el = document.querySelector("table");
  if (!el) throw new Error("the page drew no table at all");
  return el as HTMLElement;
};

/**
 * The one line the table draws in place of rows — loading, refused, unreachable
 * or empty.
 *
 * Scoped to the table rather than to the body: the page's subtitle and the
 * chips both carry capability names, so a body-wide search would match them and
 * pass whatever the failed panel actually said.
 */
const statusLine = (): string => {
  const line = [...(tableEl().parentElement?.children ?? [])].find((c) => c.tagName !== "TABLE");
  return line?.textContent ?? "";
};

const subjects = (): string[] =>
  [...document.querySelectorAll('[data-testid^="rbac-subject-"]')].map((el) => el.textContent ?? "");

/**
 * Which of the four the matrix is drawing, and what is under it.
 *
 * One object, so that "it says it could not read" and "it also says nobody
 * holds anything" cannot both be true and still pass.
 */
const matrix = () => {
  const line = statusLine();
  return {
    loading: line.includes(LOADING),
    refused: line.includes(REFUSED),
    unreachable: line.includes(UNREACHABLE),
    empty: line.includes(EMPTY),
    subjects: subjects(),
  };
};

const heading = (): string => document.querySelector("h3")?.textContent ?? "";

const roleOf = (subject: string): string | null =>
  screen.queryByTestId(`rbac-role-${subject}`)?.textContent ?? null;

const chip = (subject: string, capability: string): HTMLButtonElement | null =>
  (screen.queryByTestId(`rbac-cap-${subject}-${capability}`) as HTMLButtonElement | null);

/** The columns offered on one row, read back off the test ids that name them. */
const chipsOn = (subject: string): string[] => {
  const prefix = `rbac-cap-${subject}-`;
  return [...document.querySelectorAll(`[data-testid^="${prefix}"]`)]
    .map((el) => (el.getAttribute("data-testid") ?? "").slice(prefix.length));
};

/** Whether the cell says the subject holds it — the mark, not the name beside it. */
const holds = (subject: string, capability: string): boolean | null => {
  const el = chip(subject, capability);
  return el === null ? null : (el.textContent ?? "").startsWith(HELD_MARK);
};

/**
 * The toast, found by its shape rather than by its words.
 *
 * `Toast` carries no test id. Searching for the words instead would make every
 * negative assertion below vacuous — a page that drew no toast at all would
 * satisfy "it does not say the grant was given".
 */
const TOAST_ICONS = [HELD_MARK, "✕", "!", "ℹ"];
const toastEl = (): HTMLElement | null =>
  ([...document.querySelectorAll("div")] as HTMLElement[]).find((d) => {
    const first = d.firstElementChild;
    return d.children.length === 3
      && first?.tagName === "SPAN"
      && TOAST_ICONS.includes(first.textContent ?? "")
      && d.lastElementChild?.tagName === "BUTTON";
  }) ?? null;
/** The sentence the toast is making, or `""` when there is no toast. */
const toastMessage = (): string => toastEl()?.children[1]?.textContent ?? "";

const grantWrites = () => calls.filter((c) => c.method === "POST" && c.url.endsWith(GRANTS));
const grantRemovals = () => calls.filter((c) => c.method === "DELETE" && c.url.endsWith(GRANTS));
const bodyOf = (call: { body: string | null } | undefined): unknown =>
  JSON.parse(call?.body ?? "null");

describe("the four things an empty matrix can mean", () => {
  it("accuses nobody in the frame before the map has been asked for", async () => {
    mapReads = [stillReading];
    readAccounts = stillReading;
    const painted: string[] = [];
    render(tree(firstPaint((text) => painted.push(text))));
    await settle();
    expect(painted.length).toBe(1);
    const first = painted[0] ?? "";
    // `isLoading` starts `true`. Initialised the other way, the first committed
    // frame tells the operator that nobody in the tenant holds anything —
    // before a single request has left — which is this console's defect lasting
    // one frame.
    expect({
      empty: first.includes(EMPTY),
      refused: first.includes(REFUSED),
      unreachable: first.includes(UNREACHABLE),
    }).toEqual({ empty: false, refused: false, unreachable: false });
    expect(matrix()).toEqual({
      loading: true, refused: false, unreachable: false, empty: false, subjects: [],
    });
  });

  it("says the account may not read the map without exposing the machine key", async () => {
    // § 11.3's refusal carries `capability` as a field precisely so a client
    // does not parse it out of the sentence — and the sentence here does not
    // carry it, so a screen regexing the message cannot pass this.
    mapReads = [answers(403, { ok: false, error: "not allowed", capability: GRANT })];
    await mount();
    expect(matrix()).toEqual({
      loading: false, refused: true, unreachable: false, empty: false, subjects: [],
    });
    expect(statusLine()).toContain(`${REFUSED}.`);
    expect(statusLine()).not.toContain(GRANT);
  });

  it("names no capability when the server named none", async () => {
    mapReads = [answers(403, { ok: false, error: "not allowed" })];
    await mount();
    expect(matrix().refused).toBe(true);
    // Nine screens on this console had the missing name typed into their own
    // copy, and the dictionary still holds one such sentence with `role.grant`
    // written into it. A hardcoded parenthetical shows up right here.
    expect(statusLine()).toContain(`${REFUSED}.`);
    expect(statusLine()).not.toContain("(");
  });

  it("does not call a broken proxy a refusal", async () => {
    // A `5xx` is the server failing, not the server saying no. This is the line
    // the 502-read-as-signed-out defect crossed elsewhere in this console.
    mapReads = [answers(502, { error: "bad gateway" })];
    await mount();
    expect(matrix()).toEqual({
      loading: false, refused: false, unreachable: true, empty: false, subjects: [],
    });
  });

  it("says the server did not answer when there was no answer at all", async () => {
    mapReads = [noAnswer];
    await mount();
    expect(matrix()).toEqual({
      loading: false, refused: false, unreachable: true, empty: false, subjects: [],
    });
  });

  it("says nobody holds a grant only when both routes answered and said so", async () => {
    mapReads = [answers(200, mapOf([]))];
    readAccounts = answers(200, { ok: true, users: [] });
    await mount();
    expect(matrix()).toEqual({
      loading: false, refused: false, unreachable: false, empty: true, subjects: [],
    });
    expect(heading()).toContain("(0)");
  });

  it("counts beside the heading the rows it actually drew", async () => {
    await mount();
    // Two cells and three subjects: a heading counting the grants rather than
    // the people would say `(2)` about three rows.
    expect(subjects().length).toBe(3);
    expect(heading()).toContain(`(${subjects().length})`);
  });

  /**
   * **Recorded, not endorsed.** This is a defect, reported alongside this file.
   *
   * The table says the right sentence — the account may not read the map — while
   * the heading one line above it says the server could not be reached, about a
   * server that answered `403`. That is the collapse this whole file is written
   * against, surviving in the one place the four states are not drawn by
   * `DataTable`. Delete this test when the heading learns the difference.
   */
  it("still labels the heading unreachable when the server refused", async () => {
    mapReads = [answers(403, { ok: false, error: "not allowed", capability: GRANT })];
    await mount();
    expect(matrix().refused).toBe(true);
    expect(heading()).toContain(HEADING_UNREACHABLE);
  });
});

describe("the vocabulary comes from the server with the map", () => {
  it("draws a column for each name the answer carried, and for no other", async () => {
    await mount();
    expect(chipsOn("ada")).toEqual(VOCABULARY);
    // The contract defines more names than this answer sent. Without that gap
    // a screen compiling its own copy would be indistinguishable from one
    // reading the response — which is the defect the route's own comment names.
    expect(ALL_CAPABILITIES.length).toBeGreaterThan(VOCABULARY.length);
    expect(chip("ada", CONTENT)).toBe(null);
    for (const capability of VOCABULARY) {
      expect(chip("ada", capability)?.textContent).toContain(friendly(capability));
      expect(document.body.textContent ?? "").not.toContain(capability);
    }
  });

  it("offers nothing to toggle when the answer carried no vocabulary at all", async () => {
    // An older server that does not send the field. The columns are then
    // unknown, and unknown is not `ALL_CAPABILITIES`: a fallback there offers an
    // operator names this deployment may not have.
    mapReads = [answers(200, { ok: true, grants: CELLS })];
    await mount();
    expect(subjects()).toEqual(["ada", "svc-runner", "grace"]);
    expect(chipsOn("ada")).toEqual([]);
  });

  it("marks a capability held for the subject the grant names, and for no one else", async () => {
    await mount();
    // A screen keying the mark off the capability rather than off the pair
    // draws every row identically, and every word on it is still a word the
    // server sent.
    expect(holds("ada", GRANT)).toBe(true);
    expect(holds("ada", PROVISION)).toBe(false);
    expect(holds("svc-runner", PROVISION)).toBe(true);
    expect(holds("svc-runner", GRANT)).toBe(false);
    expect(holds("grace", GRANT)).toBe(false);
  });

  it("gives a person holding nothing a row, so a first capability can be given", async () => {
    await mount();
    // Somebody admitted five minutes ago has no grants, which is how everyone
    // starts. Rows taken from the grants alone left them off the screen, and
    // there was then no way to give them their first one.
    expect(subjects()).toContain("grace");
    expect(chipsOn("grace")).toEqual(VOCABULARY);
    expect(holds("grace", GRANT)).toBe(false);
  });

  it("asks the map for the columns and the accounts for the roles, once each", async () => {
    await mount();
    expect(calls.filter((c) => c.method === "GET" && c.url.endsWith(GRANTS)).length).toBe(1);
    expect(calls.filter((c) => c.method === "GET" && c.url.endsWith(USERS)).length).toBe(1);
  });
});

describe("the role column, and the second read that fills it", () => {
  it("shows the role the accounts route gave, for the account it gave it for", async () => {
    await mount();
    expect(roleOf("ada")).toBe("admin");
    expect(roleOf("grace")).toBe("member");
  });

  it("says it does not know, rather than a role, for a subject with no account", async () => {
    await mount();
    // Every subject the grants list named used to be printed as one role the
    // client had chosen, including subjects the server has no account for.
    expect(roleOf("svc-runner")).toBe(NO_ROLE);
  });

  it("keeps the map when the accounts route refuses, and invents no roles", async () => {
    readAccounts = answers(403, { ok: false, error: "not allowed", capability: ADMIT });
    await mount();
    // A viewer who may read grants but not accounts still gets the table. A
    // page with one shared error flag would draw the refusal of the second read
    // over the answer of the first.
    expect(matrix()).toEqual({
      loading: false, refused: false, unreachable: false, empty: false,
      subjects: ["ada", "svc-runner"],
    });
    expect([roleOf("ada"), roleOf("svc-runner")]).toEqual([NO_ROLE, NO_ROLE]);
  });

  it("does not decide the mesh has no members when the accounts route never answers", async () => {
    readAccounts = noAnswer;
    await mount();
    // The rows stay as the grants described them rather than this screen
    // deciding the roster is empty. `grace` is gone because only the unanswered
    // route knew about her — that is absence of evidence, drawn as absence.
    expect(subjects()).toEqual(["ada", "svc-runner"]);
    expect(matrix().empty).toBe(false);
  });

  /**
   * **Recorded, not endorsed.** Reported alongside this file.
   *
   * The grants route answered, and answered with nothing; that sentence is
   * true. The accounts route was never reached, and the screen says nothing at
   * all about it — with no rows there are no em dashes either, so the one place
   * that read's failure was visible has gone. What the operator sees is a
   * settled, complete-looking "nobody holds a grant" over half a page of data
   * that could not be read.
   */
  it("says the roster is empty while saying nothing about the roster read that failed", async () => {
    mapReads = [answers(200, mapOf([]))];
    readAccounts = noAnswer;
    await mount();
    expect(matrix()).toEqual({
      loading: false, refused: false, unreachable: false, empty: true, subjects: [],
    });
  });
});

describe("giving a capability and taking it back", () => {
  it("writes the grant the server's own vocabulary named, over the whole tenant", async () => {
    mapReads = [
      answers(200, mapOf(CELLS)),
      answers(200, mapOf([...CELLS, cell("grace", META)])),
    ];
    await mount();
    fireEvent.click(chip("grace", META)!);
    await settle();
    expect(grantWrites().length).toBe(1);
    expect(bodyOf(grantWrites()[0])).toEqual({ subject: "grace", capability: META, scope: "*" });
    // Subject and capability both land in the toast, so the two being exchanged
    // fails here rather than reading as a sentence made of the server's words.
    expect(toastMessage()).toBe(`${GRANTED}: grace ${DOT} ${friendly(META)}`);
    // And the matrix redraws from a second read of the map.
    expect(mapReadCount).toBe(2);
    expect(holds("grace", META)).toBe(true);
  });

  it("re-reads after a revoke rather than trusting its own copy of the cell", async () => {
    // `DELETE` answers `200` whether or not the grant was there and says which
    // in `action`. `not-found` means the cell on screen disagreed with the
    // server, so what the operator must end up looking at is the server's map.
    removeGrant = answers(200, { ok: true, action: "not-found" });
    await mount();
    expect(holds("ada", GRANT)).toBe(true);
    fireEvent.click(chip("ada", GRANT)!);
    await settle();
    expect(grantRemovals().length).toBe(1);
    expect(bodyOf(grantRemovals()[0])).toEqual({ subject: "ada", capability: GRANT, scope: "*" });
    expect(mapReadCount).toBe(2);
    // A screen that turned the cell off locally would now say `ada` holds
    // nothing, about a server that still says she does.
    expect(holds("ada", GRANT)).toBe(true);
    expect(toastMessage()).toBe(`${REVOKED}: ada ${DOT} ${friendly(GRANT)}`);
  });

  it("does not say the grant changed when the server refused the write", async () => {
    writeGrant = answers(403, { ok: false, error: "not allowed", capability: GRANT });
    await mount();
    fireEvent.click(chip("grace", META)!);
    await settle();
    // `SC-WRITE-10`'s shape: a state update below the `try` runs on every path,
    // and the screen then reports a change the server blocked while the other
    // side still holds nothing.
    expect(toastMessage()).toContain(WRITE_FAILED);
    expect(toastMessage()).not.toContain(GRANTED);
    expect(holds("grace", META)).toBe(false);
    // Nothing was re-read either: the map on screen is still the answered one.
    expect(mapReadCount).toBe(1);
  });

  it("does not say the grant changed when the write never reached the server", async () => {
    writeGrant = noAnswer;
    await mount();
    fireEvent.click(chip("grace", META)!);
    await settle();
    // Granted-in-the-browser-only is the worst of the three: the operator reads
    // that the capability was given and stops watching an account that has it
    // not.
    expect(toastMessage()).toContain(WRITE_FAILED);
    expect(toastMessage()).not.toContain(GRANTED);
    expect(holds("grace", META)).toBe(false);
    expect(mapReadCount).toBe(1);
  });

  it("offers the write to a session the server gave the granting capability to", async () => {
    await mount();
    // The control the refusal below is measured against: without it, a screen
    // that disables every cell always would pass that test and be useless.
    const enabled = chip("grace", GRANT);
    expect(enabled?.disabled).toBe(false);
    expect(enabled?.getAttribute("title")).toBe(GRANTED);
  });

  it("offers no write to a session that was not given it", async () => {
    held = [META];
    await mount();
    // Every cell on the row, not one of them: a screen that disabled only the
    // ones already held would still let a capability be handed out by somebody
    // the server never authorised to hand any out.
    expect(VOCABULARY.map((capability) => chip("grace", capability)?.disabled))
      .toEqual(VOCABULARY.map(() => true));
    // The title is where the reason lives; without it a dead row is just a
    // screen that looks broken.
    expect(chip("grace", GRANT)?.getAttribute("title")).toBe(NEEDS_GRANT);
    // **The `if (!canGrant) return` behind these cells is deliberately not
    // asserted here.** React does not deliver a click to a disabled button, so
    // a test that clicked one and then found no request would pass with that
    // guard deleted — measured, as a surviving mutant. What actually holds the
    // write back on this screen is the attribute above, and that is what is
    // measured instead of a line that no click can reach.
  });
});

describe("the words on the screen are the dictionary's", () => {
  it("draws no Korean of its own with the language left at English", async () => {
    await mount();
    // Every string on this page has a Korean fallback compiled in beside its
    // key, reached the moment a key is missing from the English dictionary. The
    // fixtures above are ASCII, so any Hangul on the page is the screen's own.
    // Written as code points, not as characters: this tree is scanned for
    // Hangul, and a scan cannot tell a literal asserting its absence from one
    // that is the thing being looked for.
    const hasHangul = (text: string): boolean =>
      // Compared by code point rather than matched by a regexp. The range has
      // to be written somehow, and `SC-I18N-06` reads a `\u` escape as text
      // wherever it cannot see that it is an escape — a regexp literal is one
      // of those places. Numbers say the same thing and cannot be misread.
      [...text].some((ch) => {
        const code = ch.codePointAt(0) ?? 0;
        return code >= 0xac00 && code <= 0xd7a3;
      });
    const text = document.body.textContent ?? "";
    expect(hasHangul(text)).toBe(false);
    expect(text).toContain(DICTIONARY.en["rbac.title"]!);
  });
});
