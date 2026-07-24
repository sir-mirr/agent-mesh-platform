import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { AutonomyTaskStore } from "./autonomy";
import { ReminderScheduler } from "./scheduler";

const MANIFEST_SHA = "a".repeat(64);

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

function createTask(store: AutonomyTaskStore, taskId = "autonomy-tooling-001"): void {
  store.create({
    taskId,
    manifestSha256: MANIFEST_SHA,
    lane: "A",
    owner: "synapse-pm",
    phase: "implementation",
    nextAction: "run_tests",
  });
}

describe("AutonomyTaskStore", () => {
  test("migrates the contract tables and requires an approval reference for lane C", () => {
    const db = testDb();
    const store = new AutonomyTaskStore(db);
    const taskColumns = db.prepare(`PRAGMA table_info(autonomy_tasks)`).all() as Array<{ name: string }>;
    const eventColumns = db.prepare(`PRAGMA table_info(autonomy_events)`).all() as Array<{ name: string }>;
    expect(taskColumns.map((column) => column.name)).toEqual([
      "task_id", "manifest_sha256", "lane", "owner", "status", "phase", "last_progress_at",
      "last_heartbeat_at", "next_action", "approval_ref", "escalation_level", "updated_at",
    ]);
    expect(eventColumns.map((column) => column.name)).toEqual([
      "id", "task_id", "kind", "actor", "occurred_at", "evidence_json",
    ]);
    expect(() => store.create({
      taskId: "needs-approval",
      manifestSha256: MANIFEST_SHA,
      lane: "C",
      owner: "synapse-pm",
      phase: "waiting",
      nextAction: "await_approval",
    })).toThrow("lane C requires approvalRef");
  });

  test("heartbeat records liveness without refreshing progress", async () => {
    const db = testDb();
    let now = new Date("2026-07-24T00:00:00.000Z");
    const scheduler = new ReminderScheduler(db, {
      now: () => now,
      autonomy: { now: () => now, heartbeatAfterMs: 15, nudgeAfterMs: 30, escalateAfterMs: 45 },
    });
    createTask(scheduler.autonomy);
    const initial = scheduler.autonomy.get("autonomy-tooling-001");
    now = new Date("2026-07-24T00:00:00.016Z");
    const deliveries: Array<{ recipient: string; content: string }> = [];
    await scheduler.tick(true, async () => ({ status: "delivered" }), async (recipient, content) => {
      deliveries.push({ recipient, content });
    });

    const after = scheduler.autonomy.get("autonomy-tooling-001");
    expect(after?.last_progress_at).toBe(initial?.last_progress_at);
    expect(after?.last_heartbeat_at).toBe(now.toISOString());
    expect(deliveries.map((delivery) => delivery.recipient)).toEqual(["synapse-pm"]);
    expect(deliveries[0]?.content).toContain("AUTONOMY HEARTBEAT");
    expect(db.prepare(`SELECT count(*) AS count FROM autonomy_events WHERE kind = 'heartbeat'`).get()).toEqual({ count: 1 });
  });

  test("nudges and escalates once despite repeated scheduler ticks", async () => {
    const db = testDb();
    let now = new Date("2026-07-24T00:00:00.000Z");
    const scheduler = new ReminderScheduler(db, {
      now: () => now,
      autonomy: { now: () => now, heartbeatAfterMs: 15, nudgeAfterMs: 30, escalateAfterMs: 45 },
    });
    createTask(scheduler.autonomy, "stalled-task-001");
    const deliveries: Array<{ recipient: string; content: string }> = [];
    const send = async (recipient: string, content: string) => { deliveries.push({ recipient, content }); };

    now = new Date("2026-07-24T00:00:00.031Z");
    await scheduler.tick(true, async () => ({ status: "delivered" }), send);
    await scheduler.tick(true, async () => ({ status: "delivered" }), send);
    expect(deliveries.map((delivery) => delivery.recipient)).toEqual(["synapse-pm"]);
    expect(deliveries[0]?.content).toContain("AUTONOMY NUDGE");
    expect(db.prepare(`SELECT count(*) AS count FROM autonomy_events WHERE kind = 'nudge'`).get()).toEqual({ count: 1 });

    now = new Date("2026-07-24T00:00:00.046Z");
    await scheduler.tick(true, async () => ({ status: "delivered" }), send);
    await scheduler.tick(true, async () => ({ status: "delivered" }), send);
    expect(deliveries.slice(1).map((delivery) => delivery.recipient)).toEqual(["finja", "synapse-pm"]);
    expect(deliveries[1]?.content).toContain("AUTONOMY ESCALATION");
    expect(db.prepare(`SELECT count(*) AS count FROM autonomy_events WHERE kind = 'escalated'`).get()).toEqual({ count: 1 });
    expect(scheduler.autonomy.get("stalled-task-001")?.escalation_level).toBe(2);
  });

  test("only a passing gate result transitions a task to verified_done", () => {
    const db = testDb();
    const store = new AutonomyTaskStore(db);
    createTask(store);
    store.recordGateResult({
      taskId: "autonomy-tooling-001",
      actor: "autonomy-gate",
      profile: "contract",
      result: "pass",
      artifactRef: "artifact-001",
    });
    expect(store.get("autonomy-tooling-001")?.status).toBe("verified_done");
    expect(() => store.progress({
      taskId: "autonomy-tooling-001",
      actor: "synapse-pm",
      phase: "implementation",
      nextAction: "run_tests",
    })).toThrow("task is not active");
    expect(db.prepare(`SELECT kind FROM autonomy_events WHERE task_id = ? ORDER BY id`).all("autonomy-tooling-001")).toEqual([
      { kind: "created" }, { kind: "gate_pass" }, { kind: "verified_done" },
    ]);
  });
});
