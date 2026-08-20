/**
 * Which queue the bell is actually looking at, and the four things it can say.
 *
 * Two admin queues answer one path segment apart — `admin/pending` is people
 * waiting to be admitted, `admin/keys/pending` is keys waiting to be approved —
 * and until `D-689` both replied under the same body key, so a reader holding
 * the response could not tell which queue it had. The bell is the only place an
 * operator sees either of them without opening a page, and a bell that read the
 * wrong route (or the wrong name out of the right route) would draw one queue's
 * backlog under a label naming the other. Both halves are pinned here: the path
 * asked, and the name read out of the answer.
 *
 * The rest is the distinction this console keeps re-learning. *Refused*,
 * *unreachable*, *stale* and *empty* are four different sentences about the
 * backend, and the defect is always the same one — the screen says nobody is
 * waiting about a server that never answered. The module's own comments record
 * that happening here twice: the fetch's `.catch` once set the list to `[]`,
 * and a `403` once printed "could not ask" at a server that had answered.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Registered once for the process and never unregistered: bun runs every test
// file's top level before any test, so a register/unregister pair swaps the
// document out from under whichever file is still using it.
if (!(globalThis as { document?: unknown }).document) GlobalRegistrator.register();

const { render, screen, cleanup, fireEvent, act } = await import("@testing-library/react");
const { NotificationBell } = await import("./NotificationBell.tsx");
const { I18nProvider, DICTIONARY } = await import("@/contexts/I18nContext.tsx");

const KEYS_PENDING = "/api/v1/admin/keys/pending";
const KEYS_STREAM = "/api/v1/admin/keys/stream";
const KEYS_APPROVE = "/api/v1/admin/keys/approve";
const KEYS_DENY = "/api/v1/admin/keys/deny";

/**
 * **happy-dom ships no `EventSource`, and the component constructs one inside a
 * `try`.** Left alone, `new EventSource(...)` throws `ReferenceError` straight
 * into that `catch {}`, and every live branch — the snapshot reader, the
 * dropped-stream notice — is unreachable dead code under test. Those are the
 * branches worth pinning, so the constructor is supplied by hand, the same way
 * `fetch` is: bun:test has no global stubber and no fake for either.
 */
type SseListener = (event: { data: string }) => void;

class FakeEventSource {
  static opened: Array<{ url: string; withCredentials: boolean }> = [];
  static live: FakeEventSource | null = null;
  static closedCount = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, SseListener[]>();
  constructor(url: string, init?: { withCredentials?: boolean }) {
    FakeEventSource.opened.push({ url, withCredentials: init?.withCredentials === true });
    FakeEventSource.live = this;
  }
  addEventListener(type: string, fn: SseListener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close(): void {
    FakeEventSource.closedCount += 1;
  }
  send(type: string, data: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ data });
  }
}

const realEventSource = (globalThis as { EventSource?: unknown }).EventSource;
(globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;

const realFetch = globalThis.fetch;
const stub = (fn: unknown) => { globalThis.fetch = fn as typeof globalThis.fetch; };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Reply = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;
const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
let reply: Reply = () => { throw new TypeError("Failed to fetch"); };

beforeEach(() => {
  calls.length = 0;
  FakeEventSource.opened = [];
  FakeEventSource.live = null;
  FakeEventSource.closedCount = 0;
  reply = () => { throw new TypeError("Failed to fetch"); };
  stub(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return await reply(String(input), init);
  });
});

afterEach(() => { cleanup(); globalThis.fetch = realFetch; });
afterAll(() => {
  // The fake is on `globalThis`, which outlives this file the same way
  // `mock.module` does; putting the original back keeps that from leaking.
  if (realEventSource === undefined) delete (globalThis as { EventSource?: unknown }).EventSource;
  else (globalThis as { EventSource?: unknown }).EventSource = realEventSource;
});

/** The queue read answers `body`; any write answers `{ ok: true }`. */
const queueAnswers = (body: unknown, status = 200) => {
  reply = (url) => (url.endsWith(KEYS_PENDING) ? json(status, body) : json(200, { ok: true }));
};

/** Every `fetch` in the file rejects — no answer at all, which is not a status. */
const queueUnreachable = () => {
  reply = () => { throw new TypeError("Failed to fetch"); };
};

const settle = async () => {
  // The mount fetch resolves over several microtasks (fetch, then `.json()`,
  // then two `.then`s) and the decision writes over more, so a bare
  // `await act(async () => {})` is not always enough to have drained them.
  await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
};

const mount = async () => {
  render(<I18nProvider><NotificationBell /></I18nProvider>);
  await settle();
};

