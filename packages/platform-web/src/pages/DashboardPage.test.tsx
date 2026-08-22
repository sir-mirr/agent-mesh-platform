/**
 * What the landing console says about a backend it has not heard from.
 *
 * This screen is four panels behind one role switch, and every one of them
 * draws counts. A count is the easiest place in this product to tell a lie:
 * `0` is a statement about the mesh, and three of the four things that can put
 * it on screen are not answers — the request is still out, the server refused
 * it, or nothing answered at all. The page's own comments record that landing
 * twice here ("Owned Agents 0" on a refused read, and `0` for two and a half
 * seconds on a slow link), so the four states are what this file measures:
 *
 *     loading      the question is out and nothing has come back
 *     refused      the server answered, and said no
 *     unreachable  there was no answer to read
 *     empty        the server answered, and there is nothing there
 *
 * Every test therefore asserts both halves: which of the four the panel draws,
 * and which of the other three it does **not** say. A positive alone passes on
 * a screen that draws all four at once.
 *
 * ## Why `fetch` and not the api modules
 *
 * `mock.module` is installed on the process, and every module this page reads
 * (`api/agents.ts`, `api/telemetry.ts`, `api/groups.ts`, `api/mailbox.ts`) has
 * its own test file that imports the real one at top level. So the fake goes in
 * at the network, one map from path to answer, which is also the only way to
 * have one panel refused while the panel beside it succeeds — the distinction
 * the whole file is about.
 *
 * ## Which panels a session can actually reach
 *
 * The server issues `admin` or nothing, so `/auth/me` decides between the
 * platform panel and the operator panel and nothing else. The group panel is
 * not reachable at all: `AuthProvider`'s initial state keeps whatever `role`
 * `localStorage` holds, but `GuardedRoute` renders its checking message until
 * `/auth/me` answers, and every dashboard route is inside that guard. So the
 * window a stored role would win does not exist in the app.
 *
 * **This file mounts below that guard, on purpose, and that is what its
 * assertions are about.** They measure this component's arithmetic — that a
 * count it was never sent stays unmeasured — and not a screen a person can
 * open. `agent-mesh-local-pm` measured both ends: the panel draws when
 * `DashboardPage` is mounted directly, and does not when the whole `App` is,
 * and the earlier version of this sentence claimed the second was the first.
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
// The real router. A stubbed `react-router-dom` is global to the process and
// leaks into the files that import it after this one.
const { MemoryRouter } = await import("react-router-dom");
const { AuthProvider } = await import("@/contexts/AuthContext.tsx");
const { I18nProvider, DICTIONARY } = await import("@/contexts/I18nContext.tsx");
const { CAPABILITY } = await import("@/types/auth.ts");
const { DashboardPage } = await import("./DashboardPage.tsx");

const ME = "/auth/me";
const AGENTS = "/api/v1/agents";
const MAILBOX = "/api/v1/admin/mailbox";
const GROUPS = "/api/v1/admin/groups";
const KEYS_PENDING = "/api/v1/admin/keys/pending";
const HEALTH = "/api/v1/health";
const USAGE = "/api/v1/admin/ai-usage";
const BEHAVIOUR = "/api/v1/admin/telemetry/behaviour";
const USER_KEY = "agent_mesh_user";

/**
 * The English word this screen would draw, or a failure naming the key.
 *
 * `DICTIONARY.en[key]!` on a key that has been renamed is `undefined`, and an
 * assertion comparing against it either passes vacuously or fails somewhere
 * that does not name the cause. This says which key went missing.
 */
const en = (key: string): string => {
  const word = DICTIONARY.en[key];
  if (word === undefined) throw new Error(`the dictionary has no English for ${key}`);
  return word;
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** § 11.3's refusal: the server answered, and named what is missing. */
const refusal = (capability: string) => () => json(403, { error: "not allowed", capability });
/** A refusal that names nothing — what a locked account gets from every route. */
const refusalUnnamed = () => json(403, { error: "not allowed" });
/** No answer at all: offline, DNS, connection refused. Not a status. */
const down = (): Response => { throw new TypeError("Failed to fetch"); };
/** Asked, and still out. The window this screen used to draw as `0`. */
const stillOut = (): Promise<Response> => new Promise<Response>(() => {});
const answers = (body: unknown) => () => json(200, body);

type Answer = Response | Promise<Response>;
type Route = [path: string, make: () => Answer];

const realFetch = globalThis.fetch;
/** bun:test has no global stubber, so the original goes back by hand in
 *  `afterEach`; a forgotten restore poisons every file that runs after this. */
const stub = (fn: unknown) => { globalThis.fetch = fn as typeof globalThis.fetch; };

const calls: string[] = [];
let routes: Route[] = [];
const asked = (path: string): number => calls.filter((url) => url.endsWith(path)).length;

beforeEach(() => {
  calls.length = 0;
  // happy-dom's storage belongs to the process. A remembered session decides
  // which of the four panels draws, and `agent_mesh_lang` decides which
  // language every assertion below is written in, so both are cleared rather
  // than inherited from whichever file ran first.
  localStorage.clear();
  routes = [];
  stub(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    for (const [path, make] of routes) if (url.endsWith(path)) return make();
    // Anything this scenario did not name answers a body with nothing in it,
    // so a route left out cannot masquerade as a refusal or an outage.
    return json(200, { ok: true });
  });
});

