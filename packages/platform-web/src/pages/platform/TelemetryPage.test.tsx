/**
 * The telemetry screen, and the four different things it can mean by a blank cell.
 *
 * Five reads land on this page and each of them can be *still reading*,
 * *refused*, *unanswered*, or *answered with nothing*. Three of them are the
 * same word on the page — a `0`, a `—`, an empty gauge — and this console's
 * recurring defect is letting them stay that way. The page's own comment
 * records the measurement: with § 11 refusing the gated panels the screen came
 * out at 999 bytes, and with an idle mesh answering everything it came out at
 * 999 bytes too. **The screen made no statement about the backend at all.**
 *
 * Two of the five endpoints (`/api/v1/agents`, `/api/v1/health`) are ungated
 * and therefore always answer, so a refusal never reaches the page-wide error
 * branch — it arrives as a `refused` entry beside a normal-looking layout. That
 * is why every case below is driven from a per-URL map rather than one global
 * failure: the mixed reads are the only interesting ones, and a page with a
 * single error flag draws them wrong.
 *
 * `failureKind` / `refusedCapability` are what separate *refused* from
 * *unreachable*, so the refusal fixtures carry the capability in § 11.3's field
 * with a sentence that never repeats it, and one fixture is a `500` whose body
 * says "forbidden". A reader matching prose instead of reading the status fails
 * both, which is the point of asserting them.
 *
 * Words compared against are `DICTIONARY.en`'s: the tree is held at zero Korean
 * characters, so the page renders inside `I18nProvider` (English by default)
 * and the expectations come out of the dictionary rather than out of the Korean
 * fallbacks compiled into the component.
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
const { MemoryRouter } = await import("react-router-dom");
const { I18nProvider, DICTIONARY } = await import("@/contexts/I18nContext.tsx");
const { CAPABILITY } = await import("@/types/auth.ts");
const { TelemetryPage, formatElapsed } = await import("./TelemetryPage.tsx");

const en = (key: string) => DICTIONARY.en[key]!;

/** The five reads behind this screen, in the order `fetchTelemetry` lists them. */
const USAGE = "/api/v1/admin/ai-usage";
const AGENTS = "/api/v1/agents";
const MAILBOX = "/api/v1/admin/mailbox";
const HEALTH = "/api/v1/health";
const BEHAVIOUR = "/api/v1/admin/telemetry/behaviour";
/** Not this page's — `<Breadcrumbs>` mounts the bell, which reads its own queue. */
const KEY_QUEUE = "/api/v1/admin/keys/pending";

// Taken from the contract rather than typed as strings: a capability name this
// mesh does not define is as wrong in a fixture as in a screen, because it makes
// the test agree with a server that does not exist.
const USAGE_READ = CAPABILITY.USAGE_READ;
const DEPTH = CAPABILITY.MAILBOX_READ_DEPTH;
const STATS = CAPABILITY.TENANT_READ_STATS;

/** The panel labels `fetchTelemetry` names in a refusal, as the page prints them. */
const PANEL_MAILBOX = "queue depth";
const PANEL_BEHAVIOUR = "behaviour metrics";
const PANEL_AGENTS = "agents";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Answer = () => Response | Promise<Response>;
const answers = (status: number, body: unknown): Answer => () => json(status, body);
/** No answer at all — offline, DNS, connection refused. Not a status. */
const noAnswer: Answer = () => { throw new TypeError("Failed to fetch"); };
/** In flight, and still in flight when the assertion runs. */
const stillReading: Answer = () => new Promise<Response>(() => {});
/**
 * The server answered and said no.
 *
 * The sentence deliberately contains none of `forbidden`, `permission` or
 * `capability`: a reader that matched the prose would call this unreachable,
 * and the module's comment records that exact reader being removed.
 */
const refuses = (capability: string | null): Answer =>
  answers(403, capability === null ? { error: "insufficient scope" } : { error: "insufficient scope", capability });

const realFetch = globalThis.fetch;
// bun:test has no global stubber, so the original goes back by hand; a
// forgotten restore poisons every file that runs after this one.
const stub = (fn: unknown) => { globalThis.fetch = fn as typeof globalThis.fetch; };

const calls: Array<{ url: string; method: string }> = [];

let usageRoute: Answer;
let agentsRoute: Answer;
let mailboxRoute: Answer;
let healthRoute: Answer;
let behaviourRoute: Answer;
let keyQueueRoute: Answer;

