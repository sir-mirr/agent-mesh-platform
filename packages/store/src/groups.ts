/**
 * Groups, and who may send to whom (SPEC § 12).
 *
 * **Deny by default.** A mesh that ships permissive is a mesh where every
 * deployment stays open until somebody configures it, and nobody configures
 * what already works. So a send is refused unless a rule allows it — which
 * means groups have to be useful on the first day rather than after setup, and
 * that is what the `default` group is for.
 *
 * Every identity is in exactly one group. Membership is not a set: "which
 * policy applies to this agent" must have one answer, and two memberships with
 * conflicting egress rules would need a precedence order that nobody would get
 * right under pressure.
 *
 * An identity with no explicit group is in `default`, and `default` may talk
 * to itself. A fresh deployment therefore works exactly as it did before this
 * existed, and the first restriction someone writes is the first one that
 * bites — rather than every deployment breaking on upgrade.
 *
 * ## Egress is directional
 *
 * `A -> B` does not imply `B -> A`. A group of agents allowed to report into
 * an aggregator is not a group the aggregator may command, and collapsing the
 * two would make the narrower grant impossible to express.
 */

import type { Database } from "bun:sqlite";

export const DEFAULT_TENANT = "default";

/** Where an identity lives until someone moves it. Also the only group that starts able to send. */
export const DEFAULT_GROUP = "default";

export interface Group {
  tenant: string;
  group_id: string;
  description: string | null;
  created_at: string;
  created_by: string;
}

export function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_groups (
      tenant      TEXT NOT NULL,
      group_id    TEXT NOT NULL,
      description TEXT,
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_by  TEXT NOT NULL,
      PRIMARY KEY (tenant, group_id)
    );
  `);
  // One group per identity, enforced by the key rather than by application
  // code. "Which policy applies here" must have one answer, and a second
  // membership would need a precedence rule nobody gets right under pressure.
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_group_members (
      tenant   TEXT NOT NULL,
      identity TEXT NOT NULL,
      group_id TEXT NOT NULL,
      moved_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      moved_by TEXT NOT NULL,
      PRIMARY KEY (tenant, identity)
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS group_egress (
      tenant     TEXT NOT NULL,
      from_group TEXT NOT NULL,
      to_group   TEXT NOT NULL,
      granted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      granted_by TEXT NOT NULL,
      PRIMARY KEY (tenant, from_group, to_group)
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_group_members_group
      ON agent_group_members(tenant, group_id);
  `);

  // The `default` group and its self-rule, seeded so a deployment that has
  // never heard of groups behaves as it did before they existed. Without the
  // self-rule, deny-by-default would silence every existing mesh on upgrade.
  db.prepare(
    `INSERT INTO agent_groups (tenant, group_id, description, created_by)
     VALUES (?, ?, 'Everything that has not been placed anywhere else', 'seed')
     ON CONFLICT DO NOTHING`,
  ).run(DEFAULT_TENANT, DEFAULT_GROUP);
  db.prepare(
    `INSERT INTO group_egress (tenant, from_group, to_group, granted_by)
     VALUES (?, ?, ?, 'seed') ON CONFLICT DO NOTHING`,
  ).run(DEFAULT_TENANT, DEFAULT_GROUP, DEFAULT_GROUP);
}

export function createGroup(
  db: Database,
  g: { tenant?: string; groupId: string; description?: string | null; createdBy: string },
): boolean {
  return (
    db
      .prepare(
        `INSERT INTO agent_groups (tenant, group_id, description, created_by)
         VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      )
      .run(g.tenant ?? DEFAULT_TENANT, g.groupId, g.description ?? null, g.createdBy).changes > 0
  );
}

export function listGroups(db: Database, tenant = DEFAULT_TENANT): Group[] {
  return db
    .prepare(
      `SELECT tenant, group_id, description, created_at, created_by
         FROM agent_groups WHERE tenant = ? ORDER BY group_id`,
    )
    .all(tenant) as Group[];
}

/** The group an identity is in — `default` when nobody has said otherwise. */
export function groupOf(db: Database, identity: string, tenant = DEFAULT_TENANT): string {
  const row = db
    .prepare(`SELECT group_id FROM agent_group_members WHERE tenant = ? AND identity = ?`)
    .get(tenant, identity) as { group_id: string } | undefined;
  return row?.group_id ?? DEFAULT_GROUP;
}

export function membersOf(db: Database, groupId: string, tenant = DEFAULT_TENANT): string[] {
  return (
    db
      .prepare(
        `SELECT identity FROM agent_group_members WHERE tenant = ? AND group_id = ? ORDER BY identity`,
      )
      .all(tenant, groupId) as Array<{ identity: string }>
  ).map((r) => r.identity);
}

/** Move an identity. Replaces rather than adds — one group per identity. */
export function moveTo(
  db: Database,
  m: { tenant?: string; identity: string; groupId: string; movedBy: string },
): void {
  db.prepare(
    `INSERT INTO agent_group_members (tenant, identity, group_id, moved_by)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(tenant, identity) DO UPDATE SET
       group_id = excluded.group_id,
       moved_at = datetime('now'),
       moved_by = excluded.moved_by`,
  ).run(m.tenant ?? DEFAULT_TENANT, m.identity, m.groupId, m.movedBy);
}

export function allowEgress(
  db: Database,
  e: { tenant?: string; fromGroup: string; toGroup: string; grantedBy: string },
): void {
  db.prepare(
    `INSERT INTO group_egress (tenant, from_group, to_group, granted_by)
     VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
  ).run(e.tenant ?? DEFAULT_TENANT, e.fromGroup, e.toGroup, e.grantedBy);
}

export function revokeEgress(
  db: Database,
  e: { tenant?: string; fromGroup: string; toGroup: string },
): boolean {
  return (
    db
      .prepare(`DELETE FROM group_egress WHERE tenant = ? AND from_group = ? AND to_group = ?`)
      .run(e.tenant ?? DEFAULT_TENANT, e.fromGroup, e.toGroup).changes > 0
  );
}

export function listEgress(
  db: Database,
  tenant = DEFAULT_TENANT,
): Array<{ from_group: string; to_group: string; granted_by: string; granted_at: string }> {
  return db
    .prepare(
      `SELECT from_group, to_group, granted_by, granted_at
         FROM group_egress WHERE tenant = ? ORDER BY from_group, to_group`,
    )
    .all(tenant) as Array<{ from_group: string; to_group: string; granted_by: string; granted_at: string }>;
}

export interface SendVerdict {
  ok: boolean;
  fromGroup: string;
  toGroup: string;
}

/**
 * May `from` send to `to`?
 *
 * **Directional.** `A -> B` says nothing about `B -> A`: agents allowed to
 * report into an aggregator are not agents it may command, and treating the
 * rule as symmetric would make the narrower grant inexpressible.
 *
 * Same-group sends still require a rule. `default` has one, seeded; a group
 * someone creates does not until they say so, which is the point of asking.
 */
export function maySend(
  db: Database,
  from: string,
  to: string,
  tenant = DEFAULT_TENANT,
): SendVerdict {
  const fromGroup = groupOf(db, from, tenant);
  const toGroup = groupOf(db, to, tenant);
  const allowed = !!db
    .prepare(
      `SELECT 1 FROM group_egress WHERE tenant = ? AND from_group = ? AND to_group = ? LIMIT 1`,
    )
    .get(tenant, fromGroup, toGroup);
  return { ok: allowed, fromGroup, toGroup };
}
