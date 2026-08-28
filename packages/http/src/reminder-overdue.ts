/**
 * The overdue-reminder decision an operator could not make (SPEC § 3.3, D-810).
 *
 * `ReminderScheduler` holds a `once` reminder that is more than
 * `overdueHoldMs` past its slot: the moment it was for has passed, there is no
 * later slot to move it to, and delivering it late may be worse than dropping
 * it — so a person decides. `recordOverdueDecision` writes that decision and
 * the scheduler reads it on the next scan.
 *
 * Nothing called it. The daemon has no HTTP surface, so a held reminder waited
 * with no way to release it short of editing SQLite, and — because a held
 * reminder is silent — "nothing is held" and "something is held and nobody can
 * see it" were the same view.
 *
 * ## What "held" means here
 *
 * **Read from the daemon's own record, not recomputed.** The obvious
 * implementation asks `reminders` for `once` rows whose `next_fire_at` is more
 * than some threshold in the past — and that threshold is the daemon's
 * `overdueHoldMs`, configured by `AGENT_MESH_*` env in a different process.
 * Copying it here makes two answers to "is this held?" that drift the moment
 * either side is reconfigured, and the operator screen would then list rows the
 * scheduler is still happy to fire, or miss ones it is holding.
 *
 * The scheduler writes `overdue_hold:<id>:<slot>` into `scheduler_health` when
 * it holds, so that key **is** the fact. This reads it.
 *
 * ## Two handles
 *
 * The query opens read-only and the decision opens read-write for one
 * statement, the same split `audit-access-log.ts` uses and for the same reason:
 * the code that serves a list must not be able to change what it lists.
 */

