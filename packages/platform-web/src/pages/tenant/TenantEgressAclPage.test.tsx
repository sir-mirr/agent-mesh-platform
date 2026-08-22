/**
 * What the egress matrix says about the tenant's policy, and what it must never
 * say instead.
 *
 * Four readings, one panel: *still asking*, *the server refused*, *the server
 * never answered*, and *the server answered and there are no groups*. This
 * console has collapsed them three times, always in the same direction — a
 * sentence about the server's answer drawn over a backend that never answered.
 * `api/client.ts` exists so a screen does not have to guess (`failureKind`,
 * `refusedCapability`), so every state below pins the sentence that appears
 * **and the three that must not**: an error panel that also carries the empty
 * sentence is the defect, and only a negative can see it.
 *
 * The grid has a fifth reading of its own, and it is the one this page gets
 * wrong. `fetchGroups` deliberately answers `egress_allowed: null` when the
 * route carried no `egress` array at all — *the policy was not read* — and
 * keeps it apart from `[]`, which is *the policy was read and it allows
 * nothing*. This page folds the first into the second (`(g.egress_allowed &&
 * …) || false`), so an unread policy is drawn as a complete, confident DENY
 * grid. That is pinned here as TODAY's behaviour, not endorsed: the test that
 * pins it goes red the moment somebody fixes it, which is the point.
 *
 * Direction is the other thing worth a negative. A→B and B→A are different
 * rules — `maySend` matches `from_group` and `to_group` and nothing else — so
 * a mapping that transposed the answer would draw a grid in which every word
 * came from the server and every cell was a lie. The cells are read by
 * `acl-<source>-<target>`, and one test checks those ids agree with the names
 * printed down the side and across the top, so the ids cannot be a private
 * label that disagrees with what the operator sees.
 *
 * The providers are real. `mock.module` is global to the bun process and
 * outlives the file that installs it, so `fetch` is answered per-URL instead —
 * which is also the only way to tell a refusal of *this* screen's route from a
 * backend that is down, since the bell inside `<Breadcrumbs>` keeps answering
 * while the groups route fails.
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
const { MemoryRouter } = await import("react-router-dom");
const { I18nProvider, DICTIONARY } = await import("@/contexts/I18nContext.tsx");
const { CAPABILITY } = await import("@/types/auth.ts");
const { TenantEgressAclPage } = await import("./TenantEgressAclPage.tsx");

const GROUPS = "/api/v1/admin/groups";
/** The bell inside `<Breadcrumbs>`; it must keep answering while groups fails. */
const BELL = "/api/v1/admin/keys/pending";

// Taken from the contract rather than typed as a string: a capability name this
// mesh does not define is as wrong in a fixture as it is on a screen, because
// it makes the test agree with a server that does not exist.
const MANAGE = CAPABILITY.GROUP_MANAGE;

const DESC = DICTIONARY.en["egress.desc"]!;
const LOADING = DICTIONARY.en["egress.loading"]!;
const EMPTY = DICTIONARY.en["egress.noGroups"]!;
const UNREACHABLE = DICTIONARY.en["egress.error"]!;
const REFUSED = DICTIONARY.en["common.refusedRead"]!;
const ALLOW = DICTIONARY.en["acl.allow"]!;
const DENY = DICTIONARY.en["acl.deny"]!;
const UPDATED = DICTIONARY.en["egress.toast.updated"]!;
const WRITE_FAILED = DICTIONARY.en["egress.toast.failed"]!;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const realFetch = globalThis.fetch;
/** bun:test has no global stubber, so the original goes back by hand — a
 *  forgotten restore poisons every file that runs after this one. */
const stub = (fn: unknown) => { globalThis.fetch = fn as typeof globalThis.fetch; };

type Reply = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;
const calls: Array<{ url: string; init: RequestInit | undefined }> = [];

/** What `GET /api/v1/admin/groups` does. */
let readGroups: Reply = () => json(200, { groups: [] });
/** What a write under `/<group>/egress` does. */
let writeEgress: Reply = () => json(200, { ok: true });

