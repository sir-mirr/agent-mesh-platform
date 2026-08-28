/**
 * What the group list says about the server, and what it must never say instead.
 *
 * Four readings, one panel: *still asking*, *the server refused*, *the server
 * never answered*, and *the server answered and there is nothing*. This console
 * has collapsed them three times, always in the same direction — "no groups yet"
 * drawn over a backend that never replied, which reads to an operator as a quiet
 * mesh rather than as a screen that failed. `api/client.ts` exists to make the
 * split available (`failureKind`, `refusedCapability`), so the assertions below
 * pin which of the four sentences appears **and which of the other three does
 * not**: an error state that also contains the empty sentence is the defect,
 * and only a negative can see it.
 *
 * Two more things are pinned here because they are the same mistake in another
 * field:
 *
 *   * **The refusal repeats the server's own capability name and invents none.**
 *     The dictionary still carries `groups.refused`, a sentence with
 *     `group.manage` typed into it — a guess that was right the day it was
 *     written. When the refusal names no capability, the screen must say only
 *     that it may not read, because a name it made up sends an operator to ask
 *     for a grant they may already hold.
 *   * **A write reads as done only when the server said it did.** `POST
 *     /api/v1/admin/groups` distinguishes *created* from *already existed*, and
 *     a refused write is neither.
 *
 * The providers are real. `mock.module` is global to the bun process and
 * survives the file that installs it, so every context here is mounted for
 * real and `fetch` is answered per-URL instead — which is also the only way to
 * tell a refusal of *this* screen's route from a backend that is down, since
 * the bell's route and `/auth/me` keep answering while the groups route fails.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { registerDom } from "../../register-dom";

// Registered once for the process and never unregistered: bun runs every test
// file's top level before it runs any test, so a register/unregister pair swaps
// the document out from under whichever file is still using it.
registerDom();

// `await import`, never a statement: a static import is hoisted above the
// registration above and would load React's DOM entry with no document present.
const { render, screen, cleanup, fireEvent, act } = await import("@testing-library/react");
const { MemoryRouter } = await import("react-router-dom");
const { I18nProvider, DICTIONARY } = await import("@/contexts/I18nContext.tsx");
const { AuthProvider } = await import("@/contexts/AuthContext.tsx");
const { RbacProvider } = await import("@/contexts/RbacContext.tsx");
const { CAPABILITY } = await import("@/types/auth.ts");
const { GroupsPage } = await import("./GroupsPage.tsx");

const ME = "/auth/me";
const GROUPS = "/api/v1/admin/groups";
const AGENTS = "/api/v1/agents";
const TENANTS = "/api/v1/admin/tenants/directory";
/** The bell inside `<Breadcrumbs>`; it must keep answering while groups fails. */
const BELL = "/api/v1/admin/keys/pending";

// Taken from the contract rather than typed: a capability name this mesh does
// not define is as wrong in a fixture as on a screen, because it makes the test
// agree with a server that does not exist.
const MANAGE = CAPABILITY.GROUP_MANAGE;

const LOADING = DICTIONARY.en["table.loading"]!;
const EMPTY = DICTIONARY.en["groups.empty"]!;
const UNREACHABLE = DICTIONARY.en["groups.error"]!;
const REFUSED = DICTIONARY.en["common.refusedRead"]!;
const CREATED = DICTIONARY.en["groups.created"]!;
const EXISTS = DICTIONARY.en["groups.exists"]!;
const CREATE_FAILED = DICTIONARY.en["groups.createFailed"]!;
const ASSIGNED = DICTIONARY.en["groups.assigned"]!;
const ASSIGN_UNKNOWN = DICTIONARY.en["groups.assignUnknown"]!;
const ASSIGN_FAILED = DICTIONARY.en["groups.assignFailed"]!;
const CREATE_BTN = DICTIONARY.en["groups.createBtn"]!;
const ASSIGN_BTN = DICTIONARY.en["groups.assignBtn"]!;
const NAME_LABEL = DICTIONARY.en["groups.modal.nameLabel"]!;
const DESC_LABEL = DICTIONARY.en["groups.modal.descLabel"]!;
const AGENT_LABEL = DICTIONARY.en["groups.modal.agentIdLabel"]!;
const TENANT_LABEL = DICTIONARY.en["groups.modal.tenantLabel"]!;
const ASSIGN_TITLE = DICTIONARY.en["groups.modal.assignTitle"]!;
const ASSIGN_EMPTY = DICTIONARY.en["groups.modal.assignEmpty"]!;
const ASSIGN_UNAVAILABLE = DICTIONARY.en["groups.modal.assignUnavailable"]!;
const CANCEL = DICTIONARY.en["common.cancel"]!;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const realFetch = globalThis.fetch;
/** bun:test has no global stubber, so the original goes back by hand — a
 *  forgotten restore poisons every file that runs after this one. */
const stub = (fn: unknown) => { globalThis.fetch = fn as typeof globalThis.fetch; };

type Reply = (init: RequestInit | undefined) => Response | Promise<Response>;
const calls: Array<{ url: string; init: RequestInit | undefined }> = [];