/**
 * Rows from this server's own chat registry.
 *
 * Two of them are live sockets (`status: "active"`, and the web channel); the
 * third is neither. Three rows against a `agent_count` of five is what makes
 * the two counts in the log line tell each other apart.
 */
const AGENT_ROWS = [
  { identity: "a-1", status: "active" },
  { identity: "a-2", status: "idle" },
  { identity: "a-3", status: "offline", channel: "web" },
];
const WEB_CHANNEL_IDENTITIES = 1;
const HEALTH_OK = { status: "ok", agent_count: 5, uptime: 900, version: "0.2.0" };

const COUNTING_SINCE = "2026-08-19T10:00:00.000Z";
/** Every one of the six read, four of them zero — what a healthy hub looks like. */
const BEHAVIOUR_MEASURED = {
  counting_since: COUNTING_SINCE,
  pending_keys: { value: 0 },
  oldest_pending_ms: { value: 0 },
  signature_refusals: { value: 0 },
  rate_limited: { value: 0 },
  egress_refusals: { value: 0 },
  accepted: { value: 7 },
};

beforeEach(() => {
  calls.length = 0;
  // happy-dom's storage belongs to the whole run, and another file in this
  // package sets the saved language to Korean. Left there it would fail every
  // dictionary comparison below for a reason that has nothing to do with this
  // screen.
  localStorage.removeItem("agent_mesh_lang");
  usageRoute = answers(200, { accounts: [], schema_version: 1 });
  agentsRoute = answers(200, { ok: true, agents: AGENT_ROWS });
  mailboxRoute = answers(200, { ok: true, mailboxes: [] });
  healthRoute = answers(200, HEALTH_OK);
  behaviourRoute = answers(200, BEHAVIOUR_MEASURED);
  keyQueueRoute = answers(200, { ok: true, keys: [] });
  stub(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: (init?.method ?? "GET").toUpperCase() });
    // One route fails while the others answer — that separation is the whole
    // difference between a refused panel and a backend that is down.
    if (url.endsWith(KEY_QUEUE)) return await keyQueueRoute();
    if (url.endsWith(BEHAVIOUR)) return await behaviourRoute();
    if (url.endsWith(USAGE)) return await usageRoute();
    if (url.endsWith(MAILBOX)) return await mailboxRoute();
    if (url.endsWith(AGENTS)) return await agentsRoute();
    if (url.endsWith(HEALTH)) return await healthRoute();
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
  // Five reads resolve over several microtasks each (fetch, then `.json()`,
  // then `Promise.all`, then the state writes), so a bare
  // `await act(async () => {})` has not always drained them.
  await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
};

const view = () =>
  render(
    <I18nProvider>
      {/* The real router rather than a mocked `useLocation`: the page mounts
          `<Breadcrumbs />`, and a module-level stub of react-router-dom would be
          installed for the whole process and reach every other file. */}
      <MemoryRouter initialEntries={["/platform/telemetry"]}>
        <TelemetryPage />
      </MemoryRouter>
    </I18nProvider>,
  );

const mount = async () => { view(); await settle(); };

/** Everything on screen. The bell contributes one glyph and no words. */
const pageText = () => document.body.textContent ?? "";

const refusalBanner = () => screen.queryByTestId("telemetry-refused");

/**
 * One behavioural counter, found by its label rather than by position.
 *
 * `pageText()` holds every number on the screen, so a body-wide `toContain("0")`
 * passes wherever the zero landed — including the card of a metric that was
 * never read. The label sits in its own `<div>`; the card is that div's parent.
 * The deepest match is taken because a card whose value renders as nothing has
 * the same `textContent` as its own label, and document order would hand back
 * the card instead.
 */
const metricCard = (label: string): HTMLElement => {
  const matches = [...document.querySelectorAll("div")].filter((d) => d.textContent === label);
  const cell = matches[matches.length - 1];
  const card = cell?.parentElement;
  if (!card) throw new Error(`no metric card is labelled ${label}`);
  return card;
};
const metricText = (label: string) => metricCard(label).textContent ?? "";
/** The server's own word for why a counter could not be read, or `null`. */
const unmeasuredReason = (label: string) =>
  metricCard(label).querySelector("[data-testid='metric-unmeasured']")?.getAttribute("title") ?? null;

