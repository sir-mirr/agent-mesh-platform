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
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Registered once for the process and never unregistered: bun runs every test
// file's top level before it runs any test, so a register/unregister pair swaps
// the document out from under whichever file is still using it.
if (!(globalThis as { document?: unknown }).document) GlobalRegistrator.register();

// `await import`, not a static import: a static one is hoisted above the
// registration above and would load React's DOM entry into a process that has
// no document yet.
const { render, screen, cleanup, fireEvent, act } = await import("@testing-library/react");
const { MemoryRouter } = await import("react-router-dom");
const { TopologyPage } = await import("./TopologyPage.tsx");
const { I18nProvider, DICTIONARY } = await import("@/contexts/I18nContext.tsx");
const { CAPABILITY } = await import("@/types/auth.ts");

const GROUPS = "/api/v1/admin/groups";
const AGENTS = "/api/v1/agents";
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

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

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

/** Every group pill on the canvas, as `Name (count)`. */
const clusterLabels = (): string[] =>
  screen.queryAllByTestId("topology-cluster").map((g) => g.querySelector("text")?.textContent ?? "");

/** The banner a send raises. `Toast` is the one `inline-flex` div on the page. */
const toastText = (): string => {
  const el = [...document.querySelectorAll("div")].find((d) => d.style.display === "inline-flex");
  if (!el) throw new Error("the send raised no toast");
  return el.textContent ?? "";
};

/** Two agents in one group. The second has never been seen; the route sends no
 *  `status` for either, because it has no such field. */
const AGENT_ROWS = [
  { id: "svc-alpha-1", name: "Alpha One", description: "Alpha One", type: "runtime", last_seen_at: "2026-08-19T09:00:00Z" },
  { id: "svc-alpha-2", name: "Alpha Two", description: "Alpha Two", type: "runtime", last_seen_at: null },
];
const GROUP_ROWS = [
  { group_id: "grp_alpha", name: "Alpha", members: ["svc-alpha-1", "svc-alpha-2"] },
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
        { group_id: "grp_empty", name: "Empty", members: [] },
        { group_id: "grp_beta", name: "Beta", members: ["svc-alpha-1"] },
      ] }),
      [AGENTS]: () => json(200, { agents: AGENT_ROWS }),
      [KEYS_PENDING]: () => json(200, { ok: true, keys: [] }),
    });
    await mount();

    // One agent is declared a member of anything. The other is in the registry
    // and in no group, and belongs to no cluster on this canvas.
    expect(drawn("topology-cluster")).toBe(2);
    expect(drawn("topology-agent")).toBe(1);
    // **`|| 1` turned a known 0 into a 1** in this exact pill. A group the
    // server described as empty says nothing else.
    expect(clusterLabels()).toEqual(["Empty (0)", "Beta (1)"]);
  });
});

describe("the heading counts what is actually on the canvas", () => {
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
    expect(clusterLabels()).toEqual(["Alpha (2)"]);
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
        { group_id: "grp_alpha", name: "Alpha", members: ["svc-alpha-1"] },
        { group_id: "grp_beta", name: "Beta", members: ["svc-alpha-1"] },
      ] }),
      [AGENTS]: () => json(200, { agents: AGENT_ROWS }),
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
    expect(clusterLabels()).toEqual(["Alpha (1)", "Beta (1)"]);
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
  });

  it("calls an accepted message accepted", async () => {
    serve({
      [GROUPS]: () => json(200, { groups: GROUP_ROWS }),
      [AGENTS]: () => json(200, { agents: AGENT_ROWS }),
      [KEYS_PENDING]: () => json(200, { ok: true, keys: [] }),
      [MESSAGES]: () => json(201, { ok: true, message: {
        id: "msg_2", from: "operator", to: "svc-alpha-1", ts: "2026-08-20T00:00:00Z", status: "pending",
      } }),
    });
    await mount();
    await sendTo("Alpha One");

    // The control: a toast that says "refused" whatever came back would pass
    // the test above on its own.
    expect(toastText()).toContain(say("topo.send.accepted"));
    expect(toastText()).not.toContain(say("topo.send.refused"));
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
        { group_id: "grp_alpha", name: "Alpha", members: ["svc-alpha-1", "svc-alpha-2", "svc-alpha-3"] },
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

      const alphaOneNode = screen.queryAllByTestId("topology-agent")
        .find((node) => [...node.querySelectorAll("text")].some((label) => label.textContent === "Alpha One"));
      if (!alphaOneNode) throw new Error("the topology canvas did not draw Alpha One");
      fireEvent.click(alphaOneNode);
      await finishAnimations();
      expectValidCamera("node navigation");

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
        { group_id: "grp_alpha", name: "Alpha", members: alpha.map((agent) => agent.id) },
        { group_id: "grp_beta", name: "Beta", members: ["beta-1"] },
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
    expect(clusterLabels()).toEqual(["Alpha (7)", "Beta (1)"]);

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
    expect(drawn("topology-agent")).toBe(1);
    expect(clusterLabels()).toEqual([`${say("topo.noGroup")} (1)`]);
  });
});
