/**
 * The tenant list and who may change it (T-026).
 *
 * A tenant id is a plain string in `agents`, `local_users`, `agent_groups` and
 * `message_stats`, with nothing pointing back at the row that names it. Every
 * refusal here follows from that: an id cannot be reused, a tenant cannot be
 * removed outright, and an account cannot be admitted into one that is not on
 * the list.
 *
 * **Who may is a stand-in.** § 11's vocabulary of twelve has no name for
 * *manages the list of tenants*, so `role = 'admin'` stands in until adding one
 * is somebody's call to make (a contracts tag moves three repositories). The
 * tests below say `platform administrator` and go through the route, so the day
 * the capability exists, `requirePlatformAdmin` changes and these do not.
 *
 * This file owns the `tn-` prefix.
 */
import { beforeAll, describe, expect, test } from "bun:test";

process.env.JWT_SECRET ||= "tenants-admin-probe";

const { app } = await import("./main.ts");
const { upsertUser, approveUser, createPendingApproval, getDb, getLocalUser } = await import("./db");
const { signJwt } = await import("./auth");
const { STORE_FILES, agentsSchema, grants, openAt, stateDir, tenants } = await import("@agent-mesh/store");
const { join } = await import("node:path");

const db = openAt(join(stateDir(), STORE_FILES.agents), { create: true });
agentsSchema.migrate(db);
grants.migrate(db);

let n = 0;
const uniq = (p: string) => `tn-${p}-${++n}-${process.pid}`;

/** An approved session. `admin: true` makes it the platform administrator stand-in. */
async function session(opts: { admin?: boolean } = {}) {
  const login = uniq(opts.admin ? "root" : "member");
  const user = upsertUser(1_090_000 + n, login);
  createPendingApproval(login, user.github_id);
  expect(approveUser(login)).toBe(true);
  if (opts.admin) {
    getDb().prepare(`UPDATE users SET role = 'admin' WHERE github_login = ?`).run(login);
  }
  const jwt = await signJwt({ github_id: user.github_id, github_login: login, role: "member" });
  return { login, authorization: `Bearer ${jwt}` };
}

