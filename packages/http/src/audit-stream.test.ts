/**
 * The audit stream, and the gap it fills on reconnect (§ 11.0.1, § 8.9.5).
 *
 * This route serves whole message bodies, so it is gated on
 * `audit.read.content` and **records the read before opening the stream** —
 * the capability note is explicit that holding that grant is defensible and
 * holding it without the record is not.
 *
 * The gap fetch is the half worth testing. `EventSource` re-attaches the last
 * `id:` it saw, and a reconnect that silently skipped what happened in between
 * would leave an operator watching a stream that looks live and is missing
 * messages — the failure mode an audit console cannot have. Above a hundred it
 * says so instead, because a client that has been away for an hour wants to
 * know it was away rather than to receive the hour.
 *
 * **The poller is not driven here.** `startAuditPoller` installs a 1.5s
 * interval and is called only under `import.meta.main`; a repeating timer left
 * in a shared test process fires inside whatever file runs next. Same
 * judgement as the reconnect timer in `hub-link.test.ts`.
 *
 * This file owns the `aud-` prefix.
 */
import { describe, expect, test } from "bun:test";

process.env.JWT_SECRET ||= "audit-stream-probe";

const { app, connectToHub } = await import("./main.ts");
const { upsertUser, approveUser, createPendingApproval } = await import("./db");
const { signJwt } = await import("./auth");
const { STORE_FILES, agentsSchema, auditSchema, grants, hubSchema, openAt, openStore, stateDir } =
  await import("@agent-mesh/store");
const { CAPABILITY } = await import("@agent-mesh/contracts");
const { join } = await import("node:path");

const agentsDb = openAt(join(stateDir(), STORE_FILES.agents), { create: true });
agentsSchema.migrate(agentsDb);
grants.migrate(agentsDb);

/** The hub's store — the gap fetch reads `messages` out of it. */
const hub = openStore("hub", { create: true });
hubSchema.migrate(hub);

/**
 * The access log's store, created here because `audit-access-log.ts` opens it
 * `create: false` on purpose: the module that records a read must not be the
 * one that decides the store exists. Without this the route answers `503` and
 * every test below would be measuring the refusal path.
 */
const auditDb = openAt(join(stateDir(), STORE_FILES.audit), { create: true });
auditSchema.migrate(auditDb);

let n = 0;
const uniq = (p: string) => `aud-${p}-${++n}-${process.pid}`;

async function holder(...caps: string[]) {
  const login = uniq("op");
  const user = upsertUser(900000 + n, login);
  createPendingApproval(login, user.github_id);
  expect(approveUser(login)).toBe(true);
  for (const capability of caps) {
    grants.grant(agentsDb, { subject: login, capability, grantedBy: "audit-stream-test" });
  }
  const jwt = await signJwt({ github_id: user.github_id, github_login: login, role: "member" });
  return { login, cookie: `mesh_token=${jwt}` };
}

/** A message in the hub's table, at a time this test chose. */
function said(o: { from?: string; to?: string; content?: string; ts: string }): string {
  const id = uniq("msg");
  hub.prepare(
    `INSERT INTO messages (id, from_agent, to_agent, content, status, ts)
     VALUES (?, ?, ?, ?, 'delivered', ?)`,
  ).run(id, o.from ?? uniq("from"), o.to ?? uniq("to"), o.content ?? "hello", o.ts);
  return id;
}

const open = (query: string, cookie: string, headers: Record<string, string> = {}) =>
  app.fetch(new Request(`http://aud-probe/api/v1/admin/chat-audits/stream${query}`, {
    headers: { cookie, ...headers },
  }));

/**
 * Everything the stream has already queued, and nothing it has not.
 *
 * The route's `start()` runs while the `ReadableStream` is constructed, so the
 * connection comment and the whole gap replay are enqueued before `app.fetch`
 * resolves. Reading until the queue drains is therefore complete rather than
 * racy — and the reader is cancelled, which is what clears the 30s keepalive.
 */
async function drain(res: Response, expected: number): Promise<string[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: string[] = [];
  try {
    while (frames.length < expected) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((r) => {
          timer = setTimeout(() => r({ value: undefined, done: true }), 500);
        }),
      ]);
      clearTimeout(timer);
      if (done || !value) break;
      frames.push(decoder.decode(value));
    }
  } finally {
    await reader.cancel();
  }
  return frames;
}

const events = (frames: string[]) =>
  frames.join("").split("\n\n").filter(Boolean);

