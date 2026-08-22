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

const { app, revokeStrandsTheTenant, protectedSubjects } = await import("./main.ts");
const { upsertUser, approveUser, createPendingApproval, getDb } = await import("./db");
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

/**
 * **Whoever is told about a decision is whoever can make it.**
 *
 * `GET /api/v1/admin/keys/stream` pushes a proposal to an operator with a
 * dashboard open, rather than waiting for them to poll a screen they may not
 * have opened. Two frames arrive before anything happens — `connected`, then a
 * `snapshot` of what is already waiting — and a proposal made afterwards
 * arrives as `key-proposed`. The split matters: replaying the backlog as
 * arrivals would announce a day-old key as though it had just landed.
 */
describe("the pending-key stream", () => {
  /** Frames, one at a time, holding the pending read across calls. */
  function subscribe(cookie: string) {
    const res = app.fetch(new Request("http://gw-probe/api/v1/admin/keys/stream", {
      headers: { cookie },
    }));
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    let pending: ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> | null = null;
    const decoder = new TextDecoder();
    return {
      async ready() { reader = (await res).body!.getReader(); return this; },
      async next(ms = 2000): Promise<string | null> {
        if (!pending) pending = reader.read();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const out = await Promise.race([
          pending,
          new Promise<null>((r) => { timer = setTimeout(() => r(null), ms); }),
        ]);
        clearTimeout(timer);
        if (!out) return null;
        pending = null;
        return out.value ? decoder.decode(out.value) : null;
      },
      async close() { await reader.cancel(); },
    };
  }

  test("refuses an operator who cannot decide", async () => {
    const nobody = await operator();
    expect((await get("/api/v1/admin/keys/stream", "")).status).toBe(401);
    expect((await get("/api/v1/admin/keys/stream", nobody.cookie)).status).toBe(403);
  });

  test("says what is already waiting, then what arrives", async () => {
    const op = await operator([CAPABILITY.KEY_APPROVE, SCOPE_TENANT]);
    const waiting = uniq("already");
    keys.proposeKey(db, waiting, publicKey(), "grants-writes-test");

    const s = await subscribe(op.cookie).ready();
    expect(await s.next()).toContain("event: connected");

    const snapshot = (await s.next())!;
    expect(snapshot).toContain("event: snapshot");
    expect(JSON.parse(snapshot.split("data: ")[1]!).keys.map((k: { identity: string }) => k.identity))
      .toContain(waiting);

    // Proposed after the stream opened: an arrival, not part of the backlog.
    const arriving = uniq("arriving");
    keys.proposeKey(db, arriving, publicKey(), "grants-writes-test");

    const frame = (await s.next())!;
    expect(frame).toContain("event: key-proposed");
    const proposed = JSON.parse(frame.split("data: ")[1]!);
    expect(proposed.identity).toBe(arriving);
    expect(proposed.fingerprint).toBeTruthy();
    // § 10.2: the decision is a comparison against what the agent's operator
    // reports out of band, so the key itself is not shipped to the screen.
    expect(proposed).not.toHaveProperty("public_key");

    await s.close();
  });
});

/**
 * The one capability that can undo itself.
 *
 * Revoke the last tenant-wide `role.grant` and there is no way back: granting
 * requires holding it, so the person who could restore it is the person who no
 * longer has it. Every other capability is recoverable by whoever still holds
 * this one.
 *
 * Not unrecoverable in the end — a restart re-seeds these from `role = 'admin'`
 * — but the recovery is a restart, wanted by somebody who is looking at a 403
 * and has no way to know that is what they need. The screen makes the fixed
 * admin's chips unclickable; this is the same rule where it cannot be clicked
 * past, and the two read the same answer rather than each holding a copy.
 */
