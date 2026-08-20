/**
 * What the lease queue says about a backlog it could not read, and what it
 * refuses to say about one it could.
 *
 * The screen answers one route — `GET /api/v1/admin/mailbox` — and everything
 * an operator acts on is derived from that one read: two counters, a table, and
 * a sentence about why there is nothing in it. So the whole subject here is the
 * four different things that read can be, and the fact that they are four:
 *
 *   still waiting for an answer · the server refused · nothing answered · the
 *   server answered and said the mesh is quiet
 *
 * Three of them draw an empty table, which is why they keep collapsing into
 * one. This console has shipped that collapse repeatedly, and the module's own
 * comments record the local version of it: the screen once invented a row, a
 * message id, a lease state and a 300-second countdown for a route that answers
 * per *mailbox* and carries none of those, so eleven queued messages were drawn
 * as `Available 1`. What the server did not send is not drawn, and every
 * assertion below is paired with what the screen must **not** say in that state
 * — an empty-looking table is only trustworthy if the sentence under it is
 * about the answer that actually arrived.
 *
 * `failureKind`/`refusedCapability` on `api/client.ts` are how *refused* is told
 * from *unreachable*; the fixtures here drive those through real `Response`
 * objects rather than asserting on the helpers, because the defect was never in
 * the helpers — it was in screens that never asked.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Registered once for the process and never unregistered: bun runs every test
// file's top level before any test, so a register/unregister pair would swap
// `document` out from under whichever file is still using it.
if (!(globalThis as { document?: unknown }).document) GlobalRegistrator.register();

// `await import`, never a static one: a static import is hoisted above the
// registration above and would load React's DOM entry into a process that has
// no document.
const { render, screen, cleanup, act } = await import("@testing-library/react");
const { MemoryRouter } = await import("react-router-dom");
const { I18nProvider, DICTIONARY } = await import("@/contexts/I18nContext.tsx");
const { CAPABILITY } = await import("@/types/auth.ts");
const { LeaseQueuePage } = await import("./LeaseQueuePage.tsx");

const MAILBOX = "/api/v1/admin/mailbox";
/** The bell inside `<Breadcrumbs />` reads this on mount; it is not the subject. */
const KEYS_PENDING = "/api/v1/admin/keys/pending";

const en = (key: string): string => DICTIONARY.en[key]!;

// Read from the contract rather than typed as a string. A capability name this
// mesh does not define is as wrong in a fixture as on a screen — it makes the
// test agree with a server that cannot exist.
const DEPTH = CAPABILITY.MAILBOX_READ_DEPTH;
const META = CAPABILITY.AUDIT_READ_METADATA;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const realFetch = globalThis.fetch;
/** bun:test has no global stubber, so the original goes back by hand below. */
const stub = (fn: unknown) => { globalThis.fetch = fn as typeof globalThis.fetch; };

type Reply = (url: string) => Response | Promise<Response>;
const calls: string[] = [];
let reply: Reply = () => { throw new TypeError("Failed to fetch"); };

beforeEach(() => {
  calls.length = 0;
  // The provider restores a saved language and every word compared below is the
  // English dictionary's. happy-dom's storage belongs to the process, so another
  // file switching to Korean would otherwise decide what this file asserts.
  try { localStorage.removeItem("agent_mesh_lang"); } catch { /* no storage, no saved language */ }
  reply = () => { throw new TypeError("Failed to fetch"); };
  stub(async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return await reply(String(input));
  });
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  try { localStorage.removeItem("agent_mesh_lang"); } catch { /* nothing to take back */ }
});
afterAll(() => {
  // Both of these outlive the file the way `mock.module` would; a forgotten
  // restore poisons every file that runs after this one.
  globalThis.fetch = realFetch;
  try { localStorage.removeItem("agent_mesh_lang"); } catch { /* nothing to take back */ }
});

/**
 * The mailbox route answers `body`; the bell's queue answers empty and quietly.
 *
 * Answering per-URL rather than globally is the whole point: a refusal on this
 * screen's route has to be distinguishable from the backend being down, and it
 * only is if something else on the page is still being answered.
 */
const mailboxAnswers = (body: unknown, status = 200) => {
  reply = (url) => (url.includes(MAILBOX) ? json(status, body) : json(200, { ok: true, keys: [] }));
};

/** This screen's route gets no answer at all; the bell's is served normally. */
const mailboxUnreachable = () => {
  reply = (url) => {
    if (url.includes(MAILBOX)) throw new TypeError("Failed to fetch");
    return json(200, { ok: true, keys: [] });
  };
};