const bell = () => screen.getByTestId("bell");
/** Everything the bell button says: the icon alone, plus a badge when it has one. */
const bellFace = () => bell().textContent;
const openDropdown = () => { fireEvent.click(bell()); };
const dropdownText = () => document.body.textContent ?? "";
const buttonSaying = (word: string) =>
  [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(word));

const snapshot = async (body: unknown) => {
  await act(async () => { FakeEventSource.live?.send("snapshot", JSON.stringify(body)); });
};
const keyProposed = async (body: unknown) => {
  await act(async () => { FakeEventSource.live?.send("key-proposed", JSON.stringify(body)); });
};

const PROPOSAL = { identity: "joiner-1", fingerprint: "sha256:aabbccddee11", type: "worker" };

describe("which queue the bell reads", () => {
  it("asks the key queue, not the admission queue one segment above it", async () => {
    queueAnswers({ ok: true, keys: [] });
    await mount();
    // `admin/pending` is people waiting to be let in and is a different
    // operator decision behind a different capability. One segment is the whole
    // difference between the two, and both answer 200.
    expect(calls.map((c) => c.url)).toEqual([KEYS_PENDING]);
    expect(FakeEventSource.opened).toEqual([{ url: KEYS_STREAM, withCredentials: true }]);
  });

  it("does not draw the admission queue's rows when the body carries them", async () => {
    // The shape both routes used to answer with. Reading `pending` here would
    // put people waiting for an account under a bell about agent keys, and
    // nothing about the response would have looked wrong.
    queueAnswers({ ok: true, pending: [{ identity: "person-awaiting-account", fingerprint: "sha256:ff" }] });
    await mount();
    openDropdown();
    expect(dropdownText()).not.toContain("person-awaiting-account");
    expect(bellFace()).toBe("\u{1F514}");
  });

  it("reads the stream's snapshot under the name the rename left it at", async () => {
    queueAnswers({ ok: true, keys: [] });
    await mount();
    await snapshot({ keys: [PROPOSAL] });
    openDropdown();
    expect(dropdownText()).toContain("joiner-1");
    expect(bellFace()).toBe("\u{1F514}1");
  });

  it("ignores a snapshot still using the pre-rename name", async () => {
    // `1daa973` moved the stream's snapshot to `keys`; a reader that also
    // accepted `proposals` could never be wrong about which name arrived, which
    // is precisely the ambiguity the rename existed to end. So the old name
    // draws nothing rather than quietly working.
    queueAnswers({ ok: true, keys: [PROPOSAL] });
    await mount();
    await snapshot({ proposals: [{ identity: "old-name-row", fingerprint: "sha256:99887766554433" }] });
    openDropdown();
    expect(dropdownText()).not.toContain("old-name-row");
    expect(dropdownText()).toContain("joiner-1");
  });
});

describe("a read that never happened is not an empty queue", () => {
  it("says it could not ask, rather than that nobody is waiting", async () => {
    queueUnreachable();
    await mount();
    openDropdown();
    // The exact defect the module's comment records: the `.catch` set the list
    // to `[]`, and `[]` draws a sentence about the server's answer when there
    // was no answer. Measured with only this route failing, the bell was
    // indistinguishable from a quiet mesh.
    expect(screen.queryByTestId("bell-empty")).toBe(null);
    expect(screen.queryByTestId("bell-empty-unreachable")).not.toBe(null);
    expect(dropdownText()).toContain(DICTIONARY.en["bell.unreachable"]!);
    expect(dropdownText()).not.toContain(DICTIONARY.en["bell.empty"]!);
  });

  it("marks the bell itself, so a closed dropdown is not silence either", async () => {
    queueUnreachable();
    await mount();
    // Without this the operator never opens the dropdown: a bell with no badge
    // is what a healthy empty queue looks like.
    expect(bellFace()).toBe("\u{1F514}?");
    expect(screen.getByTestId("bell-unreachable").getAttribute("title"))
      .toBe(DICTIONARY.en["bell.unreachable"]!);
  });

  it("calls a refusal a refusal, because the server did answer", async () => {
    queueAnswers({ error: "not allowed", capability: "key.approve" }, 403);
    await mount();
    openDropdown();
    // Walked with a session holding only `audit.read.metadata`, the bell used
    // to say "could not ask" at a `403` — sending the operator to check the
    // network for a permission they simply do not hold.
    expect(screen.queryByTestId("bell-empty-unreachable")).toBe(null);
    expect(screen.queryByTestId("bell-empty-refused")).not.toBe(null);
    expect(dropdownText()).toContain(DICTIONARY.en["bell.refused"]!);
    expect(screen.getByTestId("bell-unreachable").getAttribute("title"))
      .toBe(DICTIONARY.en["bell.refused"]!);
  });

  it("does not call a broken proxy a refusal", async () => {
    // A `5xx` is the server failing, not the server saying no. This is the line
    // the 502-read-as-signed-out defect crossed elsewhere in this console.
    queueAnswers({ error: "bad gateway" }, 502);
    await mount();
    openDropdown();
    expect(screen.queryByTestId("bell-empty-refused")).toBe(null);
    expect(screen.queryByTestId("bell-empty-unreachable")).not.toBe(null);
  });

  it("says the queue is empty only when the server said so", async () => {
    queueAnswers({ ok: true, keys: [] });
    await mount();
    openDropdown();
    expect(screen.queryByTestId("bell-empty")).not.toBe(null);
    expect(dropdownText()).toContain(DICTIONARY.en["bell.empty"]!);
    // An answered-and-empty queue wears no badge at all. Absent has to look
    // absent: a `0` and a `?` are both claims this state is not making.
    expect(bellFace()).toBe("\u{1F514}");
    expect(screen.queryByTestId("bell-unreachable")).toBe(null);
  });
});

