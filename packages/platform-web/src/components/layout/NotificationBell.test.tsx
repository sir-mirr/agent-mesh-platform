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
import { registerDom } from "../../register-dom";

// Registered once for the process and never unregistered: bun runs every test
// file's top level before any test, so a register/unregister pair swaps the
// document out from under whichever file is still using it.
registerDom();

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

/**
 * One row, found by the cell that holds its identity.
 *
 * `dropdownText()` is the whole body, so `toContain(value)` passes wherever the
 * value landed — including the wrong field of the wrong row. The row's identity
 * is rendered in a `<code>`, and the row is that cell's line's parent.
 */
const rowFor = (identity: string): HTMLElement => {
  const cell = [...document.querySelectorAll("code")].find((c) => c.textContent === identity);
  const row = cell?.parentElement?.parentElement;
  if (!row) throw new Error(`no row renders ${identity} as an identity`);
  return row;
};
/**
 * The one line of `row` a label introduces, label included, or `""`.
 *
 * The row's containers start with the label too, so the shortest match is taken
 * — the element that carries the field and nothing after it.
 */
const lineLabelled = (row: HTMLElement, label: string): string =>
  [...row.querySelectorAll("div, span")]
    .map((el) => el.textContent ?? "")
    .filter((text) => text.startsWith(`${label}:`))
    .sort((a, b) => a.length - b.length)[0] ?? "";

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
    //
    // **And it now says it could not read, rather than showing a quiet bell.**
    // The reader refuses a body without a `keys` array instead of answering
    // `[]`, so this reaches the operator as a failed read. A plain bell here
    // would be the same sentence a server on the old name produces: nothing
    // waiting.
    queueAnswers({ ok: true, pending: [{ identity: "person-awaiting-account", fingerprint: "sha256:ff" }] });
    await mount();
    openDropdown();
    expect(dropdownText()).not.toContain("person-awaiting-account");
    expect(bellFace()).toBe("\u{1F514}?");
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
    expect(bellFace()).toBe("\u{1F514}1");
  });

  it("does not turn a dropped stream into a queue it could not read", async () => {
    // **The mutant this file could not see.** `es.onerror` setting `failure` to
    // `unreachable` alongside `streamLost` passed every assertion here, because
    // with rows on screen `unreachable` has nothing to draw: the `?` badge is
    // gated on an empty count and the unreachable empty-state only renders for
    // an empty list. So the drop is asserted on an *empty* queue, where the two
    // states have different sentences and the wrong one is visible.
    queueAnswers({ ok: true, keys: [] });
    await mount();
    await act(async () => { FakeEventSource.live?.onerror?.(); });
    openDropdown();
    // The read succeeded and said nothing is waiting. That the channel then
    // dropped does not retract the answer.
    expect(screen.queryByTestId("bell-empty")).not.toBe(null);
    expect(screen.queryByTestId("bell-empty-unreachable")).toBe(null);
    expect(dropdownText()).toContain(DICTIONARY.en["bell.streamLost"]!);
    expect(bellFace()).toBe("\u{1F514}");
  });

  it("takes the notice back down when the stream reconnects", async () => {
    queueAnswers({ ok: true, keys: [] });
    await mount();
    openDropdown();
    await act(async () => { FakeEventSource.live?.onerror?.(); });
    // The control the absence below is measured against. Without it, a
    // component that never raises the notice at all — `onerror` unwired, the
    // whole stale-stream state dead — reads exactly like one that raised it and
    // took it back down, and both setup calls here are optional-chained, so
    // neither would even throw.
    expect(screen.queryByTestId("bell-stream-lost")).not.toBe(null);
    await act(async () => { FakeEventSource.live?.onopen?.(); });
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
  it("shows and clears the hover affordance only on a proposal that is still actionable", async () => {
    queueAnswers({ ok: true, keys: [PROPOSAL] });
    await mount();
    openDropdown();

    const row = rowFor(PROPOSAL.identity);
    const propsKey = Object.keys(row).find((key) => key.startsWith("__reactProps$"));
    const props = propsKey ? (row as unknown as Record<string, Record<string, unknown>>)[propsKey] : undefined;
    const enter = props?.onMouseEnter;
    const leave = props?.onMouseLeave;
    if (typeof enter !== "function" || typeof leave !== "function") {
      throw new Error("the pending proposal row has no hover callbacks");
    }

    const target = { style: { background: "" } };
    enter({ currentTarget: target });
    if (target.style.background !== "var(--color-bg-surface-sub)") {
      throw new Error("the pending proposal did not show its hover affordance");
    }

    leave({ currentTarget: target });
    if (String(target.style.background) !== "transparent") {
      throw new Error(`the pending proposal kept its hover affordance after the pointer left: ${JSON.stringify(target.style.background)}`);
    }
  });

  it("carries the identity and the type the server sent, each in its own slot", async () => {
    queueAnswers({ ok: true, keys: [PROPOSAL] });
    await mount();
    openDropdown();
    // Both values are in the body wherever the mapping puts them, so a
    // body-wide `toContain` passes with the two slots exchanged — and a row
    // headed by a group where the identity belongs is the same class of defect
    // as reading the wrong queue: every word on it is a word the server sent,
    // and the row still says something untrue.
    const row = rowFor(PROPOSAL.identity);
    expect(lineLabelled(row, DICTIONARY.en["bell.identity"]!))
      .toBe(`${DICTIONARY.en["bell.identity"]!}: ${PROPOSAL.identity}`);
    expect(lineLabelled(row, DICTIONARY.en["bell.group"]!))
      .toBe(`${DICTIONARY.en["bell.group"]!}: ${PROPOSAL.type}`);
  });

  it("does not dress a proposal that named no type in one the server could have sent", async () => {
    queueAnswers({ ok: true, keys: [
      PROPOSAL,
      { identity: "joiner-2", fingerprint: "sha256:bb22334455" },
    ] });
    await mount();
    openDropdown();
    const declared = lineLabelled(rowFor(PROPOSAL.identity), DICTIONARY.en["bell.group"]!);
    const unstated = lineLabelled(rowFor("joiner-2"), DICTIONARY.en["bell.group"]!);
    expect(declared).toBe(`${DICTIONARY.en["bell.group"]!}: ${PROPOSAL.type}`);
    // The server named no type for the second row. Whatever stands in that slot
    // is the component's own word, and the one thing it may not be is a word
    // the server could have sent: a fallback equal to a real type makes an
    // unclassified agent read exactly like a classified one, which is the
    // constant-fingerprint defect moved into a different field. Pinning the
    // literal instead would only pin the fallback in place — the placeholder is
    // free to change, being mistakable for a declaration is not.
    expect(unstated).not.toBe(declared);
    expect(unstated).not.toContain(PROPOSAL.type);
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

    // Three rows that are all pending cannot tell the count apart from the
    // length of the list — both say 3, and "nothing else" is the entire claim
    // in the name. So one is decided here. A decided row stays on screen, which
    // is how the operator sees what they just did; counting it would keep the
    // badge up and send them back to a queue with nothing waiting in it, which
    // is the same wrong sentence as a badge over an unread queue.
    openDropdown();
    fireEvent.click(screen.getByText("joiner-1"));
    fireEvent.click(buttonSaying(DICTIONARY.en["pairing.modal.approveAndBind"]!)!);
    await settle();
    openDropdown();
    expect(bellFace()).toBe("\u{1F514}2");
    expect(dropdownText()).toContain(DICTIONARY.en["bell.approved"]!);
    // The other two are untouched, so the badge fell by a decision rather than
    // by rows going missing.
    expect(dropdownText()).toContain("joiner-2");
    expect(dropdownText()).toContain("joiner-3");
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
    // The write left, the dropdown is open again, and the bell said the one
    // thing that is true about a `403`. On its own the negative below is also
    // satisfied by a bell that gives no decision feedback whatsoever — the
    // string it denies cannot render if nothing renders — and by a deny that
    // was never sent.
    expect(calls.some((c) => c.url.endsWith(KEYS_DENY))).toBe(true);
    expect(screen.queryByTestId("bell-decision-failed")).not.toBe(null);
    expect(dropdownText()).toContain(DICTIONARY.en["bell.decideRefused"]!);
    // Refused is also not decided: the row is still waiting on the server.
    expect(bellFace()).toBe("\u{1F514}1");
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

describe("a snapshot that empties the queue", () => {
  it("takes the rows down when the stream says nothing is waiting", async () => {
    // **The guard was `list.length > 0`.** A queue somebody else drained never
    // cleared: the bell went on showing proposals the hub had already decided,
    // and the badge went on counting them. An operator watching the bell was
    // reading a list that had stopped being true.
    queueAnswers({ ok: true, keys: [PROPOSAL] });
    await mount();
    openDropdown();
    expect(dropdownText()).toContain("joiner-1");

    await snapshot({ keys: [] });
    expect(dropdownText()).not.toContain("joiner-1");
    expect(screen.queryByTestId("bell-empty")).not.toBe(null);
    // And no badge: an answered-and-empty queue wears none.
    expect(bellFace()).toBe("\u{1F514}");
  });

  it("keeps one unreadable row from taking the whole snapshot with it", async () => {
    // `p.fingerprint.slice(0, 10)` threw inside a bare `catch {}`, so a single
    // row without a fingerprint put the entire snapshot on the floor — and the
    // previous list stayed on screen with nothing said about it.
    queueAnswers({ ok: true, keys: [] });
    await mount();
    await snapshot({ keys: [{ identity: "no-fingerprint" }, PROPOSAL] });
    openDropdown();
    expect(dropdownText()).toContain("joiner-1");
    expect(dropdownText()).toContain("no-fingerprint");
  });
});
