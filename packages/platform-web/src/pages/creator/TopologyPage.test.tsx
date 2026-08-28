/**
 * What the mesh graph draws when it has nothing to draw, and why the four
 * reasons are not one reason.
 *
 * A graph is the worst screen on this console to get this wrong on. A list that
 * fails can at least fail visibly in the space its rows would have taken; a
 * canvas that fails looks exactly like a canvas of a mesh with nothing in it —
 * white, quiet, and wrong in a way an operator reads as good news. The page's
 * own comments record the family: `I-064`'s heading that counted six agents
 * over a canvas holding two, an empty group that drew as holding the whole
 * mesh, a `member_count || 1` that turned a known zero into a one, and a
 * `status` key the route has never sent that reported the whole mesh online.
 * Every one of them is the same mistake — a claim the server did not make,
 * drawn as if it had.
 *
 * So each test below fixes one of the four readings —
 *
 *   loading   refused (the server said no)
 *   unreachable (no answer)   empty (it said nothing is there)
 *
 * — and asserts both halves: the sentence the screen draws, and the sentences
 * it must not draw. "No agents to draw." over a `403` is the defect; so is a
 * heading reading "0 connected groups and 0 agent nodes" about a request that
 * never got an answer.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { registerDom } from "../../register-dom";

// Registered once for the process and never unregistered: bun runs every test
// file's top level before it runs any test, so a register/unregister pair swaps
// the document out from under whichever file is still using it.
registerDom();

// `await import`, not a static import: a static one is hoisted above the
// registration above and would load React's DOM entry into a process that has
// no document yet.
const { render, screen, cleanup, fireEvent, act } = await import("@testing-library/react");
const { MemoryRouter } = await import("react-router-dom");
const { TopologyPage } = await import("./TopologyPage.tsx");
const { CONSOLE_RESPONSE_FIXTURES } = await import("@agent-mesh/contracts/fixtures");
const { I18nProvider, DICTIONARY } = await import("@/contexts/I18nContext.tsx");
const { CAPABILITY } = await import("@/types/auth.ts");

const GROUPS = "/api/v1/admin/groups";
const AGENTS = "/api/v1/agents";
const CONTRACT_AGENT_BODY = CONSOLE_RESPONSE_FIXTURES
  .find((fixture) => fixture.path === AGENTS)!.body as {
    agents: Array<{ id: string; deleted_at: string | null }>;
  };
/** `Breadcrumbs` renders the bell, which reads this on mount. Answered so the
 *  bell's own four states never put their words on the page under test. */
const KEYS_PENDING = "/api/v1/admin/keys/pending";
const MESSAGES = "/api/v1/messages";

// Taken from the contract rather than typed in: a capability name this mesh
// does not define is as wrong in a fixture as in a screen — it makes the test
// agree with a server that cannot exist.
const NAMED = CAPABILITY.GROUP_MANAGE;
const OTHER = CAPABILITY.AGENT_TEARDOWN;

const EN = DICTIONARY.en;
/** The dictionary is the only permitted source of rendered words here. */
const say = (key: string): string => {
  const value = EN[key];
  if (!value) throw new Error(`the dictionary has no en entry for ${key}`);
  return value;
};

const v035Body = (body: unknown): unknown => {
  if (typeof body !== "object" || body === null || !("agents" in body)) return body;
  const agents = (body as { agents?: unknown }).agents;
  if (!Array.isArray(agents)) return body;
  return {
    ...(body as Record<string, unknown>),
    // The older topology scenarios describe live nodes. Make that v0.35 fact
    // explicit while the contract fixture below supplies the opposite row.
    agents: agents.map((agent) => (
      typeof agent === "object" && agent !== null && !("deleted_at" in agent)
        ? { ...agent, deleted_at: null }
        : agent
    )),
  };
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(v035Body(body)), { status, headers: { "content-type": "application/json" } });

const realFetch = globalThis.fetch;
/** bun:test has no global stubber, so the original goes back by hand below; a
 *  forgotten restore poisons every file that runs after this one. */
const stub = (fn: unknown) => { globalThis.fetch = fn as typeof globalThis.fetch; };

type Answer = () => Response | Promise<Response>;
const calls: string[] = [];
let routes: Array<[string, Answer]> = [];

/**
 * Answer per route, so one panel's read can fail while the others succeed.
 *
 * That is the whole point of the map: a screen that folds every failure into
 * one flag cannot be caught by a stub that fails everything at once, because
 * then every reading agrees. Anything not listed answers the empty-but-fine
 * body, which is the reading a broken screen would like to fall into.
 */
const serve = (map: Record<string, Answer>) => {
  routes = Object.entries(map);
};

beforeEach(() => {
  calls.length = 0;
  // The provider hydrates its language from storage, and happy-dom's storage
  // belongs to the whole run rather than to this file.
  localStorage.clear();
  serve({});
  stub(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    for (const [path, answer] of routes) {
      if (url.endsWith(path)) return await answer();
    }
    return json(200, { ok: true, keys: [], groups: [], agents: [] });
  });
});

afterEach(() => { cleanup(); localStorage.clear(); globalThis.fetch = realFetch; });
afterAll(() => { localStorage.clear(); globalThis.fetch = realFetch; });

const settle = async () => {
  // The mount read resolves over several microtasks — `fetch`, then `.json()`,
  // then the `Promise.all`, then `.then`/`.finally` — and the auto-fit effect
  // writes camera state after that, so a bare `await act(async () => {})` has
  // not always drained them.
  await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
};

const mount = async () => {
  render(
    <MemoryRouter initialEntries={["/creator/topology"]}>
      <I18nProvider>
        <TopologyPage />
      </I18nProvider>
    </MemoryRouter>,
  );
  await settle();
};

/**
 * The centred card the screen draws over an empty canvas.
 *
 * Found by its own inline geometry rather than by the words in it — the point
 * of every test here is which words are in it, so a finder that searched for
 * words could never report the wrong ones. `z-index: 40` alone is shared with
 * the zoom controls in the corner; `top: 50%` is not.
 */
const overlay = (): HTMLElement | null =>
  [...document.querySelectorAll("div")].find(
    (d) => d.style.zIndex === "40" && d.style.top === "50%",
  ) ?? null;
/**
 * Every helper below throws when its element is absent rather than answering
 * `""`.
 *
 * Half the assertions in this file are negative — what the screen must *not*
 * say — and `"".not.toContain(anything)` passes. A screen that drew no overlay,
 * no drawer and no toast at all would have satisfied them one after another,
 * which is the shape of the 57 unfailable assertions this repository had to
 * throw away once already.
 */
const overlayText = (): string => {
  const el = overlay();
  if (!el) throw new Error("the canvas carries no state overlay");
  return el.textContent ?? "";
};

/** The status pill in the top-left of the canvas — the counters, or why not. */
const hud = (): HTMLElement | null =>
  [...document.querySelectorAll("div")].find((d) => d.style.zIndex === "20") ?? null;
const hudText = (): string => {
  const el = hud();
  if (!el) throw new Error("the canvas carries no status pill");
  return el.textContent ?? "";
};

/** The drawer that opens for a selected node. */
const panel = (): HTMLElement | null =>
  [...document.querySelectorAll("div")].find((d) => d.style.zIndex === "50") ?? null;
const panelText = (): string => {
  const el = panel();
  if (!el) throw new Error("no node drawer is open");
  return el.textContent ?? "";
};

/** The sentence under the page title. */
const subtitle = (): string => {
  const heading = [...document.querySelectorAll("h1")].find((h) => h.textContent === say("topo.title"));
  if (!heading) throw new Error("the page draws no topology title");
  return heading.parentElement?.querySelector("p")?.textContent ?? "";
};

