/**
 * What the agent list says about the server, and what it must never say instead.
 *
 * Four readings, one table: *still asking*, *the server refused*, *the server
 * never answered*, and *the server answered and there is nothing registered*.
 * This console has collapsed them three times, always in the same direction —
 * "no agents are registered" drawn over a backend that never replied, which an
 * operator reads as a quiet mesh rather than as a screen that failed.
 * `api/client.ts` exists so the split does not have to be guessed at
 * (`failureKind`, `refusedCapability`); the assertions below pin which of the
 * four sentences the table draws **and which of the other three it does not**,
 * because an error state that also contains the empty sentence is the defect
 * and only a negative can see it.
 *
 * Three more things are pinned here, each the same invention in another column.
 * `GET /api/v1/agents` answers `{id, name, description, channel, type,
 * created_at, last_seen_at, fingerprint}` and no more — the fixtures below are
 * that shape — and every absent field in it used to be filled in on arrival:
 *
 *   * **`last_seen_at: null` is no presence record, not "offline".** SPEC § 9.1
 *     says the route carries no status on purpose, because whether silence
 *     means inactive is an operating policy. The screen may say when the mesh
 *     last saw an identity; it may not say what that means.
 *   * **An absent fingerprint has to look absent.** It defaulted to the literal
 *     `sha256:verified_mesh_identity` under a column headed "Ed25519 public key
 *     fingerprint" — the field an operator compares by eye to decide an
 *     identity is who it claims to be, so a constant there makes every agent
 *     match and the word inside it invites skipping the comparison.
 *   * **Mailbox depth is not on this route at all.** It was a literal `0`, and
 *     zero backlog is the answer an operator hopes for, so the one cell nobody
 *     could check was also the one nobody would question.
 *
 * And teardown is irreversible — the identity is destroyed, its key moves to
 * the breach archive, and the name can never be registered again. So the
 * control is asserted to appear only for the capability the server granted,
 * the confirmation to be armed only by the identity of the row the operator
 * actually clicked, and a refused or unanswered `DELETE` never to read as a
 * teardown that happened.
 *
 * The providers are real. `mock.module` is global to the bun process and
 * outlives the file that installs it, so every context here is mounted for real
 * and `fetch` is answered per-URL instead — which is also the only way to tell
 * a refusal of *this* screen's route from a backend that is down, since
 * `/auth/me` and the bell's queue keep answering while the agent route fails.
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
const { AgentsPage } = await import("./AgentsPage.tsx");

const ME = "/auth/me";
const AGENTS = "/api/v1/agents";
/** The teardown route, which is a different path — `admin/agents/<identity>`. */
const TEARDOWN_PATH = "/api/v1/admin/agents/";
/** The bell inside `<Breadcrumbs>`; it must keep answering while agents fails. */
const BELL = "/api/v1/admin/keys/pending";

// Taken from the contract rather than typed as strings: a capability name this
// mesh does not define is as wrong in a fixture as it is on a screen, because
// it makes the test agree with a server that does not exist.
const TEARDOWN_CAP = CAPABILITY.AGENT_TEARDOWN;
/**
 * The name a refusal carries in the fixtures below.
 *
 * Which capability the list route will come to require is the route's business
 * — today it refuses an unapproved account without naming one at all. What is
 * pinned here is that the screen repeats whatever § 11.3's refusal names and
 * invents nothing, so the fixture needs a real name and not this route's.
 */
const PROVISION = CAPABILITY.AGENT_PROVISION;

const LOADING = DICTIONARY.en["table.loading"]!;
const EMPTY = DICTIONARY.en["agents.empty"]!;
const UNREACHABLE = DICTIONARY.en["agents.error"]!;
const REFUSED = DICTIONARY.en["common.refusedRead"]!;
const NEVER_SEEN = DICTIONARY.en["agents.neverSeen"]!;
const AGO = DICTIONARY.en["agents.ago"]!;
const HOUR = DICTIONARY.en["agents.unit.hour"]!;
const NOT_REPORTED = DICTIONARY.en["agents.notReported"]!;
const FP_ABSENT = DICTIONARY.en["fp.absent"]!;
const PLAYGROUND = DICTIONARY.en["nav.playground"]!;
const TEARDOWN_BTN = DICTIONARY.en["agents.teardownBtn"]!;
const TEARDOWN_CONFIRM = DICTIONARY.en["agents.teardown.confirm"]!;
const TORN_DOWN = DICTIONARY.en["agents.teardown.done"]!;
const TEARDOWN_FAILED = DICTIONARY.en["agents.teardown.failed"]!;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const realFetch = globalThis.fetch;
/** bun:test has no global stubber, so the original goes back by hand — a
 *  forgotten restore poisons every file that runs after this one. */
