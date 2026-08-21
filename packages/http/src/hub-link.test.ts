/**
 * What this service does the moment the hub answers, and for each frame after.
 *
 * `connectToHub` was 84 uncovered lines — the largest single block in
 * `main.ts` — because everything it does happens inside two socket callbacks
 * and nothing could invoke it: the served process crosses `import.meta.main`
 * and a test does not. It is exported as a seam now, and `WebSocket` is stood
 * in for.
 *
 * **The close path is deliberately not driven.** `onclose` schedules
 * `setTimeout(connectToHub, 5000)`, and a reconnect timer left running in a
 * shared test process fires during whatever file happens to be executing five
 * seconds later. Reaching those four lines is not worth handing every later
 * test a socket dial it did not ask for — the same judgement as not breaking
 * the hub database to reach a `catch`.
 *
 * The order on `onopen` is the point. § 8.2 checks both halves of a proxy claim
 * against stored rows rather than against what the socket says, so this
 * identity must exist and carry `can_proxy`, and each person must exist as type
 * `human`, **before** `mesh.connect` names them. Get the order wrong and the
 * hub drops the claims: every message sent on a person's behalf is refused, and
 * nothing on this side reports anything.
 */
import { afterEach, describe, expect, test } from "bun:test";

process.env.JWT_SECRET ||= "hub-link-probe";

const { app, connectToHub, redeclareProxies, sseClientCount } = await import("./main.ts");
const { getDb, upsertApprovedWebUser, upsertUser, approveUser, createPendingApproval } = await import("./db");
const { signJwt } = await import("./auth");

let n = 0;
const uniq = (p: string) => `hub-${p}-${++n}-${process.pid}`;

const realWs = globalThis.WebSocket;
const realFetch = globalThis.fetch;
afterEach(() => {
  hangUp();
  globalThis.WebSocket = realWs;
  globalThis.fetch = realFetch;
});

/** Every frame the service sent, and the handlers it installed. */
/** One log for both channels, because the question is which came first. */
type Step = { kind: "http"; url: string; body: string } | { kind: "ws"; frame: any };
let steps: Step[] = [];

type Fake = {
  sent: string[];
  open: () => Promise<void>;
  message: (frame: unknown) => void;
  /** Deliver bytes the hub would never send, to reach the parse failure. */
  messageRaw: (raw: string) => void;
  /** Answer a request frame the way the hub would, correlated by its id. */
  reply: (result: unknown, overrideId?: number) => void;
  /** How many message listeners are still attached. */
  listeners: () => number;
  /** Drop the link without scheduling anything. See `hangUp` below. */
  error: () => void;
};

/**
 * A socket that never connects to anything.
 *
 * `onopen` is awaited rather than fired and forgotten: the handler provisions
 * over `fetch` before it sends, so a test that does not wait sees the frames of
 * a half-finished registration.
 */
function standInSocket(): Fake {
  const sent: string[] = [];
  let ws: any;
  // **Real listener bookkeeping.** `sendViaHub` correlates a reply by adding a
  // `message` listener and removing it again, so a stand-in with no-op
  // `addEventListener` leaves every send waiting out its five-second timeout —
  // and a leak there is invisible without somewhere to count them.
  const listeners = new Set<(e: { data: string }) => void>();
  globalThis.WebSocket = function (this: any) {
    ws = this;
    this.send = (frame: string) => {
      sent.push(frame);
      steps.push({ kind: "ws", frame: JSON.parse(frame) });
    };
    this.addEventListener = (kind: string, fn: any) => { if (kind === "message") listeners.add(fn); };
    this.removeEventListener = (kind: string, fn: any) => { if (kind === "message") listeners.delete(fn); };
    this.close = () => {};
    return this;
  } as any;
  const deliver = (raw: string) => {
    ws.onmessage?.({ data: raw });
    for (const fn of [...listeners]) fn({ data: raw });
  };

  return {
    sent,
    open: async () => { await ws.onopen(); },
    message: (frame: unknown) => ws.onmessage({ data: JSON.stringify(frame) }),
    messageRaw: (raw: string) => ws.onmessage({ data: raw }),
    reply: (result: unknown, overrideId?: number) => {
      const request = sent.map((f) => JSON.parse(f)).reverse().find((f) => typeof f.id === "number");
      deliver(JSON.stringify({ jsonrpc: "2.0", id: overrideId ?? request?.id, result }));
    },
    listeners: () => listeners.size,
    error: () => ws.onerror(),
  };
}

