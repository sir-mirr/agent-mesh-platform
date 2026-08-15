/**
 * The audit query API (SPEC § 9.1).
 *
 * Read-only, on the http server because that is where the admin session lives.
 * The hub writes `audit.db`; this holds a read-only handle and declares nothing
 * about the schema — `@agent-mesh/store` states it once, which is the whole
 * reason that package exists.
 *
 * **Paginated by `(stored_at, event_id)` ascending**, and the composite matters.
 * `stored_at` alone is not unique: two events stored in the same millisecond
 * would give a cursor no way to say which it had already returned, so a page
 * boundary landing between them either skips one or repeats it. The event id
 * breaks the tie, and the index is on the same pair so the ordering the cursor
 * assumes is the ordering the query produces.
 *
 * Ascending rather than newest-first because a cursor over a growing table has
 * to be stable under concurrent writes. Descending from "now" shifts every
 * offset each time a row lands; ascending from a fixed point does not — new
 * rows arrive after the cursor, where a reader will reach them in order.
 */

import { openAt, stateDir, STORE_FILES } from '@agent-mesh/store'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'

let _auditDb: Database | null = null

function auditDb(): Database {
  if (!_auditDb) {
    _auditDb = openAt(join(stateDir(), STORE_FILES.audit), { readonly: true })
  }
  return _auditDb
}

export function closeAuditDb(): void {
  _auditDb?.close()
  _auditDb = null
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

export interface QueryResult {
  status: number
  body: Record<string, unknown>
}

/**
 * Fields never returned, whatever a caller asks for (SPEC § 9.1).
 *
 * The payload is stored verbatim so its digest stays checkable, which means the
 * store may hold whatever a client put there. Redaction therefore happens on
 * the way out rather than on the way in — the alternative would break the
 * digest and with it the attestation.
 */
const REDACTED_KEYS = new Set([
  'authorization',
  'private_key',
  'privatekey',
  'secret',
  'token',
  'access_token',
  'refresh_token',
  'api_key',
  'apikey',
  'password',
  'reasoning',
  'reasoning_stream',
])

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = REDACTED_KEYS.has(k.toLowerCase()) ? '[redacted]' : redact(v)
    }
    return out
  }
  return value
}

interface EventRow {
  event_id: string
  schema_version: number
  event_type: string
  occurred_at: string
  correlation_id: string | null
  causation_event_id: string | null
  producer_id: string | null
  identity: string
  recorded_by_kind: string
  recorded_by_id: string | null
  payload: string
  payload_digest: string
  attestation: string | null
  stored_at: string
}

function shape(row: EventRow, blobs: unknown[]): Record<string, unknown> {
  let payload: unknown
  try {
    payload = redact(JSON.parse(row.payload))
  } catch {
    payload = null
  }
  return {
    event_id: row.event_id,
    schema_version: row.schema_version,
    event_type: row.event_type,
    occurred_at: row.occurred_at,
    correlation_id: row.correlation_id,
    causation_event_id: row.causation_event_id,
    producer_id: row.producer_id,
    identity: row.identity,
    recorded_by: { kind: row.recorded_by_kind, id: row.recorded_by_id },
    payload,
    payload_digest: row.payload_digest,
    // Returned so a reader can check the signature themselves. That is the
    // point of keeping it: an audit record nobody can verify is a log.
    attestation: row.attestation ? JSON.parse(row.attestation) : null,
    stored_at: row.stored_at,
    attachments: blobs,
  }
}

function attachmentsOf(eventId: string): unknown[] {
  return auditDb()
    .prepare(`SELECT blob_key, sha256, size, name FROM audit_event_blobs WHERE event_id = ?`)
    .all(eventId)
}

export function getEvent(eventId: string): QueryResult {
  const row = auditDb()
    .prepare(`SELECT * FROM audit_events WHERE event_id = ?`)
    .get(eventId) as EventRow | undefined
  if (!row) return { status: 404, body: { ok: false, error: `no event '${eventId}'` } }
  return { status: 200, body: { ok: true, event: shape(row, attachmentsOf(eventId)) } }
}

export interface ListQuery {
  identity?: string
  provider?: string
  correlation_id?: string
  from?: string
  to?: string
  cursor?: string
  limit?: string
}

/**
 * The cursor is `<stored_at>|<event_id>` — the ordering key itself, not an
 * offset. An offset would shift under concurrent appends and hand the reader
 * a page it had already seen, or skip one it had not.
 */
function parseCursor(cursor: string): { storedAt: string; eventId: string } | null {
  const at = cursor.indexOf('|')
  if (at <= 0) return null
  return { storedAt: cursor.slice(0, at), eventId: cursor.slice(at + 1) }
}

export function listEvents(q: ListQuery): QueryResult {
  const limit = Math.min(Math.max(Number(q.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1), MAX_LIMIT)

  const where: string[] = []
  const args: unknown[] = []

  if (q.identity) {
    where.push('identity = ?')
    args.push(q.identity)
  }
  // `provider` is the producing component. `recorded_by_id` carries it for
  // adapter-reported events; hub-recorded ones have none, which is the
  // distinction § 8.9.4 made a field rather than a prefix match.
  if (q.provider) {
    where.push('recorded_by_id = ?')
    args.push(q.provider)
  }
  if (q.correlation_id) {
    where.push('correlation_id = ?')
    args.push(q.correlation_id)
  }
  if (q.from) {
    where.push('stored_at >= ?')
    args.push(q.from)
  }
  if (q.to) {
    where.push('stored_at <= ?')
    args.push(q.to)
  }

  if (q.cursor) {
    const c = parseCursor(q.cursor)
    if (!c) return { status: 400, body: { ok: false, error: 'malformed cursor' } }
    // Strictly after the cursor in the composite ordering. The row-value
    // comparison is what makes the tie-break correct: comparing stored_at alone
    // would re-emit every event sharing the boundary timestamp.
    where.push('(stored_at, event_id) > (?, ?)')
    args.push(c.storedAt, c.eventId)
  }

  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  // One row over the limit, to say whether another page exists without a second
  // count query that could disagree with this one under concurrent writes.
  const rows = auditDb()
    .prepare(
      `SELECT * FROM audit_events ${clause} ORDER BY stored_at ASC, event_id ASC LIMIT ?`,
    )
    .all(...(args as any[]), limit + 1) as EventRow[]

  const page = rows.slice(0, limit)
  const last = page[page.length - 1]

  return {
    status: 200,
    body: {
      ok: true,
      events: page.map((r) => shape(r, attachmentsOf(r.event_id))),
      next_cursor: rows.length > limit && last ? `${last.stored_at}|${last.event_id}` : null,
    },
  }
}