const stub = (fn: unknown) => { globalThis.fetch = fn as typeof globalThis.fetch; };

type Reply = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;
const calls: Array<{ url: string; init: RequestInit | undefined }> = [];

/** What `/auth/me` says this session holds. */
let held: string[] = [TEARDOWN_CAP];
/** What `GET /api/v1/agents` does. */
let readAgents: Reply = () => json(200, { agents: [] });
/** What `DELETE /api/v1/admin/agents/<identity>` does. */
let destroyAgent: Reply = () => json(200, { ok: true });

const session = (capabilities: string[]) => ({
  github_id: 4,
  github_login: "operator-1",
  role: "member",
  approved: true,
  tenant: "tenant_default",
  capabilities,
  created_at: "2026-01-01T00:00:00Z",
});

beforeEach(() => {
  calls.length = 0;
  held = [TEARDOWN_CAP];
  readAgents = () => json(200, { agents: [] });
  destroyAgent = () => json(200, { ok: true });
  // `AuthProvider` hydrates from storage and `I18nProvider` reads a saved
  // language out of it; happy-dom's storage belongs to the process, so a
  // leftover from another file would be a signed-in user or a second language.
  localStorage.clear();
  stub(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith(ME)) return json(200, session(held));
    if (url.endsWith(BELL)) return json(200, { ok: true, keys: [] });
    if (url.endsWith(AGENTS)) return await readAgents(url, init);
    if (url.includes(TEARDOWN_PATH)) return await destroyAgent(url, init);
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
  // The real router, at the path this page is mounted at: `<Breadcrumbs>` reads
  // `useLocation`, and a stub of it leaks out of the file that installs it.
  render(
    <MemoryRouter initialEntries={["/creator"]}>
      <I18nProvider>
        <AuthProvider>
          <RbacProvider>
            <AgentsPage />
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
 * Scoped to the table on purpose: the page's own subtitle and the breadcrumb
 * bar are full of prose, and a body-wide search would pass on words that are
 * nowhere near the panel that failed.
 */
const status = (): string => {
  const wrapper = tableEl().parentElement;
  const line = [...(wrapper?.children ?? [])].find((c) => c.tagName !== "TABLE");
  return line?.textContent ?? "";
};

const rows = (): HTMLElement[] => [...document.querySelectorAll("tbody tr")] as HTMLElement[];

const rowFor = (identity: string): HTMLElement => {
  const row = rows().find((r) => (r.querySelector("td")?.textContent ?? "").includes(identity));
  if (!row) throw new Error(`no row on the table renders ${identity}`);
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
 * The teardown dialog, or `null`.
 *
 * `Modal` is the only thing on this screen positioned `fixed`, and it returns
 * `null` when it is closed — so this is also how "no dialog is open" is read.
 */
const dialog = (): HTMLElement | null =>
  ([...document.querySelectorAll("div")] as HTMLElement[])
    .find((d) => d.style.position === "fixed") ?? null;

const dialogText = (): string => dialog()?.textContent ?? "";

const confirmField = (): HTMLInputElement => {
  const input = dialog()?.querySelector('input[type="text"]');
  if (!input) throw new Error("the open dialog has no confirmation field");
  return input as HTMLInputElement;
};

const confirmButton = (): HTMLButtonElement => {
  const button = [...(dialog()?.querySelectorAll("button") ?? [])].find((b) =>
    (b.textContent ?? "").includes(TEARDOWN_CONFIRM));
  if (!button) throw new Error("the open dialog has no teardown control");
  return button as HTMLButtonElement;
};

/**
 * The toast the page is showing, or `""`.
 *
 * Found by the icon the component always puts beside the message, so this is
 * the toast and not some other sentence sharing a word with it. Every icon the
 * component can pick is accepted: which one this page uses is a separate
 * question from what it says.
 */
const TOAST_ICONS = ["✓", "✕", "!", "ℹ"];
const toast = (): string => {
  for (const el of [...document.querySelectorAll("span")]) {
    const icon = el.textContent ?? "";
    if (!TOAST_ICONS.includes(icon)) continue;
    const box = el.parentElement;
    if (box && (box.textContent ?? "").length > icon.length) return box.textContent ?? "";
  }
  return "";
};

const agentReads = () => calls.filter((c) => c.url.endsWith(AGENTS));
const teardownWrites = () => calls.filter((c) => c.url.includes(TEARDOWN_PATH));

/** Two hours before now, so `lastSeenText` composes the hour unit from it. */
const twoHoursAgo = () => new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

/**
 * The shape `GET /api/v1/agents` really answers with.
 *
 * Taken from the route in `agent-mesh-http`, which joins the registry to the
 * mesh's presence and key tables: there is no `status` field and no queue
 * depth, `name` and `description` are two different fields, and `last_seen_at`
 * and `fingerprint` are `null` for an identity the mesh holds no presence
 * record or approved key for. A fixture inventing any of those would let the
 * screen invent them too.
 */
const ALPHA = {
  id: "agt_alpha",
  name: "alpha",
  description: "Billing reconciler",
  channel: "websocket",
  type: "worker",
  created_at: "2026-08-01T10:00:00Z",
  last_seen_at: null,
  fingerprint: null,
};
const beta = () => ({
  id: "agt_beta",
  name: "beta",
  description: "Support triage",
  channel: "websocket",
  type: "relay",
  created_at: "2026-08-02T11:30:00Z",
  last_seen_at: twoHoursAgo(),
  fingerprint: "sha256:0f1e2d3c4b5a69788796a5b4c3d2e1f0",
});

describe("the four things the table can be saying", () => {
  it("says it is still asking, and claims nothing about the fleet yet", async () => {
    // The read never answers while everything else on the page has settled, so
    // this is the state an operator sees in front of a slow route rather than a
    // frame between two renders.
    readAgents = () => new Promise<Response>(() => {});
    await mount();

    expect(status()).toContain(LOADING);
    // Each of these is a claim about a server that has not spoken yet, and the
    // first is the one this console keeps drawing here.
    expect(status()).not.toContain(EMPTY);
    expect(status()).not.toContain(UNREACHABLE);
    expect(status()).not.toContain(REFUSED);
    expect(rows()).toHaveLength(0);
  });

  it("says the account may not read the fleet when the server refused", async () => {
    readAgents = () => json(403, { error: "not allowed", capability: PROVISION });
    await mount();

    // The server answered. Reporting that as "the server did not answer" sends
    // an operator to check a network that is fine, for a permission they simply
    // do not hold — measured on this console with a member session.
    expect(status()).toContain(`${REFUSED} (${PROVISION}).`);
    expect(status()).not.toContain(UNREACHABLE);
    expect(status()).not.toContain(EMPTY);
    // A panel that never leaves the loading state is a third wrong sentence:
    // the read is over, and the operator is watching a spinner for an answer
    // that already arrived.
    expect(status()).not.toContain(LOADING);
  });

  it("does not name a capability the refusal did not name", async () => {
    // A refusal carrying no `capability` field. Reaching for a name the screen
    // remembers would put a guess in front of the operator: the route's
    // requirement may have moved, and the one thing this screen knows is that
    // it was refused.
    readAgents = () => json(403, { error: "not allowed" });
    await mount();

    expect(status()).toContain(`${REFUSED}.`);
    expect(status()).not.toContain(PROVISION);
    expect(status()).not.toContain(TEARDOWN_CAP);
    expect(status()).not.toContain(UNREACHABLE);
    expect(status()).not.toContain(EMPTY);
  });

  it("says the server never answered when nothing answered it", async () => {
    readAgents = () => { throw new TypeError("Failed to fetch"); };
    await mount();

    expect(status()).toContain(UNREACHABLE);
    expect(status()).not.toContain(REFUSED);
    expect(status()).not.toContain(EMPTY);
    // Only this route failed: the session read and the bell's queue both
    // answered, so the sentence is about the agent route rather than about a
    // backend that is down. Without this the fixture proves nothing about
    // which request the screen is reporting on.
    expect(calls.map((c) => c.url)).toContain(ME);
    expect(calls.map((c) => c.url)).toContain(BELL);
  });

  it("does not read a broken proxy as a refusal", async () => {
    // A `5xx` is the server failing, not the server saying no. This is the line
    // the "502 read as signed out" defect crossed elsewhere on this console.
    readAgents = () => json(502, { error: "bad gateway" });
    await mount();

    expect(status()).toContain(UNREACHABLE);
    expect(status()).not.toContain(REFUSED);
    expect(status()).not.toContain(EMPTY);
  });

  it("says nothing is registered only when the server said so", async () => {
    readAgents = () => json(200, { agents: [] });
    await mount();

    expect(status()).toContain(EMPTY);
    expect(status()).not.toContain(UNREACHABLE);
    expect(status()).not.toContain(REFUSED);
    expect(status()).not.toContain(LOADING);
  });

  it("reads the fleet route once, and no second agent-shaped route", async () => {
    readAgents = () => json(200, { agents: [ALPHA] });
    await mount();

    // One read of one route. A page that also asked a second agents-shaped
    // route would be drawing two answers into one table, and the teardown route
    // is not a read at all.
    expect(agentReads().map((c) => c.url)).toEqual([AGENTS]);
    expect(teardownWrites()).toHaveLength(0);
  });
});

describe("a row says only what the server sent", () => {
  it("puts each field in its own column and reports the two it was not given", async () => {
    readAgents = () => json(200, { agents: [ALPHA, beta()] });
    await mount();

    expect(rows()).toHaveLength(2);

    // Every value below is somewhere in the body whatever the mapping does, so
    // a body-wide `toContain` passes with two columns exchanged — and a row
    // showing one agent's fingerprint beside another agent's id is a row where
    // every word came from the server and the row is still untrue.
    const alpha = cellsOf(rowFor(ALPHA.id));
    expect(alpha[0]).toBe(`${ALPHA.description}${ALPHA.id}`);
    expect(alpha[1]).toBe(ALPHA.type);

    const found = beta();
    const other = cellsOf(rowFor(found.id));
    expect(other[0]).toBe(`${found.description}${found.id}`);
    expect(other[1]).toBe(found.type);
    expect(other[3]).toContain(found.fingerprint);

    // `GET /api/v1/agents` carries no queue depth for anybody, so this cell is
    // the same absence on a row that is otherwise fully populated. `0` is what
    // it used to say, and zero backlog is the answer an operator hopes for.
    expect(alpha[4]).toBe(NOT_REPORTED);
    expect(other[4]).toBe(NOT_REPORTED);
    expect(other[4]).not.toContain("0");
    expect(screen.getAllByTestId("inbox-unknown")).toHaveLength(2);
  });

  it("calls no presence record no presence record, rather than offline", async () => {
    readAgents = () => json(200, { agents: [ALPHA, beta()] });
    await mount();

    const unseen = rowFor(ALPHA.id);
    const seen = rowFor(beta().id);

    // SPEC § 9.1: `last_seen_at: null` means the mesh holds no presence record,
    // and whether silence means inactive is an operating policy this screen is
    // not entitled to decide. The cell is compared whole rather than searched,
    // because any status word added beside the sentence is exactly the
    // judgement being guarded against.
    expect(cellsOf(unseen)[2]).toBe(NEVER_SEEN);
    expect(unseen.querySelector('[data-testid="never-seen"]')).not.toBe(null);
    expect(unseen.querySelector('[data-testid="last-seen"]')).toBe(null);

    // The other row was measured, and says how long ago in the operator's own
    // language. Borrowing this row's time for the one above would make an
    // identity nobody has ever seen look like one seen this afternoon.
    expect(cellsOf(seen)[2]).toBe(`2${HOUR} ${AGO}`);
    expect(seen.querySelector('[data-testid="last-seen"]')).not.toBe(null);
    expect(seen.querySelector('[data-testid="never-seen"]')).toBe(null);
    expect(cellsOf(unseen)[2]).not.toBe(cellsOf(seen)[2]);
  });

  it("shows an absent fingerprint as absent, and not as a constant every agent matches", async () => {
    readAgents = () => json(200, { agents: [ALPHA, beta()] });
    await mount();

    const unkeyed = cellsOf(rowFor(ALPHA.id));
    const keyed = cellsOf(rowFor(beta().id));

    // A fingerprint is what an operator compares by eye to decide an identity
    // is who it claims to be. The old default was one literal for every row, so
    // a real mismatch was invisible; whatever stands here for "the server sent
    // none" may not be mistakable for a key, and above all may not equal the
    // key on the row beside it.
    expect(unkeyed[3]).toBe(FP_ABSENT);
    expect(unkeyed[3]).not.toContain("sha256:");
    expect(unkeyed[3]).not.toBe(keyed[3]);
    expect(rowFor(ALPHA.id).querySelector('[data-testid="fingerprint-absent"]')).not.toBe(null);
    expect(rowFor(beta().id).querySelector('[data-testid="fingerprint-absent"]')).toBe(null);
  });

  it("keeps the two rows' own answers apart when only one of them was measured", async () => {
    // The reverse fixture of the pair above: the seen agent has no key and the
    // unseen one does. A mapping that read either field off the wrong row — or
    // off the first row for everybody — passes the tests above, where the
    // populated row is always the same one.
    const swapped = [
      { ...ALPHA, last_seen_at: twoHoursAgo(), fingerprint: null },
      { ...beta(), last_seen_at: null, fingerprint: "sha256:99aabbccddeeff0011223344556677" },
    ];
    readAgents = () => json(200, { agents: swapped });
    await mount();

    expect(cellsOf(rowFor(ALPHA.id))[2]).toBe(`2${HOUR} ${AGO}`);
    expect(cellsOf(rowFor(ALPHA.id))[3]).toBe(FP_ABSENT);
    expect(cellsOf(rowFor(beta().id))[2]).toBe(NEVER_SEEN);
    expect(cellsOf(rowFor(beta().id))[3]).toContain("99aabbccddeeff0011223344556677");
  });
});

describe("teardown is offered only where the server granted it", () => {
  it("draws no teardown control for a session holding nothing", async () => {
    held = [];
    readAgents = () => json(200, { agents: [ALPHA] });
    await mount();

    // The row is on screen — so the button is missing because of the
    // capability, not because the table is empty — and the read-only control
    // beside it is still offered.
    expect(rows()).toHaveLength(1);
    expect(cellsOf(rowFor(ALPHA.id))[5]).toContain(PLAYGROUND);
    // Walked with a member holding nothing: the button was there, the modal
    // opened, the typed confirmation was accepted, and the server refused at
    // the last step — a person walked all the way through an irreversible flow
    // that could never have worked.
    expect(screen.queryByTestId(`teardown-${ALPHA.id}`)).toBe(null);
    expect(buttonSaying(TEARDOWN_BTN)).toBe(undefined);
  });

  it("does not open teardown to a session holding some other capability", async () => {
    held = [PROVISION];
    readAgents = () => json(200, { agents: [ALPHA] });
    await mount();

    // Creating an identity and destroying one are different grants. A screen
    // asking "does this session hold anything" rather than "does it hold this"
    // passes the test above and fails here.
    expect(rows()).toHaveLength(1);
    expect(screen.queryByTestId(`teardown-${ALPHA.id}`)).toBe(null);
  });

  it("offers it to the session the server gave `agent.teardown`", async () => {
    held = [TEARDOWN_CAP];
    readAgents = () => json(200, { agents: [ALPHA] });
    await mount();

    // The control the two absences above are measured against: without it, a
    // page that renders no teardown button under any circumstances reads
    // exactly like one that gates it correctly.
    expect(screen.queryByTestId(`teardown-${ALPHA.id}`)).not.toBe(null);
    expect(buttonSaying(TEARDOWN_BTN)).not.toBe(undefined);
  });
});

describe("what an irreversible teardown destroys", () => {
  const openTeardownFor = (identity: string) => {
    fireEvent.click(screen.getByTestId(`teardown-${identity}`));
  };
  const typeConfirmation = (text: string) => {
    fireEvent.change(confirmField(), { target: { value: text } });
  };

  it("names the row the operator clicked, and no other", async () => {
    readAgents = () => json(200, { agents: [ALPHA, beta()] });
    await mount();
    openTeardownFor(beta().id);

    // The dialog is the last thing an operator reads before an identity stops
    // existing. A dialog describing the neighbouring row is a destruction of
    // the wrong agent that looked confirmed.
    expect(dialogText()).toContain(beta().id);
    expect(dialogText()).toContain(beta().description);
    expect(dialogText()).not.toContain(ALPHA.id);
  });

  it("arms the confirmation with that identity and refuses another one", async () => {
    readAgents = () => json(200, { agents: [ALPHA, beta()] });
    await mount();
    openTeardownFor(beta().id);

    // Nothing typed, and the control clicked anyway: the point of a typed
    // confirmation is that a click alone cannot destroy an identity.
    expect(confirmButton().disabled).toBe(true);
    fireEvent.click(confirmButton());
    await settle();
    expect(teardownWrites()).toHaveLength(0);

    // The other row's identity — a real name, correctly spelled, and the wrong
    // one. A confirmation that accepts any non-empty text is this flow's only
    // guard, and it would be answering yes to a question the operator never
    // read.
    typeConfirmation(ALPHA.id);
    expect(confirmButton().disabled).toBe(true);
    fireEvent.click(confirmButton());
    await settle();
    expect(teardownWrites()).toHaveLength(0);

    typeConfirmation(beta().id);
    expect(confirmButton().disabled).toBe(false);
  });

  it("sends the destroy to the identity that was confirmed", async () => {
    readAgents = () => json(200, { agents: [ALPHA, beta()] });
    await mount();
    openTeardownFor(beta().id);
    typeConfirmation(beta().id);
    fireEvent.click(confirmButton());
    await settle();

    const writes = teardownWrites();
    expect(writes).toHaveLength(1);
    // The identity is in the path, so a mapping that reached for the wrong
    // field of the row would destroy something with a real name. There is no
    // undo and the name can never be registered again.
    expect(writes[0]?.url).toBe(`${TEARDOWN_PATH}${beta().id}`);
    expect(writes[0]?.init?.method).toBe("DELETE");
  });

  it("re-reads the fleet and reports the identity it destroyed", async () => {
    let reads = 0;
    readAgents = () => (reads++ === 0
      ? json(200, { agents: [ALPHA, beta()] })
      : json(200, { agents: [ALPHA] }));
    await mount();
    openTeardownFor(beta().id);
    typeConfirmation(beta().id);
    fireEvent.click(confirmButton());
    await settle();

    // A list left as it was after a teardown shows an identity that no longer
    // exists, and the operator's next action is taken against it.
    expect(agentReads()).toHaveLength(2);
    expect(rows()).toHaveLength(1);
    expect(cellsOf(rowFor(ALPHA.id))[0]).toContain(ALPHA.id);
    expect(toast()).toContain(TORN_DOWN);
    expect(toast()).toContain(beta().id);
    expect(toast()).not.toContain(TEARDOWN_FAILED);
    // The dialog closed on the way through; leaving it open over a fresh list
    // invites the same confirmation being submitted twice.
    expect(dialog()).toBe(null);
  });

  it("does not call a refused teardown a teardown", async () => {
    readAgents = () => json(200, { agents: [ALPHA, beta()] });
    destroyAgent = () => json(403, { error: "not allowed", capability: TEARDOWN_CAP });
    await mount();
    openTeardownFor(beta().id);
    typeConfirmation(beta().id);
    fireEvent.click(confirmButton());
    await settle();

    // `SC-WRITE-10` elsewhere on this console: the state update sat below the
    // `try`, so it ran on every path and the screen reported a write the server
    // had blocked. Here that reads as an identity destroyed that is still
    // registered — and the operator stops looking at it.
    expect(teardownWrites()).toHaveLength(1);
    expect(toast()).not.toContain(TORN_DOWN);
    expect(toast()).toContain(TEARDOWN_FAILED);
    expect(rows()).toHaveLength(2);
    expect(cellsOf(rowFor(beta().id))[0]).toContain(beta().id);
  });

  it("does not call a teardown that never reached the server a teardown", async () => {
    readAgents = () => json(200, { agents: [ALPHA, beta()] });
    destroyAgent = () => { throw new TypeError("Failed to fetch"); };
    await mount();
    openTeardownFor(beta().id);
    typeConfirmation(beta().id);
    fireEvent.click(confirmButton());
    await settle();

    expect(teardownWrites()).toHaveLength(1);
    expect(toast()).not.toContain(TORN_DOWN);
    expect(toast()).toContain(TEARDOWN_FAILED);
    expect(rows()).toHaveLength(2);
  });

  it("stops showing a fleet the server has stopped answering for", async () => {
    // Every failed-read state above is entered from an empty table, where "no
    // rows" is also what the component starts as — so none of them can tell a
    // screen that cleared the list from one that never had it. Here the rows
    // are really on screen first, and the re-read after the teardown is
    // refused.
    let reads = 0;
    readAgents = () => (reads++ === 0
      ? json(200, { agents: [ALPHA, beta()] })
      : json(403, { error: "not allowed", capability: PROVISION }));
    await mount();
    expect(rows()).toHaveLength(2);

    openTeardownFor(beta().id);
    typeConfirmation(beta().id);
    fireEvent.click(confirmButton());
    await settle();

    // Rows left standing under a failed re-read are a list an operator reads as
    // current: one of these identities was just destroyed, and the screen no
    // longer knows anything about the rest.
    expect(rows()).toHaveLength(0);
    expect(status()).toContain(`${REFUSED} (${PROVISION}).`);
    expect(status()).not.toContain(EMPTY);
    expect(status()).not.toContain(UNREACHABLE);
  });
});
