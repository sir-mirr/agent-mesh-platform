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
const { AuthProvider } = await import("@/contexts/AuthContext.tsx");
const { RbacProvider } = await import("@/contexts/RbacContext.tsx");
const { CAPABILITY } = await import("@/types/auth.ts");
const { GroupsPage } = await import("./GroupsPage.tsx");

const ME = "/auth/me";
const GROUPS = "/api/v1/admin/groups";
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
const CREATE_BTN = DICTIONARY.en["groups.createBtn"]!;
const ASSIGN_BTN = DICTIONARY.en["groups.assignBtn"]!;
const NAME_LABEL = DICTIONARY.en["groups.modal.nameLabel"]!;
const DESC_LABEL = DICTIONARY.en["groups.modal.descLabel"]!;
const AGENT_LABEL = DICTIONARY.en["groups.modal.agentIdLabel"]!;
const ASSIGN_TITLE = DICTIONARY.en["groups.modal.assignTitle"]!;

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
/** What `GET /api/v1/admin/groups` does. */
let readGroups: Reply = () => json(200, { groups: [] });
/** What `POST /api/v1/admin/groups` does. */
let writeGroup: Reply = () => json(200, { ok: true, group_id: "grp_new", created: true });

const session = (capabilities: string[]) => ({
  github_id: 3,
  github_login: "operator-1",
  role: "member",
  approved: true,
  tenant: "tenant_default",
  capabilities,
  created_at: "2026-01-01T00:00:00Z",
});

