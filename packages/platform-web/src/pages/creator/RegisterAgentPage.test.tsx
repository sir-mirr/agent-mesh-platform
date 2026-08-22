/**
 * What this screen says about the pending-key queue, and where the code it
 * hands an operator came from.
 *
 * Two separate claims live on this page, and this console has collapsed both
 * before.
 *
 * The queue read has four answers — *still asking*, *the server refused*,
 * *nothing answered*, *the server said nothing is waiting* — and the recurring
 * defect is one sentence drawn for all four: "no agent is waiting to be
 * approved", printed about a backend that never replied. An operator reading
 * that closes the page. The page decides between them from `failureKind` and
 * `refusedCapability` on the thrown `ApiError` — what the server *did*, not how
 * it worded it — so a `502` is not a refusal and a `403` is not an outage.
 * Every state below is therefore asserted twice: the sentence it draws, and the
 * sentences it must not.
 *
 * The generator's claim is provenance. The code on screen is the one
 * `POST /api/v1/admin/pairing-codes` minted; a code the browser invented looks
 * exactly like a real one and is redeemable nowhere, so what is rendered is
 * compared against what the stubbed route answered. (The modal this page opens
 * does mint its own — that is its own file's subject, and it is not exercised
 * here beyond the one decision the page itself owns.)
 *
 * ## What is deliberately not asserted
 *
 * Two things on this page are wrong today, and a green assertion over either of
 * them would pin the defect in place rather than record it. They are reported
 * rather than tested, and each belongs to somebody's fix:
 *
 * - the failure toast on the generator prints `err.message` raw, so a refusal
 *   and an outage arrive as one sentence — and an outage arrives as the
 *   browser's own `Failed to fetch`. The queue on the same screen splits them
 *   with `failureKind`; this half never started asking.
 * - the issued panel reads `selectedTtl`, the value that was *asked for*, while
 *   the server's granted `ttl_seconds` is stored in state nothing renders. A
 *   clamped lifetime is displayed as the requested one.
 *
 * `common.loading` and `table.loading` are the same word in English, so the
 * loading assertions below name both places rather than the sentence alone.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Registered once for the process and never unregistered: bun runs every test
// file's top level before any test, so a register/unregister pair would swap
// the document out from under whichever file is still using it.
if (!(globalThis as { document?: unknown }).document) GlobalRegistrator.register();

// `await import`, never a static import: a static one is hoisted above the
// registration and would load React's DOM entry into a process with no document.
const { render, screen, cleanup, fireEvent, act } = await import("@testing-library/react");
// The real router. A stubbed `useLocation` is global to the process and broke a
// neighbouring file's assertions when it leaked out of the file that installed it.
const { MemoryRouter } = await import("react-router-dom");
const { I18nProvider, DICTIONARY } = await import("@/contexts/I18nContext.tsx");
const { CAPABILITY } = await import("@/types/auth.ts");
const { RegisterAgentPage } = await import("./RegisterAgentPage.tsx");

const KEYS_PENDING = "/api/v1/admin/keys/pending";
const KEYS_APPROVE = "/api/v1/admin/keys/approve";
const KEYS_DENY = "/api/v1/admin/keys/deny";
const PAIRING_CODES = "/api/v1/admin/pairing-codes";
const REDEEM = "/api/v1/pairing-codes/redeem";
const LANG_KEY = "agent_mesh_lang";

/** The English dictionary's word, because the fallbacks compiled in are Korean. */
const en = (key: string) => DICTIONARY.en[key]!;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const realFetch = globalThis.fetch;
/** bun:test has no global stubber, so the original goes back by hand below. */
const stub = (fn: unknown) => { globalThis.fetch = fn as typeof globalThis.fetch; };

type Reply = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;
const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
/**
 * **Everything not answered on purpose gets no answer at all.**
 *
 * Answering per-URL is what tells a refusal on one panel from the backend being
 * down; a default of `{}` would let a screen that asked the wrong route look
 * healthy, which is exactly the mistake the queue assertions are about.
 */
let reply: Reply = () => { throw new TypeError("Failed to fetch"); };