const drawn = (kind: "topology-agent" | "topology-cluster" | "topology-gateway"): number =>
  screen.queryAllByTestId(kind).length;

const drawnClusters = (kind: "group" | "unassigned"): number =>
  screen.queryAllByTestId("topology-cluster")
    .filter((cluster) => cluster.getAttribute("data-topology-kind") === kind).length;

/** Every group pill on the canvas, as `Name (count)`. */
const clusterLabels = (): string[] =>
  screen.queryAllByTestId("topology-cluster")
    .filter((cluster) => cluster.getAttribute("data-topology-kind") === "group")
    .map((g) => g.querySelector("text")?.textContent ?? "");

/** The safety-net orbit is visible without pretending to be a server group. */
const unassignedClusterLabels = (): string[] =>
  screen.queryAllByTestId("topology-cluster")
    .filter((cluster) => cluster.getAttribute("data-topology-kind") === "unassigned")
    .map((g) => g.querySelector("text")?.textContent ?? "");

/** The banner a send raises. `Toast` is the one `inline-flex` div on the page. */
const toastBox = (): HTMLElement | null =>
  [...document.querySelectorAll("div")].find((d) => d.style.display === "inline-flex") ?? null;
const toastText = (): string => {
  const el = toastBox();
  if (!el) throw new Error("the send raised no toast");
  return el.textContent ?? "";
};

/** The durable answer beside the control that caused the send. */
const sendResult = (): HTMLElement => {
  const el = screen.queryByTestId("topology-send-result");
  if (!el) throw new Error("the node drawer carries no send result");
  return el;
};
const sendResultText = (): string => sendResult().textContent ?? "";

/** Two agents in one group. The second has never been seen; the route sends no
 *  `status` for either, because it has no such field. */
const AGENT_ROWS = [
  { id: "svc-alpha-1", name: "Alpha One", description: "Alpha One", type: "runtime", last_seen_at: "2026-08-19T09:00:00Z" },
  { id: "svc-alpha-2", name: "Alpha Two", description: "Alpha Two", type: "runtime", last_seen_at: null },
];
const GROUP_ROWS = [
  { group_id: "grp_alpha", members: ["svc-alpha-1", "svc-alpha-2"] },
];

const healthy = () => serve({
  [GROUPS]: () => json(200, { groups: GROUP_ROWS }),
  [AGENTS]: () => json(200, { agents: AGENT_ROWS }),
  [KEYS_PENDING]: () => json(200, { ok: true, keys: [] }),
});

/** Every sentence the screen owns about the state of the read. */
const LOADING = say("topo.loading");
const UNREACHABLE = say("topo.error");
const REFUSED = say("common.refusedRead");
const EMPTY = say("topo.empty");

describe("a read that never finished is not an empty mesh", () => {
  it("says it is still loading, and claims no counts while it is", async () => {
    // Both reads hang. Nothing has been answered, so every number on this
    // screen would be an invention.
    serve({
      [GROUPS]: () => new Promise<Response>(() => {}),
      [AGENTS]: () => new Promise<Response>(() => {}),
      [KEYS_PENDING]: () => json(200, { ok: true, keys: [] }),
    });
    await mount();

    expect(overlayText()).toContain(LOADING);
    expect(subtitle()).toBe(say("topology.loading"));
    expect(hudText()).toContain(say("topology.loadingShort"));

    // The three sentences a still-running read must not produce. "No agents to
    // draw." is a report of an answer; there is no answer yet.
    expect(overlayText()).not.toContain(EMPTY);
    expect(overlayText()).not.toContain(UNREACHABLE);
    expect(overlayText()).not.toContain(REFUSED);
    // A counter reading `0` is the same invention in digits: the HUD states
    // what the mesh holds, and nothing has said what it holds.
    expect(hudText()).not.toContain(`${say("topo.hud.agents")}: 0`);
    expect(hudText()).not.toContain(`${say("topo.hud.groups")}: 0`);
    expect(drawn("topology-agent")).toBe(0);
  });
});

describe("a refusal is the server answering, and says so", () => {
  it("summarises the refusal without exposing internal permission identifiers", async () => {
    // The message and field intentionally name different internal permissions.
    // Neither belongs in operator-facing copy; the refusal state is enough to
    // explain why the protected section is unavailable.
    serve({
      [GROUPS]: () => json(403, { error: `missing capability ${OTHER}`, capability: NAMED }),
      [AGENTS]: () => json(200, { agents: AGENT_ROWS }),
      [KEYS_PENDING]: () => json(200, { ok: true, keys: [] }),
    });
    await mount();

    expect(overlayText()).toContain(REFUSED);
    expect(overlayText()).not.toContain(NAMED);
    expect(overlayText()).not.toContain(OTHER);
  });

  it("does not say the server failed to answer when it answered 403", async () => {
    serve({
      [GROUPS]: () => json(403, { error: "not allowed", capability: NAMED }),
      [AGENTS]: () => json(200, { agents: AGENT_ROWS }),
      [KEYS_PENDING]: () => json(200, { ok: true, keys: [] }),
    });
    await mount();

    // Walked with a member session, this sentence sends an operator to check a
    // network that is fine, for a permission they simply do not hold.
    expect(overlayText()).not.toContain(UNREACHABLE);
    // And it is certainly not an empty mesh: the agents route answered with two
    // agents in this very test, and the screen still may not say so.
    expect(overlayText()).not.toContain(EMPTY);
    expect(overlayText()).toContain(say("common.retry"));
  });

  it("leaves the capability out rather than guessing when the server named none", async () => {
    serve({
      [GROUPS]: () => json(403, { error: "not allowed" }),
      [AGENTS]: () => json(200, { agents: AGENT_ROWS }),
      [KEYS_PENDING]: () => json(200, { ok: true, keys: [] }),
    });
    await mount();

    expect(overlayText()).toContain(REFUSED);
    // The overlay holds the sentence and the retry control, neither of which
    // carries a bracket. A parenthesis here could only be a name the screen
    // supplied itself — the exact thing `refusedText` exists to stop.
    expect(overlayText()).not.toContain("(");
  });

  it("draws nothing at all rather than half a mesh, when only one of the two reads was refused", async () => {
    // **The headline case.** The agents route answered, in full, with two
    // agents; the groups route refused. A screen that drew what it did get
    // would show a canvas an operator has no way to read as incomplete.
    serve({
      [GROUPS]: () => json(403, { error: "not allowed", capability: NAMED }),
      [AGENTS]: () => json(200, { agents: AGENT_ROWS }),
      [KEYS_PENDING]: () => json(200, { ok: true, keys: [] }),
    });
    await mount();

    expect(calls.some((u) => u.endsWith(AGENTS))).toBe(true);
    expect(drawn("topology-cluster")).toBe(0);
    expect(drawn("topology-agent")).toBe(0);
    expect(drawn("topology-gateway")).toBe(0);
    // An empty canvas needs a reason written on it, and the heading must not
    // supply the counts of a mesh nobody described.
    expect(subtitle()).toBe(say("common.loadError"));
    expect(hudText()).toContain(say("common.disconnected"));
    expect(hudText()).not.toContain(`${say("topo.hud.groups")}: 0`);
    expect(hudText()).not.toContain(`${say("topo.hud.gateways")}: 0`);
  });
});

