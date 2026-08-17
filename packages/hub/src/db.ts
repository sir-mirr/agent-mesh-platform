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
import { groups as groupsSchema, agentsSchema, auditSchema, hubSchema, openStore, selfReminderSchema } from "@agent-mesh/store";

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
// § 12. Groups live beside identities, and the hub decides every send.
groupsSchema.migrate(agentsDb);

/**
 * Proxies the deployment declares (SPEC § 8.2).
 *
 * `can_proxy` used to arrive on the unauthenticated provisioning route, which
 * meant the entitlement check read a value the checked party had written.
 * Refusing it there left `agent-mesh-http` unable to obtain the flag it
 * genuinely needs — and it should not be able to grant itself one.
 *
 * So a deployment states its proxies. Speaking on behalf of other identities is
 * the strongest thing a participant can hold, and this is the level at which
 * that decision belongs: an operator editing configuration, not a process
 * asking for it at startup.
 *
 * **Additive.** It grants and never withdraws, because withdrawing here would
 * fight the other half of § 8.2: an operator granting through
 * `POST /api/v1/admin/agents/{identity}/can-proxy` made a decision, and a hub
 * restart clearing it would undo that silently.
 */
export const DECLARED_PROXIES: ReadonlySet<string> = new Set(
  (process.env.AGENT_MESH_PROXY_IDENTITIES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

/**
 * Apply the declaration to one identity.
 *
 * Called at boot **and** on every provisioning, because both orders happen: a
 * hub restarted beside a running proxy finds the row already there, and a hub
 * started first finds nothing and must grant when the row appears. The second
 * is the common case — `agent-mesh-http` registers itself after connecting —
 * and doing only the first left it unable to proxy at all.
 */
export function applyDeclaredProxy(identity: string): void {
  if (!DECLARED_PROXIES.has(identity)) return;
  agentsDb.prepare(`UPDATE agents SET can_proxy = 1 WHERE identity = ?`).run(identity);
}

for (const identity of DECLARED_PROXIES) applyDeclaredProxy(identity);
hubSchema.migrate(db);
auditSchema.migrate(auditDb);

/**
 * The self-reminder daemon's store, opened lazily because the hub only touches
 * it when a reminder RPC arrives, and a deployment may never see one.
 */
let _srDb: Database | null = null;
/**
 * The scheduler's store, opened lazily.
 *
 * Created and migrated here as well as by the daemon, because § 8.5 lets a
 * reminder be scheduled while the daemon is down — the row waits for it. Opening
 * without `create` meant every reminder RPC failed on a state directory the
 * daemon had not touched first, which is every fresh deployment and every test.
 */
export function srDb(): Database {
  if (!_srDb) {
    _srDb = openStore("selfReminder", { create: true });
    selfReminderSchema.migrate(_srDb);
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
/**
 * Insert only if the identity is free (SPEC § 10.1, `create_only`).
 *
 * `changes` is the answer, and the check is the insert rather than a read
 * before one — a separate existence check leaves a window in which a second
 * caller registers between the two, which is precisely the race a lane
 * onboarding must not lose.
 */
export const stmtInsertAgentIfAbsent = agentsDb.prepare(`
  INSERT INTO agents (identity, type, description, last_seen, created_at)
  VALUES (?, ?, ?, datetime('now'), datetime('now'))
  ON CONFLICT(identity) DO NOTHING
`);

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

/**
 * What a socketless caller may be handed (SPEC § 8.10.1).
 *
 * Pending, and either never leased or leased to a caller whose lease has
 * lapsed. A batch handed out and not acknowledged therefore comes back — the
 * caller's turn may simply have ended before it could persist them.
 */
export const stmtLeasableMessages = db.prepare(`
  SELECT id, from_agent, to_agent, sent_by, content, reply_to, status, ts
  FROM messages
  WHERE to_agent = ?1 AND status = 'pending'
    AND (leased_until IS NULL OR leased_until < datetime('now'))
  ORDER BY ts ASC
  LIMIT ?2
`);

export const stmtLeaseMessage = db.prepare(`
  UPDATE messages SET leased_until = datetime('now', '+' || ?2 || ' seconds') WHERE id = ?1
`);

/** Acknowledge, but only what the caller actually holds. */
export const stmtAckMessage = db.prepare(`
  UPDATE messages SET status = 'delivered', leased_until = NULL
  WHERE id = ?1 AND to_agent = ?2
`);

export const stmtMessageById = db.prepare(`
  SELECT id, from_agent, to_agent, sent_by, content, reply_to, status, ts
  FROM messages WHERE id = ?
`);

export const stmtCountLeasable = db.prepare(`
  SELECT COUNT(*) AS n FROM messages
  WHERE to_agent = ?1 AND status = 'pending'
    AND (leased_until IS NULL OR leased_until < datetime('now'))
`);

// --- send idempotency (SPEC § 8.2) -------------------------------------------

export const stmtSelectIdempotency = db.prepare(`
  SELECT request_digest, message_id, status FROM send_idempotency
  WHERE sent_by = ?1 AND client_message_id = ?2
`);

export const stmtInsertIdempotency = db.prepare(`
  INSERT INTO send_idempotency (sent_by, client_message_id, request_digest, message_id, status)
  VALUES (?, ?, ?, ?, ?)
`);

/** Oldest first: pending messages are replayed in the order they arrived. */
export const stmtPendingMessages = db.prepare(`
  SELECT id, from_agent, to_agent, sent_by, content, reply_to, status, ts
  FROM messages
  WHERE to_agent = ? AND status = 'pending'
  ORDER BY ts ASC
`);
