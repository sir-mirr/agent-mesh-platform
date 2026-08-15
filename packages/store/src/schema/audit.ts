/**
 * `audit.db` — the audit record (SPEC § 8.9).
 *
 * **One file**, and that is the load-bearing decision. An event and its
 * attachment references must commit together: SQLite does not guarantee atomic
 * commit across attached databases in WAL mode, so splitting them would leave a
 * window where an event exists without its references or the reverse. Both are
 * corruption of the record.
 *
 * Separate from `hub.db` for the opposite reason — lifetime. Messages are
 * operational and short-lived; audit is kept indefinitely, and a file that
 * grows forever must not be the file message routing needs to write. On a
 * separate volume, audit filling the disk stops audit rather than the mesh.
 *
 * Written by the hub, read by the http server for the query API (§ 9.1).
 */

import type { Database } from "bun:sqlite";

export function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_events (
      event_id           TEXT PRIMARY KEY,
      schema_version     INTEGER NOT NULL,
      event_type         TEXT NOT NULL,
      occurred_at        TEXT NOT NULL,
      correlation_id     TEXT,
      causation_event_id TEXT,
      producer_id        TEXT,
      identity           TEXT NOT NULL,
      recorded_by_kind   TEXT NOT NULL,
      recorded_by_id     TEXT,
      payload            TEXT NOT NULL,
      payload_digest     TEXT NOT NULL,
      attestation        TEXT,
      stored_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);

  // The query API pages by (stored_at, event_id) ascending (§ 9.1). A cursor
  // over an index that does not match its ordering skips or repeats rows when
  // something is appended mid-page, which is the one thing pagination must not
  // do under concurrent writes.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_audit_events_stored
      ON audit_events(stored_at, event_id);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_audit_events_identity
      ON audit_events(identity, stored_at);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_audit_events_correlation
      ON audit_events(correlation_id, stored_at);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_audit_events_type
      ON audit_events(event_type, stored_at);
  `);

  // References, not bytes. Content addressing keeps one file however many
  // events point at it, so retention of the record and of the attachments are
  // separate questions.
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_event_blobs (
      event_id TEXT NOT NULL,
      blob_key TEXT NOT NULL,
      sha256   TEXT NOT NULL,
      size     INTEGER NOT NULL,
      name     TEXT,
      PRIMARY KEY (event_id, blob_key)
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_audit_event_blobs_key
      ON audit_event_blobs(blob_key);
  `);
}

export interface AuditEventRow {
  event_id: string;
  schema_version: number;
  event_type: string;
  occurred_at: string;
  correlation_id: string | null;
  causation_event_id: string | null;
  producer_id: string | null;
  /** Derived from the authenticated connection, never from the payload. */
  identity: string;
  /** `hub` for events the hub observed, `adapter` for reported ones. */
  recorded_by_kind: string;
  recorded_by_id: string | null;
  /** The received `params` bytes, verbatim. */
  payload: string;
  payload_digest: string;
  /** The request signature that authenticated the append, as JSON. */
  attestation: string | null;
  stored_at: string;
}

export interface AuditEventBlobRow {
  event_id: string;
  blob_key: string;
  sha256: string;
  size: number;
  name: string | null;
}
