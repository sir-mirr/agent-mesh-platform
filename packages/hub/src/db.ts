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
import { agentsSchema, auditSchema, hubSchema, openStore } from "@agent-mesh/store";

/** Message routing and history. */
export const db = openStore("hub", { create: true });

/** Identity, keys and key history (SPEC § 3.1). */
export const agentsDb = openStore("agents", { create: true });

/**
 * The audit record (SPEC § 8.9). A third file rather than a third set of tables
 * because its retention is indefinite while the others are operational — on a
 * separate volume, audit filling the disk stops audit rather than the mesh.
 */
export const auditDb = openStore("audit", { create: true });

agentsSchema.migrate(agentsDb);
hubSchema.migrate(db);
auditSchema.migrate(auditDb);

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
  agentsDb.close();
  _srDb?.close();
  _srDb = null;
}

// --- agents -----------------------------------------------------------------

/** `created_at` is deliberately not updated: it is immutable post-insert (SPEC § 10.1). */
export const stmtUpsertAgent = agentsDb.prepare(`
  INSERT INTO agents (identity, description, last_seen, created_at)
  VALUES (?, ?, datetime('now'), datetime('now'))
  ON CONFLICT(identity) DO UPDATE SET
    description = COALESCE(excluded.description, agents.description),
    last_seen   = datetime('now')
`);

export const stmtUpdateLastSeen = agentsDb.prepare(`
  UPDATE agents SET last_seen = datetime('now') WHERE identity = ?
`);

/** Live identities only. A soft-deleted one must not appear (SPEC § 9.3). */
export const stmtListAgents = agentsDb.prepare(`
  SELECT identity, description, last_seen, type
  FROM agents WHERE deleted_at IS NULL ORDER BY identity
`);

/** Pre-registration check for `mesh.connect`. Soft-deleted counts as absent. */
export const stmtAgentExists = agentsDb.prepare(`
  SELECT 1 AS one FROM agents WHERE identity = ? AND deleted_at IS NULL
`);

/** Provisioning (SPEC § 10.1). Same immutability rule on `created_at`. */
export const stmtUpsertAgentTyped = agentsDb.prepare(`
  INSERT INTO agents (identity, type, description, last_seen, created_at)
  VALUES (?, ?, ?, datetime('now'), datetime('now'))
  ON CONFLICT(identity) DO UPDATE SET
    type        = excluded.type,
    description = excluded.description
`);

/** § 10.1 requires strict `YYYY-MM-DDTHH:MM:SSZ`, which SQLite formats for us. */
export const stmtSelectAgent = agentsDb.prepare(`
  SELECT
    identity,
    type,
    description,
    last_seen,
    deleted_at,
    strftime('%Y-%m-%dT%H:%M:%SZ', created_at) AS created_at_iso
  FROM agents WHERE identity = ?
`);

/**
 * Teardown is a soft delete (SPEC § 9.3). `messages` is left alone: the rows
 * outlive the identity, and once signatures exist, discarding a key would make
 * every past signature unverifiable.
 */
export const stmtSoftDeleteAgent = agentsDb.prepare(`
  UPDATE agents SET deleted_at = datetime('now')
  WHERE identity = ? AND deleted_at IS NULL
`);

/** Revoking the identity's keys is part of the same transaction. */
export const stmtRevokeKeysOfAgent = agentsDb.prepare(`
  UPDATE agent_keys SET status = 'revoked', decided_at = datetime('now')
  WHERE identity = ? AND status IN ('pending','approved')
`);

export const stmtInsertKeyEvent = agentsDb.prepare(`
  INSERT INTO agent_key_events (id, identity, fingerprint, action, reason, actor)
  VALUES (?, ?, ?, ?, ?, ?)
`);

/**
 * Whether an identity has been torn down. An unknown identity is not the same
 * thing: SPEC § 3.1 has unknown recipients queued, because one may be
 * provisioned later. A soft-deleted one never will be.
 */
export const stmtAgentDeleted = agentsDb.prepare(`
  SELECT deleted_at FROM agents WHERE identity = ? AND deleted_at IS NOT NULL
`);

export const stmtSetCanProxy = agentsDb.prepare(`
  UPDATE agents SET can_proxy = ? WHERE identity = ?
`);

export const stmtKeysOfAgent = agentsDb.prepare(`
  SELECT fingerprint FROM agent_keys WHERE identity = ? AND status IN ('pending','approved')
`);

// --- audit (SPEC § 8.9) ------------------------------------------------------

export const stmtInsertAuditEvent = auditDb.prepare(`
  INSERT INTO audit_events (
    event_id, schema_version, event_type, occurred_at, correlation_id,
    causation_event_id, producer_id, identity, recorded_by_kind, recorded_by_id,
    payload, payload_digest, attestation
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export const stmtInsertAuditBlob = auditDb.prepare(`
  INSERT INTO audit_event_blobs (event_id, blob_key, sha256, size, name)
  VALUES (?, ?, ?, ?, ?)
`);

export const stmtSelectAuditEvent = auditDb.prepare(`
  SELECT payload_digest, stored_at FROM audit_events WHERE event_id = ?
`);

// --- messages ---------------------------------------------------------------

export const stmtInsertMessage = db.prepare(`
  INSERT INTO messages (id, from_agent, to_agent, sent_by, content, reply_to, status, ts)
  VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
`);

export const stmtUpdateMessageStatus = db.prepare(`
  UPDATE messages SET status = ? WHERE id = ?
`);

/** Both directions of one conversation, newest first (SPEC § 8.4). */
export const stmtFetchMessages = db.prepare(`
  SELECT id, from_agent, to_agent, sent_by, content, reply_to, status, ts
  FROM messages
  WHERE (from_agent = ?1 AND to_agent = ?2)
     OR (from_agent = ?2 AND to_agent = ?1)
  ORDER BY ts DESC
  LIMIT ?3
`);

/** Oldest first: pending messages are replayed in the order they arrived. */
export const stmtPendingMessages = db.prepare(`
  SELECT id, from_agent, to_agent, sent_by, content, reply_to, status, ts
  FROM messages
  WHERE to_agent = ? AND status = 'pending'
  ORDER BY ts ASC
`);
