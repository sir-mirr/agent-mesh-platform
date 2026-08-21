/**
 * What a spend snapshot costs to write, and who may read one.
 *
 * A monitor outside the mesh pushes a snapshot every five minutes; the admin
 * console reads it and subscribes for the next. Three properties hold the
 * shape together:
 *
 * - **Ingest is off until a token is configured**, and `503` says so rather
 *   than `401`. A deployment that never set one is not a caller who got the
 *   credential wrong.
 * - **The token is compared in constant time.** The alternative leaks it one
 *   byte at a time to whoever times the answers — and these four lines were
 *   deleted once by a commit whose subject was a front-end fixture, leaving
 *   any caller with any token able to write the figures the admin screens read.
 * - **Spend has its own capability.** § 11: it is not the audit trail and not
 *   tenant traffic, so it does not borrow a grant that answers a different
 *   question.
 *
 * This file owns the `aiu-` prefix.
 */
import { afterEach, describe, expect, test } from "bun:test";

process.env.JWT_SECRET ||= "ai-usage-probe";

const { app, aiUsageSseClientCount } = await import("./main.ts");
const { upsertUser, approveUser, createPendingApproval } = await import("./db");
const { signJwt } = await import("./auth");
const { STORE_FILES, agentsSchema, grants, openAt, stateDir } = await import("@agent-mesh/store");
const { CAPABILITY } = await import("@agent-mesh/contracts");
const { join } = await import("node:path");

const db = openAt(join(stateDir(), STORE_FILES.agents), { create: true });
agentsSchema.migrate(db);
grants.migrate(db);

let n = 0;
const uniq = (p: string) => `aiu-${p}-${++n}-${process.pid}`;

const TOKEN = "aiu-ingest-token";
const realToken = process.env.AI_USAGE_INGEST_TOKEN;
afterEach(() => {
  if (realToken === undefined) delete process.env.AI_USAGE_INGEST_TOKEN;
  else process.env.AI_USAGE_INGEST_TOKEN = realToken;
});

async function reader(...caps: string[]) {
  const login = uniq("op");
  const user = upsertUser(1_010_000 + n, login);
  createPendingApproval(login, user.github_id);
  expect(approveUser(login)).toBe(true);
  for (const capability of caps) {
    grants.grant(db, { subject: login, capability, grantedBy: "ai-usage-test" });
  }
  const jwt = await signJwt({ github_id: user.github_id, github_login: login, role: "member" });
  return { login, cookie: `mesh_token=${jwt}` };
}

const snapshot = (over: Record<string, unknown> = {}) => ({
  schema_version: "v1",
  ts: "2027-03-03T00:00:00.000Z",
  source: uniq("monitor"),
  accounts: [{ account: "one", spend_usd: 12.5 }],
  ...over,
});

const ingest = (body: unknown, bearer?: string) =>
  app.fetch(new Request("http://aiu-probe/api/v1/ingest/ai-usage", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bearer === undefined ? {} : { authorization: bearer }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));

const get = (path: string, cookie: string) =>
  app.fetch(new Request(`http://aiu-probe${path}`, { headers: { cookie } }));