describe("who may watch", () => {
  /**
   * Not the role check it used to have. Every admin-role session read every
   * conversation on the mesh and nothing recorded that it had.
   */
  test("refuses a caller without audit.read.content", async () => {
    expect((await open("", "")).status).toBe(401);
    const metadataOnly = await holder(CAPABILITY.AUDIT_READ_METADATA);
    const res = await open("", metadataOnly.cookie);
    expect(res.status).toBe(403);
    expect((await res.json()).capability).toBe(CAPABILITY.AUDIT_READ_CONTENT);
  });

  /** The read is recorded before the stream opens, and names what was asked for. */
  test("records the read, with the query and not the content", async () => {
    const op = await holder(CAPABILITY.AUDIT_READ_CONTENT);
    const before = (auditDb.prepare(
      `SELECT count(*) AS n FROM audit_events WHERE event_type = 'mesh.identity.audit_read' AND identity = ?`,
    ).get(op.login) as { n: number }).n;

    said({ to: "watched", content: "a secret nobody should find in the log", ts: "2026-04-01 00:00:00" });
    const res = await open("?to_agent=watched", op.cookie);
    await drain(res, 1);

    const row = auditDb.prepare(
      `SELECT payload FROM audit_events
        WHERE event_type = 'mesh.identity.audit_read' AND identity = ?
        ORDER BY rowid DESC LIMIT 1`,
    ).get(op.login) as { payload: string };
    const after = (auditDb.prepare(
      `SELECT count(*) AS n FROM audit_events WHERE event_type = 'mesh.identity.audit_read' AND identity = ?`,
    ).get(op.login) as { n: number }).n;

    expect(after).toBe(before + 1);
    const payload = JSON.parse(row.payload);
    expect(payload.change.read).toBe("chat-audits:stream");
    expect(payload.change.query).toEqual({ to_agent: "watched" });
    expect(row.payload).not.toContain("a secret nobody should find");
  });
});

