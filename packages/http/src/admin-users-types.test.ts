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
const { upsertUser, approveUser, createPendingApproval, getLocalUser } = await import("./db");
const { signJwt } = await import("./auth");
const { STORE_FILES, agentsSchema, grants, openAt, stateDir } = await import("@agent-mesh/store");
const { CAPABILITY } = await import("@agent-mesh/contracts");
const { join } = await import("node:path");

const db = openAt(join(stateDir(), STORE_FILES.agents), { create: true });
agentsSchema.migrate(db);
grants.migrate(db);

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
  return { login, cookie: `mesh_token=${jwt}` };
}

const req = (method: string, path: string, cookie: string, body?: unknown) =>
  app.fetch(new Request(`http://aut-probe${path}`, {
    method,
    headers: { "content-type": "application/json", cookie },
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
      const res = await req(method, path, nobody.cookie, {});
      expect(res.status).toBe(403);
      expect((await res.json()).capability).toBe(CAPABILITY.USER_ADMIT);
    }
  });

  test("refuses a body it cannot parse, and a username off-pattern", async () => {
    const op = await holder(CAPABILITY.USER_ADMIT);
    expect((await post("/api/v1/admin/users", op.cookie, "{not json")).status).toBe(400);
    for (const username of [undefined, 7, "", "-leading", "has space", "under_score"]) {
      const res = await post("/api/v1/admin/users", op.cookie, { username });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("username");
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
    const res = await post("/api/v1/admin/users", op.cookie, { username, display_name: "A Newcomer" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.user).toMatchObject({ username, display_name: "A Newcomer" });
    const secret = body.temporary_password as string;
    expect(secret.length).toBeGreaterThan(8);

    // Not in the listing.
    const listed = await (await get("/api/v1/admin/users", op.cookie)).json();
    expect(JSON.stringify(listed)).not.toContain(secret);
    // **The exact column set**, because the way this breaks is `SELECT *`.
    // `must_change_password` is a flag and belongs here; a hash would not, and
    // a listing that names its columns cannot start carrying one by accident.
    const row = listed.users.find((u: any) => u.username === username);
    expect(row).toBeDefined();
    expect(Object.keys(row).sort()).toEqual([
      "created_at", "display_name", "must_change_password", "role", "tenant", "username",
    ]);

    // Not recoverable from the row either — what is stored is a hash.
    const stored = JSON.stringify(getLocalUser(username));
    expect(stored).not.toContain(secret);
  });

  /** Flagged from the start: its first login lands on the change screen. */
  test("puts the new account behind the first-login gate", async () => {
    const op = await holder(CAPABILITY.USER_ADMIT);
    const username = uniq("newcomer");
    await post("/api/v1/admin/users", op.cookie, { username });
    expect(getLocalUser(username)?.must_change_password).toBe(1);
  });

  /** Somebody already there is `409`, and the message says who. */
  test("refuses a name that is taken", async () => {
    const op = await holder(CAPABILITY.USER_ADMIT);
    const username = uniq("twice");
    expect((await post("/api/v1/admin/users", op.cookie, { username })).status).toBe(201);
    const again = await post("/api/v1/admin/users", op.cookie, { username });
    expect(again.status).toBe(409);
    expect((await again.json()).error).toContain(username);
  });

  /**
   * The tenant comes from what this reads, not from what the screen sends: an
   * operator naming one is taken at their word, and one who names nothing puts
   * the account where they are.
   */
  test("takes a named tenant, and otherwise the default", async () => {
    const op = await holder(CAPABILITY.USER_ADMIT);
    const named = uniq("elsewhere");
    await post("/api/v1/admin/users", op.cookie, { username: named, tenant: "other-tenant" });
    expect(getLocalUser(named)?.tenant).toBe("other-tenant");

    const here = uniq("here");
    await post("/api/v1/admin/users", op.cookie, { username: here });
    expect(getLocalUser(here)?.tenant).toBe("default");
  });

  test("ignores a display_name or role that is not a string", async () => {
    const op = await holder(CAPABILITY.USER_ADMIT);
    const username = uniq("odd");
    const res = await post("/api/v1/admin/users", op.cookie,
      { username, display_name: 7, role: { not: "a string" } });
    expect(res.status).toBe(201);
    const { user } = await res.json();
    expect(user.display_name).not.toBe(7);
    expect(typeof user.role).toBe("string");
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
    const res = await post(`/api/v1/admin/users/${stranger}/password`, op.cookie, {});
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain(stranger);
  });

  test("issues a different password and says the account must change it", async () => {
    const op = await holder(CAPABILITY.USER_ADMIT);
    const username = uniq("forgetful");
    const first = (await (await post("/api/v1/admin/users", op.cookie, { username })).json())
      .temporary_password as string;

    const res = await post(`/api/v1/admin/users/${username}/password`, op.cookie, {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, username, must_change_password: true });
    expect(body.temporary_password).not.toBe(first);

    // And back behind the gate: a password read out loud is a way in for one
    // login, not a password.
    expect(getLocalUser(username)?.must_change_password).toBe(1);

    const listed = await (await get("/api/v1/admin/users", op.cookie)).json();
    expect(JSON.stringify(listed)).not.toContain(body.temporary_password);
  });
});