/** What `/auth/me` says this session holds. */
let held: string[] = [MANAGE];
let sessionRole = "member";
let sessionTenant = "default";
/** What `GET /api/v1/admin/groups` does. */
let readGroups: Reply = () => json(200, { groups: [] });
/** The unified registry used to decide which group members are agents. */
let readAgents: Reply = () => json(200, { agents: [] });
/** What the platform-only tenant directory does. */
let readTenants: Reply = () => json(200, {
  ok: true,
  tenant: "default",
  tenants: [{ id: "default", name: "Platform", created_at: "2026-01-01T00:00:00Z", deleted_at: null }],
});
/** What `POST /api/v1/admin/groups` does. */
let writeGroup: Reply = () => json(200, { ok: true, group_id: "grp_new", created: true });
/** What the singular group-member move does. */
let writeMember: Reply = () => json(200, {
  ok: true,
  identity: "agt_gamma",
  tenant: "default",
  from_group: null,
  to_group: "grp_billing",
});

const session = (capabilities: string[]) => ({
  github_id: 3,
  github_login: "operator-1",
  role: sessionRole,
  approved: true,
  tenant: sessionTenant,
  capabilities,
  created_at: "2026-01-01T00:00:00Z",
});

beforeEach(() => {
  calls.length = 0;
  held = [MANAGE];
  sessionRole = "member";
  sessionTenant = "default";
  readGroups = () => json(200, { groups: [] });
  readAgents = () => json(200, { agents: [
    { id: "operator-1", type: "user", tenant: "default" },
    { id: "agt_alpha", type: "agent", tenant: "default" },
    { id: "agt_beta", type: "agent", tenant: "default" },
    { id: "agt_gamma", type: "agent", tenant: "default" },
  ] });
  readTenants = () => json(200, {
    ok: true,
    tenant: "default",
    tenants: [
      { id: "default", name: "Platform", created_at: "2026-01-01T00:00:00Z", deleted_at: null },
      { id: "acme", name: "Acme", created_at: "2026-02-01T00:00:00Z", deleted_at: null },
      { id: "retired", name: "Retired", created_at: "2026-03-01T00:00:00Z", deleted_at: "2026-08-01T00:00:00Z" },
    ],
  });
  writeGroup = () => json(200, { ok: true, group_id: "grp_new", created: true });
  writeMember = () => json(200, {
    ok: true,
    identity: "agt_gamma",
    tenant: "default",
    from_group: null,
    to_group: "grp_billing",
  });
  // `AuthProvider` hydrates from storage and `I18nProvider` reads a saved
  // language out of it; happy-dom's storage belongs to the process, so a
  // leftover from another file would be a signed-in user or a second language.
  localStorage.clear();
  stub(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith(ME)) return json(200, session(held));
    if (url.endsWith(BELL)) return json(200, { ok: true, keys: [] });
    if (url.endsWith(TENANTS)) return await readTenants(init);
    if (url.endsWith(AGENTS) || url.includes(`${AGENTS}?`)) return await readAgents(init);
    if (/\/api\/v1\/admin\/groups\/[^/]+\/members$/.test(url)) return await writeMember(init);
    if (url.endsWith(GROUPS)) {
      return (init?.method ?? "GET") === "GET" ? await readGroups(init) : await writeGroup(init);
    }
    return json(200, { ok: true });
  });
});

afterEach(() => { cleanup(); localStorage.clear(); globalThis.fetch = realFetch; });
// What this file wrote into process-wide storage comes back out for everyone
// else in the run, not just for the next test in here.
afterAll(() => { localStorage.clear(); globalThis.fetch = realFetch; });

const settle = async () => {
  // The mount read resolves over several microtasks (fetch, then `.json()`,
  // then the mapping) and `/auth/me` writes state after its own, so a bare
  // `await act(async () => {})` is not always enough to have drained them.
  await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
};

