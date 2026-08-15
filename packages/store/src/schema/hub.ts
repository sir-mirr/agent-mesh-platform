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
      ts         DATETIME DEFAULT CURRENT_TIMESTAMP,
      leased_until DATETIME
    );
  `);

  // Delivery to a socketless caller is at-least-once (SPEC § 8.10.1): a batch
  // is handed out under a lease and stays invisible until it is acknowledged or
  // the lease lapses. A caller whose turn ends mid-batch therefore blocks only
  // itself, and only until the lease expires.
  const messageColumns = db.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name: string }>;
  if (!messageColumns.some((c) => c.name === "leased_until")) {
    db.exec(`ALTER TABLE messages ADD COLUMN leased_until DATETIME`);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_pending
      ON messages(to_agent, status, leased_until);
  `);

  // Send idempotency (SPEC § 8.2). The hub can commit a message and then fail
  // to deliver the response; only the client can tell the resulting retry from
  // a new send, so it supplies the key and this remembers the answer.
  //
  // `request_digest` is what distinguishes a retry from a reused key: the same
  // key with the same message returns the original result, the same key with a
  // different message is a permanent error.
  db.exec(`
    CREATE TABLE IF NOT EXISTS send_idempotency (
      sent_by           TEXT NOT NULL,
      client_message_id TEXT NOT NULL,
      request_digest    TEXT NOT NULL,
      message_id        TEXT NOT NULL,
      status            TEXT NOT NULL,
      created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (sent_by, client_message_id)
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_send_idempotency_age ON send_idempotency(created_at);
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
  /** Set while a socketless caller holds this message unacknowledged. */
  leased_until: string | null;
}
