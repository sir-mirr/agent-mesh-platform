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
