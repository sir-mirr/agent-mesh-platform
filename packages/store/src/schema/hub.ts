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
      sent_by    TEXT,
      content    TEXT NOT NULL,
      reply_to   TEXT,
      status     TEXT DEFAULT 'pending',
      ts         DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Idempotent shim for databases written before the two identities were told
  // apart. Old rows cannot be backfilled — the transmitting identity was never
  // recorded, and copying `from_agent` into `sent_by` would assert that nothing
  // was proxied, which is exactly the claim these rows cannot support. NULL
  // says "not known", and that is the honest value.
  const columns = db.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === "sent_by")) {
    db.exec(`ALTER TABLE messages ADD COLUMN sent_by TEXT`);
  }
}

/**
 * `from_agent` is who the message is **from**; `sent_by` is the socket that
 * actually transmitted it.
 *
 * They differ only when a proxy sends on someone's behalf — the http server
 * forwarding for a logged-in web user. Before `sent_by` existed only the claim
 * survived, so a proxied message was indistinguishable from one the claimed
 * sender wrote, and no record anywhere said which socket produced it.
 *
 * `sent_by` is stamped by the hub from the authenticated connection and is
 * never read from request params, for the same reason SPEC § 8.9.3 keeps
 * `identity` and `recorded_by` out of the audit request body: a field a caller
 * can set is a field a caller can lie in.
 */
export interface MessageRow {
  id: string;
  from_agent: string;
  to_agent: string;
  /** Null only for rows written before the column existed. */
  sent_by: string | null;
  content: string;
  reply_to: string | null;
  status: string | null;
  ts: string;
}
