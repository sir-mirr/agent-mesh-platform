/**
 * `agents.db` — identity, keys, key history (SPEC § 3.1, § 10.2, § 10.3).
 *
 * Separate from `hub.db` because the lifetimes differ. Identity is small and
 * permanent; messages are operational and short-lived; audit is kept
 * indefinitely. One file would mean one backup policy, one `VACUUM`, and —
 * the part that matters — audit growth filling the disk taking message routing
 * down with it.
 *
 * Both the hub and the http server hold this file read-write: the hub to
 * provision, the http server to record an operator's approval.
 *
 * Only the hub calls `migrate` (SPEC § 3.1).
 */

import type { Database } from "bun:sqlite";

/**
 * Seeded types, and whether an identity of that type may exist without a
 * signing key.
 *
 * This is **informative**, not a closed set. `agents.type` is a classification
 * label that nothing branches on, so validating it against a hardcoded enum
 * meant a new runtime needed a specification revision to widen a list no code
 * read. Deployments extend the table; adding a runtime changes no code.
 *
 * `service` is seeded at `0` because the baseline services predate keys. A
 * deployment that wants them authenticated raises the flag.
 *
 * `human` is seeded at `0` for a different and more permanent reason. A person
 * signs into the web surface and is authenticated there by session token; they
 * hold no key and never connect a socket of their own, so their envelopes reach
 * the hub through the http server. Requiring a key of them would require a
 * browser to hold one, and the key model here is one approved key per identity
 * — which fits an installed agent on one machine and not a person with a laptop
 * and a phone.
 *
 * Until now a person had no type at all: they existed only in the http server's
 * own registry, so the hub had no word for the participants it was routing the
 * most traffic for.
 */
const SEEDED_TYPES: ReadonlyArray<[type: string, description: string, requiresKey: 0 | 1]> = [
  ["ai-claude", "Claude runtime", 1],
  ["ai-codex", "Codex runtime", 1],
  ["ai-gemini", "Gemini runtime", 1],
  ["service", "Baseline service", 0],
  ["human", "Person, authenticated by web session rather than by key", 0],
];

