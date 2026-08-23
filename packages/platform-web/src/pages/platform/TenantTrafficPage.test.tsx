/**
 * The tenant traffic screen, and the four different things an empty table means.
 *
 * One read stands behind this whole page — `GET /api/v1/admin/tenants`, gated on
 * `tenant.read.stats` — and it can come back four ways: *still in flight*,
 * *refused*, *never answered*, or *answered, and nothing is there*. Three of
 * those four draw a table with no rows in it, and this console's recurring
 * defect is letting them draw the same sentence: "no tenant has sent anything
 * yet", printed about a backend that never replied. `SPEC` § 11.3 puts the
 * refusal's `capability` in a field precisely so a screen does not have to
 * guess, and `failureKind` / `refusedCapability` are what turn that field into
 * the two sentences below. Every case here pins which of the four is drawn
 * *and* which of the other three is not, because the wrong one is not visibly
 * wrong — it is a fluent sentence about a server nobody reached.
 *
 * The second half is the distinction the page's own data has: **zero is not
 * absent**. A tenant that exists and routed nothing is a measurement; a tenant
 * the server never listed is not. They differ by one row, and the counters that
 * separate them are all `0` — so a render that falls back to `-` on a falsy
 * count, or drops the row, or dates an undated row, turns a measured quiet
 * tenant into one that reads as unknown or as missing. Each counter is read out
 * of its own cell, located through its own column header: the page prints six
 * numbers per row, and a body-wide `toContain("0")` passes with any two of them
 * exchanged.
 *
 * `<Breadcrumbs>` mounts `<NotificationBell>`, which reads a queue of its own.
 * That is the reason for the per-URL map rather than one global failure: a
 * refusal on the bell's route and a backend that is down look identical to a
 * page with a single error flag, and telling them apart is the entire subject
 * of this file.
 *
 * Words compared against come out of `DICTIONARY.en` — the tree is held at zero
 * Korean characters, so the page renders inside `I18nProvider` (English by
 * default) rather than falling through to the Korean literals compiled into the
 * component as `t()` fallbacks.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { registerDom } from "../../register-dom";

// Registered once for the process and never unregistered: bun runs every test
// file's top level before it runs any test, so a register/unregister pair would
// swap the document out from under whichever file is still using it.
registerDom();

// `await import`, not a statement: a static import is hoisted above the
// registration above and would load React's DOM entry into a process with no
// document.
const { render, cleanup, act } = await import("@testing-library/react");
const { MemoryRouter } = await import("react-router-dom");
const { I18nProvider, DICTIONARY } = await import("@/contexts/I18nContext.tsx");
const { CAPABILITY } = await import("@/types/auth.ts");
const { TenantTrafficPage } = await import("./TenantTrafficPage.tsx");

const en = (key: string) => DICTIONARY.en[key]!;

/** This screen's one read. */
const TENANTS = "/api/v1/admin/tenants";
/** Not this screen's — `<Breadcrumbs>` mounts the bell, which reads its own queue. */
const KEY_QUEUE = "/api/v1/admin/keys/pending";

// Taken from the contract rather than typed as a string: a capability name this
// mesh does not define is as wrong in a fixture as it is in a screen, because it
// makes the test agree with a server that does not exist.
const STATS = CAPABILITY.TENANT_READ_STATS;
/**
 * A real capability that is *not* this route's.
 *
 * The refusal that names it is how a screen repeating the server is told from a
 * screen printing a name it was born holding: a hardcoded `tenant.read.stats`
 * is right in every fixture except this one.
 */
const OTHER = CAPABILITY.USAGE_READ;

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
 * The sentence carries none of `forbidden`, `permission` or `capability`: a
 * screen that matched prose instead of reading `status` would call this
 * unreachable, and a screen that read the status would not care what it says.
 */
const refuses = (capability: string | null): Answer =>
  answers(403, capability === null ? { error: "insufficient scope" } : { error: "insufficient scope", capability });

const realFetch = globalThis.fetch;
// bun:test has no global stubber, so the original goes back by hand; a forgotten
// restore poisons every file that runs after this one.
const stub = (fn: unknown) => { globalThis.fetch = fn as typeof globalThis.fetch; };

const calls: Array<{ url: string; method: string }> = [];

let tenantsRoute: Answer;
let keyQueueRoute: Answer;

/**
 * The two rows the rest of the file is about.
 *
 * `QUIET` is the whole point of the screen's harder half: it exists, the server
 * listed it, and every number it has is zero. `BUSY` gives each column a value
 * no other column has, so a cell read can tell "senders" from "recipients" —
 * with `3` and `3` the two columns are indistinguishable exchanged.
 */
