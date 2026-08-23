/**
 * The two server-sent streams, and the search beside them.
 *
 * All three were uncovered for the same reason the OAuth callback was: they
 * look like they need something this process does not have. They do not. A
 * stream handler returns a `Response` whose body is a `ReadableStream`, and
 * `app.fetch` hands it straight back — so the first frames, the headers, and
 * what happens when the client goes away are all reachable in a plain test.
 *
 * **The abort path is the half worth the trouble.** Both streams register the
 * caller in a module-level set and unregister on the way out; a leak there is
 * invisible until a long-lived process has thousands of dead controllers and
 * starts writing to them. Nothing had ever closed one of these connections.
 */
import { describe, expect, test } from "bun:test";

process.env.JWT_SECRET ||= "streams-probe";

const { app, sseClientCount } = await import("./main.ts");
const { getDb, upsertUser, approveUser, createPendingApproval } = await import("./db");
const { signJwt } = await import("./auth");
const { STORE_FILES, agentsSchema, grants, openAt, stateDir } = await import("@agent-mesh/store");
const { join } = await import("node:path");

/**
 * Grants live in the agents store, not this service's own.
 *
 * `requireCapability` reads them from there — the grant table is the mesh's
 * answer about a subject, and http keeps its sessions and messages separately.
 * Opened here for writing because `main.ts` holds its handle privately.
 */
const agentsDb = openAt(join(stateDir(), STORE_FILES.agents), { create: true });
agentsSchema.migrate(agentsDb);
// `role_grants` has its own migration, in the module that owns it — the agents
// schema does not create it, which is how a caller learns the grant table is a
// separate thing rather than a column on an identity.
grants.migrate(agentsDb);
const { CAPABILITY } = await import("@agent-mesh/contracts");

let n = 0;
const uniq = (p: string) => `sse-${p}-${++n}-${process.pid}`;

/** An approved person, and the cookie their browser would carry. */
async function person(): Promise<{ login: string; authorization: string }> {
  const login = uniq("person");
  const user = upsertUser(700000 + n, login);
  createPendingApproval(login, user.github_id);
  expect(approveUser(login)).toBe(true);
  // `member`, stated: `upsertUser` makes the first user of an empty table an
  // admin, and an admin is approved by definition — so reading the role back
  // would make approval depend on how many people the table already held.
  const jwt = await signJwt({ github_id: user.github_id, github_login: login, role: "member" });
  return { login, authorization: `Bearer ${jwt}` };
}

/** A message this person is party to, so search has something to find. */
const say = (from: string, to: string, content: string) =>
  getDb().prepare(
    `INSERT INTO messages (id, from_agent, to_agent, content, status, ts)
     VALUES (?, ?, ?, ?, 'delivered', datetime('now'))`,
  ).run(uniq("msg"), from, to, content);

const get = (path: string, headers: Record<string, string> = {}, signal?: AbortSignal) =>
  app.fetch(new Request(`http://sse-probe${path}`, { headers, ...(signal ? { signal } : {}) }));

/** The first `n` bytes a stream produces, without waiting for it to end. */
async function firstChunk(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const { value } = await reader.read();
  await reader.cancel();
  return new TextDecoder().decode(value);
}

