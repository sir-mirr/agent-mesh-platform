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
import { readFileSync } from "node:fs";

process.env.JWT_SECRET ||= "admin-reads-probe";

const { app } = await import("./main.ts");
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
   * **An empty list is an answer, and a broken query does not get to give one.**
   *
   * This route returned `{ agents: [] }` from its `catch`, so *the audit holds
   * nobody* and *the query did not run* were one sentence to every caller —
   * the shape `SC-DOWN-*` measures on the front end, on the wrong side of it.
   * The first run of this file demonstrated it: the hub store did not exist in
   * this process, the route logged `unable to open database file`, answered
   * `200`, and the test above written as the happy path passed through the
   * `catch` without noticing. It answers `503` with a code now (D-736).
   *
   * **Asserted over the source rather than by breaking the store**, and that is
   * a deliberate step down. Forcing the branch means making the hub database
   * unreadable, and the way that was first written — renaming `hub.db` while
   * leaving `hub.db-wal` beside it — left a mismatched write-ahead log that
   * took eight later tests in the same process down with it. A probe that
   * breaks its subject for everyone after it is worse than one that measures
   * less: `receive.test.ts` and `delivery-landing.test.ts` in this repository
   * are both scarred by the same lesson.
   *
   * So this checks the shape the route now has, which is enough to catch the
   * registered mutation putting the empty list back. What it does not do is run
   * the branch, and saying so is the honest half.
   */
  /** The source no longer contains the sentence that made the two identical. */
  test("and no longer answers an empty list from its catch", () => {
    const source = readFileSync(new URL("./main.ts", import.meta.url).pathname, "utf8");
    const route = /app\.get\('\/api\/v1\/admin\/chat-audits\/agents'[\s\S]*?\n\}\)/.exec(source);
    expect(route, "the chat-audits agents route moved").not.toBeNull();
    expect(route![0]).toContain("catch");
    expect(route![0]).toContain("AUDIT_AGENTS_UNAVAILABLE");
    expect(route![0]).toContain("503,");

    // **Prose may name the defect; that is how the reason survives.** The
    // comment beside the fix quotes `{ agents: [] }` to say what it replaced,
    // and the first version of this check matched it — the same carve-out
    // `greppable.test.ts` makes, arrived at the same way.
    const code = route![0].split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    expect(code).not.toMatch(/agents:\s*\[\]/);
    expect(code).toContain("503,");
  });
});
