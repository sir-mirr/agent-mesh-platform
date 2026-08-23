/**
 * Groups, and what a group is allowed to send (SPEC § 12).
 *
 * **Deny by default**, which is what makes these routes the only way a
 * deployment says anything at all. A mesh that shipped permissive would stay
 * open until somebody configured it, and nobody configures what already works.
 *
 * Two of the decisions here are corrections rather than designs, and both are
 * pinned below because the wrong version passed for months:
 *
 * - A body asking for more than this route implements is **refused, not
 *   dropped**. This repository's own fixture sent `members` and `name` to the
 *   create route and was answered `201` every time — so the groups were empty
 *   and the response said the whole of the request had happened.
 * - Revoking egress answers `200` either way and says which happened in
 *   `action`. It used to answer `404` with `ok: true` — a status and a body
 *   saying opposite things about the same call — and a contract scenario had
 *   ratified it.
 *
 * This file owns the `grp-` prefix.
 */
import { describe, expect, test } from "bun:test";

process.env.JWT_SECRET ||= "groups-probe";

const { app } = await import("./main.ts");
const { upsertUser, approveUser, createPendingApproval, getDb } = await import("./db");
const { signJwt } = await import("./auth");
const { STORE_FILES, agentsSchema, grants, groups, openAt, ownership, stateDir, tenants } =
  await import("@agent-mesh/store");
const { CAPABILITY } = await import("@agent-mesh/contracts");
const { join } = await import("node:path");

const db = openAt(join(stateDir(), STORE_FILES.agents), { create: true });
agentsSchema.migrate(db);
grants.migrate(db);
groups.migrate(db);
ownership.migrate(db);

let n = 0;
const uniq = (p: string) => `grp-${p}-${++n}-${process.pid}`;

async function holder(...caps: string[]) {
  const login = uniq("op");
  const user = upsertUser(950000 + n, login);
  createPendingApproval(login, user.github_id);
  expect(approveUser(login)).toBe(true);
  for (const capability of caps) {
    grants.grant(db, { subject: login, capability, grantedBy: "groups-test" });
  }
  const jwt = await signJwt({ github_id: user.github_id, github_login: login, role: "member" });
  return { login, authorization: `Bearer ${jwt}` };
}