afterEach(() => { cleanup(); localStorage.clear(); globalThis.fetch = realFetch; });
afterAll(() => { localStorage.clear(); globalThis.fetch = realFetch; });

const settle = async () => {
  // The platform panel's mount is `Promise.all` over `fetchTelemetry` (five
  // requests, each `fetch` then `.json()`), `fetchGroups` and `fetchAgents`,
  // and the state writes land in later turns again. One microtask drain is not
  // enough to have finished that.
  for (let turn = 0; turn < 3; turn++) {
    await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
  }
};

const mount = async () => {
  render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <I18nProvider>
        <AuthProvider>
          <DashboardPage />
        </AuthProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
  await settle();
};

/** What `/auth/me` answers for the one role this server issues. */
const ADMIN_ME = answers({
  github_id: 1,
  github_login: "admin",
  role: "admin",
  approved: true,
  tenant: "tenant_default",
  capabilities: [CAPABILITY.GROUP_MANAGE, CAPABILITY.MAILBOX_READ_DEPTH],
  created_at: "2026-01-01T00:00:00Z",
});
/** The session is not signed in — which is what puts the operator panel up. */
const NO_SESSION = () => json(401, { error: "unauthenticated" });

/** The last visit's session, as the browser kept it. */
const remember = (role: string) => {
  localStorage.setItem(USER_KEY, JSON.stringify({
    id: "usr_admin", name: "admin", role, capabilities: [], tenantId: "tenant_default", authProvider: "local",
  }));
};

/** One KPI card, by the label the dictionary gave it. */
const kpiCard = (label: string): HTMLElement => {
  const card = document.querySelector(`[data-kpi="${label}"]`);
  if (!card) throw new Error(`no KPI card is labelled ${label}`);
  return card as HTMLElement;
};
/** Its second row: the number, and the caption beside it. */
const kpiRow = (label: string): HTMLElement => {
  const row = kpiCard(label).children[1];
  if (!row) throw new Error(`the ${label} card renders no value row`);
  return row as HTMLElement;
};
const kpiValue = (label: string): string => kpiRow(label).children[0]?.textContent ?? "";
const kpiSub = (label: string): string => kpiRow(label).children[1]?.textContent ?? "";

const bodyText = (): string => document.body.textContent ?? "";
const buttonSaying = (word: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(word));

type DashboardGroupState = "loading" | "refused" | "unreachable" | "empty" | "present";
const DASHBOARD_GROUP_STATES: DashboardGroupState[] = ["loading", "refused", "unreachable", "empty", "present"];

/** One role panel says exactly one thing about its groups read. */
const expectDashboardGroupState = (prefix: "tenant-groups" | "group-groups", shown: DashboardGroupState) => {
  for (const state of DASHBOARD_GROUP_STATES) {
    const found = screen.queryByTestId(`${prefix}-${state}`);
    if (state === shown) expect(found, `${prefix} did not draw its ${shown} state`).not.toBe(null);
    else expect(found, `${prefix} drew ${state} beside ${shown}`).toBe(null);
  }
};

type DashboardListPrefix = "tenant-agents" | "tenant-pending-keys" | "group-agents";

/** The agents and key reads use the same five visible states as groups. */
const expectDashboardListState = (prefix: DashboardListPrefix, shown: DashboardGroupState) => {
  for (const state of DASHBOARD_GROUP_STATES) {
    const found = screen.queryByTestId(`${prefix}-${state}`);
    if (state === shown) expect(found, `${prefix} did not draw its ${shown} state`).not.toBe(null);
    else expect(found, `${prefix} drew ${state} beside ${shown}`).toBe(null);
  }
};

/**
 * The fleet row that renders `identity` in a cell of its own.
 *
 * A body-wide `toContain` passes wherever a value landed, including the wrong
 * field of another row. Each row carries the playground button, so the nearest
 * ancestor holding that button is the row and not the list around it.
 */
const fleetRow = (identity: string): HTMLElement => {
  const cells = [...document.querySelectorAll("span")].filter((s) => s.textContent === identity);
  if (cells.length !== 1) throw new Error(`expected one cell rendering ${identity}, found ${cells.length}`);
  let node: HTMLElement | null = cells[0]!.parentElement;
  while (node && !(node.textContent ?? "").includes(en("nav.playground"))) node = node.parentElement;
  if (!node) throw new Error(`no fleet row holds ${identity}`);
  return node;
};

