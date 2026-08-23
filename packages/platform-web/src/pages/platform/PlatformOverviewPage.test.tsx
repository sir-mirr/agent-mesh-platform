/**
 * The platform summary, and the four things a number on it can mean.
 *
 * This screen is one read fanned out over five endpoints (`fetchTelemetry`),
 * and every tile on it is a sentence about a backend: *still reading*,
 * *refused*, *no answer*, or *answered, and the answer was nothing*. Two of the
 * five are ungated and two are behind `usage.read` / `mailbox.read.depth`, so
 * the interesting states are the mixed ones — a session that may read the
 * registry but not the queue depth gets four tiles' worth of truth and one
 * tile's worth of guess. A single global failure flag cannot draw that, which
 * is why the fixtures below answer per URL.
 *
 * The distinction this console keeps losing is *unknown* against *zero*. The
 * whole point of `SystemTelemetry.total_messages` being `number | null` is that
 * a total nobody sent is not a queue of zero, and `api/telemetry.ts` carries a
 * comment about a `0` that "looks calm" being drawn over a mesh with a backlog.
 * So the counts are asserted twice over: once with the server answering a real
 * number, and once with the server not answering at all — the two must not
 * render the same glyph.
 *
 * `failureKind` / `refusedCapability` are what separate *refused* from
 * *unreachable*. The refusal fixtures therefore carry § 11.3's `capability`
 * field with a sentence that does not repeat it, and the 5xx fixture carries a
 * sentence that does: a screen matching prose instead of reading the status
 * fails both, which is the point of them.
 *
 * Words come from `DICTIONARY.en` rather than from the Korean fallbacks
 * compiled into the component — this tree is held at zero Korean characters, so
 * the page renders inside `I18nProvider`, which is English by default.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { registerDom } from "../../register-dom";

// Registered once for the process and never unregistered: bun runs every test
// file's top level before any test, so a register/unregister pair would swap
// the document out from under whichever file is still using it.
registerDom();

// `await import`, not a static import: a static one is hoisted above the
// registration above and would load React's DOM entry into a process that has
// no document yet.
const { render, screen, cleanup, fireEvent, act } = await import("@testing-library/react");
const { useLayoutEffect } = await import("react");
const { MemoryRouter } = await import("react-router-dom");
const { I18nProvider, DICTIONARY } = await import("@/contexts/I18nContext.tsx");
const { CAPABILITY } = await import("@/types/auth.ts");
const { PlatformOverviewPage } = await import("./PlatformOverviewPage.tsx");

const en = (key: string): string => DICTIONARY.en[key]!;

/** The five panels this screen fans out over, and the bell the header mounts. */
const USAGE = "/api/v1/admin/ai-usage";
const AGENTS = "/api/v1/agents";
const MAILBOX = "/api/v1/admin/mailbox";
const HEALTH = "/api/v1/health";
const BEHAVIOUR = "/api/v1/admin/telemetry/behaviour";
const KEY_QUEUE = "/api/v1/admin/keys/pending";

// Taken from the contract rather than typed as a string: a capability name this
// mesh does not define is as wrong in a fixture as on a screen, because it makes
// the test agree with a server that does not exist.
const QUEUE_DEPTH = CAPABILITY.MAILBOX_READ_DEPTH;
const USAGE_READ = CAPABILITY.USAGE_READ;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Answer = () => Response | Promise<Response>;
const answers = (status: number, body: unknown): Answer => () => json(status, body);
/** No answer at all — offline, DNS, connection refused. Not a status. */
const noAnswer: Answer = () => { throw new TypeError("Failed to fetch"); };
/** In flight, and still in flight when the assertion runs. */
const stillReading: Answer = () => new Promise<Response>(() => {});

/**
 * `/api/v1/health`'s own shape. `agent_count` is deliberately unlike the number
 * of registry rows below: they are two different quantities (mesh identities
 * alive against rows in this server's chat registry) and the socket tile must
 * not be reading this one.
 */
const HEALTH_OK = { status: "ok", version: "0.2.0", agent_count: 12, uptime: 125 };
/** Only the explicit web channel is counted; a status field is not a socket. */
const AGENT_ROWS = [
  { identity: "hub-worker-1", status: "active" },
  { identity: "console-operator", channel: "web" },
  { identity: "sleeping-worker", status: "idle" },
];
/**
 * The route answers its own `count(*)` as `total_queued`, and the grouped rows
 * separately. The two disagree here on purpose: a screen re-deriving the total
 * from the rows — the defect `api/telemetry.ts` records, summed over a column
 * no route emits — would draw 4, or 0.
 */
