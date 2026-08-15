import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { ReminderScheduler } from "./scheduler";

function testDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE reminders (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, type TEXT NOT NULL, schedule_spec TEXT NOT NULL,
      payload TEXT NOT NULL, context TEXT, status TEXT NOT NULL, next_fire_at DATETIME,
      fire_count INTEGER NOT NULL DEFAULT 0, last_fired_at DATETIME, updated_at DATETIME, created_by TEXT NOT NULL
    );
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, reminder_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      scheduled_at DATETIME NOT NULL, fired_at DATETIME NOT NULL, delivery_status TEXT NOT NULL,
      hub_msg_id TEXT, attempt INTEGER NOT NULL, error TEXT
    );
  `);
  return db;
}

function addDue(db: Database, at: string): void {
  db.prepare(`INSERT INTO reminders (id, agent_id, type, schedule_spec, payload, context, status, next_fire_at, created_by) VALUES ('r1', 'agent-a', 'once', '{}', 'private reminder body', '{"task_id":"t1"}', 'active', ?, 'agent-a')`).run(at);
}

function addCron(db: Database, id: string, cron: string, at: string): void {
  db.prepare(`INSERT INTO reminders (id, agent_id, type, schedule_spec, payload, context, status, next_fire_at, created_by) VALUES (?, 'agent-a', 'cron', ?, 'fixture reminder body', '{}', 'active', ?, 'agent-a')`)
    .run(id, JSON.stringify({ cron, tz: "Asia/Seoul" }), at);
}

describe("ReminderScheduler health and overdue policy", () => {
  test("records due scans/stall state and sends one deduplicated recovery alert to both routes", async () => {
    const db = testDb();
    let now = new Date("2026-07-14T00:00:00.000Z");
    addDue(db, "2026-07-13 23:00:00");
    const scheduler = new ReminderScheduler(db, {
      now: () => now,
      overdueHoldMs: 60_000,
      stalledAfterMs: 60_000,
      stallLogIntervalMs: 60_000,
      recoveryAlertRecipients: ["alert-route-1", "alert-route-2"],
    });
    scheduler.setConnectivity("unavailable", "duplicate_identity");
    now = new Date("2026-07-14T00:02:00.000Z");
    await scheduler.tick(false, async () => ({ status: "delivered" }));

    expect(scheduler.getHealthState("last_due_scan")).toBe(now.toISOString());
    expect(scheduler.getHealthState("last_stall_category")).toBe("hub_unavailable");
    expect(db.prepare(`SELECT count(*) AS count FROM scheduler_events WHERE event_type = 'scheduler_stalled'`).get()).toEqual({ count: 1 });

    const recipients: string[] = [];
    await scheduler.onHubRegistered(async (recipient, content) => {
      recipients.push(recipient);
      expect(content).not.toContain("private reminder body");
      return { status: "pending" };
    });
    await scheduler.onHubRegistered(async (recipient) => { recipients.push(recipient); return {}; });
    expect(recipients).toEqual(["alert-route-1", "alert-route-2"]);
    expect(scheduler.getHealthState("last_successful_hub_registration")).toBe(now.toISOString());
  });

  test("records the recovery event but routes no alert when no recipients are configured", async () => {
    const db = testDb();
    let now = new Date("2026-07-14T00:00:00.000Z");
    const scheduler = new ReminderScheduler(db, { now: () => now });
    scheduler.setConnectivity("unavailable", "duplicate_identity");
    now = new Date("2026-07-14T00:02:00.000Z");

    const recipients: string[] = [];
    await scheduler.onHubRegistered(async (recipient) => { recipients.push(recipient); return {}; });

    expect(recipients).toEqual([]);
    expect(db.prepare(`SELECT count(*) AS count FROM scheduler_events WHERE event_type = 'scheduler_recovered'`).get()).toEqual({ count: 1 });
    expect(scheduler.getHealthState("last_successful_hub_registration")).toBe(now.toISOString());
  });

  test("rejects an overdue decision whose approval reference lacks the configured prefix", () => {
    const db = testDb();
    const scheduler = new ReminderScheduler(db, { overdueApprovalPrefix: "OPS-OK:" });

    expect(() => scheduler.recordOverdueDecision("r1", "2026-07-13 23:00:00", "replay", "nope"))
      .toThrow('approval reference must start with "OPS-OK:"');
    expect(() => scheduler.recordOverdueDecision("r1", "2026-07-13 23:00:00", "replay", "OPS-OK:ticket-42"))
      .not.toThrow();
  });

  test("holds overdue reminders without firing, rescheduling, or changing reminder state", async () => {
    const db = testDb();
    let sent = 0;
    const scheduler = new ReminderScheduler(db, {
      now: () => new Date("2026-07-14T00:10:00.000Z"),
      overdueHoldMs: 60_000,
    });
    addDue(db, "2026-07-14 00:00:00");
    await scheduler.tick(true, async () => { sent++; return { status: "delivered" }; });

    expect(sent).toBe(0);
    expect(db.prepare(`SELECT status, next_fire_at, fire_count FROM reminders WHERE id = 'r1'`).get()).toEqual({ status: "active", next_fire_at: "2026-07-14 00:00:00", fire_count: 0 });
    expect(db.prepare(`SELECT count(*) AS count FROM scheduler_events WHERE event_type = 'overdue_hold'`).get()).toEqual({ count: 1 });
    expect(db.prepare(`SELECT count(*) AS count FROM audit_log`).get()).toEqual({ count: 0 });
  });

  test("keeps named operating schedules deliverable in one tick", async () => {
    const db = testDb();
    const now = new Date("2026-07-22T10:00:00.000Z"); // Wednesday 19:00 KST
    const scheduler = new ReminderScheduler(db, { now: () => now });
    const at = "2026-07-22 10:00:00";
    addCron(db, "eod-1900-kst", "0 19 * * 1-5", at);
    addCron(db, "weekly-1600-kst", "0 16 * * 3", at);
    addCron(db, "weekly-1700-kst", "0 17 * * 3", at);
    addCron(db, "daily-scrum-1000-kst", "0 10 * * 1-5", at);

    const delivered: string[] = [];
    await scheduler.tick(true, async (reminder) => {
      delivered.push(reminder.id);
      return { status: "delivered" };
    });

    expect(delivered).toEqual(["eod-1900-kst", "weekly-1600-kst", "weekly-1700-kst", "daily-scrum-1000-kst"]);
    expect(db.prepare(`SELECT id, status, fire_count, next_fire_at FROM reminders ORDER BY id`).all()).toEqual([
      { id: "daily-scrum-1000-kst", status: "active", fire_count: 1, next_fire_at: "2026-07-23 01:00:00" },
      { id: "eod-1900-kst", status: "active", fire_count: 1, next_fire_at: "2026-07-23 10:00:00" },
      { id: "weekly-1600-kst", status: "active", fire_count: 1, next_fire_at: "2026-07-29 07:00:00" },
      { id: "weekly-1700-kst", status: "active", fire_count: 1, next_fire_at: "2026-07-29 08:00:00" },
    ]);
  });
});
