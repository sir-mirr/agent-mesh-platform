/**
 * Admitting a person to this deployment, and naming what an agent may be.
 *
 * Two admin surfaces with one property in common: each has a refusal that
 * exists because the obvious alternative is worse.
 *
 * - **The temporary password is in one response and nowhere else.** Not the
 *   listing, not a read, not the log — and what is stored is a hash, so it
 *   cannot be recovered from the database either. The way that property breaks
 *   is a second route being helpful, so the listing is tested for its absence
 *   rather than trusted.
 * - **A type is create-only** (§ 10.3). The field worth updating is
 *   `requires_key`, and lowering it retroactively lets every identity of that
 *   type connect without a key (§ 8.1) — silently disarming the signing
 *   requirement for identities provisioned long before.
 *
 * And the gate that sits over everything: an account that must change its
 * password can do that and nothing else. **The server refuses, not the
 * screen** — a redirect is what the operator sees and not what stops `curl`
 * carrying the same cookie.
 *
 * This file owns the `aut-` prefix.
 */
import { describe, expect, test } from "bun:test";

process.env.JWT_SECRET ||= "admin-users-probe";

const { app } = await import("./main.ts");
const { upsertUser, approveUser, createPendingApproval, getLocalUser, getDb, SEED_ADMIN_USERNAME } = await import("./db");
const { signJwt } = await import("./auth");
const { STORE_FILES, agentsSchema, grants, openAt, stateDir, tenants } = await import("@agent-mesh/store");
const { CAPABILITY } = await import("@agent-mesh/contracts");
const { join } = await import("node:path");

const db = openAt(join(stateDir(), STORE_FILES.agents), { create: true });
agentsSchema.migrate(db);
grants.migrate(db);
tenants.migrate(db);

let n = 0;
const uniq = (p: string) => `aut-${p}-${++n}-${process.pid}`;

async function holder(...caps: string[]) {
  const login = uniq("op");
  const user = upsertUser(970000 + n, login);
  createPendingApproval(login, user.github_id);
  expect(approveUser(login)).toBe(true);
  for (const capability of caps) {
    grants.grant(db, { subject: login, capability, grantedBy: "admin-users-test" });
  }
  const jwt = await signJwt({ github_id: user.github_id, github_login: login, role: "member" });
  return { login, authorization: `Bearer ${jwt}` };
}

