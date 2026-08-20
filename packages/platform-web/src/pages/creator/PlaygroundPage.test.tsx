/**
 * What the playground says about the mesh, and what it says about a send.
 *
 * Two panels, two ways to lie.
 *
 * **The left panel reads the registry**, and the reading has four answers this
 * console has collapsed three times: *still asking*, *the server refused*, *the
 * server never answered*, and *the server answered and nothing is registered*.
 * The collapse always goes the same direction — "no agents are registered"
 * drawn over a backend that never replied, which an operator reads as a quiet
 * mesh rather than as a screen that failed. `api/client.ts` exists so the split
 * is read off the exception (`failureKind`, `refusedCapability`) instead of
 * guessed at, so each of the four is pinned here **together with the other
 * three it must not also say** — a panel showing the error sentence and the
 * empty sentence at once is the defect, and only a negative can see it.
 *
 * **The right panel is evidence.** A delivery receipt is the only thing on this
 * screen that came from the hub rather than from the person, and the module's
 * own comments record it being made of neither: every field once had a local
 * fallback behind `||`, the envelope was never unwrapped, so what a person saw
 * was their own selection, the browser's clock and a literal string where the
 * server's id belongs. A receipt made of the sender's inputs cannot disagree
 * with the sender, so it never reported anything. Every assertion about the
 * card below is therefore a value the request did **not** carry — a `from` the
 * picker did not choose, a `to` the route rewrote, a timestamp years away from
 * this run's clock.
 *
 * The other half of the same rule is the absence: a `201` with no `message`, a
 * refused send and a send that never left are three ways to have no receipt,
 * and none of them may be drawn as a delivery — nor as the panel's *idle*
 * prompt, which is what an `alert()` used to leave behind and reads as though
 * nothing had been tried at all.
 *
 * The providers are real. `mock.module` is global to the bun process and
 * outlives the file that installs it, so every context here is mounted for real
 * and `fetch` is answered per-URL instead — which is also the only way to tell
 * a refusal of *this* screen's route from a backend that is down, since
 * `/auth/me` and the bell inside `<Breadcrumbs>` keep answering while the agent
 * route fails.
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
const { CAPABILITY } = await import("@/types/auth.ts");
const { PlaygroundPage } = await import("./PlaygroundPage.tsx");

const ME = "/auth/me";
const AGENTS = "/api/v1/agents";
const MESSAGES = "/api/v1/messages";
/** The bell inside `<Breadcrumbs>`; it must keep answering while agents fails. */
const BELL = "/api/v1/admin/keys/pending";

/**
 * The name a refusal carries in the fixtures below.
 *
 * Taken from the contract rather than typed as a string: a capability this mesh
 * does not define is as wrong in a fixture as it is on a screen, because it
 * makes the test agree with a server that does not exist. Which name the
 * registry read will come to require is the route's business — today it carries
 * no capability guard at all — and what is pinned here is that the screen
 * repeats whatever § 11.3's refusal names and invents nothing, so the fixture
 * needs a real name and deliberately not a guess at this route's.
 */
const REFUSED_CAP = CAPABILITY.MAILBOX_READ_DEPTH;

const LOADING = DICTIONARY.en["play.loading"]!;
const EMPTY = DICTIONARY.en["play.empty"]!;
const UNREACHABLE = DICTIONARY.en["agents.error"]!;
const REFUSED = DICTIONARY.en["common.refusedRead"]!;
const NEVER_SEEN = DICTIONARY.en["agents.neverSeen"]!;
const AGO = DICTIONARY.en["agents.ago"]!;
const HOUR = DICTIONARY.en["agents.unit.hour"]!;
const NO_FINGERPRINT = DICTIONARY.en["play.noFingerprint"]!;
const KIND = DICTIONARY.en["dash.op.kind"]!;
const LAST_SEEN = DICTIONARY.en["play.lastSeen"]!;
const SEND_BTN = DICTIONARY.en["play.sendBtn"]!;
const AWAITING_SEND = DICTIONARY.en["play.emptyReceipt"]!;
const NO_RECEIPT_TITLE = DICTIONARY.en["play.noReceipt"]!;
const NO_RECEIPT_IN_201 = DICTIONARY.en["play.noReceiptIn201"]!;
const WHAT_WAS_SENT = DICTIONARY.en["play.dispatched"]!;
const RECEIPT_PENDING = DICTIONARY.en["receipt.pending"]!;
const RECEIPT_DELIVERED = DICTIONARY.en["receipt.delivered"]!;
const RECEIPT_FAILED = DICTIONARY.en["receipt.failed"]!;