/**
 * The web-channel registry card's value.
 *
 * Read out of that one cell rather than out of the card: the caption underneath
 * says "sockets healthy" no matter what the number is, so a card-wide match
 * cannot tell a measured zero from a drawn one.
 */
const socketsValue = (): string | null => {
  const card = document.querySelector(`[data-kpi="${en("tel.sockets")}"]`);
  return card?.children[1]?.children[0]?.textContent ?? null;
};

const refreshButton = () => screen.getByText(en("telem.refreshBtn"));
const refresh = async () => {
  await act(async () => { fireEvent.click(refreshButton()); });
  await settle();
};

const readsOf = (path: string) => calls.filter((c) => c.method === "GET" && c.url.endsWith(path)).length;

describe("the four things a blank telemetry screen can mean", () => {
  it("says it is still collecting, and makes no claim about the mesh yet", async () => {
    usageRoute = stillReading;
    agentsRoute = stillReading;
    mailboxRoute = stillReading;
    healthRoute = stillReading;
    behaviourRoute = stillReading;
    view();
    // No `settle()`: this is the frame an operator sees while the five reads are
    // in flight. Every sentence below is a statement about an answer that has
    // not arrived, and drawing any of them here is the defect in its earliest
    // form — a screen that decided what the backend said before it said it.
    expect(pageText()).toContain(en("tel.loading"));
    expect(pageText()).not.toContain(en("tel.error"));
    expect(pageText()).not.toContain(en("common.refusedRead"));
    expect(pageText()).not.toContain(en("tel.partial"));
    expect(pageText()).not.toContain(en("common.unmeasured"));
    expect(pageText()).not.toContain(en("telem.logTitle"));
    expect(refusalBanner()).toBe(null);
    expect(screen.queryByTestId("behaviour-metrics")).toBe(null);
    expect(screen.queryByTestId("behaviour-unreachable")).toBe(null);
    // A gauge reading zero is the single most dangerous thing this page can
    // draw before an answer: four of the six counters read zero when all is
    // well, so a placeholder zero is the number the operator is hoping for.
    expect(socketsValue()).toBe(null);
  });

  it("draws no dashboard at all when nothing answered", async () => {
    usageRoute = noAnswer;
    agentsRoute = noAnswer;
    mailboxRoute = noAnswer;
    healthRoute = noAnswer;
    behaviourRoute = noAnswer;
    await mount();
    expect(pageText()).toContain(en("tel.error"));
    // The recorded shape of this defect elsewhere in the console: the layout
    // renders anyway with `—` and `0` in the cells, and a zeroed gauge under a
    // "sockets healthy" caption is a measurement of a machine nobody reached.
    expect(socketsValue()).toBe(null);
    expect(screen.queryByTestId("behaviour-metrics")).toBe(null);
    expect(pageText()).not.toContain(en("common.unmeasured"));
    // Nothing answered, so nothing refused either — and "still collecting" is
    // over.
    expect(refusalBanner()).toBe(null);
    expect(pageText()).not.toContain(en("tel.loading"));
  });

  it("says which panels were withheld, where an idle mesh says nothing", async () => {
    // **The 999-bytes measurement, run twice.** Both mounts below draw a mesh
    // with zero live sockets and zero agents; in one of them that zero is the
    // truth and in the other it is a panel the session may not read. If the
    // page cannot tell them apart, an operator staring at a refused console
    // reads it as a quiet one.
    agentsRoute = refuses(null);
    healthRoute = answers(200, { status: "ok", agent_count: 0 });
    await mount();
    const withheld = pageText();
    const banner = refusalBanner();
    expect(banner).not.toBe(null);
    expect(banner!.textContent).not.toContain(PANEL_AGENTS);
    expect(banner!.textContent).toContain(en("tel.partial.note"));
    expect(socketsValue()).toBe(en("common.unmeasured"));

    cleanup();
    calls.length = 0;
    agentsRoute = answers(200, { ok: true, agents: [] });
    await mount();
    const idle = pageText();
    expect(refusalBanner()).toBe(null);
    expect(idle).not.toContain(en("tel.partial"));
    // Same number, and it means the opposite thing. The server answered this
    // one, so the gauge is a reading rather than a hole.
    expect(socketsValue()).toBe("0");

    // The measurement itself: two backends in different states must not produce
    // the same page.
    expect(withheld).not.toBe(idle);
  });

  it("says the mesh is empty only about panels that answered", async () => {
    agentsRoute = answers(200, { ok: true, agents: [] });
    healthRoute = answers(200, { status: "ok", agent_count: 0 });
    behaviourRoute = answers(200, {
      ...BEHAVIOUR_MEASURED,
      accepted: { value: 0 },
    });
    await mount();
    // Everything answered and everything is zero. This is the only state in
    // which the page may draw a bare dashboard with no caveat on it.
    expect(refusalBanner()).toBe(null);
    expect(screen.queryByTestId("behaviour-unreachable")).toBe(null);
    expect(screen.queryByTestId("behaviour-metrics")).not.toBe(null);
    expect(pageText()).not.toContain(en("tel.error"));
    expect(pageText()).not.toContain(en("common.unmeasured"));
    expect(metricText(en("tel.m.accepted"))).toBe(`${en("tel.m.accepted")}0`);
  });
});

