/**
 * Identity teardown (SPEC § 9.3).
 *
 * A **soft** delete: `deleted_at` is set, every key of the identity is revoked,
 * and `messages` is left alone. Hard deletion is incompatible with two other
 * rules — discarding a key makes every past signature permanently unverifiable,
 * which is the property signing exists for, and freeing the identity string
 * lets a later registration inherit the previous holder's message and audit
 * history.
 *
 * It lives here rather than in a service because **it is destructive and it is
 * reachable from two places**: the operation belongs to `agents.db`, and both
 * the hub and the http server hold that file read-write (§ 3.1). Two copies of
 * a transaction that revokes keys is two chances for one of them to stop
 * revoking, and the copy that stopped would look like it worked.
 *
 * Because nothing outside `agents.db` is touched this is a single-file
 * transaction. SQLite does not guarantee atomic commit across attached
 * databases in WAL mode, so spanning two would not be atomic even written as
 * though it were.
 */

import { randomUUID } from "node:crypto";

import type { Database } from "bun:sqlite";

export type TeardownAction = "soft-deleted" | "already-deleted" | "not-found";

export interface TeardownResult {
  identity: string;
  action: TeardownAction;
  /** Absent for `not-found`. */
  deletedAt?: string | null;
  /** Fingerprints revoked by this call. Empty unless `action` is `soft-deleted`. */
  revoked: string[];
}

/**
 * Tear down one identity.
 *
 * `actor` is recorded on every `agent_key_events` row and is **the whole point
 * of routing this through an authenticated caller**: § 10.2 requires each key
 * transition to carry who caused it, and a teardown that could only write
 * `"hub"` recorded that a revocation happened without recording who is
 * answerable for it.
 *
 * Idempotent. All three actions are success: `not-found` for an identity with
 * no row, `already-deleted` for one that already carries `deleted_at`.
 */
export function teardownIdentity(
  db: Database,
  identity: string,
  actor: string,
): TeardownResult {
  const existing = db
    .prepare(`SELECT identity, deleted_at FROM agents WHERE identity = ?`)
    .get(identity) as { identity: string; deleted_at: string | null } | undefined;

  if (!existing) return { identity, action: "not-found", revoked: [] };
  if (existing.deleted_at) {
    return { identity, action: "already-deleted", deletedAt: existing.deleted_at, revoked: [] };
  }

  // Read the fingerprints *before* revoking them, so the history explains the
  // transition rather than merely showing the result.
  const keys = db
    .prepare(`SELECT fingerprint FROM agent_keys WHERE identity = ? AND status IN ('pending','approved')`)
    .all(identity) as Array<{ fingerprint: string }>;

  const run = db.transaction(() => {
    db.prepare(`UPDATE agents SET deleted_at = datetime('now') WHERE identity = ? AND deleted_at IS NULL`)
      .run(identity);
    db.prepare(`UPDATE agent_keys SET status = 'revoked', decided_at = datetime('now')
                WHERE identity = ? AND status IN ('pending','approved')`)
      .run(identity);
    for (const { fingerprint } of keys) {
      db.prepare(
        `INSERT INTO agent_key_events (id, identity, fingerprint, action, reason, actor)
         VALUES (?, ?, ?, 'revoked', 'teardown', ?)`,
      ).run(randomUUID(), identity, fingerprint, actor);
    }
  });
  run();

  const row = db
    .prepare(`SELECT deleted_at FROM agents WHERE identity = ?`)
    .get(identity) as { deleted_at: string | null } | undefined;

  return {
    identity,
    action: "soft-deleted",
    deletedAt: row?.deleted_at ?? null,
    revoked: keys.map((k) => k.fingerprint),
  };
}