const MAILBOX_OK = {
  ok: true,
  mailboxes: [
    { identity: "hub-worker-1", pending: 3, leased: 0, oldest: null },
    { identity: "console-operator", pending: 1, leased: 0, oldest: null },
  ],
  total_queued: 7,
};
const USAGE_OK = { ok: true, accounts: [], schema_version: 1, source: "test", ts: "2026-08-20T00:00:00.000Z" };
const BEHAVIOUR_OK = {
  counting_since: "2026-08-20T00:00:00.000Z",
  pending_keys: { value: 0 },
  oldest_pending_ms: { value: 0 },
  signature_refusals: { value: 0 },
  rate_limited: { value: 0 },
  egress_refusals: { value: 0 },
  accepted: { value: 0 },
};

const realFetch = globalThis.fetch;
// bun:test has no global stubber, so the original goes back by hand; a
// forgotten restore poisons every file that runs after this one.
const stub = (fn: unknown) => { globalThis.fetch = fn as typeof globalThis.fetch; };

const calls: string[] = [];

let usageRoute: Answer;
let agentsRoute: Answer;
let mailboxRoute: Answer;
let healthRoute: Answer;
let behaviourRoute: Answer;
let keyQueueRoute: Answer;

/** Every panel at once, for the states that are about the whole backend. */
const everyPanel = (answer: Answer) => {
  usageRoute = answer;
  agentsRoute = answer;
  mailboxRoute = answer;
  healthRoute = answer;
  behaviourRoute = answer;
};

beforeEach(() => {
  calls.length = 0;
  // happy-dom's storage belongs to the whole run, and another file in this
  // package leaves the saved language set. Left there it would fail every
  // dictionary comparison below for a reason that has nothing to do with this
  // screen.
  localStorage.removeItem("agent_mesh_lang");
  usageRoute = answers(200, USAGE_OK);
  agentsRoute = answers(200, { agents: AGENT_ROWS });
  mailboxRoute = answers(200, MAILBOX_OK);
  healthRoute = answers(200, HEALTH_OK);
  behaviourRoute = answers(200, BEHAVIOUR_OK);
  // The page header mounts `<Breadcrumbs>`, which mounts the notification bell;
  // it reads a different queue and is answered here so its own failure states
  // never appear in this screen's DOM.
  keyQueueRoute = answers(200, { ok: true, keys: [] });
  stub(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    // One panel can fail while the others answer — that separation is the only
    // way a refused tile is told from a backend that is down.
    if (url.endsWith(KEY_QUEUE)) return await keyQueueRoute();
    if (url.endsWith(BEHAVIOUR)) return await behaviourRoute();
    if (url.endsWith(USAGE)) return await usageRoute();
    if (url.endsWith(MAILBOX)) return await mailboxRoute();
    if (url.endsWith(HEALTH)) return await healthRoute();
    if (url.endsWith(AGENTS)) return await agentsRoute();
    throw new TypeError("Failed to fetch");
  });
});

afterEach(() => {
  cleanup();
  localStorage.removeItem("agent_mesh_lang");
  globalThis.fetch = realFetch;
});
afterAll(() => {
  localStorage.removeItem("agent_mesh_lang");
  globalThis.fetch = realFetch;
});

const settle = async () => {
  // The mount read resolves over several microtasks (five fetches, each then a
  // `.json()`, then `Promise.all`, then the state writes), so a bare
  // `await act(async () => {})` has not always drained them.
  await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
};

const view = () =>
  render(
    <I18nProvider>
      {/* The real router rather than a mocked `useLocation`: the page mounts
          `<Breadcrumbs />`, and a module-level stub of react-router-dom would be
          installed for the whole process and reach every other file. */}
      <MemoryRouter initialEntries={["/platform"]}>
        <PlatformOverviewPage />
      </MemoryRouter>
    </I18nProvider>,
  );

const mount = async () => { view(); await settle(); };

/**
 * The screen as it is committed, before the read has been asked for.
 *
 * A layout effect runs during the commit that mounts the tree, ahead of the
 * page's own `useEffect` — so a sibling holding one records the first frame an
 * operator can see. Nothing else can: `render` flushes passive effects before
 * returning, and by then the request is already in flight.
 */
