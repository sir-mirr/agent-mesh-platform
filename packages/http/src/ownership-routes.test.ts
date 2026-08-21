/**
 * Claiming an identity, and being allowed to speak for one (§ 11.3, § 8.2).
 *
 * Two routes that hand out authority over an identity, from opposite ends:
 *
 * - **A pairing code** carries a person's claim across a gap the session
 *   cannot cross. The operator is in a browser; the agent is a process on some
 *   host with a CLI and no cookie. Redemption is the one transaction in which
 *   both are known, which is why it is also where the address is recorded.
 * - **`can_proxy`** is the strongest thing a participant can be given —
 *   permission to sign as somebody else — so it is gated on `agent.provision`
 *   *scoped to that identity*, not on holding the capability anywhere.
 *
 * The prefixes in this directory must not collide: two files each counting
 * from zero produce the same names, and `INSERT OR IGNORE` makes the loser
 * silent. This file owns `own-`.
 */
import { describe, expect, test } from "bun:test";

process.env.JWT_SECRET ||= "ownership-probe";

const { app } = await import("./main.ts");
const { upsertUser, approveUser, createPendingApproval } = await import("./db");
const { signJwt } = await import("./auth");
const { STORE_FILES, agentsSchema, entitlement, grants, groups, openAt, ownership, stateDir } =
  await import("@agent-mesh/store");
const { CAPABILITY, SCOPE_TENANT } = await import("@agent-mesh/contracts");
const { join } = await import("node:path");

const db = openAt(join(stateDir(), STORE_FILES.agents), { create: true });
agentsSchema.migrate(db);
grants.migrate(db);
ownership.migrate(db);
// The teardown route asks which group an identity is in before deciding, so
// the table has to exist here even though nothing in this file uses groups —
// run alone, its absence came back as `500` from the global error handler.
groups.migrate(db);

let n = 0;
const uniq = (p: string) => `own-${p}-${++n}-${process.pid}`;

/** An operator, optionally holding `agent.provision` at some scope. */
async function operator(scope?: string) {
  const login = uniq("op");
  const user = upsertUser(370000 + n, login);
  createPendingApproval(login, user.github_id);
  approveUser(login);
  if (scope !== undefined) {
    grants.grant(db, {
      subject: login,
      capability: CAPABILITY.AGENT_PROVISION,
      scope,
      grantedBy: "ownership-test",
    });
  }
  const jwt = await signJwt({ github_id: user.github_id, github_login: login, role: "member" });
  return { login, cookie: `mesh_token=${jwt}` };
}

