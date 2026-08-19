/**
 * Reminder RPCs (SPEC § 8.5–8.7).
 *
 * The hub writes the self-reminder daemon's database directly rather than
 * proxying to it: the daemon may be down when a reminder is scheduled, and a
 * row written now is one the daemon picks up when it returns.
 *
 * Every statement here is owner-scoped by `agent_id = <caller identity>`. A
 * caller cannot read, cancel or list another identity's reminders.
 */

import { parseScheduleSpec } from "@agent-mesh/contracts";

import { srDb } from "../db";
import { INVALID_PARAMS, INVALID_REQUEST, SERVER_ERROR, rpcError, rpcResult } from "../jsonrpc";
import { wsIdentities } from "../presence";

export function handleScheduleReminder(
  ws: any,
  params: Record<string, any>,
  id: string | number | null | undefined
): string {
  const agent_id = wsIdentities.get(ws);
  if (!agent_id) return rpcError(id, INVALID_REQUEST, "not registered");

  const { id: remId, type, schedule_spec, payload, context, idempotency_key, next_fire_at } = params;
  if (!remId || !type || !schedule_spec || !payload || !next_fire_at) {
    return rpcError(id, INVALID_PARAMS, "missing required: id/type/schedule_spec/payload/next_fire_at");
  }

  // Refused here rather than at fire time. A spec the daemon cannot read leaves
  // a row that looks scheduled and never fires — and the caller finds out by
  // the reminder not arriving, which is the one signal it cannot distinguish
  // from the reminder having arrived and been missed.
  const schedule = parseScheduleSpec(String(type), String(schedule_spec));
  if (!schedule.ok) {
    return rpcError(id, INVALID_PARAMS, `schedule_spec: ${schedule.reason}`);
  }

  /**
   * Stored in the form the scheduler compares against, not the form § 8.5
   * states.
   *
   * § 8.5 says `next_fire_at` is ISO-8601 and this used to store exactly what
   * arrived. The scheduler selects due rows with
   * `next_fire_at <= sqliteTime(now)` — `YYYY-MM-DD HH:MM:SS` — and the
   * comparison is on strings, so an ISO timestamp never sorts as due: `T` is
   * `0x54` and the space is `0x20`. **A caller following the contract got
   * `{ok: true}`, a stored row, and a reminder that never fired.**
   *
   * Measured rather than reasoned: the same test passed in 522ms with a
   * space-separated timestamp and timed out at thirty seconds with the ISO one,
   * with nothing else changed.
   *
   * Nothing caught it because the two sides were tested apart —
   * `scheduler.test.ts` writes its own rows in the store's format, and
   * `reminders.test.ts` schedules in ISO and never runs a scheduler. Every
   * example in this repository used the form that does not work.
   *
   * Normalised here rather than compared loosely there: the column is a
   * `DATETIME` and every other writer already uses this form, so the boundary
   * is where the two vocabularies meet.
   */
  const fireAt = new Date(String(next_fire_at));
  if (Number.isNaN(fireAt.getTime())) {
    return rpcError(id, INVALID_PARAMS, `next_fire_at: not a timestamp`);
  }
  const storedFireAt = fireAt.toISOString().replace("T", " ").slice(0, 19);

  try {
    srDb()
      .prepare(
        `INSERT INTO reminders
           (id, agent_id, type, schedule_spec, payload, context, idempotency_key,
            status, next_fire_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
      )
      .run(
        remId,
        agent_id,
        type,
        schedule_spec,
        payload,
        context ?? null,
        idempotency_key ?? null,
        storedFireAt,
        agent_id
      );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("UNIQUE") || msg.includes("idx_reminders_idem_active")) {
      return rpcResult(id, { ok: false, error: "dedup", idempotency_key: idempotency_key });
    }
    return rpcError(id, -32000, `db error: ${msg}`);
  }
  return rpcResult(id, { ok: true, id: remId, type, next_fire_at });
}

export function handleCancelReminder(
  ws: any,
  params: Record<string, any>,
  id: string | number | null | undefined
): string {
  const agent_id = wsIdentities.get(ws);
  if (!agent_id) return rpcError(id, INVALID_REQUEST, "not registered");

  const remId = params.id;
  if (!remId) return rpcError(id, INVALID_PARAMS, "id required");

  const res = srDb()
    .prepare(
      `UPDATE reminders SET status = 'cancelled', updated_at = datetime('now')
       WHERE id = ? AND agent_id = ? AND status IN ('active','paused')`
    )
    .run(remId, agent_id);

  return rpcResult(id, { changes: (res as any).changes });
}

export function handleListReminders(
  ws: any,
  params: Record<string, any>,
  id: string | number | null | undefined
): string {
  const agent_id = wsIdentities.get(ws);
  if (!agent_id) return rpcError(id, INVALID_REQUEST, "not registered");

  const status = ((params.status as string) ?? "active").toLowerCase();
  const limit = Math.min(Math.max(Number(params.limit ?? 50), 1), 200);

  const rows =
    status === "all"
      ? srDb()
          .prepare(
            `SELECT id, type, status, schedule_spec, payload, context, next_fire_at,
                    fire_count, last_fired_at, idempotency_key, created_at
               FROM reminders WHERE agent_id = ?
              ORDER BY COALESCE(next_fire_at, last_fired_at, created_at) DESC LIMIT ?`
          )
          .all(agent_id, limit)
      : srDb()
          .prepare(
            `SELECT id, type, status, schedule_spec, payload, context, next_fire_at,
                    fire_count, last_fired_at, idempotency_key, created_at
               FROM reminders WHERE agent_id = ? AND status = ?
              ORDER BY COALESCE(next_fire_at, last_fired_at, created_at) DESC LIMIT ?`
          )
          .all(agent_id, status, limit);

  /**
   * Whether each row is waiting on a person, rather than waiting on its time.
   *
   * **Both look like `active`.** A `once` reminder more than `overdueHoldMs`
   * late is held for an operator decision (`scheduler.ts:284`) and its row stays
   * `active` with a `next_fire_at` receding further into the past on every scan.
   * So a caller listing its reminders sees the same thing for one that is about
   * to fire and one that never will, and § 8.5 gives it no way to tell — the
   * shape this repository has spent the week removing from screens, in an RPC
   * response.
   *
   * Additive rather than a new `status`: existing consumers read `status` and a
   * value they have never seen would change what they do. `held_since` is
   * absent on every row that is simply scheduled, so the two are distinguishable
   * without either becoming the other.
   *
   * The hold lives in the daemon's own `scheduler_health` keys and is read here
   * rather than mirrored, because a copy of it in `reminders` would be a second
   * declaration of the same fact — and the daemon is the only writer.
   */
  const heldSince = (row: { id?: unknown; next_fire_at?: unknown }): string | null => {
    if (typeof row.id !== "string" || typeof row.next_fire_at !== "string") return null;
    try {
      const held = srDb()
        .prepare(`SELECT value FROM scheduler_health WHERE key = ?`)
        .get(`overdue_hold:${row.id}:${row.next_fire_at}`) as { value?: string } | undefined;
      return held?.value ?? null;
    } catch {
      // `scheduler_health` is created by the daemon's own migration, not by the
      // store schema the hub applies — so on a deployment where the daemon has
      // never run the table is absent. **Absent is the right answer there and
      // not a guess**: only the daemon writes a hold, so a mesh it has never
      // touched cannot be holding anything.
      return null;
    }
  };

  return rpcResult(id, {
    rows: (rows as Array<Record<string, unknown>>).map((row) => {
      const since = heldSince(row as { id?: unknown; next_fire_at?: unknown });
      return since === null ? row : { ...row, held_since: since };
    }),
  });
}