beforeEach(() => {
  calls.length = 0;
  reply = () => { throw new TypeError("Failed to fetch"); };
  stub(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return await reply(String(input), init);
  });
  // The provider restores a saved language, and every word compared below is
  // the English dictionary's. Another file in this process switching to Korean
  // would otherwise decide what this file asserts against.
  try { localStorage.removeItem(LANG_KEY); } catch { /* no storage, no saved language */ }
});

// happy-dom's `localStorage` belongs to the process rather than to this file,
// and a forgotten `fetch` restore poisons every file that runs after this one.
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  try { localStorage.removeItem(LANG_KEY); } catch { /* nothing to take back out */ }
});
afterAll(() => {
  globalThis.fetch = realFetch;
  try { localStorage.removeItem(LANG_KEY); } catch { /* nothing to take back out */ }
});

/** The pending-key queue answers `body`; nothing else answers at all. */
const queueAnswers = (body: unknown, status = 200) => {
  reply = (url) => {
    if (url.endsWith(KEYS_PENDING)) return json(status, body);
    throw new TypeError("Failed to fetch");
  };
};

/** The queue has been asked and has not answered: the window at mount. */
const queueStillOut = () => {
  reply = () => new Promise<Response>(() => {});
};

const settle = async () => {
  // The mount read resolves over several microtasks (fetch, then `.json()`,
  // then the `.then`/`.finally` pair), so a bare `await act(async () => {})`
  // has not always drained them.
  await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
};

const mount = async () => {
  render(
    <MemoryRouter initialEntries={["/creator/register"]}>
      <I18nProvider>
        <RegisterAgentPage />
      </I18nProvider>
    </MemoryRouter>,
  );
  await settle();
};

/**
 * The heading over the queue, count or status in brackets included.
 *
 * Read as its own node rather than out of `document.body.textContent`: the bell
 * this page mounts reads the same route and draws its own verdict, so a
 * body-wide `toContain` would pass on the bell's sentence while the table said
 * something else.
 */
const queueHeading = (): string => {
  const heading = [...document.querySelectorAll("h3")]
    .find((el) => (el.textContent ?? "").includes(en("reg.queue.title")));
  if (!heading) throw new Error("the queue heading is gone");
  return heading.textContent ?? "";
};

/** The one table on this screen is the pending-key queue's. */
const queueTable = (): HTMLElement => {
  const table = document.querySelector("table");
  const root = table?.parentElement;
  if (!root) throw new Error("the pending queue table is gone");
  return root as HTMLElement;
};

/**
 * The line the table draws in place of rows — loading, error or empty — or `""`
 * when it has rows. `DataTable` renders exactly one of the three, so this is
 * where all four states are distinguishable from each other.
 */
const queueNotice = (): string =>
  [...queueTable().children].find((el) => el.tagName === "DIV")?.textContent ?? "";

const queueRows = (): HTMLElement[] => [...queueTable().querySelectorAll("tbody tr")] as HTMLElement[];

/** identity, group, fingerprint, status, actions — in the order the page declares them. */
const cellsOf = (row: HTMLElement): string[] => [...row.querySelectorAll("td")].map((td) => td.textContent ?? "");

/**
 * The row whose *identity* cell holds this value.
 *
 * Found by an exact `<code>` match rather than by a substring of the row: a
 * value lands somewhere for any mapping, including one that has put it in the
 * wrong column, and a row headed by a fingerprint where an identity belongs is
 * the defect these assertions exist for.
 */
const rowFor = (identity: string): HTMLElement => {
  const row = queueRows().find((r) => [...r.querySelectorAll("code")].some((c) => c.textContent === identity));
  if (!row) throw new Error(`no row in the queue renders ${identity} as an identity`);
  return row;
};

const buttonSaying = (word: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(word));

const identityField = (): HTMLInputElement => screen.getByLabelText(en("reg.field.identity")) as HTMLInputElement;

const ttlSelect = (): HTMLSelectElement => {
  const select = document.querySelector("select");
  if (!select) throw new Error("the ttl control is gone");
  return select as HTMLSelectElement;
};

