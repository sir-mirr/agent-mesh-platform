import { hubErrorCategory } from "./lifecycle";
import { createLogger, silentSink, type Logger } from "@agent-mesh/log";
import { nextIntervalFire, parseScheduleSpec } from "@agent-mesh/contracts";
import { createHash } from "node:crypto";

import { Database } from "bun:sqlite";
import { migrateSchedulerState } from "@agent-mesh/store";
import { CronExpressionParser } from "cron-parser";

export type ConnectivityState = "connecting" | "registered" | "unavailable";

export interface DueReminder {
  id: string;
  agent_id: string;
  type: string;
  schedule_spec: string;
  payload: string;
  context: string | null;
  next_fire_at: string;
}

export interface SchedulerOptions {
  now?: () => Date;
  overdueHoldMs?: number;
  stalledAfterMs?: number;
  stallLogIntervalMs?: number;
  log?: Logger;
  /** Identities notified when the scheduler recovers from a hub outage.
   *  Deployment-specific — the scheduler ships with no built-in recipients. */
  recoveryAlertRecipients?: readonly string[];
  /** Prefix an `approvalRef` must carry for `recordOverdueDecision` to accept it. */
  overdueApprovalPrefix?: string;
}

function sqliteTime(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 19);
}

function asDate(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Identifies one **fire**, not one reminder.
 *
 * A repeating reminder delivers many times, so the reminder id alone cannot
 * settle whether an envelope is a duplicate — `(id, slot)` can. Derived rather
 * than random so a retry after an ambiguous failure reuses the key and § 8.2
 * returns the original message, while the next slot produces a different one.
 *
 * Hashed so it fits `client_message_id`'s 128-character bound whatever the
 * caller named the reminder. The readable form goes in the envelope header,
 * which is where an operator correlating a duplicate will look.
 */
export function fireKey(reminderId: string, scheduledAt: string): string {
  return createHash("sha256").update(`${reminderId}\u0000${scheduledAt}`).digest("hex").slice(0, 32);
}

function formatPayload(r: DueReminder, now: Date): string {
  const scheduled = r.next_fire_at.replace(" ", "T") + "Z";
  let taskId: string | null = null;
  let parsedContext: Record<string, unknown> | null = null;
  if (r.context) {
    try {
      const parsed = JSON.parse(r.context);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        parsedContext = parsed as Record<string, unknown>;
        taskId = typeof parsedContext.task_id === "string" ? parsedContext.task_id : null;
      }
    } catch {}
  }
  // `fire=` is what a consumer deduplicates on (SPEC § 3.3). The reminder id is
  // not enough on its own: a repeating reminder delivers under the same id
  // every slot, so an at-least-once consumer keying on it would drop every fire
  // after the first as a duplicate of the first.
  const header =
    `[SELF-REMINDER ${r.id} fire=${r.id}@${scheduled} scheduled=${scheduled} ` +
    `fired=${now.toISOString()} type=${r.type}${taskId ? ` task=${taskId}` : ""}]`;
  let body = `${header}\n${r.payload}`;
  if (r.context) {
    if (parsedContext) {
      const entries = Object.entries(parsedContext);
      const ordered = taskId
        ? [["task_id", taskId] as [string, unknown], ...entries.filter(([key]) => key !== "task_id")]
        : entries;
      const lines = ordered.map(([key, value]) => `${key}: ${value}`).join("\n");
      if (lines) body += `\n\n--- context ---\n${lines}\n`;
    } else {
      body += `\n\n--- context ---\n${r.context}\n`;
    }
  }
  return body;
}

/** SQLite-backed scheduler state. It never replays overdue rows unless a future
 * caller explicitly records an approved replay decision. */
export class ReminderScheduler {
  private readonly now: () => Date;
  private readonly overdueHoldMs: number;
  private readonly stalledAfterMs: number;
  private readonly stallLogIntervalMs: number;
  private readonly log: Logger;
  private readonly recoveryAlertRecipients: readonly string[];
  private readonly overdueApprovalPrefix: string;
  private ticking = false;

  constructor(private readonly db: Database, options: SchedulerOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.overdueHoldMs = options.overdueHoldMs ?? 5 * 60_000;
    this.stalledAfterMs = options.stalledAfterMs ?? 5 * 60_000;
    this.stallLogIntervalMs = options.stallLogIntervalMs ?? 5 * 60_000;
    this.log = options.log ?? createLogger("self-reminder", silentSink);
    this.recoveryAlertRecipients = options.recoveryAlertRecipients ?? [];
    this.overdueApprovalPrefix = options.overdueApprovalPrefix ?? "APPROVED:";
    this.migrate();
  }