describe("no answer at all is a third thing", () => {
  it("says the server did not answer, and does not call it a refusal", async () => {
    serve({
      [GROUPS]: () => { throw new TypeError("Failed to fetch"); },
      [AGENTS]: () => json(200, { agents: AGENT_ROWS }),
      [KEYS_PENDING]: () => json(200, { ok: true, keys: [] }),
    });
    await mount();

    expect(overlayText()).toContain(UNREACHABLE);
    // "This account may not read this screen" about a connection that was
    // never made sends the operator to an administrator for a permission they
    // already have.
    expect(overlayText()).not.toContain(REFUSED);
    expect(overlayText()).not.toContain(EMPTY);
    expect(subtitle()).toBe(say("common.loadError"));
    // A read that failed is one the operator can try again; an empty mesh is
    // not. The control belongs to both failures and to neither of the others.
    expect(overlayText()).toContain(say("common.retry"));

    const locationPrototype = Object.getPrototypeOf(window.location) as { reload: () => void };
    const realReload = locationPrototype.reload;
    let reloads = 0;
    locationPrototype.reload = () => { reloads += 1; };
    try {
      const retry = [...document.querySelectorAll("button")]
        .find((button) => (button.textContent ?? "").includes(say("common.retry")));
      if (!retry) throw new Error("the unreachable topology has no retry control");
      fireEvent.click(retry);
      expect(reloads).toBe(1);
    } finally {
      locationPrototype.reload = realReload;
    }
  });

  it("does not read a broken proxy as the server saying no", async () => {
    // A `5xx` is the server failing, not the server refusing. This is the line
    // a `502` crossed elsewhere in this console, where it signed operators out
    // of a running deployment and sent them to a login form behind the same
    // proxy.
    serve({
      [GROUPS]: () => json(502, { error: "bad gateway" }),
      [AGENTS]: () => json(200, { agents: AGENT_ROWS }),
      [KEYS_PENDING]: () => json(200, { ok: true, keys: [] }),
    });
    await mount();

    expect(overlayText()).toContain(UNREACHABLE);
    expect(overlayText()).not.toContain(REFUSED);
  });
});

describe("empty is what the server said, and only that", () => {
  it("says there is nothing to draw when both routes answered with nothing", async () => {
    serve({
      [GROUPS]: () => json(200, { groups: [] }),
      [AGENTS]: () => json(200, { agents: [] }),
      [KEYS_PENDING]: () => json(200, { ok: true, keys: [] }),
    });
    await mount();

    expect(overlayText()).toContain(EMPTY);
    // The three states this is not. An answered-and-empty mesh is the only one
    // of the four in which a `0` is a measurement rather than a guess.
    expect(overlayText()).not.toContain(LOADING);
    expect(overlayText()).not.toContain(UNREACHABLE);
    expect(overlayText()).not.toContain(REFUSED);
    expect(overlayText()).not.toContain(say("common.retry"));
    expect(hudText()).not.toContain(say("common.disconnected"));
    expect(hudText()).toContain(`${say("topo.hud.groups")}: 0`);
    expect(hudText()).toContain(`${say("topo.hud.agents")}: 0`);
    expect(subtitle()).toBe(
      say("topo.subtitle").replace("{groups}", "0").replace("{agents}", "0"),
    );
  });

  it("does not put a group the server says is empty on the canvas as holding the mesh", async () => {
    // The defect this page's own comment records: when a group held nobody,
    // every live agent was pushed into it, with no condition and no match — so
    // an empty group drew as holding the whole mesh, and drew them again for
    // the next empty group. `SC-CONSIST-01` cannot see it, because the heading
    // and the canvas both read the inflated list and agree with each other.
    serve({
      [GROUPS]: () => json(200, { groups: [
        { group_id: "grp_empty", members: [] },
        { group_id: "grp_beta", members: ["svc-alpha-1"] },
      ] }),
      [AGENTS]: () => json(200, { agents: AGENT_ROWS }),
      [KEYS_PENDING]: () => json(200, { ok: true, keys: [] }),
    });
    await mount();

    // One agent is declared a member of anything. The other is in the registry
    // and in no group, so it gets an explicit visual home instead of being
    // pushed into Empty or silently discarded.
    expect(drawn("topology-cluster")).toBe(3);
    expect(drawnClusters("group")).toBe(2);
    expect(drawnClusters("unassigned")).toBe(1);
    expect(drawn("topology-agent")).toBe(2);
    // **`|| 1` turned a known 0 into a 1** in this exact pill. A group the
    // server described as empty says nothing else.
    expect(clusterLabels()).toEqual(["grp_empty (0)", "grp_beta (1)"]);
    expect(unassignedClusterLabels()).toEqual([`${say("topo.noGroup")} (1)`]);
  });

  it("keeps a registered agent visible when the reported default group has no members", async () => {
    // T-035: the page received both answers below. `soak-claude` was in the
    // registry and `default.members` was empty, but the old graph iterated only
    // group members and therefore dropped the registry row without a word.
    serve({
      [GROUPS]: () => json(200, { groups: [
        { group_id: "default", members: [] },
      ] }),
      [AGENTS]: () => json(200, { agents: [
        { id: "soak-claude", name: "ai-claude", description: "AI Claude", type: "ai-claude", created_at: "2026-08-22T00:00:00Z" },
      ] }),
      [KEYS_PENDING]: () => json(200, { ok: true, keys: [] }),
    });
    await mount();

    expect(calls.some((url) => url.endsWith(AGENTS))).toBe(true);
    expect(drawn("topology-cluster")).toBe(2);
    expect(drawnClusters("group")).toBe(1);
    expect(drawnClusters("unassigned")).toBe(1);
    expect(drawn("topology-agent")).toBe(1);
    expect(drawn("topology-gateway")).toBe(1);
    expect(clusterLabels()).toEqual(["default (0)"]);
    expect(unassignedClusterLabels()).toEqual([`${say("topo.noGroup")} (1)`]);
    expect(screen.getByText("soak-claude")).toBeTruthy();
    // The no-group orbit is a visual container, not a second server group or
    // a gateway. The measured counters stay tied to the two API answers.
    expect(subtitle()).toBe(
      say("topo.subtitle").replace("{groups}", "1").replace("{agents}", "1"),
    );
    expect(hudText()).toContain(`${say("topo.hud.groups")}: 1`);
    expect(hudText()).toContain(`${say("topo.hud.agents")}: 1`);
    expect(hudText()).toContain(`${say("topo.hud.gateways")}: 1`);
  });

  it("uses the reported default membership without also drawing the no-group safety net", async () => {
    // T-036: the server now derives default membership for an identity that
    // has never been explicitly moved. T-035 must remain a fallback for
    // divergent responses, not duplicate the normal server answer.
    serve({
      [GROUPS]: () => json(200, { groups: [
        { group_id: "default", members: ["soak-claude"] },
      ] }),
      [AGENTS]: () => json(200, { agents: [
        { id: "soak-claude", name: "ai-claude", description: "AI Claude", type: "ai-claude", created_at: "2026-08-22T00:00:00Z" },
      ] }),
      [KEYS_PENDING]: () => json(200, { ok: true, keys: [] }),
    });
    await mount();

    expect(drawn("topology-cluster")).toBe(1);
    expect(drawnClusters("group")).toBe(1);
    expect(drawnClusters("unassigned")).toBe(0);
    expect(drawn("topology-agent")).toBe(1);
    expect(clusterLabels()).toEqual(["default (1)"]);
    expect(screen.getByText("soak-claude")).toBeTruthy();
  });
});