// --- The gate over everything ---------------------------------------------

describe("an account that must change its password", () => {
  async function flagged() {
    const op = await holder(CAPABILITY.USER_ADMIT);
    const username = uniq("flagged");
    await post("/api/v1/admin/users", op.cookie, { username });
    const jwt = await signJwt({ github_id: 0, github_login: username, role: "member" });
    return { username, cookie: `mesh_token=${jwt}` };
  }

  /**
   * **The server refuses, not the screen.** A redirect is what an operator
   * sees; it is not what stops `curl` carrying the same cookie.
   */
  test("is refused everywhere, with the reason in the body", async () => {
    const who = await flagged();
    for (const path of ["/api/v1/admin/users", "/api/v1/messages", "/api/v1/admin/agent-types"]) {
      const res = await get(path, who.cookie);
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
      const res = await get(path, who.cookie);
      expect(res.status).not.toBe(403);
    }
  });

  /** An account that is not flagged passes through untouched. */
  test("does not stand in anybody else's way", async () => {
    const op = await holder(CAPABILITY.USER_ADMIT);
    const res = await get("/api/v1/admin/users", op.cookie);
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
      expect((await req(method, path, nobody.cookie, {})).status).toBe(403);
    }
  });

  test("refuses a body it cannot parse, and a type off-pattern", async () => {
    const op = await holder(CAPABILITY.AGENT_PROVISION);
    expect((await post("/api/v1/admin/agent-types", op.cookie, "{not json")).status).toBe(400);
    for (const type of [undefined, 7, "", "has space", "under_score"]) {
      const res = await post("/api/v1/admin/agent-types", op.cookie, { type });
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
      const res = await post("/api/v1/admin/agent-types", op.cookie, { type, requires_key });
      expect(res.status).toBe(201);
      expect((await res.json()).type.requires_key, `requires_key: ${JSON.stringify(requires_key)}`)
        .toBe(expected);
    }
  });

  test("keeps a description only when it is a string", async () => {
    const op = await holder(CAPABILITY.AGENT_PROVISION);
    const typed = uniq("kind");
    await post("/api/v1/admin/agent-types", op.cookie, { type: typed, description: 7 });
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
    expect((await post("/api/v1/admin/agent-types", op.cookie, { type })).status).toBe(201);

    const again = await post("/api/v1/admin/agent-types", op.cookie, { type, requires_key: 0 });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ ok: false, code: "TYPE_EXISTS" });
    expect(agentsSchema.getType(db, type)?.requires_key).toBe(1);
  });

  test("lists what it has been told, including the new one", async () => {
    const op = await holder(CAPABILITY.AGENT_PROVISION);
    const type = uniq("kind");
    await post("/api/v1/admin/agent-types", op.cookie, { type, description: "a kind of thing" });
    const { ok, types } = await (await get("/api/v1/admin/agent-types", op.cookie)).json();
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
    await post("/api/v1/admin/agent-types", op.cookie, { type });
    const carrier = uniq("agent");
    db.prepare(`INSERT INTO agents (identity, type) VALUES (?, ?)`).run(carrier, type);

    const res = await del(`/api/v1/admin/agent-types/${type}`, op.cookie);
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
    await post("/api/v1/admin/agent-types", op.cookie, { type });
    for (let i = 0; i < 25; i++) {
      db.prepare(`INSERT INTO agents (identity, type) VALUES (?, ?)`).run(uniq("carrier"), type);
    }
    const body = await (await del(`/api/v1/admin/agent-types/${type}`, op.cookie)).json();
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
    await post("/api/v1/admin/agent-types", op.cookie, { type });
    const gone = uniq("agent");
    db.prepare(`INSERT INTO agents (identity, type, deleted_at) VALUES (?, ?, datetime('now'))`)
      .run(gone, type);
    const res = await del(`/api/v1/admin/agent-types/${type}`, op.cookie);
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
    await post("/api/v1/admin/agent-types", op.cookie, { type });

    const deleted = await del(`/api/v1/admin/agent-types/${type}`, op.cookie);
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true, type, action: "deleted" });
    expect(agentsSchema.getType(db, type)).toBeNull();

    const again = await del(`/api/v1/admin/agent-types/${type}`, op.cookie);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, type, action: "not-found" });
  });
});
