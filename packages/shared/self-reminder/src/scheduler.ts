import { Database } from "bun:sqlite";
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
  log?: (event: string, fields: Record<string, unknown>) => void;
}

function sqliteTime(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 19);
}

function asDate(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
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
  const header = `[SELF-REMINDER ${r.id} scheduled=${scheduled} fired=${now.toISOString()} type=${r.type}${taskId ? ` task=${taskId}` : ""}]`;
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
 * caller explicitly records a PM-approved replay decision. */
export class ReminderScheduler {
  private readonly now: () => Date;
  private readonly overdueHoldMs: number;
  private readonly stalledAfterMs: number;
  private readonly stallLogIntervalMs: number;
  private readonly log: (event: string, fields: Record<string, unknown>) => void;
  private ticking = false;

  constructor(private readonly db: Database, options: SchedulerOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.overdueHoldMs = options.overdueHoldMs ?? 5 * 60_000;
    this.stalledAfterMs = options.stalledAfterMs ?? 5 * 60_000;
    this.stallLogIntervalMs = options.stallLogIntervalMs ?? 5 * 60_000;
    this.log = options.log ?? (() => {});
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
    for (const recipient of ["finja", "team-lead"]) {
      try {
        await sendAlert(recipient, alert);
      } catch {
        this.log("scheduler_recovery_alert_delivery_failed", { recipient, error_category: "hub_rpc_failed" });
      }
    }
  }

  async tick(hubReady: boolean, sendReminder: (reminder: DueReminder, content: string) => Promise<{ id?: string; status?: string }>): Promise<void> {
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
          const result = await sendReminder(reminder, formatPayload(reminder, now));
          const status = result.status === "pending" ? "queued" : "delivered";
          this.insertAudit(reminder, status, result.id ?? null, null, now);
          this.advanceOrComplete(reminder, now);
          this.putState("last_successful_reminder_fire", now.toISOString(), now);
          this.log("reminder_fired", { reminder_id: reminder.id, delivery_status: status });
        } catch {
          this.insertAudit(reminder, "failed", null, "hub_rpc_failed", now);
          this.db.prepare(`UPDATE reminders SET status = 'active', updated_at = ? WHERE id = ?`).run(nowSql, reminder.id);
          this.putState("last_hub_error_category", "hub_rpc_failed", now);
          this.log("reminder_fire_failed", { reminder_id: reminder.id, error_category: "hub_rpc_failed" });
        }
      }
      this.maybeRecordStall("no_successful_fire", due.length, now);
    } finally {
      this.ticking = false;
    }
  }

  /** Future PM-controlled path. No production call site invokes this method. */
  recordOverdueDecision(reminderId: string, scheduledAt: string, decision: "replay" | "skip", approvalRef: string): void {
    if (!approvalRef.startsWith("PM-APPROVED:")) throw new Error("PM approval reference required");
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

  private shouldHoldOverdue(reminder: DueReminder, now: Date): boolean {
    const scheduled = asDate(reminder.next_fire_at);
    if (!scheduled || now.getTime() - scheduled.getTime() <= this.overdueHoldMs) return false;
    const decision = this.db.prepare(`SELECT decision FROM overdue_decisions WHERE reminder_id = ? AND scheduled_at = ?`).get(reminder.id, reminder.next_fire_at) as { decision?: string } | undefined;
    if (decision?.decision === "replay") return false;
    if (decision?.decision === "skip") return true;
    const holdKey = `overdue_hold:${reminder.id}:${reminder.next_fire_at}`;
    if (!this.getState(holdKey)) {
      this.putState(holdKey, now.toISOString(), now);
      this.recordEvent("overdue_hold", { reminder_id: reminder.id, scheduled_at: reminder.next_fire_at, reason: "awaiting_pm_decision" }, now);
      this.log("overdue_reminder_held", { reminder_id: reminder.id, scheduled_at: reminder.next_fire_at, reason: "awaiting_pm_decision" });
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
    this.log("scheduler_stalled", { due_active_count: dueCount, error_category: category });
  }

  private advanceOrComplete(reminder: DueReminder, now: Date): void {
    const nowSql = sqliteTime(now);
    if (reminder.type === "once" || reminder.type === "interval") {
      this.db.prepare(`UPDATE reminders SET status = 'fired', fire_count = fire_count + 1, last_fired_at = ?, updated_at = ?, next_fire_at = NULL WHERE id = ?`).run(nowSql, nowSql, reminder.id);
      return;
    }
    if (reminder.type === "cron") {
      try {
        const spec = JSON.parse(reminder.schedule_spec) as { cron: string; tz?: string };
        if (!spec.cron) throw new Error("cron field missing");
        const next = CronExpressionParser.parse(spec.cron, { tz: spec.tz ?? "UTC", currentDate: now }).next().toDate();
        this.db.prepare(`UPDATE reminders SET fire_count = fire_count + 1, last_fired_at = ?, updated_at = ?, status = 'active', next_fire_at = ? WHERE id = ?`).run(nowSql, nowSql, sqliteTime(next), reminder.id);
      } catch {
        this.db.prepare(`UPDATE reminders SET status = 'dead', updated_at = ? WHERE id = ?`).run(nowSql, reminder.id);
        this.log("cron_advance_failed", { reminder_id: reminder.id, error_category: "invalid_schedule" });
      }
    }
  }

  private insertAudit(reminder: DueReminder, status: string, hubMsgId: string | null, error: string | null, now: Date): void {
    this.db.prepare(`INSERT INTO audit_log (reminder_id, agent_id, scheduled_at, fired_at, delivery_status, hub_msg_id, attempt, error) VALUES (?, ?, ?, ?, ?, ?, 1, ?)`).run(reminder.id, reminder.agent_id, reminder.next_fire_at, sqliteTime(now), status, hubMsgId, error);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scheduler_health (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at DATETIME NOT NULL
      );
      CREATE TABLE IF NOT EXISTS scheduler_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        details TEXT NOT NULL,
        created_at DATETIME NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_scheduler_events_type_time ON scheduler_events(event_type, created_at DESC);
      CREATE TABLE IF NOT EXISTS overdue_decisions (
        reminder_id TEXT NOT NULL,
        scheduled_at DATETIME NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('replay','skip')),
        approval_ref TEXT NOT NULL,
        decided_at DATETIME NOT NULL,
        PRIMARY KEY (reminder_id, scheduled_at)
      );
    `);
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