describe("a dropped stream is a third state, not a fourth reading of the queue", () => {
  it("says the list may be stale while still showing it", async () => {
    queueAnswers({ ok: true, keys: [PROPOSAL] });
    await mount();
    await act(async () => { FakeEventSource.live?.onerror?.(); });
    openDropdown();
    // `EventSource` reconnects on its own, so an error is not "gone" — and it
    // is not "nothing is waiting" or "I could not ask" either. What it means is
    // that the rows below are the last thing received, which is a claim about
    // the channel, and the rows stay because they were really answered.
    expect(screen.queryByTestId("bell-stream-lost")).not.toBe(null);
    expect(dropdownText()).toContain(DICTIONARY.en["bell.streamLost"]!);
    expect(dropdownText()).toContain("joiner-1");
    expect(screen.queryByTestId("bell-empty-unreachable")).toBe(null);
    expect(bellFace()).toBe("\u{1F514}1");
  });

  it("takes the notice back down when the stream reconnects", async () => {
    queueAnswers({ ok: true, keys: [] });
    await mount();
    await act(async () => { FakeEventSource.live?.onerror?.(); });
    await act(async () => { FakeEventSource.live?.onopen?.(); });
    openDropdown();
    // A stale-data warning that never clears is one an operator learns to
    // ignore, which costs the warning that matters.
    expect(screen.queryByTestId("bell-stream-lost")).toBe(null);
  });

  it("closes the stream when the bell goes away", async () => {
    queueAnswers({ ok: true, keys: [] });
    await mount();
    cleanup();
    // A subscription outliving its component holds a connection open per
    // remount and keeps writing into state nothing is rendering.
    expect(FakeEventSource.closedCount).toBe(1);
  });
});

describe("what a row says about a proposal", () => {
  it("carries the identity and the type the server sent", async () => {
    queueAnswers({ ok: true, keys: [PROPOSAL] });
    await mount();
    openDropdown();
    expect(dropdownText()).toContain("joiner-1");
    expect(dropdownText()).toContain("worker");
  });

  it("says General when the proposal named no type, rather than inventing one", async () => {
    queueAnswers({ ok: true, keys: [{ identity: "joiner-2", fingerprint: "sha256:bb22334455" }] });
    await mount();
    openDropdown();
    expect(dropdownText()).toContain("General");
  });

  it("says just now when the proposal carried no timestamp", async () => {
    queueAnswers({ ok: true, keys: [{ identity: "joiner-3", fingerprint: "sha256:cc33445566" }] });
    await mount();
    openDropdown();
    // The alternative reading is a fabricated arrival time, which is the same
    // family of defect as the invented `created_at` on the registry screen: a
    // number an operator would sort by that no server ever sent.
    expect(dropdownText()).toContain(DICTIONARY.en["bell.justNow"]!);
  });

  it("hands the modal a missing fingerprint as missing, so neither decision is offered", async () => {
    queueAnswers({ ok: true, keys: [{ identity: "no-key-row", fingerprint: null }] });
    await mount();
    openDropdown();
    fireEvent.click(screen.getByText("no-key-row"));
    // Both decisions name a key by its fingerprint. A placeholder here would be
    // worse than a blank — it is the field an operator compares by eye, and a
    // constant in it makes every proposal match. Disabled buttons are what
    // "there is no key to decide about" looks like.
    expect(buttonSaying(DICTIONARY.en["pairing.modal.approveAndBind"]!)?.disabled).toBe(true);
    expect(buttonSaying(DICTIONARY.en["common.reject"]!)?.disabled).toBe(true);
  });
});