describe("refused is read off the status, never out of the sentence", () => {
  it("calls a 403 a refusal even when its message never says so", async () => {
    behaviourRoute = refuses(USAGE_READ);
    await mount();
    const banner = refusalBanner();
    expect(banner).not.toBe(null);
    // The whole banner, so a panel named without its capability — or a
    // capability named without the note that explains what the blank cells
    // below mean — fails here.
    expect(banner!.textContent).toBe(`${en("tel.partial")} (1). ${en("tel.partial.note")}`);
    expect(banner!.textContent).not.toContain(USAGE_READ);
    expect(banner!.textContent).not.toContain(PANEL_BEHAVIOUR);
    // A refusal of one panel is not the backend being down: the other four
    // answered and the page still has a dashboard to draw.
    expect(pageText()).not.toContain(en("tel.error"));
    expect(socketsValue()).toBe(String(WEB_CHANNEL_IDENTITIES));
  });

  it("does not call a broken proxy a refusal because its body said forbidden", async () => {
    // The exact reader `fetchTelemetry`'s comment records removing: it matched
    // `/forbidden|capability|permission/i` against the message, so a `500`
    // phrased this way was drawn as a permission the operator lacks — sending
    // them to ask for a grant that would not have helped.
    behaviourRoute = answers(500, { error: "forbidden by upstream proxy" });
    await mount();
    expect(refusalBanner()).toBe(null);
    expect(pageText()).not.toContain(en("tel.partial"));
    expect(pageText()).not.toContain(USAGE_READ);
    // It still has to say the panel is missing — just not why it is not.
    expect(screen.queryByTestId("behaviour-unreachable")).not.toBe(null);
  });

  it("does not call an unanswered route a refusal", async () => {
    behaviourRoute = noAnswer;
    await mount();
    expect(refusalBanner()).toBe(null);
    expect(screen.queryByTestId("behaviour-unreachable")).not.toBe(null);
    expect(screen.queryByTestId("behaviour-metrics")).toBe(null);
  });

  it("repeats the capability the server named instead of the one built in", async () => {
    // § 11.3's refusal carries `capability` as a field precisely so a client
    // does not keep its own copy. The built-in requirement for this route is
    // `mailbox.read.depth`; a server that has moved the route behind something
    // else says so, and a screen printing its own guess sends the operator to
    // ask for the wrong grant.
    mailboxRoute = refuses(STATS);
    behaviourRoute = refuses(USAGE_READ);
    await mount();
    const banner = refusalBanner();
    expect(banner).not.toBe(null);
    expect(banner!.textContent).toContain("(2)");
    expect(banner!.textContent).not.toContain(STATS);
    expect(banner!.textContent).not.toContain(DEPTH);
    // Both refusals are named, not just whichever one came back first — a
    // banner that stops at one leaves the operator hunting the second blank
    // panel on their own.
    expect(banner!.textContent).not.toContain(USAGE_READ);
    expect(banner!.textContent).not.toContain(PANEL_BEHAVIOUR);
  });

  it("falls back to the route's own requirement when the server named nothing", async () => {
    mailboxRoute = refuses(null);
    await mount();
    expect(refusalBanner()!.textContent).not.toContain(DEPTH);
    expect(refusalBanner()!.textContent).not.toContain(PANEL_MAILBOX);
  });
});