const mount = async () => {
  // The real router, with the path the page is mounted at: `<Breadcrumbs>` reads
  // `useLocation`, and a stub of it leaks out of the file that installs it.
  render(
    <MemoryRouter initialEntries={["/creator/groups"]}>
      <I18nProvider>
        <AuthProvider>
          <RbacProvider>
            <GroupsPage />
          </RbacProvider>
        </AuthProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
  await settle();
};

const tableEl = (): HTMLElement => {
  const el = document.querySelector("table");
  if (!el) throw new Error("the page drew no table at all");
  return el as HTMLElement;
};

/**
 * The one line the table draws in place of rows — loading, error, or empty.
 *
 * Scoped to the table on purpose. The page's own subtitle names `group.manage`,
 * so a body-wide search for a capability name matches the header and would pass
 * whatever the failed panel said.
 */
const status = (): string => {
  const wrapper = tableEl().parentElement;
  const line = [...(wrapper?.children ?? [])].find((c) => c.tagName !== "TABLE");
  return line?.textContent ?? "";
};

const rows = (): HTMLElement[] => [...document.querySelectorAll("tbody tr")] as HTMLElement[];

const rowFor = (groupId: string): HTMLElement => {
  const row = rows().find((r) => (r.querySelector("td")?.textContent ?? "").includes(groupId));
  if (!row) throw new Error(`no row on the table renders ${groupId}`);
  return row;
};

/** One row, cell by cell, so a value in the wrong column is not a pass. */
const cellsOf = (row: HTMLElement): string[] =>
  [...row.querySelectorAll("td")].map((td) => td.textContent ?? "");

const buttonSaying = (word: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(word)) as
    | HTMLButtonElement
    | undefined;

/**
 * The toast the page is showing, or `""`.
 *
 * Found by the icon the component always puts beside the message, so this is
 * the toast and not some other sentence that happens to share a word. Both the
 * success and the failure icon are accepted: which one this page uses is a
 * separate question from what it says.
 */
const toastBox = (): HTMLElement | null => {
  for (const el of [...document.querySelectorAll("span")]) {
    const icon = el.textContent ?? "";
    if (icon !== "✓" && icon !== "✕") continue;
    const box = el.parentElement;
    if (box && (box.textContent ?? "").length > icon.length) return box;
  }
  return null;
};
const toast = (): string => toastBox()?.textContent ?? "";

const groupReads = () =>
  calls.filter((c) => c.url.endsWith(GROUPS) && (c.init?.method ?? "GET") === "GET");
const groupWrites = () =>
  calls.filter((c) => c.url.endsWith(GROUPS) && (c.init?.method ?? "GET") === "POST");
const memberWrites = () =>
  calls.filter((c) => /\/api\/v1\/admin\/groups\/[^/]+\/members$/.test(c.url));

const openForm = (): HTMLFormElement => {
  const form = document.querySelector("form");
  if (!form) throw new Error("no dialog form is open");
  return form as HTMLFormElement;
};
const typeInto = (label: string, value: string) => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};
/** Submit the open dialog through its own submit control, not past it. */
const submitForm = () => {
  const button = [...openForm().querySelectorAll("button")].find((b) => b.type === "submit");
  if (!button) throw new Error("the open dialog has no submit control");
  fireEvent.click(button);
};
/**
 * Submit the dialog without the browser's own field validation in the way.
 *
 * The fields are `required`, so a click on the submit control with one of them
 * empty never reaches the handler — which means a test that submits by clicking
 * cannot see the handler's own guard at all: deleting it leaves the file green.
 * A dispatched `submit` is the shape that arrives when validation is not the
 * thing stopping it, and it is what the guard is written for.
 */
const submitFormUnvalidated = () => { fireEvent.submit(openForm()); };

/**
 * A group as `GET /api/v1/admin/groups` sends it.
 *
 * **No `name`.** These fixtures carried one — "Support Group", "Billing Group"
 * — and the route has never sent it: `groupsStore.listGroups` selects
 * `tenant group_id description created_at created_by`, and the create route
 * accepts only `group_id description tenant`. So on a real deployment the
 * screen's Name column has always shown the group id, and the fixture was the
 * only place a display name existed.
 */
const SUPPORT = {
  group_id: "grp_support",
  tenant: "default",
  description: "front line",
  members: ["agt_alpha", "agt_beta"],
  created_at: "2026-08-01T10:00:00Z",
};
const BILLING = {
  group_id: "grp_billing",
  tenant: "default",
  description: "invoices",
  members: [],
  created_at: "2026-08-02T11:30:00Z",
};

