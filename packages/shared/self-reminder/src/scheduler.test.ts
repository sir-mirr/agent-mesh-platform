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
  db.prepare(`INSERT INTO reminders (id, agent_id, type, schedule_spec, payload, context, status, next_fire_at, created_by) VALUES ('r1', 'finja', 'once', '{}', 'private reminder body', '{"task_id":"t1"}', 'active', ?, 'finja')`).run(at);
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
    expect(recipients).toEqual(["finja", "team-lead"]);
    expect(scheduler.getHealthState("last_successful_hub_registration")).toBe(now.toISOString());
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
});