/** The two dots a picker row can wear. Escaped so no editor can mangle them. */
const SEEN_DOT = "\u{1F7E2}";
const UNSEEN_DOT = "\u26AA";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const realFetch = globalThis.fetch;
/** bun:test has no global stubber, so the original goes back by hand — a
 *  forgotten restore poisons every file that runs after this one. */
const stub = (fn: unknown) => { globalThis.fetch = fn as typeof globalThis.fetch; };

type Reply = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;
const calls: Array<{ url: string; init: RequestInit | undefined }> = [];

/**
 * A registry row exactly as `GET /api/v1/agents` sends one.
 *
 * Every optional field defaults to `null` here on purpose: those are the ones
 * the route genuinely omits, and each of them used to be filled in on arrival.
 */
const row = (identity: string, over: Record<string, unknown> = {}) => ({
  identity,
  type: "worker",
  description: null,
  created_at: null,
  last_seen_at: null,
  fingerprint: null,
  ...over,
});

const LANE_A = row("lane-a", { description: "Support lane" });
const LANE_B = row("lane-b", { description: "Finance lane" });
const LANE_C = row("lane-c", { description: "Audit lane" });

/** What the route answers for a signed-in member on this source. */
const SESSION = {
  github_id: 9,
  github_login: "operator-1",
  role: "member",
  approved: true,
  tenant: "tenant_default",
  capabilities: [CAPABILITY.AGENT_PROVISION],
  created_at: "2026-01-01T00:00:00Z",
};

/**
 * The receipt the hub writes at the `201`.
 *
 * Deliberately disagreeing with the request in every field it can: `from` is
 * not the sender the picker offers, `to` is not the recipient that was posted,
 * and `ts` is years from this run's clock. A card built out of the caller's own
 * inputs would agree with the request instead, which is the defect, and a
 * fixture that agrees with the request cannot see it.
 */
const RECEIPT = {
  id: "msg_1620086400000_ab12cd34",
  from: "signed-in-operator",
  to: "lane-rewritten-by-the-route",
  ts: "2021-05-04T00:00:00.000Z",
  status: "pending" as const,
};

/** What `GET /api/v1/agents` does. */
let readAgents: Reply = () => json(200, { agents: [LANE_A, LANE_B] });
/** What `POST /api/v1/messages` does. */
let sendMessage: Reply = () => json(201, { ok: true, message: RECEIPT });

beforeEach(() => {
  calls.length = 0;
  readAgents = () => json(200, { agents: [LANE_A, LANE_B] });
  sendMessage = () => json(201, { ok: true, message: RECEIPT });
  // `AuthProvider` hydrates from storage and `I18nProvider` reads a saved
  // language out of it; happy-dom's storage belongs to the process, so a
  // leftover from another file would be a signed-in user or a second language.
  localStorage.clear();
  stub(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith(ME)) return json(200, SESSION);
    if (url.endsWith(BELL)) return json(200, { ok: true, keys: [] });
    if (url.endsWith(AGENTS)) return await readAgents(url, init);
    if (url.endsWith(MESSAGES)) return await sendMessage(url, init);
    return json(200, { ok: true });
  });
});

afterEach(() => { cleanup(); localStorage.clear(); globalThis.fetch = realFetch; });
// What this file wrote into process-wide storage comes back out for everyone
// else in the run, not just for the next test in here.
afterAll(() => { localStorage.clear(); globalThis.fetch = realFetch; });

