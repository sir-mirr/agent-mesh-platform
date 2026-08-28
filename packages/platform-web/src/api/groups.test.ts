/**
 * Groups, and the egress policy that has three states while the grid has two.
 *
 * `egress_allowed: null` is this layer's only record that the route did not
 * answer with egress at all — a different fact from a group that may reach
 * nothing. The distinction dies one caller later (`TenantEgressAclPage`
 * collapses both with `|| false`, and `AclMatrix` pins that it cannot carry a
 * third state), so if it is not held here it is held nowhere, and an unread
 * policy is drawn as a complete, confident refusal.
 *
 * `member_count` is the same shape of question: `null` is "the row carried no
 * member list", `0` is "it carried an empty one". `TopologyPage` already had a
 * `|| 1` that turned a known zero into a one.
 *
 * The write side is pinned against the route rather than against the type:
 * `POST /api/v1/admin/groups` accepts `group_id` and `description` and refuses
 * a body carrying anything else with a `400` — this repository's own fixture
 * sent `members` and `name` for four months and read the answer as success.
 */
import { describe, it, expect, mock, afterEach } from "bun:test";
import {
  assignGroupMemberApi,
  fetchGroups,
  createGroupApi,
  addEgressRuleApi,
  deleteEgressRuleApi,
} from "./groups.ts";

const realFetch = globalThis.fetch;
/** bun:test has no global stubber, so the original goes back by hand — a
 *  forgotten restore would poison every file that runs after this one. */
const stub = (fn: unknown) => { globalThis.fetch = fn as typeof globalThis.fetch; };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const spyOn = (body: unknown, status = 200) => {
  const spy = mock(async (_input: RequestInfo | URL, _init?: RequestInit) => json(body, status));
  stub(spy);
  return spy;
};

afterEach(() => { globalThis.fetch = realFetch; });