describe("a counter that was not read is not a counter reading zero", () => {
  const MIXED = {
    counting_since: COUNTING_SINCE,
    pending_keys: { value: 0 },
    oldest_pending_ms: { value: null, unavailable: "no key has been waiting since the hub started" },
    signature_refusals: { value: 4 },
    rate_limited: { value: 0 },
    egress_refusals: { value: null, unavailable: "egress counters are off on this hub" },
    accepted: { value: 0 },
  };

  it("draws an unread counter as unmeasured and a measured zero as zero", async () => {
    behaviourRoute = answers(200, MIXED);
    await mount();
    // Four of the six read zero when all is well, which is what makes an unread
    // source dangerous here: a zero drawn because nothing answered is the number
    // an operator is hoping for and will not question.
    expect(metricText(en("tel.m.pending"))).toBe(`${en("tel.m.pending")}0`);
    expect(metricText(en("tel.m.sig"))).toBe(`${en("tel.m.sig")}4`);
    expect(metricText(en("tel.m.rate"))).toBe(`${en("tel.m.rate")}0`);
    expect(metricText(en("tel.m.accepted"))).toBe(`${en("tel.m.accepted")}0`);

    expect(metricText(en("tel.m.oldest"))).toBe(`${en("tel.m.oldest")}${en("common.unmeasured")}`);
    // Not "0", and not a unit either: `0 ms` under "Oldest wait" is a statement
    // that nothing is queued, made about a counter nobody read.
    expect(metricText(en("tel.m.oldest"))).not.toContain("0");
    expect(metricText(en("tel.m.oldest"))).not.toContain("ms");
    expect(metricText(en("tel.m.egress"))).toBe(`${en("tel.m.egress")}${en("common.unmeasured")}`);
  });

  it("turns a long wait into human time instead of raw milliseconds", async () => {
    const rawWait = 181_835_000;
    behaviourRoute = answers(200, {
      ...BEHAVIOUR_MEASURED,
      oldest_pending_ms: { value: rawWait },
    });
    await mount();

    const shown = metricText(en("tel.m.oldest"));
    expect(shown).toContain(formatElapsed(rawWait, "en"));
    expect(shown).not.toContain(String(rawWait));
    expect(shown).not.toContain("ms");
    expect(formatElapsed(rawWait, "ko")).toBe("2일 2시간");
  });

  it("carries each unread counter's own reason rather than one shared sentence", async () => {
    behaviourRoute = answers(200, MIXED);
    await mount();
    // Two metrics are unread for two different reasons. A single constant in
    // the slot passes any assertion that only checks a reason is present, and
    // it is the difference between "nothing has happened yet" and "this hub
    // does not count that at all".
    expect(unmeasuredReason(en("tel.m.oldest"))).toBe(MIXED.oldest_pending_ms.unavailable);
    expect(unmeasuredReason(en("tel.m.egress"))).toBe(MIXED.egress_refusals.unavailable);
    // A counter that was read has nothing to explain.
    expect(unmeasuredReason(en("tel.m.pending"))).toBe(null);
  });

  it("says the counters cannot be read when the window they cover is unknown", async () => {
    behaviourRoute = answers(200, { ...BEHAVIOUR_MEASURED, counting_since: null });
    await mount();
    // These are per-process counters that reset with the hub. Four refusals is
    // a different fact over an hour than over a month, and without the window
    // the numbers below are not a rate of anything.
    expect(screen.getByTestId("counting-since").textContent).toBe(en("tel.since.unknown"));
    expect(pageText()).not.toContain(en("tel.since"));
    // The counters themselves were answered, so they stay on screen.
    expect(screen.queryByTestId("behaviour-metrics")).not.toBe(null);
  });

  it("carries the window the counters were taken over, and that it resets", async () => {
    await mount();
    const since = screen.getByTestId("counting-since").textContent ?? "";
    expect(since).toContain(en("tel.since"));
    // The server's own timestamp rather than a fixed sentence: a caption that
    // says "since the hub started" without saying when is not a window.
    expect(since).toContain(new Date(COUNTING_SINCE).toLocaleString());
    expect(since).toContain(en("tel.since.note"));
    expect(since).not.toContain(en("tel.since.unknown"));
  });

  it("replaces the six counters with a notice rather than removing them", async () => {
    behaviourRoute = refuses(USAGE_READ);
    await mount();
    // Measured with only this route refusing and the rest healthy: eighteen
    // fragments of the page disappeared and nothing replaced them, on the one
    // screen whose entire job is telling an operator what is happening.
    const notice = screen.queryByTestId("behaviour-unreachable");
    expect(notice).not.toBe(null);
    expect(notice!.textContent).toContain(en("tel.behaviour"));
    expect(notice!.textContent).toContain(en("common.errorLoad"));
    expect(screen.queryByTestId("behaviour-metrics")).toBe(null);
    // And the counters are gone rather than drawn at zero — a labelled `0` here
    // is exactly the "healthy hub" reading a refusal must not produce.
    expect(screen.queryByText(en("tel.m.accepted"))).toBe(null);
    expect(screen.queryByText(en("tel.m.sig"))).toBe(null);
    expect(screen.queryByTestId("counting-since")).toBe(null);
    // The rest of the page answered and is still drawn.
    expect(socketsValue()).toBe(String(WEB_CHANNEL_IDENTITIES));
  });
});

