/**
 * The signing-key lifecycle (SPEC § 10.2).
 *
 * ```
 * none ──propose (any caller)──▶ pending ──approve (operator)──▶ approved
 *                                   └──────deny (operator)─────▶ denied
 * approved ──rotation proposal──▶ pending ──approve──▶ previous key revoked
 * ```
 *
 * Here rather than in either service because both halves run it: the hub
 * accepts proposals on an unauthenticated route, and http performs approval
 * behind the admin gate. Two implementations of one state machine are two sets
 * of edge cases, and the edge cases are the whole of it — the straight path
 * through this file is a handful of lines, and everything else exists because a
 * client restarted at an awkward moment.
 *
 * **Proposing grants nothing.** That is what lets § 10.1 stay unauthenticated:
 * anyone can propose a key, and it is inert until an operator compares its
 * fingerprint against the one the holder logged and approves it.
 *
 * Every transition appends to `agent_key_events`. Rows are never deleted —
 * revocation is a status change, because past signatures stay verifiable and
 * the event timeline is what lets a verifier judge them by date. A routine
 * `rotation` says nothing about earlier signatures; a `compromise` casts doubt
 * on the window before it.
 */

import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";

import { keyFingerprint } from "@agent-mesh/contracts";

import type { AgentKeyRow, KeyStatus } from "./schema/agents";

export type KeyEventAction = "proposed" | "approved" | "denied" | "revoked" | "superseded";

/** Why an identity has no usable key — the `data.key_status` of a `-32014`. */
export type NoKeyReason = "missing" | "pending" | "denied" | "revoked";

export interface ProposeResult {
  fingerprint: string;
  status: KeyStatus;
  /** False when the key was already on record and nothing changed. */
  created: boolean;
}

function appendEvent(
  db: Database,
  identity: string,
  fingerprint: string,
  action: KeyEventAction,
  reason: string | null,
  actor: string,
): void {
  db.prepare(
    `INSERT INTO agent_key_events (id, identity, fingerprint, action, reason, actor)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), identity, fingerprint, action, reason, actor);
}

function keyByFingerprint(db: Database, fingerprint: string): AgentKeyRow | null {
  return (
    (db.prepare(`SELECT * FROM agent_keys WHERE fingerprint = ?`).get(fingerprint) as AgentKeyRow) ??
    null
  );
}

function keyByStatus(db: Database, identity: string, status: KeyStatus): AgentKeyRow | null {
  return (
    (db
      .prepare(`SELECT * FROM agent_keys WHERE identity = ? AND status = ?`)
      .get(identity, status) as AgentKeyRow) ?? null
  );
}

export function approvedKey(db: Database, identity: string): AgentKeyRow | null {
  return keyByStatus(db, identity, "approved");
}

export function pendingKey(db: Database, identity: string): AgentKeyRow | null {
  return keyByStatus(db, identity, "pending");
}

/**
 * Which identity holds this fingerprint as its approved key.
 *
 * The reverse of the usual lookup, and it is what lets a caller with no socket
 * identify itself: at most one key per identity is approved, so a fingerprint
 * names exactly one participant. A caller therefore does not have to *claim* an
 * identity over HTTP — the signature already says which one it is, and a claim
 * it could make separately would be a claim it could get wrong or lie about.
 *
 * Deliberately restricted to `approved`. A revoked or denied fingerprint
 * resolves to nothing, so a withdrawn key stops identifying its holder at the
 * same moment it stops verifying.
 */
export function identityForFingerprint(db: Database, fingerprint: string): string | null {
  const row = db
    .prepare(`SELECT identity FROM agent_keys WHERE fingerprint = ? AND status = 'approved'`)
    .get(fingerprint) as { identity: string } | undefined;
  return row?.identity ?? null;
}

export function listKeys(db: Database, identity: string): AgentKeyRow[] {
  return db
    .prepare(`SELECT * FROM agent_keys WHERE identity = ? ORDER BY proposed_at DESC`)
    .all(identity) as AgentKeyRow[];
}

/** Everything awaiting an operator, oldest first — the approval queue. */
export function listPendingKeys(db: Database): AgentKeyRow[] {
  return db
    .prepare(`SELECT * FROM agent_keys WHERE status = 'pending' ORDER BY proposed_at ASC`)
    .all() as AgentKeyRow[];
}

export function listKeyEvents(db: Database, identity: string): Array<{
  id: string;
  identity: string;
  fingerprint: string;
  action: KeyEventAction;
  reason: string | null;
  actor: string | null;
  occurred_at: string;
}> {
  return db
    .prepare(`SELECT * FROM agent_key_events WHERE identity = ? ORDER BY occurred_at ASC, id ASC`)
    .all(identity) as any[];
}

/**
 * Register a key for an identity, or report what is already on record.
 *
 * Three behaviours the straight reading misses, each of them a restarting
 * client rather than a hypothetical:
 *
 * - **A key already on record is a no-op.** An adapter that re-sends its key on
 *   every boot must not knock its own approved key back to `pending`, which
 *   would take it offline until someone noticed and re-approved.
 * - **A different key while one is pending replaces it.** A restart loop with a
 *   fresh key each time would otherwise flood the queue, and only the newest
 *   proposal can possibly be the one the holder is logging.
 * - **A proposal never touches an approved key.** Rotation is proposed
 *   alongside; the incumbent stays usable until the replacement is approved, so
 *   proposing does not create a window where the identity cannot sign.
 */
export function proposeKey(
  db: Database,
  identity: string,
  publicKey: string,
  actor = "api",
): ProposeResult {
  const fingerprint = keyFingerprint(publicKey);

  const existing = keyByFingerprint(db, fingerprint);
  if (existing) {
    // Including `denied` and `revoked`: re-proposing a key an operator has
    // already ruled on returns that ruling rather than quietly reopening it.
    return { fingerprint, status: existing.status, created: false };
  }

  const tx = db.transaction(() => {
    const superseded = pendingKey(db, identity);
    if (superseded) {
      // Deleted rather than parked in a terminal state. Nothing was ever signed
      // with it, so there is no signature its survival would keep verifiable —
      // and leaving it as `denied` would make a client that flaps between two
      // keys unable to re-propose the first. The event is the record.
      db.prepare(`DELETE FROM agent_keys WHERE fingerprint = ?`).run(superseded.fingerprint);
      appendEvent(db, identity, superseded.fingerprint, "superseded", fingerprint, actor);
    }
    db.prepare(
      `INSERT INTO agent_keys (fingerprint, identity, public_key, status) VALUES (?, ?, ?, 'pending')`,
    ).run(fingerprint, identity, publicKey);
    appendEvent(db, identity, fingerprint, "proposed", null, actor);
  });
  tx();

  return { fingerprint, status: "pending", created: true };
}

export class KeyTransitionError extends Error {
  constructor(
    message: string,
    readonly code: "not-found" | "wrong-state",
  ) {
    super(message);
  }
}

function requireKey(db: Database, fingerprint: string, expected: KeyStatus[]): AgentKeyRow {
  const row = keyByFingerprint(db, fingerprint);
  if (!row) throw new KeyTransitionError(`no key with fingerprint ${fingerprint}`, "not-found");
  if (!expected.includes(row.status)) {
    throw new KeyTransitionError(
      `key ${fingerprint} is ${row.status}, expected ${expected.join(" or ")}`,
      "wrong-state",
    );
  }
  return row;
}

/**
 * Approve a pending key, revoking whatever it replaces.
 *
 * The revocation is `rotation`, and the distinction is load-bearing: it records
 * that the old key was retired in the ordinary way, so signatures it made
 * before this moment stay trustworthy. A key retired because it leaked must be
 * revoked explicitly with that reason instead — approving a replacement does
 * not say anything about how the previous one ended.
 */
export function approveKey(db: Database, fingerprint: string, actor: string): AgentKeyRow {
  const row = requireKey(db, fingerprint, ["pending"]);

  const tx = db.transaction(() => {
    const incumbent = approvedKey(db, row.identity);
    if (incumbent) {
      db.prepare(
        `UPDATE agent_keys SET status = 'revoked', decided_at = CURRENT_TIMESTAMP, decided_by = ?
         WHERE fingerprint = ?`,
      ).run(actor, incumbent.fingerprint);
      appendEvent(db, row.identity, incumbent.fingerprint, "revoked", "rotation", actor);
    }
    db.prepare(
      `UPDATE agent_keys SET status = 'approved', decided_at = CURRENT_TIMESTAMP, decided_by = ?
       WHERE fingerprint = ?`,
    ).run(actor, fingerprint);
    appendEvent(db, row.identity, fingerprint, "approved", null, actor);
  });
  tx();

  return keyByFingerprint(db, fingerprint)!;
}

export function denyKey(
  db: Database,
  fingerprint: string,
  actor: string,
  reason: string | null = null,
): AgentKeyRow {
  const row = requireKey(db, fingerprint, ["pending"]);
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE agent_keys SET status = 'denied', decided_at = CURRENT_TIMESTAMP, decided_by = ?
       WHERE fingerprint = ?`,
    ).run(actor, fingerprint);
    appendEvent(db, row.identity, fingerprint, "denied", reason, actor);
  });
  tx();
  return keyByFingerprint(db, fingerprint)!;
}

