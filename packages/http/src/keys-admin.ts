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

import { checkpointForShutdown, openAt, stateDir, STORE_FILES, keys, KeyTransitionError } from '@agent-mesh/store'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'

import { admitRegistryAgent, isRegistryAgentApproved } from './db'

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
  if (_agentsDb) {
    checkpointForShutdown(_agentsDb)
    _agentsDb.close()
  }
  _agentsDb = null
}

export interface KeyDecisionResult {
  status: number
  body: Record<string, unknown>
}

/**
 * Everything awaiting a decision, oldest first.
 *
 * **`keys`, not `pending`.** Two decision queues answer on this server — key
 * proposals here, people awaiting admission on `/api/v1/admin/pending` — and
 * both used to answer `{ pending: [...] }`. A caller asking "is anything
 * waiting" could reach for either, receive an honest empty array, and be
 * reading the answer to the other question. `agent-mesh-local-pm` found the
 * pair by counting routes that share a last segment.
 *
 * Moved in three steps rather than one, because the route is here and its
 * consumer is the front end: they taught the bell to read `keys` first while
 * nothing sent it, this is the move, and they drop the old branch after. The
 * middle step is the only one that can break anything, and it cannot break the
 * bell because the first step already landed.
 */
export function listPending(): KeyDecisionResult {
  const rows = keys.listPendingKeys(agentsDb())
  return {
    status: 200,
    body: {
      ok: true,
      keys: rows.map((k) => ({
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
 * Put an approved identity on this server's own list (D-747).
 *
 * The description and type come from the mesh's row, because that is where an
 * operator wrote them when the identity was provisioned (§ 10.1) and this
 * server has no other account of what an agent is. A torn-down identity is not
 * admitted: § 9.3's delete is a `deleted_at` stamp, and admitting past it would
 * put a destroyed name back on the screen.
 */
export function admitApprovedIdentity(identity: string, db: Database = agentsDb()): void {
  const row = db
    .prepare(`SELECT description, type FROM agents WHERE identity = ? AND deleted_at IS NULL`)
    .get(identity) as { description: string | null; type: string | null } | undefined
  if (!row) return
  admitRegistryAgent({ id: identity, description: row.description, type: row.type })
}

/**
 * Admit every identity whose key an operator already approved (T-026, D-747).
 *
 * **The rule applied backwards, not a new decision.** D-747 says approving a
 * key admits its identity, and the approvals that happened before that landed
 * were the same operator act — they compared a fingerprint and said this
 * identity is one the console deals with. What is missing is only the row the
 * rule now writes, so the identities approved on Tuesday are addressable and
 * the ones approved on Monday answer `404` from `POST /api/v1/messages`. That
 * difference is a date, and nothing an operator can see or fix.
 *
 * `soak-claude` is the live case: connected, approved, on the mesh, and absent
 * from this server's list.
 *
 * **Not "every identity the hub knows".** That was the thing D-747 refused to
 * decide by fiat, and the reason is unchanged: a route that adds any hub
 * identity has to say *whose* registry. An approved key is the operator's
 * decision, already made and recorded, which is why this can run without one.
 *
 * A torn-down identity is not admitted — `admitApprovedIdentity` reads
 * `deleted_at IS NULL`, so § 9.3's soft delete survives the backfill rather
 * than being undone by it.
 *
 * Returns how many rows it wrote, so the caller logs what happened rather than
 * that something did.
 */
export function admitApprovedIdentities(
  db: Database = agentsDb(),
  admit: (identity: string, db?: Database) => void = admitApprovedIdentity,
): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT k.identity
         FROM agent_keys k
         JOIN agents a ON a.identity = k.identity
        WHERE k.status = 'approved' AND a.deleted_at IS NULL
        ORDER BY k.identity`,
    )
    .all() as Array<{ identity: string }>

  const admitted: string[] = []
  for (const { identity } of rows) {
    if (isRegistryAgentApproved(identity)) continue
    admit(identity, db)
    admitted.push(identity)
  }
  return admitted
}

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
  db: Database = agentsDb(),
  /** D-747. A parameter so the admission can be watched without a second store. */
  admit: (identity: string, db?: Database) => void = admitApprovedIdentity,
): KeyDecisionResult {
  try {
    let row
    switch (decision) {
      case 'approve':
        row = keys.approveKey(db, fingerprint, actor)
        // **Approval is admission** (D-747). After the key transition, so an
        // approval that could not be applied admits nobody.
        admit(row.identity, db)
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