export function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      identity    TEXT PRIMARY KEY,
      description TEXT,
      last_seen   DATETIME,
      type        TEXT,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      deleted_at  DATETIME,
      can_proxy   INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Idempotent shims for databases written by earlier builds. PRAGMA lists
  // every column, so a missing one is added rather than assumed present.
  //   type       — added in the era that made POST /api/v1/agents the SSOT.
  //   created_at — added for the ISO-8601 provenance SPEC § 10.1 requires, and
  //                backfilled from last_seen because there was no better
  //                source. Operators wanting cleaner values apply
  //                ops/migrations/0001_*.sql instead.
  //   deleted_at — 0.2 soft delete (SPEC § 9.3).
  const columns = db.prepare(`PRAGMA table_info(agents)`).all() as Array<{ name: string }>;
  const has = (name: string) => columns.some((c) => c.name === name);

  if (!has("type")) {
    db.exec(`ALTER TABLE agents ADD COLUMN type TEXT`);
  }
  if (!has("created_at")) {
    // SQLite rejects non-constant defaults in ALTER TABLE ADD COLUMN, so the
    // column arrives nullable and is filled in a second statement.
    db.exec(`ALTER TABLE agents ADD COLUMN created_at DATETIME`);
    db.exec(
      `UPDATE agents SET created_at = COALESCE(last_seen, datetime('now')) WHERE created_at IS NULL`,
    );
  }
  if (!has("deleted_at")) {
    db.exec(`ALTER TABLE agents ADD COLUMN deleted_at DATETIME`);
  }
  if (!has("can_proxy")) {
    // 0.2 entitlement (SPEC § 8.2). Default 0: an identity that has not been
    // given this cannot speak for anyone, which is the safe direction for a
    // column arriving under an existing deployment.
    db.exec(`ALTER TABLE agents ADD COLUMN can_proxy INTEGER NOT NULL DEFAULT 0`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_types (
      type         TEXT PRIMARY KEY,
      description  TEXT,
      requires_key INTEGER NOT NULL DEFAULT 1,
      created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const seed = db.prepare(`
    INSERT OR IGNORE INTO agent_types (type, description, requires_key) VALUES (?, ?, ?)
  `);
  for (const [type, description, requiresKey] of SEEDED_TYPES) {
    seed.run(type, description, requiresKey);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_keys (
      fingerprint TEXT PRIMARY KEY,
      identity    TEXT NOT NULL,
      public_key  TEXT NOT NULL,
      status      TEXT NOT NULL CHECK (status IN ('pending','approved','denied','revoked')),
      proposed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      decided_at  DATETIME,
      decided_by  TEXT
    );
  `);

  // These indexes are the enforcement, not a hint. Application code that also
  // checks is a second chance to get it wrong; the database refusing is not.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_agent_keys_pending
      ON agent_keys(identity) WHERE status = 'pending';
  `);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_agent_keys_approved
      ON agent_keys(identity) WHERE status = 'approved';
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_agent_keys_identity ON agent_keys(identity);
  `);

  // Append-only. A revocation is a matter of record: key rows survive so past
  // signatures stay verifiable, and this is the timeline that lets a verifier
  // judge them by date. `reason` matters — a routine rotation says nothing
  // about earlier signatures, while a compromise casts doubt on the window
  // around it.
  //
  // `superseded` is not in SPEC § 10.2's list of transitions because it is not
  // one an operator performs: it records a pending proposal displaced by a
  // newer one from the same client. Calling that `denied` would have claimed an
  // operator ruled on it, and would have made the key unproposable afterwards.
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_key_events (
      id          TEXT PRIMARY KEY,
      identity    TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      action      TEXT NOT NULL CHECK (action IN ('proposed','approved','denied','revoked','superseded')),
      reason      TEXT,
      actor       TEXT,
      occurred_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_agent_key_events_identity
      ON agent_key_events(identity, occurred_at);
  `);
}

export interface AgentRow {
  identity: string;
  description: string | null;
  last_seen: string | null;
  type: string | null;
  created_at: string | null;
  deleted_at: string | null;
  /**
   * Whether this identity may speak for others (SPEC § 8.2).
   *
   * Held by the http server and, in principle, nothing else. It is a property
   * of the identity rather than of its type because `service` covers both the
   * web gateway and the scheduler, and only one of them has any business
   * claiming to be someone else.
   */
  can_proxy: number;
}

export interface AgentTypeRow {
  type: string;
  description: string | null;
  requires_key: number;
  created_at: string;
}

export type KeyStatus = "pending" | "approved" | "denied" | "revoked";

export interface AgentKeyRow {
  fingerprint: string;
  identity: string;
  public_key: string;
  status: KeyStatus;
  proposed_at: string;
  decided_at: string | null;
  decided_by: string | null;
}

/** Registered types, for validation and for telling a caller what is accepted. */
export function listTypes(db: Database): AgentTypeRow[] {
  return db.prepare(`SELECT * FROM agent_types ORDER BY type`).all() as AgentTypeRow[];
}

export function getType(db: Database, type: string): AgentTypeRow | null {
  return (db.prepare(`SELECT * FROM agent_types WHERE type = ?`).get(type) as AgentTypeRow) ?? null;
}

/**
 * The identity's approved key, if it has one.
 *
 * Read per request rather than cached: caching for a connection's lifetime
 * would make revocation ineffective against sockets already open, which is the
 * one case revocation exists for. It costs ~1.7 µs against ~32 µs for the
 * verification it feeds.
 */
export function approvedKey(db: Database, identity: string): AgentKeyRow | null {
  return (
    (db
      .prepare(`SELECT * FROM agent_keys WHERE identity = ? AND status = 'approved'`)
      .get(identity) as AgentKeyRow) ?? null
  );
}