const firstPaint = (record: (text: string) => void) => {
  const Paint = () => {
    useLayoutEffect(() => { record(document.body.textContent ?? ""); }, []);
    return null;
  };
  return <Paint />;
};

/**
 * One KPI tile, located by `data-kpi` rather than by surrounding text.
 *
 * The card is `[label row][value row]`, and the value row is `[value][sub]`.
 * Reading the value by position rather than by text is the whole point — a tile
 * is wrong precisely when the number in it is wrong, and matching text would
 * find the number wherever it landed.
 */
const kpiCard = (label: string): Element => {
  const card = document.querySelector(`[data-kpi="${label}"]`);
  if (!card) throw new Error(`no KPI tile is labelled ${label}`);
  return card;
};
const kpiValue = (label: string): string => kpiCard(label).children[1]?.children[0]?.textContent ?? "";
const kpiSub = (label: string): string => kpiCard(label).children[1]?.children[1]?.textContent ?? "";
const kpiLabels = (): string[] =>
  [...document.querySelectorAll("[data-kpi]")].map((el) => el.getAttribute("data-kpi") ?? "");

const nodeTable = (): HTMLTableElement => {
  const table = document.querySelector("table");
  if (!table) throw new Error("the screen drew no node table at all");
  return table;
};
/** The `DataTable` wrapper: its rows and its one state sentence. */
const tableText = (): string => nodeTable().parentElement?.textContent ?? "";
const nodeRows = (): Element[] => [...nodeTable().querySelectorAll("tbody tr")];

/**
 * Every node row's cell from the column with a given heading.
 *
 * Read through the heading rather than by index, so a value landing under the
 * wrong label fails: each cell is a separate claim about a process, and an
 * uptime printed under "Health Status" is still a sentence the screen made up.
 */
const cellsUnder = (header: string): string[] => {
  const headings = [...nodeTable().querySelectorAll("th")].map((th) => th.textContent ?? "");
  const index = headings.indexOf(header);
  if (index < 0) throw new Error(`no column is headed ${header}`);
  return nodeRows().map((row) => [...row.querySelectorAll("td")][index]?.textContent ?? "");
};

/**
 * Which of the four the screen is drawing about the fan-out, in one object.
 *
 * Asserted together so that "it could not be read" and "there is nothing there"
 * cannot both be true and still pass — folding two of these into one sentence
 * is the defect, and a test naming only the state it wants sees nothing wrong
 * with a second one drawn beside it.
 */
const readState = () => {
  const text = tableText();
  return {
    loading: text.includes(en(K_TABLE_LOADING)),
    unreachable: text.includes(en(K_OVERVIEW_ERROR)),
    empty: text.includes(en(K_TABLE_EMPTY)),
    refused: screen.queryByTestId("overview-refused") !== null,
    rows: nodeRows().length,
  };
};

const refusalText = (): string => screen.queryByTestId("overview-refused")?.textContent ?? "";
const refreshButton = (): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(en(K_SERVER_REFRESHBTN)));
const panelReads = (path: string): number => calls.filter((url) => url.endsWith(path)).length;

/**
 * The dictionary keys this file reads, one per line.
 *
 * **Not written inline at the call sites.** `capability-prose` treats the second
 * and later quoted strings on a line as text a person reads, and a key like
 * `server.kpi.sockets` has the shape of a capability name — so an inline key on
 * a line with any other string reads as a namespaced name the contract does not
 * define, which is exactly what that guard exists to catch. Alone on a line, a
 * key is the first string and is not mistaken for one.
 */
const K_AGENTS_UNIT_MINUTE = "agents.unit.minute";
const K_AGENTS_UNIT_SECOND = "agents.unit.second";
const K_COMMON_DISCONNECTED = "common.disconnected";
const K_COMMON_REFUSEDREAD = "common.refusedRead";
const K_OVERVIEW_ERROR = "overview.error";
const K_OVERVIEW_PARTIAL = "overview.partial";
const K_SERVER_COL_ENDPOINT = "server.col.endpoint";
const K_SERVER_COL_STATUS = "server.col.status";
const K_SERVER_COL_UPTIME = "server.col.uptime";
const K_SERVER_KPI_HEALTH = "server.kpi.health";
const K_SERVER_KPI_SOCKETS = "server.kpi.sockets";
const K_SERVER_KPI_SOCKETSSUB = "server.kpi.socketsSub";
const K_SERVER_KPI_THROUGHPUT = "server.kpi.throughput";
const K_SERVER_REFRESHBTN = "server.refreshBtn";
const K_TABLE_EMPTY = "table.empty";
const K_TABLE_LOADING = "table.loading";