/** An identity this server's registry knows about. */
function registered(): string {
  const identity = uniq("agent");
  db.prepare(`INSERT INTO agents (identity) VALUES (?)`).run(identity);
  return identity;
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.fetch(new Request(`http://own-probe${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));

const issue = (body: unknown, cookie: string) =>
  post("/api/v1/admin/pairing-codes", body, { cookie });

const redeem = (body: unknown, headers: Record<string, string> = {}) =>
  post("/api/v1/pairing-codes/redeem", body, headers);

// --- Issuing (POST /api/v1/admin/pairing-codes) ----------------------------

describe("issuing a pairing code", () => {
  test("refuses a caller with no session and one with no grant", async () => {
    expect((await issue({ identity: registered() }, "")).status).toBe(401);
    const nobody = await operator();
    const res = await issue({ identity: registered() }, nobody.cookie);
    expect(res.status).toBe(403);
    expect((await res.json()).capability).toBe(CAPABILITY.AGENT_PROVISION);
  });

  test("refuses a body it cannot parse", async () => {
    const op = await operator(SCOPE_TENANT);
    const res = await issue("{not json", op.cookie);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("JSON");
  });

  /** The § 10.1 pattern, not "any string" — the code names an identity. */
  test("refuses an identity that is missing, not a string, or off-pattern", async () => {
    const op = await operator(SCOPE_TENANT);
    for (const identity of [undefined, 7, "", "-leading-dash", "has space", "has_underscore", "슬"]) {
      const res = await issue({ identity }, op.cookie);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("identity");
    }
  });

  /**
   * The window is bounded at both ends. Zero and negative are not "no expiry",
   * and an hour is the ceiling — a code good for a day is a password.
   */
  test("refuses a ttl outside 1..3600", async () => {
    const op = await operator(SCOPE_TENANT);
    for (const ttl_seconds of [0, -1, 3601, 3600.5, "not a number", ""]) {
      const res = await issue({ identity: registered(), ttl_seconds }, op.cookie);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("1..3600");
    }
    // The boundaries themselves are inside.
    for (const ttl_seconds of [1, 3600]) {
      expect((await issue({ identity: registered(), ttl_seconds }, op.cookie)).status).toBe(201);
    }
  });

  /**
   * **`NaN` never arrives as `NaN`.** `JSON.stringify` writes it as `null`, and
   * `null ?? default` is the default — so the `Number.isFinite` guard is
   * unreachable from a JSON caller and the unreadable case shows up as a
   * string instead. Written down because the guard looks like the one that
   * catches this and does not.
   */
  test("takes the default for a ttl JSON could not carry", async () => {
    const op = await operator(SCOPE_TENANT);
    for (const ttl_seconds of [NaN, Infinity, null]) {
      const res = await issue({ identity: registered(), ttl_seconds }, op.cookie);
      expect(res.status).toBe(201);
      expect((await res.json()).ttl_seconds).toBe(300);
    }
  });

  /**
   * `201`, and the code is in the body exactly once. **`ttl_seconds` is the
   * server's fact**, not an echo of the request the console falls back to:
   * `RegisterAgentPage` did `res.ttl_seconds || selectedTtl` and took the
   * request's value on every call, because the field was never sent.
   */
  test("issues a code, and says how long it is good for", async () => {
    const op = await operator(SCOPE_TENANT);
    const identity = registered();
    const res = await issue({ identity, ttl_seconds: 120 }, op.cookie);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.identity).toBe(identity);
    expect(body.ttl_seconds).toBe(120);
    expect(body.code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(typeof body.expires_at).toBe("string");

    const row = db.prepare(`SELECT identity, issued_by, redeemed_at FROM pairing_codes WHERE code = ?`)
      .get(body.code) as { identity: string; issued_by: string; redeemed_at: string | null };
    expect(row).toEqual({ identity, issued_by: op.login, redeemed_at: null });
  });

  /** Omitting it takes the deployment's default rather than refusing. */
  test("defaults the window when the caller does not ask for one", async () => {
    const op = await operator(SCOPE_TENANT);
    const res = await issue({ identity: registered() }, op.cookie);
    expect(res.status).toBe(201);
    expect((await res.json()).ttl_seconds).toBe(300);
  });

  /**
   * An identity nobody registered still gets a code. The code says who may
   * claim the *name*; § 10.1 provisioning is a separate act, and refusing here
   * would mean the name has to exist before anyone can be made answerable for
   * it — which is backwards for the CLI-first flow this exists to serve.
   */
  test("issues for a name this registry has never seen", async () => {
    const op = await operator(SCOPE_TENANT);
    expect((await issue({ identity: uniq("unregistered") }, op.cookie)).status).toBe(201);
  });
});

// --- Redeeming (POST /api/v1/pairing-codes/redeem) -------------------------

describe("redeeming one", () => {
  /** **No session, by design.** The code is the credential; the caller is a CLI. */
  test("is reached with no cookie at all", async () => {
    const op = await operator(SCOPE_TENANT);
    const identity = registered();
    const { code } = await (await issue({ identity }, op.cookie)).json();

    const owner = uniq("owner");
    const res = await redeem({ code, owner });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, identity, owner });
    expect(ownership.isOwner(db, owner, identity)).toBe(true);
  });

  /**
   * The ownership row records *how* the claim was made — `pairing:` and the
   * operator who issued it, not the person who typed the code. Those are two
   * different people and only one of them was authenticated.
   */
  test("records the issuer as the grantor, not the redeemer", async () => {
    const op = await operator(SCOPE_TENANT);
    const identity = registered();
    const { code } = await (await issue({ identity }, op.cookie)).json();
    const owner = uniq("owner");
    await redeem({ code, owner });

    const [row] = ownership.owners(db, identity);
    expect(row!.owner).toBe(owner);
    expect(row!.granted_by).toBe(`pairing:${op.login}`);
  });

  test("refuses a body it cannot parse, or one missing either half", async () => {
    expect((await redeem("{not json")).status).toBe(400);
    for (const body of [{}, { code: "ABCD-EFGH-JKLM" }, { owner: "someone" }, { code: 7, owner: "x" }]) {
      const res = await redeem(body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("required");
    }
  });

  /**
   * **Three reasons, three answers.** "Ask for another" and "somebody else
   * already used this" are different situations for the person losing the
   * race, and collapsing them into `invalid` hides the second one entirely.
   */
  test("distinguishes unknown, expired, and already-redeemed", async () => {
    const unknown = await redeem({ code: "ZZZZ-ZZZZ-ZZZZ", owner: uniq("owner") });
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).reason).toBe("unknown");

    // The route refuses a negative window, so an already-dead code is issued
    // through the store — the only caller that ever passes one.
    const dead = ownership.issueCode(db, {
      identity: registered(), issuedBy: uniq("op"), ttlSeconds: -60,
    });
    const expired = await redeem({ code: dead.code, owner: uniq("owner") });
    expect(expired.status).toBe(409);
    expect((await expired.json()).reason).toBe("expired");

    const op = await operator(SCOPE_TENANT);
    const { code } = await (await issue({ identity: registered() }, op.cookie)).json();
    expect((await redeem({ code, owner: uniq("first") })).status).toBe(200);
    const again = await redeem({ code, owner: uniq("second") });
    expect(again.status).toBe(409);
    expect((await again.json()).reason).toBe("already-redeemed");
  });

  /** A spent code hands nothing to the second caller. */
  test("gives the loser of a race no ownership", async () => {
    const op = await operator(SCOPE_TENANT);
    const identity = registered();
    const { code } = await (await issue({ identity }, op.cookie)).json();
    const first = uniq("first");
    const second = uniq("second");
    await redeem({ code, owner: first });
    await redeem({ code, owner: second });

    expect(ownership.isOwner(db, first, identity)).toBe(true);
    expect(ownership.isOwner(db, second, identity)).toBe(false);
    expect(ownership.owners(db, identity)).toHaveLength(1);
  });

  /**
   * **The last hop, not the first.** `x-forwarded-for` is client-appended and
   * anything but the entry nearest this server is a value the client chose.
   * Taking `[0]` would record whatever the caller typed into the header.
   */
  test("records the nearest address in x-forwarded-for", async () => {
    const op = await operator(SCOPE_TENANT);
    const { code } = await (await issue({ identity: registered() }, op.cookie)).json();
    await redeem({ code, owner: uniq("owner") }, { "x-forwarded-for": "10.0.0.1, 203.0.113.9" });
    expect(db.prepare(`SELECT redeemed_from FROM pairing_codes WHERE code = ?`).get(code))
      .toEqual({ redeemed_from: "203.0.113.9" });
  });

  test("falls back to x-real-ip, and to nothing at all", async () => {
    const op = await operator(SCOPE_TENANT);
    const codes: string[] = [];
    for (let i = 0; i < 3; i++) {
      codes.push((await (await issue({ identity: registered() }, op.cookie)).json()).code);
    }
    await redeem({ code: codes[0], owner: uniq("owner") }, { "x-real-ip": "198.51.100.4" });
    // An empty forwarded-for must not shadow the fallback.
    await redeem({ code: codes[1], owner: uniq("owner") },
      { "x-forwarded-for": "  ", "x-real-ip": "198.51.100.5" });
    await redeem({ code: codes[2], owner: uniq("owner") });

    const seen = codes.map((code) =>
      (db.prepare(`SELECT redeemed_from FROM pairing_codes WHERE code = ?`)
        .get(code) as { redeemed_from: string | null }).redeemed_from);
    expect(seen).toEqual(["198.51.100.4", "198.51.100.5", null]);
  });

  /**
   * Redeemed rows are kept. "Who claimed this, when, from where" is the
   * provenance of the ownership claim — deleting the code after use throws
   * away the only record of how the claim was made.
   */
  test("keeps the spent code as the record of the claim", async () => {
    const op = await operator(SCOPE_TENANT);
    const { code } = await (await issue({ identity: registered() }, op.cookie)).json();
    await redeem({ code, owner: uniq("owner") }, { "x-real-ip": "192.0.2.7" });
    const row = db.prepare(`SELECT redeemed_at, redeemed_from FROM pairing_codes WHERE code = ?`)
      .get(code) as { redeemed_at: string | null; redeemed_from: string | null };
    expect(row.redeemed_at).toBeTruthy();
    expect(row.redeemed_from).toBe("192.0.2.7");
  });

  /** Two owners for one identity is the point — an owner leaving must not strand it. */
  test("adds an owner rather than replacing the incumbent", async () => {
    const op = await operator(SCOPE_TENANT);
    const identity = registered();
    const first = uniq("first");
    const second = uniq("second");
    for (const owner of [first, second]) {
      const { code } = await (await issue({ identity }, op.cookie)).json();
      expect((await redeem({ code, owner })).status).toBe(200);
    }
    expect(ownership.owners(db, identity).map((o) => o.owner).sort())
      .toEqual([first, second].sort());
  });
});

// --- can_proxy (POST /api/v1/admin/agents/:identity/can-proxy) -------------

const setProxy = (identity: string, body: unknown, cookie: string) =>
  post(`/api/v1/admin/agents/${identity}/can-proxy`, body, { cookie });

describe("granting the right to speak for others", () => {
  test("refuses a caller with no session and one with no grant", async () => {
    const identity = registered();
    expect((await setProxy(identity, { can_proxy: true }, "")).status).toBe(401);
    const nobody = await operator();
    expect((await setProxy(identity, { can_proxy: true }, nobody.cookie)).status).toBe(403);
  });

  /**
   * **Scoped to the identity.** Holding `agent.provision` on `a` must not flip
   * `b` — that is the whole reason the scope column exists, and this is the
   * strongest capability there is to widen by accident.
   */
  test("refuses a grant held on a different identity", async () => {
    const mine = registered();
    const theirs = registered();
    const op = await operator(mine);

    expect((await setProxy(mine, { can_proxy: true }, op.cookie)).status).toBe(200);
    const res = await setProxy(theirs, { can_proxy: true }, op.cookie);
    expect(res.status).toBe(403);
    expect((await res.json()).scope).toBe(theirs);
    expect(entitlement.canProxy(db, theirs)).toBe(false);
  });

  /** A tenant-wide grant satisfies a narrower scope; the reverse never happens. */
  test("accepts a tenant-wide grant", async () => {
    const op = await operator(SCOPE_TENANT);
    const identity = registered();
    expect((await setProxy(identity, { can_proxy: true }, op.cookie)).status).toBe(200);
    expect(entitlement.canProxy(db, identity)).toBe(true);
  });

  /**
   * The capability check runs before the format check, so an off-pattern name
   * answers `403` to a stranger and `400` only to someone who could have acted
   * on it. The refusal that leaks less comes first.
   */
  test("checks the grant before the name's shape", async () => {
    const bad = "has%20space";
    expect((await setProxy(bad, { can_proxy: true }, (await operator()).cookie)).status).toBe(403);

    const op = await operator(SCOPE_TENANT);
    const res = await setProxy(bad, { can_proxy: true }, op.cookie);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("invalid identity format");
  });

  test("refuses a body it cannot parse", async () => {
    const op = await operator(SCOPE_TENANT);
    const res = await setProxy(registered(), "{not json", op.cookie);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("JSON");
  });

  /**
   * A boolean, not something truthy. `"false"` is a string a form sends and
   * reads as *on* everywhere that tests it loosely — here it is refused rather
   * than granted.
   */
  test("refuses can_proxy that is not a boolean", async () => {
    const op = await operator(SCOPE_TENANT);
    const identity = registered();
    for (const can_proxy of [undefined, 1, 0, "true", "false", null, {}]) {
      const res = await setProxy(identity, { can_proxy }, op.cookie);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("can_proxy must be a boolean");
    }
    expect(entitlement.canProxy(db, identity)).toBe(false);
  });

  /** Nothing is created on the way past. An unknown name is `404`, not an insert. */
  test("refuses a name this registry does not carry", async () => {
    const op = await operator(SCOPE_TENANT);
    const stranger = uniq("stranger");
    const res = await setProxy(stranger, { can_proxy: true }, op.cookie);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain(stranger);
    expect(db.prepare(`SELECT 1 FROM agents WHERE identity = ?`).get(stranger)).toBeNull();
  });

  /** A torn-down identity is gone for this purpose, not merely hidden from lists. */
  test("refuses an identity that has been torn down", async () => {
    const op = await operator(SCOPE_TENANT);
    const identity = registered();
    db.prepare(`UPDATE agents SET deleted_at = datetime('now') WHERE identity = ?`).run(identity);
    expect((await setProxy(identity, { can_proxy: true }, op.cookie)).status).toBe(404);
  });

  /** Both directions, and the store agrees with the answer. */
  test("grants it and takes it back", async () => {
    const op = await operator(SCOPE_TENANT);
    const identity = registered();

    const on = await setProxy(identity, { can_proxy: true }, op.cookie);
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ ok: true, identity, can_proxy: true });
    expect(entitlement.canProxy(db, identity)).toBe(true);

    const off = await setProxy(identity, { can_proxy: false }, op.cookie);
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ ok: true, identity, can_proxy: false });
    expect(entitlement.canProxy(db, identity)).toBe(false);
    expect(db.prepare(`SELECT can_proxy FROM agents WHERE identity = ?`).get(identity))
      .toEqual({ can_proxy: 0 });
  });

  /** One identity, and no other. */
  test("touches only the row it names", async () => {
    const op = await operator(SCOPE_TENANT);
    const target = registered();
    const bystander = registered();
    await setProxy(target, { can_proxy: true }, op.cookie);
    expect(entitlement.canProxy(db, bystander)).toBe(false);
  });
});

/**
 * **Teardown by ownership, when the capability alone does not reach.**
 *
 * § 11.3 lets a scoped `agent.teardown` holder tear down what they own. The
 * capability check answers the tenant-wide and per-identity grants; ownership
 * answers *it is mine* — and holding `agent.teardown` scoped to `lane-a` says
 * nothing about `lane-b`, which matters here more than anywhere because § 9.3
 * is irreversible: the name is never usable again.
 */
describe("tearing down what you own", () => {
  const teardown = (identity: string, cookie: string) =>
    app.fetch(new Request(`http://own-probe/api/v1/admin/agents/${identity}`, {
      method: "DELETE",
      headers: { cookie },
    }));

  /** A holder scoped to some other agent, who owns this one. */
  async function ownerOf(identity: string) {
    const login = uniq("owner");
    const user = upsertUser(371000 + n, login);
    createPendingApproval(login, user.github_id);
    approveUser(login);
    grants.grant(db, {
      subject: login,
      capability: CAPABILITY.AGENT_TEARDOWN,
      scope: uniq("elsewhere"),          // deliberately not this identity, nor the tenant
      grantedBy: "ownership-test",
    });
    ownership.assign(db, { identity, owner: login, grantedBy: "ownership-test" });
    const jwt = await signJwt({ github_id: user.github_id, github_login: login, role: "member" });
    return { login, cookie: `mesh_token=${jwt}` };
  }

  test("admits an owner whose grant names another agent", async () => {
    const identity = registered();
    const who = await ownerOf(identity);
    const res = await teardown(identity, who.cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, identity, action: "soft-deleted" });
  });

  /** Ownership of one agent is not ownership of the next. */
  test("refuses the same holder on an identity they do not own", async () => {
    const mine = registered();
    const theirs = registered();
    const who = await ownerOf(mine);
    expect((await teardown(theirs, who.cookie)).status).toBe(403);
  });

  /**
   * **Validated after the owner is known, and still validated.** A name that
   * cannot be an identity is refused with `400` rather than passed to the
   * store — ownership of a malformed name is a row somebody wrote, not a
   * reason to act on it.
   */
  test("refuses a malformed identity even from its owner", async () => {
    const bad = "-not-an-identity";
    const who = await ownerOf(bad);
    const res = await teardown(bad, who.cookie);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("invalid identity format");
  });
});
