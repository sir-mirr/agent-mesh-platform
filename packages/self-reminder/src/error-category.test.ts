/**
 * The category recorded for a failure is the one that happened.
 *
 * **Three sites hardcoded `"hub_rpc_failed"` and discarded the error.** That
 * string is what `hubErrorCategory` returns when it has *nothing better* — so
 * the one case the constant was right for is the case where the real answer was
 * unavailable anyway, and in every other case it overwrote an answer that was
 * there. An entitlement refusal, a schema rejection and a local `TypeError`
 * were all filed as a hub RPC failure.
 *
 * One of the three is read back and shown to a person. `advanceDue` wrote the
 * constant into `last_hub_error_category`; `onHubRegistered` reads that key and
 * puts it in the recovery alert as `last_error_category=`. So an operator asking
 * why the outage happened was answered with a constant, and a fabricated
 * category that reaches a human is worse than one merely written down, because
 * it is the one that gets acted on.
 *
 * Nothing could have caught it: `HubRpcError` was not exported, so no test
 * could construct the case where the category is interesting. A helper that
 * reads a class the caller cannot build has exactly one testable branch, and it
 * is the fallback.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { HubRpcError } from "./lifecycle";
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
  db.prepare(
    `INSERT INTO reminders (id, agent_id, type, schedule_spec, payload, context, status, next_fire_at, created_by)
     VALUES ('r1', 'agent-a', 'once', '{}', 'body', '{}', 'active', '2026-07-13 23:59:40', 'agent-a')`,
  ).run();
  return db;
}

/** The failed row, not the `firing` one written before the hub is called. */
const errorOf = (db: Database) =>
  (db.prepare(`SELECT error FROM audit_log WHERE reminder_id = 'r1' AND delivery_status = 'failed'`).get() as { error: string } | null)?.error;

/** Fire once, with the hub call rejecting as given. */
async function fireRejecting(db: Database, rejection: unknown) {
  const now = new Date("2026-07-14T00:00:00.000Z");
  const scheduler = new ReminderScheduler(db, {
    now: () => now,
    overdueHoldMs: 60_000,
    stalledAfterMs: 60_000,
    stallLogIntervalMs: 60_000,
    recoveryAlertRecipients: [],
  });
  await scheduler.advanceDue(true, async () => { throw rejection; });
  return scheduler;
}

describe("a reminder the hub refused", () => {
  test("records the hub's own category, not a constant", async () => {
    const db = testDb();
    await fireRejecting(db, new HubRpcError("not entitled to send as agent-a", "not_entitled"));

    expect(errorOf(db), "the refusal's category was replaced by a constant").toBe("not_entitled");
  });

  test("and the same category is what a later recovery alert quotes", async () => {
    // The read-back. `last_hub_error_category` is written by the fire path and
    // read by the recovery alert, so a constant written here is a constant a
    // person is told later — the only one of the three sites whose output
    // leaves the process.
    const db = testDb();
    const scheduler = new ReminderScheduler(db, {
      now: () => new Date("2026-07-14T00:00:00.000Z"),
      overdueHoldMs: 60_000,
      stalledAfterMs: 60_000,
      stallLogIntervalMs: 60_000,
      recoveryAlertRecipients: ["ops"],
    });
    scheduler.setConnectivity("unavailable", "hub_unavailable");
    await scheduler.advanceDue(true, async () => {
      throw new HubRpcError("recipient torn down", "recipient_deleted");
    });

    const alerts: string[] = [];
    await scheduler.onHubRegistered(async (_to, content) => { alerts.push(content); return {}; });

    expect(alerts, "no recovery alert was sent, so this proves nothing").toHaveLength(1);
    expect(alerts[0], "the operator was told a category that did not happen")
      .toContain("last_error_category=recipient_deleted");
  });

  test("an error with no category still reports the fallback", async () => {
    // The half that keeps the assertions above honest. `hub_rpc_failed` is
    // correct when there is nothing better — a local `TypeError` is not a hub
    // refusal and has no category to preserve — and a fix that dropped the
    // fallback would leave `undefined` in the audit row.
    const db = testDb();
    await fireRejecting(db, new TypeError("cannot read properties of undefined"));

    expect(errorOf(db)).toBe("hub_rpc_failed");
  });
});

describe("delivering the recovery alert itself", () => {
  test("reports the category of the failure that stopped it", async () => {
    // The third site. It reaches only a log line, which is why it survived
    // longest: nothing downstream reads it, so nothing downstream could be
    // wrong in a way anybody noticed.
    const db = testDb();
    const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const scheduler = new ReminderScheduler(db, {
      now: () => new Date("2026-07-14T00:00:00.000Z"),
      overdueHoldMs: 60_000,
      stalledAfterMs: 60_000,
      stallLogIntervalMs: 60_000,
      recoveryAlertRecipients: ["ops"],
      log: (event: string, fields: Record<string, unknown>) => { logs.push({ event, fields }); },
    } as any);
    scheduler.setConnectivity("unavailable", "hub_unavailable");

    await scheduler.onHubRegistered(async () => {
      throw new HubRpcError("no egress rule", "egress_denied");
    });

    const failed = logs.find((l) => l.event === "scheduler_recovery_alert_delivery_failed");
    expect(failed, "the alert delivery did not fail, so this proves nothing").toBeDefined();
    expect(failed!.fields.error_category).toBe("egress_denied");
  });
});