/** Fill the form and submit it. `submit` rather than a click on the button:
 *  the guard under test is the page's own `if (!targetIdentity) return`, and
 *  happy-dom's form validation would otherwise decide that case instead. */
const issueCode = async (identity: string, ttlSeconds?: number) => {
  fireEvent.change(identityField(), { target: { value: identity } });
  if (ttlSeconds !== undefined) fireEvent.change(ttlSelect(), { target: { value: String(ttlSeconds) } });
  const form = identityField().closest("form");
  if (!form) throw new Error("the generator form is gone");
  fireEvent.submit(form);
  await settle();
};

/**
 * The panel that appears once a code has been issued, or `null`.
 *
 * Its label is a leaf, and the code sits in the node after it — so "what is in
 * the code slot" is a different question from "is this string somewhere on the
 * page", and only the first one can catch a code drawn from the wrong source.
 */
const issuedPanel = (): HTMLElement | null => {
  const label = [...document.querySelectorAll("div")]
    .find((d) => d.children.length === 0 && (d.textContent ?? "").startsWith(en("reg.issued.label")));
  return (label?.parentElement as HTMLElement | undefined) ?? null;
};

const issuedCode = (): string | null => {
  const panel = issuedPanel();
  if (!panel) return null;
  return panel.children[1]?.textContent ?? null;
};

/** The `curl` line this page renders for the operator to run elsewhere. */
const curlLine = (): string => {
  const block = [...document.querySelectorAll("code")].find((c) => (c.textContent ?? "").includes(REDEEM));
  return block?.textContent ?? "";
};

const bodyText = (): string => document.body.textContent ?? "";

const PROPOSAL = { identity: "settlement-4", fingerprint: "sha256:a1b2c3d4e5", type: "worker" };
const OTHER = { identity: "ledger-2", fingerprint: "sha256:b7c8d9e0f1", type: "relay" };