const settle = async () => {
  // The mount read resolves over several microtasks (fetch, then `.json()`,
  // then the mapping and two `.then`s) and `/auth/me` writes state after its
  // own, so a bare `await act(async () => {})` is not enough to have drained
  // them.
  await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
};

const mount = async () => {
  // The real router, at the path this page is mounted at: `<Breadcrumbs>` reads
  // `useLocation`, and a stub of it leaks out of the file that installs it.
  render(
    <MemoryRouter initialEntries={["/creator/playground"]}>
      <I18nProvider>
        <AuthProvider>
          <PlaygroundPage />
        </AuthProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
  await settle();
};

const payloadField = (): HTMLTextAreaElement => {
  const el = document.querySelector("textarea");
  if (!el) throw new Error("the page drew no payload field");
  return el as HTMLTextAreaElement;
};

const formEl = (): HTMLFormElement => {
  const form = payloadField().closest("form");
  if (!form) throw new Error("the payload field is not inside a form");
  return form;
};

/** The dispatch panel: the form's own card, and nothing in the other column. */
const panelEl = (): HTMLElement => {
  const panel = formEl().parentElement;
  if (!panel) throw new Error("the form is not inside a panel");
  return panel;
};

/**
 * The one line the panel draws above the form — loading, refused, unreachable
 * or empty — or `""` when it draws none.
 *
 * Scoped to that panel on purpose, and read whole rather than searched: the
 * page's own subtitle and the breadcrumb bar are full of prose, and a body-wide
 * `toContain` would pass on words nowhere near the panel that failed. Reading
 * it whole is what lets the assertions be equalities, so a panel saying two of
 * the four things at once fails instead of passing on the one it was asked for.
 */
const statusLine = (): string => {
  const line = [...panelEl().children].slice(1).find((c) => c.tagName !== "FORM");
  return line?.textContent ?? "";
};

/** The receipt column — the grid's second cell, beside the dispatch panel. */
const receiptPanel = (): HTMLElement => {
  const grid = panelEl().parentElement;
  const column = grid?.children[1];
  if (!column) throw new Error("the page drew no receipt column");
  return column as HTMLElement;
};
const receiptText = (): string => receiptPanel().textContent ?? "";

const selectsIn = (): HTMLSelectElement[] =>
  [...panelEl().querySelectorAll("select")] as HTMLSelectElement[];
const senderSelect = (): HTMLSelectElement => selectsIn()[0]!;
const recipientSelect = (): HTMLSelectElement => selectsIn()[1]!;

const optionTexts = (sel: HTMLSelectElement): string[] =>
  [...sel.querySelectorAll("option")].map((o) => o.textContent ?? "");

/** The detail line under a picker: kind, last seen, fingerprint. `""` if none. */
const detailUnder = (sel: HTMLSelectElement): string =>
  sel.parentElement?.children[2]?.textContent ?? "";

const sendButton = (): HTMLButtonElement => {
  const button = [...document.querySelectorAll("button")]
    .find((b) => (b.textContent ?? "").includes(SEND_BTN));
  if (!button) throw new Error("the page drew no send control");
  return button as HTMLButtonElement;
};

const send = async () => {
  await act(async () => { fireEvent.click(sendButton()); });
  await settle();
};

const sends = () => calls.filter((c) => c.url.endsWith(MESSAGES));
const sentBody = (): Record<string, unknown> =>
  JSON.parse(String(sends()[sends().length - 1]!.init!.body));

/**
 * The receipt card's message id, or `null` when the panel draws no card.
 *
 * A value rather than the element: `expect(element).toBe(null)` serialises a
 * happy-dom node — and every global reachable from it — into the failure
 * output, which turned one red assertion here into a 48 MB report. Reading the
 * id is also the stronger question, since *which* receipt is on screen is the
 * thing a stale card gets wrong.
 */
const cardId = (): string | null =>
  screen.queryByTestId("receipt-card")?.getAttribute("data-message-id") ?? null;
const cardStatus = (): string | null =>
  screen.queryByTestId("receipt-card")?.getAttribute("data-status") ?? null;
const drawsCard = (): boolean => screen.queryByTestId("receipt-card") !== null;
const drawsNoReceipt = (): boolean => screen.queryByTestId("receipt-error") !== null;

describe("four readings of the registry, and only ever one of them", () => {
  it("says it is still asking, and does not answer for the route", async () => {
    // The window between mount and the first reply. "Nothing is registered"
    // here is a claim about an answer that has not arrived, and it is the one
    // an operator acts on — they go and register an agent that already exists.
    readAgents = () => new Promise<Response>(() => {});
    await mount();
    expect(statusLine()).toBe(LOADING);
    expect(statusLine()).not.toContain(EMPTY);
    expect(statusLine()).not.toContain(UNREACHABLE);
    expect(statusLine()).not.toContain(REFUSED);
  });

  it("repeats the capability the refusal named, rather than one of its own", async () => {
    readAgents = () => json(403, { error: "not allowed", capability: REFUSED_CAP });
    await mount();
    // Nine screens had the name typed into their own copy — right on the day
    // they were written and stale the moment a route's requirement moved.
    // § 11.3 sends it, so the screen quotes the answer it got.
    expect(statusLine()).toBe(`${REFUSED} (${REFUSED_CAP}).`);
    expect(statusLine()).not.toContain(UNREACHABLE);
    expect(statusLine()).not.toContain(EMPTY);
  });

  it("names no capability when the refusal named none", async () => {
    readAgents = () => json(403, { error: "not allowed" });
    await mount();
    // A refusal that carries no name leaves the screen with nothing to quote,
    // and the honest sentence is the shorter one. Filling the gap from memory
    // is the same invention as the constant fingerprint, in a sentence.
    expect(statusLine()).toBe(`${REFUSED}.`);
  });

  it("does not call a broken proxy a refusal", async () => {
    // A `5xx` is the server failing, not the server saying no. This is the line
    // the 502-read-as-signed-out defect crossed elsewhere in this console: the
    // operator is sent to ask for a permission they already hold.
    readAgents = () => json(502, { error: "bad gateway" });
    await mount();
    expect(statusLine()).toBe(UNREACHABLE);
    expect(statusLine()).not.toContain(REFUSED);
  });

  it("reads no answer at all as unreachable rather than as a refusal", async () => {
    readAgents = () => { throw new TypeError("Failed to fetch"); };
    await mount();
    // `apiClient` reports this as `status: null`, which is not zero and not a
    // 4xx. Anything treating a missing status as falsy lands on "refused".
    expect(statusLine()).toBe(UNREACHABLE);
    expect(statusLine()).not.toContain(REFUSED);
    expect(statusLine()).not.toContain(EMPTY);
  });

  it("offers no agent to send from when the read never landed", async () => {
    readAgents = () => { throw new TypeError("Failed to fetch"); };
    await mount();
    // The picker is the other half of the same sentence: a row in it is a claim
    // that the mesh holds that identity, and after a failed read the screen
    // knows of none. An invented row here would be worse than the wrong
    // sentence above, because it is selectable.
    expect(optionTexts(senderSelect())).toEqual([]);
    expect(optionTexts(recipientSelect())).toEqual([]);
    expect(detailUnder(senderSelect())).toBe("");
  });

  it("says nothing is registered only when the server said so", async () => {
    readAgents = () => json(200, { agents: [] });
    await mount();
    expect(statusLine()).toBe(EMPTY);
    expect(statusLine()).not.toContain(UNREACHABLE);
    expect(statusLine()).not.toContain(REFUSED);
    expect(statusLine()).not.toContain(LOADING);
  });

  it("draws no line at all once rows arrived", async () => {
    await mount();
    // The control the four above are measured against. Without it a panel that
    // renders its loading line forever would satisfy every "not" assertion in
    // the error cases and never be caught by the one positive it fails.
    expect(statusLine()).toBe("");
    expect(optionTexts(senderSelect())).toHaveLength(2);
  });
});

describe("what a picker says about an identity nobody measured", () => {
  it("keeps an unseen identity unseen, in the dot and in both details", async () => {
    readAgents = () => json(200, { agents: [LANE_A] });
    await mount();
    // `last_seen_at: null` is *no presence record*, not "offline" (SPEC § 9.1),
    // and the fingerprint absent is the field an operator compares by eye to
    // decide an identity is who it claims to be — a constant there makes every
    // agent match, and the one it defaulted to had the word `verified` in it.
    expect(optionTexts(senderSelect())).toEqual([
      `${UNSEEN_DOT} Support lane (lane-a) — [worker]`,
    ]);
    expect(detailUnder(senderSelect())).toContain(`${LAST_SEEN}: ${NEVER_SEEN}`);
    expect(detailUnder(senderSelect())).toContain(NO_FINGERPRINT);
    expect(detailUnder(senderSelect())).not.toContain("sha256");
  });

  it("reports a measured sighting as measured, and the key it was actually sent", async () => {
    const fingerprint = "sha256:11aa22bb33cc44dd55ee66ff7788";
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    readAgents = () => json(200, {
      agents: [row("lane-c", { description: "Seen lane", type: "relay", last_seen_at: twoHoursAgo, fingerprint })],
    });
    await mount();
    // The dot is the same claim in a glyph, so it moves with the record rather
    // than standing for a status this route does not send.
    expect(optionTexts(senderSelect())).toEqual([
      `${SEEN_DOT} Seen lane (lane-c) — [relay]`,
    ]);
    expect(detailUnder(senderSelect())).toContain(`${LAST_SEEN}: 2${HOUR} ${AGO}`);
    expect(detailUnder(senderSelect())).toContain(`${KIND}: relay`);
    // Truncated for the eye, but the prefix is the server's own bytes, and the
    // ellipsis is what says there are more of them.
    expect(detailUnder(senderSelect())).toContain(`${fingerprint.substring(0, 20)}...`);
    expect(detailUnder(senderSelect())).not.toContain(NO_FINGERPRINT);
  });
});

describe("the receipt is the hub's, or there is no receipt", () => {
  it("claims nothing about a send before one has been made", async () => {
    await mount();
    expect(sends()).toHaveLength(0);
    expect(drawsCard()).toBe(false);
    expect(drawsNoReceipt()).toBe(false);
    expect(receiptText()).toContain(AWAITING_SEND);
  });

  it("posts the recipient the operator chose, and the body they typed", async () => {
    readAgents = () => json(200, { agents: [LANE_A, LANE_B, LANE_C] });
    await mount();
    // The two pickers start on different agents, and the assertions below are
    // only worth anything while they do: a recipient chosen to equal the sender
    // makes `to: sender` and `to: recipient` post the same body, and a mutation
    // run found exactly that hole here.
    expect(senderSelect().value).toBe("lane-a");
    expect(recipientSelect().value).toBe("lane-b");

    fireEvent.change(recipientSelect(), { target: { value: "lane-c" } });
    await send();
    // The route reads `to` and `text` and nothing else; a stale or defaulted
    // recipient here sends a real message to the wrong agent while the screen
    // shows the name that was picked.
    expect(sends()).toHaveLength(1);
    expect(sends()[0]!.init!.method).toBe("POST");
    expect(sentBody()).toEqual({ to: "lane-c", text: payloadField().value });

    // And it is the picker labelled *recipient* that travels. Moving the other
    // one must not move the address: `from` is not in the body at all — the
    // route stamps the authenticated login over anything a client sends.
    fireEvent.change(senderSelect(), { target: { value: "lane-b" } });
    await send();
    expect(sentBody()).toEqual({ to: "lane-c", text: payloadField().value });
  });

  it("sends what a preset put in the box, not what was there before it", async () => {
    await mount();
    const before = payloadField().value;
    const preset = [...document.querySelectorAll("button")]
      .find((b) => b.textContent === "Security alert");
    fireEvent.click(preset!);
    expect(payloadField().value).not.toBe(before);
    await send();
    // A preset that only repaints the textarea while the previous body goes out
    // is a screen showing one message and dispatching another.
    expect(sentBody().text).toBe(payloadField().value);
    expect(String(sentBody().text)).toContain("EGRESS_CHECK");
  });

  it("draws the receipt the hub wrote, in fields the request did not carry", async () => {
    await mount();
    await send();
    expect(drawsCard()).toBe(true);
    // Every field here disagrees with the request on purpose. The card that
    // reported nothing was made of `receipt.from || sender`, `receipt.ts ||
    // new Date()` and a literal where the id belongs — it agreed with the
    // person who filled the form in, and so could never contradict them.
    expect(cardId()).toBe(RECEIPT.id);
    expect(receiptText()).toContain(RECEIPT.id);
    expect(receiptText()).toContain(RECEIPT.from);
    expect(receiptText()).toContain(RECEIPT.to);
    expect(receiptText()).toContain(RECEIPT.ts);
    // The picker's own two names are the fallbacks that used to be drawn here,
    // and `from` is not even sent — the route stamps the authenticated login.
    expect(receiptText()).not.toContain("lane-a");
    expect(receiptText()).not.toContain("lane-b");
  });

  it("calls a message the hub is still holding held, not delivered", async () => {
    await mount();
    await send();
    // `pending` is the hub accepting it; `delivered` is the recipient having
    // taken it. One word apart, and only the second one means the message
    // arrived — a screen that rounds the first up to the second tells an
    // operator to stop watching.
    expect(cardStatus()).toBe("pending");
    expect(receiptText()).toContain(RECEIPT_PENDING);
    expect(receiptText()).not.toContain(RECEIPT_DELIVERED);
  });

  it("carries a receipt the hub refused through as a refusal", async () => {
    sendMessage = () => json(201, { ok: true, message: { ...RECEIPT, status: "failed" } });
    await mount();
    await send();
    // The route answers `201` with a `failed` receipt when the hub would not
    // take the message, and that receipt is the only place the person is told
    // it will not be delivered. It is still evidence, so it is still drawn —
    // just never as a success.
    expect(cardStatus()).toBe("failed");
    expect(receiptText()).toContain(RECEIPT_FAILED);
    expect(receiptText()).not.toContain(RECEIPT_DELIVERED);
    expect(receiptText()).not.toContain(RECEIPT_PENDING);
  });
});

describe("an absent receipt is not a delivery", () => {
  it("says the 201 carried none, and does not sit on the prompt that means nothing was tried", async () => {
    sendMessage = () => json(201, { ok: true });
    await mount();
    await send();
    // The message really left; what came back had no `message` in it. The old
    // reading filled the fields in locally and reported success, and the
    // alert() that replaced it left this panel on its idle prompt — the same
    // words it shows before anything has been sent at all.
    expect(sends()).toHaveLength(1);
    expect(drawsCard()).toBe(false);
    expect(drawsNoReceipt()).toBe(true);
    expect(receiptText()).toContain(NO_RECEIPT_TITLE);
    expect(receiptText()).toContain(NO_RECEIPT_IN_201);
    expect(receiptText()).not.toContain(AWAITING_SEND);
    // The body panel is titled as what was sent, and it is only true beside a
    // receipt that says something was.
    expect(receiptText()).not.toContain(WHAT_WAS_SENT);
  });

  it("shows the server's own words when the send was refused", async () => {
    const refusal = 'You are not authorized to message agent "lane-b"';
    sendMessage = () => json(403, { error: refusal, capability: REFUSED_CAP });
    await mount();
    await send();
    expect(drawsCard()).toBe(false);
    expect(drawsNoReceipt()).toBe(true);
    expect(receiptText()).toContain(refusal);
    // A refusal is not a `201` that forgot its receipt: that sentence would
    // send an operator to read the route's response for a bug in it, when what
    // happened is that this account may not message that agent.
    expect(receiptText()).not.toContain(NO_RECEIPT_IN_201);
    expect(receiptText()).not.toContain(AWAITING_SEND);
  });

  it("does not call a send that never left the browser a refusal", async () => {
    sendMessage = () => { throw new TypeError("Failed to fetch"); };
    await mount();
    await send();
    expect(drawsCard()).toBe(false);
    expect(drawsNoReceipt()).toBe(true);
    // Nothing answered, so nothing refused. Saying the account may not do this
    // is the same wrong turn as the `502` that became a login form: the
    // operator goes and asks for a permission that was never the problem.
    expect(receiptText()).not.toContain(REFUSED);
    expect(receiptText()).not.toContain(NO_RECEIPT_IN_201);
    expect(receiptText()).not.toContain(AWAITING_SEND);
  });

  it("takes the previous receipt down when the next send brings none", async () => {
    await mount();
    await send();
    expect(cardId()).toBe(RECEIPT.id);

    sendMessage = () => json(201, { ok: true });
    await send();
    // **The receipt wins the panel.** A card left standing while the send under
    // it failed is not a stale detail — the failure has nowhere else to be
    // drawn, so the operator sees the id of the message they sent a minute ago
    // and reads it as the one they just failed to send.
    expect(drawsCard()).toBe(false);
    expect(receiptText()).not.toContain(RECEIPT.id);
    expect(drawsNoReceipt()).toBe(true);
    expect(receiptText()).toContain(NO_RECEIPT_IN_201);
  });
});

describe("the words on the screen are the dictionary's", () => {
  it("draws no Korean of its own in either state of the receipt panel", async () => {
    // Every string on this page has a Korean fallback compiled in beside its
    // key, reached the moment that key is missing from the English half of the
    // dictionary — and five screens printed Korean in English mode before the
    // api layer stopped writing sentences. The fixtures in this file are ASCII,
    // so any Hangul on the page is the screen's own.
    //
    // Written as code points rather than as characters: this tree is scanned
    // for Hangul, and a scan cannot tell a literal asserting its absence from
    // one that is the thing being looked for.
    const hasHangul = (text: string): boolean =>
      // Compared by code point rather than matched by a regexp. The range has
      // to be written somehow, and `SC-I18N-06` reads a `\u` escape as text
      // wherever it cannot see that it is an escape — a regexp literal is one
      // of those places. Numbers say the same thing and cannot be misread.
      [...text].some((ch) => {
        const code = ch.codePointAt(0) ?? 0;
        return code >= 0xac00 && code <= 0xd7a3;
      });
    sendMessage = () => json(201, { ok: true });
    await mount();
    expect(hasHangul(document.body.textContent ?? "")).toBe(false);

    await send();
    // The no-receipt panel is the newest copy on this screen and the only one
    // an operator reaches by having something go wrong, which makes it both the
    // likeliest key to be missing from the English dictionary and the least
    // likely omission to be noticed.
    expect(receiptText()).toContain(NO_RECEIPT_IN_201);
    expect(hasHangul(document.body.textContent ?? "")).toBe(false);
  });
});

describe("a body that is not JSON", () => {
  it("draws the receipt for a message the mesh accepted", async () => {
    // **The panel parsed the textarea during render.** `sendMessageApi` sends
    // `text`, so the field is free text and nothing requires JSON — the default
    // is a JSON preset, which is the only reason the happy path never showed
    // it. Type a word, send it successfully, and `JSON.parse` threw while React
    // was drawing the receipt for a message the mesh had already taken.
    await mount();
    fireEvent.change(payloadField(), { target: { value: "hello" } });
    await send();
    expect(drawsNoReceipt()).toBe(false);
    expect(document.body.textContent).toContain("hello");
  });

  it("shows what was sent, not what is in the box now", async () => {
    // The panel is labelled *dispatched*, and it read the textarea's current
    // value: editing the box after a send rewrote the record of the send while
    // the receipt above it did not move.
    await mount();
    fireEvent.change(payloadField(), { target: { value: '{"a":1}' } });
    await send();
    fireEvent.change(payloadField(), { target: { value: '{"b":2}' } });
    // Compared in the pretty-printed form the viewer produces, because the
    // textarea's own compact value is on the page too — asserting the bare
    // name matched the box and said nothing about the panel.
    expect(document.body.textContent).toContain('"a": 1');
    expect(document.body.textContent).not.toContain('"b": 2');
  });
});