const req = (method: string, path: string, cookie: string, body?: unknown) =>
  app.fetch(new Request(`http://grp-probe${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: cookie },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  }));

const get = (path: string, cookie: string) => req("GET", path, cookie);
const post = (path: string, cookie: string, body?: unknown) => req("POST", path, cookie, body);
const del = (path: string, cookie: string) => req("DELETE", path, cookie);

/** A group that exists, made through the route that makes them. */
async function group(cookie: string, description?: string): Promise<string> {
  const groupId = uniq("team");
  const res = await post("/api/v1/admin/groups", cookie,
    description === undefined ? { group_id: groupId } : { group_id: groupId, description });
  expect(res.status).toBe(201);
  return groupId;
}

const ROUTES: Array<[string, string]> = [
  ["GET", "/api/v1/admin/groups"],
  ["POST", "/api/v1/admin/groups"],
  ["POST", "/api/v1/admin/groups/some-group/members"],
  ["POST", "/api/v1/admin/groups/some-group/egress"],
  ["DELETE", "/api/v1/admin/groups/some-group/egress/other-group"],
];

describe("who may configure a mesh", () => {
  test("refuses every route to a caller without group.manage", async () => {
    const nobody = await holder();
    for (const [method, path] of ROUTES) {
      expect((await req(method, path, "", {})).status).toBe(401);
      const res = await req(method, path, nobody.authorization, {});
      expect(res.status).toBe(403);
      expect((await res.json()).capability).toBe(CAPABILITY.GROUP_MANAGE);
    }
  });
});

describe("making a group", () => {
  test("refuses a body it cannot parse", async () => {
    const op = await holder(CAPABILITY.GROUP_MANAGE);
    expect((await post("/api/v1/admin/groups", op.authorization, "{not json")).status).toBe(400);
  });

  test("refuses a group_id that is missing or off-pattern", async () => {
    const op = await holder(CAPABILITY.GROUP_MANAGE);
    for (const group_id of [undefined, 7, "", "-leading", "has space", "under_score"]) {
      const res = await post("/api/v1/admin/groups", op.authorization, { group_id });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("group_id");
    }
  });

  /**
   * **The four-month bug.** `members` and `name` were accepted and dropped, and
   * the `201` said otherwise. A field this route does not implement is refused,
   * and the refusal names it — an operator told "unsupported field(s)" with no
   * list is being asked to guess which of theirs it was.
   */
  test("refuses a field it does not implement, and names it", async () => {
    const op = await holder(CAPABILITY.GROUP_MANAGE);
    const res = await post("/api/v1/admin/groups", op.authorization,
      { group_id: uniq("team"), name: "Team", colour: "blue" });
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error).toContain("name");
    expect(error).toContain("colour");
    expect(error).toContain("group_id, description and tenant");
  });

  /** `members` gets the sentence that says where membership actually goes. */
  test("points a body carrying members at the route that moves one", async () => {
    const op = await holder(CAPABILITY.GROUP_MANAGE);
    const res = await post("/api/v1/admin/groups", op.authorization,
      { group_id: uniq("team"), members: ["a", "b"] });
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error).toContain("/members");
    expect(error).toContain("one identity per call");
  });

  test("creates one, and says it was already there the second time", async () => {
    const op = await holder(CAPABILITY.GROUP_MANAGE);
    const groupId = uniq("team");
    const first = await post("/api/v1/admin/groups", op.authorization,
      { group_id: groupId, description: "the reporting side" });
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ ok: true, group_id: groupId, tenant: "default", created: true });

    const again = await post("/api/v1/admin/groups", op.authorization, { group_id: groupId });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, group_id: groupId, tenant: "default", created: false });

    // And the second call did not overwrite the description with nothing.
    const listed = (await (await get("/api/v1/admin/groups", op.authorization)).json())
      .groups.find((g: any) => g.group_id === groupId);
    expect(listed.description).toBe("the reporting side");
    expect(listed.created_by).toBe(op.login);
  });

  test("keeps a description only when it is a string", async () => {
    const op = await holder(CAPABILITY.GROUP_MANAGE);
    const groupId = uniq("team");
    await post("/api/v1/admin/groups", op.authorization, { group_id: groupId, description: 7 });
    const listed = (await (await get("/api/v1/admin/groups", op.authorization)).json())
      .groups.find((g: any) => g.group_id === groupId);
    expect(listed.description).toBeNull();
  });

  /**
   * **A new group can send nowhere, including to itself.** Seeding a self-rule
   * would guess the one thing the operator created the group to state.
   */
  test("grants the new group nothing, not even to itself", async () => {
    const op = await holder(CAPABILITY.GROUP_MANAGE);
    const groupId = await group(op.authorization);
    const one = uniq("agent");
    const other = uniq("agent");
    for (const identity of [one, other]) {
      await post(`/api/v1/admin/groups/${groupId}/members`, op.authorization, { identity });
    }
    const { egress } = await (await get("/api/v1/admin/groups", op.authorization)).json();
    expect(egress.filter((e: any) => e.from_group === groupId)).toEqual([]);
    // Two agents in the same new group still cannot reach each other.
    expect(groups.maySend(db, one, other).ok).toBe(false);
    // `default` is the one group that starts able to send, and it is seeded.
    expect(groups.maySend(db, uniq("nobody"), uniq("nobody"))).toEqual({
      ok: true, fromGroup: "default", toGroup: "default",
    });
  });
});

describe("listing them", () => {
  test("carries each group's members with it", async () => {
    const op = await holder(CAPABILITY.GROUP_MANAGE);
    const groupId = await group(op.authorization);
    const member = uniq("agent");
    await post(`/api/v1/admin/groups/${groupId}/members`, op.authorization, { identity: member });

    const body = await (await get("/api/v1/admin/groups", op.authorization)).json();
    expect(body.ok).toBe(true);
    const listed = body.groups.find((g: any) => g.group_id === groupId);
    expect(listed.members).toEqual([member]);
    // A group nobody is in carries an empty list, not a missing field.
    const empty = await group(op.authorization);
    const after = await (await get("/api/v1/admin/groups", op.authorization)).json();
    expect(after.groups.find((g: any) => g.group_id === empty).members).toEqual([]);
  });

  /**
   * **The agent nobody moved is still in a group**, and this is the read that
   * says which. § 12 puts every unplaced identity in `default`, so a listing
   * built from `agent_group_members` alone answers `[]` for the group that
   * holds all of them — which is what `agent-mesh-local-pm` measured on the
   * standing stack: `soak-claude` registered and listed by `GET
   * /api/v1/agents`, `default` reporting no members, and the console drawing
   * the topology from the second one.
   */
  test("names an agent nobody has placed among `default`'s members", async () => {
    const op = await holder(CAPABILITY.GROUP_MANAGE);
    const identity = uniq("unplaced");
    db.prepare(`INSERT INTO agents (identity, type, tenant) VALUES (?, 'ai-claude', 'default')`)
      .run(identity);

    const listed = (await (await get("/api/v1/admin/groups", op.authorization)).json())
      .groups.find((g: any) => g.group_id === "default");
    expect(listed.members).toContain(identity);

    // And it leaves when somebody places it, rather than being in both.
    const elsewhere = await group(op.authorization);
    await post(`/api/v1/admin/groups/${elsewhere}/members`, op.authorization, { identity });
    const moved = (await (await get("/api/v1/admin/groups", op.authorization)).json()).groups;
    expect(moved.find((g: any) => g.group_id === "default").members).not.toContain(identity);
    expect(moved.find((g: any) => g.group_id === elsewhere).members).toEqual([identity]);
  });
});

describe("moving somebody into one", () => {
  test("refuses a body it cannot parse, or one naming no identity", async () => {
    const op = await holder(CAPABILITY.GROUP_MANAGE);
    const groupId = await group(op.authorization);
    expect((await post(`/api/v1/admin/groups/${groupId}/members`, op.authorization, "{not json")).status).toBe(400);
    for (const identity of [undefined, 7, "", "has space"]) {
      const res = await post(`/api/v1/admin/groups/${groupId}/members`, op.authorization, { identity });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("identity");
    }
  });

  /**
   * A group that does not exist is `404`. Moving an identity there would put it
   * somewhere no rule can ever name, which is silence rather than an error.
   */
  test("refuses a group that does not exist", async () => {
    const op = await holder(CAPABILITY.GROUP_MANAGE);
    const missing = uniq("nowhere");
    const res = await post(`/api/v1/admin/groups/${missing}/members`, op.authorization,
      { identity: uniq("agent") });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain(missing);
  });

  /**
   * **A move, not an addition.** The answer names both ends, because an
   * operator needs to know what the identity stopped being able to do as well
   * as what it can now.
   */
  test("reports where the identity came from", async () => {
    const op = await holder(CAPABILITY.GROUP_MANAGE);
    const first = await group(op.authorization);
    const second = await group(op.authorization);
    const identity = uniq("agent");

    const into = await post(`/api/v1/admin/groups/${first}/members`, op.authorization, { identity });
    expect(await into.json()).toEqual({
      ok: true, identity, tenant: "default", from_group: "default", to_group: first,
    });

    const moved = await post(`/api/v1/admin/groups/${second}/members`, op.authorization, { identity });
    expect(await moved.json()).toEqual({
      ok: true, identity, tenant: "default", from_group: first, to_group: second,
    });
    expect(groups.membersOf(db, first)).not.toContain(identity);
    expect(groups.groupOf(db, identity)).toBe(second);
  });
});

describe("what a group may send", () => {
  test("refuses a body it cannot parse, or one naming no group", async () => {
    const op = await holder(CAPABILITY.GROUP_MANAGE);
    const groupId = await group(op.authorization);
    expect((await post(`/api/v1/admin/groups/${groupId}/egress`, op.authorization, "{not json")).status).toBe(400);
    for (const to_group of [undefined, 7, "", "has space"]) {
      const res = await post(`/api/v1/admin/groups/${groupId}/egress`, op.authorization, { to_group });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("to_group");
    }
  });

  /**
   * **Directional, and the route shape says so.** Agents allowed to report into
   * an aggregator are not agents it may command; treating the rule as
   * symmetric would make the narrower grant inexpressible.
   */
  test("grants one direction and not the other", async () => {
    const op = await holder(CAPABILITY.GROUP_MANAGE);
    const reporters = await group(op.authorization);
    const aggregator = await group(op.authorization);
    const reporter = uniq("reporter");
    const collector = uniq("collector");
    await post(`/api/v1/admin/groups/${reporters}/members`, op.authorization, { identity: reporter });
    await post(`/api/v1/admin/groups/${aggregator}/members`, op.authorization, { identity: collector });

    const res = await post(`/api/v1/admin/groups/${reporters}/egress`, op.authorization,
      { to_group: aggregator });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, tenant: "default", from_group: reporters, to_group: aggregator });

    expect(groups.maySend(db, reporter, collector).ok).toBe(true);
    expect(groups.maySend(db, collector, reporter).ok).toBe(false);
  });

  test("grants a rule to a group that does not exist yet, and it holds when it does", async () => {
    // The route does not check the far end. A deployment configured before its
    // groups exist is a deployment configured in whatever order suits it.
    const op = await holder(CAPABILITY.GROUP_MANAGE);
    const from = await group(op.authorization);
    const later = uniq("later");
    expect((await post(`/api/v1/admin/groups/${from}/egress`, op.authorization, { to_group: later })).status)
      .toBe(201);
    const { egress } = await (await get("/api/v1/admin/groups", op.authorization)).json();
    expect(egress).toContainEqual(expect.objectContaining({
      from_group: from, to_group: later, granted_by: op.login,
    }));
  });
});

describe("taking a rule back", () => {
  /**
   * **`200` either way, and `action` says which.** This answered `404` with
   * `ok: true` — a status and a body saying opposite things about the same
   * call — and a contract scenario had ratified it (§ 9.2a).
   */
  test("says which of delete and not-found happened, and never disagrees with itself", async () => {
    const op = await holder(CAPABILITY.GROUP_MANAGE);
    const from = await group(op.authorization);
    const to = await group(op.authorization);
    await post(`/api/v1/admin/groups/${from}/egress`, op.authorization, { to_group: to });

    const deleted = await del(`/api/v1/admin/groups/${from}/egress/${to}`, op.authorization);
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true, action: "deleted" });

    const again = await del(`/api/v1/admin/groups/${from}/egress/${to}`, op.authorization);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, action: "not-found" });
  });

  /** Revoking one direction leaves the other alone. */
  test("takes back only the direction it names", async () => {
    const op = await holder(CAPABILITY.GROUP_MANAGE);
    const a = await group(op.authorization);
    const b = await group(op.authorization);
    await post(`/api/v1/admin/groups/${a}/egress`, op.authorization, { to_group: b });
    await post(`/api/v1/admin/groups/${b}/egress`, op.authorization, { to_group: a });

    await del(`/api/v1/admin/groups/${a}/egress/${b}`, op.authorization);
    const { egress } = await (await get("/api/v1/admin/groups", op.authorization)).json();
    expect(egress).not.toContainEqual(expect.objectContaining({ from_group: a, to_group: b }));
    expect(egress).toContainEqual(expect.objectContaining({ from_group: b, to_group: a }));
  });
});

describe("who is answerable for an identity", () => {
  test("refuses a caller without agent.provision, and an off-pattern name", async () => {
    const nobody = await holder();
    expect((await get(`/api/v1/admin/agents/${uniq("a")}/owners`, nobody.authorization)).status).toBe(403);
    const op = await holder(CAPABILITY.AGENT_PROVISION);
    const bad = await get("/api/v1/admin/agents/has%20space/owners", op.authorization);
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toContain("invalid identity format");
  });

  /** Owners are plural, and the answer says how each claim was made. */
  test("lists every owner, with how the claim was made", async () => {
    const op = await holder(CAPABILITY.AGENT_PROVISION);
    const identity = uniq("agent");
    ownership.assign(db, { identity, owner: uniq("first"), grantedBy: "groups-test" });
    ownership.assign(db, { identity, owner: uniq("second"), grantedBy: "groups-test" });

    const body = await (await get(`/api/v1/admin/agents/${identity}/owners`, op.authorization)).json();
    expect(body.ok).toBe(true);
    expect(body.identity).toBe(identity);
    expect(body.owners).toHaveLength(2);
    expect(body.owners.every((o: any) => o.granted_by === "groups-test")).toBe(true);
  });

  test("answers an empty list for an identity nobody claimed", async () => {
    const op = await holder(CAPABILITY.AGENT_PROVISION);
    const body = await (await get(`/api/v1/admin/agents/${uniq("unclaimed")}/owners`, op.authorization)).json();
    expect(body.owners).toEqual([]);
  });
});

/**
 * Which tenant a group is in (T-026).
 *
 * `(tenant, group_id)` has been the primary key since groups existed, and every
 * store function has taken a tenant argument with a default — while the routes
 * passed none. So every group this service made went into `default`, the
 * listing read `default`, and the column was carried by four tables without one
 * route ever writing anything but the same value into it.
 *
 * `group.manage` is held **inside** a tenant, so which tenant a write lands in
 * is not the body's to decide alone.
 */
describe("a group belongs to a tenant", () => {
  /** An operator whose `role = 'admin'`: the platform-administrator stand-in. */
  async function platformAdmin(...caps: string[]) {
    const op = await holder(...caps);
    getDb().prepare(`UPDATE users SET role = 'admin' WHERE github_login = ?`).run(op.login);
    return op;
  }

  test("is the operator's own unless they administer the installation", async () => {
    const op = await holder(CAPABILITY.GROUP_MANAGE);
    tenants.createTenant(db, { id: "grp-elsewhere", name: "Elsewhere" });

    const groupId = uniq("team");
    const res = await post("/api/v1/admin/groups", op.authorization,
      { group_id: groupId, tenant: "grp-elsewhere" });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("TENANT_NOT_YOURS");
    // Nothing written, in either tenant: a refusal that half-happened is worse
    // than one that did not.
    expect(groups.listGroups(db, "grp-elsewhere").map((g) => g.group_id)).not.toContain(groupId);
    expect(groups.listGroups(db).map((g) => g.group_id)).not.toContain(groupId);
  });

  test("refuses a tenant nobody created, even from the platform administrator", async () => {
    const op = await platformAdmin(CAPABILITY.GROUP_MANAGE);
    const res = await post("/api/v1/admin/groups", op.authorization,
      { group_id: uniq("team"), tenant: "grp-not-a-tenant" });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("NO_SUCH_TENANT");
  });

  test("lands in the tenant the platform administrator names, and is listed there", async () => {
    const op = await platformAdmin(CAPABILITY.GROUP_MANAGE);
    tenants.createTenant(db, { id: "grp-branch", name: "Branch" });
    const groupId = uniq("team");

    expect((await post("/api/v1/admin/groups", op.authorization,
      { group_id: groupId, tenant: "grp-branch" })).status).toBe(201);
    expect(groups.listGroups(db, "grp-branch").map((g) => g.group_id)).toContain(groupId);
    expect(groups.listGroups(db).map((g) => g.group_id)).not.toContain(groupId);
  });

  /**
   * The listing read `default` and only `default`, so a group in another tenant
   * was written, was real, and was invisible to the one screen that would have
   * shown it.
   */
  test("is invisible to an operator in another tenant, and visible to the administrator", async () => {
    const admin = await platformAdmin(CAPABILITY.GROUP_MANAGE);
    tenants.createTenant(db, { id: "grp-far", name: "Far" });
    const groupId = uniq("team");
    await post("/api/v1/admin/groups", admin.authorization, { group_id: groupId, tenant: "grp-far" });

    const ordinary = await holder(CAPABILITY.GROUP_MANAGE);
    const theirs = await (await get("/api/v1/admin/groups", ordinary.authorization)).json();
    expect(theirs.tenant).toBe("default");
    expect(theirs.groups.map((g: any) => g.group_id)).not.toContain(groupId);

    const all = await (await get("/api/v1/admin/groups", admin.authorization)).json();
    const row = all.groups.find((g: any) => g.group_id === groupId);
    expect(row).toBeDefined();
    expect(row.tenant).toBe("grp-far");
  });

  test("a move names the group in its own tenant, and 404s in another", async () => {
    const admin = await platformAdmin(CAPABILITY.GROUP_MANAGE);
    tenants.createTenant(db, { id: "grp-moving", name: "Moving" });
    const groupId = uniq("team");
    await post("/api/v1/admin/groups", admin.authorization, { group_id: groupId, tenant: "grp-moving" });
    const identity = uniq("agent");

    // The same name, in the tenant the caller is in: a different group, and
    // there is nothing there.
    const wrong = await post(`/api/v1/admin/groups/${groupId}/members`, admin.authorization, { identity });
    expect(wrong.status).toBe(404);
    expect((await wrong.json()).error).toContain("default");

    const right = await post(`/api/v1/admin/groups/${groupId}/members`, admin.authorization,
      { identity, tenant: "grp-moving" });
    expect(right.status).toBe(200);
    expect(groups.membersOf(db, groupId, "grp-moving")).toContain(identity);
    expect(groups.groupOf(db, identity)).toBe("default");
  });

  test("egress is granted and withdrawn inside one tenant", async () => {
    const admin = await platformAdmin(CAPABILITY.GROUP_MANAGE);
    tenants.createTenant(db, { id: "grp-egress", name: "Egress" });
    const from = uniq("reporters");
    const to = uniq("aggregator");
    for (const group_id of [from, to]) {
      await post("/api/v1/admin/groups", admin.authorization, { group_id, tenant: "grp-egress" });
    }

    expect((await post(`/api/v1/admin/groups/${from}/egress`, admin.authorization,
      { to_group: to, tenant: "grp-egress" })).status).toBe(201);
    expect(groups.listEgress(db, "grp-egress").some((e) => e.from_group === from)).toBe(true);
    // Not in `default`, where the same two names would be two other groups.
    expect(groups.listEgress(db).some((e) => e.from_group === from)).toBe(false);

    // The delete carries its tenant in the query: the target is in the path,
    // and a body on a delete is a second place to look for what it acts on.
    const removed = await del(`/api/v1/admin/groups/${from}/egress/${to}?tenant=grp-egress`, admin.authorization);
    expect(await removed.json()).toMatchObject({ action: "deleted" });
    expect(groups.listEgress(db, "grp-egress").some((e) => e.from_group === from)).toBe(false);
  });
});
