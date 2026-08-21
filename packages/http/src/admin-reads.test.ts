/**
 * Three admin reads, and the qualifier one of them must not drop.
 *
 * `GET /api/v1/admin/agent-sources` asks the *running hub* how it observes an
 * address rather than reporting this process's idea of it — the two are
 * configured separately, and answering from a constant here describes a
 * deployment that may not be the one answering. It then spells the consequence
 * out in prose, because `forwarded` and `socket` are not equally good evidence
 * and a UI inferring that from the mode string is a UI that will eventually
 * stop.
 *
 * The three sentences are asserted here, including the one for a hub that did
 * not answer: *unknown* is a third thing, not a synonym for `socket`.
 */
import { afterEach, describe, expect, test } from "bun:test";

process.env.JWT_SECRET ||= "admin-reads-probe";

const { app } = await import("./main.ts");
const { auditAgents } = await import("./audit-agents");
const { upsertUser, approveUser, createPendingApproval } = await import("./db");
const { signJwt } = await import("./auth");
const { STORE_FILES, agentsSchema, grants, hubSchema, openAt, openStore, stateDir } = await import("@agent-mesh/store");
const { ALL_CAPABILITIES, CAPABILITY } = await import("@agent-mesh/contracts");
const { join } = await import("node:path");

const agentsDb = openAt(join(stateDir(), STORE_FILES.agents), { create: true });
agentsSchema.migrate(agentsDb);
grants.migrate(agentsDb);

/**
 * The hub's store, created here so the audit query can actually run.
 *
 * `main.ts` opens it `readonly` and its route swallows the failure — the first
 * run of this file logged `query failed: unable to open database file` and the
 * route still answered `200 {"agents":[]}`, so the test below meant as the happy
 * path went through the `catch`. Creating the store is what makes the two
 * distinguishable at all, which is the point the next test makes.
 */
const hub = openStore("hub", { create: true });
hubSchema.migrate(hub);

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

let n = 0;
const uniq = (p: string) => `adm-${p}-${++n}-${process.pid}`;

/** An approved person holding exactly the capabilities named. */
async function holder(...caps: string[]) {
  const login = uniq("op");
  const user = upsertUser(800000 + n, login);
  createPendingApproval(login, user.github_id);
  expect(approveUser(login)).toBe(true);
  for (const capability of caps) {
    grants.grant(agentsDb, { subject: login, capability, grantedBy: "admin-reads-test" });
  }
  // Stated, not read back: the first user of an empty table is an admin, and an
  // admin is approved by definition.
  const jwt = await signJwt({ github_id: user.github_id, github_login: login, role: "member" });
  return { login, cookie: `mesh_token=${jwt}` };
}

const get = (path: string, cookie: string) =>
  app.fetch(new Request(`http://adm-probe${path}`, { headers: { cookie } }));