describe("opening the stream", () => {
  test("answers an event-stream that is not cached or transformed", async () => {
    const op = await holder(CAPABILITY.AUDIT_READ_CONTENT);
    const res = await open("", op.cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-transform");
    await drain(res, 1);
  });

  /** A comment first, so a client observes the connection rather than inferring it. */
  test("says it is connected before anything else", async () => {
    const op = await holder(CAPABILITY.AUDIT_READ_CONTENT);
    const res = await open("", op.cookie);
    expect((await drain(res, 1))[0]).toBe(":connected\n\n");
  });
});

describe("the gap after a reconnect", () => {
  /** No anchor means no replay — a first connection is not a client that fell behind. */
  test("replays nothing when no last id is offered", async () => {
    const op = await holder(CAPABILITY.AUDIT_READ_CONTENT);
    said({ ts: "2026-05-01 00:00:00" });
    const frames = await drain(await open("", op.cookie), 2);
    expect(frames).toEqual([":connected\n\n"]);
  });

  /** An id this hub never saw cannot anchor a range, so nothing is guessed. */
  test("replays nothing when the anchor is unknown", async () => {
    const op = await holder(CAPABILITY.AUDIT_READ_CONTENT);
    said({ ts: "2026-05-02 00:00:00" });
    const frames = await drain(await open("?last_event_id=never-existed", op.cookie), 2);
    expect(frames).toEqual([":connected\n\n"]);
  });

  /**
   * Everything after the anchor, oldest first, marked `recovered` so a console
   * can tell a replay from a live message — and carrying `id:` so the *next*
   * reconnect anchors on the last one replayed rather than on the last one
   * seen live.
   */
  test("replays what happened while the client was away", async () => {
    const op = await holder(CAPABILITY.AUDIT_READ_CONTENT);
    const to = uniq("watched");
    const anchor = said({ to, content: "seen", ts: "2026-06-01 00:00:00" });
    const missed1 = said({ to, content: "missed one", ts: "2026-06-02 00:00:00" });
    const missed2 = said({ to, content: "missed two", ts: "2026-06-03 00:00:00" });

    const frames = events(await drain(
      await open(`?to_agent=${to}&last_event_id=${anchor}`, op.cookie), 3));
    expect(frames[0]).toBe(":connected");

    const replayed = frames.slice(1).map((f) => JSON.parse(f.split("data: ")[1]!));
    expect(replayed.map((m) => m.id)).toEqual([missed1, missed2]);
    expect(replayed.every((m) => m.recovered === true)).toBe(true);
    expect(replayed[0].content).toBe("missed one");
    expect(frames[1]).toContain(`id: ${missed1}`);
  });

  /** The header is what a browser sends; the query is for everything else. */
  test("takes the anchor from Last-Event-ID as well as the query", async () => {
    const op = await holder(CAPABILITY.AUDIT_READ_CONTENT);
    const to = uniq("watched");
    const anchor = said({ to, ts: "2026-06-04 00:00:00" });
    const missed = said({ to, ts: "2026-06-05 00:00:00" });

    const frames = events(await drain(
      await open(`?to_agent=${to}`, op.cookie, { "Last-Event-ID": anchor }), 2));
    expect(frames).toHaveLength(2);
    expect(JSON.parse(frames[1]!.split("data: ")[1]!).id).toBe(missed);
  });

  /**
   * **The filters bound the replay too.** A stream filtered to one pair that
   * replayed the whole mesh on reconnect would hand an operator content their
   * filter said they were not reading.
   */
  test("applies the filters to the replay, not only to what comes after", async () => {
    const op = await holder(CAPABILITY.AUDIT_READ_CONTENT);
    const mine = uniq("mine");
    const other = uniq("other");
    const anchor = said({ to: mine, ts: "2026-07-01 00:00:00" });
    said({ to: other, content: "not mine", ts: "2026-07-02 00:00:00" });
    const wanted = said({ to: mine, content: "haystack NEEDLE haystack", ts: "2026-07-03 00:00:00" });
    said({ to: mine, content: "no match here", ts: "2026-07-04 00:00:00" });

    const frames = events(await drain(
      await open(`?to_agent=${mine}&search=NEEDLE&last_event_id=${anchor}`, op.cookie), 3));
    const replayed = frames.slice(1).map((f) => JSON.parse(f.split("data: ")[1]!));
    expect(replayed.map((m) => m.id)).toEqual([wanted]);
  });

  test("bounds the replay by sender as well", async () => {
    const op = await holder(CAPABILITY.AUDIT_READ_CONTENT);
    const to = uniq("watched");
    const speaker = uniq("speaker");
    const anchor = said({ to, ts: "2026-07-10 00:00:00" });
    said({ from: uniq("stranger"), to, ts: "2026-07-11 00:00:00" });
    const wanted = said({ from: speaker, to, ts: "2026-07-12 00:00:00" });

    const frames = events(await drain(
      await open(`?from_agent=${speaker}&to_agent=${to}&last_event_id=${anchor}`, op.cookie), 3));
    const replayed = frames.slice(1).map((f) => JSON.parse(f.split("data: ")[1]!));
    expect(replayed.map((m) => m.id)).toEqual([wanted]);
  });

  /**
   * Past a hundred it sends the *number*, not the hour. A client that has been
   * away that long needs to know it was away — replaying silently would make a
   * partial view look complete, and replaying all of it would spend the
   * console's memory on history it can page through instead.
   */
  test("answers a count rather than an hour of messages", async () => {
    const op = await holder(CAPABILITY.AUDIT_READ_CONTENT);
    const to = uniq("flooded");
    const anchor = said({ to, ts: "2026-08-01 00:00:00" });
    for (let i = 0; i < 101; i++) {
      said({ to, ts: `2026-08-02 ${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00` });
    }

    const frames = events(await drain(
      await open(`?to_agent=${to}&last_event_id=${anchor}`, op.cookie), 5));
    expect(frames).toHaveLength(2);
    expect(frames[1]).toContain("event: gap-too-large");
    const data = JSON.parse(frames[1]!.split("data: ")[1]!);
    expect(data).toEqual({ count: 101, truncated: true, last_event_id: anchor });
  });

  /**
   * A hundred exactly is still sent. The boundary is `> 100`, and an off-by-one
   * here is the difference between a client receiving its gap and being told
   * the gap was too large to send.
   */
  test("sends a hundred, and refuses only past it", async () => {
    const op = await holder(CAPABILITY.AUDIT_READ_CONTENT);
    const to = uniq("hundred");
    const anchor = said({ to, ts: "2026-09-01 00:00:00" });
    for (let i = 0; i < 100; i++) {
      said({ to, ts: `2026-09-02 ${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00` });
    }
    const frames = events(await drain(
      await open(`?to_agent=${to}&last_event_id=${anchor}`, op.cookie), 102));
    expect(frames).toHaveLength(101);
    expect(frames.join("")).not.toContain("gap-too-large");
  });

  /**
   * Two messages sharing a timestamp are ordered by id, and the anchor's own
   * tie is excluded — `ts > ? OR (ts = ? AND id > ?)`. Dropping the second half
   * would replay the anchor itself to every reconnecting client.
   */
  test("does not replay the anchor to the client that already has it", async () => {
    const op = await holder(CAPABILITY.AUDIT_READ_CONTENT);
    const to = uniq("tied");
    const ts = "2026-10-01 00:00:00";
    const ids = [said({ to, ts }), said({ to, ts }), said({ to, ts })].sort();
    const anchor = ids[1]!;

    const frames = events(await drain(
      await open(`?to_agent=${to}&last_event_id=${anchor}`, op.cookie), 3));
    const replayed = frames.slice(1).map((f) => JSON.parse(f.split("data: ")[1]!));
    expect(replayed.map((m) => m.id)).toEqual([ids[2]]);
  });

  /** An empty filter string is no filter, not a filter matching the empty string. */
  test("treats a blank filter as absent", async () => {
    const op = await holder(CAPABILITY.AUDIT_READ_CONTENT);
    const to = uniq("blank");
    const anchor = said({ to, ts: "2026-11-01 00:00:00" });
    const after = said({ to, ts: "2026-11-02 00:00:00" });
    const frames = events(await drain(
      await open(`?from_agent=&to_agent=${to}&search=&last_event_id=${anchor}`, op.cookie), 3));
    const replayed = frames.slice(1).map((f) => JSON.parse(f.split("data: ")[1]!));
    expect(replayed.map((m) => m.id)).toEqual([after]);
  });
});

// --- What reaches a watcher (broadcastAuditMessage, auditMatchesFilters) ---
//
// Both are module-private and neither is reachable from a route: the only
// callers are the hub socket's `onmessage` and the audit poller. The poller
// installs a repeating timer, so the socket is the door used here.

/**
 * A stream held open, read frame by frame.
 *
 * **The pending read is kept, not abandoned.** Racing `read()` against a
 * timeout and dropping the loser leaves that read live, and it takes the *next*
 * chunk — so a test that asserts "nothing arrived" swallows the frame the
 * following assertion is waiting for. Three tests failed that way before the
 * promise was held across calls, all of them looking like a filter bug.
 */
function subscribe(query: string, cookie: string) {
  const res = app.fetch(new Request(
    `http://aud-probe/api/v1/admin/chat-audits/stream${query}`, { headers: { cookie } }));
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  let pending: ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> | null = null;
  const decoder = new TextDecoder();
  return {
    async ready() { reader = (await res).body!.getReader(); return this; },
    /** The next frame, or `null` if nothing arrives promptly. */
    async next(): Promise<string | null> {
      if (!pending) pending = reader.read();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const out = await Promise.race([
        pending,
        new Promise<null>((r) => { timer = setTimeout(() => r(null), 300); }),
      ]);
      clearTimeout(timer);
      if (!out) return null;
      pending = null;
      return out.value ? decoder.decode(out.value) : null;
    },
    async close() { await reader.cancel(); },
  };
}

/**
 * A socket that delivers frames and nothing else.
 *
 * `connectToHub` installs `onmessage` while it constructs the socket, so a
 * frame can be handed to it without the handshake — `onopen` is what
 * provisions and claims, and none of that is what these tests are about.
 * `onerror` puts the module back to *not connected* without scheduling the
 * five-second reconnect `onclose` would.
 */
function frameDoor() {
  let ws: any;
  const real = globalThis.WebSocket;
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
    hangUp() { ws.onerror(); globalThis.WebSocket = real; },
  };
}