  setConnectivity(state: ConnectivityState, errorCategory?: string): void {
    const now = this.now();
    this.putState("connectivity_state", state, now);
    if (state === "unavailable") {
      if (!this.getState("hub_unavailable_since")) this.putState("hub_unavailable_since", now.toISOString(), now);
      if (errorCategory) this.putState("last_hub_error_category", errorCategory, now);
    }
  }

  async onHubRegistered(sendAlert: (recipient: string, content: string) => Promise<unknown>): Promise<void> {
    const now = this.now();
    const outageStarted = this.getState("hub_unavailable_since");
    this.putState("last_successful_hub_registration", now.toISOString(), now);
    this.putState("connectivity_state", "registered", now);
    this.deleteState("hub_unavailable_since");
    if (!outageStarted || this.getState("recovery_alert_outage") === outageStarted) return;

    const dueCountRow = this.db.prepare(
      `SELECT count(*) AS count FROM reminders WHERE status = 'active' AND next_fire_at <= ?`
    ).get(sqliteTime(now)) as { count: number } | undefined;
    const dueCount = dueCountRow?.count ?? 0;
    const category = this.getState("last_hub_error_category") ?? "hub_unavailable";
    const alert = [
      "Self-reminder scheduler recovered.",
      `outage_started=${outageStarted}`,
      `recovered_at=${now.toISOString()}`,
      `due_active_count=${dueCount}`,
      `last_error_category=${category}`,
    ].join(" ");

    // Persist before delivery. mesh.send stores pending messages, so a process
    // crash or route failure cannot cause duplicate recovery alerts on restart.
    this.putState("recovery_alert_outage", outageStarted, now);
    this.recordEvent("scheduler_recovered", { outage_started: outageStarted, due_active_count: dueCount, error_category: category }, now);
    if (this.recoveryAlertRecipients.length === 0) {
      this.log.warn("recovered, but no recipient is configured for the alert", "scheduler_recovery_alert_skipped", {
        outcome: "skipped",
        reason: "no_recipients_configured",
      });
      return;
    }
    for (const recipient of this.recoveryAlertRecipients) {
      try {
        await sendAlert(recipient, alert);
      } catch (error) {
        // **The category was hardcoded and the error discarded.** An
        // entitlement refusal, a schema rejection and a local `TypeError` were
        // all filed as a hub RPC failure, which is the fallback
        // `hubErrorCategory` returns when it has nothing better — so the one
        // case the constant is right for is the case where the real answer is
        // unavailable anyway, and every other case it overwrites an answer that
        // was there.
        this.log.error("could not deliver the recovery alert", "scheduler_recovery_alert_delivery_failed", {
          actor: recipient,
          outcome: "failed",
          reason: hubErrorCategory(error),
        });
      }
    }
  }

  async advanceDue(
    hubReady: boolean,
    sendReminder: (
      reminder: DueReminder,
      content: string,
      clientMessageId: string,
    ) => Promise<{ id?: string; status?: string; duplicate?: boolean }>,
  ): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      const nowSql = sqliteTime(now);
      this.putState("last_due_scan", now.toISOString(), now);
      const due = this.db.prepare(`
        SELECT id, agent_id, type, schedule_spec, payload, context, next_fire_at
          FROM reminders WHERE status = 'active' AND next_fire_at <= ?
         ORDER BY next_fire_at ASC LIMIT 100
      `).all(nowSql) as DueReminder[];
      if (due.length === 0) return;

      if (!hubReady) {
        this.maybeRecordStall("hub_unavailable", due.length, now);
        return;
      }