/** Answer the hub's capabilities route with one observed-source mode, or fail. */
function hubSays(mode: string | null, ok = true) {
  globalThis.fetch = (async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (!url.includes("/api/v1/capabilities")) throw new Error(`unexpected fetch: ${url}`);
    if (!ok) throw new Error("hub unreachable");
    return new Response(JSON.stringify({ surface: { observed_source: mode } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

const source = (identity: string, observed: string) =>
  agentsDb.prepare(
    `INSERT INTO agent_sources (identity, observed, first_seen, last_seen, requests)
     VALUES (?, ?, datetime('now'), datetime('now'), 1)
     ON CONFLICT DO NOTHING`,
  ).run(identity, observed);

describe("the grant map", () => {
  test("refuses a caller without role.grant", async () => {
    const nobody = await holder();
    expect([401, 403]).toContain((await get("/api/v1/admin/grants", nobody.cookie)).status);
  });

  test("lists what one subject holds", async () => {
    const op = await holder(CAPABILITY.ROLE_GRANT);
    const body = await (await get(`/api/v1/admin/grants?subject=${op.login}`, op.cookie)).json();
    expect(body.ok).toBe(true);
    expect(body.grants.map((g: any) => g.capability)).toContain(CAPABILITY.ROLE_GRANT);
  });

  test("refuses a capability that is not in the vocabulary, and hands the vocabulary over", async () => {
    const op = await holder(CAPABILITY.ROLE_GRANT);
    const res = await get("/api/v1/admin/grants?capability=cook.dinner", op.cookie);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("cook.dinner");
    // Naming the valid set beats a caller guessing it one request at a time.
    expect(body.capabilities).toEqual(ALL_CAPABILITIES);
  });

  test("lists who holds one capability", async () => {
    const op = await holder(CAPABILITY.ROLE_GRANT);
    const body = await (await get(`/api/v1/admin/grants?capability=${CAPABILITY.ROLE_GRANT}`, op.cookie)).json();
    expect(body.capability).toBe(CAPABILITY.ROLE_GRANT);
    expect(body.subjects.map((s: any) => s.subject)).toContain(op.login);
  });

  /**
   * With no filter the response carries the vocabulary beside the cells. A
   * screen building a matrix needs the columns as much as the entries, and
   * reading them from the response beats a copy compiled into the front end —
   * which is how a capability added here would quietly never appear there.
   */
  test("and answers the whole map with the vocabulary beside it", async () => {
    const op = await holder(CAPABILITY.ROLE_GRANT);
    const body = await (await get("/api/v1/admin/grants", op.cookie)).json();
    expect(body.capabilities).toEqual(ALL_CAPABILITIES);
    expect(body.grants.some((g: any) => g.subject === op.login && g.capability === CAPABILITY.ROLE_GRANT)).toBe(true);
  });
});

describe("the observed sources, and what the addresses are worth", () => {
  test("refuses a caller without source.read", async () => {
    const nobody = await holder();
    expect([401, 403]).toContain((await get("/api/v1/admin/agent-sources", nobody.cookie)).status);
  });

  test("refuses an identity that is not shaped like one", async () => {
    const op = await holder(CAPABILITY.SOURCE_READ);
    hubSays("socket");
    const res = await get("/api/v1/admin/agent-sources?identity=not%20an%20identity", op.cookie);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("invalid identity");
  });

  test("filters to one identity when asked", async () => {
    const op = await holder(CAPABILITY.SOURCE_READ);
    const who = uniq("seen");
    source(who, "203.0.113.9");
    source(uniq("other"), "198.51.100.9");
    hubSays("socket");
    const body = await (await get(`/api/v1/admin/agent-sources?identity=${who}`, op.cookie)).json();
    expect(body.sources.every((r: any) => r.identity === who)).toBe(true);
    expect(body.sources_total).toBe(body.sources.length);
  });

  /**
   * **The list stops at 500 and the count does not.** A screen drawing 500 rows
   * out of 3000 reports a smaller fleet than the one running, and no other
   * field in the response contradicted it.
   */
  test("caps the list at five hundred while still reporting the real total", async () => {
    const op = await holder(CAPABILITY.SOURCE_READ);
    const before = (agentsDb.prepare(`SELECT count(*) AS n FROM agent_sources`).get() as { n: number }).n;
    for (let i = before; i < 505; i++) source(`bulk-${i}-${process.pid}`, `203.0.113.${i % 250}`);
    const total = (agentsDb.prepare(`SELECT count(*) AS n FROM agent_sources`).get() as { n: number }).n;
    expect(total).toBeGreaterThan(500);

    hubSays("socket");
    const body = await (await get("/api/v1/admin/agent-sources", op.cookie)).json();
    expect(body.sources.length).toBe(500);
    expect(body.sources_total).toBe(total);
  });

  /**
   * The qualifier is the part that is easy to drop, and dropping it turns a
   * header value into an observation. Three modes, three sentences — and the
   * third is not a synonym for the second.
   */
  test("says what the addresses are evidence of, per mode", async () => {
    const op = await holder(CAPABILITY.SOURCE_READ);

    hubSays("socket");
    let body = await (await get("/api/v1/admin/agent-sources", op.cookie)).json();
    expect(body.observed_source).toBe("socket");
    expect(body.evidence_note).toContain("kernel-observed peer");

    hubSays("forwarded");
    body = await (await get("/api/v1/admin/agent-sources", op.cookie)).json();
    expect(body.observed_source).toBe("forwarded");
    expect(body.evidence_note).toContain("X-Forwarded-For");
    // The condition the hub cannot verify, stated rather than implied.
    expect(body.evidence_note).toContain("the hub cannot verify");
  });

  test("and says the mode is unknown when the hub does not answer, not that it is socket", async () => {
    const op = await holder(CAPABILITY.SOURCE_READ);
    hubSays(null, false);
    const body = await (await get("/api/v1/admin/agent-sources", op.cookie)).json();
    expect(body.ok).toBe(true);
    expect(body.observed_source).toBeNull();
    expect(body.evidence_note).toContain("did not answer");
    // Unreachable is not a reason to withhold the rows.
    expect(Array.isArray(body.sources)).toBe(true);
  });
});

describe("who appears in the audit", () => {
  /**
   * Identities with no body attached — the metadata half of § 11's boundary, so
   * the metadata capability is the gate rather than the content one.
   */
  test("refuses a caller without audit.read.metadata", async () => {
    const nobody = await holder(CAPABILITY.SOURCE_READ);
    expect([401, 403]).toContain((await get("/api/v1/admin/chat-audits/agents", nobody.cookie)).status);
  });

  test("answers the identities on both sides of every audited message", async () => {
    const op = await holder(CAPABILITY.AUDIT_READ_METADATA);
    const from = uniq("spoke");
    const to = uniq("heard");
    hub.prepare(
      `INSERT INTO messages (id, from_agent, to_agent, content, status, ts)
       VALUES (?, ?, ?, 'hello', 'delivered', datetime('now'))`,
    ).run(uniq("m"), from, to);

    const res = await get("/api/v1/admin/chat-audits/agents", op.cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    // `{ agents }` and nothing else — no `ok`, which is worth pinning because
    // every neighbouring admin route sends one and a client written against
    // them would read `undefined` as failure.
    expect(Object.keys(body)).toEqual(["agents"]);
    // Both sides, which is what makes it *who appears in the audit* rather than
    // who sent something.
    expect(body.agents).toContain(from);
    expect(body.agents).toContain(to);
  });

  /**
   * **The step down is undone.** This used to assert over `main.ts`'s source —
   * that the route still contained `AUDIT_AGENTS_UNAVAILABLE` and no
   * `agents: []` — because reaching the branch meant making the hub database
   * unreadable, and the way that was first tried (renaming `hub.db` and
   * leaving `hub.db-wal` beside it) took eight later tests down with a
   * mismatched write-ahead log. The comment said plainly that it did not run
   * the branch.
   *
   * It runs now. `auditAgents` takes the handle as an argument, so a store that
   * will not answer is a different argument rather than a broken file, and
   * `audit-degraded.test.ts` drives both outcomes. The regex went with it: a
   * source assertion that no longer measures anything the real test does not is
   * a thing that breaks when somebody reformats a route.
   *
   * What stays here is the wiring — that this route serves the delegate's
   * answer rather than one of its own.
   */
  test("serves what the reader answered, rather than an answer of its own", async () => {
    const op = await holder(CAPABILITY.AUDIT_READ_METADATA);
    const from = uniq("speaker");
    const to = uniq("listener");
    hub.prepare(
      `INSERT INTO messages (id, from_agent, to_agent, content, status, ts)
       VALUES (?, ?, ?, 'x', 'delivered', datetime('now'))`,
    ).run(uniq("msg"), from, to);

    const res = await get("/api/v1/admin/chat-audits/agents", op.cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(auditAgents(() => hub).body);
  });
});

// --- Queue depth (GET /api/v1/admin/mailbox, /:identity) -------------------
//
// The operator's answer to "why is this agent not receiving". An empty queue
// and one held entirely under leases by a caller that died look identical from
// outside, so `leased` is reported beside `pending` rather than folded into it.

/** A message sitting in the hub's queue for someone. */
function queued(
  to: string,
  o: { from?: string; content?: string; ts?: string; status?: string; lease?: string | null } = {},
): string {
  const id = uniq("msg");
  hub.prepare(
    `INSERT INTO messages (id, from_agent, to_agent, content, status, ts, leased_until)
     VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')), ?)`,
  ).run(
    id, o.from ?? uniq("sender"), to, o.content ?? "hello",
    o.status ?? "pending", o.ts ?? null, o.lease ?? null,
  );
  return id;
}

const pendingNow = () =>
  (hub.prepare(`SELECT count(*) AS n FROM messages WHERE status = 'pending'`).get() as { n: number }).n;

describe("how deep the queues are", () => {
  test("refuses a caller without mailbox.read_depth", async () => {
    const nobody = await holder();
    expect((await get("/api/v1/admin/mailbox", "")).status).toBe(401);
    expect((await get("/api/v1/admin/mailbox", nobody.cookie)).status).toBe(403);
  });

  /**
   * **A live lease and a lapsed one are not the same thing.** The lapsed one is
   * pending again — the caller holding it died — and counting it as leased
   * tells an operator to wait for a delivery nobody is going to make.
   */
  test("counts pending per agent, and only live leases as leased", async () => {
    const op = await holder(CAPABILITY.MAILBOX_READ_DEPTH);
    const identity = uniq("busy");
    queued(identity, { ts: "2026-01-01 00:00:00" });
    queued(identity, { lease: "2026-01-01 00:00:00" });          // lapsed
    queued(identity, { lease: "2099-01-01 00:00:00" });          // held
    queued(identity, { status: "delivered" });                   // not pending at all

    const body = await (await get("/api/v1/admin/mailbox", op.cookie)).json();
    const row = body.mailboxes.find((q: any) => q.identity === identity);
    expect(row).toMatchObject({ identity, pending: 3, leased: 1, oldest: "2026-01-01 00:00:00" });
  });

  /**
   * The total is the route's own `count(*)`. The console used to sum the rows
   * over a field named `depth` that this route has never emitted, so its
   * "messages queued" tile read `0` whether the mesh was idle or backed up.
   */
  test("answers a total it counted itself", async () => {
    const op = await holder(CAPABILITY.MAILBOX_READ_DEPTH);
    queued(uniq("someone"));
    const before = pendingNow();
    const body = await (await get("/api/v1/admin/mailbox", op.cookie)).json();
    expect(body.ok).toBe(true);
    expect(body.total_queued).toBe(before);
    expect(body.total_queued).toBeGreaterThan(0);
  });

  /** Deepest first — the operator is looking for the one that is stuck. */
  test("puts the deepest queue first", async () => {
    const op = await holder(CAPABILITY.MAILBOX_READ_DEPTH);
    const few = uniq("few");
    const many = uniq("many");
    queued(few);
    for (let i = 0; i < 4; i++) queued(many);

    const body = await (await get("/api/v1/admin/mailbox", op.cookie)).json();
    const mine = body.mailboxes.filter((q: any) => q.identity === few || q.identity === many);
    expect(mine.map((q: any) => q.identity)).toEqual([many, few]);
  });

  test("refuses an off-pattern identity", async () => {
    const op = await holder(CAPABILITY.MAILBOX_READ_DEPTH);
    const res = await get("/api/v1/admin/mailbox/has%20space", op.cookie);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("invalid identity format");
  });

  /**
   * One agent's queue, oldest first, and `leased` as a boolean rather than the
   * `1`/`0` SQLite answers with — a reader doing `if (m.leased)` on `0` is
   * right by luck, and one doing `m.leased === true` is wrong.
   */
  test("lists one agent's pending messages, oldest first", async () => {
    const op = await holder(CAPABILITY.MAILBOX_READ_DEPTH);
    const identity = uniq("queue");
    const sender = uniq("sender");
    const second = queued(identity, { from: sender, content: "second", ts: "2026-02-02 00:00:00" });
    const first = queued(identity, { from: sender, content: "first!", ts: "2026-01-01 00:00:00",
      lease: "2099-01-01 00:00:00" });
    queued(identity, { status: "delivered", ts: "2020-01-01 00:00:00" });
    queued(uniq("other"), { ts: "2019-01-01 00:00:00" });

    const body = await (await get(`/api/v1/admin/mailbox/${identity}`, op.cookie)).json();
    expect(body).toEqual({
      ok: true,
      identity,
      messages: [
        { id: first, from: sender, ts: "2026-01-01 00:00:00", size: 6, leased: true },
        { id: second, from: sender, ts: "2026-02-02 00:00:00", size: 6, leased: false },
      ],
    });
  });

  /** `size` is the content's length, not the row's — the body itself is not served here. */
  test("reports the size without the content", async () => {
    const op = await holder(CAPABILITY.MAILBOX_READ_DEPTH);
    const identity = uniq("sized");
    queued(identity, { content: "x".repeat(4096) });
    const body = await (await get(`/api/v1/admin/mailbox/${identity}`, op.cookie)).json();
    expect(body.messages[0].size).toBe(4096);
    expect(JSON.stringify(body)).not.toContain("xxxx");
  });

  /**
   * The ceiling is 500 and the floor is 1, and anything unreadable takes the
   * default rather than the floor — `Number('') || 100` is the guard, and a
   * missing `limit` must not answer with one message.
   */
  test("clamps the limit, and defaults what it cannot read", async () => {
    const op = await holder(CAPABILITY.MAILBOX_READ_DEPTH);
    const identity = uniq("many");
    for (let i = 0; i < 6; i++) queued(identity, { ts: `2026-03-0${i + 1} 00:00:00` });

    const count = async (q: string) =>
      (await (await get(`/api/v1/admin/mailbox/${identity}${q}`, op.cookie)).json()).messages.length;

    expect(await count("?limit=2")).toBe(2);
    expect(await count("?limit=0")).toBe(6);      // 0 is falsy -> default 100
    expect(await count("?limit=-5")).toBe(1);     // negative -> floor
    expect(await count("?limit=nonsense")).toBe(6);
    expect(await count("")).toBe(6);
    expect(await count("?limit=9999")).toBe(6);   // ceiling is above what is here
  });

  /** A name with nothing queued is an empty list, not a 404. */
  test("answers an empty queue rather than refusing", async () => {
    const op = await holder(CAPABILITY.MAILBOX_READ_DEPTH);
    const res = await get(`/api/v1/admin/mailbox/${uniq("idle")}`, op.cookie);
    expect(res.status).toBe(200);
    expect((await res.json()).messages).toEqual([]);
  });
});