describe("the four things the list can be saying", () => {
  it("says it is still asking, and claims nothing about the groups yet", async () => {
    // The read never answers, and everything else on the page has settled — so
    // this is the state an operator sees while a slow route is in flight, not a
    // frame between two renders.
    readGroups = () => new Promise<Response>(() => {});
    await mount();

    expect(status()).toContain(LOADING);
    // Each of these is a claim about a server that has not spoken. "No groups
    // yet" is the one this console keeps drawing here.
    expect(status()).not.toContain(EMPTY);
    expect(status()).not.toContain(UNREACHABLE);
    expect(status()).not.toContain(REFUSED);
    expect(rows()).toHaveLength(0);
  });

  it("says the account may not read groups when the server refused", async () => {
    readGroups = () => json(403, { error: "not allowed", capability: MANAGE });
    await mount();

    // The server answered. Reporting that as "the server did not answer" sends
    // an operator to check a network that is fine, for a permission they simply
    // do not hold — measured on this console with a member session.
    expect(status()).toContain(`${REFUSED}.`);
    expect(status()).not.toContain(MANAGE);
    expect(status()).not.toContain(UNREACHABLE);
    expect(status()).not.toContain(EMPTY);
    // A panel that never leaves the loading state is a third wrong sentence:
    // the read is over, and the operator is watching a spinner for an answer
    // that already arrived.
    expect(status()).not.toContain(LOADING);
  });

  it("does not name a capability the refusal did not name", async () => {
    // A refusal carrying no `capability` field. The dictionary still holds a
    // sentence with the name typed into it, and reaching for that here would
    // put a guess in front of the operator: the route's requirement may have
    // moved, and the one thing the screen knows is that it was refused.
    readGroups = () => json(403, { error: "not allowed" });
    await mount();

    expect(status()).toContain(`${REFUSED}.`);
    expect(status()).not.toContain(MANAGE);
    expect(status()).not.toContain(UNREACHABLE);
    expect(status()).not.toContain(EMPTY);
  });

  it("says the server never answered when nothing answered it", async () => {
    readGroups = () => { throw new TypeError("Failed to fetch"); };
    await mount();

    expect(status()).toContain(UNREACHABLE);
    expect(status()).not.toContain(REFUSED);
    expect(status()).not.toContain(EMPTY);
    // Only this route failed: the session read and the bell's queue both
    // answered, so the sentence is about the groups route rather than about a
    // backend being down. Without this the fixture proves nothing about which
    // request the screen is reporting on.
    expect(calls.map((c) => c.url)).toContain(ME);
    expect(calls.map((c) => c.url)).toContain(BELL);
  });

  it("does not read a broken proxy as a refusal", async () => {
    // A `5xx` is the server failing, not the server saying no. This is exactly
    // the line the "502 read as signed out" defect crossed elsewhere here.
    readGroups = () => json(502, { error: "bad gateway" });
    await mount();

    expect(status()).toContain(UNREACHABLE);
    expect(status()).not.toContain(REFUSED);
    expect(status()).not.toContain(MANAGE);
  });

  it("says there are no groups only when the server said so", async () => {
    readGroups = () => json(200, { groups: [] });
    await mount();

    expect(status()).toContain(EMPTY);
    expect(status()).not.toContain(UNREACHABLE);
    expect(status()).not.toContain(REFUSED);
    expect(status()).not.toContain(LOADING);
  });

  it("stops showing a list the server has stopped answering for", async () => {
    // A read that succeeded, then one that is refused. Every state above is
    // entered from an empty table, where "no rows" is also what the component
    // starts as — so nothing there can tell a screen that cleared the list from
    // one that never had it. Here the rows are really on screen first.
    let reads = 0;
    readGroups = () => (reads++ === 0
      ? json(200, { groups: [SUPPORT] })
      : json(403, { error: "not allowed", capability: MANAGE }));
    await mount();
    expect(rows()).toHaveLength(1);

    fireEvent.click(buttonSaying(CREATE_BTN)!);
    typeInto(NAME_LABEL, "Analytics Group");
    submitForm();
    await settle();

    // Rows left standing under a failed re-read are a list an operator reads as
    // current. The group may since have been deleted, or belong to a tenant
    // this session may no longer see; the screen no longer knows.
    expect(rows()).toHaveLength(0);
    expect(status()).toContain(`${REFUSED}.`);
    expect(status()).not.toContain(MANAGE);
    expect(status()).not.toContain(EMPTY);
  });

  it("reads the tenant's group route and no other", async () => {
    readGroups = () => json(200, { groups: [SUPPORT] });
    await mount();

    // One read of one route. A page that also asked a second groups-shaped
    // route would be drawing two answers into one table.
    expect(groupReads().map((c) => c.url)).toEqual([GROUPS]);
  });
});

describe("what a row says about a group", () => {
  it("draws the server's group id once and puts each other field in its own column", async () => {
    readGroups = () => json(200, { groups: [SUPPORT, BILLING] });
    await mount();

    expect(rows()).toHaveLength(2);

    // Every value below is somewhere in the body whatever the mapping does, so
    // a body-wide `toContain` passes with two columns exchanged — and a row
    // that shows one group's members under another group's name is a row where
    // every word came from the server and the row is still untrue.
    const support = cellsOf(rowFor(SUPPORT.group_id));
    expect([...tableEl().querySelectorAll("thead th")][0]?.textContent).toBe("Group ID");
    expect(DICTIONARY.ko["groups.col.name"]).toBe("그룹 ID");
    // The route sends no display name. One server-sent id is the whole first
    // cell; drawing it twice invents the appearance of two distinct fields.
    expect(support[0]).toBe(SUPPORT.group_id);
    expect(support[1]).toBe(SUPPORT.description);
    expect(support[2]).toBe(String(SUPPORT.members.length));
    expect(support[3]).toBe(SUPPORT.members.join(""));
    expect(support[5]).toBe(SUPPORT.tenant);

    const billing = cellsOf(rowFor(BILLING.group_id));
    expect(billing[1]).toBe(BILLING.description);
    expect(billing[2]).toBe("0");
    // The server said this group has no members. Borrowing the neighbouring
    // row's list would still look like a populated console.
    expect(billing[3]).not.toContain("agt_");
  });

  it("dates a group from what the server sent rather than from a constant", async () => {
    readGroups = () => json(200, { groups: [SUPPORT, BILLING] });
    await mount();

    // Two different instants, each rendered from its own row's `created_at`. A
    // fabricated timestamp — the defect already found on the registry screen —
    // would make both cells read the same, and it is a value an operator sorts
    // and reasons by.
    expect(cellsOf(rowFor(SUPPORT.group_id))[4])
      .toBe(new Date(SUPPORT.created_at).toLocaleString());
    expect(cellsOf(rowFor(BILLING.group_id))[4])
      .toBe(new Date(BILLING.created_at).toLocaleString());
  });

  it("does not count or list a person from a mixed policy group as an agent", async () => {
    readGroups = () => json(200, { groups: [{
      ...SUPPORT,
      members: ["operator-1", "agt_alpha"],
    }] });
    await mount();

    const row = cellsOf(rowFor(SUPPORT.group_id));
    expect(row[2]).toBe("1");
    expect(row[3]).toBe("agt_alpha");
    expect(row[3]).not.toContain("operator-1");
  });

  it("keeps equal group ids in different tenants as two visible rows", async () => {
    readGroups = () => json(200, { groups: [
      { ...BILLING, tenant: "acme", description: "acme row" },
      { ...BILLING, tenant: "beta", description: "beta row" },
    ] });
    await mount();

    expect(rows()).toHaveLength(2);
    const rendered = rows().map(cellsOf);
    expect(rendered.find((cells) => cells[1] === "acme row")?.[5]).toBe("acme");
    expect(rendered.find((cells) => cells[1] === "beta row")?.[5]).toBe("beta");
  });
});