const req = (method: string, path: string, cookie: string, body?: unknown) =>
  app.fetch(new Request(`http://aut-probe${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: cookie },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  }));
const get = (p: string, c: string) => req("GET", p, c);
const post = (p: string, c: string, b?: unknown) => req("POST", p, c, b);
const del = (p: string, c: string) => req("DELETE", p, c);

// --- Local accounts --------------------------------------------------------

describe("admitting a person", () => {
  test("refuses a caller without user.admit", async () => {
    const nobody = await holder();
    for (const [method, path] of [
      ["POST", "/api/v1/admin/users"],
      ["POST", "/api/v1/admin/users/someone/password"],
      ["GET", "/api/v1/admin/users"],
    ] as Array<[string, string]>) {
      expect((await req(method, path, "", {})).status).toBe(401);
      const res = await req(method, path, nobody.authorization, {});
      expect(res.status).toBe(403);
      expect((await res.json()).capability).toBe(CAPABILITY.USER_ADMIT);
    }
  });

  test("refuses a body it cannot parse, and a username off-pattern", async () => {
    const op = await holder(CAPABILITY.USER_ADMIT);
    expect((await post("/api/v1/admin/users", op.authorization, "{not json")).status).toBe(400);
    for (const username of [undefined, 7, "", "-leading", "has space", "under_score"]) {
      const res = await post("/api/v1/admin/users", op.authorization, { username });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("username");
    }
  });

  /**
   * **Admission makes members. Promotion is a different act, on a different
   * screen, under a different capability** (owner's decision, T-045).
   *
   * `role` reached the store unread: any string was written, and `admin` is not
   * a label here — `isUserApproved` returns true for it outright, and this
   * server's own admin screens gate on the same string. So a `user.admit`
   * holder could mint an administrator by adding one field to a request the
   * console never shows, and a typo could write a role no check recognises,
   * leaving an account that opens nothing with nothing on screen saying why.
   *
   * The vocabulary is closed rather than filtered: `admin` is refused here
   * because it is somebody else's route to grant, and an unknown word is
   * refused because silently writing it is how the second failure happens.
   */
  test("admits members only, and refuses a role it does not know", async () => {
    const op = await holder(CAPABILITY.USER_ADMIT);

    const promoted = await post("/api/v1/admin/users", op.authorization, {
      username: uniq("would-be-admin"),
      role: "admin",
    });
    expect(promoted.status, "this route minted an administrator").toBe(400);
    expect((await promoted.json()).error).toContain("role");

    for (const role of ["administrator", "MEMBER", "owner", 7, ""]) {
      const res = await post("/api/v1/admin/users", op.authorization, { username: uniq("odd-role"), role });
      expect(res.status, `a role of ${JSON.stringify(role)} was accepted`).toBe(400);
    }

    // The two shapes that are the same request: `member`, and no role at all.
    for (const body of [{ role: "member" }, {}]) {
      const res = await post("/api/v1/admin/users", op.authorization, { username: uniq("newcomer"), ...body });
      expect(res.status, `${JSON.stringify(body)} was refused`).toBe(201);
      expect((await res.json()).user.role, "admission wrote a role other than member").toBe("member");
    }
  });

  /**
   * **The password is in this response and nowhere else.** The listing, the
   * stored row, and every read are checked for its absence — the way this
   * property breaks is a second route being helpful.
   */
  test("hands back a password that appears nowhere else", async () => {
    const op = await holder(CAPABILITY.USER_ADMIT);
    const username = uniq("newcomer");
    const res = await post("/api/v1/admin/users", op.authorization, { username, display_name: "A Newcomer" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.user).toMatchObject({ username, display_name: "A Newcomer" });
    const secret = body.temporary_password as string;
    expect(secret.length).toBeGreaterThan(8);

    // Not in the listing.
    const listed = await (await get("/api/v1/admin/users", op.authorization)).json();
    expect(JSON.stringify(listed)).not.toContain(secret);
    // **The exact column set**, because the way this breaks is `SELECT *`.
    // `must_change_password` is a flag and belongs here; a hash would not, and
    // a listing that names its columns cannot start carrying one by accident.
    const row = listed.users.find((u: any) => u.username === username);
    expect(row).toBeDefined();
    expect(Object.keys(row).sort()).toEqual([
      // `disabled_at` joined this list with T-047 and belongs here for the same
      // reason `must_change_password` does: it is a state an operator acts on.
      // A hash would not, and a listing that names its columns cannot start
      // carrying one by accident.
      "created_at", "disabled_at", "display_name", "must_change_password", "role", "tenant", "username",
    ]);

    // Not recoverable from the row either — what is stored is a hash.
    const stored = JSON.stringify(getLocalUser(username));
    expect(stored).not.toContain(secret);
  });

  /** Flagged from the start: its first login lands on the change screen. */
  test("puts the new account behind the first-login gate", async () => {
    const op = await holder(CAPABILITY.USER_ADMIT);
    const username = uniq("newcomer");
    await post("/api/v1/admin/users", op.authorization, { username });
    expect(getLocalUser(username)?.must_change_password).toBe(1);
  });

  /** Somebody already there is `409`, and the message says who. */
  test("refuses a name that is taken", async () => {
    const op = await holder(CAPABILITY.USER_ADMIT);
    const username = uniq("twice");
    expect((await post("/api/v1/admin/users", op.authorization, { username })).status).toBe(201);
    const again = await post("/api/v1/admin/users", op.authorization, { username });
    expect(again.status).toBe(409);
    expect((await again.json()).error).toContain(username);
  });

  /**
   * The tenant comes from what this reads, not from what the screen sends: an
   * operator who names nothing puts the account where they are, and one who
   * names a tenant has to be allowed to (T-026).
   */
  test("puts the account in the admitting operator's tenant by default", async () => {
    const op = await holder(CAPABILITY.USER_ADMIT);
    const here = uniq("here");
    await post("/api/v1/admin/users", op.authorization, { username: here });
    expect(getLocalUser(here)?.tenant).toBe("default");
  });

  /**
   * **Naming another tenant is the platform administrator's move.**
   * `user.admit` is held *inside* a tenant, so an operator who could name any
   * tenant would be creating accounts — including administrators — in tenants
   * they cannot see. Refused by the route rather than by a screen offering one
   * option, because the route answers without the screen.
   */
  test("refuses a tenant that is not the operator's own", async () => {
    const op = await holder(CAPABILITY.USER_ADMIT);
    tenants.createTenant(db, { id: "aut-elsewhere", name: "Elsewhere" });

    const named = uniq("elsewhere");
    const res = await post("/api/v1/admin/users", op.authorization, { username: named, tenant: "aut-elsewhere" });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("TENANT_NOT_YOURS");
    expect(getLocalUser(named)).toBeNull();
  });

  test("a platform administrator may name one, and it has to exist", async () => {
    const op = await holder(CAPABILITY.USER_ADMIT);
    getDb().prepare(`UPDATE users SET role = 'admin' WHERE github_login = ?`).run(op.login);
    tenants.createTenant(db, { id: "aut-branch", name: "Branch" });

    const named = uniq("posted");
    expect((await post("/api/v1/admin/users", op.authorization, { username: named, tenant: "aut-branch" })).status)
      .toBe(201);
    expect(getLocalUser(named)?.tenant).toBe("aut-branch");

    // A tenant nobody created is a typo, and `local_users.tenant` is a plain
    // string with nothing pointing back at the list — an account admitted into
    // one stays in a tenant no screen will ever show.
    const nowhere = uniq("nowhere");
    const res = await post("/api/v1/admin/users", op.authorization, { username: nowhere, tenant: "aut-not-a-tenant" });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("NO_SUCH_TENANT");
    expect(getLocalUser(nowhere)).toBeNull();
  });

  test("and a deleted tenant is not one that can be picked", async () => {
    const op = await holder(CAPABILITY.USER_ADMIT);
    getDb().prepare(`UPDATE users SET role = 'admin' WHERE github_login = ?`).run(op.login);
    tenants.createTenant(db, { id: "aut-closed", name: "Closed" });
    tenants.deleteTenant(db, "aut-closed");

    const res = await post("/api/v1/admin/users", op.authorization,
      { username: uniq("late"), tenant: "aut-closed" });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("NO_SUCH_TENANT");
  });

  /**
   * **A name is decoration; a role is access.** They are not held to the same
   * standard on purpose: a `display_name` that arrives as a number costs the
   * account a label, so it is dropped and the admission stands, while a role
   * that arrives as anything but `member` is refused outright — see the
   * vocabulary test above for why nothing else may be written here.
   */
  test("drops a display_name that is not a string, and refuses a role that is not one", async () => {
    const op = await holder(CAPABILITY.USER_ADMIT);
    const username = uniq("odd");
    const res = await post("/api/v1/admin/users", op.authorization, { username, display_name: 7 });
    expect(res.status).toBe(201);
    const { user } = await res.json();
    expect(user.display_name).not.toBe(7);
    expect(user.role).toBe("member");

    const typed = await post("/api/v1/admin/users", op.authorization,
      { username: uniq("odd"), display_name: 7, role: { not: "a string" } });
    expect(typed.status, "a role that is not even a string was admitted").toBe(400);
  });
});

/** What the registry says about a person, which deactivation has to move too. */
const registryApproval = (id: string): number | null =>
  (getDb().prepare("SELECT approved FROM agent_registry WHERE id = ?").get(id) as { approved: number } | null)
    ?.approved ?? null;

describe("deactivating an account", () => {
  /**
   * **Deactivation, not deletion** (T-047, D-803). The owner's reason for
   * choosing it is that it can be undone and that it leaves a record; a
   * deleted row has neither property.
   *
   * The two halves are asserted together because either alone is a working
   * account: a login that is refused while the session already in somebody's
   * browser keeps answering is not a deactivated account, it is a locked front
   * door with the back one open. § 11.1 already requires this — the token
   * carries who and the store answers what, precisely so that revoking access
   * does not have to wait out a token's lifetime.
   */
  test("refuses the login, the live session, and the mesh identity, and gives all three back", async () => {
    const op = await holder(CAPABILITY.USER_ADMIT);
    const username = uniq("leaver");
    const created = await post("/api/v1/admin/users", op.authorization, { username });
    expect(created.status).toBe(201);
    const password = (await created.json()).temporary_password as string;

    // A session in hand, established before the account is deactivated.
    //
    // **Carried as a bearer token, not as the cookie the browser would send.**
    // A `Request` built in this process keeps a `cookie` header here and loses
    // it on the runtime CI runs — measured four ways in
    // `set-cookie-survives.test.ts`, which forbids the header in this package
    // for that reason. The token is the same session material either way, and
    // `extractJwt` reads both paths through one check.
    const signedIn = await post("/auth/local", "", { username, password });
    expect(signedIn.status, "the new account could not sign in even before deactivation").toBe(200);
    expect(signedIn.headers.get("set-cookie") ?? "", "the sign-in handed back no session").toContain("mesh_token");
    const local = getLocalUser(username)!;
    const session = `Bearer ${await signJwt({ github_id: -local.id, github_login: username, role: local.role })}`;
    expect((await get("/auth/me", session)).status, "the session did not work before deactivation").toBe(200);

    const off = await post(`/api/v1/admin/users/${username}/deactivate`, op.authorization);
    expect(off.status).toBe(200);

    // ① The password that worked a moment ago is refused, and says why.
    const refused = await post("/auth/local", "", { username, password });
    expect(refused.status).toBe(403);
    expect((await refused.json()).error).toContain("deactivated");

    // **A wrong password says what it said before.** Naming the state to
    // somebody who cannot prove they own the account turns this route into a
    // way to enumerate accounts, which the refusal above deliberately avoids
    // by requiring the password first.
    const wrong = await post("/auth/local", "", { username, password: "not-the-password" });
    expect(wrong.status, "a wrong password revealed that the account exists").toBe(401);
    expect((await wrong.json()).error).not.toContain("deactivated");

    // ② The session already issued stops at the next request.
    expect((await get("/auth/me", session)).status, "a session issued before deactivation kept working").toBe(401);

    // ③ And the mesh identity goes with it, or the account is only half gone:
    // an approved registry row is re-provisioned on every hub connect, which
    // is how a removed person came back on the next restart.
    expect(registryApproval(username), "the mesh identity stayed approved").toBe(0);

    // Reactivation returns all three.
    const on = await post(`/api/v1/admin/users/${username}/reactivate`, op.authorization);
    expect(on.status).toBe(200);
    const back = await post("/auth/local", "", { username, password });
    expect(back.status, "the account could not sign in again after reactivation").toBe(200);
    expect(registryApproval(username), "the mesh identity was not restored").toBe(1);
  });

  test("refuses a deactivation of somebody who is not there", async () => {
    const op = await holder(CAPABILITY.USER_ADMIT);
    const res = await post(`/api/v1/admin/users/${uniq("ghost")}/deactivate`, op.authorization);
    expect(res.status).toBe(404);
  });

  /**
   * **Two refusals that are this repository's judgement, approved by the PM
   * and open to the owner reversing them.** Deactivating yourself is a door
   * locked from the inside with the key still in it; deactivating the seeded
   * administrator is the same act performed on the account an installation
   * recovers through.
   */
  test("refuses to deactivate the caller or the seeded administrator", async () => {
    const op = await holder(CAPABILITY.USER_ADMIT);
    const self = await post(`/api/v1/admin/users/${op.login}/deactivate`, op.authorization);
    expect(self.status, "an operator deactivated their own account").toBe(409);
    expect((await self.json()).code).toBe("SELF_DEACTIVATION");

    const seed = await post(`/api/v1/admin/users/${SEED_ADMIN_USERNAME}/deactivate`, op.authorization);
    expect(seed.status, "the installation's recovery account was deactivated").toBe(409);
    expect((await seed.json()).code).toBe("PROTECTED_ACCOUNT");
  });

  test("says which accounts are deactivated when it lists them", async () => {
    const op = await holder(CAPABILITY.USER_ADMIT);
    const username = uniq("listed");
    expect((await post("/api/v1/admin/users", op.authorization, { username })).status).toBe(201);
    const before = ((await (await get("/api/v1/admin/users", op.authorization)).json()).users as any[])
      .find((u) => u.username === username);
    expect(before?.disabled_at ?? null, "a new account was listed as already deactivated").toBeNull();

    await post(`/api/v1/admin/users/${username}/deactivate`, op.authorization);
    const after = ((await (await get("/api/v1/admin/users", op.authorization)).json()).users as any[])
      .find((u) => u.username === username);
    expect(typeof after?.disabled_at, "the listing does not say the account is deactivated").toBe("string");
  });
});

describe("reissuing a password", () => {
  /**
   * **`404`, not `409`.** Admission refuses because somebody is already there;
   * this refuses because nobody is. Answering them the same way would send an
   * operator looking for the wrong thing — and before this route existed, an
   * account whose holder forgot their password had no route at all: the reissue
   * came back `409` from admission.
   */
  test("answers a different absence than admission does", async () => {
    const op = await holder(CAPABILITY.USER_ADMIT);
    const stranger = uniq("stranger");
    const res = await post(`/api/v1/admin/users/${stranger}/password`, op.authorization, {});
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain(stranger);
  });

  test("issues a different password and says the account must change it", async () => {
    const op = await holder(CAPABILITY.USER_ADMIT);
    const username = uniq("forgetful");
    const first = (await (await post("/api/v1/admin/users", op.authorization, { username })).json())
      .temporary_password as string;

    const res = await post(`/api/v1/admin/users/${username}/password`, op.authorization, {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, username, must_change_password: true });
    expect(body.temporary_password).not.toBe(first);

    // And back behind the gate: a password read out loud is a way in for one
    // login, not a password.
    expect(getLocalUser(username)?.must_change_password).toBe(1);

    const listed = await (await get("/api/v1/admin/users", op.authorization)).json();
    expect(JSON.stringify(listed)).not.toContain(body.temporary_password);
  });
});

// --- The gate over everything ---------------------------------------------

describe("an account that must change its password", () => {
  async function flagged() {
    const op = await holder(CAPABILITY.USER_ADMIT);
    const username = uniq("flagged");
    await post("/api/v1/admin/users", op.authorization, { username });
    const jwt = await signJwt({ github_id: 0, github_login: username, role: "member" });
    return { username, authorization: `Bearer ${jwt}` };
  }

  /**
   * **The server refuses, not the screen.** A redirect is what an operator
   * sees; it is not what stops `curl` carrying the same cookie.
   */
  test("is refused everywhere, with the reason in the body", async () => {
    const who = await flagged();
    for (const path of ["/api/v1/admin/users", "/api/v1/messages", "/api/v1/admin/agent-types"]) {
      const res = await get(path, who.authorization);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ must_change_password: true });
    }
  });

  /**
   * Three routes stay open and each for a reason: the change itself, `/auth/me`
   * so the console can ask *why* it is refused, and logout so the session can
   * be abandoned rather than repaired.
   */
  test("may change its password, ask why, and leave", async () => {
    const who = await flagged();
    for (const path of ["/auth/me", "/auth/local/password", "/auth/logout"]) {
      const res = await get(path, who.authorization);
      expect(res.status).not.toBe(403);
    }
  });

  /** An account that is not flagged passes through untouched. */
  test("does not stand in anybody else's way", async () => {
    const op = await holder(CAPABILITY.USER_ADMIT);
    const res = await get("/api/v1/admin/users", op.authorization);
    expect(res.status).toBe(200);
  });
});

// --- Agent types (§ 10.3) --------------------------------------------------

describe("naming what an agent may be", () => {
  test("refuses a caller without agent.provision", async () => {
    const nobody = await holder();
    for (const [method, path] of [
      ["GET", "/api/v1/admin/agent-types"],
      ["POST", "/api/v1/admin/agent-types"],
      ["DELETE", "/api/v1/admin/agent-types/whatever"],
    ] as Array<[string, string]>) {
      expect((await req(method, path, nobody.authorization, {})).status).toBe(403);
    }
  });

  test("refuses a body it cannot parse, and a type off-pattern", async () => {
    const op = await holder(CAPABILITY.AGENT_PROVISION);
    expect((await post("/api/v1/admin/agent-types", op.authorization, "{not json")).status).toBe(400);
    for (const type of [undefined, 7, "", "has space", "under_score"]) {
      const res = await post("/api/v1/admin/agent-types", op.authorization, { type });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("type");
    }
  });

  /**
   * **Unstated means required.** A type that needs no key is the exception —
   * `service` and `human` — so anything the caller did not say lands on the
   * side that keeps § 8.1's signing requirement.
   */
  test("requires a key unless told otherwise in so many words", async () => {
    const op = await holder(CAPABILITY.AGENT_PROVISION);
    const cases: Array<[unknown, number]> = [
      [undefined, 1], ["false", 1], [null, 1], [1, 1], ["0", 1],   // anything unclear
      [0, 0], [false, 0],                                           // the two that mean it
    ];
    for (const [requires_key, expected] of cases) {
      const type = uniq("kind");
      const res = await post("/api/v1/admin/agent-types", op.authorization, { type, requires_key });
      expect(res.status).toBe(201);
      expect((await res.json()).type.requires_key, `requires_key: ${JSON.stringify(requires_key)}`)
        .toBe(expected);
    }
  });

  test("keeps a description only when it is a string", async () => {
    const op = await holder(CAPABILITY.AGENT_PROVISION);
    const typed = uniq("kind");
    await post("/api/v1/admin/agent-types", op.authorization, { type: typed, description: 7 });
    expect(agentsSchema.getType(db, typed)?.description).toBeNull();
  });

  /**
   * **Create-only, and this is the § 8.1 property.** Updating would let an
   * operator lower `requires_key` on a type identities already carry, which
   * disarms the signing requirement for every one of them — provisioned long
   * before anybody thought about it.
   */
  test("refuses to update an existing type rather than lowering its guard", async () => {
    const op = await holder(CAPABILITY.AGENT_PROVISION);
    const type = uniq("kind");
    expect((await post("/api/v1/admin/agent-types", op.authorization, { type })).status).toBe(201);

    const again = await post("/api/v1/admin/agent-types", op.authorization, { type, requires_key: 0 });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ ok: false, code: "TYPE_EXISTS" });
    expect(agentsSchema.getType(db, type)?.requires_key).toBe(1);
  });

  test("lists what it has been told, including the new one", async () => {
    const op = await holder(CAPABILITY.AGENT_PROVISION);
    const type = uniq("kind");
    await post("/api/v1/admin/agent-types", op.authorization, { type, description: "a kind of thing" });
    const { ok, types } = await (await get("/api/v1/admin/agent-types", op.authorization)).json();
    expect(ok).toBe(true);
    expect(types.find((t: any) => t.type === type))
      .toMatchObject({ type, description: "a kind of thing", requires_key: 1 });
  });
});

describe("taking a type away", () => {
  /**
   * **A type identities carry is not removable**, and the refusal names them —
   * capped, because an operator needs enough to go and look rather than all of
   * them.
   */
  test("refuses while anybody carries it, and says who", async () => {
    const op = await holder(CAPABILITY.AGENT_PROVISION);
    const type = uniq("kind");
    await post("/api/v1/admin/agent-types", op.authorization, { type });
    const carrier = uniq("agent");
    db.prepare(`INSERT INTO agents (identity, type) VALUES (?, ?)`).run(carrier, type);

    const res = await del(`/api/v1/admin/agent-types/${type}`, op.authorization);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, code: "TYPE_IN_USE" });
    expect(body.identities).toContain(carrier);
    expect(agentsSchema.getType(db, type)).not.toBeNull();
  });

  /** Twenty names at most. The rest is a number in the sentence. */
  test("names at most twenty of them", async () => {
    const op = await holder(CAPABILITY.AGENT_PROVISION);
    const type = uniq("crowded");
    await post("/api/v1/admin/agent-types", op.authorization, { type });
    for (let i = 0; i < 25; i++) {
      db.prepare(`INSERT INTO agents (identity, type) VALUES (?, ?)`).run(uniq("carrier"), type);
    }
    const body = await (await del(`/api/v1/admin/agent-types/${type}`, op.authorization)).json();
    expect(body.identities).toHaveLength(20);
    expect(body.error).toContain("25");
  });

  /**
   * **A soft-deleted identity still counts.** It carries the type and can be
   * brought back, so removing the type underneath it would restore an identity
   * whose kind no longer exists.
   */
  test("counts an identity that has been torn down", async () => {
    const op = await holder(CAPABILITY.AGENT_PROVISION);
    const type = uniq("kind");
    await post("/api/v1/admin/agent-types", op.authorization, { type });
    const gone = uniq("agent");
    db.prepare(`INSERT INTO agents (identity, type, deleted_at) VALUES (?, ?, datetime('now'))`)
      .run(gone, type);
    const res = await del(`/api/v1/admin/agent-types/${type}`, op.authorization);
    expect(res.status).toBe(409);
    expect((await res.json()).identities).toContain(gone);
  });

  /**
   * `200` either way with `action` saying which — one clause, one word. Four
   * delete routes had four vocabularies for the same two outcomes.
   */
  test("says deleted or not-found, and never disagrees with its status", async () => {
    const op = await holder(CAPABILITY.AGENT_PROVISION);
    const type = uniq("kind");
    await post("/api/v1/admin/agent-types", op.authorization, { type });

    const deleted = await del(`/api/v1/admin/agent-types/${type}`, op.authorization);
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true, type, action: "deleted" });
    expect(agentsSchema.getType(db, type)).toBeNull();

    const again = await del(`/api/v1/admin/agent-types/${type}`, op.authorization);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, type, action: "not-found" });
  });
});

// --- Passing the gate (POST /auth/local/password) --------------------------

describe("changing the password that was handed to you", () => {
  /** An account admitted through the route above, holding its temporary password. */
  async function admitted() {
    const op = await holder(CAPABILITY.USER_ADMIT);
    const username = uniq("holder");
    const res = await post("/api/v1/admin/users", op.authorization, { username });
    const { temporary_password } = await res.json();
    const jwt = await signJwt({ github_id: 0, github_login: username, role: "member" });
    return { username, password: temporary_password as string, authorization: `Bearer ${jwt}` };
  }

  const change = (cookie: string, body: unknown) =>
    post("/auth/local/password", cookie, body);

  test("refuses a body it cannot parse", async () => {
    const who = await admitted();
    expect((await change(who.authorization, "{not json")).status).toBe(400);
  });

  /**
   * Eight characters is the floor, and both halves have to be strings. The
   * check is on `next` only — `current` is whatever the account already has,
   * and refusing a short one would lock out an account admitted before the
   * floor existed.
   */
  test("refuses a next that is missing, short, or not a string", async () => {
    const who = await admitted();
    for (const body of [
      {}, { current: who.password }, { next: "longenough" },
      { current: who.password, next: "short" },
      { current: who.password, next: 12345678 },
      { current: 7, next: "longenough" },
    ]) {
      const res = await change(who.authorization, body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("`next`");
    }
  });

  /** Changing it to itself is not a change, and a gate it passes is not passed. */
  test("refuses a next that is the current one", async () => {
    const who = await admitted();
    const res = await change(who.authorization, { current: who.password, next: who.password });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("must differ");
  });

  /**
   * `403`, not `404`. The account exists and the caller does not know its
   * password — a `404` would say the opposite and hand a prober a way to tell
   * a real account from an invented one.
   */
  test("refuses a wrong current password without denying the account exists", async () => {
    const who = await admitted();
    const res = await change(who.authorization, { current: "not-the-password", next: "longenough" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("`current`");
  });

  /** A session with no local account behind it has nothing to change. */
  test("answers 404 for a session that is not a local account", async () => {
    const github = await holder(CAPABILITY.USER_ADMIT);   // an OAuth session
    const res = await change(github.authorization, { current: "whatever", next: "longenough" });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain("no local account");
  });

  /**
   * **The gate opens.** The point of the whole flow: the account was refused
   * everywhere until this succeeded, and is refused nowhere after.
   */
  test("clears the flag, and the refusal with it", async () => {
    const who = await admitted();
    expect((await get("/api/v1/admin/users", who.authorization)).status).toBe(403);

    const res = await change(who.authorization, { current: who.password, next: "a-longer-one" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, must_change_password: false });
    expect(getLocalUser(who.username)?.must_change_password).toBe(0);

    // No longer refused by the gate. `403` for a missing capability is a
    // different refusal and the body says which.
    const after = await get("/api/v1/admin/users", who.authorization);
    expect(await after.json()).not.toMatchObject({ must_change_password: true });
  });

  /** And the old password stops working, which is what changing one means. */
  test("leaves the password it replaced unusable", async () => {
    const who = await admitted();
    await change(who.authorization, { current: who.password, next: "a-longer-one" });
    const again = await change(who.authorization, { current: who.password, next: "another-longer-one" });
    expect(again.status).toBe(403);
  });
});