const BUSY = {
  tenant: "globex-ops",
  received: 12,
  senders: 3,
  recipients: 7,
  via_mailbox: 5,
  last_at: "2026-08-19T10:00:00.000Z",
};
const QUIET = {
  tenant: "acme-eng",
  received: 0,
  senders: 0,
  recipients: 0,
  via_mailbox: 0,
  last_at: null,
};

/** What the route answers when it is healthy and the mesh has moved messages. */
const measured = (tenants: unknown[]) => answers(200, { ok: true, hours: 24, tenants });

beforeEach(() => {
  calls.length = 0;
  // happy-dom's storage belongs to the whole run and another file in this
  // package saves a language into it. Left there, Korean would fail every
  // dictionary comparison below for a reason that has nothing to do with this
  // screen.
  localStorage.removeItem("agent_mesh_lang");
  tenantsRoute = measured([BUSY]);
  keyQueueRoute = answers(200, { ok: true, keys: [] });
  stub(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: (init?.method ?? "GET").toUpperCase() });
    // One route fails while the other answers. That separation is the whole
    // difference between "this panel was refused" and "the backend is down",
    // and a page with one error flag for both draws them identically.
    if (url.split("?")[0]!.endsWith(KEY_QUEUE)) return await keyQueueRoute();
    if (url.split("?")[0]!.endsWith(TENANTS)) return await tenantsRoute();
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
  // The read resolves over several microtasks (fetch, then `.json()`, then the
  // `.then`, then `.finally`) and the state writes over more, so a bare
  // `await act(async () => {})` has not always drained them.
  await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
};

const view = () =>
  render(
    <I18nProvider>
      {/* The real router rather than a mocked `useLocation`: the page mounts
          `<Breadcrumbs />`, and a module-level stub of react-router-dom would be
          installed for the whole process and reach every other file. */}
      <MemoryRouter initialEntries={["/platform/tenant-traffic"]}>
        <TenantTrafficPage />
      </MemoryRouter>
    </I18nProvider>,
  );

const mount = async () => { view(); await settle(); };

/**
 * The table and the one thing drawn in place of its rows, and nothing else.
 *
 * Deliberately not `document.body`: the page header, the breadcrumbs and the
 * bell are all on screen, and a body-wide negative would be satisfied by text
 * that belongs to a different component's state.
 */
const tableBox = (): HTMLElement => {
  const table = document.querySelector("table");
  const box = table?.parentElement;
  if (!box) throw new Error("the screen drew no data table at all");
  return box as HTMLElement;
};
const tableText = () => tableBox().textContent ?? "";

/**
 * The sentence shown instead of rows, or `""` when rows are shown.
 *
 * The table and the notice are siblings and only one of them is ever populated,
 * so the notice is the last child when it exists and the `<table>` is when it
 * does not. `""` therefore means "this table is showing data", which is itself
 * an assertion worth making: a screen that draws rows *and* "nothing is there"
 * is the same defect read from the other side.
 */
const note = (): string => {
  const last = tableBox().lastElementChild;
  if (!last || last.tagName === "TABLE") return "";
  return last.textContent ?? "";
};

const headers = (): string[] =>
  [...tableBox().querySelectorAll("thead th")].map((th) => th.textContent ?? "");

const rows = (): HTMLElement[] => [...tableBox().querySelectorAll("tbody tr")] as HTMLElement[];

/** The tenant column of every row, in the order the table drew them. */
const tenantsShown = (): string[] =>
  rows().map((r) => r.querySelectorAll("td")[0]?.textContent ?? "");

const rowFor = (tenant: string): HTMLElement => {
  const row = rows().find((r) => (r.querySelectorAll("td")[0]?.textContent ?? "") === tenant);
  if (!row) throw new Error(`no row is headed by the tenant ${tenant}`);
  return row;
};

/**
 * One cell of one row, located through the header above it.
 *
 * By header rather than by a hardcoded index, so the read cannot silently
 * follow a column that moved: if the column is gone the lookup throws instead
 * of quietly returning the neighbour's number.
 */
const cell = (tenant: string, headerKey: string): string => {
  const at = headers().indexOf(en(headerKey));
  if (at < 0) throw new Error(`no column is headed ${en(headerKey)}`);
  return rowFor(tenant).querySelectorAll("td")[at]?.textContent ?? "";
};

const COL_RECEIVED = "traffic.col.routes";
const COL_SENDERS = "tt.senders";
const COL_RECIPIENTS = "tt.recipients";
const COL_VIA_MAILBOX = "tt.viaMailbox";
const COL_LAST_AT = "tt.lastAt";