const ALPHA = { group_id: "grp_alpha", name: "Alpha Team" };
const BETA = { group_id: "grp_beta", name: "Beta Team" };
const IDS = [ALPHA.group_id, BETA.group_id];

/** A body the route really sends: groups, plus the rules that were read. */
const policy = (egress: Array<{ from_group: string; to_group: string }>) =>
  json(200, { groups: [ALPHA, BETA], egress });

beforeEach(() => {
  calls.length = 0;
  readGroups = () => json(200, { groups: [] });
  writeEgress = () => json(200, { ok: true });
  // `I18nProvider` reads a saved language out of storage and happy-dom's
  // storage belongs to the process, so a leftover from another file would draw
  // this page in a second language and every dictionary lookup below would miss.
  localStorage.clear();
  stub(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith(BELL)) return json(200, { ok: true, keys: [] });
    if (url.endsWith(GROUPS)) return await readGroups(url, init);
    if (url.includes("/egress")) return await writeEgress(url, init);
    return json(200, { ok: true });
  });
});

afterEach(() => { cleanup(); localStorage.clear(); globalThis.fetch = realFetch; });
// What this file wrote into process-wide storage comes back out for everyone
// else in the run, not just for the next test in here.
afterAll(() => { localStorage.clear(); globalThis.fetch = realFetch; });

const settle = async () => {
  // The mount read resolves over several microtasks (fetch, then `.json()`,
  // then the mapping, then `.finally`), so a bare `await act(async () => {})`
  // is not always enough to have drained them.
  await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
};

const mount = async () => {
  // The real router, at the path the page is mounted at: `<Breadcrumbs>` reads
  // `useLocation`, and a stub of it leaks out of the file that installs it.
  render(
    <MemoryRouter initialEntries={["/tenant/egress-acl"]}>
      <I18nProvider>
        <TenantEgressAclPage />
      </I18nProvider>
    </MemoryRouter>,
  );
  await settle();
};

/**
 * The one node the page draws where its state goes — a sentence, or the matrix.
 *
 * Scoped to that node on purpose. The page's own subtitle and the bell both
 * render words, so a body-wide search would pass whatever the failed panel
 * actually said. The description paragraph is the panel's fixed left sibling.
 */
const panel = (): HTMLElement => {
  const desc = [...document.querySelectorAll("p")].find((el) => el.textContent === DESC);
  const node = desc?.nextElementSibling;
  if (!node) throw new Error("the page drew nothing where its one state panel goes");
  return node as HTMLElement;
};
const panelText = (): string => panel().textContent ?? "";

/** The matrix, or `null` — nothing else on this page draws a table. */
const matrix = (): HTMLElement | null => document.querySelector("table");

const cell = (sourceId: string, targetId: string): HTMLElement => {
  const el = screen.queryByTestId(`acl-${sourceId}-${targetId}`);
  if (!el) throw new Error(`the matrix has no cell for ${sourceId} to ${targetId}`);
  return el;
};
/** What the operator reads in one cell: `ALLOW` or `DENY`. */
const verdict = (sourceId: string, targetId: string): string => cell(sourceId, targetId).textContent ?? "";
const grid = (): string[][] => IDS.map((source) => IDS.map((target) => verdict(source, target)));
const toggle = (sourceId: string, targetId: string) => {
  const button = cell(sourceId, targetId).querySelector("button");
  if (!button) throw new Error(`the cell for ${sourceId} to ${targetId} has no control`);
  fireEvent.click(button);
};

/**
 * The toast the page is showing, or `""`.
 *
 * Found by the icon the component always puts beside the message, so this is
 * the toast and not some other sentence that happens to share a word.
 */
const toast = (): string => {
  for (const el of [...document.querySelectorAll("span")]) {
    const icon = el.textContent ?? "";
    if (icon !== "ℹ" && icon !== "✓" && icon !== "✕") continue;
    const box = el.parentElement;
    if (box && (box.textContent ?? "").length > icon.length) return box.textContent ?? "";
  }
  return "";
};

