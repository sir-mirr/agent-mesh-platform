/**
 * Taking delivery, and settling what was taken before (SPEC § 8.10.1).
 *
 * This is the heart of store-and-forward, and it is here rather than in the hub
 * because it needs nothing the hub has. It reads a table, hands out a batch
 * under a lease, and settles the previous one. No socket, no presence, no idea
 * that a realtime path exists — see `docs/decisions/mailbox-and-hub.md`.
 *
 * ## What the caller supplies
 *
 * The database handle and the prepared statements, because the mailbox does not
 * own the schema — `@agent-mesh/store` does, and the hub migrates it (§ 3.1).
 * And an `onSettled` hook, because *recording* a delivery is an audit concern
 * belonging to whoever is running this, not to the queue itself.
 *
 * Injecting the hook rather than importing the recorder is the whole boundary in
 * one line. `recordDelivered` lives in the hub's audit module; importing it is
 * how this file would learn the hub exists.
 */

import type { Database, Statement } from "bun:sqlite";
import { createLogger } from "@agent-mesh/log";

const log = createLogger("mailbox");

/** A message as it goes back to the caller (§ 8.8.1). */
export interface MailboxMessage {
  id: string;
  from: string;
  to: string;
  sent_by: string | null;
  content: string;
  reply_to: string | null;
  ts: string;
}

export interface ReceiveResult {
  messages: MailboxMessage[];
  /** Still waiting beyond this batch, counted after the lease. */
  remaining: number;
  lease_seconds: number;
}

/**
 * The statements this needs, owned by `@agent-mesh/store` and passed in.
 *
 * Named rather than positional: five prepared statements in a row is an
 * argument list nobody reads twice, and swapping two of them silently
 * acknowledges the wrong batch.
 */
export interface MailboxStatements {
  ackMessage: Statement;
  messageById: Statement;
  leasableMessages: Statement;
  leaseMessage: Statement;
  countLeasable: Statement;
}

export interface ReceiveOptions {
  db: Database;
  stmt: MailboxStatements;
  identity: string;
  limit: number;
  ackIds: string[];
  leaseSeconds: number;
  /**
   * Called for each message the caller actually held and has now settled.
   *
   * **On acknowledgement, not on hand-out**, because that is when it is true: a
   * leased batch may be redelivered, and recording each attempt would put
   * several `delivered` events behind one message (§ 8.9.4).
   */
  onSettled?: (row: unknown) => void;
}

export function receive(opts: ReceiveOptions): ReceiveResult {
  const { db, stmt, identity, limit, ackIds, leaseSeconds, onSettled } = opts;

  let page: any[] = [];
  let remaining = 0;

  // One transaction. Settling the last batch and leasing the next are the same
  // act, so there is no instant at which a caller has settled one and not yet
  // claimed the other.
  const tx = db.transaction(() => {
    // Scoped to the caller's own queue, and ids it does not hold are ignored
    // rather than refused: a caller retrying an ambiguous receive re-sends the
    // same acknowledgements, and failing that retry would strand the very batch
    // it is trying to settle.
    for (const messageId of ackIds) {
      const settled = stmt.ackMessage.run(messageId, identity);
      // `changes` is what says the caller actually held it.
      if (settled.changes > 0) {
        const row = stmt.messageById.get(messageId);
        if (row && onSettled) onSettled(row);
      }
    }

    page = stmt.leasableMessages.all(identity, limit) as any[];
    // **A lease that lapsed is the only redelivery this service does.** The
    // batch comes back because the caller's turn ended before it could persist
    // what it was handed, which is the design -- and it is also what a caller
    // stuck in a crash loop looks like from here. Indistinguishable in the
    // rows, so it is counted where the two are still one event.
    const relet = page.filter((m) => m.leased_until !== null && m.leased_until !== undefined);
    if (relet.length > 0) {
      log.warn(`handing back ${relet.length} message(s) whose lease lapsed`, "lease_expired", {
        actor: identity,
        count: relet.length,
        outcome: "re_offered",
        reason: "lease_lapsed",
      });
    }
    for (const m of page) stmt.leaseMessage.run(m.id, leaseSeconds);
    remaining = (stmt.countLeasable.get(identity) as { n: number }).n;
  });
  tx();

  return {
    messages: page.map((m) => ({
      id: m.id,
      from: m.from_agent,
      to: m.to_agent,
      sent_by: m.sent_by,
      content: m.content,
      reply_to: m.reply_to,
      ts: m.ts,
    })),
    remaining,
    lease_seconds: leaseSeconds,
  };
}