describe("the badge counts what is still waiting", () => {
  it("counts the pending rows and nothing else", async () => {
    queueAnswers({ ok: true, keys: [
      PROPOSAL,
      { identity: "joiner-2", fingerprint: "sha256:bb22334455" },
      { identity: "joiner-3", fingerprint: "sha256:cc33445566" },
    ] });
    await mount();
    expect(bellFace()).toBe("\u{1F514}3");
  });

  it("replaces a proposal that arrives twice rather than counting it twice", async () => {
    queueAnswers({ ok: true, keys: [PROPOSAL] });
    await mount();
    // The stream re-announces on reconnect, so the same fingerprint arrives
    // again; counted twice it would tell the operator there is a second key
    // waiting that does not exist.
    await keyProposed({ identity: "joiner-1-renamed", fingerprint: PROPOSAL.fingerprint });
    openDropdown();
    expect(bellFace()).toBe("\u{1F514}1");
    expect(dropdownText()).toContain("joiner-1-renamed");
    expect(dropdownText()).not.toContain("joiner-1 (Agent)");
  });

  it("shows a proposal that arrived only over the stream", async () => {
    queueAnswers({ ok: true, keys: [] });
    await mount();
    await keyProposed({ identity: "late-joiner", fingerprint: "sha256:dd44556677", type: "relay" });
    openDropdown();
    expect(dropdownText()).toContain("late-joiner");
    expect(bellFace()).toBe("\u{1F514}1");
  });
});

describe("a decision moves the row only when the server moved", () => {
  const decideOn = async (buttonWord: string) => {
    openDropdown();
    fireEvent.click(screen.getByText("joiner-1"));
    fireEvent.click(buttonSaying(buttonWord)!);
    await settle();
    openDropdown();
  };

  it("marks the key approved once the write went through", async () => {
    queueAnswers({ ok: true, keys: [PROPOSAL] });
    await mount();
    await decideOn(DICTIONARY.en["pairing.modal.approveAndBind"]!);
    expect(calls.some((c) => c.url.endsWith(KEYS_APPROVE))).toBe(true);
    expect(dropdownText()).toContain(DICTIONARY.en["bell.approved"]!);
    expect(screen.queryByTestId("bell-decision-failed")).toBe(null);
    expect(bellFace()).toBe("\u{1F514}");
  });

  it("leaves the row pending when the server refused the decision", async () => {
    reply = (url) => (url.endsWith(KEYS_PENDING)
      ? json(200, { ok: true, keys: [PROPOSAL] })
      : json(403, { error: "not allowed", capability: "key.approve" }));
    await mount();
    await decideOn(DICTIONARY.en["pairing.modal.approveAndBind"]!);
    // `SC-WRITE-10`: the state update used to sit below the `try`, so it ran on
    // every path. The bell said the key was decided about a write the server
    // blocked, and the proposal was still pending on the other side.
    expect(dropdownText()).not.toContain(DICTIONARY.en["bell.approved"]!);
    expect(bellFace()).toBe("\u{1F514}1");
    expect(dropdownText()).toContain(DICTIONARY.en["bell.decideRefused"]!);
  });

  it("does not call a blocked write unreachable when the server answered it", async () => {
    reply = (url) => (url.endsWith(KEYS_PENDING)
      ? json(200, { ok: true, keys: [PROPOSAL] })
      : json(403, { error: "not allowed", capability: "key.approve" }));
    await mount();
    await decideOn(DICTIONARY.en["common.reject"]!);
    expect(dropdownText()).not.toContain(DICTIONARY.en["bell.decideUnreachable"]!);
  });

  it("says the denial never reached the server when it did not", async () => {
    reply = (url) => {
      if (url.endsWith(KEYS_PENDING)) return json(200, { ok: true, keys: [PROPOSAL] });
      throw new TypeError("Failed to fetch");
    };
    await mount();
    await decideOn(DICTIONARY.en["common.reject"]!);
    expect(calls.some((c) => c.url.endsWith(KEYS_DENY))).toBe(true);
    // Denied-in-the-browser-only is the worst of the three: the operator reads
    // that the key was rejected and stops watching a proposal still waiting.
    expect(dropdownText()).not.toContain(DICTIONARY.en["bell.denied"]!);
    expect(bellFace()).toBe("\u{1F514}1");
    expect(dropdownText()).toContain(DICTIONARY.en["bell.decideUnreachable"]!);
  });
});
