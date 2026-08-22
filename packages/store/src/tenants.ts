/**
 * Which tenant an identity belongs to (SPEC § 11.4).
 *
 * A column on `agents`, not a derivation from group membership. The derivation
 * was the alternative and needs a rule for an identity in no group and another
 * for one in several — and neither rule can be right, because somebody who put
 * an identity in two groups was not thereby saying which tenant its traffic
 * counts towards. **A derivation rule reads an intention nobody expressed.**
 */

import type { Database } from "bun:sqlite";

export const DEFAULT_TENANT = "default";

/**
 * An identity's tenant, or `default`.
 *
 * Unknown identities answer `default` rather than throwing. A send has already
 * been authorised by the time this is asked, so an identity missing here is a
 * race with teardown rather than a caller doing something wrong — and § 15.6's
 * rule applies: statistics must not be the thing that stops routing.
 */
export function tenantOf(db: Database, identity: string): string {
  const row = db
    .prepare(`SELECT tenant FROM agents WHERE identity = ?`)
    .get(identity) as { tenant: string | null } | undefined;
  return row?.tenant ?? DEFAULT_TENANT;
}

/**
 * The tenants themselves (T-026).
 *
 * `agents.tenant`, `local_users.tenant`, `agent_groups.tenant` and
 * `message_stats.tenant` all carried a tenant *id* before anything held the
 * list of them. That worked while there was one — `default`, spelled the same
 * in five places — and stops working the moment somebody has to be shown a
 * choice: a picker built from `SELECT DISTINCT tenant` offers the tenants that
 * already have rows, which is every tenant except the one just created.
 *
 * So the list is a table. What it adds over the strings is a **name** that is
 * not an id (`default` is displayed as \uD50C\uB7AB\uD3FC), and a way to say a
 * tenant is gone without deleting the rows that point at it.
 *
 * **Soft delete, and the rows stay.** Traffic in `message_stats` and accounts
 * in `local_users` reference a tenant by id; removing the row would leave both
 * pointing at nothing, and § 11.4's answer for a tenant that received traffic
 * last week is not "unknown". `deleted_at` says *no longer offered*, which is
 * what a picker needs and the only thing deletion here can honestly mean.
 */

export interface Tenant {
  id: string;
  name: string;
  created_at: string;
  deleted_at: string | null;
}

/** The default tenant's display name. The id stays `default`; this is what a person reads. */
export const DEFAULT_TENANT_NAME = "\uD50C\uB7AB\uD3FC";

export function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      deleted_at DATETIME
    );
  `);
  // Seeded rather than written by an operator, for the same reason the
  // `default` group is: every existing row in five tables already names this
  // tenant, so a deployment that upgrades into this table must find its own
  // tenant already in it. `DO NOTHING` keeps a rename made afterwards.
  db.prepare(
    `INSERT INTO tenants (id, name) VALUES (?, ?) ON CONFLICT DO NOTHING`,
  ).run(DEFAULT_TENANT, DEFAULT_TENANT_NAME);
}

/**
 * The tenants on offer, `default` first and the rest by name.
 *
 * Deleted ones are left out unless asked for. A caller listing them for a
 * picker wants what can be chosen; a caller resolving an id that traffic
 * already names wants the row whatever its state, and asks with `true`.
 */
export function listTenants(db: Database, includeDeleted = false): Tenant[] {
  return db
    .prepare(
      `SELECT id, name, created_at, deleted_at
         FROM tenants
        ${includeDeleted ? "" : "WHERE deleted_at IS NULL"}
        ORDER BY (id = '${DEFAULT_TENANT}') DESC, name`,
    )
    .all() as Tenant[];
}

/** One tenant by id, deleted or not. `null` when nothing has ever used that id. */
export function getTenant(db: Database, id: string): Tenant | null {
  return (
    (db
      .prepare(`SELECT id, name, created_at, deleted_at FROM tenants WHERE id = ?`)
      .get(id) as Tenant | undefined) ?? null
  );
}

/**
 * Whether an id may be used for new work: it exists and is not deleted.
 *
 * Separate from `getTenant` because the two questions have different answers
 * for a deleted tenant, and a route that asked the wrong one would admit an
 * account into a tenant nobody can pick any more.
 */
export function tenantIsOpen(db: Database, id: string): boolean {
  const row = getTenant(db, id);
  return row !== null && row.deleted_at === null;
}

/** Create one. `false` when the id is taken — including by a deleted tenant, whose id is not free. */
export function createTenant(db: Database, t: { id: string; name: string }): boolean {
  return (
    db
      .prepare(`INSERT INTO tenants (id, name) VALUES (?, ?) ON CONFLICT DO NOTHING`)
      .run(t.id, t.name).changes > 0
  );
}

/**
 * Rename one. `false` when there is no such tenant.
 *
 * The id is never rewritten: it is what five other tables hold, and a rename
 * that moved it would leave every one of those rows pointing at nothing. The
 * name is the part a person reads, and this is the whole of what renaming is.
 */
export function renameTenant(db: Database, id: string, name: string): boolean {
  return db.prepare(`UPDATE tenants SET name = ? WHERE id = ?`).run(name, id).changes > 0;
}

/**
 * Stop offering one. `false` when it was already deleted or never existed.
 *
 * The default tenant refuses: every row whose tenant nobody stated is in it,
 * including the seeded administrator's, so deleting it would remove the only
 * tenant the installation is guaranteed to have while leaving everything still
 * pointing there. Refused in the store rather than in the route — the rule is
 * about what the data means, and a second copy in a route is a copy that can
 * be talked out of.
 */
export function deleteTenant(db: Database, id: string): boolean {
  if (id === DEFAULT_TENANT) return false;
  return (
    db
      .prepare(`UPDATE tenants SET deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL`)
      .run(id).changes > 0
  );
}

/** Undo a soft delete. `false` when it was not deleted. */
export function restoreTenant(db: Database, id: string): boolean {
  return (
    db
      .prepare(`UPDATE tenants SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL`)
      .run(id).changes > 0
  );
}
