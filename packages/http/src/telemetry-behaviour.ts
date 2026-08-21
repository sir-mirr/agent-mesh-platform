/**
 * Reading the four behaviour metrics that come from this server's own stores.
 *
 * `shapeMetrics` was already separated from the reading so it could be tested
 * against a source that failed. The reading itself was not: it sat inline in
 * the route with three `catch` blocks that turn an unreadable store into
 * `null`, and reaching any of them meant breaking a store under a live
 * process. Every source is a parameter here for the reason `audit-agents.ts`
 * and `chat-audits.ts` take theirs.
 *
 * **`null` and `0` are different answers**, which is the whole point of the
 * split. Four of these six read `0` when everything is well, so a zero
 * produced by a source that could not be reached is the one wrong number an
 * operator has no reason to question.
 */

import type { Database } from "bun:sqlite";
import type { Sources } from "./behaviour-metrics";

export interface BehaviourDeps {
  /** The key-proposal queue, read through the same helper its route uses. */
  pendingKeys: () => { status: number; body: unknown };
  /** The people waiting to be admitted, as `/api/v1/admin/pending` lists them. */
  pendingApprovals: () => Array<{ requested_at?: string }>;
  openHub: () => Database;
  /** Injected so the age of a queue is a fact about the test, not about the clock. */
  now: () => number;
}

/**
 * SQLite's `CURRENT_TIMESTAMP` is UTC with no zone marker, so it is stamped as
 * UTC rather than handed to `Date.parse` as-is — which reads it as local time
 * and reports a queue hours older or younger than it is.
 */
export function parseSqliteUtc(stamp: string): number {
  return Date.parse(`${stamp.replace(" ", "T")}Z`);
}

export function readBehaviour(deps: BehaviourDeps): Omit<Sources, "limits"> {
  let pendingKeys: number | null = null;
  try {
    const r = deps.pendingKeys();
    // **`keys`, which is what the helper returns.** This read `proposals` — a
    // field no version of that body has ever carried — so `?? 0` answered for
    // it and telemetry reported an empty key queue however many proposals were
    // waiting. A zero from a source that was read incorrectly is worse than an
    // unread marker: nothing about it looks wrong.
    pendingKeys = r.status === 200 ? ((r.body as any).keys?.length ?? 0) : null;
  } catch {
    pendingKeys = null;
  }

  // The other decision queue. Two of them answer on this server and this
  // metric counted one: key proposals were here, the people waiting on
  // `/api/v1/admin/pending` were not, so an operator reading telemetry saw a
  // calm mesh while somebody waited to be let in.
  let pendingUsers: number | null = null;
  let oldestPendingUserMs: number | null = null;
  try {
    const waiting = deps.pendingApprovals();
    pendingUsers = waiting.length;
    const stamps = waiting
      .map((row) => (row.requested_at ? parseSqliteUtc(row.requested_at) : NaN))
      .filter((ms) => Number.isFinite(ms));
    oldestPendingUserMs = stamps.length > 0 ? deps.now() - Math.min(...stamps) : 0;
  } catch {
    pendingUsers = null;
    oldestPendingUserMs = null;
  }

  let oldestPendingMs: number | null = null;
  let accepted: number | null = null;
  try {
    const db = deps.openHub();
    // The same UTC reading as above, spelled in SQL because the subtraction
    // happens where the stamp was written.
    const oldest = db
      .prepare(
        `SELECT (strftime('%s','now') - strftime('%s', MIN(ts))) * 1000 AS ms
         FROM messages WHERE status = 'pending'`,
      )
      .get() as { ms: number | null };
    // No pending message is a real zero, not an unknown: the query answered.
    oldestPendingMs = oldest?.ms ?? 0;
    const total = db.prepare(`SELECT COUNT(*) AS n FROM messages`).get() as { n: number };
    accepted = total.n;
  } catch {
    oldestPendingMs = null;
    accepted = null;
  }

  return { pendingKeys, pendingUsers, oldestPendingUserMs, oldestPendingMs, accepted };
}