describe("the control offered to a session that may not use it", () => {
  it("offers group creation only where the server granted it", async () => {
    readGroups = () => json(200, { groups: [] });

    held = [MANAGE];
    await mount();
    const granted = buttonSaying(CREATE_BTN) !== undefined;
    cleanup();

    // The same page for a session the server said holds nothing. Without the
    // granted arm above, an absent button proves only that the page never draws
    // one.
    held = [];
    await mount();
    const withheld = buttonSaying(CREATE_BTN) !== undefined;

    expect({ granted, withheld }).toEqual({ granted: true, withheld: false });
  });
});

describe("creating a group", () => {
  it("dismisses the create dialog from both its close and cancel controls", async () => {
    await mount();
    fireEvent.click(buttonSaying(CREATE_BTN)!);
    const close = document.querySelector("h2")?.parentElement?.querySelector("button");
    if (!close) throw new Error("the create dialog has no close control");
    fireEvent.click(close);
    expect(document.querySelector("form")).toBeNull();

    fireEvent.click(buttonSaying(CREATE_BTN)!);
    typeInto(NAME_LABEL, "Not submitted");
    const cancel = [...openForm().querySelectorAll("button")]
      .find((button) => button.textContent === CANCEL);
    if (!cancel) throw new Error("the create dialog has no cancel control");
    fireEvent.click(cancel);
    expect(document.querySelector("form")).toBeNull();
    expect(groupWrites()).toHaveLength(0);
  });

  it("a tenant-scoped session sends the typed fields but no tenant override", async () => {
    await mount();
    fireEvent.click(buttonSaying(CREATE_BTN)!);
    expect(screen.queryByLabelText(TENANT_LABEL)).toBeNull();
    expect(calls.some((call) => call.url.endsWith(TENANTS))).toBe(false);
    typeInto(NAME_LABEL, "Analytics Group");
    typeInto(DESC_LABEL, "reporting only");
    submitForm();
    await settle();

    expect(groupWrites()).toHaveLength(1);
    const sent = JSON.parse(String(groupWrites()[0]?.init?.body ?? "{}"));
    // The dialog has two fields and the route takes two; sending the
    // description as the name is the kind of swap that only ever shows up on
    // the server.
    expect(sent).toEqual({ group_id: "Analytics Group", description: "reporting only" });
  });

  it("a platform administrator selects the tenant sent with the new group", async () => {
    sessionRole = "admin";
    await mount();
    fireEvent.click(buttonSaying(CREATE_BTN)!);

    const picker = screen.getByLabelText(TENANT_LABEL) as HTMLSelectElement;
    expect([...picker.options].map((option) => option.value)).toEqual(["default", "acme"]);
    expect([...picker.options].map((option) => option.value)).not.toContain("retired");
    expect(picker.value).toBe("default");
    fireEvent.change(picker, { target: { value: "acme" } });
    typeInto(NAME_LABEL, "Analytics Group");
    submitForm();
    await settle();

    expect(groupWrites()).toHaveLength(1);
    expect(JSON.parse(String(groupWrites()[0]!.init!.body)))
      .toEqual({ group_id: "Analytics Group", description: "", tenant: "acme" });
  });

  it("keeps an unanswered platform tenant directory distinct from no active tenants", async () => {
    sessionRole = "admin";
    readTenants = () => { throw new TypeError("Failed to fetch"); };
    await mount();
    fireEvent.click(buttonSaying(CREATE_BTN)!);

    expect(screen.getByTestId("group-tenant-unreachable").textContent)
      .toContain(DICTIONARY.en["groups.modal.tenantUnavailable"]!);
    expect(screen.queryByTestId("group-tenant-empty")).toBeNull();
    const submit = [...openForm().querySelectorAll("button")].find((button) => button.type === "submit");
    expect((submit as HTMLButtonElement).disabled).toBe(true);
  });

  it("says the group was created, and shows what the server then listed", async () => {
    let reads = 0;
    readGroups = () => (reads++ === 0
      ? json(200, { groups: [] })
      : json(200, { groups: [{ ...SUPPORT, group_id: "grp_analytics" }] }));
    writeGroup = () => json(200, { ok: true, group_id: "grp_analytics", created: true });

    await mount();
    fireEvent.click(buttonSaying(CREATE_BTN)!);
    typeInto(NAME_LABEL, "Analytics Group");
    submitForm();
    await settle();

    expect(toast()).toContain(`${CREATED}: grp_analytics`);
    expect(toast()).not.toContain(EXISTS);
    // The row is on screen because the list was read again, not because the
    // dialog put it there: a locally appended row survives a server that never
    // stored it, and the operator finds out on the next reload.
    expect(groupReads()).toHaveLength(2);
    // The reread's row, drawn under the id the server stored. The operator
    // typed "Analytics Group" into a field labelled Name, and the route stores
    // that string as `group_id` — see the `sent` assertion above, which is the
    // body this form posts.
    expect(cellsOf(rowFor("grp_analytics"))[0]).toContain("grp_analytics");
    // And the dialog is gone. One left open over its own success toast reads as
    // a write that did not take, and the retry it invites is a second group.
    // Counted rather than compared as a node: a failing comparison against an
    // element makes the runner serialise a DOM tree that refers back to itself,
    // and the report never arrives.
    expect(document.querySelectorAll("form").length).toBe(0);

    const closeToast = toastBox()?.querySelector("button");
    if (!closeToast) throw new Error("the group result toast has no close control");
    fireEvent.click(closeToast);
    expect(toast()).toBe("");
  });

  it("says the group already existed when the server says it created nothing", async () => {
    writeGroup = () => json(200, { ok: true, group_id: "grp_support", created: false });

    await mount();
    fireEvent.click(buttonSaying(CREATE_BTN)!);
    typeInto(NAME_LABEL, "Support Group");
    submitForm();
    await settle();

    // `created: false` is the server saying the name was taken. Reporting it as
    // a creation tells an operator they have just made a group that somebody
    // else owns and that they did not change.
    expect(toast()).toContain(`${EXISTS}: grp_support`);
    expect(toast()).not.toContain(CREATED);
  });

  it("does not report a group the server refused to create", async () => {
    writeGroup = () => json(403, { error: "not allowed", capability: MANAGE });

    await mount();
    fireEvent.click(buttonSaying(CREATE_BTN)!);
    typeInto(NAME_LABEL, "Analytics Group");
    submitForm();
    await settle();

    expect(toast()).toContain(CREATE_FAILED);
    expect(toast()).not.toContain(CREATED);
    expect(toast()).not.toContain(EXISTS);
    // The dialog is still open with what was typed still in it. Clearing a form
    // for a write the server rejected makes the retry a retype, and the operator
    // has nothing on screen telling them what they had asked for.
    expect((screen.getByLabelText(NAME_LABEL) as HTMLInputElement).value)
      .toBe("Analytics Group");
    // And the group does not appear in the list either. A refused write that
    // leaves a row behind is the same defect as a refused decision that marks a
    // key approved: the screen and the server disagree, and only the screen is
    // in the room.
    expect(rows()).toHaveLength(0);
    expect(status()).toContain(EMPTY);
  });
});

