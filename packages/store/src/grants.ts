/**
 * Who may do what, resolved per request (SPEC § 11).
 *
 * **The token carries identity; this carries the answer.** The JWT holds
 * `role` today, which means the answer is fixed for the token's lifetime — so
 * revoking someone's access does not revoke it until they happen to expire.
 * With one `admin` that was tolerable. With a set that grows it is not, and
 * the one moment revocation matters is an incident, which is exactly when
 * nobody wants to wait out a TTL.
 *
 * So this is a database read on a store the process already holds open, on
 * every authenticated request that needs a decision.
 *
 * `tenant` is here before tenancy is built. A grant is scoped to a tenant even
 * when there is only one, because retrofitting the column means revisiting
 * every query written in the meantime, and the one that was written without it
 * is a cross-tenant leak waiting for a missing `WHERE`.
 */

import type { Database } from "bun:sqlite";

import { ALL_CAPABILITIES, SCOPE_TENANT, type Capability } from "@agent-mesh/contracts";

/** Until tenancy lands, everything is in one. Named so the queries already carry it. */
export const DEFAULT_TENANT = "default";

export interface Grant {
  tenant: string;
  subject: string;
  capability: Capability;
  scope: string;
  granted_by: string;
  granted_at: string;
}

export function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS role_grants (
      tenant     TEXT NOT NULL,
      subject    TEXT NOT NULL,
      capability TEXT NOT NULL,
      scope      TEXT NOT NULL,
      granted_by TEXT NOT NULL,
      granted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (tenant, subject, capability, scope)
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_role_grants_lookup
      ON role_grants(tenant, subject, capability);
  `);
}

/**
 * Record a grant.
 *
 * The capability is validated against the contract's list rather than accepted
 * as any string. A typo would otherwise create a grant that is never checked
 * for — a permission that looks granted on every screen and gates nothing.
 */
export function grant(
  db: Database,
  g: { tenant?: string; subject: string; capability: string; scope?: string; grantedBy: string },
): void {
  if (!(ALL_CAPABILITIES as readonly string[]).includes(g.capability)) {
    throw new Error(`unknown capability: ${g.capability}`);
  }
  db.prepare(
    `INSERT INTO role_grants (tenant, subject, capability, scope, granted_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(tenant, subject, capability, scope) DO NOTHING`,
  ).run(g.tenant ?? DEFAULT_TENANT, g.subject, g.capability, g.scope ?? SCOPE_TENANT, g.grantedBy);
}

/** Remove one. Returns whether a row went, so a caller can tell a no-op from a revoke. */
export function revoke(
  db: Database,
  g: { tenant?: string; subject: string; capability: string; scope?: string },
): boolean {
  return (
    db
      .prepare(
        `DELETE FROM role_grants
          WHERE tenant = ? AND subject = ? AND capability = ? AND scope = ?`,
      )
      .run(g.tenant ?? DEFAULT_TENANT, g.subject, g.capability, g.scope ?? SCOPE_TENANT).changes > 0
  );
}

/**
 * Whether `subject` may do `capability` to `scope`.
 *
 * A tenant-wide grant (`*`) satisfies any narrower scope; a grant on one
 * identity satisfies only that identity. **Widening never happens the other
 * way** — holding `key.approve` on `agent-a` must not answer yes for
 * `agent-b`, which is the whole point of scoping it.
 */
export function has(
  db: Database,
  subject: string,
  capability: Capability,
  scope: string = SCOPE_TENANT,
  tenant: string = DEFAULT_TENANT,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM role_grants
        WHERE tenant = ? AND subject = ? AND capability = ?
          AND (scope = ? OR scope = ?)
        LIMIT 1`,
    )
    .get(tenant, subject, capability, SCOPE_TENANT, scope) as { ok: number } | undefined;
  return !!row;
}

/** Everything one subject holds — for an operator screen, and for tests. */
export function listFor(db: Database, subject: string, tenant: string = DEFAULT_TENANT): Grant[] {
  return db
    .prepare(
      `SELECT tenant, subject, capability, scope, granted_by, granted_at
         FROM role_grants WHERE tenant = ? AND subject = ?
        ORDER BY capability, scope`,
    )
    .all(tenant, subject) as Grant[];
}

/** Everyone holding one capability — "who can tear down agents here". */
export function subjectsWith(
  db: Database,
  capability: Capability,
  tenant: string = DEFAULT_TENANT,
): Array<{ subject: string; scope: string }> {
  return db
    .prepare(
      `SELECT subject, scope FROM role_grants
        WHERE tenant = ? AND capability = ? ORDER BY subject, scope`,
    )
    .all(tenant, capability) as Array<{ subject: string; scope: string }>;
}