describe("fetchGroups", () => {
  it("names every field it keeps, and keeps nothing else the row carried", async () => {
    // The store's `Group` is tenant/group_id/description/created_at/created_by,
    // and `created_by` is deliberately not selected here — so the fixture
    // carries it and `toEqual` is exact. A `...g` spread, which is the shortest
    // way to write "just pass the row on", fails here instead of leaking a
    // store-only field into every screen.
    //
    // `name` is `group_id`: that row has no display name at all, so the id is
    // the name on this platform.
    spyOn({
      ok: true,
      groups: [{
        group_id: "ops",
        tenant: "acme",
        description: "on call",
        created_at: "2026-08-20T12:00:00Z",
        created_by: "op-1",
        members: ["a-1", "a-2"],
      }],
      egress: [],
    });
    expect((await fetchGroups())[0]).toEqual({
      id: "ops",
      name: "ops",
      tenant: "acme",
      description: "on call",
      member_count: 2,
      members: ["a-1", "a-2"],
      egress_allowed: [],
      created_at: "2026-08-20T12:00:00Z",
    });
  });

  it("keeps a policy nobody read apart from one that allows nothing", async () => {
    // No `egress` key: the route answered about groups and said nothing about
    // who may reach whom. `[]` here would be this layer asserting a total
    // denial the server never stated.
    spyOn({ ok: true, groups: [{ group_id: "ops" }] });
    expect((await fetchGroups())[0]!.egress_allowed).toBe(null);

    // `egress: []` is the server stating it: the rules were read and there are
    // none. Absent and empty must not arrive as the same value.
    spyOn({ ok: true, groups: [{ group_id: "ops" }], egress: [] });
    expect((await fetchGroups())[0]!.egress_allowed).toEqual([]);

    // A third shape, and the one that separates `Array.isArray(data.egress)`
    // from a mere `!= null`: a body whose `egress` is not a list has still
    // stated no rules. Called "read", it draws a confident total denial from a
    // body that named nothing — or throws on the filter, which is the same
    // screen either way.
    spyOn({ ok: true, groups: [{ group_id: "ops" }], egress: { ops: ["billing"] } });
    expect((await fetchGroups())[0]!.egress_allowed).toBe(null);
  });

  it("reads a rule in one direction only", async () => {
    // SPEC section 12: `A -> B` does not imply `B -> A`. Agents allowed to
    // report into an aggregator are not agents it may command, and a filter
    // reading `to_group` instead of `from_group` would hand out the reverse
    // grant while every screen kept drawing the same number of allowed cells.
    spyOn({
      ok: true,
      groups: [{ group_id: "ops" }, { group_id: "billing" }],
      egress: [{ from_group: "ops", to_group: "billing" }],
    });
    const rows = await fetchGroups();
    expect(rows[0]!.egress_allowed).toEqual(["billing"]);
    expect(rows[1]!.egress_allowed).toEqual([]);
  });

  it("does not join equal group ids across different tenants", async () => {
    spyOn({
      ok: true,
      groups: [
        { group_id: "ops", tenant: "acme" },
        { group_id: "ops", tenant: "beta" },
      ],
      egress: [
        { tenant: "acme", from_group: "ops", to_group: "acme-target" },
        { tenant: "beta", from_group: "ops", to_group: "beta-target" },
      ],
    });

    const [acme, beta] = await fetchGroups();
    expect(acme!.egress_allowed).toEqual(["acme-target"]);
    expect(beta!.egress_allowed).toEqual(["beta-target"]);
  });

  it("does not guess a tenant for an old-shaped rule in a multi-tenant response", async () => {
    spyOn({
      ok: true,
      groups: [
        { group_id: "ops", tenant: "acme" },
        { group_id: "ops", tenant: "beta" },
      ],
      egress: [{ from_group: "ops", to_group: "unknown-tenant" }],
    });

    const rows = await fetchGroups();
    expect(rows.map((row) => row.egress_allowed)).toEqual([null, null]);
  });

  it("reads a rule from a group to itself, and seeds no such rule where there is none", async () => {
    // `maySend` has no self-exception, so the diagonal is data in both
    // directions and neither direction may be guessed here. A group that seeds
    // its own id is drawn as able to talk to itself before the operator decided
    // that — the one thing they created it to decide — and a filter that skips
    // `to_group === from_group` as a tautology drops the self-rule the store
    // seeds on `default`, which is the grant an unconfigured mesh sends every
    // message under. Drawn as absent, it invites revoking what nothing else
    // replaces.
    spyOn({
      ok: true,
      groups: [{ group_id: "ops" }, { group_id: "billing" }],
      egress: [{ from_group: "ops", to_group: "ops" }],
    });
    const rows = await fetchGroups();
    expect(rows[0]!.egress_allowed).toEqual(["ops"]);
    expect(rows[1]!.egress_allowed).toEqual([]);
  });

  it("counts the members it was told about and says nothing when it was not told", async () => {
    spyOn({ ok: true, groups: [
      { group_id: "empty", members: [] },
      { group_id: "silent" },
      { group_id: "misshapen", members: "a-1" },
    ] });
    const [empty, silent, misshapen] = await fetchGroups();
    // A group that genuinely holds nobody. `TopologyPage` had a `|| 1` here
    // that turned this known zero into one agent that does not exist.
    expect(empty!.member_count).toBe(0);
    // A row carrying no member list at all. `0` would be a count nobody made.
    expect(silent!.member_count).toBe(null);
    expect(silent!.members).toEqual([]);
    // A row carrying something that is not a list, which is the branch a guard
    // written as `g.members ? g.members.length : null` gets wrong — and it gets
    // it wrong by answering with a number: a single identity read as a
    // membership of three. Every other fixture here is falsy-or-array, so
    // nothing else makes that guard differ from this one.
    expect(misshapen!.member_count).toBe(null);
    expect(misshapen!.members).toEqual([]);
  });

  it("leaves an absent description and an absent creation time absent", async () => {
    // `""` would render as a description that says nothing, and a date column
    // is compared by eye — a fabricated value there is worse than a blank.
    spyOn({ ok: true, groups: [{ group_id: "ops" }] });
    const [row] = await fetchGroups();
    expect(row!.description).toBe(null);
    expect(row!.created_at).toBe(null);
    expect(row!.tenant).toBe(null);
  });

  it("keys the row on group_id, which is the only id this route sends", async () => {
    // The second half of this used to feed `{ id: "grp-b" }` with no
    // `group_id`, to show that `id` alone was still read. The route sends
    // `tenant group_id description created_at created_by members` and no `id`
    // at all, so that row is one the server cannot produce and the branch
    // satisfying it could never run. What is worth holding is that the egress
    // filter matches on the same key the row is drawn under — a mismatch there
    // shows an empty policy, which reads as "reaches nothing".
    spyOn({ ok: true, groups: [{ group_id: "grp-a" }], egress: [] });
    expect((await fetchGroups())[0]!.id).toBe("grp-a");

    spyOn({ ok: true, groups: [{ group_id: "grp-b" }], egress: [{ from_group: "grp-b", to_group: "grp-c" }] });
    expect((await fetchGroups())[0]!.egress_allowed).toEqual(["grp-c"]);
  });

  it("reads no policy out of a body that carries no egress", async () => {
    // The half worth keeping. A response with groups and no `egress` key means
    // the rules were not read, not that they are empty — every group in it is
    // "policy not read" rather than "reaches nothing".
    spyOn({ ok: true, tenant: "default", groups: [{ group_id: "ops", members: ["a-1"] }] });
    const rows = await fetchGroups();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("ops");
    expect(rows[0]!.member_count).toBe(1);
    expect(rows[0]!.egress_allowed).toBe(null);
  });

  it("refuses a body it does not recognise instead of reporting a mesh with no groups", async () => {
    // This asked for a bare array to be mapped. The route has never sent one,
    // so the branch could not run against the server. What replaces it is the
    // distinction the test below already makes for egress: an empty list is a
    // claim about the tenant, and a body this reader cannot read is not.
    spyOn([{ group_id: "ops", members: ["a-1"] }]);
    expect(fetchGroups()).rejects.toThrow(/does not know that shape/);
  });

  it("hands a refusal on rather than drawing a mesh with no groups", async () => {
    // An empty list is a claim about the mesh made out of a fact about the
    // session — and it is a value this mapper produces from a perfectly good
    // body, so a `catch` added here would reach the operator as "your tenant
    // has no groups" with nothing on the screen to say otherwise. Which
    // failure it was, and the capability the server named, is decided in
    // `client.ts` and asserted in `client.test.ts` against this same response;
    // repeating it here would read as this route deciding it.
    spyOn({ error: "not allowed", capability: "group.manage" }, 403);
    expect(await fetchGroups().then((rows) => rows, () => "rejected")).toBe("rejected");
  });
});