/** Asked and not yet answered — the window the screen is in while it mounts. */
const nothingAnswersYet = () => { reply = () => new Promise<Response>(() => {}); };

const settle = async () => {
  // The read resolves over several microtasks (fetch, `.json()`, the `.then`
  // and the `.finally`), so a bare `await act(async () => {})` has not always
  // drained them.
  await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
};

const view = () =>
  render(
    <I18nProvider>
      {/* A real router rather than a stubbed `useLocation`: the page mounts
          `<Breadcrumbs />`, and a `mock.module` of react-router-dom is global to
          the process and would reach every other file's top-level import. */}
      <MemoryRouter initialEntries={["/creator/lease-queue"]}>
        <LeaseQueuePage />
      </MemoryRouter>
    </I18nProvider>,
  );

/** Mounted and left mid-flight, with the mount read still outstanding. */
const mountPending = () => { view(); };
const mount = async () => { view(); await settle(); };

const bodyText = () => document.body.textContent ?? "";

/**
 * The one sentence the table draws in place of rows, or `""` when it has rows.
 *
 * `DataTable` renders that sentence as a sibling of `<table>` and only when the
 * row list is empty, so the empty string is itself a reading: no note is drawn
 * over a table that has data. Scoped to the table rather than matched against
 * the whole body, because the guide banner above it is prose about leases and a
 * body-wide `toContain` would find words there.
 */
const tableNote = (): string => {
  const table = document.querySelector("table");
  if (!table) throw new Error("the screen drew no table at all");
  const wrapper = table.parentElement!;
  const last = wrapper.lastElementChild!;
  return last === table ? "" : (last.textContent ?? "");
};

/** The card a label names — `<span>label</span>` inside the card's header row. */
const kpiCard = (label: string): HTMLElement => {
  const labelEl = [...document.querySelectorAll("span")].find((s) => s.textContent === label);
  const card = labelEl?.parentElement?.parentElement;
  if (!card) throw new Error(`no telemetry card is labelled ${label}`);
  return card as HTMLElement;
};
/** The number (or the refusal to give one) the card puts beside its label. */
const kpiValue = (label: string): string =>
  kpiCard(label).firstElementChild?.children[1]?.firstElementChild?.textContent ?? "";
/** The line under the bar, which is the card's own sentence about the read. */
const kpiStatus = (label: string): string =>
  kpiCard(label).lastElementChild?.firstElementChild?.textContent ?? "";

const LEASED_KPI = en("lease.kpi.leased");
const WAITING_KPI = en("lease.kpi.available");
const REFUSED_BASE = en("common.refusedRead");

/** One row's four cells, in the order an operator reads them. */
const rowFor = (identity: string): string[] => {
  const cell = screen.queryByTestId(`mailbox-${identity}`);
  const row = cell?.closest("tr");
  if (!row) throw new Error(`no row is drawn for the mailbox ${identity}`);
  return [...row.children].map((td) => td.textContent ?? "");
};

const rowCount = () => document.querySelectorAll("tbody tr").length;
const headers = () => [...document.querySelectorAll("thead th")].map((th) => th.textContent ?? "");

const TWO_MAILBOXES = {
  mailboxes: [
    { identity: "worker-a", pending: 7, leased: 4, oldest: "2026-08-19T23:07:41Z" },
    { identity: "worker-b", pending: 4, leased: 1, oldest: null },
  ],
};

describe("a read that has not come back yet", () => {
  it("says it is still asking, rather than that no mailbox is holding anything", async () => {
    nothingAnswersYet();
    // Deliberately not settled: this is the state the screen is in between the
    // effect firing and the answer landing, and it is the one most easily drawn
    // as an answered, quiet mesh.
    mountPending();
    expect(tableNote()).toContain(en("table.loading"));
    // The three sentences that would each be a claim about an answer nobody has
    // received. "Nothing is queued" is the dangerous one — an operator reads it
    // and stops looking.
    expect(tableNote()).not.toContain(en("lease.empty"));
    expect(tableNote()).not.toContain(en("lease.error"));
    expect(tableNote()).not.toContain(REFUSED_BASE);
  });
});