/** Two rows as `GET /api/v1/agents` sends them: id, name, description, channel, type. */
const SEEN_ROW = {
  id: "agent-seen", name: "agent-seen", description: "Billing worker",
  channel: "web", type: "worker", last_seen_at: "2026-08-19T00:00:00Z",
};
const UNSEEN_ROW = {
  id: "agent-unseen", name: "agent-unseen", description: "Report writer",
  channel: "grpc", type: "worker",
};

describe("the operator panel, while the registry has not answered", () => {
  it("says the question is still out, and does not answer it with zero", async () => {
    routes = [[ME, NO_SESSION], [AGENTS, stillOut], [MAILBOX, stillOut]];
    await mount();

    // The state this panel's own comment says it lacked: `agents` starts `[]`,
    // and `[]` drew `0` registered until the answer arrived and the number
    // jumped. Measured there with the route delayed 2.5s.
    expect(screen.queryByTestId("operator-agents-loading")).not.toBe(null);
    expect(screen.queryByTestId("operator-agents-empty")).toBe(null);
    expect(screen.queryByTestId("operator-agents-unreachable")).toBe(null);

    expect(kpiValue(en("dash.kpi.agents"))).not.toBe("0");
    expect(kpiSub(en("dash.kpi.agents"))).toBe(en("common.loading"));
    expect(document.querySelector(`[data-kpi="${en("dash.kpi.sockets")}"]`)).toBe(null);
    // Neither of the two sentences about an answer, because there is no answer.
    expect(bodyText()).not.toContain(en("dash.op.empty"));
    expect(bodyText()).not.toContain(en("common.errorLoad"));
  });
});

describe("the operator panel, on an answer", () => {
  it("invites a first agent only because the registry said there are none", async () => {
    routes = [[ME, NO_SESSION], [AGENTS, answers({ agents: [] })], [MAILBOX, answers({ mailboxes: [], total_queued: 0 })]];
    await mount();

    expect(screen.queryByTestId("operator-agents-empty")).not.toBe(null);
    expect(screen.queryByTestId("operator-agents-loading")).toBe(null);
    expect(screen.queryByTestId("operator-agents-unreachable")).toBe(null);
    expect(kpiValue(en("dash.kpi.agents"))).toBe("0");
    expect(bodyText()).toContain(en("dash.op.empty"));
    // The invitation is the part that only an answer earns: "register your
    // first agent" drawn about a read that failed tells the operator their mesh
    // is empty when nobody asked it anything.
    expect(screen.queryByText(en("dash.op.register"))).not.toBe(null);
    expect(bodyText()).not.toContain(en("common.errorLoad"));
    expect(bodyText()).not.toContain(en("common.loading"));
    // An answered-and-empty queue is a measured zero, and has to look different
    // from the mailbox route saying nothing.
    expect(kpiValue(en("dash.kpi.inbox"))).toBe("0");
  });

  it("counts sightings separately from rows, and calls an unseen agent unseen", async () => {
    routes = [
      [ME, NO_SESSION],
      [AGENTS, answers({ agents: [SEEN_ROW, UNSEEN_ROW] })],
      [MAILBOX, answers({ mailboxes: [], total_queued: 0 })],
    ];
    await mount();

    expect(kpiValue(en("dash.kpi.agents"))).toBe("2");
    // `last_seen_at` is the only presence this route carries. A socket count
    // equal to the row count is the invented `status: "active"` this console
    // removed from the api layer, arriving instead from the screen.
    expect(document.querySelector(`[data-kpi="${en("dash.kpi.sockets")}"]`)).toBe(null);

    // Per row rather than over the body: both words are on the page either way,
    // and a row that swaps them is the same defect as counting them wrong.
    expect(fleetRow(SEEN_ROW.id).textContent).toContain(en("dash.op.seen"));
    expect(fleetRow(SEEN_ROW.id).textContent).not.toContain(en("agents.neverSeen"));
    expect(fleetRow(UNSEEN_ROW.id).textContent).toContain(en("agents.neverSeen"));
    // The kind the server sent, in the slot the label promises.
    expect(fleetRow(SEEN_ROW.id).textContent).toContain(`${en("dash.op.kind")}: ${SEEN_ROW.type}`);
  });
});

