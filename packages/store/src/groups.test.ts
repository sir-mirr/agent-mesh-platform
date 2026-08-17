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