      for (const reminder of due) {
        if (this.shouldHoldOverdue(reminder, now)) continue;
        const claim = this.db.prepare(`UPDATE reminders SET status = 'firing', updated_at = ? WHERE id = ? AND status = 'active'`).run(nowSql, reminder.id);
        if (claim.changes !== 1) continue;
        this.insertAudit(reminder, "firing", null, null, now);
        try {
          // Keyed on the fire (SPEC § 8.2). The failure path below returns the
          // row to `active`, so a send whose *response* was lost is retried on
          // the next scan — without a key that retry delivers the reminder
          // twice, and the daemon cannot tell the two cases apart.
          const result = await sendReminder(
            reminder,
            formatPayload(reminder, now),
            fireKey(reminder.id, reminder.next_fire_at),
          );
          const status = result.status === "pending" ? "queued" : "delivered";
          this.insertAudit(reminder, status, result.id ?? null, null, now);
          this.advanceOrComplete(reminder, now);
          this.putState("last_successful_reminder_fire", now.toISOString(), now);
          this.log.info("fired a reminder", "reminder_fired", {
            id: reminder.id,
            actor: reminder.agent_id,
            outcome: status,
            delivery_status: status,
            // True when this fire had already reached the hub and only the
            // response was lost. Worth seeing: it is the difference between a
            // flaky link and a scheduler firing twice.
            deduplicated: result.duplicate === true,
          });
        } catch (error) {
          // **This one is read back and shown to a person.** The constant went
          // into the audit row, into `last_hub_error_category`, and from there
          // into the recovery alert's `last_error_category=` — so an operator
          // told why the outage happened was told `hub_rpc_failed` whatever it
          // had actually been. A fabricated category that reaches a human is
          // worse than one that is merely written down, because it is acted on.
          const category = hubErrorCategory(error);
          this.insertAudit(reminder, "failed", null, category, now);
          this.db.prepare(`UPDATE reminders SET status = 'active', updated_at = ? WHERE id = ?`).run(nowSql, reminder.id);
          this.putState("last_hub_error_category", category, now);
          this.log.error("a reminder could not be delivered", "reminder_fire_failed", {
            id: reminder.id,
            actor: reminder.agent_id,
            outcome: "failed",
            reason: category,
          });
        }
      }
      this.maybeRecordStall("no_successful_fire", due.length, now);
    } finally {
      this.ticking = false;
    }
  }

  /** Future operator-controlled path. No production call site invokes this method. */
  recordOverdueDecision(reminderId: string, scheduledAt: string, decision: "replay" | "skip", approvalRef: string): void {
    if (!approvalRef.startsWith(this.overdueApprovalPrefix)) {
      throw new Error(`approval reference must start with "${this.overdueApprovalPrefix}"`);
    }
    this.db.prepare(`
      INSERT INTO overdue_decisions (reminder_id, scheduled_at, decision, approval_ref, decided_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(reminder_id, scheduled_at) DO UPDATE SET
        decision = excluded.decision, approval_ref = excluded.approval_ref, decided_at = excluded.decided_at
    `).run(reminderId, scheduledAt, decision, approvalRef, this.now().toISOString());
  }

  getHealthState(key: string): string | null {
    return this.getState(key);
  }

  /**
   * Whether an overdue reminder waits for an operator before firing.
   *
   * **Only a `once` reminder does.** A one-shot that is hours late may be worse
   * to deliver than to drop — the moment it was for has passed — and there is
   * no later slot to move it to, so a person has to decide.
   *
   * A repeating reminder has no such question. Its next slot is computable, one
   * catch-up fire is what every scheduler does after an outage (§ 3.3 already
   * requires consumers to be idempotent), and the grid-aligned advance means
   * missed slots are skipped rather than replayed — the backlog the hold exists
   * to prevent cannot form.
   *
   * Holding them was the more damaging behaviour: `recordOverdueDecision` has
   * no production call site, so an interval reminder that fell five minutes
   * behind once was held permanently, still `active`, with a `next_fire_at`
   * receding further into the past on every scan and nothing that could release
   * it short of editing the database.
   */
  private shouldHoldOverdue(reminder: DueReminder, now: Date): boolean {
    if (reminder.type !== "once") return false;
    const scheduled = asDate(reminder.next_fire_at);
    if (!scheduled || now.getTime() - scheduled.getTime() <= this.overdueHoldMs) return false;
    const decision = this.db.prepare(`SELECT decision FROM overdue_decisions WHERE reminder_id = ? AND scheduled_at = ?`).get(reminder.id, reminder.next_fire_at) as { decision?: string } | undefined;
    if (decision?.decision === "replay") return false;
    if (decision?.decision === "skip") return true;
    const holdKey = `overdue_hold:${reminder.id}:${reminder.next_fire_at}`;
    if (!this.getState(holdKey)) {
      this.putState(holdKey, now.toISOString(), now);
      this.recordEvent("overdue_hold", { reminder_id: reminder.id, scheduled_at: reminder.next_fire_at, reason: "awaiting_operator_decision" }, now);
      this.log.warn("holding an overdue reminder for an operator", "overdue_reminder_held", {
        id: reminder.id,
        scheduled_at: reminder.next_fire_at,
        outcome: "held",
        reason: "awaiting_operator_decision",
      });
    }
    return true;
  }

  private maybeRecordStall(category: "hub_unavailable" | "no_successful_fire", dueCount: number, now: Date): void {
    const unavailableSince = asDate(this.getState("hub_unavailable_since"));
    const lastFire = asDate(this.getState("last_successful_reminder_fire"));
    const qualifies = category === "hub_unavailable"
      ? !!unavailableSince && now.getTime() - unavailableSince.getTime() >= this.stalledAfterMs
      : !lastFire || now.getTime() - lastFire.getTime() >= this.stalledAfterMs;
    if (!qualifies) return;
    const lastLogged = asDate(this.getState("last_scheduler_stalled"));
    if (lastLogged && now.getTime() - lastLogged.getTime() < this.stallLogIntervalMs) return;
    this.putState("last_scheduler_stalled", now.toISOString(), now);
    this.putState("last_stall_category", category, now);
    this.recordEvent("scheduler_stalled", { due_active_count: dueCount, error_category: category }, now);
    this.log.error("the scheduler is stalled", "scheduler_stalled", {
      due_active_count: dueCount,
      outcome: "stalled",
      reason: category,
    });
  }

  /**
   * Decide where a reminder goes after it has fired.
   *
   * Every branch has to leave the row in a terminal or a schedulable state. The
   * previous version fell through for any type it did not recognise, and the
   * due scan only selects `status = 'active'` — so an unrecognised type left
   * the row stuck in `firing` forever, invisible to the scan and to the
   * operator alike.
   */
  private advanceOrComplete(reminder: DueReminder, now: Date): void {
    const nowSql = sqliteTime(now);
    if (reminder.type === "once") {
      this.db.prepare(`UPDATE reminders SET status = 'fired', fire_count = fire_count + 1, last_fired_at = ?, updated_at = ?, next_fire_at = NULL WHERE id = ?`).run(nowSql, nowSql, reminder.id);
      return;
    }

    let next: Date;
    try {
      next = this.nextFire(reminder, now);
    } catch (err) {
      // `dead`, not `active`: the spec cannot be parsed, so retrying would fail
      // identically every scan and the row would churn the log forever.
      this.db.prepare(`UPDATE reminders SET status = 'dead', updated_at = ? WHERE id = ?`).run(nowSql, reminder.id);
      this.log.error("cannot schedule the next fire, so the reminder is dead", "advance_failed", {
        id: reminder.id,
        reminder_type: reminder.type,
        outcome: "dead",
        reason: "invalid_schedule",
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    this.db.prepare(`UPDATE reminders SET fire_count = fire_count + 1, last_fired_at = ?, updated_at = ?, status = 'active', next_fire_at = ? WHERE id = ?`).run(nowSql, nowSql, sqliteTime(next), reminder.id);
  }

  /** The next slot for a repeating reminder. Throws on a spec it cannot read. */
  private nextFire(reminder: DueReminder, now: Date): Date {
    const parsed = parseScheduleSpec(reminder.type, reminder.schedule_spec, now);
    if (!parsed.ok) throw new Error(parsed.reason);

    if (parsed.schedule.type === "interval") {
      // Advanced from the slot it was due for, not from `now` — a fire that ran
      // late must not walk the schedule off its grid for good.
      const scheduled = asDate(reminder.next_fire_at) ?? now;
      return nextIntervalFire(scheduled, parsed.schedule.everyMs, now);
    }
    if (parsed.schedule.type === "cron") {
      return CronExpressionParser.parse(parsed.schedule.cron, {
        tz: parsed.schedule.tz,
        currentDate: now,
      }).next().toDate();
    }
    // `once` is handled by the caller and never reaches here; anything else was
    // refused by `parseScheduleSpec` above.
    throw new Error(`type "${reminder.type}" does not repeat`);
  }

  private insertAudit(reminder: DueReminder, status: string, hubMsgId: string | null, error: string | null, now: Date): void {
    this.db.prepare(`INSERT INTO audit_log (reminder_id, agent_id, scheduled_at, fired_at, delivery_status, hub_msg_id, attempt, error) VALUES (?, ?, ?, ?, ?, ?, 1, ?)`).run(reminder.id, reminder.agent_id, reminder.next_fire_at, sqliteTime(now), status, hubMsgId, error);
  }

  /**
   * **Delegated, not repeated.** These tables are declared in
   * `@agent-mesh/store`'s `self-reminder` schema, beside `reminders` and
   * `audit_log`, because three processes read them now — this daemon, the hub,
   * and (D-810) an admin route. Keeping a copy here would be two DDLs for one
   * file, which drift with nothing able to notice: `CREATE TABLE IF NOT EXISTS`
   * is silent about a table that already exists in a different shape.
   *
   * Still called from the constructor. The daemon's `main.ts` migrates first,
   * but a unit test may build a scheduler over a hand-made database, and this
   * is what makes that work without every such test knowing the DDL.
   */
  private migrate(): void {
    migrateSchedulerState(this.db);
  }

  private putState(key: string, value: string, now: Date): void {
    this.db.prepare(`INSERT INTO scheduler_health (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, value, sqliteTime(now));
  }

  private getState(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM scheduler_health WHERE key = ?`).get(key) as { value?: string } | undefined;
    return row?.value ?? null;
  }

  private deleteState(key: string): void {
    this.db.prepare(`DELETE FROM scheduler_health WHERE key = ?`).run(key);
  }

  private recordEvent(eventType: string, details: Record<string, unknown>, now: Date): void {
    this.db.prepare(`INSERT INTO scheduler_events (event_type, details, created_at) VALUES (?, ?, ?)`).run(eventType, JSON.stringify(details), sqliteTime(now));
  }
}