describe("the four things the queue read can say", () => {
  it("says it is still asking, and does not answer for the server meanwhile", async () => {
    queueStillOut();
    await mount();
    // Loading is the one state where the page knows nothing. Drawing the empty
    // sentence here is the same lie as drawing it over an outage, one moment
    // earlier.
    expect(queueHeading()).toContain(`(${en("common.loading")})`);
    expect(queueNotice()).toContain(en("table.loading"));
    expect(queueNotice()).not.toContain(en("reg.queue.empty"));
    expect(queueNotice()).not.toContain(en("reg.queue.error"));
    expect(queueNotice()).not.toContain(en("common.refusedRead"));
    expect(queueRows().length).toBe(0);
    // A count is a claim about an answer nobody has received yet.
    expect(queueHeading()).not.toContain(`0 ${en("reg.queue.waiting")}`);
  });

  it("says the server refused, and repeats the name the server gave for it", async () => {
    // Deliberately **not** the name the old hardcoded copy carried. Nine
    // screens had the capability typed into their own sentence and were right
    // on the day they were written; a screen that repeats the refusal cannot go
    // stale, and only a name the copy would not have guessed tells the two
    // apart.
    queueAnswers({ error: "not allowed", capability: CAPABILITY.GROUP_MANAGE }, 403);
    await mount();
    expect(queueHeading()).toContain(`(${en("common.refused")})`);
    expect(queueNotice()).toContain(`${en("common.refusedRead")}.`);
    expect(queueNotice()).not.toContain(CAPABILITY.GROUP_MANAGE);
    expect(queueNotice()).not.toContain(CAPABILITY.KEY_APPROVE);
    // The server answered. Saying the network is down sends an operator to
    // check a connection over a permission they simply do not hold.
    expect(queueNotice()).not.toContain(en("reg.queue.error"));
    expect(queueNotice()).not.toContain(en("reg.queue.empty"));
    expect(queueHeading()).not.toContain(en("common.unreachable"));
    expect(queueHeading()).not.toContain(`0 ${en("reg.queue.waiting")}`);
  });

  it("invents no capability name when the refusal named none", async () => {
    queueAnswers({ error: "not allowed" }, 403);
    await mount();
    expect(queueHeading()).toContain(`(${en("common.refused")})`);
    // A guessed name in brackets reads exactly like one the server sent, and an
    // operator asked for the wrong grant is worse off than one told only that
    // they may not read this.
    expect(queueNotice()).toContain(`${en("common.refusedRead")}.`);
    expect(queueNotice()).not.toContain("(");
    expect(queueNotice()).not.toContain(CAPABILITY.KEY_APPROVE);
    expect(queueNotice()).not.toContain(CAPABILITY.GROUP_MANAGE);
  });

  it("says it could not ask when nothing answered, not that nobody is waiting", async () => {
    // Nothing is answered at all — offline, DNS, connection refused. This is
    // the defect the whole file is written against: `[]` in the `.catch` draws
    // a sentence about the server's answer when there was no answer, and the
    // screen is then indistinguishable from a quiet mesh.
    reply = () => { throw new TypeError("Failed to fetch"); };
    await mount();
    expect(queueHeading()).toContain(en("common.unreachable"));
    expect(queueNotice()).toContain(en("reg.queue.error"));
    expect(queueNotice()).not.toContain(en("reg.queue.empty"));
    expect(queueNotice()).not.toContain(en("common.refusedRead"));
    expect(queueHeading()).not.toContain(`0 ${en("reg.queue.waiting")}`);
    expect(queueHeading()).not.toContain(`(${en("common.refused")})`);
  });

  it("does not call a broken gateway a refusal", async () => {
    // A `5xx` is the server failing, not the server saying no. This is the line
    // a `502` crossed elsewhere in this console, where it was read as a
    // signed-out session and threw every operator to a login form.
    queueAnswers({ error: "bad gateway" }, 502);
    await mount();
    expect(queueHeading()).toContain(en("common.unreachable"));
    expect(queueNotice()).toContain(en("reg.queue.error"));
    expect(queueNotice()).not.toContain(en("common.refusedRead"));
    expect(queueHeading()).not.toContain(`(${en("common.refused")})`);
  });

  it("says the queue is empty only when the server said so", async () => {
    queueAnswers({ ok: true, keys: [] });
    await mount();
    // An answered-and-empty queue is the one state entitled to a count, and
    // that count is `0` rather than a `?` or a warning.
    expect(queueHeading()).toContain(`(0 ${en("reg.queue.waiting")})`);
    expect(queueNotice()).toContain(en("reg.queue.empty"));
    expect(queueNotice()).not.toContain(en("reg.queue.error"));
    expect(queueNotice()).not.toContain(en("common.refusedRead"));
    expect(queueNotice()).not.toContain(en("table.loading"));
  });
});

describe("what a row says about a proposal", () => {
  it("keeps identity, group and fingerprint each in its own column", async () => {
    queueAnswers({ ok: true, keys: [PROPOSAL] });
    await mount();
    const row = cellsOf(rowFor(PROPOSAL.identity));
    // Every value is somewhere in the row for any mapping, including one that
    // has exchanged two of them — and a fingerprint under a heading naming a
    // group is a row where every word is a word the server sent and the row
    // still says something untrue.
    expect(row[0]).toContain(PROPOSAL.identity);
    expect(row[1]).toBe(PROPOSAL.type);
    expect(row[2]).toBe(PROPOSAL.fingerprint);
    expect(row[3]).toContain(en("reg.status.pending"));
    expect(row[4]).toContain(en("reg.action.pair"));
  });

  it("draws nothing where a proposal carried no fingerprint", async () => {
    queueAnswers({ ok: true, keys: [PROPOSAL, { identity: "no-key-yet", fingerprint: null }] });
    await mount();
    // A fingerprint is the value an operator compares to decide an identity is
    // who it claims to be. A placeholder there makes every proposal match, and
    // this front end shipped a constant one — under this exact heading — for as
    // long as the column existed. Absent has to look absent.
    expect(cellsOf(rowFor("no-key-yet"))[2]).toBe("");
    // Both rows are still drawn, so the blank above is an empty cell rather
    // than a row that went missing.
    expect(cellsOf(rowFor(PROPOSAL.identity))[2]).toBe(PROPOSAL.fingerprint);
    expect(queueRows().length).toBe(2);
  });

  it("does not dress an untyped proposal as one the server classified", async () => {
    queueAnswers({ ok: true, keys: [PROPOSAL, { identity: "unclassified-1", fingerprint: "sha256:c9d8e7f6a5" }] });
    await mount();
    const declared = cellsOf(rowFor(PROPOSAL.identity))[1];
    const unstated = cellsOf(rowFor("unclassified-1"))[1];
    expect(declared).toBe(PROPOSAL.type);
    // The server named no type for the second row, so whatever stands there is
    // the page's own word — and the one thing it may not be is a word the
    // server could have sent, which would make an unclassified agent read
    // exactly like a classified one. Pinning the literal would only pin the
    // placeholder in place; being mistakable for a declaration is the defect.
    expect(unstated).not.toBe(declared);
    expect(unstated).not.toContain(PROPOSAL.type);
  });
});