describe("createGroupApi", () => {
  it("sends group_id and nothing the route would refuse", async () => {
    // The route rejects any field outside { group_id, description, tenant } with a
    // `400` — `name` and `members` included. An extra key here does not get
    // dropped, it fails the whole creation.
    const spy = spyOn({ ok: true, group_id: "ops", created: true }, 201);
    await createGroupApi("ops");
    const init = spy.mock.calls[0]![1]!;
    expect(init.method).toBe("POST");
    // Anchored, not `toContain`: every write path on this module is a sub-path
    // of this one, so a POST re-pointed at `/api/v1/admin/groups/{id}/egress`
    // — or at anything else under it — contains the substring and answers 2xx.
    expect(String(spy.mock.calls[0]![0])).toMatch(/\/api\/v1\/admin\/groups$/);
    // An omitted description is left out, not sent as null: the route stores
    // `null` for a non-string anyway, and a key that carries nothing invites
    // the next field to be added the same way.
    expect(JSON.parse(String(init.body))).toEqual({ group_id: "ops" });
  });

  it("passes a description when the operator wrote one", async () => {
    const spy = spyOn({ ok: true, group_id: "ops", created: true }, 201);
    await createGroupApi("ops", "on call rotation");
    expect(JSON.parse(String(spy.mock.calls[0]![1]!.body)))
      .toEqual({ group_id: "ops", description: "on call rotation" });
  });

  it("sends a tenant only when the platform administrator selected one", async () => {
    let spy = spyOn({ ok: true, group_id: "ops", tenant: "acme", created: true }, 201);
    await createGroupApi("ops", undefined, "acme");
    expect(JSON.parse(String(spy.mock.calls[0]![1]!.body)))
      .toEqual({ group_id: "ops", tenant: "acme" });

    spy = spyOn({ ok: true, group_id: "ops", tenant: "default", created: true }, 201);
    await createGroupApi("ops");
    expect(JSON.parse(String(spy.mock.calls[0]![1]!.body)))
      .toEqual({ group_id: "ops" });
  });

  it("carries `created` back, because 200 and 201 are different answers", async () => {
    // The route answers `200` with `created: false` when the group was already
    // there. A screen that reads only `ok` reports a creation that did not
    // happen.
    spyOn({ ok: true, group_id: "ops", created: false });
    expect((await createGroupApi("ops")).created).toBe(false);
  });
});