describe("the operator panel, on a read that did not come back", () => {
  /**
   * What both failures have to say, and the three things neither may say.
   *
   * The panel does not currently distinguish the two — see the note below — so
   * this is the shared floor, asserted from each of them so that a change
   * making one of them draw an empty fleet fails here.
   */
  const expectNoAnswerDrawn = () => {
    expect(screen.queryByTestId("operator-agents-empty")).toBe(null);
    expect(screen.queryByTestId("operator-agents-loading")).toBe(null);
    expect(bodyText()).not.toContain(en("dash.op.empty"));
    // The invitation is the sentence this panel used to draw at a `403`.
    expect(screen.queryByText(en("dash.op.register"))).toBe(null);
    // `0` owned agents is a claim about a mesh that said nothing.
    expect(kpiValue(en("dash.kpi.agents"))).not.toBe("0");
    expect(kpiSub(en("dash.kpi.agents"))).toBe(en("common.errorLoad"));
  };

  it("does not call a refused registry an empty one", async () => {
    // A locked account gets this from every route but the password change:
    // the server answered, and it named no capability.
    routes = [[ME, NO_SESSION], [AGENTS, refusalUnnamed], [MAILBOX, refusal(CAPABILITY.MAILBOX_READ_DEPTH)]];
    await mount();
    expectNoAnswerDrawn();
  });

  it("does not call a registry that never answered an empty one", async () => {
    routes = [[ME, NO_SESSION], [AGENTS, down], [MAILBOX, down]];
    await mount();
    expectNoAnswerDrawn();
  });
});

describe("the queue card, which two panels draw", () => {
  it("does not report a queue depth the mailbox route never sent", async () => {
    routes = [
      [ME, NO_SESSION],
      [AGENTS, answers({ agents: [SEEN_ROW] })],
      [MAILBOX, refusal(CAPABILITY.MAILBOX_READ_DEPTH)],
    ];
    await mount();

    // The registry answered, so the panel around this card is healthy — which
    // is exactly the arrangement in which a `?? 0` on the queue is invisible.
    expect(kpiValue(en("dash.kpi.agents"))).toBe("1");
    expect(kpiValue(en("dash.kpi.inbox"))).not.toBe("0");
    expect(kpiValue(en("dash.kpi.inbox"))).toBe(en("common.unmeasured"));
  });

  it("reports the total_queued value the route sent and draws no invented dispatch card", async () => {
    routes = [
      [ME, NO_SESSION],
      [AGENTS, answers({ agents: [SEEN_ROW] })],
      [MAILBOX, answers({ mailboxes: [{ identity: "agent-seen", pending: 7, leased: 0, oldest: null }], total_queued: 7 })],
    ];
    await mount();

    expect(kpiValue(en("dash.kpi.inbox"))).toBe("7");
    expect(document.querySelector(`[data-kpi="${en("dash.kpi.latency")}"]`)).toBe(null);
  });

  it("says the same thing on the group panel's copy of the card", async () => {
    // **No session draws this panel.** The server issues `admin` or nothing,
    // and the guard above every dashboard route holds the screen until
    // `/auth/me` answers — `App.test.tsx` measures both halves of that. What
    // this mounts is the component, under the guard rather than through it, so
    // what follows is a claim about `queueValue`'s arithmetic and not about
    // anything a person sees.
    //
    // It is here because `queueValue` is shared between the two panels, and a
    // mutation planted on one copy leaves the other unmeasured. This is the
    // other copy.
    remember("GROUP_ADMIN");
    routes = [[ME, stillOut], [GROUPS, answers({ groups: [] })], [AGENTS, answers({ agents: [SEEN_ROW] })], [MAILBOX, down]];
    await mount();

    expect(kpiValue(en("dash.ga.agents"))).toBe("1");
    expect(kpiValue(en("dash.ga.lease"))).not.toBe("0");
    expect(kpiValue(en("dash.ga.lease"))).toBe(en("common.unmeasured"));
  });
});