describe("the count beside the heading", () => {
  it("counts what is still waiting rather than how many rows there are", async () => {
    reply = (url) => {
      if (url.endsWith(KEYS_PENDING)) return json(200, { ok: true, keys: [PROPOSAL, OTHER] });
      if (url.endsWith(KEYS_APPROVE)) return json(200, { ok: true });
      throw new TypeError("Failed to fetch");
    };
    await mount();
    expect(queueHeading()).toContain(`(2 ${en("reg.queue.waiting")})`);

    // Two rows that are both pending cannot tell the count apart from the
    // length of the list, and "still waiting" is the whole claim in the name.
    // So one is decided. A decided row stays on screen — that is how the
    // operator sees what they just did — and counting it would leave a queue
    // reported as backed up with nothing waiting in it.
    const pair = rowFor(PROPOSAL.identity).querySelector("button");
    fireEvent.click(pair!);
    fireEvent.click(buttonSaying(en("pairing.modal.approveAndBind"))!);
    await settle();

    // Named by fingerprint: an approval that reaches the server carrying the
    // wrong key admits the wrong agent, and both rows are pending so nothing
    // else on screen would look different.
    const write = calls.find((c) => c.url.endsWith(KEYS_APPROVE));
    expect(JSON.parse(String(write?.init?.body ?? "{}")).fingerprint).toBe(PROPOSAL.fingerprint);

    expect(queueHeading()).toContain(`(1 ${en("reg.queue.waiting")})`);
    expect(cellsOf(rowFor(PROPOSAL.identity))[3]).toContain(en("reg.status.approved"));
    expect(cellsOf(rowFor(PROPOSAL.identity))[4]).toContain(en("reg.action.done"));
    // The untouched row is untouched, so the count fell by a decision rather
    // than by a row disappearing.
    expect(cellsOf(rowFor(OTHER.identity))[3]).toContain(en("reg.status.pending"));
  });

  it("marks only the proposal whose fingerprint the server accepted for denial", async () => {
    reply = (url) => {
      if (url.endsWith(KEYS_PENDING)) return json(200, { ok: true, keys: [PROPOSAL, OTHER] });
      if (url.endsWith(KEYS_DENY)) return json(200, { ok: true });
      throw new TypeError("Failed to fetch");
    };
    await mount();

    fireEvent.click(rowFor(PROPOSAL.identity).querySelector("button")!);
    fireEvent.click(buttonSaying(en("common.reject"))!);
    await settle();

    const write = calls.find((c) => c.url.endsWith(KEYS_DENY));
    expect(JSON.parse(String(write?.init?.body ?? "{}"))).toEqual({
      fingerprint: PROPOSAL.fingerprint,
      reason: "Rejected by operator",
    });
    const denied = cellsOf(rowFor(PROPOSAL.identity));
    if (!denied[3] || denied[3].includes(en("reg.status.pending")) || denied[3].includes(en("reg.status.approved"))) {
      throw new Error(`the denied proposal did not move to its rejected status cell: ${JSON.stringify(denied)}`);
    }
    expect(denied[4]).toContain(en("reg.action.done"));
    expect(cellsOf(rowFor(OTHER.identity))[3]).toContain(en("reg.status.pending"));
    expect(queueHeading()).toContain(`(1 ${en("reg.queue.waiting")})`);
  });

  it("keeps a refused approval pending and names the failed write in its own place", async () => {
    reply = (url) => {
      if (url.endsWith(KEYS_PENDING)) return json(200, { ok: true, keys: [PROPOSAL] });
      if (url.endsWith(KEYS_APPROVE)) return json(403, { error: "not allowed", capability: CAPABILITY.KEY_APPROVE });
      throw new TypeError("Failed to fetch");
    };
    await mount();

    fireEvent.click(rowFor(PROPOSAL.identity).querySelector("button")!);
    fireEvent.click(buttonSaying(en("pairing.modal.approveAndBind"))!);
    await settle();

    const failed = screen.queryByTestId("registration-approve-failed");
    if (!failed) throw new Error("the refused approval had no failure place");
    expect(failed.textContent).toContain(en("reg.toast.approveFailed"));
    expect(failed.textContent).toContain(PROPOSAL.identity);
    expect(failed.textContent).toContain("not allowed");
    expect(screen.queryByTestId("registration-approved")).toBeNull();
    expect(bodyText()).not.toContain(en("reg.toast.approved"));
    expect(cellsOf(rowFor(PROPOSAL.identity))[3]).toContain(en("reg.status.pending"));
    expect(cellsOf(rowFor(PROPOSAL.identity))[4]).toContain(en("reg.action.pair"));
    expect(queueHeading()).toContain(`(1 ${en("reg.queue.waiting")})`);
  });

  it("keeps an unreachable denial pending and names the failed write in its own place", async () => {
    queueAnswers({ ok: true, keys: [PROPOSAL] });
    await mount();

    fireEvent.click(rowFor(PROPOSAL.identity).querySelector("button")!);
    fireEvent.click(buttonSaying(en("common.reject"))!);
    await settle();

    const failed = screen.queryByTestId("registration-deny-failed");
    if (!failed) throw new Error("the unreachable denial had no failure place");
    expect(failed.textContent).toContain(en("reg.toast.denyFailed"));
    expect(failed.textContent).toContain(PROPOSAL.identity);
    expect(failed.textContent).toContain("Failed to fetch");
    expect(screen.queryByTestId("registration-denied")).toBeNull();
    expect(bodyText()).not.toContain(en("reg.toast.denied"));
    expect(cellsOf(rowFor(PROPOSAL.identity))[3]).toContain(en("reg.status.pending"));
    expect(cellsOf(rowFor(PROPOSAL.identity))[4]).toContain(en("reg.action.pair"));
    expect(queueHeading()).toContain(`(1 ${en("reg.queue.waiting")})`);
  });
});

