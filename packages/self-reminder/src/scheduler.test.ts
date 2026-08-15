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

function addInterval(db: Database, id: string, every: string, at: string): void {
  db.prepare(`INSERT INTO reminders (id, agent_id, type, schedule_spec, payload, context, status, next_fire_at, created_by) VALUES (?, 'agent-a', 'interval', ?, 'fixture reminder body', '{}', 'active', ?, 'agent-a')`)
    .run(id, JSON.stringify({ every }), at);
}

function rowOf(db: Database, id: string) {
  return db.prepare(`SELECT status, next_fire_at, fire_count FROM reminders WHERE id = ?`).get(id) as
    { status: string; next_fire_at: string | null; fire_count: number };
}

describe("interval reminders repeat", () => {
  test("an interval reminder stays active and gets its next slot", async () => {
    // The whole point of the type. It used to be advanced with `once`: fired
    // exactly one time, then `status = 'fired'` and `next_fire_at = NULL`.
    const db = testDb();
    const now = new Date("2026-07-14T09:00:00.000Z");
    addInterval(db, "i1", "15m", "2026-07-14 09:00:00");
    const scheduler = new ReminderScheduler(db, { now: () => now });

    await scheduler.tick(true, async () => ({ status: "delivered" }));

    expect(rowOf(db, "i1")).toEqual({
      status: "active",
      next_fire_at: "2026-07-14 09:15:00",
      fire_count: 1,
    });
  });

  test("it keeps firing across many ticks rather than stopping after one", async () => {
    const db = testDb();
    let now = new Date("2026-07-14T09:00:00.000Z");
    addInterval(db, "i1", "15m", "2026-07-14 09:00:00");
    const scheduler = new ReminderScheduler(db, { now: () => now });

    let fires = 0;
    for (let i = 0; i < 4; i++) {
      await scheduler.tick(true, async () => {
        fires++;
        return { status: "delivered" };
      });
      now = new Date(now.getTime() + 15 * 60_000);
    }

    expect(fires).toBe(4);
    expect(rowOf(db, "i1").fire_count).toBe(4);
    expect(rowOf(db, "i1").next_fire_at).toBe("2026-07-14 10:00:00");
  });

  test("a late fire returns to the original grid, not to now + interval", async () => {
    const db = testDb();
    const now = new Date("2026-07-14T09:07:23.000Z");
    addInterval(db, "i1", "15m", "2026-07-14 09:00:00");
    const scheduler = new ReminderScheduler(db, { now: () => now });

    await scheduler.tick(true, async () => ({ status: "delivered" }));

    // 09:15, not 09:22:23. Advancing from the late fire would move the schedule
    // permanently, and every outage would move it again.
    expect(rowOf(db, "i1").next_fire_at).toBe("2026-07-14 09:15:00");
  });

  test("an outage produces one catch-up fire, not one per missed slot", async () => {
    const db = testDb();
    const now = new Date("2026-07-14T11:07:00.000Z");
    addInterval(db, "i1", "15m", "2026-07-14 09:00:00");
    // The default hold is five minutes and this row is two hours late. A
    // repeating reminder is no longer held for that: its next slot is
    // computable, so there is nothing for an operator to decide.
    const scheduler = new ReminderScheduler(db, { now: () => now });

    await scheduler.tick(true, async () => ({ status: "delivered" }));

    expect(rowOf(db, "i1")).toEqual({
      status: "active",
      next_fire_at: "2026-07-14 11:15:00",
      fire_count: 1,
    });
  });

  test("the next slot is always in the future, so a fired row is never instantly due", async () => {
    const db = testDb();
    const now = new Date("2026-07-14T09:00:00.000Z");
    addInterval(db, "i1", "30s", "2026-07-14 09:00:00");
    const scheduler = new ReminderScheduler(db, { now: () => now });

    await scheduler.tick(true, async () => ({ status: "delivered" }));
    // Equal would be a fire loop: the row is due the instant it is written.
    expect(rowOf(db, "i1").next_fire_at).toBe("2026-07-14 09:00:30");
  });

  test("a spec the daemon cannot read kills the row instead of stranding it", async () => {
    // `firing` is invisible to the due scan, which selects `active` only. A
    // type that matched no branch used to be left there — never fired again,
    // never reported, and not listed as dead either.
    const db = testDb();
    const now = new Date("2026-07-14T09:00:00.000Z");
    db.prepare(`INSERT INTO reminders (id, agent_id, type, schedule_spec, payload, context, status, next_fire_at, created_by) VALUES ('bad', 'agent-a', 'weekly', '{"every":"7d"}', 'body', '{}', 'active', ?, 'agent-a')`)
      .run("2026-07-14 09:00:00");
    const events: Array<[string, Record<string, unknown>]> = [];
    const scheduler = new ReminderScheduler(db, { now: () => now, log: (e, f) => events.push([e, f]) });

    await scheduler.tick(true, async () => ({ status: "delivered" }));

    expect(rowOf(db, "bad").status).toBe("dead");
    expect(events.some(([e]) => e === "advance_failed")).toBe(true);
  });

  test("an interval whose spec lost its `every` dies rather than repeating blindly", async () => {
    const db = testDb();
    const now = new Date("2026-07-14T09:00:00.000Z");
    db.prepare(`INSERT INTO reminders (id, agent_id, type, schedule_spec, payload, context, status, next_fire_at, created_by) VALUES ('i1', 'agent-a', 'interval', '{}', 'body', '{}', 'active', ?, 'agent-a')`)
      .run("2026-07-14 09:00:00");
    const scheduler = new ReminderScheduler(db, { now: () => now });

    await scheduler.tick(true, async () => ({ status: "delivered" }));

    expect(rowOf(db, "i1").status).toBe("dead");
  });

  test("a once reminder still completes rather than repeating", async () => {
    const db = testDb();
    const now = new Date("2026-07-14T09:00:00.000Z");
    addDue(db, "2026-07-14 09:00:00");
    const scheduler = new ReminderScheduler(db, { now: () => now });

    await scheduler.tick(true, async () => ({ status: "delivered" }));

    expect(rowOf(db, "r1")).toEqual({ status: "fired", next_fire_at: null, fire_count: 1 });
  });
});