beforeEach(() => {
  calls.length = 0;
  held = [MANAGE];
  readGroups = () => json(200, { groups: [] });
  writeGroup = () => json(200, { ok: true, group_id: "grp_new", created: true });
  // `AuthProvider` hydrates from storage and `I18nProvider` reads a saved
  // language out of it; happy-dom's storage belongs to the process, so a
  // leftover from another file would be a signed-in user or a second language.
  localStorage.clear();
  stub(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith(ME)) return json(200, session(held));
    if (url.endsWith(BELL)) return json(200, { ok: true, keys: [] });
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
const toast = (): string => {
  for (const el of [...document.querySelectorAll("span")]) {
    const icon = el.textContent ?? "";
    if (icon !== "✓" && icon !== "✕") continue;
    const box = el.parentElement;
    if (box && (box.textContent ?? "").length > icon.length) return box.textContent ?? "";
  }
  return "";
};

const groupReads = () =>
  calls.filter((c) => c.url.endsWith(GROUPS) && (c.init?.method ?? "GET") === "GET");
const groupWrites = () =>
  calls.filter((c) => c.url.endsWith(GROUPS) && (c.init?.method ?? "GET") === "POST");

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

const SUPPORT = {
  group_id: "grp_support",
  name: "Support Group",
  description: "front line",
  members: ["agt_alpha", "agt_beta"],
  created_at: "2026-08-01T10:00:00Z",
};
const BILLING = {
  group_id: "grp_billing",
  name: "Billing Group",
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
    expect(status()).toContain(`${REFUSED} (${MANAGE}).`);
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
    expect(status()).toContain(`${REFUSED} (${MANAGE}).`);
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
  it("puts each field the server sent in its own column", async () => {
    readGroups = () => json(200, { groups: [SUPPORT, BILLING] });
    await mount();

    expect(rows()).toHaveLength(2);

    // Every value below is somewhere in the body whatever the mapping does, so
    // a body-wide `toContain` passes with two columns exchanged — and a row
    // that shows one group's members under another group's name is a row where
    // every word came from the server and the row is still untrue.
    const support = cellsOf(rowFor(SUPPORT.group_id));
    expect(support[0]).toBe(`${SUPPORT.name}${SUPPORT.group_id}`);
    expect(support[1]).toBe(SUPPORT.description);
    expect(support[2]).toBe(String(SUPPORT.members.length));
    expect(support[3]).toBe(SUPPORT.members.join(""));

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
  it("sends the name and description the operator typed", async () => {
    await mount();
    fireEvent.click(buttonSaying(CREATE_BTN)!);
    typeInto(NAME_LABEL, "Analytics Group");
    typeInto(DESC_LABEL, "reporting only");
    submitForm();
    await settle();

    expect(groupWrites()).toHaveLength(1);
    const sent = JSON.parse(String(groupWrites()[0]?.init?.body ?? "{}"));
    // The dialog has two fields and the route takes two; sending the
    // description as the name is the kind of swap that only ever shows up on
    // the server.
    expect(sent).toMatchObject({ group_id: "Analytics Group", description: "reporting only" });
  });

  it("says the group was created, and shows what the server then listed", async () => {
    let reads = 0;
    readGroups = () => (reads++ === 0
      ? json(200, { groups: [] })
      : json(200, { groups: [{ ...SUPPORT, group_id: "grp_analytics", name: "Analytics Group" }] }));
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
    expect(cellsOf(rowFor("grp_analytics"))[0]).toContain("Analytics Group");
    // And the dialog is gone. One left open over its own success toast reads as
    // a write that did not take, and the retry it invites is a second group.
    // Counted rather than compared as a node: a failing comparison against an
    // element makes the runner serialise a DOM tree that refers back to itself,
    // and the report never arrives.
    expect(document.querySelectorAll("form").length).toBe(0);
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
  const openAssignFor = (groupId: string) => {
    const button = [...rowFor(groupId).querySelectorAll("button")]
      .find((b) => (b.textContent ?? "").includes(ASSIGN_BTN));
    if (!button) throw new Error(`the row for ${groupId} offers no assign control`);
    fireEvent.click(button);
  };

  it("names the group whose row was clicked, not the first one listed", async () => {
    readGroups = () => json(200, { groups: [SUPPORT, BILLING] });
    await mount();
    openAssignFor(BILLING.group_id);

    // The dialog is the only place the operator sees which group they are about
    // to change. A dialog that always names the first row would put the agent
    // somewhere else and say nothing about it.
    const title = document.querySelector("h2")?.textContent ?? "";
    expect(title).toBe(`${ASSIGN_TITLE} - ${BILLING.name}`);
    expect(title).not.toContain(SUPPORT.name);
  });

  it("adds the agent to the group it was assigned to and leaves the others alone", async () => {
    readGroups = () => json(200, { groups: [SUPPORT, BILLING] });
    await mount();
    openAssignFor(BILLING.group_id);
    typeInto(AGENT_LABEL, "agt_gamma");
    submitForm();
    await settle();

    const billing = cellsOf(rowFor(BILLING.group_id));
    expect(billing[3]).toBe("agt_gamma");
    // The count is a separate field from the list, and a count that does not
    // follow the list is the number an operator reads without opening the row.
    expect(billing[2]).toBe("1");

    // The group nobody named is untouched — both the list and its count. An
    // assignment applied to every row would put an agent in groups the operator
    // never opened.
    const support = cellsOf(rowFor(SUPPORT.group_id));
    expect(support[3]).toBe(SUPPORT.members.join(""));
    expect(support[2]).toBe(String(SUPPORT.members.length));
    expect(support[3]).not.toContain("agt_gamma");

    expect(toast()).toContain(ASSIGNED);
    expect(toast()).toContain("agt_gamma");
    expect(toast()).toContain(BILLING.name);
  });

  it("ignores a submission with no agent named", async () => {
    readGroups = () => json(200, { groups: [SUPPORT, BILLING] });
    await mount();
    openAssignFor(BILLING.group_id);
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
    readGroups = () => json(200, { groups: [{ group_id: "ops", name: "ops" }] });
    await mount();
    const row = [...tableEl().querySelectorAll("tbody tr")]
      .find((tr) => (tr.textContent ?? "").includes("ops"));
    expect(row).toBeDefined();
    expect(row!.textContent).toContain(ABSENT);
    expect(row!.textContent).not.toContain("2026");
  });

  it("draws no member count rather than nought", async () => {
    // `member_count: null` means the route did not report one. Nought is a
    // measurement, and this column made it out of an absence.
    readGroups = () => json(200, { groups: [{ group_id: "ops", name: "ops", member_count: null }] });
    await mount();
    const row = [...tableEl().querySelectorAll("tbody tr")]
      .find((tr) => (tr.textContent ?? "").includes("ops"));
    expect(row!.textContent).toContain(ABSENT);
  });

  it("still draws a real zero as a zero", async () => {
    // The other direction, and the reason the fix is `??` rather than `||`: a
    // group that really holds nobody answered `member_count: 0` and fell
    // through to the next fallback anyway, so *unknown* and *nobody* left this
    // mapping by the same road.
    readGroups = () => json(200, { groups: [{ group_id: "ops", name: "ops", member_count: 0, members: [] }] });
    await mount();
    const row = [...tableEl().querySelectorAll("tbody tr")]
      .find((tr) => (tr.textContent ?? "").includes("ops"));
    expect(row!.textContent).toContain("0");
  });
});

