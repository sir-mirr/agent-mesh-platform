/**
 * Telling a logged-in operator that an agent is asking to be let in
 * (SPEC § 10.2.1).
 *
 * **The gap this fills.** Registration starts on the agent's side: it calls
 * `POST /api/v1/agents` with a public key, and that key sits `pending` until
 * somebody compares the fingerprint and approves it. Until now the only way to
 * learn a key was waiting was to ask — `GET /api/v1/admin/keys/pending`, on a
 * timer somebody remembered to set. An operator not already looking at that
 * screen had nothing to look at.
 *
 * ## Polled here, pushed to the browser
 *
 * The proposal is written by the **hub**, into `agents.db`. This server holds
 * that file (it owns key approval — § 10.2 puts the decision behind a session
 * the hub cannot authenticate), so the change is visible here without asking
 * the hub for anything.
 *
 * A poll is not the elegant answer and it is the honest one: the alternative is
 * a hub → http notification, which means a second event path between two
 * processes that already share the file the fact lives in. That is a real
 * design worth having when the volume justifies it. A key proposal happens when
 * a human deploys an agent — a handful of times a day — so a one-second read of
 * an indexed table is not the thing to optimise.
 *
 * What matters is that the browser is *pushed to*, because an operator with a
 * dashboard open is the person the whole flow is waiting on.
 *
 * ## Only what an operator needs to decide
 *
 * The fingerprint, the identity, the type, and when it arrived. **No public
 * key material**, because the decision is a comparison against what the agent's
 * own operator reports out of band, and shipping the key to the screen invites
 * comparing it with itself.
 */

import type { Database } from 'bun:sqlite'

export interface KeyProposal {
  identity: string
  fingerprint: string
  type: string | null
  proposed_at: string
}

/** Every proposal awaiting a decision, oldest first. */
export function pendingSince(db: Database): KeyProposal[] {
  return db
    .prepare(
      `SELECT k.identity, k.fingerprint, a.type, k.proposed_at
         FROM agent_keys k
         LEFT JOIN agents a ON a.identity = k.identity
        WHERE k.status = 'pending'
        ORDER BY k.proposed_at ASC, k.fingerprint ASC`,
    )
    .all() as KeyProposal[]
}

/**
 * Watch for new proposals and hand each to `onProposal` once.
 *
 * **Tracked by fingerprint, not by clock.** Two attempts at a timestamp cursor
 * failed here for two different reasons, and both looked healthy: an ISO-8601
 * mark compared against SQLite's `YYYY-MM-DD HH:MM:SS` puts `T` above a space
 * and answers "nothing new" forever, and `datetime('now')` has one-second
 * resolution, so a proposal arriving in the same second as the stream opened is
 * never greater than the mark and is lost for good.
 *
 * A fingerprint is what a proposal *is* — `agent_keys` is keyed on it, and § 10.2
 * decides by it. A set of what has been reported cannot drift from the clock,
 * because it does not consult one.
 *
 * Seeded from what is already pending, so opening a dashboard does not announce
 * a day-old backlog as though it had just arrived. That list goes out once as a
 * snapshot instead.
 */
export function watchProposals(
  db: Database,
  onProposal: (p: KeyProposal) => void,
  intervalMs = 500,
): () => void {
  const reported = new Set<string>(pendingSince(db).map((p) => p.fingerprint))
  const tick = () => {
    try {
      for (const p of pendingSince(db)) {
        if (reported.has(p.fingerprint)) continue
        reported.add(p.fingerprint)
        onProposal(p)
      }
    } catch (err) {
      // A read that fails is a tick that reports nothing, and throwing would
      // take the interval down. **But it is logged**, because the first version
      // swallowed it in silence under a comment saying silence is the failure
      // this file exists to prevent — and then a broken query made the stream
      // look perfectly healthy while pushing nothing.
      console.error(
        `[http-server] key-proposal poll failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  const timer = setInterval(tick, intervalMs)
  return () => clearInterval(timer)
}
