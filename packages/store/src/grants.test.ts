/**
 * SPEC § 11. The tests worth having are the scope ones.
 *
 * A grant that fails to apply is noticed in a minute — someone cannot do their
 * job. A grant that applies **too widely** is silent: every screen works, every
 * action succeeds, and the first sign is an agent operator having approved a
 * key in a team they are not on.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CAPABILITY, SCOPE_TENANT } from "@agent-mesh/contracts";

import { openAt } from "./open";
import * as grants from "./grants";

function db() {
  const d = openAt(join(mkdtempSync(join(tmpdir(), "grants-")), "t.db"), { create: true });
  grants.migrate(d);
  return d;
}

describe("scope", () => {
  test("a tenant-wide grant satisfies a narrower ask", () => {
    const d = db();
    grants.grant(d, { subject: "alice", capability: CAPABILITY.KEY_APPROVE, grantedBy: "root" });
    expect(grants.has(d, "alice", CAPABILITY.KEY_APPROVE, "agent-a")).toBe(true);
    expect(grants.has(d, "alice", CAPABILITY.KEY_APPROVE, SCOPE_TENANT)).toBe(true);
    d.close();
  });

  test("a narrow grant does NOT widen — the silent failure", () => {
    const d = db();
    grants.grant(d, {
      subject: "bob", capability: CAPABILITY.KEY_APPROVE, scope: "agent-a", grantedBy: "root",
    });
    expect(grants.has(d, "bob", CAPABILITY.KEY_APPROVE, "agent-a")).toBe(true);
    expect(grants.has(d, "bob", CAPABILITY.KEY_APPROVE, "agent-b")).toBe(false);
    // And it must not answer yes for the tenant either — holding one agent is
    // not holding the tenant.
    expect(grants.has(d, "bob", CAPABILITY.KEY_APPROVE, SCOPE_TENANT)).toBe(false);
    d.close();
  });

  test("capabilities do not leak into each other", () => {
    const d = db();
    grants.grant(d, { subject: "carol", capability: CAPABILITY.AUDIT_READ_METADATA, grantedBy: "root" });
    expect(grants.has(d, "carol", CAPABILITY.AUDIT_READ_METADATA)).toBe(true);
    // The privacy boundary of § 11 is exactly this pair being separate.
    expect(grants.has(d, "carol", CAPABILITY.AUDIT_READ_CONTENT)).toBe(false);
    d.close();
  });

  test("tenants do not leak into each other", () => {
    const d = db();
    grants.grant(d, { tenant: "acme", subject: "dave", capability: CAPABILITY.AGENT_TEARDOWN, grantedBy: "root" });
    expect(grants.has(d, "dave", CAPABILITY.AGENT_TEARDOWN, SCOPE_TENANT, "acme")).toBe(true);
    expect(grants.has(d, "dave", CAPABILITY.AGENT_TEARDOWN, SCOPE_TENANT, "nova")).toBe(false);
    d.close();
  });

  test("an unknown subject holds nothing", () => {
    const d = db();
    expect(grants.has(d, "nobody", CAPABILITY.KEY_APPROVE)).toBe(false);
    d.close();
  });
});

describe("writing grants", () => {
  test("a typo'd capability is refused rather than stored", () => {
    // A grant nothing ever checks for looks granted on every screen and gates
    // nothing — the worst of both.
    const d = db();
    expect(() => grants.grant(d, { subject: "eve", capability: "key.aprove", grantedBy: "root" }))
      .toThrow(/unknown capability/);
    expect(grants.listFor(d, "eve")).toHaveLength(0);
    d.close();
  });

  test("granting twice is idempotent, and keeps the first grantor", () => {
    const d = db();
    grants.grant(d, { subject: "frank", capability: CAPABILITY.GROUP_MANAGE, grantedBy: "root" });
    grants.grant(d, { subject: "frank", capability: CAPABILITY.GROUP_MANAGE, grantedBy: "someone-else" });
    const rows = grants.listFor(d, "frank");
    expect(rows).toHaveLength(1);
    // Who first granted it is the audit-relevant fact; a re-grant must not
    // rewrite it into whoever ran the script last.
    expect(rows[0]!.granted_by).toBe("root");
    d.close();
  });

  test("revoke reports whether anything went", () => {
    const d = db();
    grants.grant(d, { subject: "grace", capability: CAPABILITY.ROLE_GRANT, grantedBy: "root" });
    expect(grants.revoke(d, { subject: "grace", capability: CAPABILITY.ROLE_GRANT })).toBe(true);
    expect(grants.revoke(d, { subject: "grace", capability: CAPABILITY.ROLE_GRANT })).toBe(false);
    expect(grants.has(d, "grace", CAPABILITY.ROLE_GRANT)).toBe(false);
    d.close();
  });

  test("revoking a wide grant does not remove a narrow one", () => {
    const d = db();
    grants.grant(d, { subject: "heidi", capability: CAPABILITY.KEY_APPROVE, grantedBy: "root" });
    grants.grant(d, { subject: "heidi", capability: CAPABILITY.KEY_APPROVE, scope: "agent-a", grantedBy: "root" });
    grants.revoke(d, { subject: "heidi", capability: CAPABILITY.KEY_APPROVE });
    expect(grants.has(d, "heidi", CAPABILITY.KEY_APPROVE, "agent-a")).toBe(true);
    expect(grants.has(d, "heidi", CAPABILITY.KEY_APPROVE, "agent-b")).toBe(false);
    d.close();
  });

  test("subjectsWith answers who can do a thing", () => {
    const d = db();
    grants.grant(d, { subject: "ivan", capability: CAPABILITY.AGENT_TEARDOWN, grantedBy: "root" });
    grants.grant(d, { subject: "judy", capability: CAPABILITY.AGENT_TEARDOWN, scope: "agent-z", grantedBy: "root" });
    grants.grant(d, { subject: "ken", capability: CAPABILITY.KEY_APPROVE, grantedBy: "root" });
    expect(grants.subjectsWith(d, CAPABILITY.AGENT_TEARDOWN)).toEqual([
      { subject: "ivan", scope: "*" },
      { subject: "judy", scope: "agent-z" },
    ]);
    d.close();
  });
});
