/**
 * `agents.db` — identity, keys, key history (SPEC § 3.1).
 *
 * **At 0.1 these tables live in `hub.db`** alongside `messages`; SPEC § 3.1
 * moves them into their own file at 0.2, so that identity — small and
 * permanent — stops sharing a file and a retention policy with messages and
 * audit, which are neither. The schema is a separate module already so that
 * change is a second handle at the call site rather than an untangling here.
 *
 * Only the hub calls `migrate` (SPEC § 3.1).
 */

import type { Database } from "bun:sqlite";

export function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      identity    TEXT PRIMARY KEY,
      description TEXT,
      last_seen   DATETIME,
      type        TEXT,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Idempotent shims for databases written by earlier builds. PRAGMA lists
  // every column, so a missing one is added rather than assumed present.
  //   type       — added in the era that made POST /api/v1/agents the SSOT.
  //   created_at — added for the ISO-8601 provenance SPEC § 10.1 requires, and
  //                backfilled from last_seen because there was no better
  //                source. Operators wanting cleaner values apply
  //                ops/migrations/0001_*.sql instead.
  const columns = db.prepare(`PRAGMA table_info(agents)`).all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === "type")) {
    db.exec(`ALTER TABLE agents ADD COLUMN type TEXT`);
  }
  if (!columns.some((c) => c.name === "created_at")) {
    // SQLite rejects non-constant defaults in ALTER TABLE ADD COLUMN, so the
    // column arrives nullable and is filled in a second statement.
    db.exec(`ALTER TABLE agents ADD COLUMN created_at DATETIME`);
    db.exec(
      `UPDATE agents SET created_at = COALESCE(last_seen, datetime('now')) WHERE created_at IS NULL`,
    );
  }
}

export interface AgentRow {
  identity: string;
  description: string | null;
  last_seen: string | null;
  type: string | null;
  created_at: string | null;
}