import type { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { checkpointForShutdown, openAt, stateDir, STORE_FILES } from '@agent-mesh/store'

let _read: Database | null = null
let _write: Database | null = null

const path = () => join(stateDir(), STORE_FILES.selfReminder)

/**
 * Whether the scheduler's store exists at all.
 *
 * **A missing file is a true empty, and an unreadable one is not.** The hub
 * creates `self-reminder.db` on the first `mesh.schedule_reminder`, so on a
 * deployment where nobody has scheduled anything the file is simply absent —
 * and *nothing has ever been scheduled* does mean *nothing is held*. Opening
 * with `create: false` threw `SQLITE_CANTOPEN` there, which a route would have
 * turned into a 500 on the one screen whose job is to say whether anything is
 * waiting.
 *
 * Narrow on purpose: only absence answers empty. A file that exists and cannot
 * be read still throws, because that is not the same fact and must not be
 * reported as a quiet mesh.
 */
function storeExists(): boolean {
  return existsSync(path())
}

function readDb(): Database {
  if (!_read) _read = openAt(path(), { create: false, readonly: true })
  return _read
}

function writeDb(): Database {
  if (!_write) _write = openAt(path(), { create: false })
  return _write
}

export function closeReminderOverdue(): void {
  if (_read) _read.close()
  if (_write) {
    checkpointForShutdown(_write)
    _write.close()
  }
  _read = null
  _write = null
}

/** One held slot, as an operator has to see it to decide. */
export interface HeldOverdue {
  reminder_id: string
  agent_id: string
  /** The slot the fire was for. Part of the key: a decision belongs to one fire. */
  scheduled_at: string
  /** When the scheduler recorded the hold, ISO-8601. */
  held_since: string
  /** How late the slot already was when it was held, in milliseconds. */
  overdue_ms: number | null
  /** The reminder's current status, so a screen can say if it moved on. */
  status: string | null
}

const HOLD_PREFIX = 'overdue_hold:'

/** SQLite's `datetime` shape as an instant. Returns null for anything else. */
function asDate(value: string | null | undefined): Date | null {
  if (!value) return null
  const parsed = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function iso(value: string | null | undefined): string | null {
  const d = asDate(value)
  return d ? d.toISOString() : null
}

/**
 * Every slot the scheduler is holding and nobody has decided.
 *
 * A decided slot leaves the list because the scheduler will act on it: `replay`
 * releases it on the next scan, `skip` keeps it held forever on purpose. Both
 * are answered, so neither is still a question.
 */
export function listHeldOverdue(): HeldOverdue[] {
  if (!storeExists()) return []
  const db = readDb()
  const holds = db
    .prepare(`SELECT key, value FROM scheduler_health WHERE key LIKE ? ORDER BY value ASC`)
    .all(`${HOLD_PREFIX}%`) as Array<{ key: string; value: string }>

  const out: HeldOverdue[] = []
  for (const hold of holds) {
    // `overdue_hold:<reminder id>:<slot>`, split on the slot's **shape** rather
    // than on a colon.
    //
    // This read `lastIndexOf(':')` first, on the stated reasoning that the slot
    // has no colon — which is false twice over: `HH:MM:SS` has two. The cut
    // landed inside the time, so the id came back as `r-visible:2026-07-14 09:00`
    // and the slot as `00`, which `new Date` then read as the year 2000. Nothing
    // threw; the route answered a list of plausible rows about nothing.
    //
    // The greedy prefix with an anchored tail is what makes an id containing a
    // colon safe, which was the real case the first version was reaching for.
    const rest = hold.key.slice(HOLD_PREFIX.length)
    const parsed = /^(.*):(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)$/.exec(rest)
    if (!parsed) continue
    const reminderId = parsed[1]!
    const scheduledAt = parsed[2]!

    const decided = db
      .prepare(`SELECT 1 FROM overdue_decisions WHERE reminder_id = ? AND scheduled_at = ?`)
      .get(reminderId, scheduledAt)
    if (decided) continue

    const reminder = db
      .prepare(`SELECT agent_id, status FROM reminders WHERE id = ?`)
      .get(reminderId) as { agent_id?: string; status?: string } | undefined

    const heldAt = asDate(hold.value)
    const slot = asDate(scheduledAt)
    out.push({
      reminder_id: reminderId,
      // A hold whose reminder row is gone is still worth listing: it is the
      // case an operator most needs to see, and dropping it would answer
      // "nothing held" for a mesh that is holding something.
      agent_id: reminder?.agent_id ?? '',
      scheduled_at: iso(scheduledAt) ?? scheduledAt,
      held_since: iso(hold.value) ?? hold.value,
      overdue_ms: heldAt && slot ? heldAt.getTime() - slot.getTime() : null,
      status: reminder?.status ?? null,
    })
  }
  return out
}

export type OverdueDecision = 'replay' | 'skip'

/** What a caller is told when the decision cannot be recorded as asked. */
export interface OverdueRefusal {
  ok: false
  error: string
  code: 'INVALID_DECISION' | 'NO_SUCH_HOLD' | 'EMPTY_APPROVAL_REF'
}

export interface OverdueDecisionRecorded {
  ok: true
  reminder_id: string
  scheduled_at: string
  decision: OverdueDecision
  approval_ref: string
  decided_by: string
  decided_at: string
}

/**
 * Record one decision, or say why it was not recorded.
 *
 * **`approval_ref` is required in substance, free in form** (D-810). A product
 * with no ticket system gains nothing from a format rule except the appearance
 * of one, so `APPROVED:x` is a valid reference — the discipline comes from the
 * string being drawn beside the decision and the decider forever, not from its
 * shape. What is refused is a reference with nothing after the prefix: that is
 * not a loose standard, it is an absent answer wearing the shape of one.
 *
 * The prefix itself is the scheduler's rule (`overdueApprovalPrefix`), checked
 * there. This adds the emptiness check the scheduler does not make, and keeps
 * the prefix constant in one place by letting the scheduler's own error
 * surface.
 */
export function recordOverdueDecision(
  reminderId: string,
  scheduledAt: string,
  decision: OverdueDecision,
  approvalRef: string,
  decidedBy: string,
  prefix = 'APPROVED:',
): OverdueDecisionRecorded | OverdueRefusal {
  if (decision !== 'replay' && decision !== 'skip') {
    return { ok: false, code: 'INVALID_DECISION', error: `decision must be "replay" or "skip"` }
  }
  if (typeof approvalRef !== 'string' || !approvalRef.startsWith(prefix)) {
    return { ok: false, code: 'EMPTY_APPROVAL_REF', error: `approval_ref must start with "${prefix}"` }
  }
  if (approvalRef.slice(prefix.length).trim() === '') {
    return {
      ok: false,
      code: 'EMPTY_APPROVAL_REF',
      error: `approval_ref must say what the decision rests on, not just "${prefix}"`,
    }
  }

  // The hold must exist. Deciding a slot nobody is holding writes a row the
  // scheduler will never read, and answering `ok` to it tells an operator a
  // reminder was released when nothing was.
  const held = storeExists()
    ? readDb()
        .prepare(`SELECT 1 FROM scheduler_health WHERE key = ?`)
        .get(`${HOLD_PREFIX}${reminderId}:${scheduledAt}`)
    : null
  if (!held) {
    return {
      ok: false,
      code: 'NO_SUCH_HOLD',
      error: `no held slot ${scheduledAt} for reminder ${reminderId}`,
    }
  }

  const decidedAt = new Date().toISOString()
  writeDb()
    .prepare(
      `INSERT INTO overdue_decisions (reminder_id, scheduled_at, decision, approval_ref, decided_at, decided_by)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(reminder_id, scheduled_at) DO UPDATE SET
         decision = excluded.decision, approval_ref = excluded.approval_ref,
         decided_at = excluded.decided_at, decided_by = excluded.decided_by`,
    )
    .run(reminderId, scheduledAt, decision, approvalRef, decidedAt, decidedBy)

  return {
    ok: true,
    reminder_id: reminderId,
    scheduled_at: iso(scheduledAt) ?? scheduledAt,
    decision,
    approval_ref: approvalRef,
    decided_by: decidedBy,
    decided_at: decidedAt,
  }
}

/** Every decision made, newest first — the persistent record D-810 asks a screen to draw. */
export function listOverdueDecisions(limit = 200): Array<{
  reminder_id: string
  scheduled_at: string
  decision: string
  approval_ref: string
  decided_at: string
  decided_by: string | null
}> {
  if (!storeExists()) return []
  return (
    readDb()
      .prepare(
        `SELECT reminder_id, scheduled_at, decision, approval_ref, decided_at, decided_by
           FROM overdue_decisions ORDER BY decided_at DESC LIMIT ?`,
      )
      .all(limit) as Array<Record<string, any>>
  ).map((row) => ({
    reminder_id: String(row.reminder_id),
    scheduled_at: iso(row.scheduled_at) ?? String(row.scheduled_at),
    decision: String(row.decision),
    approval_ref: String(row.approval_ref),
    decided_at: iso(row.decided_at) ?? String(row.decided_at),
    // Null for a row written before D-810 added the column. Not backfilled:
    // naming anybody would put a person against a decision they did not make.
    decided_by: row.decided_by === null || row.decided_by === undefined ? null : String(row.decided_by),
  }))
}