describe("the heading counts what is actually on the canvas", () => {
  it("draws and addresses only the live row beside the contract fixture's torn-down row", async () => {
    const live = CONTRACT_AGENT_BODY.agents.find((agent) => agent.deleted_at === null)!;
    const retired = CONTRACT_AGENT_BODY.agents.find((agent) => typeof agent.deleted_at === "string")!;
    serve({
      [GROUPS]: () => json(200, { groups: [{
        group_id: "default",
        members: [live.id, retired.id],
      }] }),
      [AGENTS]: () => json(200, CONTRACT_AGENT_BODY),
      [KEYS_PENDING]: () => json(200, { ok: true, keys: [] }),
    });
    await mount();

    const nodes = screen.queryAllByTestId("topology-agent");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.textContent).toContain(live.id);
    expect(document.body.textContent ?? "").not.toContain(retired.id);
    expect(subtitle()).toBe(
      say("topo.subtitle").replace("{groups}", "1").replace("{agents}", "1"),
    );
  });

  it("does not draw or count a person that shares the unified registry and group namespace", async () => {
    serve({
      [GROUPS]: () => json(200, { groups: [
        { group_id: "default", members: ["admin", "svc-alpha-1"] },
      ] }),
      [AGENTS]: () => json(200, { agents: [
        { id: "admin", name: "admin", description: "Local account", channel: "web", type: "user" },
        AGENT_ROWS[0],
      ] }),
      [KEYS_PENDING]: () => json(200, { ok: true, keys: [] }),
    });
    await mount();

    expect(drawn("topology-agent")).toBe(1);
    expect(clusterLabels()).toEqual(["default (1)"]);
    expect(subtitle()).toBe(
      say("topo.subtitle").replace("{groups}", "1").replace("{agents}", "1"),
    );
    expect(hudText()).toContain(`${say("topo.hud.agents")}: 1`);
    expect(document.body.textContent ?? "").not.toContain("Local account");
  });

  it("reports zero agents when the only registry row is a person", async () => {
    serve({
      [GROUPS]: () => json(200, { groups: [
        { group_id: "default", members: ["admin"] },
      ] }),
      [AGENTS]: () => json(200, { agents: [
        { id: "admin", name: "admin", description: "Local account", channel: "web", type: "user" },
      ] }),
      [KEYS_PENDING]: () => json(200, { ok: true, keys: [] }),
    });
    await mount();

    expect(drawn("topology-agent")).toBe(0);
    expect(clusterLabels()).toEqual(["default (0)"]);
    expect(subtitle()).toBe(
      say("topo.subtitle").replace("{groups}", "1").replace("{agents}", "0"),
    );
    expect(hudText()).toContain(`${say("topo.hud.agents")}: 0`);
  });

  it("states the same number of agents the canvas drew, and does not fold gateways into it", async () => {
    healthy();
    await mount();

    // `I-064`: the heading said six agents over a canvas holding two, on a mesh
    // with two — one sum accumulated twice while drawing, and nothing compared
    // it against the drawing. Gateways are the other half: they are drawn, and
    // adding them here made the heading disagree with the counter beside it.
    expect(drawn("topology-agent")).toBe(2);
    expect(drawn("topology-gateway")).toBe(1);
    expect(drawn("topology-cluster")).toBe(1);
    expect(subtitle()).toBe(
      say("topo.subtitle").replace("{groups}", "1").replace("{agents}", "2"),
    );
    expect(hudText()).toContain(`${say("topo.hud.agents")}: 2`);
    expect(hudText()).toContain(`${say("topo.hud.gateways")}: 1`);
    expect(clusterLabels()).toEqual(["grp_alpha (2)"]);
    // A drawn mesh has no reason card over it at all. Read as text rather than
    // as a node: `expect(element).toBe(null)` fails by serialising the whole
    // subtree, and on this page that hangs the reporter — a mutant that draws
    // the card over a populated canvas then costs a timeout instead of a
    // failure, which is not a test result anybody can read.
    expect(overlay()?.textContent ?? null).toBe(null);
  });

  it("counts one agent once when two groups both claim it", async () => {
    serve({
      [GROUPS]: () => json(200, { groups: [
        { group_id: "grp_alpha", members: ["svc-alpha-1"] },
        { group_id: "grp_beta", members: ["svc-alpha-1"] },
      ] }),
      // Keep this fixture about duplicate membership. A second registry row
      // with no membership is now (correctly) another node in the no-group
      // orbit and would make the expected canvas size two for an unrelated
      // reason.
      [AGENTS]: () => json(200, { agents: [AGENT_ROWS[0]] }),
      [KEYS_PENDING]: () => json(200, { ok: true, keys: [] }),
    });
    await mount();

    // The canvas is keyed by identity, so the shared agent is one node. A
    // heading that added the two memberships would report two agents over a
    // canvas holding one — `I-064` told a third way.
    expect(drawn("topology-agent")).toBe(1);
    expect(subtitle()).toBe(
      say("topo.subtitle").replace("{groups}", "2").replace("{agents}", "1"),
    );
    // The counter beside the canvas is the same claim in a second place, and
    // this is the one fixture where summing the group pills gives a different
    // answer from counting the nodes — two memberships, one agent. A HUD that
    // added the pills up would read `2` here and agree with the drawing
    // everywhere else, which is how it would have shipped.
    expect(hudText()).toContain(`${say("topo.hud.agents")}: 1`);
    expect(clusterLabels()).toEqual(["grp_alpha (1)", "grp_beta (1)"]);
  });
});

describe("a node reports what the mesh measured, not what the screen hopes", () => {
  const select = async (label: string) => {
    const node = screen.queryAllByTestId("topology-agent")
      .find((g) => [...g.querySelectorAll("text")].some((el) => el.textContent === label));
    if (!node) throw new Error(`no agent node is labelled ${label}`);
    await act(async () => { fireEvent.click(node); });
  };

  it("says an agent with no presence record has never been seen", async () => {
    healthy();
    await mount();
    await select("Alpha Two");

    // This read `agentObj.status`, a key `GET /api/v1/agents` does not send
    // (SPEC § 9.1), so every node came out "Online" and the topology reported
    // the whole mesh up regardless of what the mesh knew. `last_seen_at: null`
    // is a missing record, and whether silence means offline is an operating
    // policy this screen does not get to decide.
    expect(panelText()).toContain(say("dash.op.neverSeen"));
    expect(panelText()).not.toContain(say("dash.op.seen"));
  });

  it("says an agent the mesh has a record for has been seen", async () => {
    healthy();
    await mount();
    await select("Alpha One");

    // The control for the assertion above: without it, a panel that says
    // "never seen" about every agent — the same one-answer defect with the
    // other word in it — passes the previous test untouched.
    expect(panelText()).toContain(say("dash.op.seen"));
    expect(panelText()).not.toContain(say("dash.op.neverSeen"));
  });
});