const groupReads = () => calls.filter((c) => c.url.endsWith(GROUPS) && (c.init?.method ?? "GET") === "GET");
const egressWrites = () => calls.filter((c) => c.url.includes("/egress"));

describe("the four things the matrix can be saying", () => {
  it("says it is still asking, and claims nothing about the policy yet", async () => {
    // The read never answers, and the rest of the page has settled — so this is
    // what an operator sees while a slow route is in flight, not a frame caught
    // between two renders.
    readGroups = () => new Promise<Response>(() => {});
    await mount();

    expect(panelText()).toContain(LOADING);
    // Each of the three below is a claim about a server that has not spoken.
    expect(panelText()).not.toContain(EMPTY);
    expect(panelText()).not.toContain(UNREACHABLE);
    expect(panelText()).not.toContain(REFUSED);
    // A grid is the loudest claim of all: every cell of it is a verdict about a
    // rule nobody has answered for yet.
    expect(matrix()).toBe(null);
  });

  it("says the account may not read the policy when the server refused", async () => {
    readGroups = () => json(403, { error: "not allowed", capability: MANAGE });
    await mount();

    // The server answered. Reporting that as "the server did not answer" sends
    // an operator to check a network that is fine, for a permission they simply
    // do not hold.
    expect(panelText()).toContain(`${REFUSED}.`);
    expect(panelText()).not.toContain(MANAGE);
    expect(panelText()).not.toContain(UNREACHABLE);
    expect(panelText()).not.toContain(EMPTY);
    // A panel still saying "loading" after the read is over is a fourth wrong
    // sentence: the answer arrived and the operator is watching a spinner.
    expect(panelText()).not.toContain(LOADING);
    expect(matrix()).toBe(null);
  });

  it("does not name a capability the refusal did not name", async () => {
    // A refusal carrying no `capability` field. The dictionary still holds
    // `egress.refused`, a sentence with `group.manage` typed into it — a guess
    // that was right the day it was written. Reaching for it here would send an
    // operator to ask for a grant they may already hold.
    readGroups = () => json(403, { error: "not allowed" });
    await mount();

    expect(panelText()).toContain(`${REFUSED}.`);
    expect(panelText()).not.toContain(MANAGE);
    expect(panelText()).not.toContain(UNREACHABLE);
    expect(panelText()).not.toContain(EMPTY);
  });

  it("says the server never answered when nothing answered it", async () => {
    readGroups = () => { throw new TypeError("Failed to fetch"); };
    await mount();

    expect(panelText()).toContain(UNREACHABLE);
    expect(panelText()).not.toContain(REFUSED);
    expect(panelText()).not.toContain(EMPTY);
    expect(matrix()).toBe(null);
    // Only this route failed — the bell's queue answered — so the sentence is
    // about the groups route rather than about a backend being down. Without
    // this the fixture proves nothing about which request is being reported on.
    expect(calls.map((c) => c.url).some((url) => url.endsWith(BELL))).toBe(true);
  });

  it("does not read a broken proxy as a refusal", async () => {
    // A `5xx` is the server failing, not the server saying no. This is the line
    // the "502 read as signed out" defect crossed elsewhere in this console.
    readGroups = () => json(502, { error: "bad gateway" });
    await mount();

    expect(panelText()).toContain(UNREACHABLE);
    expect(panelText()).not.toContain(REFUSED);
    expect(panelText()).not.toContain(MANAGE);
  });

  it("says there are no groups only when the server said so", async () => {
    readGroups = () => json(200, { groups: [] });
    await mount();

    expect(panelText()).toContain(EMPTY);
    expect(panelText()).not.toContain(UNREACHABLE);
    expect(panelText()).not.toContain(REFUSED);
    expect(panelText()).not.toContain(LOADING);
    // "No groups" and "an empty grid" are different pictures of the same
    // answer, and only one of them is honest about there being nothing to
    // toggle.
    expect(matrix()).toBe(null);
  });

  it("draws the grid, and none of the three sentences, once the policy is read", async () => {
    readGroups = () => policy([{ from_group: ALPHA.group_id, to_group: BETA.group_id }]);
    await mount();

    expect(matrix()).not.toBe(null);
    // A grid rendered under a leftover error line is the collapse running in
    // the other direction, and just as unreadable.
    expect(panelText()).not.toContain(LOADING);
    expect(panelText()).not.toContain(EMPTY);
    expect(panelText()).not.toContain(UNREACHABLE);
    expect(panelText()).not.toContain(REFUSED);
    // One read of one route. A page that also asked a second groups-shaped
    // route would be drawing two answers into one grid.
    expect(groupReads().map((c) => c.url)).toEqual([`${GROUPS}`]);
  });
});

