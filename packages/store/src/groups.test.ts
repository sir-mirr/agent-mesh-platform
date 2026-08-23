/**
 * SPEC § 12. Deny by default, and the two things that makes fragile.
 *
 * Shipping permissive means every deployment stays open until somebody
 * configures it, and nobody configures what already works. Shipping restrictive
 * means every existing mesh goes silent on upgrade unless the default is right.
 * Most of these tests are about the second.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openAt } from "./open";
import * as agentsSchema from "./schema/agents";
import * as groups from "./groups";

function db() {
  const d = openAt(join(mkdtempSync(join(tmpdir(), "grp-")), "g.db"), { create: true });
  groups.migrate(d);
  return d;
}

describe("the default, which is what upgrade survival depends on", () => {
  test("two identities nobody placed can talk", () => {
    // Deny-by-default with no seeded self-rule would silence every mesh that
    // has never heard of groups. This is the line between a feature and an
    // outage.
    const d = db();
    expect(groups.maySend(d, "a", "b").ok).toBe(true);
    d.close();
  });

  test("an unplaced identity reports as `default` rather than as nothing", () => {
    const d = db();
    expect(groups.groupOf(d, "never-seen")).toBe("default");
    d.close();
  });

  test("migrate twice does not duplicate the seed", () => {
    const d = db();
    groups.migrate(d);
    expect(groups.listGroups(d)).toHaveLength(1);
    expect(groups.listEgress(d)).toHaveLength(1);
    d.close();
  });
});

describe("deny by default", () => {
  test("a new group cannot even talk to itself until someone says so", () => {
    // The point of asking. A group created and populated is a group whose
    // policy nobody has stated yet, and guessing it would be guessing the one
    // thing the operator created it to express.
    const d = db();
    groups.createGroup(d, { groupId: "lab", createdBy: "alice" });
    groups.moveTo(d, { identity: "x", groupId: "lab", movedBy: "alice" });
    groups.moveTo(d, { identity: "y", groupId: "lab", movedBy: "alice" });
    expect(groups.maySend(d, "x", "y").ok).toBe(false);

    groups.allowEgress(d, { fromGroup: "lab", toGroup: "lab", grantedBy: "alice" });
    expect(groups.maySend(d, "x", "y").ok).toBe(true);
    d.close();
  });

  test("moving one identity out cuts it off from the group it left", () => {
    const d = db();
    groups.createGroup(d, { groupId: "lab", createdBy: "alice" });
    groups.moveTo(d, { identity: "x", groupId: "lab", movedBy: "alice" });
    expect(groups.maySend(d, "x", "still-default").ok).toBe(false);
    expect(groups.maySend(d, "still-default", "x").ok).toBe(false);
    d.close();
  });
});

describe("egress is directional", () => {
  test("A to B does not imply B to A", () => {
    // Agents allowed to report into an aggregator are not agents it may
    // command. A symmetric rule makes the narrower grant inexpressible.
    const d = db();
    groups.createGroup(d, { groupId: "sensors", createdBy: "a" });
    groups.createGroup(d, { groupId: "hub", createdBy: "a" });
    groups.moveTo(d, { identity: "s1", groupId: "sensors", movedBy: "a" });
    groups.moveTo(d, { identity: "h1", groupId: "hub", movedBy: "a" });
    groups.allowEgress(d, { fromGroup: "sensors", toGroup: "hub", grantedBy: "a" });

    expect(groups.maySend(d, "s1", "h1").ok).toBe(true);
    expect(groups.maySend(d, "h1", "s1").ok).toBe(false);
    d.close();
  });

  test("revoking one direction leaves the other", () => {
    const d = db();
    groups.createGroup(d, { groupId: "p", createdBy: "a" });
    groups.createGroup(d, { groupId: "q", createdBy: "a" });
    groups.allowEgress(d, { fromGroup: "p", toGroup: "q", grantedBy: "a" });
    groups.allowEgress(d, { fromGroup: "q", toGroup: "p", grantedBy: "a" });
    expect(groups.revokeEgress(d, { fromGroup: "p", toGroup: "q" })).toBe(true);
    expect(groups.revokeEgress(d, { fromGroup: "p", toGroup: "q" })).toBe(false);

    groups.moveTo(d, { identity: "pp", groupId: "p", movedBy: "a" });
    groups.moveTo(d, { identity: "qq", groupId: "q", movedBy: "a" });
    expect(groups.maySend(d, "pp", "qq").ok).toBe(false);
    expect(groups.maySend(d, "qq", "pp").ok).toBe(true);
    d.close();
  });
});

/**
 * **Membership is not what the table holds.** § 12 puts every identity nobody
 * has moved in `default`, which is why registering an agent writes no
 * membership row — and why a reader that asks `agent_group_members` alone
 * answers `[]` for the group that holds all of them. That is what
 * `agent-mesh-local-pm` measured on the standing stack: `soak-claude`
 * registered, `default` reporting no members.
 *
 * These need the `agents` table, because *unplaced* is a fact about the
 * identities that exist rather than about the memberships that do.
 */
