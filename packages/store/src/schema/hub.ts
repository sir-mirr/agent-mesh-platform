/**
 * `hub.db` — message routing and history (SPEC § 3.1).
 *
 * The operational store: every envelope the hub routes lands here, and it is
 * what `mesh.fetch_messages` reads and what pending delivery drains from.
 *
 * The http server reads this file directly to serve the admin audit views. It
 * holds a read-only handle, and the shape it reads is declared here rather than
 * hardcoded on that side, which is how the two used to be able to drift.
 *
 * Only the hub calls `migrate` (SPEC § 3.1).
 */

import type { Database } from "bun:sqlite";

export function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id         TEXT PRIMARY KEY,
      from_agent TEXT NOT NULL,
      to_agent   TEXT NOT NULL,
      content    TEXT NOT NULL,
      reply_to   TEXT,
      status     TEXT DEFAULT 'pending',
      ts         DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

export interface MessageRow {
  id: string;
  from_agent: string;
  to_agent: string;
  content: string;
  reply_to: string | null;
  status: string | null;
  ts: string;
}