describe("a receipt is read, not assumed", () => {
  const sendTo = async (label: string) => {
    const node = screen.queryAllByTestId("topology-agent")
      .find((g) => [...g.querySelectorAll("text")].some((el) => el.textContent === label));
    if (!node) throw new Error(`no agent node is labelled ${label}`);
    await act(async () => { fireEvent.click(node); });
    const send = [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Send Message"));
    if (!send) throw new Error("the node drawer offers no send control");
    await act(async () => { fireEvent.click(send); });
    await settle();
  };

  it("calls a hub refusal a refusal, though the write returned 201", async () => {
    serve({
      [GROUPS]: () => json(200, { groups: GROUP_ROWS }),
      [AGENTS]: () => json(200, { agents: AGENT_ROWS }),
      [KEYS_PENDING]: () => json(200, { ok: true, keys: [] }),
      [MESSAGES]: () => json(201, { ok: true, message: {
        id: "msg_1", from: "operator", to: "svc-alpha-1", ts: "2026-08-20T00:00:00Z", status: "failed",
      } }),
    });
    await mount();
    await sendTo("Alpha One");

    // `201` is not delivery. The server writes `failed` into this same body
    // when the hub refuses the message, and this toast used to report it as a
    // success — in green, with nothing else on the screen to contradict it.
    expect(calls.some((u) => u.endsWith(MESSAGES))).toBe(true);
    expect(toastText()).toContain(say("topo.send.refused"));
    expect(toastText()).not.toContain(say("topo.send.accepted"));
    expect(sendResult().getAttribute("data-message-status")).toBe("failed");
    expect(sendResultText()).toContain(say("topo.send.refused"));
    expect(sendResultText()).toContain("failed");
  });

  it("calls an accepted-but-undelivered message pending", async () => {
    serve({
      [GROUPS]: () => json(200, { groups: GROUP_ROWS }),
      [AGENTS]: () => json(200, { agents: AGENT_ROWS }),
      [KEYS_PENDING]: () => json(200, { ok: true, keys: [] }),
      [MESSAGES]: () => json(201, { ok: true, message: {
        id: "msg_2", from: "operator", to: "svc-alpha-1", ts: "2026-08-20T00:00:00Z", status: "pending",
      } }),
    });
    await mount();
    const node = screen.queryAllByTestId("topology-agent")
      .find((g) => [...g.querySelectorAll("text")].some((el) => el.textContent === "Alpha One"));
    if (!node) throw new Error("no agent node is labelled Alpha One");
    await act(async () => { fireEvent.click(node); });
    const before = panelText();
    const send = [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Send Message"));
    if (!send) throw new Error("the node drawer offers no send control");
    await act(async () => { fireEvent.click(send); });
    await settle();

    // Acceptance is not delivery. The visible panel changes, names the exact
    // status the server returned, and does not round waiting up to success.
    expect(panelText()).not.toBe(before);
    expect(sendResult().getAttribute("data-message-status")).toBe("pending");
    expect(sendResultText()).toContain(say("topo.send.pending"));
    expect(sendResultText()).toContain("pending");
    expect(sendResultText()).not.toContain(say("topo.send.delivered"));
    expect(toastText()).toContain(say("topo.send.pending"));
    expect(toastText()).not.toContain(say("topo.send.refused"));
    const close = toastBox()?.querySelector("button");
    if (!close) throw new Error("the send result toast has no close control");
    fireEvent.click(close);
    expect(toastBox()).toBeNull();
  });

  it("shows a delivered receipt as delivered", async () => {
    serve({
      [GROUPS]: () => json(200, { groups: GROUP_ROWS }),
      [AGENTS]: () => json(200, { agents: AGENT_ROWS }),
      [KEYS_PENDING]: () => json(200, { ok: true, keys: [] }),
      [MESSAGES]: () => json(201, { ok: true, message: {
        id: "msg_delivered", from: "operator", to: "svc-alpha-1", ts: "2026-08-20T00:00:00Z", status: "delivered",
      } }),
    });
    await mount();
    await sendTo("Alpha One");

    expect(sendResult().getAttribute("data-message-status")).toBe("delivered");
    expect(sendResultText()).toContain(say("topo.send.delivered"));
    expect(sendResultText()).toContain("delivered");
    expect(sendResultText()).not.toContain(say("topo.send.pending"));
  });

  it("shows a read receipt as read", async () => {
    serve({
      [GROUPS]: () => json(200, { groups: GROUP_ROWS }),
      [AGENTS]: () => json(200, { agents: AGENT_ROWS }),
      [KEYS_PENDING]: () => json(200, { ok: true, keys: [] }),
      [MESSAGES]: () => json(201, { ok: true, message: {
        id: "msg_read", from: "operator", to: "svc-alpha-1", ts: "2026-08-20T00:00:00Z", status: "read",
      } }),
    });
    await mount();
    await sendTo("Alpha One");

    expect(sendResult().getAttribute("data-message-status")).toBe("read");
    expect(sendResultText()).toContain(say("topo.send.read"));
    expect(sendResultText()).toContain("read");
    expect(sendResultText()).not.toContain(say("topo.send.pending"));
  });

  it("removes the receipt toast when its product timeout expires", async () => {
    serve({
      [GROUPS]: () => json(200, { groups: GROUP_ROWS }),
      [AGENTS]: () => json(200, { agents: AGENT_ROWS }),
      [KEYS_PENDING]: () => json(200, { ok: true, keys: [] }),
      [MESSAGES]: () => json(201, { ok: true, message: {
        id: "msg_timeout", from: "operator", to: "svc-alpha-1", ts: "2026-08-20T00:00:00Z", status: "pending",
      } }),
    });

    const realSetTimeout = globalThis.setTimeout;
    let fireAutoClose: (() => void) | null = null;
    globalThis.setTimeout = ((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
      if (delay === 3500) {
        fireAutoClose = () => callback(...args);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }
      return realSetTimeout(callback, delay, ...args);
    }) as typeof globalThis.setTimeout;

    try {
      await mount();
      await sendTo("Alpha One");
      expect(toastText()).toContain(say("topo.send.pending"));
      if (!fireAutoClose) throw new Error("the receipt toast scheduled no product timeout");

      await act(async () => { fireAutoClose?.(); });
      expect(toastBox() === null).toBe(true);
      // The nearby result remains after the transient duplicate disappears.
      expect(sendResultText()).toContain(say("topo.send.pending"));
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  it("does not report a send the server never took", async () => {
    serve({
      [GROUPS]: () => json(200, { groups: GROUP_ROWS }),
      [AGENTS]: () => json(200, { agents: AGENT_ROWS }),
      [KEYS_PENDING]: () => json(200, { ok: true, keys: [] }),
      [MESSAGES]: () => { throw new TypeError("Failed to fetch"); },
    });
    await mount();
    await sendTo("Alpha One");

    // Sent-in-the-browser-only is the worst of the three: the operator reads
    // that the message went and stops watching a delivery that never started.
    expect(toastText()).toContain(say("topo.send.failed"));
    expect(toastText()).not.toContain(say("topo.send.accepted"));
    expect(sendResult().getAttribute("data-message-status")).toBe("error");
    expect(sendResultText()).toContain(say("topo.send.failed"));
    expect(sendResultText()).toContain("Failed to fetch");
  });

  it("shows the server's error when the send route returns 5xx", async () => {
    serve({
      [GROUPS]: () => json(200, { groups: GROUP_ROWS }),
      [AGENTS]: () => json(200, { agents: AGENT_ROWS }),
      [KEYS_PENDING]: () => json(200, { ok: true, keys: [] }),
      [MESSAGES]: () => json(503, { error: "message route unavailable" }),
    });
    await mount();
    await sendTo("Alpha One");

    expect(sendResult().getAttribute("data-message-status")).toBe("error");
    expect(sendResultText()).toContain(say("topo.send.failed"));
    expect(sendResultText()).toContain("message route unavailable");
  });
});


describe("the drawer's peer list is a list of peers", () => {
  it("names each neighbour once, and counts what it names", async () => {
    // The ring is walked once per member, so every pair is joined by one edge
    // and a neighbour reaches a node from one side only. A peer appearing twice
    // is the same defect as `I-064`'s heading — a number an operator reads as
    // "how connected is this node" that counts drawings rather than peers, and
    // the chips beside it are the only place it shows.
    serve({
      [GROUPS]: () => json(200, { groups: [
        { group_id: "grp_alpha", members: ["svc-alpha-1", "svc-alpha-2", "svc-alpha-3"] },
      ] }),
      [AGENTS]: () => json(200, { agents: [
        ...AGENT_ROWS,
        { id: "svc-alpha-3", name: "Alpha Three", description: "Alpha Three", type: "runtime", last_seen_at: null },
      ] }),
      [KEYS_PENDING]: () => json(200, { ok: true, keys: [] }),
    });
    await mount();

    const node = screen.queryAllByTestId("topology-agent")
      .find((g) => [...g.querySelectorAll("text")].some((el) => el.textContent === "Alpha One"));
    if (!node) throw new Error("no agent node is labelled Alpha One");
    await act(async () => { fireEvent.click(node); });

    const chips = [...(panel()?.querySelectorAll("button") ?? [])]
      .map((b) => b.textContent ?? "")
      .filter((label) => label.includes("svc-") || label.includes("gw-"));
    expect(chips.length).toBe(new Set(chips).size);
    // The heading over the chips is the same fact stated as a number, and the
    // two disagreeing is how a repeat would reach an operator who never counts.
    expect(panelText()).toContain(`${say("topo.peers")} (${chips.length}):`);
  });

  it("flies to the neighbour a chip names, out of a filter that was hiding it", async () => {
    // `handleSelectPeer` used to carry a second behaviour for a peer id the
    // node dictionary did not hold: select the id, and leave everything else
    // where it was. Nothing produces that state — every id in `directPeers` is
    // pushed by an edge loop that has already found both endpoints in the
    // dictionary — so the branch sat unreachable and uncovered, and it is
    // gone. What it was standing in for is asserted here instead, on every
    // chip the drawer draws: the id resolves to a node, and the click *flies*
    // to it. The drawer alone cannot tell the two apart, because the deleted
    // branch opened one too; the group filter can, because flying clears it
    // and a bare selection does not — which is the difference between landing
    // on a peer you can see and landing on one the canvas is still hiding.
    serve({
      [GROUPS]: () => json(200, { groups: [
        { group_id: "grp_alpha", members: ["svc-alpha-1", "svc-alpha-2", "svc-alpha-3"] },
        { group_id: "grp_beta", members: ["svc-beta-1"] },
      ] }),
      [AGENTS]: () => json(200, { agents: [
        ...AGENT_ROWS,
        { id: "svc-alpha-3", name: "Alpha Three", description: "Alpha Three", type: "runtime", last_seen_at: null },
        { id: "svc-beta-1", name: "Beta One", description: "Beta One", type: "runtime", last_seen_at: null },
      ] }),
      [KEYS_PENDING]: () => json(200, { ok: true, keys: [] }),
    });

    // The camera eases over `requestAnimationFrame`, and a half-run move is a
    // transform between two nodes. Every frame is run to its end here.
    const realRequestAnimationFrame = globalThis.requestAnimationFrame;
    const realCancelAnimationFrame = globalThis.cancelAnimationFrame;
    let frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => {};
    const finishAnimations = async () => {
      const pending = frames;
      frames = [];
      await act(async () => { for (const frame of pending) frame(performance.now() + 1000); });
    };

    try {
      await mount();
      await finishAnimations();

      const filter = document.querySelector("select") as HTMLSelectElement | null;
      if (!filter) throw new Error("the topology canvas has no group filter");

      /** A drawn node, by the name the canvas writes under it. */
      const drawnNode = (label: string): HTMLElement | null =>
        [...screen.queryAllByTestId("topology-agent"), ...screen.queryAllByTestId("topology-gateway")]
          .find((g) => [...g.querySelectorAll("text")].some((el) => el.textContent === label)) ?? null;
      const origin = () => {
        const node = drawnNode("Alpha One");
        if (!node) throw new Error("no agent node is labelled Alpha One");
        return node;
      };

      await act(async () => { fireEvent.click(origin()); });
      await finishAnimations();

      const peers = [...(panel()?.querySelectorAll("button") ?? [])]
        .map((b) => b.getAttribute("title") ?? "")
        .filter((title) => title.startsWith("svc-") || title.startsWith("gw-"));
      // A ring of three plus the gateway link. Asserted, because a drawer with
      // no chips at all would make the loop below vacuous.
      expect(peers.sort()).toEqual(["gw-grp_alpha", "svc-alpha-2", "svc-alpha-3"]);
      // The chip carries the identity and the canvas draws the display name,
      // so the pairing is written out rather than derived: a test that rebuilt
      // the name the way the page does would pass on a page that built it
      // wrongly.
      const DRAWN_AS: Record<string, string> = {
        "gw-grp_alpha": "grp_alpha-gw",
        "svc-alpha-2": "Alpha Two",
        "svc-alpha-3": "Alpha Three",
      };

      for (const peer of peers) {
        // Back to the same node each time, then filtered away to Beta — which
        // holds neither the node nor any of its peers, so every chip below is
        // a chip for something the canvas is currently dimming.
        await act(async () => { fireEvent.click(origin()); });
        await finishAnimations();
        await act(async () => { fireEvent.change(filter, { target: { value: "grp_beta" } }); });

        const shown = DRAWN_AS[peer];
        if (!shown) throw new Error(`this test states no drawer name for ${peer}`);
        const hidden = drawnNode(shown);
        if (!hidden) throw new Error(`the canvas draws no node for ${peer}`);
        // The setup has to bite, or the assertion after the click is about a
        // filter that was never hiding anything.
        expect(hidden.style.opacity).toBe("0.2");

        const chip = [...(panel()?.querySelectorAll("button") ?? [])]
          .find((b) => b.getAttribute("title") === peer);
        if (!chip) throw new Error(`the drawer draws no chip for ${peer}`);
        await act(async () => { fireEvent.click(chip); });
        await finishAnimations();

        // Open and about the peer — a drawer that closed would mean the id
        // reached `nodes` and found nothing, the state being denied here —
        // and the canvas showing it rather than still dimming it.
        expect({
          drawer: panelText().includes(shown),
          filter: filter.value,
          peerOpacity: drawnNode(shown)?.style.opacity,
        }, `the chip for ${peer} selected without flying`).toEqual({
          drawer: true, filter: "all", peerOpacity: "1",
        });
      }
    } finally {
      globalThis.requestAnimationFrame = realRequestAnimationFrame;
      globalThis.cancelAnimationFrame = realCancelAnimationFrame;
    }
  });
});


describe("the populated canvas controls", () => {
  it("searches, zooms, pans, filters, and navigates the minimap without losing the selected node", async () => {
    // Three members make a real ring: each peer is unique. A two-member ring
    // walks A→B and B→A and would exercise React's duplicate-key warning rather
    // than the controls this scenario is about.
    serve({
      [GROUPS]: () => json(200, { groups: [{
        group_id: "grp_alpha",
        name: "Alpha",
        members: ["svc-alpha-1", "svc-alpha-2", "svc-alpha-3"],
      }] }),
      [AGENTS]: () => json(200, { agents: [
        ...AGENT_ROWS,
        { id: "svc-alpha-3", name: "Alpha Three", description: "Alpha Three", type: "runtime", last_seen_at: null },
      ] }),
      [KEYS_PENDING]: () => json(200, { ok: true, keys: [] }),
    });

    const realRequestAnimationFrame = globalThis.requestAnimationFrame;
    const realCancelAnimationFrame = globalThis.cancelAnimationFrame;
    const frames: Array<{ id: number; callback: FrameRequestCallback }> = [];
    const cancelled: number[] = [];
    let nextFrameId = 1;
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
      const id = nextFrameId++;
      frames.push({ id, callback });
      return id;
    };
    globalThis.cancelAnimationFrame = (id: number) => {
      cancelled.push(id);
      const index = frames.findIndex((frame) => frame.id === id);
      if (index >= 0) frames.splice(index, 1);
    };

    const finishAnimations = async () => {
      const pending = frames.splice(0);
      await act(async () => {
        for (const frame of pending) frame.callback(performance.now() + 1000);
      });
    };

    try {
      await mount();

      const minimap = document.querySelector(".minimap-container") as HTMLElement | null;
      const viewport = minimap?.parentElement as HTMLElement | null;
      if (!minimap || !viewport) throw new Error("the topology canvas has no minimap navigation surface");

      Object.defineProperty(viewport, "getBoundingClientRect", {
        configurable: true,
        value: () => ({ x: 0, y: 0, left: 0, top: 0, right: 1200, bottom: 700, width: 1200, height: 700, toJSON: () => ({}) }),
      });
      Object.defineProperty(minimap, "getBoundingClientRect", {
        configurable: true,
        value: () => ({ x: 20, y: 570, left: 20, top: 570, right: 220, bottom: 680, width: 200, height: 110, toJSON: () => ({}) }),
      });
      await act(async () => { window.dispatchEvent(new Event("resize")); });
      const cameraTransform = (): string | undefined => [...document.querySelectorAll("g")]
        .map((group) => group.getAttribute("transform") ?? "")
        .find((transform) => transform.startsWith("translate("));
      const expectValidCamera = (where: string) => {
        const camera = cameraTransform();
        if (!camera || camera.includes("NaN")) {
          throw new Error(`the topology camera became invalid during ${where}: ${camera ?? "missing"}`);
        }
      };
      expectValidCamera("mount");

      let captured = 0;
      let released = 0;
      Object.defineProperty(viewport, "setPointerCapture", { configurable: true, value: () => { captured += 1; } });
      Object.defineProperty(viewport, "hasPointerCapture", { configurable: true, value: () => true });
      Object.defineProperty(viewport, "releasePointerCapture", { configurable: true, value: () => { released += 1; } });

      const search = document.querySelector('input[type="text"]') as HTMLInputElement | null;
      if (!search) throw new Error("the topology canvas has no agent search control");
      fireEvent.change(search, { target: { value: "Alpha One" } });
      fireEvent.keyDown(search, { key: "Enter" });
      const partial = frames.shift();
      if (!partial) throw new Error("the topology search did not start its camera move");
      await act(async () => { partial.callback(performance.now() + 50); });
      await finishAnimations();
      expectValidCamera("search");

      if (!panelText().includes("Alpha One")) {
        throw new Error("the topology search did not open the selected node drawer");
      }

      // Open and close the suggestion box through both of its dismissal paths.
      const resultsOpen = () => [...document.querySelectorAll("div")]
        .some((item) => item.children.length === 0 && item.textContent?.startsWith(`${say("topo.results")} (`));
      fireEvent.change(search, { target: { value: "Alpha" } });
      expect(resultsOpen()).toBe(true);
      fireEvent.keyDown(search, { key: "Escape" });
      expect(resultsOpen()).toBe(false);
      fireEvent.focus(search);
      expect(resultsOpen()).toBe(true);
      fireEvent.change(search, { target: { value: "Alpha" } });
      fireEvent.mouseDown(document.body);
      expect(resultsOpen()).toBe(false);

      fireEvent.change(search, { target: { value: "Alpha Two" } });
      const resultLabel = [...(search.parentElement?.querySelectorAll("span") ?? [])]
        .find((item) => item.textContent === "Alpha Two");
      const result = resultLabel?.parentElement?.parentElement as HTMLElement | null;
      if (!result) throw new Error("the topology search did not list its matching node");
      fireEvent.mouseEnter(result);
      fireEvent.mouseLeave(result);
      fireEvent.click(result);
      await finishAnimations();
      expect(panelText()).toContain("Alpha Two");

      const peer = [...(panel()?.querySelectorAll("button") ?? [])]
        .find((button) => (button.textContent ?? "").includes("svc-alpha-1"));
      if (!peer) throw new Error("the selected topology node has no peer navigation control");
      fireEvent.click(peer);
      await finishAnimations();
      expect(panelText()).toContain("Alpha One");

      const closeDrawer = [...(panel()?.querySelectorAll("button") ?? [])]
        .find((button) => button.textContent === "✕");
      if (!closeDrawer) throw new Error("the selected topology node has no close control");
      fireEvent.click(closeDrawer);
      if (panel()) throw new Error("the topology drawer stayed open after its close control was used");

      const gateway = screen.queryAllByTestId("topology-gateway")[0];
      const gatewayLabel = gateway?.querySelectorAll("text")[1]?.textContent;
      if (!gateway || !gatewayLabel) throw new Error("the topology canvas did not draw a named gateway");
      fireEvent.click(gateway);
      await finishAnimations();
      expect(panelText()).toContain(gatewayLabel);

      const alphaOneNode = screen.queryAllByTestId("topology-agent")
        .find((node) => [...node.querySelectorAll("text")].some((label) => label.textContent === "Alpha One"));
      if (!alphaOneNode) throw new Error("the topology canvas did not draw Alpha One");
      fireEvent.click(alphaOneNode);
      await finishAnimations();
      expectValidCamera("node navigation");

      const drawer = panel();
      if (!drawer) throw new Error("node navigation did not open the drawer");
      let escapedPointerDown = 0;
      let escapedMouseDown = 0;
      const onPointerDown = () => { escapedPointerDown += 1; };
      const onMouseDown = () => { escapedMouseDown += 1; };
      document.addEventListener("pointerdown", onPointerDown);
      document.addEventListener("mousedown", onMouseDown);
      try {
        fireEvent.pointerDown(drawer, { pointerId: 3, clientX: 1, clientY: 1 });
        fireEvent.mouseDown(drawer, { clientX: 1, clientY: 1 });
      } finally {
        document.removeEventListener("pointerdown", onPointerDown);
        document.removeEventListener("mousedown", onMouseDown);
      }
      expect({ escapedPointerDown, escapedMouseDown }).toEqual({ escapedPointerDown: 0, escapedMouseDown: 0 });

      const quickMessage = drawer.querySelector('input[type="text"]') as HTMLInputElement | null;
      if (!quickMessage) throw new Error("the selected node drawer has no quick-message field");
      fireEvent.change(quickMessage, { target: { value: "health check" } });
      expect(quickMessage.value).toBe("health check");

      const filter = document.querySelector("select") as HTMLSelectElement | null;
      if (!filter) throw new Error("the topology canvas has no group filter");
      fireEvent.change(filter, { target: { value: "grp_alpha" } });
      expect(filter.value).toBe("grp_alpha");

      const buttonWithTitle = (title: string): HTMLButtonElement => {
        const button = [...document.querySelectorAll("button")].find((candidate) => candidate.title === title);
        if (!button) throw new Error(`the topology canvas has no ${title} control`);
        return button;
      };

      fireEvent.click(buttonWithTitle(say("topo.zoomIn")));
      fireEvent.click(buttonWithTitle(say("topo.zoomOut")));
      // Starting a second camera move cancels the first one rather than letting
      // two animation writers race over the same transform.
      await finishAnimations();
      fireEvent.click(buttonWithTitle(say("topo.fit")));
      await finishAnimations();
      fireEvent.click(buttonWithTitle(say("topo.zoomIn")));
      await finishAnimations();
      if (!minimap.querySelector("div")) throw new Error("the minimap did not show its lens after zooming in");
      expectValidCamera("camera buttons");

      const wheelAtCanvasCenter = (deltaY: number) => {
        // happy-dom's WheelEvent constructor does not retain clientY. Define
        // the browser values explicitly or the product quite correctly turns
        // `undefined - rect.top` into an invalid camera coordinate.
        const event = new Event("wheel", { bubbles: true, cancelable: true });
        Object.defineProperties(event, {
          deltaY: { value: deltaY },
          clientX: { value: 600 },
          clientY: { value: 350 },
        });
        viewport.dispatchEvent(event);
      };
      await act(async () => {
        wheelAtCanvasCenter(-1);
        wheelAtCanvasCenter(1);
      });
      expectValidCamera("wheel zoom");

      // Controls nested in the canvas are not drag handles for the canvas.
      fireEvent.pointerDown(alphaOneNode, { pointerId: 4, clientX: 400, clientY: 300 });
      fireEvent.pointerDown(filter, { pointerId: 5, clientX: 400, clientY: 300 });
      fireEvent.pointerDown(minimap, { pointerId: 6, clientX: 100, clientY: 620 });
      expect(captured).toBe(0);

      fireEvent.pointerDown(viewport, { pointerId: 7, clientX: 400, clientY: 300 });
      fireEvent.pointerMove(viewport, { pointerId: 7, clientX: 450, clientY: 340 });
      fireEvent.pointerUp(viewport, { pointerId: 7, clientX: 450, clientY: 340 });
      expect(captured).toBe(1);
      expect(released).toBe(1);
      expectValidCamera("pointer drag");

      // The global safety net ends a drag even if the pointer leaves the view.
      fireEvent.pointerDown(viewport, { pointerId: 8, clientX: 400, clientY: 300 });
      await act(async () => { window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); });

      fireEvent.mouseDown(minimap, { clientX: 100, clientY: 620 });
      await act(async () => {
        window.dispatchEvent(new MouseEvent("mousemove", { clientX: 180, clientY: 650, bubbles: true }));
        window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      });
      await finishAnimations();
      expectValidCamera("minimap navigation");

      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      });
      if (panel()) throw new Error("the topology drawer stayed open after Escape");
      expect(cancelled.length).toBeGreaterThan(0);
      expectValidCamera("Escape");
    } finally {
      cleanup();
      globalThis.requestAnimationFrame = realRequestAnimationFrame;
      globalThis.cancelAnimationFrame = realCancelAnimationFrame;
    }
  });

  it("lays out the product's large-cluster and inter-group branches", async () => {
    const alpha = Array.from({ length: 7 }, (_, index) => ({
      id: `alpha-${index + 1}`,
      name: `Alpha ${index + 1}`,
      description: `Alpha ${index + 1}`,
      type: "runtime",
      last_seen_at: index === 0 ? "2026-08-19T09:00:00Z" : null,
    }));
    serve({
      [GROUPS]: () => json(200, { groups: [
        { group_id: "grp_alpha", members: alpha.map((agent) => agent.id) },
        { group_id: "grp_beta", members: ["beta-1"] },
      ] }),
      [AGENTS]: () => json(200, { agents: [
        ...alpha,
        { id: "beta-1", name: "Beta 1", description: "Beta 1", type: "runtime", last_seen_at: null },
      ] }),
      [KEYS_PENDING]: () => json(200, { ok: true, keys: [] }),
    });
    await mount();

    expect(drawn("topology-cluster")).toBe(2);
    expect(drawn("topology-gateway")).toBe(2);
    expect(drawn("topology-agent")).toBe(8);
    expect(clusterLabels()).toEqual(["grp_alpha (7)", "grp_beta (1)"]);

    const filter = document.querySelector("select") as HTMLSelectElement | null;
    if (!filter) throw new Error("the large topology has no group filter");
    fireEvent.change(filter, { target: { value: "grp_alpha" } });
    const beta = screen.queryAllByTestId("topology-agent")
      .find((node) => [...node.querySelectorAll("text")].some((label) => label.textContent === "Beta 1"));
    if (!beta) throw new Error("the large topology did not draw its second group");
    expect(beta.style.opacity).toBe("0.2");
  });

  it("does not treat a wide world's minimap letterbox as navigable world space", async () => {
    const groups = Array.from({ length: 4 }, (_, index) => ({
      group_id: `grp_${index + 1}`,
      name: `Group ${index + 1}`,
      members: [`agent-${index + 1}`],
    }));
    const agents = groups.map((group, index) => ({
      id: group.members[0],
      name: `Agent ${index + 1}`,
      description: `Agent ${index + 1}`,
      type: "runtime",
      last_seen_at: null,
    }));
    serve({
      [GROUPS]: () => json(200, { groups }),
      [AGENTS]: () => json(200, { agents }),
      [KEYS_PENDING]: () => json(200, { ok: true, keys: [] }),
    });

    const realRequestAnimationFrame = globalThis.requestAnimationFrame;
    const realCancelAnimationFrame = globalThis.cancelAnimationFrame;
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => {};

    const finishAnimation = async () => {
      const callback = frames.shift();
      if (!callback) throw new Error("the minimap navigation did not start its camera move");
      await act(async () => { callback(performance.now() + 1000); });
    };

    try {
      await mount();
      const minimap = document.querySelector(".minimap-container") as HTMLElement | null;
      const viewport = minimap?.parentElement as HTMLElement | null;
      if (!minimap || !viewport) throw new Error("the wide topology has no minimap navigation surface");

      Object.defineProperty(viewport, "getBoundingClientRect", {
        configurable: true,
        value: () => ({ x: 0, y: 0, left: 0, top: 0, right: 1200, bottom: 1, width: 1200, height: 1, toJSON: () => ({}) }),
      });
      Object.defineProperty(minimap, "getBoundingClientRect", {
        configurable: true,
        value: () => ({ x: 20, y: 570, left: 20, top: 570, right: 220, bottom: 680, width: 200, height: 110, toJSON: () => ({}) }),
      });

      const cameraTransform = (): string => {
        const value = [...document.querySelectorAll("g")]
          .map((group) => group.getAttribute("transform") ?? "")
          .find((transform) => transform.startsWith("translate("));
        if (!value) throw new Error("the wide topology has no camera transform");
        return value;
      };

      fireEvent.mouseDown(minimap, { clientX: 120, clientY: 575 });
      await finishAnimation();
      const atTop = cameraTransform();
      fireEvent.mouseUp(minimap);

      fireEvent.mouseDown(minimap, { clientX: 120, clientY: 585 });
      await finishAnimation();
      const stillInLetterbox = cameraTransform();
      fireEvent.mouseUp(minimap);

      if (stillInLetterbox !== atTop) {
        throw new Error("the topology minimap treated its letterbox as world space");
      }
    } finally {
      cleanup();
      globalThis.requestAnimationFrame = realRequestAnimationFrame;
      globalThis.cancelAnimationFrame = realCancelAnimationFrame;
    }
  });

  it("draws an answered registry under an explicit no-group placeholder", async () => {
    serve({
      [GROUPS]: () => json(200, { groups: [] }),
      [AGENTS]: () => json(200, { agents: [AGENT_ROWS[0]] }),
      [KEYS_PENDING]: () => json(200, { ok: true, keys: [] }),
    });
    await mount();

    expect(drawn("topology-cluster")).toBe(1);
    expect(drawnClusters("group")).toBe(0);
    expect(drawnClusters("unassigned")).toBe(1);
    expect(drawn("topology-agent")).toBe(1);
    expect(drawn("topology-gateway")).toBe(0);
    expect(clusterLabels()).toEqual([]);
    expect(unassignedClusterLabels()).toEqual([`${say("topo.noGroup")} (1)`]);
    expect(subtitle()).toBe(
      say("topo.subtitle").replace("{groups}", "0").replace("{agents}", "1"),
    );
    expect(hudText()).toContain(`${say("topo.hud.groups")}: 0`);
    expect(hudText()).toContain(`${say("topo.hud.gateways")}: 0`);
  });
});