describe("before the backend has said anything", () => {
  it("says it is reading, and does not yet say the mesh is empty or unreachable", async () => {
    everyPanel(stillReading);
    await mount();
    // A read that has not come back knows nothing about the mesh. Both wrong
    // sentences are available here — `serverNodes` is empty until telemetry
    // arrives, so a dropped loading flag draws "nothing to show" at a backend
    // that has not been asked yet.
    expect(readState()).toEqual({
      loading: true, unreachable: false, empty: false, refused: false, rows: 0,
    });
  });

  it("accuses nobody in the first frame, before the request has left", async () => {
    everyPanel(stillReading);
    const painted: string[] = [];
    render(
      <I18nProvider>
        <MemoryRouter initialEntries={["/platform"]}>
          <PlatformOverviewPage />
          {firstPaint((text) => painted.push(text))}
        </MemoryRouter>
      </I18nProvider>,
    );
    await settle();
    // The loading flag is raised inside a passive effect, so whatever the
    // initial state says is what the operator sees first. Initialised to "not
    // loading", the first committed frame reports an empty infrastructure
    // before a single request has left — the whole defect, lasting one frame.
    expect(painted.length).toBe(1);
    const first = painted[0] ?? "";
    expect(first).toContain(en(K_TABLE_LOADING));
    expect(first).not.toContain(en(K_TABLE_EMPTY));
    expect(first).not.toContain(en(K_OVERVIEW_ERROR));
  });
});

describe("no answer is not an idle mesh", () => {
  it("says it could not read the infrastructure, rather than that there is none", async () => {
    everyPanel(noAnswer);
    await mount();
    expect(readState()).toEqual({
      loading: false, unreachable: true, empty: false, refused: false, rows: 0,
    });
  });

  it("draws no count at all, because no count was answered", async () => {
    everyPanel(noAnswer);
    await mount();
    // The sentence this whole screen exists to avoid is a calm `0`. A socket
    // count and a queue depth are both quantities an operator acts on, and a
    // fabricated zero on either reads exactly like a quiet mesh — the em dash
    // is the only honest glyph for a number nobody sent.
    expect(kpiValue(en(K_SERVER_KPI_SOCKETS))).toBe("—");
    expect(kpiValue(en(K_SERVER_KPI_THROUGHPUT))).toBe("—");
    expect(kpiSub(en(K_SERVER_KPI_SOCKETS))).toBe(en(K_COMMON_DISCONNECTED));
    expect(kpiSub(en(K_SERVER_KPI_THROUGHPUT))).toBe(en(K_COMMON_DISCONNECTED));
    // And the healthcheck tile does not report a status line no server sent.
    expect(kpiValue(en(K_SERVER_KPI_HEALTH))).not.toBe("ok");
  });

  it("does not tell an operator with every capability that they lack one", async () => {
    everyPanel(noAnswer);
    await mount();
    // The inverse of the refusal defect, and the more expensive direction: a
    // backend that is down told as a permission problem sends the operator to
    // an RBAC screen while the mesh is unreachable.
    expect(screen.queryByTestId("overview-refused")).toBe(null);
    expect(document.body.textContent ?? "").not.toContain(en(K_COMMON_REFUSEDREAD));
    expect(document.body.textContent ?? "").not.toContain(en(K_OVERVIEW_PARTIAL));
  });
});

