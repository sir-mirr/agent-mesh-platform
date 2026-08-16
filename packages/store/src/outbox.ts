/**
 * The sender's view of what it has sent (SPEC § 9.2.1).
 *
 * Two operations, and both exist because of one rule: **a sender may withdraw a
 * message the recipient has never been given, and may not withdraw one already
 * handed out.** The second half is what separates this from the standalone
 * mailer, where a sender could delete a message after it had been read — making
 * the sender the owner of someone else's record.
 *
 * The boundary is hand-over, not acknowledgement. A leased message was returned
 * in a response; the recipient holds it whether or not it survived to say so.
 *
 * ```
 * status='pending', leased_until IS NULL     never handed out   recallable
 * status='pending', leased_until in future   handed out         NOT recallable
 * status='delivered'                         acknowledged       NOT recallable
 * ```
 */

import type { Database } from "bun:sqlite";

export interface RecallableMessage {
  id: string;
  to: string;
  ts: string;
  /** Bytes of `content`, so a caller can recognise which message this is
   *  without the surface handing back what it already sent. */
  size: number;
}

/**
 * Messages this identity sent that nobody has been handed yet.
 *
 * Exactly the recallable set, so a caller never interprets `leased_until` and
 * the hub never exposes it. The hub judges; the client receives a list.
 *
 * Deliberately not "everything I sent" — that is `mesh.fetch_messages`, which
 * is a conversation. A message the recipient has seen is part of the
 * conversation; one they have not is not yet in it.
 */
export function listRecallable(db: Database, sender: string, limit: number): RecallableMessage[] {
  return db
    .prepare(
      `SELECT id, to_agent, ts, length(content) AS size
         FROM messages
        WHERE from_agent = ? AND status = 'pending'
          AND (leased_until IS NULL OR leased_until < datetime('now'))
        ORDER BY ts DESC
        LIMIT ?`,
    )
    .all(sender, limit)
    .map((r: any) => ({ id: r.id, to: r.to_agent, ts: r.ts, size: r.size }));
}

export type RecallOutcome = "recalled" | "already-delivered" | "not-found";

/**
 * Withdraw one message, deciding in the statement rather than before it.
 *
 * A recipient can call `mesh.receive` between a caller listing a message as
 * recallable and asking to recall it, so the listing is a hint and this is the
 * judgement. `changes` is the answer — a check followed by a write leaves a
 * window, and the window is where the defect lives (§ 10.1's `create_only` is
 * the same shape).
 *
 * `not-found` is distinguished from `already-delivered` because a caller acts
 * differently: the first means it has the wrong id, the second means it lost a
 * race it can never win again.
 */
export function recall(db: Database, sender: string, messageId: string): RecallOutcome {
  const result = db
    .prepare(
      `DELETE FROM messages
        WHERE id = ? AND from_agent = ? AND status = 'pending'
          AND (leased_until IS NULL OR leased_until < datetime('now'))`,
    )
    .run(messageId, sender);
  if (result.changes > 0) return "recalled";

  // Scoped to the sender: a caller asking about someone else's message is told
  // `not-found` rather than that it exists, so this cannot enumerate the mesh.
  const own = db
    .prepare(`SELECT 1 AS one FROM messages WHERE id = ? AND from_agent = ?`)
    .get(messageId, sender);
  return own ? "already-delivered" : "not-found";
}
