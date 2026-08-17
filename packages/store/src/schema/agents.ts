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
/**
 * Seeded idempotently at every hub boot (SPEC § 10.3), and **informative** —
 * a deployment extends the table through the admin surface without touching
 * this list.
 *
 * Removing an entry here is what makes a removal durable. `INSERT OR IGNORE`
 * runs on every start, so a type deleted through the API alone comes back the
 * next time the hub restarts, and the operator who deleted it is not watching
 * when it does.
 *
 * `ai-antigravity` names the **runtime that attaches**, not the model behind
 * it. `agy` is what a lane actually runs; which model it calls is not
 * something this deployment observes, and the audit record should not claim
 * it does.
 */
const SEEDED_TYPES: ReadonlyArray<[type: string, description: string, requiresKey: 0 | 1]> = [
  ["ai-claude", "Claude runtime", 1],
  ["ai-codex", "Codex runtime", 1],
  ["ai-antigravity", "Antigravity (agy) CLI runtime", 1],
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

  // Where each identity has been observed connecting from (SPEC § 8.11).
  //
  // One row per (identity, source) rather than one per request: the interesting
  // question is "which addresses has this key been used from", and a row per
  // request answers it while growing without bound. The counter and the two
  // timestamps keep the history an operator actually needs — when a source
  // first appeared and whether it is still in use.
  //
  // Recorded for every authenticated request, not only after dormancy. The
  // observation costs nothing, so an address change on a busy identity is in
  // the record even where policy does not refuse it — an operator looking
  // afterwards gets a history instead of a gap.
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_sources (
      identity   TEXT NOT NULL,
      observed   TEXT NOT NULL,
      first_seen DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      requests   INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (identity, observed)
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_agent_sources_last_seen
      ON agent_sources(identity, last_seen DESC);
  `);

  // When this identity last *sent* (SPEC § 8.11.2). Its own column rather than
  // `MAX(ts) FROM messages`: § 15.6 rotates that table, so an identity whose
  // sends aged out would read as never having sent — indistinguishable from
  // dormant, and challenged for ever.
  for (const [column, type] of [["last_send_at", "DATETIME"]] as const) {
    const has = (db.prepare(`PRAGMA table_info(agents)`).all() as Array<{ name: string }>)
      .some((c) => c.name === column);
    if (!has) db.exec(`ALTER TABLE agents ADD COLUMN ${column} ${type}`);
  }

  // Upload grants (SPEC § 8.9.2, § 9.1). Here rather than in `audit.db`
  // because the http server needs them to authorise a PUT, and it holds this
  // file read-write already for key approval — an upload must not require it
  // to open the audit store as well.
  //
  // Bound to (identity, blob_key, size), and deliberately **not single-use**.
  // A replayed grant authorises the identical bytes under the identical key,
  // which deduplicates to no effect; making it single-use would instead break
  // the retry of an upload that failed midway, which is the common case.
  db.exec(`
    CREATE TABLE IF NOT EXISTS upload_nonces (
      nonce      TEXT PRIMARY KEY,
      identity   TEXT NOT NULL,
      blob_key   TEXT NOT NULL,
      size       INTEGER NOT NULL,
      sha256     TEXT NOT NULL,
      issued_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_upload_nonces_expiry ON upload_nonces(expires_at);
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

/**
 * Add a type (SPEC § 10.3). Create-only.
 *
 * Refuses an existing type rather than updating it, because the field worth
 * updating is `requires_key` and lowering it retroactively lets every identity
 * of that type connect without a key (§ 8.1) — a change that would silently
 * disarm the signing requirement for identities provisioned long before. A
 * deployment that means it does it deliberately and out of band.
 *
 * Returns null when the type already exists.
 */
export function addType(
  db: Database,
  type: string,
  description: string | null,
  requiresKey: 0 | 1,
): AgentTypeRow | null {
  const result = db
    .prepare(
      `INSERT INTO agent_types (type, description, requires_key) VALUES (?, ?, ?)
       ON CONFLICT(type) DO NOTHING`,
    )
    .run(type, description, requiresKey);
  // `changes` is the answer, not a preceding read: two operators adding the
  // same type would both see it absent and both believe they created it.
  if (result.changes === 0) return null;
  return getType(db, type);
}

/** Identities carrying a type, soft-deleted ones included. */
export function identitiesOfType(db: Database, type: string): string[] {
  return (db.prepare(`SELECT identity FROM agents WHERE type = ?`).all(type) as Array<{ identity: string }>)
    .map((r) => r.identity);
}

/**
 * Remove a type (SPEC § 10.3).
 *
 * Refuses while any identity carries it — **including soft-deleted ones**. A
 * torn-down identity keeps its row so its past signatures stay interpretable
 * (§ 9.3), and that row names a type; dropping the type would leave the
 * classification dangling on a record the audit trail still points at.
 */
export function removeType(db: Database, type: string): { removed: boolean; inUseBy: string[] } {
  const inUseBy = identitiesOfType(db, type);
  if (inUseBy.length > 0) return { removed: false, inUseBy };
  const result = db.prepare(`DELETE FROM agent_types WHERE type = ?`).run(type);
  return { removed: result.changes > 0, inUseBy: [] };
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
