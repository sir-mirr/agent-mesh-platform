/**
 * Taking a message in (SPEC § 8.2, § 8.11.2).
 *
 * The half of `mesh.send` that is store-and-forward: write the message, stamp
 * the sender, and record the idempotency key — in one transaction, so a crash
 * between them cannot leave a key naming a message that does not exist, or a
 * message a retry would duplicate.
 *
 * ## What it deliberately does not decide
 *
 * **Whether the recipient is there.** `status` arrives already decided, because
 * deciding it means reading presence and the mailbox has no notion of who is
 * online — `docs/decisions/mailbox-and-hub.md` puts that call on the hub, and
 * the same rule sends a reply back through the mailbox unless both ends happen
 * to be live.
 *
 * Passing the answer in rather than a `isOnline` callback is the difference
 * between a boundary and a hole: a callback would let the mailbox ask, and
 * anything it can ask, it depends on.
 *
 * **Whether the send was allowed.** Entitlement, egress and dormancy are
 * refusals the caller has already made. What reaches here is accepted.
 */

import type { Database, Statement } from "bun:sqlite";

/** Where a message stands the moment it is written (§ 8.2). */
export type AcceptedStatus = "delivered" | "pending";

export interface AcceptStatements {
  insertMessage: Statement;
  insertIdempotency: Statement;
}

export interface AcceptOptions {
  /** The store holding messages. One transaction spans everything below. */
  db: Database;
  stmt: AcceptStatements;

  id: string;
  /** Who the message is *from*, which a proxy does not change (§ 8.2). */
  from: string;
  to: string;
  /** The socket that carried it. Null when nothing proxied. */
  sentBy: string | null;
  content: string;
  replyTo: string | null;
  /** Decided by the caller, from presence the mailbox cannot see. */
  status: AcceptedStatus;
  /** The transport the sender used, for routing the reply to this (§ 8.2a). */
  via: "mesh" | "mailbox";

  /** § 8.2 idempotency. Both or neither. */
  clientMessageId?: string | null;
  idempotencyDigest?: string | null;

  /**
   * Ran inside the transaction, for what the caller keeps elsewhere.
   *
   * `markSend` writes the dormancy clock into `agents.db`, which is a different
   * store with a different owner. It belongs to the same commit as the message
   * — § 8.11.2 measures silence rather than attempts, so a send that did not
   * persist must not move the clock — and it is the caller's write, not this
   * one's.
   */
  alsoInTransaction?: () => void;
}

/**
 * Write it. Throws what SQLite throws.
 *
 * Not caught here: § 15.6 forbids storage failure from stopping routing, and
 * the caller is the one that knows how to say so in its own protocol. Swallowing
 * it would leave a send that answered success and stored nothing.
 */
export function accept(opts: AcceptOptions): void {
  const { db, stmt, clientMessageId, idempotencyDigest } = opts;

  const tx = db.transaction(() => {
    stmt.insertMessage.run(
      opts.id,
      opts.from,
      opts.to,
      opts.sentBy,
      opts.content,
      opts.replyTo,
      opts.status,
      opts.via,
    );
    opts.alsoInTransaction?.();
    if (idempotencyDigest != null && typeof clientMessageId === "string") {
      stmt.insertIdempotency.run(
        opts.sentBy,
        clientMessageId,
        idempotencyDigest,
        opts.id,
        opts.status,
      );
    }
  });
  tx();
}