const readsOf = (path: string) =>
  calls.filter((c) => c.method === "GET" && c.url.split("?")[0]!.endsWith(path)).length;

describe("the four things an empty tenant table can mean", () => {
  it("says it is still reading, and makes no claim about the mesh yet", async () => {
    tenantsRoute = stillReading;
    // The bell hangs too, so nothing on the page has an answer yet — and no
    // state update lands outside `act` while the assertions below run.
    keyQueueRoute = stillReading;
    view();
    // No `settle()`: this is the frame an operator sees while the read is in
    // flight. Each sentence denied below is a statement about an answer that
    // has not arrived, and drawing one here is the defect in its earliest form
    // — a screen that decided what the server said before it said it.
    expect(note()).toContain(en("table.loading"));
    expect(tableText()).not.toContain(en("tt.empty"));
    expect(tableText()).not.toContain(en("tenants.error"));
    expect(tableText()).not.toContain(en("common.refusedRead"));
    expect(rows()).toHaveLength(0);
  });

  it("says the account was refused, in the server's own word for what is missing", async () => {
    tenantsRoute = refuses(STATS);
    await mount();
    // The bell's queue answered 200 in this run, so the refusal on screen is
    // this route's and could not have come from the console being unreachable.
    expect(readsOf(KEY_QUEUE)).toBe(1);
    expect(note()).toContain(`${en("common.refusedRead")}.`);
    expect(note()).not.toContain(STATS);
    // Walked with a session holding no `tenant.read.stats`, a screen with one
    // error branch says the server did not answer — and sends the operator to
    // check a backend that is running, about a permission they do not hold.
    expect(tableText()).not.toContain(en("tenants.error"));
    expect(tableText()).not.toContain(en("tt.empty"));
    expect(tableText()).not.toContain(en("table.loading"));
    expect(rows()).toHaveLength(0);
  });

  it("does not expose a different machine key in the refusal sentence", async () => {
    // § 11.3 carries the name in a field so a client never has to guess, and a
    // guess is right until the route's requirement changes. A refusal naming a
    // different real capability is the only fixture that can tell a screen
    // reading the field from a screen printing a constant.
    tenantsRoute = refuses(OTHER);
    await mount();
    expect(note()).toContain(`${en("common.refusedRead")}.`);
    expect(note()).not.toContain(OTHER);
    expect(note()).not.toContain(STATS);
  });

  it("names nothing at all when the refusal named nothing", async () => {
    tenantsRoute = refuses(null);
    await mount();
    // A parenthesised capability here would be the screen's own invention: the
    // server refused without saying what was missing, and an operator reading a
    // name would go and grant the wrong thing.
    expect(note()).toContain(`${en("common.refusedRead")}.`);
    expect(note()).not.toContain("(");
    expect(note()).not.toContain(STATS);
  });

  it("says nobody answered, and does not call that a refusal", async () => {
    tenantsRoute = noAnswer;
    await mount();
    expect(note()).toContain(en("tenants.error"));
    // The two sentences send an operator to two different places. "Nothing is
    // there" is the worst of the three: it is the answer they were hoping for,
    // about a request that was never answered at all.
    expect(tableText()).not.toContain(en("common.refusedRead"));
    expect(tableText()).not.toContain(en("tt.empty"));
    expect(tableText()).not.toContain(en("table.loading"));
    expect(rows()).toHaveLength(0);
  });

  it("does not read a broken proxy as a refusal, whatever its body says", async () => {
    // A `5xx` is the server failing, not the server saying no — and this body
    // says "forbidden" in prose while its status says otherwise. This is the
    // line the 502-read-as-signed-out defect crossed elsewhere in this console.
    tenantsRoute = answers(500, { error: "forbidden" });
    await mount();
    expect(note()).toContain(en("tenants.error"));
    expect(tableText()).not.toContain(en("common.refusedRead"));
  });

  it("says the mesh is quiet only when the server said so", async () => {
    tenantsRoute = measured([]);
    await mount();
    expect(note()).toContain(en("tt.empty"));
    // This is the one state in which "nothing is there" is true. It has to look
    // different from the three above, or none of them mean anything.
    expect(tableText()).not.toContain(en("tenants.error"));
    expect(tableText()).not.toContain(en("common.refusedRead"));
    expect(tableText()).not.toContain(en("table.loading"));
    expect(rows()).toHaveLength(0);
  });
});