describe("the last grantor", () => {
  const T = SCOPE_TENANT;

  describe("the arithmetic, without a database", () => {
    test("the only tenant-wide holder cannot be revoked", () => {
      expect(revokeStrandsTheTenant([{ subject: "ada", scope: T }], { subject: "ada", scope: T }))
        .toBe(true);
    });

    test("one of two can", () => {
      expect(revokeStrandsTheTenant(
        [{ subject: "ada", scope: T }, { subject: "grace", scope: T }],
        { subject: "ada", scope: T },
      )).toBe(false);
    });

    /**
     * **Scope is the whole of it.** `requireCapability` widens a tenant-wide
     * grant to any narrower scope and never the other way, so a subject left
     * holding `role.grant` on one agent is not somebody who can put this back.
     */
    test("a holder scoped to one agent is not somebody who can grant", () => {
      expect(revokeStrandsTheTenant(
        [{ subject: "ada", scope: T }, { subject: "grace", scope: "agent-7" }],
        { subject: "ada", scope: T },
      )).toBe(true);
    });

    test("and revoking that narrow one strands nobody", () => {
      expect(revokeStrandsTheTenant(
        [{ subject: "ada", scope: T }, { subject: "grace", scope: "agent-7" }],
        { subject: "grace", scope: "agent-7" },
      )).toBe(false);
    });

    /** The same subject twice: removing one row leaves the other. */
    test("a subject holding both scopes keeps the tenant one", () => {
      expect(revokeStrandsTheTenant(
        [{ subject: "ada", scope: T }, { subject: "ada", scope: "agent-7" }],
        { subject: "ada", scope: "agent-7" },
      )).toBe(false);
    });

    test("an empty tenant is already stranded", () => {
      expect(revokeStrandsTheTenant([], { subject: "ada", scope: T })).toBe(true);
    });
  });

  /**
   * Through the route, which means arranging a tenant with exactly one holder.
   * Every other test in this file leaves an operator holding `role.grant` in
   * the shared store, so the rows are moved aside and put back — the same
   * shape as breaking a store to reach a `catch`, and for the same reason:
   * the state this asks about cannot be produced any other way.
   */
  describe("through the route", () => {
    async function withOnlyOneGrantor<T>(fn: (op: { login: string; cookie: string }) => Promise<T>): Promise<T> {
      const op = await operator(CAPABILITY.ROLE_GRANT);
      const others = grants
        .subjectsWith(db, CAPABILITY.ROLE_GRANT)
        .filter((h) => h.subject !== op.login);
      for (const h of others) {
        grants.revoke(db, { subject: h.subject, capability: CAPABILITY.ROLE_GRANT, scope: h.scope });
      }
      try {
        return await fn(op);
      } finally {
        for (const h of others) {
          grants.grant(db, {
            subject: h.subject, capability: CAPABILITY.ROLE_GRANT,
            scope: h.scope, grantedBy: "grants-writes-test",
          });
        }
      }
    }

    test("refuses to revoke itself, and says which grant it is", async () => {
      await withOnlyOneGrantor(async (op) => {
        const res = await del(op.cookie, { subject: op.login, capability: CAPABILITY.ROLE_GRANT });
        expect(res.status).toBe(409);
        const body = await res.json();
        expect(body.code).toBe("LAST_GRANTOR");
        expect(body.error).toContain(op.login);
        // Still there: a refusal that removed the row anyway would be worse
        // than no refusal, because the message says otherwise.
        expect(grants.has(db, op.login, CAPABILITY.ROLE_GRANT, SCOPE_TENANT)).toBe(true);
      });
    });

    /** Narrow: the guard is about `role.grant`, not about being the last anything. */
    test("and lets the same operator give up any other capability", async () => {
      await withOnlyOneGrantor(async (op) => {
        grants.grant(db, {
          subject: op.login, capability: CAPABILITY.USAGE_READ, grantedBy: "grants-writes-test",
        });
        const res = await del(op.cookie, { subject: op.login, capability: CAPABILITY.USAGE_READ });
        expect(res.status).toBe(200);
        expect((await res.json()).action).toBe("deleted");
      });
    });

    /**
     * **The screen reads the same answer the route acts on.** The RBAC matrix
     * greys out a chip it cannot turn off, and the two ways to work that out
     * from the outside are both wrong: an account name hard-coded into the
     * bundle belongs to one deployment, and `role = 'admin'` lives behind
     * `user.admit`, which the operator looking at this screen need not hold.
     */
    test("says which grant cannot be revoked, in the map the screen reads", async () => {
      await withOnlyOneGrantor(async (op) => {
        grants.grant(db, {
          subject: op.login, capability: CAPABILITY.USAGE_READ, grantedBy: "grants-writes-test",
        });
        const body = await (await get("/api/v1/admin/grants", op.cookie)).json();
        const rows = body.grants as Array<{
          subject: string; capability: string; revocable: boolean; immutable_reason?: string;
        }>;

        const last = rows.find((r) => r.subject === op.login && r.capability === CAPABILITY.ROLE_GRANT);
        expect(last).toBeDefined();
        expect({ revocable: last!.revocable, why: last!.immutable_reason })
          .toEqual({ revocable: false, why: "last_grantor" });

        // Everything else about the same person stays clickable — the rule is
        // about this one capability, not about this one operator.
        const other = rows.find((r) => r.subject === op.login && r.capability === CAPABILITY.USAGE_READ);
        expect(other!.revocable).toBe(true);
      });
    });

    test("and every grant is revocable again once somebody else holds it", async () => {
      const first = await operator(CAPABILITY.ROLE_GRANT);
      const second = await operator(CAPABILITY.ROLE_GRANT);
      const body = await (await get("/api/v1/admin/grants", first.cookie)).json();
      const rows = (body.grants as Array<{ subject: string; capability: string; revocable: boolean }>)
        .filter((r) => r.capability === CAPABILITY.ROLE_GRANT
          && (r.subject === first.login || r.subject === second.login));
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.revocable)).toBe(true);
    });

    test("with a second holder, the revoke goes through", async () => {
      const first = await operator(CAPABILITY.ROLE_GRANT);
      const second = await operator(CAPABILITY.ROLE_GRANT);
      const res = await del(first.cookie, { subject: second.login, capability: CAPABILITY.ROLE_GRANT });
      expect(res.status).toBe(200);
      expect((await res.json()).action).toBe("deleted");
      expect(grants.has(db, second.login, CAPABILITY.ROLE_GRANT, SCOPE_TENANT)).toBe(false);
    });
  });
});