describe("writing the figures", () => {
  /**
   * **`503`, not `401`.** A deployment that configured no token has not turned
   * ingest on; a caller told `401` would go looking for a credential that does
   * not exist anywhere.
   */
  test("is off until a token is configured", async () => {
    delete process.env.AI_USAGE_INGEST_TOKEN;
    const res = await ingest(snapshot(), `Bearer ${TOKEN}`);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("AI_USAGE_INGEST_TOKEN");
  });

  /**
   * **Restored, and pinned here.** `af4b159` deleted the comparison while its
   * subject was a front-end fixture and left a comment describing what it had
   * done rather than why. With the token configured — which is what turns
   * ingest on — any caller with any token or none could write the figures the
   * admin screens read.
   */
  test("refuses a caller with the wrong token, or none", async () => {
    process.env.AI_USAGE_INGEST_TOKEN = TOKEN;
    for (const bearer of [undefined, "", "Bearer ", "Bearer wrong", TOKEN, `Bearer ${TOKEN}x`]) {
      const res = await ingest(snapshot(), bearer);
      expect(res.status, `bearer: ${JSON.stringify(bearer)}`).toBe(401);
    }
  });

  test("refuses a body it cannot parse", async () => {
    process.env.AI_USAGE_INGEST_TOKEN = TOKEN;
    const res = await ingest("{not json", `Bearer ${TOKEN}`);
    expect(res.status).toBe(400);
  });

  /**
   * `422` for a body that parsed and says the wrong thing — the shape is the
   * caller's mistake, not the request's. Each refusal names the field, because
   * the caller is a monitor somebody is writing.
   */
  test("refuses a snapshot it cannot use, and says which part", async () => {
    process.env.AI_USAGE_INGEST_TOKEN = TOKEN;
    const cases: Array<[unknown, string]> = [
      [null, "object"],
      // Already JSON: the helper sends a string through untouched, so this is
      // a body that parses to a string rather than one that does not parse.
      ['"a string"', "object"],
      [snapshot({ schema_version: "v2" }), "schema_version"],
      [snapshot({ schema_version: undefined }), "schema_version"],
      [snapshot({ accounts: [] }), "accounts"],
      [snapshot({ accounts: "not an array" }), "accounts"],
      [snapshot({ ts: 7 }), "ts and source"],
      [snapshot({ source: null }), "ts and source"],
    ];
    for (const [body, names] of cases) {
      const res = await ingest(body, `Bearer ${TOKEN}`);
      expect(res.status, JSON.stringify(body).slice(0, 60)).toBe(422);
      expect((await res.json()).error).toContain(names);
    }
  });

  /** The server stamps when it accepted, and says so — the monitor's `ts` is its own. */
  test("accepts one, and stamps its own arrival time", async () => {
    process.env.AI_USAGE_INGEST_TOKEN = TOKEN;
    const sent = snapshot();
    const res = await ingest(sent, `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Date.parse(body.accepted_at)).not.toBeNaN();
    expect(body.accepted_at).not.toBe(sent.ts);
  });
});

describe("reading them", () => {
  test("refuses a caller without usage.read", async () => {
    const nobody = await reader();
    for (const path of ["/api/v1/admin/ai-usage", "/api/v1/admin/ai-usage/stream"]) {
      expect((await get(path, "")).status).toBe(401);
      const res = await get(path, nobody.cookie);
      expect(res.status).toBe(403);
      expect((await res.json()).capability).toBe(CAPABILITY.USAGE_READ);
    }
  });

  /** Spend does not borrow the audit's grant, nor the mailbox's. */
  test("is not satisfied by a grant that answers another question", async () => {
    const other = await reader(CAPABILITY.AUDIT_READ_CONTENT, CAPABILITY.MAILBOX_READ_DEPTH);
    expect((await get("/api/v1/admin/ai-usage", other.cookie)).status).toBe(403);
  });

  test("serves the snapshot that was last written", async () => {
    process.env.AI_USAGE_INGEST_TOKEN = TOKEN;
    const op = await reader(CAPABILITY.USAGE_READ);
    const sent = snapshot({ accounts: [{ account: uniq("acct"), spend_usd: 3.25 }] });
    await ingest(sent, `Bearer ${TOKEN}`);

    const body = await (await get("/api/v1/admin/ai-usage", op.cookie)).json();
    expect(body.snapshot).toMatchObject({
      schema_version: "v1", ts: sent.ts, source: sent.source, accounts: sent.accounts,
    });
    expect(body.snapshot.last_updated_at).toBeTruthy();
  });
});

// --- The stream ------------------------------------------------------------

/** A subscriber held open, read frame by frame. The pending read is kept. */
function subscribe(cookie: string) {
  const res = app.fetch(new Request("http://aiu-probe/api/v1/admin/ai-usage/stream", {
    headers: { cookie },
  }));
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  let pending: ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> | null = null;
  const decoder = new TextDecoder();
  return {
    async ready() { reader = (await res).body!.getReader(); return this; },
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

describe("subscribing to them", () => {
  test("says it is connected before anything else", async () => {
    const op = await reader(CAPABILITY.USAGE_READ);
    const s = await subscribe(op.cookie).ready();
    expect(await s.next()).toBe(":connected\n\n");
    await s.close();
  });

  /**
   * **The snapshot already held is pushed on connect.** A console that had to
   * wait for the next five-minute tick would open on an empty panel while the
   * server was holding the answer.
   */
  test("pushes what it already has, without waiting for the next tick", async () => {
    process.env.AI_USAGE_INGEST_TOKEN = TOKEN;
    const op = await reader(CAPABILITY.USAGE_READ);
    const sent = snapshot({ source: uniq("earlier") });
    await ingest(sent, `Bearer ${TOKEN}`);

    const s = await subscribe(op.cookie).ready();
    expect(await s.next()).toBe(":connected\n\n");
    const frame = (await s.next())!;
    expect(frame).toContain("event: ai-usage-update");
    expect(JSON.parse(frame.split("data: ")[1]!).source).toBe(sent.source);
    await s.close();
  });

  test("hands every subscriber the next snapshot as it arrives", async () => {
    process.env.AI_USAGE_INGEST_TOKEN = TOKEN;
    const op = await reader(CAPABILITY.USAGE_READ);
    const one = await subscribe(op.cookie).ready();
    const two = await subscribe(op.cookie).ready();
    for (const s of [one, two]) {
      await s.next();                       // :connected
      await s.next();                       // whatever was already held, if any
    }

    const sent = snapshot({ source: uniq("live") });
    await ingest(sent, `Bearer ${TOKEN}`);

    for (const s of [one, two]) {
      const frame = (await s.next())!;
      expect(frame).toContain("event: ai-usage-update");
      expect(JSON.parse(frame.split("data: ")[1]!).source).toBe(sent.source);
    }
    await one.close();
    await two.close();
  });

  /**
   * **A subscriber that leaves is unregistered, and the rest keep their feed.**
   *
   * Nothing outside counts these clients, which is why `aiUsageSseClientCount`
   * is exported: a set that grows for the life of the process and pushes to
   * controllers whose sockets are gone fails at no particular moment, so a test
   * that cannot see the set cannot tell that shape from a healthy one.
   *
   * The departure measured here is a cancelled stream. The other way a
   * controller leaves — `broadcastAiUsage` dropping one whose `enqueue` throws
   * — is not reachable in-process: cancelling is the only way to make a
   * registered controller throw, and cancelling removes it by this path first.
   */
  test("unregisters a subscriber that leaves, and still serves the rest", async () => {
    process.env.AI_USAGE_INGEST_TOKEN = TOKEN;
    const op = await reader(CAPABILITY.USAGE_READ);
    const before = aiUsageSseClientCount();
    const gone = await subscribe(op.cookie).ready();
    const stays = await subscribe(op.cookie).ready();
    for (const s of [gone, stays]) { await s.next(); await s.next(); }
    expect(aiUsageSseClientCount()).toBe(before + 2);

    await gone.close();
    expect(aiUsageSseClientCount()).toBe(before + 1);

    const sent = snapshot({ source: uniq("after") });
    expect((await ingest(sent, `Bearer ${TOKEN}`)).status).toBe(200);
    const frame = (await stays.next())!;
    expect(JSON.parse(frame.split("data: ")[1]!).source).toBe(sent.source);

    await stays.close();
    expect(aiUsageSseClientCount()).toBe(before);
  });
});