describe("assignGroupMemberApi", () => {
  it("posts one identity and its selected group tenant", async () => {
    const spy = spyOn({
      ok: true,
      identity: "agt-1",
      tenant: "acme",
      from_group: "default",
      to_group: "ops",
    });
    await assignGroupMemberApi("ops", "agt-1", "acme");

    expect(String(spy.mock.calls[0]![0])).toMatch(/\/api\/v1\/admin\/groups\/ops\/members$/);
    expect(spy.mock.calls[0]![1]!.method).toBe("POST");
    expect(JSON.parse(String(spy.mock.calls[0]![1]!.body)))
      .toEqual({ identity: "agt-1", tenant: "acme" });
  });

  it("escapes the group id and omits an unknown tenant", async () => {
    const spy = spyOn({ ok: true });
    await assignGroupMemberApi("lane/a b", "agt-1");

    expect(String(spy.mock.calls[0]![0])).toContain("/groups/lane%2Fa%20b/members");
    expect(JSON.parse(String(spy.mock.calls[0]![1]!.body))).toEqual({ identity: "agt-1" });
  });
});

describe("addEgressRuleApi", () => {
  it("puts the source in the path and the target in the body", async () => {
    // The direction lives in two different places, and swapping them grants the
    // opposite rule while the request still succeeds — nothing on the screen
    // would say the arrow points the other way.
    const spy = spyOn({ ok: true, from_group: "ops", to_group: "billing" }, 201);
    await addEgressRuleApi("ops", "billing");
    expect(String(spy.mock.calls[0]![0])).toContain("/api/v1/admin/groups/ops/egress");
    expect(spy.mock.calls[0]![1]!.method).toBe("POST");
    expect(JSON.parse(String(spy.mock.calls[0]![1]!.body))).toEqual({ to_group: "billing" });
  });

  it("escapes the group id into the path", async () => {
    // An unescaped `/` would address a different route entirely, and the answer
    // to that route can still be a 2xx.
    const spy = spyOn({ ok: true }, 201);
    await addEgressRuleApi("lane/a b", "billing");
    expect(String(spy.mock.calls[0]![0])).toContain("/groups/lane%2Fa%20b/egress");
  });
});

describe("deleteEgressRuleApi", () => {
  it("names both groups in the path and sends no body", async () => {
    const spy = spyOn({ ok: true, action: "deleted" });
    await deleteEgressRuleApi("ops", "billing");
    const init = spy.mock.calls[0]![1]!;
    expect(init.method).toBe("DELETE");
    expect(String(spy.mock.calls[0]![0])).toContain("/groups/ops/egress/billing");
    expect(init.body).toBeUndefined();
  });

  it("escapes both segments", async () => {
    const spy = spyOn({ ok: true, action: "not-found" });
    await deleteEgressRuleApi("lane/a", "lane/b");
    expect(String(spy.mock.calls[0]![0])).toContain("/groups/lane%2Fa/egress/lane%2Fb");
  });
});