describe("the server refused, which is not the server being gone", () => {
  it("repeats the capability the refusal named instead of the one written into the copy", async () => {
    // § 11.3's refusal carries `capability` as a field so a client does not have
    // to remember what a route requires. The name used here is deliberately not
    // the one this screen's dictionary entry has hardcoded: with the expected
    // name in the fixture, a screen printing its own compiled-in guess would
    // pass and a screen reading the response would pass, and the two would be
    // indistinguishable.
    mailboxAnswers({ error: "not allowed", capability: META }, 403);
    await mount();
    expect(tableNote()).toContain(`${REFUSED_BASE} (${META}).`);
    expect(tableNote()).not.toContain(DEPTH);
  });

  it("names no capability at all when the refusal named none", async () => {
    mailboxAnswers({ error: "not allowed" }, 403);
    await mount();
    // A guess in these brackets sends the operator to ask for a grant they may
    // already hold, on a route that may no longer require it.
    expect(tableNote()).toContain(`${REFUSED_BASE}.`);
    expect(tableNote()).not.toContain(DEPTH);
    expect(tableNote()).not.toContain("(");
  });

  it("does not tell the operator the server said nothing", async () => {
    mailboxAnswers({ error: "not allowed", capability: DEPTH }, 403);
    await mount();
    // Measured elsewhere on this console with a member session: the server
    // answered `403` and the screen sent the reader to check the network.
    expect(tableNote()).not.toContain(en("lease.error"));
    expect(tableNote()).not.toContain(en("lease.empty"));
    expect(tableNote()).not.toContain(en("table.loading"));
    // The counter says the same thing as the table under it. A screen with two
    // answers to one question is one an operator resolves by picking whichever
    // they read first.
    expect(kpiStatus(LEASED_KPI)).toBe(en("common.refused"));
  });

  it("does not read a broken gateway as a refusal", async () => {
    // `502` is the server failing, not the server saying no — the line the
    // signed-out-by-a-proxy defect crossed elsewhere in this console. A check
    // written as "not 200" would call this a refusal and tell the operator to
    // go and ask for a capability.
    mailboxAnswers({ error: "Bad Gateway" }, 502);
    await mount();
    expect(tableNote()).not.toContain(REFUSED_BASE);
    expect(tableNote()).toContain(en("lease.error"));
    expect(kpiStatus(LEASED_KPI)).toBe(en("lease.down"));
  });
});

describe("nothing answered", () => {
  it("says the read failed rather than that the queue is empty", async () => {
    mailboxUnreachable();
    await mount();
    expect(tableNote()).toContain(en("lease.error"));
    // The defect this whole file exists for: an empty list drawn as a quiet
    // mesh. The bell's route is answered in this fixture, so the page is not
    // simply blank — only this screen's read failed.
    expect(tableNote()).not.toContain(en("lease.empty"));
    expect(tableNote()).not.toContain(REFUSED_BASE);
    expect(tableNote()).not.toContain(en("table.loading"));
    expect(rowCount()).toBe(0);
  });

  it("draws no number in the counters it could not measure", async () => {
    mailboxUnreachable();
    await mount();
    // A `0` here is a measurement, and the operator has no way to tell it from
    // a mesh with nothing queued. "Cannot measure" is the only honest value for
    // a sum over rows that never arrived.
    expect(kpiValue(LEASED_KPI)).toBe(en("common.unmeasurable"));
    expect(kpiValue(WAITING_KPI)).toBe(en("common.unmeasurable"));
    expect(kpiValue(LEASED_KPI)).not.toBe("0");
    expect(kpiValue(WAITING_KPI)).not.toBe("0");
  });
});

describe("the server answered and the mesh is quiet", () => {
  it("says so, and the zeroes it shows are the server's", async () => {
    mailboxAnswers({ mailboxes: [] });
    await mount();
    expect(tableNote()).toContain(en("lease.empty"));
    expect(tableNote()).not.toContain(en("lease.error"));
    expect(tableNote()).not.toContain(REFUSED_BASE);
    expect(tableNote()).not.toContain(en("table.loading"));
    // The mirror of the assertion above. This is the one state where a `0` is
    // true, and a screen that said "cannot measure" here would be hiding a real
    // answer behind the same word it uses for a failure.
    expect(kpiValue(LEASED_KPI)).toBe("0");
    expect(kpiValue(WAITING_KPI)).toBe("0");
    expect(kpiStatus(WAITING_KPI)).toBe(en("lease.ready"));
  });
});