/**
 * A protected account's row, whole (D-746).
 *
 * **Protected because it cannot be taken away, not the other way round.**
 * `seedLegacyAdminGrants` re-seeds every legacy admin capability for accounts
 * whose row says `role = 'admin'`, on every startup. Revoking one is a control
 * that appears to work, does nothing lasting, and says neither — which is the
 * worst of the three possible behaviours, and the reason the console greys the
 * whole row rather than the cells it happens to hold.
 *
 * Enforced here as well as drawn there, because the API is reachable without
 * the screen and a rule enforced in one of two places is a rule the other can
 * be talked out of.
 */
describe("a protected account", () => {
  /** An account this deployment restores grants for: `role = 'admin'`. */
  async function protectedOperator() {
    const login = uniq("fixed");
    const user = upsertUser(1_060_000 + n, login);
    createPendingApproval(login, user.github_id);
    approveUser(login);
    getDb().prepare(`UPDATE users SET role = 'admin' WHERE github_login = ?`).run(login);
    grants.grant(db, { subject: login, capability: CAPABILITY.USAGE_READ, grantedBy: "grants-writes-test" });
    return login;
  }

  test("is named in the response, and every one of its rows is locked", async () => {
    const fixed = await protectedOperator();
    const op = await operator(CAPABILITY.ROLE_GRANT);

    const body = await (await get("/api/v1/admin/grants", op.cookie)).json();
    expect(body.immutable_subjects).toContain(fixed);

    const rows = (body.grants as Array<{
      subject: string; capability: string; revocable: boolean; immutable_reason?: string;
    }>).filter((r) => r.subject === fixed);
    expect(rows.length).toBeGreaterThan(0);
    // Every row, not the one that happens to be `role.grant` — the console
    // locks the account, and a row half-locked is a row somebody will try.
    expect(rows.every((r) => r.revocable === false && r.immutable_reason === "protected_account"))
      .toBe(true);
  });

  test("and the route refuses the revoke the screen will not offer", async () => {
    const fixed = await protectedOperator();
    const op = await operator(CAPABILITY.ROLE_GRANT);

    const res = await del(op.cookie, { subject: fixed, capability: CAPABILITY.USAGE_READ });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("PROTECTED_ACCOUNT");
    expect(grants.has(db, fixed, CAPABILITY.USAGE_READ, SCOPE_TENANT)).toBe(true);
  });

  /**
   * The set comes from the same query the seed uses. A name compiled into
   * either half would belong to one installation — which is the thing the
   * console asked the server for rather than hard-coding.
   */
  /**
   * The seeded administrator is a **local** account, not a GitHub one, and it
   * is the account D-746 is about. A protected set read from `users` alone
   * would leave the one row it exists for unprotected while every test that
   * uses a GitHub admin still passes.
   */
  test("counts the local seeded administrator too", async () => {
    const local = uniq("local-admin");
    // Put back afterwards, whatever happens. One state directory holds for the
    // whole run and `seedLocalUsers` seeds the documented `admin` only into an
    // *empty* `local_users`, so a row left here is a sign-in another file's
    // `beforeAll` never gets — `main.in-process.test.ts` fails with a `401`
    // that says nothing about this file.
    getDb()
      .prepare(`INSERT INTO local_users (username, password_hash, role) VALUES (?, 'x', 'admin')`)
      .run(local);
    try {
      grants.grant(db, { subject: local, capability: CAPABILITY.USAGE_READ, grantedBy: "grants-writes-test" });
      expect(protectedSubjects()).toContain(local);

      const op = await operator(CAPABILITY.ROLE_GRANT);
      const body = await (await get("/api/v1/admin/grants", op.cookie)).json();
      expect(body.immutable_subjects).toContain(local);

      const res = await del(op.cookie, { subject: local, capability: CAPABILITY.USAGE_READ });
      expect(res.status).toBe(409);
    } finally {
      getDb().prepare(`DELETE FROM local_users WHERE username = ?`).run(local);
      grants.revoke(db, { subject: local, capability: CAPABILITY.USAGE_READ });
    }
  });

  test("is whoever this deployment's rows say it is", async () => {
    const fixed = await protectedOperator();
    expect(protectedSubjects()).toContain(fixed);

    const ordinary = await operator(CAPABILITY.ROLE_GRANT);
    expect(protectedSubjects()).not.toContain(ordinary.login);
  });
});