describe("assigning an agent to a group", () => {
  const openAssignFor = async (groupId: string) => {
    const button = [...rowFor(groupId).querySelectorAll("button")]
      .find((b) => (b.textContent ?? "").includes(ASSIGN_BTN));
    if (!button) throw new Error(`the row for ${groupId} offers no assign control`);
    fireEvent.click(button);
    await settle();
  };

  it("dismisses the assignment dialog from both its close and cancel controls", async () => {
    readGroups = () => json(200, { groups: [BILLING] });
    await mount();
    await openAssignFor(BILLING.group_id);
    const close = document.querySelector("h2")?.parentElement?.querySelector("button");
    if (!close) throw new Error("the assignment dialog has no close control");
    fireEvent.click(close);
    expect(document.querySelector("form")).toBeNull();

    await openAssignFor(BILLING.group_id);
    const cancel = [...openForm().querySelectorAll("button")]
      .find((button) => button.textContent === CANCEL);
    if (!cancel) throw new Error("the assignment dialog has no cancel control");
    fireEvent.click(cancel);
    expect(document.querySelector("form")).toBeNull();
    expect(memberWrites()).toHaveLength(0);
  });

  it("names the group whose row was clicked, not the first one listed", async () => {
    readGroups = () => json(200, { groups: [SUPPORT, BILLING] });
    await mount();
    await openAssignFor(BILLING.group_id);

    // The dialog is the only place the operator sees which group they are about
    // to change. A dialog that always names the first row would put the agent
    // somewhere else and say nothing about it.
    const title = document.querySelector("h2")?.textContent ?? "";
    expect(title).toBe(`${ASSIGN_TITLE} - ${BILLING.group_id}`);
    expect(title).not.toContain(SUPPORT.group_id);
  });

  it("posts the selected agent with the group tenant, then shows the server's reread", async () => {
    let moved = false;
    readGroups = () => json(200, {
      groups: [SUPPORT, { ...BILLING, members: moved ? ["agt_gamma"] : [] }],
    });
    writeMember = (init) => {
      moved = true;
      return json(200, {
        ok: true,
        identity: "agt_gamma",
        tenant: "default",
        from_group: null,
        to_group: BILLING.group_id,
      });
    };
    await mount();
    await openAssignFor(BILLING.group_id);
    typeInto(AGENT_LABEL, "agt_gamma");
    submitForm();
    await settle();

    expect(memberWrites()).toHaveLength(1);
    expect(memberWrites()[0]!.url).toMatch(/\/groups\/grp_billing\/members$/);
    expect(JSON.parse(String(memberWrites()[0]!.init!.body)))
      .toEqual({ identity: "agt_gamma", tenant: "default" });

    const billing = cellsOf(rowFor(BILLING.group_id));
    expect(billing[3]).toBe("agt_gamma");
    // The count is a separate field from the list, and a count that does not
    // follow the list is the number an operator reads without opening the row.
    expect(billing[2]).toBe("1");

    // The group nobody named is untouched in the server's reread.
    const support = cellsOf(rowFor(SUPPORT.group_id));
    expect(support[3]).toBe(SUPPORT.members.join(""));
    expect(support[2]).toBe(String(SUPPORT.members.length));
    expect(support[3]).not.toContain("agt_gamma");

    expect(toast()).toContain(ASSIGNED);
    expect(toast()).toContain("agt_gamma");
    expect(toast()).toContain(BILLING.group_id);
  });

  it("offers only non-user agents from the selected group's tenant", async () => {
    readAgents = () => json(200, { agents: [
      { id: "operator-1", type: "user", tenant: "default" },
      { id: "agt_same", type: "agent", tenant: "default" },
      { id: "agt_other", type: "agent", tenant: "acme" },
    ] });
    readGroups = () => json(200, { groups: [BILLING] });
    await mount();
    await openAssignFor(BILLING.group_id);

    const select = screen.getByLabelText(AGENT_LABEL) as HTMLSelectElement;
    expect(select.tagName).toBe("SELECT");
    const offered = [...select.options].map((option) => option.value).filter(Boolean);
    expect(offered).toEqual(["agt_same"]);
    expect(offered).not.toContain("operator-1");
    expect(offered).not.toContain("agt_other");
    expect(calls.map((call) => call.url)).toContain(`${AGENTS}?tenant=default`);
  });

  it("keeps the tenant guard in the handler if the DOM select is tampered with", async () => {
    readGroups = () => json(200, { groups: [BILLING] });
    await mount();
    await openAssignFor(BILLING.group_id);

    const select = screen.getByLabelText(AGENT_LABEL) as HTMLSelectElement;
    const forged = document.createElement("option");
    forged.value = "operator-1";
    forged.textContent = "operator-1";
    select.appendChild(forged);
    fireEvent.change(select, { target: { value: "operator-1" } });
    submitForm();
    await settle();

    expect(memberWrites()).toHaveLength(0);
    expect(toast()).toContain(ASSIGN_UNKNOWN);
    expect(toast()).not.toContain(ASSIGNED);
  });

  it("explicitly says when this tenant has no assignable agents", async () => {
    readAgents = () => json(200, { agents: [
      { id: "operator-1", type: "user", tenant: "default" },
      { id: "agt_other", type: "agent", tenant: "acme" },
    ] });
    readGroups = () => json(200, { groups: [BILLING] });
    await mount();
    await openAssignFor(BILLING.group_id);

    expect(screen.getByTestId("assign-candidates-empty").textContent).toContain(ASSIGN_EMPTY);
    expect(screen.queryByLabelText(AGENT_LABEL)).toBeNull();
    expect(memberWrites()).toHaveLength(0);
  });

  it("keeps an unreachable candidate read distinct from an empty tenant", async () => {
    let reads = 0;
    readAgents = () => {
      if (reads++ === 0) return json(200, { agents: [] });
      throw new TypeError("Failed to fetch");
    };
    readGroups = () => json(200, { groups: [BILLING] });
    await mount();
    await openAssignFor(BILLING.group_id);

    expect(screen.getByTestId("assign-candidates-unreachable").textContent)
      .toContain(ASSIGN_UNAVAILABLE);
    expect(document.body.textContent).not.toContain(ASSIGN_EMPTY);
    expect(screen.queryByLabelText(AGENT_LABEL)).toBeNull();
  });

  it("does not ask for candidates when the group has no tenant to scope them to", async () => {
    readGroups = () => json(200, { groups: [{ ...BILLING, tenant: null }] });
    await mount();
    const readsBeforeOpen = calls.filter((call) => call.url.includes(AGENTS)).length;
    await openAssignFor(BILLING.group_id);

    expect(screen.getByTestId("assign-candidates-tenant-unknown").textContent)
      .toContain(DICTIONARY.en["groups.modal.assignTenantUnknown"]!);
    expect(screen.queryByLabelText(AGENT_LABEL)).toBeNull();
    expect(calls.filter((call) => call.url.includes(AGENTS))).toHaveLength(readsBeforeOpen);
  });

  it("does not report or draw a move the server refused", async () => {
    writeMember = () => json(403, { error: "not allowed", capability: MANAGE });
    readGroups = () => json(200, { groups: [BILLING] });
    await mount();
    await openAssignFor(BILLING.group_id);
    typeInto(AGENT_LABEL, "agt_gamma");
    submitForm();
    await settle();

    expect(memberWrites()).toHaveLength(1);
    expect(cellsOf(rowFor(BILLING.group_id))[2]).toBe("0");
    expect(cellsOf(rowFor(BILLING.group_id))[3]).toBe("-");
    expect(toast()).toContain(ASSIGN_FAILED);
    expect(toast()).not.toContain(ASSIGNED);
  });

  it("sends only one move while the first request is still in flight", async () => {
    let finish!: (response: Response) => void;
    writeMember = () => new Promise<Response>((resolve) => { finish = resolve; });
    readGroups = () => json(200, { groups: [BILLING] });
    await mount();
    await openAssignFor(BILLING.group_id);
    typeInto(AGENT_LABEL, "agt_gamma");

    fireEvent.submit(openForm());
    fireEvent.submit(openForm());
    await settle();
    expect(memberWrites()).toHaveLength(1);

    finish(json(200, {
      ok: true,
      identity: "agt_gamma",
      tenant: "default",
      from_group: null,
      to_group: BILLING.group_id,
    }));
    await settle();
  });

  it("ignores a submission with no agent named", async () => {
    readGroups = () => json(200, { groups: [SUPPORT, BILLING] });
    await mount();
    await openAssignFor(BILLING.group_id);
    submitFormUnvalidated();
    await settle();

    // Nothing was named, so nothing moved and nothing is claimed. Without the
    // handler's own guard the group gains a member with an empty name — a row
    // that counts one agent and can name none — and the toast reports it as an
    // assignment that happened.
    expect(cellsOf(rowFor(BILLING.group_id))[2]).toBe("0");
    expect(cellsOf(rowFor(BILLING.group_id))[3]).toBe("-");
    expect(toast()).not.toContain(ASSIGNED);
  });
});

