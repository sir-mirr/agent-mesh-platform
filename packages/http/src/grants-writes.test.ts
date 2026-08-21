/**
 * Writing a grant, revoking one, and the two gates in front of them.
 *
 * § 11 makes capability the unit of authority, so these two routes are how
 * every other route's answer is decided. Three things hold:
 *
 * - **`grantedBy` is the actor.** Never a field the caller sends. A grant
 *   whose author is self-reported records whatever the author wanted
 *   recorded, and the record is the only account of how someone came to hold
 *   a capability.
 * - **The vocabulary is closed.** An unknown capability is refused with the
 *   list, so a console that mistyped one gets the real names back rather than
 *   writing a grant nothing will ever match.
 * - **Revoking twice is not an error.** `false` from the store means there was
 *   nothing to remove; the operator wanted an end state and has it.
 *
 * `requireCapabilityAnyScope` is the other gate here: § 11.3's reads answer
 * "which agents are mine", and refusing an operator who holds only their own
 * agents is the failure it exists to avoid — the answer for them is a short
 * list, not a `403`.
 *
 * This file owns the `gw-` prefix.
 */
import { describe, expect, test } from "bun:test";

process.env.JWT_SECRET ||= "grants-writes-probe";

const { app } = await import("./main.ts");
const { upsertUser, approveUser, createPendingApproval } = await import("./db");
const { signJwt } = await import("./auth");
const { STORE_FILES, agentsSchema, grants, keys, ownership, openAt, stateDir } =
  await import("@agent-mesh/store");
const { ALL_CAPABILITIES, CAPABILITY, SCOPE_TENANT } = await import("@agent-mesh/contracts");
const { join } = await import("node:path");

const db = openAt(join(stateDir(), STORE_FILES.agents), { create: true });
agentsSchema.migrate(db);
grants.migrate(db);
ownership.migrate(db);

let n = 0;
const uniq = (p: string) => `gw-${p}-${++n}-${process.pid}`;

async function operator(...caps: Array<string | [string, string]>) {
  const login = uniq("op");
  const user = upsertUser(1_030_000 + n, login);
  createPendingApproval(login, user.github_id);
  expect(approveUser(login)).toBe(true);
  for (const c of caps) {
    const [capability, scope] = Array.isArray(c) ? c : [c, undefined];
    grants.grant(db, {
      subject: login, capability, grantedBy: "grants-writes-test",
      ...(scope === undefined ? {} : { scope }),
    });
  }
  const jwt = await signJwt({ github_id: user.github_id, github_login: login, role: "member" });
  return { login, cookie: `mesh_token=${jwt}` };
}

/** A well-formed Ed25519 public key: 32 raw bytes, base64url. The store parses it. */
const publicKey = () =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

