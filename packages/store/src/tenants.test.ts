/**
 * The tenant list (T-026), and the three things it is easy to get wrong.
 *
 * A tenant id is written into `agents`, `local_users`, `agent_groups` and
 * `message_stats` — four tables that hold it as a plain string with no
 * reference back here. Everything below is about that asymmetry: the id has to
 * keep meaning what it meant, whatever happens to the row that names it.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openAt } from "./open";
import * as tenants from "./tenants";

function db() {
  const d = openAt(join(mkdtempSync(join(tmpdir(), "tenants-")), "t.db"), { create: true });
  tenants.migrate(d);
  return d;
}

describe("the default tenant", () => {
  test("is there before anybody writes one, under the name a person reads", () => {
    const d = db();
    const row = tenants.getTenant(d, tenants.DEFAULT_TENANT);
    expect(row).not.toBeNull();
    expect(row!.name).toBe(tenants.DEFAULT_TENANT_NAME);
    expect(row!.deleted_at).toBeNull();
  });

  test("keeps a rename across the next migration", () => {
    const d = db();
    expect(tenants.renameTenant(d, tenants.DEFAULT_TENANT, "Acme")).toBe(true);
    // Every start runs `migrate`. A seed that overwrote would undo the rename
    // on the next restart \u2014 the operator renames it, it works, and it is back
    // the following morning with nothing in the log about it.
    tenants.migrate(d);
    expect(tenants.getTenant(d, tenants.DEFAULT_TENANT)!.name).toBe("Acme");
  });

  test("cannot be deleted", () => {
    const d = db();
    expect(tenants.deleteTenant(d, tenants.DEFAULT_TENANT)).toBe(false);
    expect(tenants.getTenant(d, tenants.DEFAULT_TENANT)!.deleted_at).toBeNull();
  });
});

describe("creating one", () => {
  test("refuses an id that is taken, rather than renaming what is there", () => {
    const d = db();
    expect(tenants.createTenant(d, { id: "acme", name: "Acme" })).toBe(true);
    expect(tenants.createTenant(d, { id: "acme", name: "Somebody Else" })).toBe(false);
    expect(tenants.getTenant(d, "acme")!.name).toBe("Acme");
  });

  test("a deleted tenant's id is not free", () => {
    const d = db();
    tenants.createTenant(d, { id: "acme", name: "Acme" });
    tenants.deleteTenant(d, "acme");
    // Traffic in `message_stats` still says `acme`. Handing the id to somebody
    // else would attribute last week's messages to them.
    expect(tenants.createTenant(d, { id: "acme", name: "Acme Two" })).toBe(false);
  });
});

describe("deleting one", () => {
  test("stops offering it and keeps the row the other tables point at", () => {
    const d = db();
    tenants.createTenant(d, { id: "acme", name: "Acme" });
    expect(tenants.deleteTenant(d, "acme")).toBe(true);

    expect(tenants.listTenants(d).map((t) => t.id)).not.toContain("acme");
    expect(tenants.listTenants(d, true).map((t) => t.id)).toContain("acme");
    // The name still resolves, so a stats row reading `acme` is displayed
    // rather than shown as an id nobody can explain.
    expect(tenants.getTenant(d, "acme")!.name).toBe("Acme");
  });

  test("twice is not an error the second time, and is not a second delete", () => {
    const d = db();
    tenants.createTenant(d, { id: "acme", name: "Acme" });
    expect(tenants.deleteTenant(d, "acme")).toBe(true);
    const at = tenants.getTenant(d, "acme")!.deleted_at;
    expect(tenants.deleteTenant(d, "acme")).toBe(false);
    expect(tenants.getTenant(d, "acme")!.deleted_at).toBe(at);
  });

  test("is what `tenantIsOpen` answers, which `getTenant` does not", () => {
    const d = db();
    tenants.createTenant(d, { id: "acme", name: "Acme" });
    tenants.deleteTenant(d, "acme");
    expect(tenants.getTenant(d, "acme")).not.toBeNull();
    expect(tenants.tenantIsOpen(d, "acme")).toBe(false);
    expect(tenants.tenantIsOpen(d, "never-existed")).toBe(false);
    expect(tenants.tenantIsOpen(d, tenants.DEFAULT_TENANT)).toBe(true);
  });

  test("can be undone", () => {
    const d = db();
    tenants.createTenant(d, { id: "acme", name: "Acme" });
    tenants.deleteTenant(d, "acme");
    expect(tenants.restoreTenant(d, "acme")).toBe(true);
    expect(tenants.tenantIsOpen(d, "acme")).toBe(true);
    expect(tenants.restoreTenant(d, "acme")).toBe(false);
  });
});

describe("listing", () => {
  test("puts the default first and the rest by name", () => {
    const d = db();
    tenants.createTenant(d, { id: "zeta", name: "Aardvark" });
    tenants.createTenant(d, { id: "alpha", name: "Zebra" });
    // By name, not by id: the list is read by a person, and `zeta` sorting
    // before `alpha` is the id order rather than the one on the screen.
    expect(tenants.listTenants(d).map((t) => t.id)).toEqual([tenants.DEFAULT_TENANT, "zeta", "alpha"]);
  });

  test("renaming moves the name and never the id", () => {
    const d = db();
    tenants.createTenant(d, { id: "acme", name: "Acme" });
    expect(tenants.renameTenant(d, "acme", "Acme Holdings")).toBe(true);
    const row = tenants.getTenant(d, "acme")!;
    expect({ id: row.id, name: row.name }).toEqual({ id: "acme", name: "Acme Holdings" });
    expect(tenants.renameTenant(d, "never-existed", "x")).toBe(false);
  });
});

describe("tenantOf", () => {
  test("answers the default for an identity nothing has said anything about", () => {
    const d = db();
    d.exec(`CREATE TABLE agents (identity TEXT PRIMARY KEY, tenant TEXT)`);
    d.prepare(`INSERT INTO agents (identity, tenant) VALUES ('a', 'acme')`).run();
    expect(tenants.tenantOf(d, "a")).toBe("acme");
    expect(tenants.tenantOf(d, "gone")).toBe(tenants.DEFAULT_TENANT);
  });
});