describe("the counters are the server's sums, not a count of rows", () => {
  it("reads eleven messages in one mailbox as eleven", async () => {
    // The measured defect, from the module's own comment: one row per mailbox
    // counted as one waiting message, so a backlog of eleven was drawn as
    // `Available 1` — plausible enough that nobody re-read it.
    mailboxAnswers({ mailboxes: [{ identity: "worker-a", pending: 11, leased: 0, oldest: null }] });
    await mount();
    expect(kpiValue(WAITING_KPI)).toBe("11");
    expect(rowCount()).toBe(1);
    // The control for the fixture: the screen really did ask this route, once.
    expect(calls.filter((u) => u.includes(MAILBOX))).toEqual([MAILBOX]);
    expect(calls.some((u) => u.includes(KEYS_PENDING))).toBe(true);
  });

  it("sums across mailboxes and keeps waiting apart from leased", async () => {
    // Two sums that are each different from the row count and from each other,
    // so neither a row count nor a swapped pair can produce this pair.
    mailboxAnswers(TWO_MAILBOXES);
    await mount();
    expect(kpiValue(WAITING_KPI)).toBe("11");
    expect(kpiValue(LEASED_KPI)).toBe("5");
  });
});

describe("a row carries what the route sent and nothing else", () => {
  it("draws one row per mailbox with the three numbers beside its name", async () => {
    mailboxAnswers(TWO_MAILBOXES);
    await mount();
    expect(rowCount()).toBe(2);
    // Read as a whole row rather than as three body-wide `toContain`s: every
    // value here is a value the server sent, so a row with `pending` and
    // `leased` exchanged is made entirely of true numbers and still says
    // something false about which mailbox is backed up.
    expect(rowFor("worker-a")).toEqual(["\u{1F4E5} worker-a", "7", "4", "2026-08-19T23:07:41Z"]);
    // The identity cell holds the identity and nothing else. The screen used to
    // prefix it with `msg_mb_1` — an id for a message that does not exist, on a
    // screen whose subject is messages.
    expect(rowFor("worker-a")[0]).toBe("\u{1F4E5} worker-a");
  });

  it("does not invent an arrival time for a mailbox the route gave none for", async () => {
    mailboxAnswers(TWO_MAILBOXES);
    await mount();
    // `oldest: null` is the route saying it has nothing to report, and the one
    // thing that may not stand there is a timestamp: it is the column an
    // operator sorts by when deciding what is stuck.
    expect(rowFor("worker-b")[3]).toBe(en("common.unmeasured"));
    expect(rowFor("worker-b")).toEqual(["\u{1F4E5} worker-b", "4", "1", en("common.unmeasured")]);
  });

  it("carries only the four columns the route can fill", async () => {
    mailboxAnswers(TWO_MAILBOXES);
    await mount();
    // The table used to carry a message id, a `from → to` route, a lease-state
    // badge and a 300-second countdown, none of which this route answers. A
    // column header is a promise that the cells under it mean something.
    expect(headers()).toEqual([
      en("lease.col.identity"),
      en("lease.col.pending"),
      en("lease.col.leased"),
      en("lease.col.oldest"),
    ]);
  });

  it("offers no button that would take, acknowledge or return a lease", async () => {
    mailboxAnswers(TWO_MAILBOXES);
    await mount();
    const buttons = [...document.querySelectorAll("button")].map((b) => b.textContent ?? "");
    // Without this the absence below is vacuous — a page that rendered no
    // buttons at all, or failed to render, would satisfy it.
    expect(screen.queryByTestId("bell")).not.toBe(null);
    expect(buttons.length).toBeGreaterThan(0);
    // These three existed and called no route: each edited local state, so the
    // row changed and the mesh did not. Leasing happens over the agent
    // transport (SPEC § 9); an operator console cannot do it for a worker, and
    // a control that says otherwise is a lie the operator acts on. Checked on
    // buttons rather than on the body because the guide banner above explains
    // what an ACK is, in prose.
    expect(buttons.some((label) => label.includes("ACK"))).toBe(false);
    expect(buttons).not.toContain(en("lease.acquire"));
  });

  it("draws no countdown of its own beside a lease the hub is timing", async () => {
    mailboxAnswers(TWO_MAILBOXES);
    await mount();
    // The ticker decremented a TTL this screen had invented, once a second, on
    // rows standing for mailboxes rather than messages — a clock counting down
    // something the server never started. The rows hold four cells and none of
    // them is a number this browser made up.
    expect(rowFor("worker-a")).toHaveLength(4);
    expect(rowFor("worker-b")).toHaveLength(4);
    expect(rowFor("worker-a").join(" ")).not.toContain("300");
  });
});
