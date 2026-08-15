/**
 * The hub's database handles and its prepared statements.
 *
 * Statements are prepared once at module load because they are on every hot
 * path — routing a message, marking an identity seen — and re-preparing per
 * call would be the dominant cost of each.
 *
 * The hub owns the DDL for the stores it writes (SPEC § 3.1); other services
 * open them expecting the tables to be there.
 */

import type { Database } from "bun:sqlite";
import { agentsSchema, hubSchema, openStore } from "@agent-mesh/store";

/**
 * `agents` and `messages` share `hub.db` at 0.1. SPEC 0.2 moves `agents` into
 * its own file, which is a second handle here rather than an untangling — the
 * schemas are already separate modules.
 */
export const db = openStore("hub", { create: true });

agentsSchema.migrate(db);
hubSchema.migrate(db);

/**
 * The self-reminder daemon's store, opened lazily because the hub only touches
 * it when a reminder RPC arrives, and a deployment may never see one.
 */
let _srDb: Database | null = null;
export function srDb(): Database {
  if (!_srDb) {
    _srDb = openStore("selfReminder");
  }
  return _srDb;
}

export function closeDatabases(): void {
  db.close();
  _srDb?.close();
  _srDb = null;
}

// --- agents -----------------------------------------------------------------

/** `created_at` is deliberately not updated: it is immutable post-insert (SPEC § 10.1). */
export const stmtUpsertAgent = db.prepare(`
  INSERT INTO agents (identity, description, last_seen, created_at)
  VALUES (?, ?, datetime('now'), datetime('now'))
  ON CONFLICT(identity) DO UPDATE SET
    description = COALESCE(excluded.description, agents.description),
    last_seen   = datetime('now')
`);

export const stmtUpdateLastSeen = db.prepare(`
  UPDATE agents SET last_seen = datetime('now') WHERE identity = ?
`);

export const stmtListAgents = db.prepare(`
  SELECT identity, description, last_seen, type FROM agents ORDER BY identity
`);

export const stmtAgentExists = db.prepare(`
  SELECT 1 AS one FROM agents WHERE identity = ?
`);

/** Provisioning (SPEC § 10.1). Same immutability rule on `created_at`. */
export const stmtUpsertAgentTyped = db.prepare(`
  INSERT INTO agents (identity, type, description, last_seen, created_at)
  VALUES (?, ?, ?, datetime('now'), datetime('now'))
  ON CONFLICT(identity) DO UPDATE SET
    type        = excluded.type,
    description = excluded.description
`);

/** § 10.1 requires strict `YYYY-MM-DDTHH:MM:SSZ`, which SQLite formats for us. */
export const stmtSelectAgent = db.prepare(`
  SELECT
    identity,
    type,
    description,
    last_seen,
    strftime('%Y-%m-%dT%H:%M:%SZ', created_at) AS created_at_iso
  FROM agents WHERE identity = ?
`);

export const stmtDeleteAgent = db.prepare(`
  DELETE FROM agents WHERE identity = ?
`);

export const stmtDeleteMessagesOfAgent = db.prepare(`
  DELETE FROM messages WHERE from_agent = ? OR to_agent = ?
`);

// --- messages ---------------------------------------------------------------

export const stmtInsertMessage = db.prepare(`
  INSERT INTO messages (id, from_agent, to_agent, content, reply_to, status, ts)
  VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
`);

export const stmtUpdateMessageStatus = db.prepare(`
  UPDATE messages SET status = ? WHERE id = ?
`);

/** Both directions of one conversation, newest first (SPEC § 8.4). */
export const stmtFetchMessages = db.prepare(`
  SELECT id, from_agent, to_agent, content, reply_to, status, ts
  FROM messages
  WHERE (from_agent = ?1 AND to_agent = ?2)
     OR (from_agent = ?2 AND to_agent = ?1)
  ORDER BY ts DESC
  LIMIT ?3
`);

/** Oldest first: pending messages are replayed in the order they arrived. */
export const stmtPendingMessages = db.prepare(`
  SELECT id, from_agent, to_agent, content, reply_to, status, ts
  FROM messages
  WHERE to_agent = ? AND status = 'pending'
  ORDER BY ts ASC
`);
