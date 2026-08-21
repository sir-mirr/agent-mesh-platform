/**
 * Recording that someone read message content (SPEC § 11.0.1).
 *
 * **Its own handle, deliberately.** `audit-query.ts` opens the store
 * `readonly: true` and keeps doing so — the code that serves a query must not
 * be able to shape the record of it. This module opens the same file
 * read-write for one statement and nothing else, so the separation is between
 * two modules with two handles rather than between two processes.
 *
 * That is weaker than a separate writer and is written down as such: a bug in
 * this process can still reach the store. What it does buy is that the query
 * path has no write capability at all, so a change there cannot silently start
 * editing history.
 *
 * ## Failing closed
 *
 * A read that cannot be recorded does not happen. § 15.6 answers the
 * analogous routing question the other way — delivery survives an unwritable
 * audit store — and copying that here would be wrong for a reason that looks
 * like consistency: a delivery failing open loses nothing that was going to be
 * recorded, and an access log failing open loses the only record that the
 * access happened. It also makes an outage indistinguishable from an outage
 * somebody arranged.
 */

import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { checkpointForShutdown, openAt, stateDir, STORE_FILES } from '@agent-mesh/store'

let _db: Database | null = null

function db(): Database {
  if (!_db) _db = openAt(join(stateDir(), STORE_FILES.audit), { create: false })
  return _db
}

export function closeAuditAccessLog(): void {
  if (_db) {
    checkpointForShutdown(_db)
    _db.close()
  }
  _db = null
}

export interface AccessRecord {
  /** Who read. */
  actor: string
  /** `list` or a single event id — what was reached, not what was in it. */
  target: string
  /** The query that selected it, so a later reader can tell scope from intent. */
  query: Record<string, unknown>
}

/**
 * Write the access event.
 *
 * **Throws on failure**, and the caller must let that refuse the read. A
 * `void` return that swallowed the error would be the fail-open this section
 * exists to prevent, arriving as a convenience.
 *
 * The payload records *what was asked for*, never what came back. A log of
 * accesses that quoted the content would be a second copy of the thing being
 * protected.
 */
export function recordContentRead(r: AccessRecord): void {
  const payload = JSON.stringify({
    schema_version: 1,
    event_id: `evt_${Bun.randomUUIDv7()}`,
    event_type: 'mesh.identity.audit_read',
    occurred_at: new Date().toISOString(),
    correlation_id: r.actor,
    identity: r.actor,
    actor: r.actor,
    change: { read: r.target, query: r.query },
  })
  const parsed = JSON.parse(payload)
  db()
    .prepare(
      `INSERT INTO audit_events (
         event_id, schema_version, event_type, occurred_at, correlation_id,
         causation_event_id, producer_id, identity, recorded_by_kind,
         recorded_by_id, payload, payload_digest, attestation
       ) VALUES (?, 1, ?, ?, ?, NULL, NULL, ?, 'http', ?, ?, ?, NULL)`,
    )
    .run(
      parsed.event_id,
      parsed.event_type,
      parsed.occurred_at,
      r.actor,
      r.actor,
      'agent-mesh-http',
      payload,
      createHash('sha256').update(payload, 'utf8').digest('hex'),
    )
}

/** What a caller is told when the read could not be recorded. */
export interface UnrecordableRefusal {
  ok: false
  error: string
  code: 'AUDIT_READ_UNRECORDABLE'
}

/**
 * Record the read, or say why the read must not happen.
 *
 * Returns `null` to proceed and a refusal to send otherwise, so the failing
 * side is a value rather than an exception the caller might forget to catch —
 * which is the whole risk with fail-closed: the closed path is the one nobody
 * exercises.
 *
 * **`record` is injected, with the real writer as its default.** Reaching the
 * refusal otherwise means making the audit store unwritable, and a broken
 * database in a shared test process is carried into whatever file runs next.
 * `ownership.issueCode` takes its randomness the same way and for the same
 * reason: the only caller who ever passes the argument is the one asking what
 * happens in a case production must never be in.
 *
 * **503, not 500.** The request was valid and the deployment is degraded, so a
 * caller that retries once the store recovers gets its answer.
 */
export function recordContentReadOrRefuse(
  r: AccessRecord,
  record: (r: AccessRecord) => void = recordContentRead,
): UnrecordableRefusal | null {
  try {
    record(r)
    return null
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[http-server] refusing a content read: could not record it (${message})`)
    return {
      ok: false,
      error: 'content reads are recorded, and the record could not be written',
      code: 'AUDIT_READ_UNRECORDABLE',
    }
  }
}