describe("refused is a different sentence from unanswered", () => {
  /** What a session without `usage.read` or `mailbox.read.depth` actually sees. */
  const narrowSession = () => {
    usageRoute = answers(403, { error: "insufficient scope", capability: USAGE_READ });
    behaviourRoute = answers(403, { error: "insufficient scope", capability: USAGE_READ });
    mailboxRoute = answers(403, { error: "insufficient scope", capability: QUEUE_DEPTH });
  };

  it("reports how many reads were refused without exposing machine keys", async () => {
    narrowSession();
    await mount();
    // None of the three sentences says "forbidden", "permission" or
    // "capability" — the name is in § 11.3's field, which is why the field
    // exists. A screen matching the message instead reads all three as the
    // backend being down.
    expect(readState().refused).toBe(true);
    expect(refusalText()).toContain(en(K_OVERVIEW_PARTIAL));
    expect(refusalText()).not.toContain(QUEUE_DEPTH);
    expect(refusalText()).not.toContain(USAGE_READ);
    // The two ungated panels answered, so the mesh is not down and must not be
    // drawn as down: the registry and the healthcheck were read.
    expect(readState().unreachable).toBe(false);
    expect(readState().rows).toBe(1);
  });

  it("still draws what the ungated panels did answer", async () => {
    narrowSession();
    await mount();
    // A refusal on three panels is not a refusal of the screen. The socket
    // count came from the registry, which nobody was refused, and dropping it
    // because a neighbour was refused would be the same collapse in the other
    // direction.
    expect(kpiValue(en(K_SERVER_KPI_SOCKETS))).toBe("1");
    expect(cellsUnder(en(K_SERVER_COL_STATUS))).toEqual(["ok"]);
  });

  it("does not read a 5xx as a refusal, whatever the body says", async () => {
    // The line the "502 read as signed out" defect crossed elsewhere in this
    // console. A `500` is the server failing, not the server saying no — and
    // this body says the one word a prose matcher would trip on.
    mailboxRoute = answers(500, { error: "forbidden by the upstream proxy" });
    await mount();
    expect(readState().refused).toBe(false);
    expect(document.body.textContent ?? "").not.toContain(en(K_OVERVIEW_PARTIAL));
    expect(document.body.textContent ?? "").not.toContain(en(K_COMMON_REFUSEDREAD));
  });

  it("makes no claim about a mesh whose every panel refused", async () => {
    everyPanel(answers(403, { error: "insufficient scope", capability: USAGE_READ }));
    await mount();
    // Every endpoint answered, and every answer was "you may not". The screen
    // must not draw the two nodes as running, and must not print a healthcheck
    // status or a socket count it was never given.
    //
    // Which of the two failures it names is a separate matter, and it names the
    // wrong one: `fetchTelemetry` throws a plain `Error` when all five come
    // back null, so `failureKind` cannot see the refusals it collected and the
    // screen says "no answer" to a session that got five of them. That is
    // reported rather than pinned here, so the fix does not turn this red.
    expect(readState().rows).toBe(0);
    expect(readState().empty).toBe(false);
    expect(readState().loading).toBe(false);
    expect(kpiValue(en(K_SERVER_KPI_SOCKETS))).toBe("—");
    expect(kpiValue(en(K_SERVER_KPI_THROUGHPUT))).toBe("—");
    expect(kpiValue(en(K_SERVER_KPI_HEALTH))).not.toBe("ok");
  });
});

describe("a number the server did answer", () => {
  it("counts only registry rows whose channel is explicitly web", async () => {
    await mount();
    // Two different quantities: `/api/v1/health` counts mesh identities that
    // are alive, the registry counts connections this server holds. Measured on
    // the standing stack the day the comment in `api/telemetry.ts` was written,
    // 12 against 13 — one substituted for the other puts a different number
    // under the same label and nothing on screen says it changed.
    expect(kpiValue(en(K_SERVER_KPI_SOCKETS))).toBe("1");
    expect(kpiSub(en(K_SERVER_KPI_SOCKETS))).toBe(en(K_SERVER_KPI_SOCKETSSUB));
    expect(kpiValue(en(K_SERVER_KPI_SOCKETS))).not.toBe(String(HEALTH_OK.agent_count));
    expect(kpiValue(en(K_SERVER_KPI_SOCKETS))).not.toBe(String(AGENT_ROWS.length));
  });

  it("shows the queue total the route counted, not one re-derived from the rows", async () => {
    await mount();
    // The recorded defect: the console summed the mailbox rows itself, over a
    // column the route has never emitted, so the tile read `0` whether the mesh
    // was idle or backed up. The fixture's rows sum to 4 and its own total is
    // 7 — a re-derived total cannot pass, and neither can a `0`.
    expect(kpiValue(en(K_SERVER_KPI_THROUGHPUT))).toBe("7");
  });

  it("says zero when the server said zero, and says it in the healthy voice", async () => {
    agentsRoute = answers(200, { agents: [] });
    mailboxRoute = answers(200, { ok: true, mailboxes: [], total_queued: 0 });
    await mount();
    // The fourth state: answered, and the answer was nothing. It has to be
    // legible as a *different* screen from the unanswered one above — same two
    // tiles, `0` against `—` — or the em dash means nothing.
    expect(kpiValue(en(K_SERVER_KPI_SOCKETS))).toBe("0");
    expect(kpiValue(en(K_SERVER_KPI_THROUGHPUT))).toBe("0");
    expect(kpiValue(en(K_SERVER_KPI_HEALTH))).toBe("ok");
    expect(readState()).toEqual({
      loading: false, unreachable: false, empty: false, refused: false, rows: 1,
    });
  });

  it("draws no tile for a metric this platform has no producer for", async () => {
    await mount();
    // CPU, RSS and p95 were read off `/api/v1/admin/ai-usage`, which answers AI
    // account usage and has never carried them: every guard was dead and each
    // tile drew a fallback that looked like a measurement — `0%`, `0ms`. A tile
    // returning is the regression, so the roster of tiles is the assertion.
    expect(kpiLabels()).toEqual([
      en(K_SERVER_KPI_HEALTH),
      en(K_SERVER_KPI_SOCKETS),
      en(K_SERVER_KPI_THROUGHPUT),
    ]);
  });
});