describe("overdue handling distinguishes repeating from one-shot", () => {
  test("a badly overdue interval reminder resumes on its own", async () => {
    // `recordOverdueDecision` has no production call site, so a held repeating
    // reminder was held forever — active, never firing, receding further behind
    // on every scan.
    const db = testDb();
    const now = new Date("2026-07-20T09:00:00.000Z");
    addInterval(db, "i1", "15m", "2026-07-14 09:00:00");
    const scheduler = new ReminderScheduler(db, { now: () => now });

    let fired = 0;
    await scheduler.tick(true, async () => {
      fired++;
      return { status: "delivered" };
    });

    expect(fired).toBe(1);
    expect(rowOf(db, "i1").status).toBe("active");
    expect(rowOf(db, "i1").next_fire_at).toBe("2026-07-20 09:15:00");
  });

  test("an overdue cron reminder resumes on its own too", async () => {
    const db = testDb();
    const now = new Date("2026-07-20T09:00:00.000Z");
    addCron(db, "c1", "0 9 * * *", "2026-07-14 00:00:00");
    const scheduler = new ReminderScheduler(db, { now: () => now });

    let fired = 0;
    await scheduler.tick(true, async () => {
      fired++;
      return { status: "delivered" };
    });

    expect(fired).toBe(1);
    expect(rowOf(db, "c1").status).toBe("active");
  });

  test("a badly overdue once reminder is still held for a decision", async () => {
    // Unchanged, and deliberately: the moment a one-shot was for has passed,
    // there is no later slot to move it to, and delivering it late can be worse
    // than not delivering it. That is a judgement, so a person makes it.
    const db = testDb();
    const now = new Date("2026-07-14T10:00:00.000Z");
    addDue(db, "2026-07-14 09:00:00");
    const scheduler = new ReminderScheduler(db, { now: () => now });

    let fired = 0;
    await scheduler.tick(true, async () => {
      fired++;
      return { status: "delivered" };
    });

    expect(fired).toBe(0);
    expect(rowOf(db, "r1").status).toBe("active");
    expect(db.prepare(`SELECT count(*) AS c FROM scheduler_events WHERE event_type = 'overdue_hold'`).get())
      .toEqual({ c: 1 });
  });

  test("an approved replay still releases a held once reminder", async () => {
    const db = testDb();
    const now = new Date("2026-07-14T10:00:00.000Z");
    addDue(db, "2026-07-14 09:00:00");
    const scheduler = new ReminderScheduler(db, { now: () => now });

    scheduler.recordOverdueDecision("r1", "2026-07-14 09:00:00", "replay", "APPROVED:ticket-1");
    let fired = 0;
    await scheduler.tick(true, async () => {
      fired++;
      return { status: "delivered" };
    });

    expect(fired).toBe(1);
    expect(rowOf(db, "r1").status).toBe("fired");
  });
});