describe("what the grid says about the policy", () => {
  it("keeps A to B apart from B to A", async () => {
    readGroups = () => policy([{ from_group: ALPHA.group_id, to_group: BETA.group_id }]);
    await mount();

    // The whole point of a directional ACL. `maySend` matches `from_group` and
    // `to_group` and nothing else, so a transposed mapping draws a grid where
    // every word came from the server and every cell is untrue — and the
    // operator's next act is to grant a rule the server already has, or to
    // trust one it does not.
    expect(verdict(ALPHA.group_id, BETA.group_id)).toBe(ALLOW);
    expect(verdict(BETA.group_id, ALPHA.group_id)).toBe(DENY);
  });

  it("reads the same-group cell like any other, with no seeded exception", async () => {
    readGroups = () => policy([
      { from_group: ALPHA.group_id, to_group: BETA.group_id },
      { from_group: BETA.group_id, to_group: BETA.group_id },
    ]);
    await mount();

    // `maySend` requires a rule for a same-group send like any other pair, and
    // a group somebody creates has none until they say so — only `default` is
    // seeded, which is why drawing the diagonal as allowed looked right for
    // years. Beta has granted itself the rule, Alpha has not, and the two cells
    // must therefore differ.
    expect(verdict(BETA.group_id, BETA.group_id)).toBe(ALLOW);
    expect(verdict(ALPHA.group_id, ALPHA.group_id)).toBe(DENY);
  });

  it("puts the cells where the names say they are", async () => {
    readGroups = () => policy([{ from_group: ALPHA.group_id, to_group: BETA.group_id }]);
    await mount();

    // The assertions above read cells by `acl-<source>-<target>`. If those ids
    // were a private label disagreeing with the geometry drawn around them,
    // every one of those tests would pass over a grid the operator reads
    // transposed. So the one ALLOW cell is located by eye here instead: the
    // name down its own row, and the name above its own column.
    const target = cell(ALPHA.group_id, BETA.group_id);
    const row = target.parentElement;
    if (!row) throw new Error("the allowed cell is not inside a row");
    const cells = [...row.children];
    expect(cells[0]?.textContent).toBe(ALPHA.name);
    const heads = [...(matrix()?.querySelectorAll("thead th") ?? [])];
    expect(heads[cells.indexOf(target)]?.textContent).toBe(BETA.name);
  });

  it("draws an unread policy as a complete DENY grid — TODAY's behaviour, and the known defect", async () => {
    // `fetchGroups` answers `egress_allowed: null` when the response carried no
    // `egress` array at all, and its own comment says why: "without it every
    // group on a response carrying no `egress` reads as allowed to reach
    // nothing, which is a claim." This page then writes `(… ) || false` over
    // that `null` and makes exactly that claim.
    readGroups = () => json(200, { groups: [ALPHA, BETA] });
    await mount();
    const unread = grid();

    // Nothing on screen distinguishes it from the grid of a policy that really
    // was read and really allows nothing — the fifth state, drawn as the
    // fourth. Pinned, not endorsed: a page that told the two apart would fail
    // here, which is the signal that the defect below has been fixed.
    cleanup();
    readGroups = () => policy([]);
    await mount();
    expect(grid()).toEqual(unread);
    expect(unread).toEqual([[DENY, DENY], [DENY, DENY]]);
  });
});

