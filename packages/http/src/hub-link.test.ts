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

const { app, connectToHub, sseClientCount } = await import("./main.ts");
const { getDb, upsertApprovedWebUser } = await import("./db");
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
  globalThis.WebSocket = function (this: any) {
    ws = this;
    this.send = (frame: string) => {
      sent.push(frame);
      steps.push({ kind: "ws", frame: JSON.parse(frame) });
    };
    this.addEventListener = () => {};
    this.removeEventListener = () => {};
    this.close = () => {};
    return this;
  } as any;

  return {
    sent,
    open: async () => { await ws.onopen(); },
    message: (frame: unknown) => ws.onmessage({ data: JSON.stringify(frame) }),
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
   * **A frame this service cannot store is dropped, and nothing says so.**
   *
   * Measured, not reasoned. A `mesh.message` with no `content` — what an older
   * hub would send — reaches `insertMessage`, which throws on the missing
   * column, and the handler's `catch {}` swallows it. No row, no SSE push, no
   * audit event, no log line. The hub has recorded a delivery and this side has
   * nothing at all.
   *
   * That also makes the `?? ''` three lines below unreachable. Its comment says
   * it is kept as the only thing between an older hub and an audit row reading
   * *empty body* where the truth is *no body* — but a frame that would exercise
   * it dies before it gets there, so the audit row it protects is never written
   * either way. The reasoning is sound and the ordering defeats it.
   *
   * Pinned as it behaves rather than as it ought to. Raised with
   * `agent-mesh-local-pm`: what to do about a swallowed frame is a decision
   * about this service's contract with the hub, not a test's to make.
   */
  test("drops a frame it cannot store, silently", async () => {
    hubAccepts();
    const ws = standInSocket();
    live = ws;
    connectToHub();
    await ws.open();

    const frame = message();
    delete (frame.params as Record<string, unknown>).content;
    expect(() => ws.message(frame)).not.toThrow();
    expect(stored(frame.params.id as string)).toBeNull();
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
