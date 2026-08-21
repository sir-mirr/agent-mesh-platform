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
      leased_until DATETIME,
      via        TEXT
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
  /**
   * Which transport the sender used (SPEC § 8.2a): `mesh` or `mailbox`.
   *
   * **A property of the conversation, not of the moment.** A reply goes back the
   * way the thing it answers arrived, so a correspondent who reads mail once an
   * hour does not receive half a thread on a socket they were briefly holding —
   * see `docs/decisions/mailbox-and-hub.md`.
   *
   * Recorded at accept time because that is when it is knowable without asking
   * anything: the route the sender called says it. Deriving it later from
   * `status` would be wrong in exactly the interesting case, since a mailbox
   * send to somebody who happens to be online is `delivered` too.
   *
   * Null on rows written before this existed. Read as `mesh`, which is what
   * those deployments had.
   */
  if (!messageColumns.some((c) => c.name === "via")) {
    db.exec(`ALTER TABLE messages ADD COLUMN via TEXT`);
  }

  /**
   * What each tenant received (SPEC § 11.4).
   *
   * **Separate from `messages` on purpose.** A `tenant` column there would tie
   * tenancy to the operational record, which rotates; this outlives nothing and
   * is answerable on its own terms.
   *
   * **Attributed to the recipient**, which is a total rule rather than a
   * preference: every message has exactly one recipient, so every message has
   * exactly one tenant — cross-tenant traffic included. A sender rule would
   * leave traffic that *arrived* in a tenant absent from that tenant's view,
   * which is the reading an operator is actually misled by.
   *
   * **No content, no size.** § 11.0 draws the platform operator's line at
   * metadata, and a statistics table is exactly where content arrives under the
   * name "just a length".
   *
   * **No status.** Delivery outcome changes after this row is written, and a
   * statistics table that must be updated is one that can disagree with what it
   * counts. This records that a message was *accepted for* a recipient, which
   * does not change afterwards.
   *
   * `message_id` is the key, so the retry § 8.2 collapses counts once — the
   * idempotent path returns the original id and never reaches this insert.
   */
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_stats (
      message_id TEXT PRIMARY KEY,
      tenant     TEXT NOT NULL,
      to_agent   TEXT NOT NULL,
      from_agent TEXT NOT NULL,
      via        TEXT NOT NULL,
      ts         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_message_stats_tenant_ts
      ON message_stats(tenant, ts);
  `);

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

/**
 * The five statements `@agent-mesh/mailbox`'s `receive()` needs, prepared
 * against a given handle.
 *
 * **`create`, because two of the five write.** `naming.test.ts` reads the SQL
 * inside a function body and asks that the name admit a write is involved —
 * deliberately looking inside template literals, since that is where writes
 * live. It flagged the first name here, `mailboxStatements`, and the rule's own
 * note says to rename rather than to widen its verb list or add an exemption:
 * an exemption needs a sentence and a widened list silently accepts every
 * future name that starts the same way.
 *
 * **A factory rather than five module-scope constants, because `receive()` is
 * the only part of store-and-forward that takes its database as an argument** —
 * and it could not be exercised without one, since these were bound to this
 * module's handle and that handle is opened at import against whatever state
 * directory happened to be set. Copying the SQL into a test would be a second
 * declaration of the queue's semantics: the lease window, what counts as
 * leasable, and *only what the caller holds* would then live in two places and
 * drift apart quietly.
 *
 * **It lives here rather than in the hub** because this file owns the table it
 * reads (§ 3.1), and because a test of `receive()` importing it from the hub
 * would be the mailbox learning the hub exists — the one thing that module is
 * built not to do. The hub applies it to its own handle and keeps the
 * module-scope constants it had.
 */
export function createMailboxStatements(handle: Database) {
  return {
    /**
     * What a socketless caller may be handed (SPEC § 8.10.1).
     *
     * Pending, and either never leased or leased to a caller whose lease has
     * lapsed. A batch handed out and not acknowledged therefore comes back —
     * the caller's turn may simply have ended before it could persist them.
     */
    leasableMessages: handle.prepare(`
      SELECT id, from_agent, to_agent, sent_by, content, reply_to, status, ts, leased_until
      FROM messages
      WHERE to_agent = ?1 AND status = 'pending'
        AND (leased_until IS NULL OR leased_until < datetime('now'))
      ORDER BY ts ASC
      LIMIT ?2
    `),
    leaseMessage: handle.prepare(`
      UPDATE messages SET leased_until = datetime('now', '+' || ?2 || ' seconds') WHERE id = ?1
    `),
    /**
     * Acknowledge, but only what the caller actually holds **and has not
     * already settled**.
     *
     * `AND status = 'pending'` is load-bearing. `receive()` reports a settled
     * message through `onSettled` when `changes > 0`, and SQLite counts a row
     * it rewrote with identical values as changed — so a second acknowledgement
     * of the same id fired the hook again and put a second `delivered` event
     * behind one message. That is the exact outcome § 8.9.4 forbids and the
     * one `receive()`'s own comment says the hook is placed here to avoid.
     *
     * The retry it happens on is not an edge: this file's next paragraph says a
     * caller retrying an ambiguous receive re-sends the same acknowledgements,
     * and the ids it does not hold are ignored rather than refused precisely so
     * that retry is safe.
     */
    ackMessage: handle.prepare(`
      UPDATE messages SET status = 'delivered', leased_until = NULL
      WHERE id = ?1 AND to_agent = ?2 AND status = 'pending'
    `),
    messageById: handle.prepare(`
      SELECT id, from_agent, to_agent, sent_by, content, reply_to, status, ts
      FROM messages WHERE id = ?
    `),
    countLeasable: handle.prepare(`
      SELECT COUNT(*) AS n FROM messages
      WHERE to_agent = ?1 AND status = 'pending'
        AND (leased_until IS NULL OR leased_until < datetime('now'))
    `),
  };
}