describe("a tenant that routed nothing is not a tenant that is not there", () => {
  it("keeps the silent tenant as a row instead of as an absence", async () => {
    tenantsRoute = measured([QUIET, BUSY]);
    await mount();
    // A filter on `received > 0` — or any falsy-count guard — deletes this row,
    // and the screen then reads as a mesh with one tenant in it. The server
    // listed two, and how much each moved is the column, not the membership.
    expect(rows()).toHaveLength(2);
    expect(tenantsShown()).toContain(QUIET.tenant);
    // Rows are on screen, so the sentence about there being none must not be.
    expect(note()).toBe("");
    expect(tableText()).not.toContain(en("tt.empty"));
  });

  it("prints a measured zero as a zero in every counter", async () => {
    tenantsRoute = measured([QUIET, BUSY]);
    await mount();
    // `{item.received || "-"}` is the shape this guards against, and it is the
    // easy thing to write: it turns four honest zeroes into four dashes, and a
    // dash is what this table says when the server told it nothing. The tenant
    // is not unmeasured — it is measured, and the measurement is none.
    expect(cell(QUIET.tenant, COL_RECEIVED)).toBe("0");
    expect(cell(QUIET.tenant, COL_SENDERS)).toBe("0");
    expect(cell(QUIET.tenant, COL_RECIPIENTS)).toBe("0");
    expect(cell(QUIET.tenant, COL_VIA_MAILBOX)).toBe("0");
  });

  it("does not date a row the server left undated", async () => {
    tenantsRoute = measured([QUIET, BUSY]);
    await mount();
    const dated = cell(BUSY.tenant, COL_LAST_AT);
    const undated = cell(QUIET.tenant, COL_LAST_AT);
    // The row that has a time shows the server's, character for character: a
    // reformat that loses the day, or a clock that renders "now", is a value an
    // operator would act on that no server sent.
    expect(dated).toBe(BUSY.last_at);
    // The row that has none shows something that cannot be mistaken for one.
    // The epoch, a zero and the neighbouring row's timestamp are all readings
    // this cell is not entitled to — the server said nothing has been routed.
    expect(undated).not.toBe(dated);
    expect(undated).not.toMatch(/\d/);
  });

  it("puts each counter under its own column", async () => {
    tenantsRoute = measured([BUSY]);
    await mount();
    // Every one of these numbers is in the table wherever the mapping put it,
    // so a body-wide `toContain` passes with senders and recipients exchanged —
    // and a row saying three agents received where seven did is made entirely
    // of numbers the server sent and is still untrue.
    expect(cell(BUSY.tenant, COL_RECEIVED)).toBe(String(BUSY.received));
    expect(cell(BUSY.tenant, COL_SENDERS)).toBe(String(BUSY.senders));
    expect(cell(BUSY.tenant, COL_RECIPIENTS)).toBe(String(BUSY.recipients));
    expect(cell(BUSY.tenant, COL_VIA_MAILBOX)).toBe(String(BUSY.via_mailbox));
  });

  it("keeps the order the server ranked them in", async () => {
    // The route orders by received descending, so this order is one the client
    // cannot have produced by sorting — which is the point. A client-side sort
    // shows the operator a ranking the server did not compute, and the two
    // disagree the moment the window or the tie-breaking does.
    tenantsRoute = measured([QUIET, BUSY]);
    await mount();
    expect(tenantsShown()).toEqual([QUIET.tenant, BUSY.tenant]);
  });
});

describe("which read this screen is answering for", () => {
  it("asks the tenant route once, and does not re-ask on its own re-render", async () => {
    await mount();
    // The response's `hours` lands in state, which re-renders the page. With
    // the effect's dependency list wrong that write re-runs the read, and the
    // screen sits in a fetch loop against a gated admin route.
    expect(readsOf(TENANTS)).toBe(1);
    expect(rows()).toHaveLength(1);
  });

  it("does not draw a neighbouring panel's refusal as its own", async () => {
    // The bell hangs off `<Breadcrumbs>` and reads a queue behind a different
    // capability, so a session can hold `tenant.read.stats` and not `key.approve`.
    // A page that flagged an error on any failed request would black out a table
    // the server had answered in full.
    keyQueueRoute = refuses(CAPABILITY.KEY_APPROVE);
    tenantsRoute = measured([QUIET, BUSY]);
    await mount();
    expect(readsOf(KEY_QUEUE)).toBe(1);
    expect(rows()).toHaveLength(2);
    expect(note()).toBe("");
    expect(tableText()).not.toContain(en("common.refusedRead"));
    expect(tableText()).not.toContain(en("tenants.error"));
  });
});