describe("a field the route did not send", () => {
  const ABSENT = DICTIONARY.en["common.unknownValue"]!;

  it("draws no creation time rather than a plausible one", async () => {
    // **This filled it with `2026-08-17 12:00:00`.** A fixed timestamp, and a
    // convincing one: a name can be doubted on sight and a date cannot, so an
    // operator reading this column had no way to tell a group the mesh dated
    // from one it did not. `api/groups.ts` keeps `created_at` as `null`; the
    // screen said otherwise in one line.
    readGroups = () => json(200, { groups: [{ group_id: "ops" }] });
    await mount();
    const row = [...tableEl().querySelectorAll("tbody tr")]
      .find((tr) => (tr.textContent ?? "").includes("ops"));
    expect(row).toBeDefined();
    expect(row!.textContent).toContain(ABSENT);
    expect(row!.textContent).not.toContain("2026");
  });

  /**
   * **The member-count cell, not the row.** The row also holds a created-at and
   * a description this fixture does not set, and both draw the same dash — so
   * `row.textContent` contains it whatever this column did, and the check
   * passed over `member_count || … || 0` for as long as it was written that
   * way. Found by `scripts/mutation-check.ts`, which is the only reason anybody
   * looked.
   */
  const memberCountCell = (): HTMLElement => {
    const row = [...tableEl().querySelectorAll("tbody tr")]
      .find((tr) => (tr.textContent ?? "").includes("ops"));
    expect(row).toBeDefined();
    const headers = [...tableEl().querySelectorAll("thead th")].map((th) => th.textContent ?? "");
    const column = headers.findIndex((h) => h.includes(DICTIONARY.en["groups.col.agents"]!));
    expect(column, "the member-count column is no longer in the header").toBeGreaterThanOrEqual(0);
    return [...row!.querySelectorAll("td")][column] as HTMLElement;
  };

  it("draws no member count rather than nought", async () => {
    // `member_count: null` means the route did not report one. Nought is a
    // measurement, and this column made it out of an absence.
    readGroups = () => json(200, { groups: [{ group_id: "ops", member_count: null }] });
    await mount();
    expect(memberCountCell().textContent).toContain(ABSENT);
  });

  it("still draws a real zero as a zero", async () => {
    // The other direction, and the reason the fix is `??` rather than `||`: a
    // group that really holds nobody answered `member_count: 0` and fell
    // through to the next fallback anyway, so *unknown* and *nobody* left this
    // mapping by the same road.
    readGroups = () => json(200, { groups: [{ group_id: "ops", member_count: 0, members: [] }] });
    await mount();
    expect(memberCountCell().textContent).toContain("0");
  });
});
