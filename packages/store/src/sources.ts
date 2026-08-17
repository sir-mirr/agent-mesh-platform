/**
 * Where an identity has been seen connecting from (SPEC § 8.11).
 *
 * The value written here is always the hub's own observation — never anything
 * a peer claimed. `packages/hub/src/observed.ts` is what makes that true and
 * holds the reasoning; this file only stores the result.
 *
 * `null` is not recorded. A missing observation is not a source, and writing
 * one would create a row that compares equal to every other missing
 * observation — an identity would then "match" a baseline it never had.
 */

import type { Database } from "bun:sqlite";

export interface AgentSource {
  observed: string;
  first_seen: string;
  last_seen: string;
  requests: number;
}

/**
 * Note one authenticated request.
 *
 * Upsert rather than insert: one row per address, so a lane running for months
 * from one host is one row and a key used from twenty places is twenty. That
 * is the shape the question has.
 */
export function recordSource(db: Database, identity: string, observed: string | null): void {
  if (!observed) return;
  db.prepare(
    `INSERT INTO agent_sources (identity, observed) VALUES (?, ?)
     ON CONFLICT(identity, observed) DO UPDATE SET
       last_seen = datetime('now'),
       requests  = requests + 1`,
  ).run(identity, observed);
}

/** Most recently used first — which is the order an operator reads them in. */
export function listSources(db: Database, identity: string): AgentSource[] {
  return db
    .prepare(
      `SELECT observed, first_seen, last_seen, requests
         FROM agent_sources WHERE identity = ? ORDER BY last_seen DESC`,
    )
    .all(identity) as AgentSource[];
}

/**
 * Whether this identity has been seen at this place before (SPEC § 8.11.2).
 *
 * **Called before recording, not after.** `recordSource` upserts, so asking
 * afterwards always answers yes — the check would pass for every request
 * including the first one from a thief, and nothing would ever be refused.
 *
 * "Place" is whatever `group` reduces an address to. Comparing groups rather
 * than addresses is what keeps a DHCP renewal from reading as a move.
 *
 * An identity with **no** recorded source is treated as familiar. It has
 * nothing to be compared against, and refusing a first send would make the
 * mechanism a barrier to onboarding rather than to theft.
 */
export function seenBefore(
  db: Database,
  identity: string,
  observed: string | null,
  group: (a: string | null) => string | null,
): boolean {
  if (!observed) return true;
  const rows = db
    .prepare(`SELECT observed FROM agent_sources WHERE identity = ?`)
    .all(identity) as Array<{ observed: string }>;
  if (rows.length === 0) return true;
  const here = group(observed);
  return rows.some((r) => group(r.observed) === here);
}

/** When this identity last sent, or null. */
export function lastSendAt(db: Database, identity: string): string | null {
  const row = db.prepare(`SELECT last_send_at FROM agents WHERE identity = ?`).get(identity) as
    | { last_send_at: string | null }
    | undefined;
  return row?.last_send_at ?? null;
}

/** Stamp a send. Called only where one was accepted. */
export function markSend(db: Database, identity: string): void {
  db.prepare(`UPDATE agents SET last_send_at = datetime('now') WHERE identity = ?`).run(identity);
}