describe("searching your own messages", () => {
  test("refuses a caller with no session", async () => {
    expect((await get("/api/v1/messages/search?q=x")).status).toBe(401);
  });

  test("refuses a signed-in person the operator has not approved", async () => {
    const login = uniq("waiting");
    const user = upsertUser(710000 + n, login);
    const jwt = await signJwt({ github_id: user.github_id, github_login: login, role: "member" });
    const res = await get("/api/v1/messages/search?q=x", { authorization: `Bearer ${jwt}` });
    expect(res.status).toBe(403);
  });

  test("refuses a query that is absent, empty, or only spaces", async () => {
    const me = await person();
    for (const q of ["", "?q=", "?q=%20%20"]) {
      const res = await get(`/api/v1/messages/search${q}`, { authorization: me.authorization });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("q");
    }
  });

  test("answers with the wire's field names and the trimmed query", async () => {
    const me = await person();
    const needle = uniq("needle");
    say(me.login, "peer-sse", `the ${needle} is here`);
    const res = await get(`/api/v1/messages/search?q=%20${needle}%20`, { authorization: me.authorization });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.query).toBe(needle);
    expect(body.count).toBe(1);
    // `from` and `to`, not `from_agent` and `to_agent`: a client reading the
    // column names off a database dump would build against fields this never
    // sends.
    expect(Object.keys(body.messages[0]).sort())
      .toEqual(["content", "file_path", "from", "id", "reply_to", "status", "to", "ts"]);
  });

  /** Zero is falsy and takes the default; a negative survives to the floor. */
  test("clamps the limit at both ends", async () => {
    const me = await person();
    const needle = uniq("many");
    for (let i = 0; i < 3; i++) say(me.login, "peer-sse", `${needle} ${i}`);
    const count = async (limit: string) =>
      (await (await get(`/api/v1/messages/search?q=${needle}&limit=${limit}`, { authorization: me.authorization })).json()).count;
    expect(await count("2")).toBe(2);
    expect(await count("0")).toBe(3);
    expect(await count("100000")).toBe(3);
  });
});

describe("the per-agent event stream", () => {
  /**
   * **The session cookie, not a query parameter.** The parameter it replaced
   * put a bearer credential into access logs, proxy request lines, `Referer`
   * and browser history — the one place logging tools are built to keep.
   */
  test("refuses without a session, and does not read one from the query", async () => {
    expect((await get("/api/v1/events/agt-x")).status).toBe(401);
    const me = await person();
    const token = me.authorization.split("=")[1]!;
    expect((await get(`/api/v1/events/agt-x?token=${token}`)).status).toBe(401);
  });

  test("refuses a signed-in person the operator has not approved", async () => {
    const login = uniq("waiting");
    const user = upsertUser(720000 + n, login);
    const jwt = await signJwt({ github_id: user.github_id, github_login: login, role: "member" });
    expect((await get("/api/v1/events/agt-x", { authorization: `Bearer ${jwt}` })).status).toBe(403);
  });

  test("opens with a connected frame naming the agent, in SSE framing", async () => {
    const me = await person();
    const res = await get("/api/v1/events/agt-sse-1", { authorization: me.authorization });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");

    const chunk = await firstChunk(res);
    // Event, data, blank line — a client that splits on the blank line gets
    // nothing until the second frame if the trailing newlines are dropped.
    expect(chunk).toBe(`event: connected\ndata: ${JSON.stringify({ agent: "agt-sse-1" })}\n\n`);
  });

  /**
   * A browser that navigates away aborts the request. The handler unregisters
   * on that signal, and nothing had ever sent one — a leak here is a set that
   * grows for the life of the process and is written to long after the socket
   * is gone.
   */
  test("unregisters the client when the caller goes away", async () => {
    const me = await person();
    const before = sseClientCount();
    const ac = new AbortController();
    const res = await get("/api/v1/events/agt-sse-2", { authorization: me.authorization }, ac.signal);
    await firstChunk(res);
    expect(sseClientCount()).toBe(before + 1);

    ac.abort();
    // The listener runs on the abort event; giving the loop a turn is enough.
    await Bun.sleep(10);
    expect(sseClientCount()).toBe(before);
  });
});

describe("the spend stream", () => {
  /**
   * § 11: spend is not the audit trail and not tenant message traffic, so it
   * has its own capability rather than borrowing one that answers a different
   * question.
   */
  test("refuses a session holding every other capability but this one", async () => {
    const me = await person();
    const res = await get("/api/v1/admin/ai-usage/stream", { authorization: me.authorization });
    expect([401, 403]).toContain(res.status);
  });

  test("opens for a session granted usage.read, and says not to buffer it", async () => {
    const me = await person();
    grants.grant(agentsDb, {
      subject: me.login,
      capability: CAPABILITY.USAGE_READ,
      grantedBy: "streams-test",
    });

    const res = await get("/api/v1/admin/ai-usage/stream", { authorization: me.authorization });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    // Proxies that buffer a stream turn it into a very slow poll.
    expect(res.headers.get("x-accel-buffering")).toBe("no");

    // A comment frame, which is how SSE says "still here" without an event.
    expect(await firstChunk(res)).toContain(":connected");
  });
});