describe("the registry card says exactly what the agent rows report", () => {
  it("counts only identities whose channel is web", async () => {
    await mount();
    expect(socketsValue()).toBe(String(WEB_CHANNEL_IDENTITIES));
    expect(socketsValue()).not.toBe(String(AGENT_ROWS.length));
    expect(pageText()).not.toContain("active_sockets");
  });

  it("says the registry count is unmeasured when the agent list did not answer", async () => {
    agentsRoute = noAnswer;
    await mount();
    expect(socketsValue()).toBe(en("common.unmeasured"));
  });
});

describe("refreshing asks again, and drops what the last answer said", () => {
  it("clears the failure once the backend comes back", async () => {
    usageRoute = noAnswer;
    agentsRoute = noAnswer;
    mailboxRoute = noAnswer;
    healthRoute = noAnswer;
    behaviourRoute = noAnswer;
    await mount();
    expect(pageText()).toContain(en("tel.error"));

    usageRoute = answers(200, { accounts: [] });
    agentsRoute = answers(200, { ok: true, agents: AGENT_ROWS });
    mailboxRoute = answers(200, { ok: true, mailboxes: [] });
    healthRoute = answers(200, HEALTH_OK);
    behaviourRoute = answers(200, BEHAVIOUR_MEASURED);
    const before = readsOf(BEHAVIOUR);
    await refresh();
    // The button has to ask again rather than only clear the flag: a screen
    // that redraws the last answer under a fresh timestamp is worse than one
    // that never refreshed.
    expect(readsOf(BEHAVIOUR)).toBe(before + 1);
    // An error banner that survives its own cause is one an operator learns to
    // ignore, which costs the banner that matters.
    expect(pageText()).not.toContain(en("tel.error"));
    expect(screen.queryByTestId("behaviour-metrics")).not.toBe(null);
    expect(socketsValue()).toBe(String(WEB_CHANNEL_IDENTITIES));
  });

  it("does not leave the last good dashboard up when the refresh failed", async () => {
    await mount();
    expect(socketsValue()).toBe(String(WEB_CHANNEL_IDENTITIES));

    usageRoute = noAnswer;
    agentsRoute = noAnswer;
    mailboxRoute = noAnswer;
    healthRoute = noAnswer;
    behaviourRoute = noAnswer;
    await refresh();
    // Stale numbers left on screen after a failed read are the most convincing
    // wrong answer this page can give: they were true once, they carry no mark
    // saying when, and the operator is watching them precisely because
    // something is wrong.
    expect(pageText()).toContain(en("tel.error"));
    expect(socketsValue()).toBe(null);
    expect(screen.queryByTestId("behaviour-metrics")).toBe(null);
  });

  it("takes the refusal banner down when the grant is no longer missing", async () => {
    behaviourRoute = refuses(USAGE_READ);
    await mount();
    expect(refusalBanner()).not.toBe(null);

    behaviourRoute = answers(200, BEHAVIOUR_MEASURED);
    await refresh();
    // Entered from a state that contradicts it: without the refused mount above
    // this assertion is a photograph of the initial empty list and cannot fail.
    expect(refusalBanner()).toBe(null);
    expect(pageText()).not.toContain(USAGE_READ);
    expect(screen.queryByTestId("behaviour-metrics")).not.toBe(null);
  });
});