describe("the two role panels that exist below today's browser gate", () => {
  it("renders the tenant component's populated answer without inventing its egress total", async () => {
    // `/auth/me` maps every non-admin account to AGENT_OPERATOR today, so this
    // is deliberately a component-mount reach, not a browser-reach claim. The
    // panel remains product code, though, and its arithmetic has to read the
    // response it is given rather than deriving a different number.
    remember("TENANT_ADMIN");
    routes = [
      [ME, stillOut],
      [GROUPS, answers({
        groups: [
          { group_id: "grp_alpha", name: "Alpha", description: "Critical workers", members: [SEEN_ROW.id] },
          { group_id: "grp_beta", name: "Beta", members: [] },
        ],
        egress: [
          { from_group: "grp_alpha", to_group: "grp_beta" },
          { from_group: "grp_alpha", to_group: "grp_archive" },
        ],
      })],
      [AGENTS, answers({ agents: [SEEN_ROW, UNSEEN_ROW] })],
      [KEYS_PENDING, answers({ keys: [{
        identity: "agent-pending",
        fingerprint: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      }] })],
    ];
    await mount();

    expect(kpiValue(en("dash.ta.groups"))).toBe("2");
    expectDashboardGroupState("tenant-groups", "present");
    expectDashboardListState("tenant-agents", "present");
    expectDashboardListState("tenant-pending-keys", "present");
    expect(kpiValue(en("dash.ta.agents"))).toBe("2");
    if (kpiValue(en("dash.ta.egress")) !== "2") {
      throw new Error("the tenant dashboard did not sum the egress rules the route returned");
    }
    expect(kpiValue(en("dash.ta.approval"))).toBe("1");
    expect(bodyText()).toContain("Critical workers");
    expect(bodyText()).toContain("agent-pending");
    expect(bodyText()).toContain("sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
  });

  it("renders the tenant component's answered-and-empty branches as empty", async () => {
    remember("TENANT_ADMIN");
    routes = [
      [ME, stillOut],
      [GROUPS, answers({ groups: [], egress: [] })],
      [AGENTS, answers({ agents: [] })],
      [KEYS_PENDING, answers({ keys: [] })],
    ];
    await mount();

    expect(kpiValue(en("dash.ta.groups"))).toBe("0");
    expectDashboardGroupState("tenant-groups", "empty");
    expectDashboardListState("tenant-agents", "empty");
    expectDashboardListState("tenant-pending-keys", "empty");
    expect(kpiValue(en("dash.ta.agents"))).toBe("0");
    expect(bodyText()).toContain(en("dash.ta.groupsEmpty"));
    expect(bodyText()).toContain(en("dash.ta.keysEmpty"));
  });

  it("does not turn an omitted delivery-rule list into zero allowed destinations", async () => {
    remember("TENANT_ADMIN");
    routes = [
      [ME, stillOut],
      [GROUPS, answers({ groups: [{ group_id: "grp_alpha", name: "Alpha", members: [] }] })],
      [AGENTS, answers({ agents: [] })],
      [KEYS_PENDING, answers({ keys: [] })],
    ];
    await mount();
    expect(kpiValue(en("dash.ta.egress"))).toBe(en("common.unmeasured"));
  });

  it("renders the group component's groups, members, sightings, and measured queue", async () => {
    // Same reach boundary as the tenant case above: this is below the browser
    // guard, because no current server session can carry GROUP_ADMIN.
    remember("GROUP_ADMIN");
    routes = [
      [ME, stillOut],
      [GROUPS, answers({ groups: [{
        group_id: "grp_alpha",
        name: "Alpha",
        members: [SEEN_ROW.id, UNSEEN_ROW.id],
      }] })],
      [AGENTS, answers({ agents: [SEEN_ROW, UNSEEN_ROW] })],
      [MAILBOX, answers({ mailboxes: [], total_queued: 4 })],
    ];
    await mount();

    expect(kpiValue(en("dash.ga.groups"))).toBe("1");
    expectDashboardGroupState("group-groups", "present");
    expectDashboardListState("group-agents", "present");
    expect(kpiValue(en("dash.ga.agents"))).toBe("2");
    expect(kpiValue(en("dash.ga.lease"))).toBe("4");
    expect(document.querySelector(`[data-kpi="${en("dash.ga.health")}"]`)).toBe(null);
    expect(bodyText()).toContain(SEEN_ROW.id);
    expect(bodyText()).toContain(UNSEEN_ROW.id);
  });

  it("keeps the tenant group read's pending, refused, and unreachable states out of empty", async () => {
    const check = async (
      answer: () => Answer,
      state: "loading" | "refused" | "unreachable",
      sentence: string,
    ) => {
      cleanup();
      localStorage.clear();
      remember("TENANT_ADMIN");
      routes = [
        [ME, stillOut],
        [GROUPS, answer],
        [AGENTS, answers({ agents: [] })],
        [KEYS_PENDING, answers({ keys: [] })],
      ];
      await mount();

      expectDashboardGroupState("tenant-groups", state);
      expect(screen.getByTestId(`tenant-groups-${state}`).textContent).toBe(sentence);
      expect(screen.getByTestId("tenant-groups-count").textContent).not.toBe("0");
      expect(screen.getByTestId("tenant-egress-count").textContent).not.toBe("0");
      expect(bodyText()).not.toContain(en("dash.ta.groupsEmpty"));
    };

    await check(stillOut, "loading", en("common.loading"));
    await check(
      refusal(CAPABILITY.GROUP_MANAGE),
      "refused",
      `${en("common.refusedRead")}.`,
    );
    expect(bodyText()).not.toContain(en("groups.error"));

    await check(down, "unreachable", en("groups.error"));
    expect(bodyText()).not.toContain(en("common.refusedRead"));
  });

  it("keeps the group-admin group read's pending, refused, and unreachable states out of empty", async () => {
    const check = async (
      answer: () => Answer,
      state: "loading" | "refused" | "unreachable",
      sentence: string,
    ) => {
      cleanup();
      localStorage.clear();
      remember("GROUP_ADMIN");
      routes = [
        [ME, stillOut],
        [GROUPS, answer],
        [AGENTS, answers({ agents: [] })],
        [MAILBOX, answers({ mailboxes: [], total_queued: 0 })],
      ];
      await mount();

      expectDashboardGroupState("group-groups", state);
      expect(screen.getByTestId(`group-groups-${state}`).textContent).toBe(sentence);
      expect(screen.getByTestId("group-groups-count").textContent).not.toBe("0");
      expect(bodyText()).not.toContain(en("dash.ga.groupsEmpty"));
    };

    await check(stillOut, "loading", en("common.loading"));
    await check(
      refusal(CAPABILITY.GROUP_MANAGE),
      "refused",
      `${en("common.refusedRead")}.`,
    );
    expect(bodyText()).not.toContain(en("groups.error"));

    await check(down, "unreachable", en("groups.error"));
    expect(bodyText()).not.toContain(en("common.refusedRead"));
  });

  it("renders the group component's answered-and-empty branch as empty", async () => {
    remember("GROUP_ADMIN");
    routes = [
      [ME, stillOut],
      [GROUPS, answers({ groups: [] })],
      [AGENTS, answers({ agents: [] })],
      [MAILBOX, answers({ mailboxes: [], total_queued: 0 })],
    ];
    await mount();

    expectDashboardGroupState("group-groups", "empty");
    expectDashboardListState("group-agents", "empty");
    expect(kpiValue(en("dash.ga.groups"))).toBe("0");
    expect(bodyText()).toContain(en("dash.ga.groupsEmpty"));
  });

  it("keeps the tenant agents read's pending, refused, and unreachable states out of empty", async () => {
    const check = async (
      answer: () => Answer,
      state: "loading" | "refused" | "unreachable",
      sentence: string,
    ) => {
      cleanup();
      localStorage.clear();
      remember("TENANT_ADMIN");
      routes = [
        [ME, stillOut],
        [GROUPS, answers({ groups: [{ group_id: "tenant-groups-ok", name: "Groups answered", members: [] }] })],
        [AGENTS, answer],
        [KEYS_PENDING, answers({ keys: [] })],
      ];
      await mount();

      expectDashboardListState("tenant-agents", state);
      expect(screen.getByTestId(`tenant-agents-${state}`).textContent).not.toBe("0");
      expect(kpiSub(en("dash.ta.agents"))).toBe(sentence);
      expectDashboardGroupState("tenant-groups", "present");
      expectDashboardListState("tenant-pending-keys", "empty");
    };

    await check(stillOut, "loading", en("common.loading"));
    await check(refusalUnnamed, "refused", `${en("common.refusedRead")}.`);
    expect(kpiSub(en("dash.ta.agents"))).not.toBe(en("common.errorLoad"));

    await check(down, "unreachable", en("common.errorLoad"));
    expect(kpiSub(en("dash.ta.agents"))).not.toContain(en("common.refusedRead"));
  });

  it("keeps the tenant pending-key read's pending, refused, and unreachable states out of empty", async () => {
    const check = async (
      answer: () => Answer,
      state: "loading" | "refused" | "unreachable",
      sentence: string,
    ) => {
      cleanup();
      localStorage.clear();
      remember("TENANT_ADMIN");
      routes = [
        [ME, stillOut],
        [GROUPS, answers({ groups: [{ group_id: "tenant-groups-ok", name: "Groups answered", members: [] }] })],
        [AGENTS, answers({ agents: [SEEN_ROW] })],
        [KEYS_PENDING, answer],
      ];
      await mount();

      expectDashboardListState("tenant-pending-keys", state);
      expect(screen.getByTestId(`tenant-pending-keys-${state}`).textContent).toBe(sentence);
      expect(screen.getByTestId("tenant-pending-keys-count").textContent).not.toBe("0");
      expect(kpiSub(en("dash.ta.approval"))).toBe(sentence);
      expectDashboardGroupState("tenant-groups", "present");
      expectDashboardListState("tenant-agents", "present");
      expect(bodyText()).not.toContain(en("dash.ta.keysEmpty"));
    };

    await check(stillOut, "loading", en("common.loading"));
    await check(
      refusal(CAPABILITY.KEY_APPROVE),
      "refused",
      `${en("common.refusedRead")}.`,
    );
    expect(screen.getByTestId("tenant-pending-keys-refused").textContent).not.toBe(en("common.errorLoad"));

    await check(down, "unreachable", en("common.errorLoad"));
    expect(screen.getByTestId("tenant-pending-keys-unreachable").textContent).not.toContain(en("common.refusedRead"));
  });

  it("keeps the group agents read's pending, refused, and unreachable states out of empty", async () => {
    const check = async (
      answer: () => Answer,
      state: "loading" | "refused" | "unreachable",
      sentence: string,
    ) => {
      cleanup();
      localStorage.clear();
      remember("GROUP_ADMIN");
      routes = [
        [ME, stillOut],
        [GROUPS, answers({ groups: [{ group_id: "group-groups-ok", name: "Groups answered", members: [] }] })],
        [AGENTS, answer],
        [MAILBOX, answers({ mailboxes: [], total_queued: 0 })],
      ];
      await mount();

      expectDashboardListState("group-agents", state);
      expect(screen.getByTestId(`group-agents-${state}`).textContent).not.toBe("0");
      expect(kpiSub(en("dash.ga.agents"))).toBe(sentence);
      expect(document.querySelector(`[data-kpi="${en("dash.ga.health")}"]`)).toBe(null);
      expectDashboardGroupState("group-groups", "present");
    };

    await check(stillOut, "loading", en("common.loading"));
    await check(refusalUnnamed, "refused", `${en("common.refusedRead")}.`);
    expect(kpiSub(en("dash.ga.agents"))).not.toBe(en("common.errorLoad"));

    await check(down, "unreachable", en("common.errorLoad"));
    expect(kpiSub(en("dash.ga.agents"))).not.toContain(en("common.refusedRead"));
  });

  it("keeps each group answer tied to its own route when neighbouring reads fail", async () => {
    remember("TENANT_ADMIN");
    routes = [
      [ME, stillOut],
      [GROUPS, answers({ groups: [{ group_id: "tenant-alone", name: "Tenant alone", members: [] }] })],
      [AGENTS, down],
      [KEYS_PENDING, down],
    ];
    await mount();

    // The agents and key reads failed. Neither failure answers the separate
    // groups question, so a shared `isError` must not take this row down.
    expectDashboardGroupState("tenant-groups", "present");
    expect(screen.getByTestId("tenant-groups-present").textContent).toContain("Tenant alone");
    expectDashboardListState("tenant-agents", "unreachable");
    expectDashboardListState("tenant-pending-keys", "unreachable");

    cleanup();
    localStorage.clear();
    remember("GROUP_ADMIN");
    routes = [
      [ME, stillOut],
      [GROUPS, answers({ groups: [{ group_id: "group-alone", name: "Group alone", members: [] }] })],
      [AGENTS, down],
      [MAILBOX, down],
    ];
    await mount();

    expectDashboardGroupState("group-groups", "present");
    expect(screen.getByTestId("group-groups-present").textContent).toContain("Group alone");
    expectDashboardListState("group-agents", "unreachable");
  });
});

describe("refresh", () => {
  it("asks again, and takes the failure back down when the second answer arrives", async () => {
    routes = [[ME, NO_SESSION], [AGENTS, down], [MAILBOX, down]];
    await mount();
    expect(screen.queryByTestId("operator-agents-unreachable")).not.toBe(null);
    expect(asked(AGENTS)).toBe(1);

    routes = [[ME, NO_SESSION], [AGENTS, answers({ agents: [SEEN_ROW] })], [MAILBOX, down]];
    await act(async () => { fireEvent.click(buttonSaying(en("common.refresh"))!); });
    await settle();

    // A refresh that does not re-ask is a button that does nothing, and a
    // failure state that does not clear teaches the operator to ignore it.
    expect(asked(AGENTS)).toBe(2);
    expect(screen.queryByTestId("operator-agents-unreachable")).toBe(null);
    expect(kpiValue(en("dash.kpi.agents"))).toBe("1");
    expect(fleetRow(SEEN_ROW.id).textContent).toContain(SEEN_ROW.description);
  });
});

describe("the platform panel, while nothing has answered", () => {
  it("says every card is still loading, and none of them that there is nothing", async () => {
    remember("PLATFORM_ADMIN");
    routes = [
      [ME, ADMIN_ME],
      [AGENTS, stillOut], [GROUPS, stillOut], [HEALTH, stillOut],
      [MAILBOX, stillOut], [USAGE, stillOut], [BEHAVIOUR, stillOut],
    ];
    await mount();

    expect(kpiSub(en("dash.pa.nodes"))).toBe(en("common.loading"));
    expect(kpiSub(en("dash.pa.tenants"))).toBe(en("common.loading"));
    expect(kpiValue(en("dash.pa.nodes"))).not.toBe("0");
    expect(kpiValue(en("dash.pa.tenants"))).not.toBe("0");

    expect(bodyText()).toContain(en("dash.pa.tenantLoading"));
    // The three sentences a pending request has not earned.
    expect(bodyText()).not.toContain(en("dash.pa.tenantEmpty"));
    expect(bodyText()).not.toContain(en("dash.pa.tenantsNone"));
    expect(bodyText()).not.toContain(en("dash.pa.tenantError"));
  });
});

describe("the platform panel, on an answer", () => {
  it("counts the registry it names, and says no tenants only because the route said so", async () => {
    remember("PLATFORM_ADMIN");
    routes = [
      [ME, ADMIN_ME],
      [AGENTS, answers({ agents: [SEEN_ROW, UNSEEN_ROW] })],
      [GROUPS, answers({ groups: [] })],
      // `agent_count` counts mesh identities that are alive; the registry
      // counts rows in this server's own table. Different quantities, and this
      // card's caption names the second one.
      [HEALTH, answers({ status: "ok", agent_count: 13, uptime: 900, version: "0.2.0" })],
      [MAILBOX, answers({ mailboxes: [], total_queued: 0 })],
    ];
    await mount();

    expect(kpiValue(en("dash.pa.nodes"))).toBe("2");
    expect(kpiValue(en("dash.pa.nodes"))).not.toBe("13");
    expect(kpiSub(en("dash.pa.nodes"))).toBe(en("dash.pa.nodesSub"));
    expect(document.querySelector(`[data-kpi="${en("dash.pa.sockets")}"]`)).toBe(null);

    expect(kpiValue(en("dash.pa.tenants"))).toBe("0");
    expect(kpiSub(en("dash.pa.tenants"))).toBe(en("dash.pa.tenantsNone"));
    expect(bodyText()).toContain(en("dash.pa.tenantEmpty"));
    expect(bodyText()).not.toContain(en("dash.pa.tenantError"));
    expect(bodyText()).not.toContain(en("dash.pa.tenantLoading"));
  });
});

describe("the platform panel, on a read that did not come back", () => {
  const TENANTS = { groups: [{ group_id: "grp_billing", name: "billing", members: ["agent-seen"] }] };

  it("names a refusal as one, and does not say there are no tenants", async () => {
    remember("PLATFORM_ADMIN");
    routes = [
      [ME, ADMIN_ME],
      [GROUPS, refusal(CAPABILITY.GROUP_MANAGE)],
      [AGENTS, answers({ agents: [SEEN_ROW, UNSEEN_ROW] })],
      [HEALTH, answers({ status: "ok", agent_count: 13 })],
      [MAILBOX, answers({ mailboxes: [], total_queued: 0 })],
    ];
    await mount();

    // The server answered. Telling the operator the backend could not be
    // reached sends them to check a network for a permission they do not hold.
    expect(kpiSub(en("dash.pa.nodes"))).toBe(en("common.refused"));
    expect(kpiSub(en("dash.pa.nodes"))).not.toBe(en("common.errorLoad"));
    // Not a zero anywhere: `0` tenants and `0` nodes are claims about a mesh
    // this session was not allowed to look at.
    expect(kpiValue(en("dash.pa.tenants"))).not.toBe("0");
    expect(kpiValue(en("dash.pa.nodes"))).not.toBe("0");
    expect(bodyText()).not.toContain(en("dash.pa.tenantEmpty"));
    expect(bodyText()).not.toContain(en("dash.pa.tenantsNone"));
  });

  it("does not call a route that never answered a refusal", async () => {
    remember("PLATFORM_ADMIN");
    routes = [
      [ME, ADMIN_ME],
      [GROUPS, down],
      [AGENTS, answers({ agents: [SEEN_ROW, UNSEEN_ROW] })],
      [HEALTH, answers({ status: "ok", agent_count: 13 })],
      [MAILBOX, answers({ mailboxes: [], total_queued: 0 })],
    ];
    await mount();

    // The other direction of the same distinction: no answer is not "you may
    // not", and telling somebody they lack a permission they hold is how a
    // real outage gets closed as a ticket about access.
    expect(kpiSub(en("dash.pa.nodes"))).toBe(en("common.errorLoad"));
    expect(kpiSub(en("dash.pa.nodes"))).not.toBe(en("common.refused"));
    expect(kpiValue(en("dash.pa.tenants"))).not.toBe("0");
    expect(bodyText()).not.toContain(en("dash.pa.tenantEmpty"));
    expect(bodyText()).not.toContain(en("dash.pa.tenantsNone"));
  });

  it("does not take the whole screen down when only the gated panels are refused", async () => {
    // Two of `fetchTelemetry`'s five routes are ungated — none of § 11's
    // capabilities names reading the registry or health — so a session holding
    // nothing still gets an answer from those two, and the read resolves.
    // Whatever this screen says next, it must not be that the backend is
    // unreachable: `/api/v1/agents`, `/api/v1/health` and the group route all
    // answered.
    remember("PLATFORM_ADMIN");
    routes = [
      [ME, ADMIN_ME],
      [USAGE, refusal(CAPABILITY.USAGE_READ)],
      [BEHAVIOUR, refusal(CAPABILITY.USAGE_READ)],
      [MAILBOX, refusal(CAPABILITY.MAILBOX_READ_DEPTH)],
      [AGENTS, answers({ agents: [SEEN_ROW, UNSEEN_ROW] })],
      [HEALTH, answers({ status: "ok", agent_count: 13 })],
      [GROUPS, answers(TENANTS)],
    ];
    await mount();

    expect(kpiSub(en("dash.pa.nodes"))).not.toBe(en("common.errorLoad"));
    expect(bodyText()).not.toContain(en("dash.pa.tenantError"));
    // The panel that did answer keeps its answer. A refusal on one read
    // erasing a list another read returned is the same collapse in reverse.
    expect(bodyText()).toContain("billing");
    expect(kpiValue(en("dash.pa.tenants"))).toBe("1");
    expect(kpiValue(en("dash.pa.nodes"))).toBe("2");
  });
});