describe("issuing a pairing code", () => {
  const ISSUED = { ok: true, code: "PAIR-7788-LEDGER", identity: "agt-ledger-9", expires_at: "2026-01-01T00:15:00Z", ttl_seconds: 900 };

  /** The queue answers empty so the page is quiet; the generator route answers `body`. */
  const generatorAnswers = (body: unknown, status = 200) => {
    reply = (url) => {
      if (url.endsWith(KEYS_PENDING)) return json(200, { ok: true, keys: [] });
      if (url.endsWith(PAIRING_CODES)) return json(status, body);
      throw new TypeError("Failed to fetch");
    };
  };

  it("asks the server, naming the identity typed and the lifetime chosen", async () => {
    generatorAnswers(ISSUED);
    await mount();
    await issueCode(ISSUED.identity, 900);

    const posts = calls.filter((c) => c.url.endsWith(PAIRING_CODES));
    expect(posts.length).toBe(1);
    expect(posts[0]?.init?.method).toBe("POST");
    // The lifetime is the operator's choice and the only thing that bounds how
    // long a code stays redeemable. A request that always sent the default
    // would still render a code, and nothing on screen would say the code
    // expires four times sooner than the one that was asked for.
    expect(JSON.parse(String(posts[0]?.init?.body ?? "{}")))
      .toEqual({ identity: ISSUED.identity, ttl_seconds: 900 });
  });

  it("shows the code the server minted, in the panel and in the command", async () => {
    generatorAnswers(ISSUED);
    await mount();
    await issueCode(ISSUED.identity, 900);
    // A code the browser made up looks exactly like a real one and redeems
    // nowhere; the operator finds out at the far end, on another machine.
    expect(issuedCode()).toBe(ISSUED.code);
    // The `curl` line is what actually gets pasted into the agent's terminal,
    // so a stale example there is the same failure one copy later.
    expect(curlLine()).toContain(ISSUED.code);
    expect(curlLine()).toContain(REDEEM);
    expect(bodyText()).toContain(en("reg.toast.issued"));

    const notice = screen.getByTestId("pairing-code-issued");
    const close = notice.querySelector("button");
    if (!close) throw new Error("the issued-code notice has no close control");
    fireEvent.click(close);
    expect(screen.queryByTestId("pairing-code-issued")).toBeNull();
    // Dismissing the transient result does not revoke the code the server minted.
    expect(issuedCode()).toBe(ISSUED.code);
  });

  it("asks nothing at all when no identity was typed", async () => {
    generatorAnswers(ISSUED);
    await mount();
    const form = identityField().closest("form");
    fireEvent.submit(form!);
    await settle();
    // A code minted against an empty identity binds nothing, and the server
    // would be the one to say so on a screen that had already shown a code.
    expect(calls.filter((c) => c.url.endsWith(PAIRING_CODES)).length).toBe(0);
    expect(issuedCode()).toBe(null);
  });

  it("takes the last code down when the next request is refused", async () => {
    generatorAnswers(ISSUED);
    await mount();
    await issueCode(ISSUED.identity, 900);
    expect(issuedCode()).toBe(ISSUED.code);

    // The refusal arrives after a code is already on screen. A code left
    // standing here is the worst reading available: it belongs to the previous
    // identity, and the operator is looking at a screen that just failed.
    reply = (url) => {
      if (url.endsWith(KEYS_PENDING)) return json(200, { ok: true, keys: [] });
      if (url.endsWith(PAIRING_CODES)) return json(403, { error: "not allowed", capability: CAPABILITY.AGENT_PROVISION });
      throw new TypeError("Failed to fetch");
    };
    await issueCode("agt-other-3", 300);

    expect(issuedCode()).toBe(null);
    expect(bodyText()).not.toContain(ISSUED.code);
    expect(curlLine()).not.toContain(ISSUED.code);
    expect(bodyText()).toContain(en("reg.toast.failed"));
  });

  it("shows no code when the request never reached the server", async () => {
    reply = (url) => {
      if (url.endsWith(KEYS_PENDING)) return json(200, { ok: true, keys: [] });
      throw new TypeError("Failed to fetch");
    };
    await mount();
    await issueCode("agt-offline-1", 300);
    // Nothing answered, so there is no code — and a page that had drawn one
    // anyway would have invented the one value on it that has to come from the
    // server.
    expect(issuedCode()).toBe(null);
    expect(bodyText()).toContain(en("reg.toast.failed"));
    expect(bodyText()).not.toContain(en("reg.toast.issued"));
  });

  it("copies the server's code rather than what is beside it", async () => {
    // happy-dom ships no writable clipboard, and the handler calls it
    // unguarded. Supplied by hand, like `fetch`, and taken back off the
    // instance afterwards so no other file inherits it.
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: (text: string) => { written.push(text); return Promise.resolve(); } },
    });
    try {
      generatorAnswers(ISSUED);
      await mount();
      await issueCode(ISSUED.identity, 900);

      fireEvent.click(buttonSaying(en("reg.copy"))!);
      // The copy button is how the code leaves this screen. Anything else on
      // the clipboard — the identity, the ttl, the label above it — fails at
      // the agent with a message about a code that was never issued.
      expect(written).toEqual([ISSUED.code]);
      expect(buttonSaying(en("reg.copied")) !== undefined).toBe(true);
    } finally {
      delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });
});