describe("a toggle moves the policy only where the server moved", () => {
  it("grants the rule on the source group, naming the target in the body", async () => {
    readGroups = () => policy([]);
    await mount();

    toggle(ALPHA.group_id, BETA.group_id);
    await settle();

    // One write, and the pair the right way round. `POST /<from>/egress` with
    // `{to_group: <to>}` is the shape the route reads; sent transposed it
    // silently grants the opposite rule, and the grid — updated from the click
    // rather than from the answer — would show the operator what they asked for
    // either way.
    const writes = egressWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.url.endsWith(`${GROUPS}/${ALPHA.group_id}/egress`)).toBe(true);
    expect(writes[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(writes[0]?.init?.body))).toEqual({ to_group: BETA.group_id });

    expect(verdict(ALPHA.group_id, BETA.group_id)).toBe(ALLOW);
    // The reverse rule was not asked for and must not move: a toggle that wrote
    // both directions would open a path the operator never granted.
    expect(verdict(BETA.group_id, ALPHA.group_id)).toBe(DENY);
    expect(toast()).toContain(`${UPDATED}: [${ALPHA.name}] → [${BETA.name}] : ${ALLOW}`);
  });

  it("revokes the rule through the source group's own path", async () => {
    readGroups = () => policy([{ from_group: ALPHA.group_id, to_group: BETA.group_id }]);
    await mount();

    toggle(ALPHA.group_id, BETA.group_id);
    await settle();

    const writes = egressWrites();
    expect(writes).toHaveLength(1);
    // The target is in the path here rather than in a body, which is a second
    // place the pair can be swapped.
    expect(writes[0]?.url.endsWith(`${GROUPS}/${ALPHA.group_id}/egress/${BETA.group_id}`)).toBe(true);
    expect(writes[0]?.init?.method).toBe("DELETE");
    expect(verdict(ALPHA.group_id, BETA.group_id)).toBe(DENY);
    expect(toast()).toContain(`${UPDATED}: [${ALPHA.name}] → [${BETA.name}] : ${DENY}`);
  });

  it("puts the cell back when the server refused the write", async () => {
    readGroups = () => policy([{ from_group: ALPHA.group_id, to_group: BETA.group_id }]);
    writeEgress = () => json(403, { error: "not allowed", capability: MANAGE });
    await mount();

    toggle(ALPHA.group_id, BETA.group_id);
    // The control the revert is measured against. The cell is written
    // optimistically before the request leaves, so without seeing it move first
    // a page whose toggle did nothing at all would pass the assertion below.
    expect(verdict(ALPHA.group_id, BETA.group_id)).toBe(DENY);
    await settle();

    // The server refused, so the rule still stands on the other side. A grid
    // left showing DENY tells the operator this path is closed while the mesh
    // keeps delivering on it — the same class of defect as a decision the bell
    // marked done about a write that was blocked.
    expect(verdict(ALPHA.group_id, BETA.group_id)).toBe(ALLOW);
    expect(toast()).toContain(WRITE_FAILED);
    expect(toast()).not.toContain(UPDATED);
  });

  it("puts the cell back when the write never reached the server", async () => {
    readGroups = () => policy([]);
    writeEgress = () => { throw new TypeError("Failed to fetch"); };
    await mount();

    toggle(ALPHA.group_id, BETA.group_id);
    expect(verdict(ALPHA.group_id, BETA.group_id)).toBe(ALLOW);
    await settle();

    // Granted-in-the-browser-only is the worse half of the pair: the operator
    // reads that the path is open, stops thinking about it, and the mesh goes
    // on refusing every send with `-32018`.
    expect(verdict(ALPHA.group_id, BETA.group_id)).toBe(DENY);
    expect(toast()).toContain(WRITE_FAILED);
    expect(toast()).not.toContain(UPDATED);
  });
});