/**
 * Revoke a key, with or without a replacement waiting.
 *
 * An identity whose only approved key is revoked can neither connect nor sign
 * until a new one is approved, and that is the intended outcome rather than a
 * gap to be softened: the alternative is leaving a key an operator has decided
 * to stop trusting in service until something more convenient happens.
 */
export function revokeKey(
  db: Database,
  fingerprint: string,
  actor: string,
  reason: string,
): AgentKeyRow {
  const row = requireKey(db, fingerprint, ["approved", "pending"]);
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE agent_keys SET status = 'revoked', decided_at = CURRENT_TIMESTAMP, decided_by = ?
       WHERE fingerprint = ?`,
    ).run(actor, fingerprint);
    appendEvent(db, row.identity, fingerprint, "revoked", reason, actor);
  });
  tx();
  return keyByFingerprint(db, fingerprint)!;
}

/**
 * Why an identity cannot sign, for `-32014`'s `data.key_status` (SPEC § 8.1).
 *
 * `null` means it can. The distinction a client acts on is `pending` — wait for
 * an operator — against `denied` or `revoked`, which mean stop and ask a human.
 * Reporting them all as "no key" would make a client retry through a shutoff.
 */
export function noKeyReason(db: Database, identity: string): NoKeyReason | null {
  if (approvedKey(db, identity)) return null;
  if (pendingKey(db, identity)) return "pending";

  // Most recent ruling wins: an identity may have accumulated several.
  const last = db
    .prepare(
      `SELECT status FROM agent_keys WHERE identity = ? AND status IN ('denied','revoked')
       ORDER BY decided_at DESC, rowid DESC LIMIT 1`,
    )
    .get(identity) as { status: "denied" | "revoked" } | undefined;
  return last?.status ?? "missing";
}