const call = (method: string, path: string, cookie: string, body?: unknown) =>
  app.fetch(new Request(`http://gw-probe${path}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  }));

const post = (cookie: string, body?: unknown) => call("POST", "/api/v1/admin/grants", cookie, body);
const del = (cookie: string, body?: unknown) => call("DELETE", "/api/v1/admin/grants", cookie, body);
const get = (path: string, cookie: string) => call("GET", path, cookie);

describe("writing a grant", () => {
  test("refuses a caller without role.grant", async () => {
    const nobody = await operator();
    expect((await post("", { subject: "x", capability: CAPABILITY.USAGE_READ })).status).toBe(401);
    expect((await post(nobody.cookie, { subject: "x", capability: CAPABILITY.USAGE_READ })).status)
      .toBe(403);
  });

  test("refuses a body it cannot parse", async () => {
    const op = await operator(CAPABILITY.ROLE_GRANT);
    const res = await post(op.cookie, "{ not json");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid JSON body");
  });

  test("refuses a grant with no subject", async () => {
    const op = await operator(CAPABILITY.ROLE_GRANT);
    for (const body of [{}, { capability: CAPABILITY.USAGE_READ }, { subject: "", capability: CAPABILITY.USAGE_READ }, { subject: 7 }]) {
      const res = await post(op.cookie, body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("subject is required");
    }
  });

  /** The refusal carries the vocabulary, so a mistyped name is fixable in one round trip. */
  test("refuses a capability nobody defines, and says which exist", async () => {
    const op = await operator(CAPABILITY.ROLE_GRANT);
    const res = await post(op.cookie, { subject: uniq("who"), capability: "cook.dinner" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("cook.dinner");
    expect(body.capabilities).toEqual([...ALL_CAPABILITIES]);
  });

  test("refuses a capability that is missing rather than wrong", async () => {
    const op = await operator(CAPABILITY.ROLE_GRANT);
    expect((await post(op.cookie, { subject: uniq("who") })).status).toBe(400);
  });

  /**
   * **The author is the caller, not the payload.** Sending `grantedBy` is not
   * an error and not obeyed: the record says who actually did it.
   */
  test("records the actor as the author, whatever the body claims", async () => {
    const op = await operator(CAPABILITY.ROLE_GRANT);
    const subject = uniq("subject");
    const res = await post(op.cookie, {
      subject, capability: CAPABILITY.USAGE_READ, grantedBy: "somebody-else", granted_by: "somebody-else",
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ok: true, subject, capability: CAPABILITY.USAGE_READ, scope: SCOPE_TENANT });

    const listed = (await (await get(`/api/v1/admin/grants?subject=${subject}`, op.cookie)).json())
      .grants as Array<{ capability: string; granted_by: string }>;
    expect(listed.map((g) => g.granted_by)).toEqual([op.login]);
  });

  /** No scope means the tenant, which is what a tenant admin is: inside it, not above it. */
  test("defaults an unscoped grant to the tenant", async () => {
    const op = await operator(CAPABILITY.ROLE_GRANT);
    const subject = uniq("subject");
    await post(op.cookie, { subject, capability: CAPABILITY.KEY_APPROVE });
    expect(grants.has(db, subject, CAPABILITY.KEY_APPROVE, SCOPE_TENANT)).toBe(true);
  });

  test("keeps a scope it was given", async () => {
    const op = await operator(CAPABILITY.ROLE_GRANT);
    const subject = uniq("subject");
    const identity = uniq("agent");
    const res = await post(op.cookie, { subject, capability: CAPABILITY.KEY_APPROVE, scope: identity });
    expect((await res.json()).scope).toBe(identity);
    expect(grants.has(db, subject, CAPABILITY.KEY_APPROVE, identity)).toBe(true);
    expect(grants.has(db, subject, CAPABILITY.KEY_APPROVE, SCOPE_TENANT)).toBe(false);
  });
});

describe("revoking one", () => {
  test("refuses a caller without role.grant", async () => {
    const nobody = await operator();
    expect((await del("", { subject: "x", capability: CAPABILITY.USAGE_READ })).status).toBe(401);
    expect((await del(nobody.cookie, { subject: "x", capability: CAPABILITY.USAGE_READ })).status)
      .toBe(403);
  });

  test("refuses a body it cannot parse", async () => {
    const op = await operator(CAPABILITY.ROLE_GRANT);
    expect((await del(op.cookie, "{ not json")).status).toBe(400);
  });

  /** Both halves name a row. Either missing is a request that names no grant. */
  test("refuses a revocation that names no grant", async () => {
    const op = await operator(CAPABILITY.ROLE_GRANT);
    for (const body of [{}, { subject: uniq("who") }, { capability: CAPABILITY.USAGE_READ }, { subject: 7, capability: CAPABILITY.USAGE_READ }]) {
      const res = await del(op.cookie, body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("subject and capability are required");
    }
  });

  /**
   * **Twice is not an error.** An operator revoking again, or racing another,
   * wanted the same end state and has it — but the two answers are still
   * distinguishable, because "there was nothing here" is worth knowing.
   */
  test("reports whether there was anything to remove", async () => {
    const op = await operator(CAPABILITY.ROLE_GRANT);
    const subject = uniq("subject");
    await post(op.cookie, { subject, capability: CAPABILITY.USAGE_READ });

    const first = await del(op.cookie, { subject, capability: CAPABILITY.USAGE_READ });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, action: "deleted" });

    const second = await del(op.cookie, { subject, capability: CAPABILITY.USAGE_READ });
    expect(await second.json()).toEqual({ ok: true, action: "not-found" });
    expect(grants.has(db, subject, CAPABILITY.USAGE_READ, SCOPE_TENANT)).toBe(false);
  });

  /**
   * A scoped grant is not removed by a revocation that names another scope.
   *
   * Asserted through `listFor` rather than `has`, because `has` is asymmetric
   * by design: a tenant-wide grant answers a question about any single scope,
   * so it would report the scoped row as still present after the row is gone.
   */
  test("removes the scope it names, and leaves the others", async () => {
    const op = await operator(CAPABILITY.ROLE_GRANT);
    const subject = uniq("subject");
    const mine = uniq("agent");
    await post(op.cookie, { subject, capability: CAPABILITY.KEY_APPROVE, scope: mine });
    await post(op.cookie, { subject, capability: CAPABILITY.KEY_APPROVE, scope: SCOPE_TENANT });

    expect(await (await del(op.cookie, { subject, capability: CAPABILITY.KEY_APPROVE, scope: mine })).json())
      .toEqual({ ok: true, action: "deleted" });
    const left = grants.listFor(db, subject)
      .filter((g) => g.capability === CAPABILITY.KEY_APPROVE)
      .map((g) => g.scope);
    expect(left).toEqual([SCOPE_TENANT]);
  });
});

describe("the any-scope gate", () => {
  /**
   * § 11.3. A grant scoped to one agent is a grant: the operator holding it
   * has agents to look after, and the reads that ask "which are mine" must
   * answer them.
   */
  test("admits a holder scoped to a single agent", async () => {
    const identity = uniq("agent");
    const op = await operator([CAPABILITY.KEY_APPROVE, identity]);
    ownership.assign(db, { identity, owner: op.login, grantedBy: "grants-writes-test" });

    const res = await get("/api/v1/admin/agents/owned", op.cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, owner: op.login, identities: [identity] });
  });

  test("refuses a caller holding the capability at no scope at all", async () => {
    const nobody = await operator();
    expect((await get("/api/v1/admin/agents/owned", "")).status).toBe(401);
    const res = await get("/api/v1/admin/agents/owned", nobody.cookie);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ capability: CAPABILITY.KEY_APPROVE, scope: "any" });
  });

  /**
   * **"Everything in the tenant" is not an answer to "what is mine".** The
   * screen asking is the approval queue's empty state, and an operator who
   * owns nothing needs to be told that rather than handed the tenant.
   */
  test("does not widen the owned list for a tenant-wide holder", async () => {
    const op = await operator([CAPABILITY.KEY_APPROVE, SCOPE_TENANT]);
    expect((await (await get("/api/v1/admin/agents/owned", op.cookie)).json()).identities).toEqual([]);
  });
});

describe("the pending-key queue", () => {
  /** A queue filtered to what the operator owns, and unfiltered for the tenant. */
  test("shows an owner their own proposals and nobody else's", async () => {
    const mine = uniq("mine");
    const theirs = uniq("theirs");
    for (const identity of [mine, theirs]) {
      keys.proposeKey(db, identity, publicKey(), "grants-writes-test");
    }
    const op = await operator([CAPABILITY.KEY_APPROVE, mine]);
    ownership.assign(db, { identity: mine, owner: op.login, grantedBy: "grants-writes-test" });

    const body = await (await get("/api/v1/admin/keys/pending", op.cookie)).json();
    const listed = (body.keys as Array<{ identity: string }>).map((k) => k.identity);
    expect(listed).toContain(mine);
    expect(listed).not.toContain(theirs);
    expect(body.ok).toBe(true);

    const wide = await operator([CAPABILITY.KEY_APPROVE, SCOPE_TENANT]);
    const all = (await (await get("/api/v1/admin/keys/pending", wide.cookie)).json())
      .keys as Array<{ identity: string }>;
    expect(all.map((k) => k.identity)).toContain(theirs);
  });
});