describe("who is in `default`, which is nobody the table names", () => {
  function meshDb() {
    const d = openAt(join(mkdtempSync(join(tmpdir(), "grp-mesh-")), "g.db"), { create: true });
    agentsSchema.migrate(d);
    groups.migrate(d);
    return d;
  }

  const register = (d: ReturnType<typeof openAt>, identity: string, tenant = "default") =>
    d.prepare(`INSERT INTO agents (identity, type, tenant) VALUES (?, 'ai-claude', ?)`)
      .run(identity, tenant);

  test("an agent nobody placed is a member of `default`", () => {
    const d = meshDb();
    register(d, "soak-claude");
    expect(groups.groupOf(d, "soak-claude")).toBe("default");
    expect(groups.membersOf(d, "default")).toEqual(["soak-claude"]);
    // And the rows say nothing, which is the whole point: the two readings
    // disagreed, and the one that ignored § 12 was the one being served.
    expect(groups.placedIn(d, "default")).toEqual([]);
    d.close();
  });

  test("moving an agent out takes it out of `default` too", () => {
    const d = meshDb();
    register(d, "soak-claude");
    groups.createGroup(d, { groupId: "lab", createdBy: "a" });
    groups.moveTo(d, { identity: "soak-claude", groupId: "lab", movedBy: "a" });
    expect(groups.membersOf(d, "default")).toEqual([]);
    expect(groups.membersOf(d, "lab")).toEqual(["soak-claude"]);
    d.close();
  });

  test("an agent placed back in `default` is named once, not twice", () => {
    // Two sources for one identity, and the row is what keeps them disjoint:
    // having one is exactly what *unplaced* means the absence of.
    const d = meshDb();
    register(d, "soak-claude");
    groups.moveTo(d, { identity: "soak-claude", groupId: "default", movedBy: "a" });
    expect(groups.membersOf(d, "default")).toEqual(["soak-claude"]);
    d.close();
  });

  test("a torn-down identity is in no group at all", () => {
    // § 9.3 soft delete. A member list that still names it describes a mesh
    // that no longer exists.
    const d = meshDb();
    register(d, "gone");
    d.prepare(`UPDATE agents SET deleted_at = datetime('now') WHERE identity = ?`).run("gone");
    expect(groups.membersOf(d, "default")).toEqual([]);
    d.close();
  });

  test("`default` in one tenant does not hold another tenant's unplaced", () => {
    const d = meshDb();
    register(d, "acme-one", "acme");
    register(d, "nova-one", "nova");
    expect(groups.membersOf(d, "default", "acme")).toEqual(["acme-one"]);
    expect(groups.membersOf(d, "default", "nova")).toEqual(["nova-one"]);
    d.close();
  });

  test("an identity placed by hand is a member even if it registered nowhere", () => {
    // Somebody wrote that row on purpose. `agents` is where the mesh's own
    // identities live, and a membership the operator stated does not depend on
    // this server having heard of the identity.
    const d = meshDb();
    groups.moveTo(d, { identity: "not-registered-here", groupId: "default", movedBy: "a" });
    expect(groups.membersOf(d, "default")).toEqual(["not-registered-here"]);
    d.close();
  });

  test("a group that is not `default` is only its rows", () => {
    // The unplaced belong to `default` and to nothing else — a named group
    // that swept them up would make every group the same group.
    const d = meshDb();
    register(d, "soak-claude");
    groups.createGroup(d, { groupId: "lab", createdBy: "a" });
    expect(groups.membersOf(d, "lab")).toEqual([]);
    d.close();
  });
});

describe("membership is singular", () => {
  test("moving replaces rather than adds", () => {
    // "Which policy applies to this agent" must have one answer. Two
    // memberships with conflicting egress would need a precedence order nobody
    // gets right under pressure.
    const d = db();
    groups.createGroup(d, { groupId: "one", createdBy: "a" });
    groups.createGroup(d, { groupId: "two", createdBy: "a" });
    groups.moveTo(d, { identity: "m", groupId: "one", movedBy: "a" });
    groups.moveTo(d, { identity: "m", groupId: "two", movedBy: "a" });
    expect(groups.groupOf(d, "m")).toBe("two");
    expect(groups.membersOf(d, "one")).toEqual([]);
    expect(groups.membersOf(d, "two")).toEqual(["m"]);
    d.close();
  });

  test("groups do not leak across tenants", () => {
    const d = db();
    groups.createGroup(d, { tenant: "acme", groupId: "lab", createdBy: "a" });
    groups.moveTo(d, { tenant: "acme", identity: "x", groupId: "lab", movedBy: "a" });
    expect(groups.groupOf(d, "x", "acme")).toBe("lab");
    expect(groups.groupOf(d, "x", "nova")).toBe("default");
    d.close();
  });
});