const said2 = (o: Record<string, unknown>) => ({
  id: uniq("live"), from: uniq("from"), to: uniq("to"), content: "hello",
  reply_to: null, ts: "2027-01-01 00:00:00", ...o,
});

describe("what a watcher receives", () => {
  test("hands a live frame to a subscriber, with an id to reconnect on", async () => {
    const op = await holder(CAPABILITY.AUDIT_READ_CONTENT);
    const s = await subscribe("", op.cookie).ready();
    expect(await s.next()).toBe(":connected\n\n");

    const door = frameDoor();
    const msg = said2({ content: "live one" });
    door.deliver(msg);

    const frame = (await s.next())!;
    expect(frame).toContain(`id: ${msg.id}`);
    expect(frame).toContain("event: message");
    const data = JSON.parse(frame.split("data: ")[1]!);
    expect(data).toMatchObject({
      id: msg.id, from_agent: msg.from, to_agent: msg.to,
      content: "live one", reply_to: null, status: "delivered",
    });
    door.hangUp();
    await s.close();
  });

  /**
   * **The same id arrives twice.** The hub socket and the audit poller both
   * see every message, so without this a console shows every conversation
   * doubled.
   */
  test("sends one id once", async () => {
    const op = await holder(CAPABILITY.AUDIT_READ_CONTENT);
    const s = await subscribe("", op.cookie).ready();
    await s.next();

    const door = frameDoor();
    const msg = said2({});
    door.deliver(msg);
    door.deliver(msg);

    expect((await s.next())!).toContain(msg.id);
    expect(await s.next()).toBeNull();
    door.hangUp();
    await s.close();
  });

  /**
   * The guard remembers the last two hundred and no more. Past that an id is
   * new again — bounded memory bought with a duplicate nobody will see, since
   * two hundred messages have gone by in between.
   */
  test("forgets an id after two hundred others", async () => {
    const op = await holder(CAPABILITY.AUDIT_READ_CONTENT);
    const door = frameDoor();
    const msg = said2({});
    door.deliver(msg);                                   // remembered, nobody watching
    for (let i = 0; i < 200; i++) door.deliver(said2({}));

    const s = await subscribe("", op.cookie).ready();
    await s.next();
    door.deliver(msg);
    expect((await s.next())!).toContain(msg.id);
    door.hangUp();
    await s.close();
  });

  /** A filtered stream is filtered — the sender, the recipient, and the text. */
  test("passes only what the filters name", async () => {
    const op = await holder(CAPABILITY.AUDIT_READ_CONTENT);
    const from = uniq("speaker");
    const to = uniq("listener");
    const s = await subscribe(`?from_agent=${from}&to_agent=${to}&search=needle`, op.cookie).ready();
    await s.next();

    const door = frameDoor();
    door.deliver(said2({ from: uniq("someone-else"), to, content: "a needle here" }));
    door.deliver(said2({ from, to: uniq("someone-else"), content: "a needle here" }));
    door.deliver(said2({ from, to, content: "no match" }));
    expect(await s.next()).toBeNull();

    const wanted = said2({ from, to, content: "a NEEDLE in a haystack" });
    door.deliver(wanted);
    expect((await s.next())!).toContain(wanted.id);      // search is case-insensitive
    door.hangUp();
    await s.close();
  });

  /** Two watchers with different filters each get their own answer. */
  test("decides per subscriber, not per message", async () => {
    const op = await holder(CAPABILITY.AUDIT_READ_CONTENT);
    const mine = uniq("mine");
    const watching = await subscribe(`?to_agent=${mine}`, op.cookie).ready();
    const everything = await subscribe("", op.cookie).ready();
    await watching.next();
    await everything.next();

    const door = frameDoor();
    const elsewhere = said2({ to: uniq("elsewhere") });
    door.deliver(elsewhere);
    expect(await watching.next()).toBeNull();
    expect((await everything.next())!).toContain(elsewhere.id);

    door.hangUp();
    await watching.close();
    await everything.close();
  });

  /**
   * **An id cannot open a frame of its own.** `id:` is a line in the envelope,
   * so a newline inside a message id would let the sender inject SSE fields
   * into the watcher's stream.
   */
  test("strips newlines out of the id line", async () => {
    const op = await holder(CAPABILITY.AUDIT_READ_CONTENT);
    const s = await subscribe("", op.cookie).ready();
    await s.next();

    const door = frameDoor();
    const msg = said2({ id: `${uniq("evil")}\nevent: injected\ndata: {}\n` });
    door.deliver(msg);

    // The injected text survives as text — what it must not do is start a
    // line. `id:` is one line of the envelope, and stripping the newlines is
    // what keeps it one line.
    const frame = (await s.next())!;
    const lines = frame.split("\n");
    expect(lines[0]).toBe(`id: ${msg.id.replace(/\n/g, "")}`);
    expect(lines.filter((l) => l.startsWith("event:"))).toEqual(["event: message"]);
    expect(lines.filter((l) => l.startsWith("data:"))).toHaveLength(1);
    door.hangUp();
    await s.close();
  });
});