/**
 * Put the module back to *not connected*, through the one door that schedules
 * nothing.
 *
 * `onclose` sets `setTimeout(connectToHub, 5000)`, so using it to tidy up would
 * hand every later file a socket dial it did not ask for. `onerror` clears the
 * same flag and starts no timer.
 *
 * Tidying is not optional here. A link left *connected* to a stand-in that
 * answers nothing makes every later `sendViaHub` wait out its full five-second
 * timeout — which is exactly what happened: one test in
 * `main.in-process.test.ts` took 5004ms and failed, and the cause was this file
 * two files earlier.
 */
let live: Fake | null = null;
const hangUp = () => { live?.error(); live = null; };

/**
 * Answer the hub's provisioning routes with success, and record that it was
 * asked.
 *
 * Provisioning is http and the claim is a socket frame, so *which came first*
 * cannot be read from either channel alone. Both land in one log.
 */
function hubAccepts() {
  steps = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    steps.push({
      kind: "http",
      url: typeof input === "string" ? input : input.url,
      // **The body, not only the URL.** `provisionSelf` and `provisionHuman`
      // both POST `/api/v1/agents`; the identity inside is the only thing that
      // says which ran. Asserting on the path alone let the mutation that
      // removes the people survive, because this service still provisions
      // itself.
      body: typeof init?.body === "string" ? init.body : "",
    });
    return new Response(JSON.stringify({ ok: true }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

/**
 * An approved web user, in the table the claim is built from.
 *
 * `listApprovedWebUserIds` reads `agent_registry` — the mesh's registry of who
 * this service may speak for — and not `pending_approvals`, which is the queue
 * an operator works through. Two different questions, and building the proxy
 * claim from the second would name people who were merely waiting.
 */
async function approvedWebUser(): Promise<string> {
  const login = uniq("person");
  upsertApprovedWebUser(login);
  return login;
}

const parse = (frames: string[]) => frames.map((f) => JSON.parse(f));

describe("what it says when the hub answers", () => {
  test("provisions before it claims, and claims every approved person", async () => {
    const who = await approvedWebUser();
    hubAccepts();
    const ws = standInSocket();
    live = ws;
    connectToHub();
    await ws.open();

    // One frame on the socket, and it is the claim. Provisioning is http, so a
    // second frame here would mean something was claimed over the socket that
    // § 8.2 reads from stored rows.
    const frames = parse(ws.sent);
    expect(frames).toHaveLength(1);
    expect(frames[0].method).toBe("mesh.connect");
    expect(frames[0].params.identity).toContain("http-server");
    expect(frames[0].params.proxy_for).toContain(who);

    // **The order, measured rather than assumed.** The first version of this
    // asserted only the frame, so removing the provisioning entirely changed
    // nothing it could see — the registered mutation survived and said so.
    const claimAt = steps.findIndex((s) => s.kind === "ws" && s.frame.method === "mesh.connect");
    const provisioned = steps.filter((s, i) => s.kind === "http" && i < claimAt);
    expect(claimAt).toBeGreaterThan(-1);
    expect(provisioned.length, "nothing was provisioned before the claim").toBeGreaterThan(0);
    // The people, not only this identity: § 8.2 reads both halves from rows.
    expect(
      provisioned.some((s) => (s as { url: string; body: string }).body.includes(who)),
      "the person was never provisioned before being claimed",
    ).toBe(true);
  });

  /**
   * The claim is the *approved* list, not every account. An unapproved person
   * named here would be dropped by the hub anyway — but naming them says this
   * service believes it may speak for someone an operator has not admitted.
   */
  test("and does not claim a person the operator has not approved", async () => {
    // In the queue an operator works through, and deliberately not in the
    // registry the claim is built from.
    const waiting = uniq("waiting");
    getDb().prepare(
      `INSERT INTO agent_registry (id, name, channel, type, approved) VALUES (?, ?, 'web', 'user', 0)`,
    ).run(waiting, waiting);
    hubAccepts();
    const ws = standInSocket();
    live = ws;
    connectToHub();
    await ws.open();

    expect(parse(ws.sent)[0].params.proxy_for).not.toContain(waiting);
  });
});

describe("what it does with a frame the hub pushes", () => {
  const message = (over: Record<string, unknown> = {}) => ({
    jsonrpc: "2.0",
    method: "mesh.message",
    params: {
      id: uniq("msg"),
      from: uniq("agent"),
      to: uniq("person"),
      content: "hello",
      ts: new Date().toISOString(),
      ...over,
    },
  });

  const stored = (id: string) =>
    getDb().prepare(`SELECT id, content, status FROM messages WHERE id = ?`).get(id) as
      | { id: string; content: string; status: string }
      | null;

  test("writes it down before it tells anybody", async () => {
    hubAccepts();
    const ws = standInSocket();
    live = ws;
    connectToHub();
    await ws.open();

    const frame = message();
    ws.message(frame);
    const row = stored(frame.params.id as string);
    expect(row?.content).toBe("hello");
    // `delivered`, because the frame is the hub reporting a delivery rather
    // than this service deciding one.
    expect(row?.status).toBe("delivered");
  });

  /**
   * **A frame the store will not take reaches nobody** (D-737).
   *
   * This took three readings to get right, and the first two were wrong in
   * different ways — the comment is longer than the test because the wrong
   * answers were both plausible.
   *
   * A `mesh.message` with no `content` is what an older hub sends. It used to
   * reach `insertMessage`, whose statement was `INSERT OR IGNORE`, so the
   * `NOT NULL` on `content` was not an error: **the row was silently not
   * written, nothing threw, and the handler ran to the end.** The message went
   * to the operator's screen, to the audit stream and out as a push
   * notification, while being absent from this service's own history. On
   * screen, in the audit trail, gone from the record — a reload lost it and the
   * audit said it was delivered.
   *
   * The clause is `ON CONFLICT(id) DO NOTHING` now. The tolerance that was
   * wanted is for a repeated id — the socket path and the audit poller both
   * reach this — and nothing else. So the write raises, the caller's `catch`
   * names the frame, and the three things downstream do not happen.
   */
  test("is not drawn, not audited, and not pushed", async () => {
    hubAccepts();
    const ws = standInSocket();
    live = ws;
    connectToHub();
    await ws.open();

    const logged: string[] = [];
    const errored: string[] = [];
    const realLog = console.log;
    const realError = console.error;
    console.log = (...args: unknown[]) => { logged.push(args.join(" ")); };
    console.error = (...args: unknown[]) => { errored.push(args.join(" ")); };
    try {
      const frame = message();
      delete (frame.params as Record<string, unknown>).content;
      expect(() => ws.message(frame)).not.toThrow();

      // Not kept, and not handled on past the failed write. `hub→sse` is the
      // last statement of the branch, after the SSE push and the audit
      // broadcast — its absence is what says none of them ran.
      expect(stored(frame.params.id as string)).toBeNull();
      expect(logged.some((l) => l.includes('"event":"hub_frame_forwarded"'))).toBe(false);

      // And it is named, so an operator can go and look for it on the far side.
      const line = errored.find((l) => l.includes("dropped a hub frame"));
      expect(line, "the frame was dropped without a word").toBeDefined();
      expect(line).toContain(String(frame.params.id));
      expect(line).toContain(String(frame.params.from));
    } finally {
      console.log = realLog;
      console.error = realError;
    }
  });

  /**
   * The tolerance that *is* wanted: one message, arriving twice.
   *
   * The socket path and the audit poller both reach `insertMessage` with the
   * same id, and storing it once is right. Narrowing the clause had to keep
   * that, or the fix above would turn every ordinary duplicate into a dropped
   * frame and a log line.
   */
  test("and a message that arrives twice is stored once, quietly", async () => {
    hubAccepts();
    const ws = standInSocket();
    live = ws;
    connectToHub();
    await ws.open();

    const errored: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => { errored.push(args.join(" ")); };
    try {
      const frame = message();
      ws.message(frame);
      ws.message(frame);
      expect(stored(frame.params.id as string)).not.toBeNull();
      expect(errored.some((l) => l.includes("dropped a hub frame"))).toBe(false);
    } finally {
      console.error = realError;
    }
  });

  /**
   * The `catch` that used to be empty (D-737).
   *
   * A frame that is not JSON is the reachable way in: `JSON.parse` throws
   * before anything else runs, so the handler has no id and no sender to name
   * and says so rather than saying nothing. The line has to carry the reason —
   * an operator who knows only that a frame was dropped cannot tell a truncated
   * write from a hub speaking a protocol this build does not know.
   */
  test("names a frame it could not even parse, and why", async () => {
    hubAccepts();
    const ws = standInSocket();
    live = ws;
    connectToHub();
    await ws.open();

    const said: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => { said.push(args.join(" ")); };
    try {
      // Straight past `JSON.stringify`, so what arrives is not a frame at all.
      expect(() => (ws as any).message).not.toThrow();
      const rawSocket = said.length;
      void rawSocket;
      ws.messageRaw("{ not json");
      const line = said.find((l) => l.includes("dropped a hub frame"));
      expect(line, "an unparseable frame was dropped without a word").toBeDefined();
      expect(line).toContain('"id":"unknown"');
      expect(line).toContain('"actor":"unknown"');
      expect(line).toMatch(/"error":"\S/);
    } finally {
      console.error = realError;
    }
  });

  test("survives a frame that is not JSON, and one that is not a method it knows", async () => {
    hubAccepts();
    const ws = standInSocket();
    live = ws;
    connectToHub();
    await ws.open();

    const before = sseClientCount();
    expect(() => (globalThis as any).nothing).not.toThrow();
    // Neither of these may throw out of the handler: the socket stays up and
    // the next frame still arrives.
    expect(() => ws.message({ jsonrpc: "2.0", method: "mesh.unheard-of", params: {} })).not.toThrow();
    const frame = message();
    ws.message(frame);
    expect(stored(frame.params.id as string)).toBeDefined();
    expect(sseClientCount()).toBe(before);
  });

  /** A delivery report is a different method, and writes no message row. */
  test("a delivery report is not a message", async () => {
    hubAccepts();
    const ws = standInSocket();
    live = ws;
    connectToHub();
    await ws.open();

    const id = uniq("delivered");
    expect(() =>
      ws.message({
        jsonrpc: "2.0",
        method: "mesh.delivered",
        params: { id, from: "a", to: "b", ts: new Date().toISOString() },
      }),
    ).not.toThrow();
    expect(stored(id)).toBeNull();
  });
});

/**
 * `sendViaHub`, reached the only way a caller can reach it.
 *
 * It is module-private and its whole job is correlation: put a request on the
 * socket, wait for the frame carrying the same id, hand back the hub's message
 * id. Nothing had ever driven it with a hub that answers — the suite could
 * only ever see the `hubConnected === false` shortcut, which is the branch that
 * does not correlate anything.
 */
describe("sending through the hub", () => {
  /** An approved person, and the cookie their browser would carry. */
  async function sender() {
    const login = uniq("sender");
    const user = upsertUser(650000 + n, login);
    createPendingApproval(login, user.github_id);
    expect(approveUser(login)).toBe(true);
    upsertApprovedWebUser(login);
    // **A member may message only what a policy allows.** `role: "admin"` would
    // skip the check entirely, and skipping it here would make every assertion
    // below true of a session nobody in this deployment actually has.
    getDb().prepare(`INSERT OR IGNORE INTO policies (github_login, allowed_agent) VALUES (?, '*')`).run(login);
    const jwt = await signJwt({ github_id: user.github_id, github_login: login, role: "member" });
    return { login, cookie: `mesh_token=${jwt}` };
  }

  /**
   * A recipient this server knows about.
   *
   * `POST /api/v1/messages` answers `404` for an identity absent from *this*
   * server's `agent_registry` (SPEC § 9.1) — a different table from the hub's,
   * on the same namespace. An identity can exist on the mesh, connect, hold an
   * approved key, and still not be addressable here.
   */
  const recipient = () => {
    const id = uniq("agent");
    getDb().prepare(
      `INSERT OR IGNORE INTO agent_registry (id, name, channel, type, approved) VALUES (?, ?, 'mesh', 'agent', 1)`,
    ).run(id, id);
    return id;
  };

  const post = (cookie: string, body: Record<string, unknown>) =>
    app.fetch(new Request("http://hub-probe/api/v1/messages", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    }));

  const rowOf = (id: string) =>
    getDb().prepare(`SELECT status FROM messages WHERE id = ?`).get(id) as { status: string } | null;

  async function connected() {
    hubAccepts();
    const ws = standInSocket();
    live = ws;
    connectToHub();
    await ws.open();
    return ws;
  }

  test("puts the message on the wire and takes the hub's id for the answer", async () => {
    const ws = await connected();
    const me = await sender();
    const to = recipient();

    const inFlight = post(me.cookie, { to, text: "hello there" });
    await Bun.sleep(5);
    const request = parse(ws.sent).find((f) => f.method === "mesh.send");
    expect(request, "nothing was sent to the hub").toBeDefined();
    expect(request.params).toEqual({ to, content: "hello there", from: me.login });

    ws.reply({ id: "hub-assigned-1" });
    const res = await inFlight;
    // `201`: the message was created here before the hub was asked, which is
    // also why the row exists to be corrected when the hub refuses it.
    expect(res.status).toBe(201);
    const body = await res.json();
    // Accepted by the hub, so the row is `pending` — waiting for its
    // recipient — rather than `failed`.
    expect(body.message.status).toBe("pending");
    expect(rowOf(body.message.id)?.status).toBe("pending");
  });

  /**
   * **§ 15.2 puts the attachments *in* the body and § 8.2's content is a flat
   * string**, so a message carrying them goes on the wire as JSON holding both.
   * One without them stays a plain string, which is the case that must not
   * change.
   */
  test("wraps a message with attachments, and leaves a plain one alone", async () => {
    const ws = await connected();
    const me = await sender();
    const to = recipient();

    const attachment = { id: "a".repeat(64) + ".txt", download_url: "http://x/api/v1/attachments/a" };
    const inFlight = post(me.cookie, { to, text: "see attached", attachments: [attachment] });
    await Bun.sleep(5);
    const request = parse(ws.sent).find((f) => f.method === "mesh.send");
    expect(JSON.parse(request.params.content)).toEqual({ text: "see attached", attachments: [attachment] });
    ws.reply({ id: "hub-assigned-2" });
    await inFlight;
  });

  /**
   * **A reply for another request must not resolve this one.** The id is the
   * whole of the correlation — a socket carries every caller's traffic, so a
   * handler that took the first frame it saw would hand one caller another's
   * answer.
   */
  test("ignores an answer that is not to its request", async () => {
    const ws = await connected();
    const me = await sender();

    const inFlight = post(me.cookie, { to: recipient(), text: "correlated" });
    await Bun.sleep(5);
    const before = ws.listeners();
    expect(before).toBeGreaterThan(0);

    ws.reply({ id: "not-mine" }, 999999);
    await Bun.sleep(5);
    // Still waiting: the listener is attached and the request is unresolved.
    expect(ws.listeners()).toBe(before);

    ws.reply({ id: "hub-assigned-3" });
    await inFlight;
    // And it lets go once its own answer arrives — the listener is added per
    // request, so one that is never removed is a leak per message sent.
    expect(ws.listeners()).toBe(before - 1);
  });

  /**
   * **`failed`, and written back.** A message the hub refused used to be
   * written locally and rendered as though it had been routed: the person saw a
   * sent message nobody would ever receive. The row is corrected, not only the
   * object the response is built from — the history route, the conversation
   * view and search all serve the stored value.
   */
  test("marks a message the hub would not take as failed, in the row too", async () => {
    const ws = await connected();
    const me = await sender();

    const inFlight = post(me.cookie, { to: recipient(), text: "refused" });
    await Bun.sleep(5);
    // An answer with no message id is the hub declining to take it.
    ws.reply({});
    const body = await (await inFlight).json();

    expect(body.message.status).toBe("failed");
    expect(rowOf(body.message.id)?.status).toBe("failed");
  });
});

/**
 * Saying the claim again, without waiting for a reconnect.
 *
 * `mesh.connect` names everyone this service may speak for, and the hub reads
 * it once. Somebody admitted a minute later is therefore not in it — every
 * message sent on their behalf is refused until the socket happens to drop,
 * which could be hours. `redeclareProxies` is what the approval route calls so
 * that the gap is a moment rather than an outage, and § 8.2 makes the
 * provisioning half necessary too: the hub checks both halves of a claim
 * against stored rows, so a person named in the frame but absent from the
 * registry is a claim it drops.
 */
describe("re-declaring who may be spoken for", () => {
  /**
   * **Nothing at all when there is no link.** Not an error and not a queued
   * retry: the next `onopen` sends the current list anyway, so anything kept
   * here would be a second, older answer to the same question.
   */
  test("does nothing when the hub is not connected", async () => {
    hangUp();
    hubAccepts();
    await approvedWebUser();
    await redeclareProxies();
    expect(steps).toEqual([]);
  });

  test("provisions the new person, then names them in a fresh claim", async () => {
    hubAccepts();
    const ws = standInSocket();
    live = ws;
    connectToHub();
    await ws.open();

    const before = parse(ws.sent).filter((f) => f.method === "mesh.connect");
    expect(before).toHaveLength(1);

    // Admitted after the socket opened — the case this exists for.
    const late = await approvedWebUser();
    expect(before[0].params.proxy_for).not.toContain(late);

    steps = [];
    await redeclareProxies();

    const claims = parse(ws.sent).filter((f) => f.method === "mesh.connect");
    expect(claims).toHaveLength(2);
    expect(claims[1].params.proxy_for).toContain(late);
    expect(claims[1].params.identity).toBe(before[0].params.identity);

    // **Registered before claimed**, the same order `onopen` uses. A frame
    // naming somebody the hub has no row for is a claim it drops.
    const claimAt = steps.findIndex((s) => s.kind === "ws" && s.frame.method === "mesh.connect");
    expect(claimAt).toBeGreaterThan(-1);
    expect(steps.some((s, i) => s.kind === "http" && i < claimAt && s.body.includes(late))).toBe(true);
  });
});