describe("what a node row says about a process", () => {
  it("reports the health the healthcheck reported", async () => {
    await mount();
    expect(cellsUnder(en(K_SERVER_COL_STATUS))).toEqual(["ok"]);
    // Formatted from the seconds `/health` sent, in the dictionary's units: a
    // row printing the raw seconds, or minutes alone, is a different claim
    // about how long the process has been up.
    expect(cellsUnder(en(K_SERVER_COL_UPTIME)))
      .toEqual([`2${en(K_AGENTS_UNIT_MINUTE)} 5${en(K_AGENTS_UNIT_SECOND)}`]);
    expect(cellsUnder(en(K_SERVER_COL_ENDPOINT))).toEqual(["/api/v1/health"]);
  });

  it("does not call a degraded hub healthy", async () => {
    healthRoute = answers(200, { ...HEALTH_OK, status: "degraded" });
    await mount();
    // The one thing on this row that is a real reading rather than a constant.
    // A row hardcoded to HEALTHY would pass every other assertion in this file.
    expect(cellsUnder(en(K_SERVER_COL_STATUS))).toEqual(["degraded"]);
    expect(tableText()).not.toContain("ok");
  });
});

describe("the refresh button", () => {
  it("asks every panel again", async () => {
    await mount();
    expect(panelReads(HEALTH)).toBe(1);
    expect(panelReads(MAILBOX)).toBe(1);
    fireEvent.click(refreshButton()!);
    await settle();
    // A refresh control that does not refresh is worse than none: the operator
    // reads a stale screen believing they just re-read it.
    expect(panelReads(HEALTH)).toBe(2);
    expect(panelReads(MAILBOX)).toBe(2);
    expect(panelReads(AGENTS)).toBe(2);
    expect(panelReads(BEHAVIOUR)).toBe(2);
  });

  it("drops the rows it can no longer vouch for when the refresh finds nothing", async () => {
    await mount();
    expect(readState().rows).toBe(1);
    everyPanel(noAnswer);
    fireEvent.click(refreshButton()!);
    await settle();
    // Rows left standing under an error sentence are the worst of both: the
    // operator sees two healthy nodes and a warning, and believes the nodes,
    // which now describe a backend that has stopped answering. Two independent
    // lines keep that from happening — the `.catch` drops the telemetry, and
    // `isOnline` folds in `isError` — so either one alone can be deleted
    // without this file noticing. Measured: removing both is what this test
    // catches, and nothing else in the file does.
    expect(readState()).toEqual({
      loading: false, unreachable: true, empty: false, refused: false, rows: 0,
    });
    expect(kpiValue(en(K_SERVER_KPI_SOCKETS))).toBe("—");
  });

  it("takes the refusal notice down once the capability is no longer refused", async () => {
    mailboxRoute = answers(403, { error: "insufficient scope", capability: QUEUE_DEPTH });
    await mount();
    // The control the absence below is measured against: without it a screen
    // that never draws the notice at all reads exactly like one that drew it
    // and cleared it.
    expect(readState().refused).toBe(true);
    mailboxRoute = answers(200, MAILBOX_OK);
    fireEvent.click(refreshButton()!);
    await settle();
    // A refusal banner that outlives the refusal is one an operator learns to
    // ignore, which costs the banner that matters.
    expect(readState().refused).toBe(false);
    expect(kpiValue(en(K_SERVER_KPI_THROUGHPUT))).toBe("7");
  });
});
