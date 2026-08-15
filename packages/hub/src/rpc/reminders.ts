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
        next_fire_at,
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

  return rpcResult(id, { rows });
}
