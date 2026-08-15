/**
 * Key approval, behind the admin gate (SPEC § 10.2).
 *
 * **This cannot live on the hub**, and that is the point rather than an
 * accident of layout. The hub has no authentication, so an approval endpoint
 * there would let any caller that can reach the port approve its own proposed
 * key — turning the whole procedure into a formality that grants exactly what
 * it was built to withhold. Approval is the one operation in the key lifecycle
 * that needs to know who is asking, so it runs on the service that knows.
 *
 * It is also why this process holds `agents.db` read-write (§ 3.1) while the
 * hub owns the DDL: http writes decisions into a schema it does not define.
 *
 * **Approving without comparing the fingerprint attests to nothing** (§ 10.2).
 * A lane logs its own fingerprint at startup; the operator's job is to check
 * that the string here is that string. So every response and every listing
 * leads with the fingerprint, and approval is addressed *by* fingerprint rather
 * than by identity — an operator who approves "the pending key for prod-codex1"
 * without naming it approves whatever happens to be pending at that instant,
 * including one that arrived between reading the screen and clicking.
 */

import { openAt, stateDir, STORE_FILES, keys, KeyTransitionError } from '@agent-mesh/store'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'

let _agentsDb: Database | null = null

/**
 * Opened lazily and read-write. The hub creates the schema; this process only
 * ever writes decisions into it, so a missing file means the hub has not
 * started rather than that something needs creating here.
 */
/**
 * The one read-write handle this process holds on `agents.db`.
 *
 * Exported because teardown (§ 9.3) needs it too. A second `openAt` would be a
 * second WAL connection with its own pragmas, and the two would only have to
 * disagree once.
 */
export function agentsDb(): Database {
  if (!_agentsDb) {
    _agentsDb = openAt(join(stateDir(), STORE_FILES.agents), { create: false })
  }
  return _agentsDb
}

export function closeAgentsDb(): void {
  _agentsDb?.close()
  _agentsDb = null
}

export interface KeyDecisionResult {
  status: number
  body: Record<string, unknown>
}

/** Everything awaiting a decision, oldest first. */
export function listPending(): KeyDecisionResult {
  const rows = keys.listPendingKeys(agentsDb())
  return {
    status: 200,
    body: {
      ok: true,
      pending: rows.map((k) => ({
        fingerprint: k.fingerprint,
        identity: k.identity,
        public_key: k.public_key,
        proposed_at: k.proposed_at,
      })),
    },
  }
}

/** One identity's whole key history, for deciding with context rather than blind. */
export function keyHistory(identity: string): KeyDecisionResult {
  const db = agentsDb()
  return {
    status: 200,
    body: {
      ok: true,
      identity,
      key_status: keys.noKeyReason(db, identity),
      keys: keys.listKeys(db, identity),
      events: keys.listKeyEvents(db, identity),
    },
  }
}

type Decision = 'approve' | 'deny' | 'revoke'

/**
 * Apply an operator's decision to one key.
 *
 * `actor` is the admin's login, recorded on the row and in the event. An
 * approval nobody is named for is an approval nobody can be asked about.
 */
export function decide(
  decision: Decision,
  fingerprint: string,
  actor: string,
  reason: string | null,
): KeyDecisionResult {
  const db = agentsDb()
  try {
    let row
    switch (decision) {
      case 'approve':
        row = keys.approveKey(db, fingerprint, actor)
        break
      case 'deny':
        row = keys.denyKey(db, fingerprint, actor, reason)
        break
      case 'revoke':
        // Required, and not for form's sake: a routine `rotation` says nothing
        // about signatures made before it, while `compromise` casts doubt on
        // the whole window preceding it. Only the recorded reason lets a
        // verifier tell those apart afterwards, and by then nobody remembers.
        if (!reason) {
          return {
            status: 400,
            body: { ok: false, error: 'revocation requires a reason (e.g. rotation, compromise)' },
          }
        }
        row = keys.revokeKey(db, fingerprint, actor, reason)
        break
    }
    return {
      status: 200,
      body: {
        ok: true,
        fingerprint: row.fingerprint,
        identity: row.identity,
        status: row.status,
        decided_by: row.decided_by,
        decided_at: row.decided_at,
      },
    }
  } catch (err) {
    if (err instanceof KeyTransitionError) {
      // 404 for a fingerprint that does not exist, 409 for one in the wrong
      // state — an operator acting on a stale listing needs to know which,
      // because one means "you have the wrong string" and the other means
      // "someone got there first".
      return {
        status: err.code === 'not-found' ? 404 : 409,
        body: { ok: false, error: err.message },
      }
    }
    return {
      status: 500,
      body: { ok: false, error: err instanceof Error ? err.message : String(err) },
    }
  }
}
