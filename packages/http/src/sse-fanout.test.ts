/**
 * What reaches a browser when the hub delivers, and what happens to a browser
 * that has gone.
 *
 * `pushToSSE` fans one hub frame out to both directions of a conversation —
 * the recipient's stream and the sender's, so a person watching their own
 * outbox sees the message land. Nothing had ever driven it with a client
 * actually registered: every existing test that pushes a hub frame does so with
 * an empty client set, so the guard at the top returned and the five lines
 * below it never ran.
 *
 * **The line worth having is the `catch`.** A controller whose reader has gone
 * throws on `enqueue`, and the entry is dropped there and nowhere else — a leak
 * here is invisible until a long-lived process is writing to thousands of dead
 * controllers.
 *
 * `hasActiveSSE` is *not* covered here and cannot be: its only caller checks
 * for VAPID keys first, and those are read at module load. Reaching it means
 * setting them for the whole run, which turns every send in the suite into a
 * push attempt. Same held bucket as `sendPushForMessage` itself.
 *
 * This file owns the `fan-` prefix.
 */
import { afterEach, describe, expect, test } from "bun:test";

process.env.JWT_SECRET ||= "sse-fanout-probe";

const { app, connectToHub, sseClientCount } = await import("./main.ts");
const { upsertUser, approveUser, createPendingApproval } = await import("./db");
const { signJwt } = await import("./auth");

let n = 0;
const uniq = (p: string) => `fan-${p}-${++n}-${process.pid}`;

const realWs = globalThis.WebSocket;
afterEach(() => { globalThis.WebSocket = realWs; });

async function person() {
  const login = uniq("person");
  const user = upsertUser(990000 + n, login);
  createPendingApproval(login, user.github_id);
  expect(approveUser(login)).toBe(true);
  const jwt = await signJwt({ github_id: user.github_id, github_login: login, role: "member" });
  return { login, authorization: `Bearer ${jwt}` };
}

/** A browser watching one conversation. */
async function watching(agentId: string, cookie: string) {
  const res = await app.fetch(new Request(`http://fan-probe/api/v1/events/${agentId}`, {
    headers: { authorization: cookie },
  }));
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  const next = async (): Promise<string> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const out = await Promise.race([
      reader.read(),
      new Promise<null>((r) => { timer = setTimeout(() => r(null), 300); }),
    ]);
    clearTimeout(timer);
    if (!out) return "";
    const text = out.value ? decoder.decode(out.value) : "";
    seen += text;
    return text;
  };
  return { reader, next, all: () => seen };
}

/**
 * A socket that delivers frames and nothing else — `connectToHub` installs
 * `onmessage` while it constructs the socket, and the handshake is not what
 * these tests are about. `onerror` puts the module back to *not connected*
 * without scheduling the five-second reconnect `onclose` would.
 */
function frameDoor() {
  let ws: any;
  globalThis.WebSocket = function (this: any) {
    ws = this;
    this.send = () => {};
    this.addEventListener = () => {};
    this.removeEventListener = () => {};
    this.close = () => {};
    return this;
  } as any;
  connectToHub();
  return {
    deliver(params: Record<string, unknown>) {
      ws.onmessage({ data: JSON.stringify({ jsonrpc: "2.0", method: "mesh.message", params }) });
    },
    hangUp() { ws.onerror(); },
  };
}

const frame = (o: Record<string, unknown>) => ({
  id: uniq("msg"), content: "hello", reply_to: null, ts: "2027-02-02 00:00:00", ...o,
});

describe("what reaches a watching browser", () => {
  test("delivers the hub's frame to the conversation being watched", async () => {
    const who = await person();
    const agent = uniq("agent");
    const view = await watching(agent, who.authorization);
    expect(await view.next()).toContain("event: connected");

    const door = frameDoor();
    const msg = frame({ from: agent, to: who.login, content: "from the agent" });
    door.deliver(msg);

    const got = await view.next();
    expect(got).toContain("event: message");
    const data = JSON.parse(got.split("data: ")[1]!);
    expect(data).toMatchObject({
      id: msg.id, from: agent, to: who.login, content: "from the agent", status: "delivered",
    });

    door.hangUp();
    await view.reader.cancel();
  });

  /**
   * **Both directions.** The same frame is pushed to `from:to` and to `to:from`
   * — a person watching their own outbox has the second key, and without it a
   * message they sent never appears as sent.
   */
  test("reaches the sender's own view as well as the recipient's", async () => {
    const who = await person();
    const agent = uniq("agent");
    const inbox = await watching(agent, who.authorization);
    await inbox.next();

    const door = frameDoor();
    // `to` is the person: this is the direction the recipient watches.
    door.deliver(frame({ from: agent, to: who.login, content: "inbound" }));
    expect(await inbox.next()).toContain("inbound");

    // And the reverse pair, which the *other* push covers.
    door.deliver(frame({ from: who.login, to: agent, content: "outbound" }));
    expect(await inbox.next()).toContain("outbound");

    door.hangUp();
    await inbox.reader.cancel();
  });

  /** A conversation nobody is watching costs nothing and reaches nobody. */
  test("does not deliver another conversation's frame", async () => {
    const who = await person();
    const agent = uniq("agent");
    const view = await watching(agent, who.authorization);
    await view.next();

    const door = frameDoor();
    door.deliver(frame({ from: uniq("elsewhere"), to: uniq("somebody"), content: "not yours" }));
    expect(await view.next()).toBe("");

    door.hangUp();
    await view.reader.cancel();
  });

  /**
   * **The dead controller is dropped where it throws and nowhere else.** A
   * browser that closed its tab leaves a controller that rejects `enqueue`, and
   * without the `catch` the set grows for the life of the process — a leak
   * nothing reports until it is writing to thousands of them.
   */
  test("forgets a browser that has gone, the next time it writes", async () => {
    const who = await person();
    const agent = uniq("agent");
    const view = await watching(agent, who.authorization);
    await view.next();

    const before = sseClientCount();
    await view.reader.cancel();                       // the tab closes
    expect(sseClientCount()).toBe(before);            // nothing noticed yet

    const door = frameDoor();
    door.deliver(frame({ from: agent, to: who.login }));
    expect(sseClientCount()).toBe(before - 1);

    // And a second write finds nothing left to drop rather than throwing.
    door.deliver(frame({ from: agent, to: who.login }));
    expect(sseClientCount()).toBe(before - 1);
    door.hangUp();
  });
});