const call = (method: string, path: string, cookie: string, body?: unknown) =>
  app.fetch(new Request(`http://tn-probe${path}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { authorization: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));

const TENANTS = "/api/v1/admin/tenants";

beforeAll(() => {
  // The route reads through `agentsDb()`; this handle is the same file.
  tenants.migrate(db);
});

describe("the directory", () => {
  test("refuses a caller with no session at all", async () => {
    expect((await call("GET", `${TENANTS}/directory`, "")).status).toBe(401);
  });

  /**
   * § 9.1's three states. This route holds no capability of its own, so
   * without an approval check it would be the one admin route a person still
   * waiting in `GET /api/v1/admin/pending` can read.
   */
  test("refuses a session nobody has approved, and says which state it is in", async () => {
    const login = uniq("pending");
    const user = upsertUser(1_095_000 + n, login);
    createPendingApproval(login, user.github_id);
    const jwt = await signJwt({ github_id: user.github_id, github_login: login, role: "member" });

    const res = await call("GET", `${TENANTS}/directory`, `Bearer ${jwt}`);
    expect(res.status).toBe(403);
    expect((await res.json()).approved).toBe(false);
  });

  /**
   * Not gated on `tenant.read.stats`. That capability answers *how much traffic
   * a tenant received*; this answers *which tenants there are*, and a tenant
   * admin naming their own tenant on a screen needs the second without the
   * first — refusing them would leave the screen showing an id.
   */
  test("shows an ordinary session its own tenant and nothing else", async () => {
    const admin = await session({ admin: true });
    await call("POST", TENANTS, admin.authorization, { id: uniq("other"), name: "Somebody Else" });

    const member = await session();
    const body = await (await call("GET", `${TENANTS}/directory`, member.authorization)).json();
    expect(body.tenant).toBe("default");
    expect(body.tenants.map((t: any) => t.id)).toEqual(["default"]);
  });

  test("shows the platform administrator all of them, deleted ones included", async () => {
    const admin = await session({ admin: true });
    const gone = uniq("closed");
    await call("POST", TENANTS, admin.authorization, { id: gone, name: "Closed" });
    expect((await call("DELETE", `${TENANTS}/${gone}`, admin.authorization)).status).toBe(200);

    const body = await (await call("GET", `${TENANTS}/directory`, admin.authorization)).json();
    const row = body.tenants.find((t: any) => t.id === gone);
    // Named rather than hidden: somebody explaining last month's traffic needs
    // the name of a tenant nobody may pick any more, and a picker filters on
    // `deleted_at` rather than on the list being short.
    expect(row).toBeDefined();
    expect(row.deleted_at).not.toBeNull();
    expect(row.name).toBe("Closed");
  });

  test("carries the default tenant under the name a person reads", async () => {
    const member = await session();
    const body = await (await call("GET", `${TENANTS}/directory`, member.authorization)).json();
    expect(body.tenants[0]).toMatchObject({ id: "default", name: tenants.DEFAULT_TENANT_NAME });
  });
});

describe("creating one", () => {
  test("refuses an ordinary session, and says what it is reserved to", async () => {
    const member = await session();
    const res = await call("POST", TENANTS, member.authorization, { id: uniq("acme"), name: "Acme" });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("PLATFORM_ADMIN_ONLY");
  });

  test("takes an id and a name, and answers the row", async () => {
    const admin = await session({ admin: true });
    const id = uniq("acme");
    const res = await call("POST", TENANTS, admin.authorization, { id, name: "  Acme  " });
    expect(res.status).toBe(201);
    const { tenant } = await res.json();
    // Trimmed: a name with an edge of whitespace sorts and searches as a
    // different string from the one anybody typed.
    expect(tenant).toMatchObject({ id, name: "Acme", deleted_at: null });
  });

  test("refuses a malformed id and a blank name, before writing anything", async () => {
    const admin = await session({ admin: true });
    expect((await call("POST", TENANTS, admin.authorization, { id: "not a tenant id", name: "X" })).status)
      .toBe(400);
    const id = uniq("nameless");
    expect((await call("POST", TENANTS, admin.authorization, { id, name: "   " })).status).toBe(400);
    expect(tenants.getTenant(db, id)).toBeNull();
  });

  test("refuses an id that is taken, including by a deleted tenant", async () => {
    const admin = await session({ admin: true });
    const id = uniq("twice");
    expect((await call("POST", TENANTS, admin.authorization, { id, name: "First" })).status).toBe(201);

    const again = await call("POST", TENANTS, admin.authorization, { id, name: "Second" });
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe("TENANT_EXISTS");
    expect(tenants.getTenant(db, id)!.name).toBe("First");

    await call("DELETE", `${TENANTS}/${id}`, admin.authorization);
    const afterDelete = await call("POST", TENANTS, admin.authorization, { id, name: "Third" });
    expect(afterDelete.status).toBe(409);
    // The two 409s are not the same refusal, and the message says which: an id
    // freed by deletion would attribute last week's `message_stats` rows to
    // whoever took it next.
    expect((await afterDelete.json()).error).toContain("deleted");
  });
});

describe("renaming one", () => {
  test("moves the name and never the id", async () => {
    const admin = await session({ admin: true });
    const id = uniq("acme");
    await call("POST", TENANTS, admin.authorization, { id, name: "Acme" });

    const res = await call("PATCH", `${TENANTS}/${id}`, admin.authorization, { name: "Acme Holdings" });
    expect(res.status).toBe(200);
    expect((await res.json()).tenant).toMatchObject({ id, name: "Acme Holdings" });
  });

  test("is the platform administrator's, and 404 for a tenant nobody created", async () => {
    const admin = await session({ admin: true });
    const member = await session();
    const id = uniq("acme");
    await call("POST", TENANTS, admin.authorization, { id, name: "Acme" });

    expect((await call("PATCH", `${TENANTS}/${id}`, member.authorization, { name: "Mine Now" })).status)
      .toBe(403);
    expect(tenants.getTenant(db, id)!.name).toBe("Acme");
    expect((await call("PATCH", `${TENANTS}/tn-never-existed`, admin.authorization, { name: "X" })).status)
      .toBe(404);
    expect((await call("PATCH", `${TENANTS}/${id}`, admin.authorization, { name: "  " })).status).toBe(400);
  });

  /**
   * The default tenant is renameable — that is the whole point of a name that
   * is not the id. Deleting it is not.
   */
  test("includes the default tenant", async () => {
    const admin = await session({ admin: true });
    const before = tenants.getTenant(db, "default")!.name;
    expect((await call("PATCH", `${TENANTS}/default`, admin.authorization, { name: "Head Office" })).status)
      .toBe(200);
    expect(tenants.getTenant(db, "default")!.name).toBe("Head Office");
    tenants.renameTenant(db, "default", before);
  });
});

describe("deleting one", () => {
  test("refuses the default tenant", async () => {
    const admin = await session({ admin: true });
    const res = await call("DELETE", `${TENANTS}/default`, admin.authorization);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("DEFAULT_TENANT");
    expect(tenants.getTenant(db, "default")!.deleted_at).toBeNull();
  });

  /**
   * `200` with `action`, like the other four delete routes on this service —
   * `test/delete-absence.test.ts` reads them out of the source so a new one
   * cannot answer differently. A target that is not there is not an error.
   */
  test("says not-found for a tenant nobody created, rather than refusing", async () => {
    const admin = await session({ admin: true });
    const res = await call("DELETE", `${TENANTS}/tn-never-existed`, admin.authorization);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, action: "not-found" });
  });

  test("stops offering it, keeps the row, and names the three outcomes apart", async () => {
    const admin = await session({ admin: true });
    const id = uniq("closing");
    await call("POST", TENANTS, admin.authorization, { id, name: "Closing" });

    const first = await call("DELETE", `${TENANTS}/${id}`, admin.authorization);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, action: "deleted" });

    const second = await call("DELETE", `${TENANTS}/${id}`, admin.authorization);
    expect(second.status).toBe(200);
    // Three cases, three words: doing it, having done it, and never having had
    // it. One boolean beside `ok` would collapse the last two, and they are the
    // two an operator most needs told apart.
    expect(await second.json()).toMatchObject({ ok: true, action: "already-deleted" });
    expect(tenants.getTenant(db, id)).not.toBeNull();
  });

  test("is the platform administrator's", async () => {
    const admin = await session({ admin: true });
    const member = await session();
    const id = uniq("kept");
    await call("POST", TENANTS, admin.authorization, { id, name: "Kept" });

    expect((await call("DELETE", `${TENANTS}/${id}`, member.authorization)).status).toBe(403);
    expect(tenants.getTenant(db, id)!.deleted_at).toBeNull();
  });
});

describe("a session's own tenant", () => {
  test("is the local row's, and `default` for a login with no local account", async () => {
    const member = await session();
    expect(getLocalUser(member.login)).toBeNull();
    const body = await (await call("GET", `${TENANTS}/directory`, member.authorization)).json();
    expect(body.tenant).toBe("default");
  });
});
