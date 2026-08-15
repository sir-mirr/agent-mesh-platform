/**
 * Self-reminder scheduler entrypoint.
 *
 * The scheduler keeps reminder payload/context inside the delivery path only;
 * lifecycle and health logs intentionally contain identifiers, counts and error
 * categories rather than reminder content or credentials.
 */
import { Database } from "bun:sqlite";
import WebSocket from "ws";

import { HubLifecycle, hubErrorCategory } from "./lifecycle";
import { ReminderScheduler } from "./scheduler";

const STATE_DIR = process.env.AGENT_MESH_STATE_DIR ?? "/srv/agent-mesh-lab/state/shared";
const DB_PATH = process.env.SELF_REMINDER_DB ?? `${STATE_DIR}/self-reminder.db`;
const HUB_URL = process.env.HUB_URL ?? process.env.AGENT_MESH_HUB_URL ?? "ws://127.0.0.1:3100/ws";
const IDENTITY = process.env.SELF_REMINDER_IDENTITY ?? "self-reminder";
const POLL_MS = Number(process.env.SELF_REMINDER_POLL_MS ?? 1000);
const OVERDUE_HOLD_MS = Number(process.env.SELF_REMINDER_OVERDUE_HOLD_MS ?? 5 * 60_000);
const STALLED_AFTER_MS = Number(process.env.SELF_REMINDER_STALLED_AFTER_MS ?? 5 * 60_000);
// Deployment-specific. Unset means recovery alerts are recorded but not sent.
const RECOVERY_ALERT_RECIPIENTS = (process.env.SELF_REMINDER_RECOVERY_ALERT_RECIPIENTS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(`[self-reminder ${new Date().toISOString()}] ${event}`, JSON.stringify(fields));
}

const db = new Database(DB_PATH, { create: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA busy_timeout = 5000;");
db.exec(`
  CREATE TABLE IF NOT EXISTS reminders (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, type TEXT NOT NULL CHECK (type IN ('once','cron','interval')),
    schedule_spec TEXT NOT NULL, payload TEXT NOT NULL, context TEXT, idempotency_key TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','firing','paused','fired','cancelled','exhausted','dead')),
    next_fire_at DATETIME, fire_count INTEGER NOT NULL DEFAULT 0, last_fired_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT (datetime('now')), updated_at DATETIME NOT NULL DEFAULT (datetime('now')),
    created_by TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_reminders_idem_active ON reminders (agent_id, idempotency_key) WHERE status = 'active' AND idempotency_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders (next_fire_at) WHERE status = 'active' AND next_fire_at IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_reminders_owner ON reminders (agent_id, status);
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, reminder_id TEXT NOT NULL, agent_id TEXT NOT NULL,
    scheduled_at DATETIME NOT NULL, fired_at DATETIME NOT NULL DEFAULT (datetime('now')),
    delivery_status TEXT NOT NULL CHECK (delivery_status IN ('firing','delivered','queued','failed','skipped','dedup')),
    hub_msg_id TEXT, attempt INTEGER NOT NULL DEFAULT 1, error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_audit_reminder ON audit_log (reminder_id, fired_at);
  CREATE INDEX IF NOT EXISTS idx_audit_agent_time ON audit_log (agent_id, fired_at DESC);
`);

const recovered = db.prepare(`UPDATE reminders SET status = 'active', updated_at = datetime('now') WHERE status = 'firing'`).run();
if (recovered.changes > 0) log("recovered_stuck_firing_rows", { count: recovered.changes });

const scheduler = new ReminderScheduler(db, {
  overdueHoldMs: OVERDUE_HOLD_MS,
  stalledAfterMs: STALLED_AFTER_MS,
  recoveryAlertRecipients: RECOVERY_ALERT_RECIPIENTS,
  log,
});

let lifecycle: HubLifecycle;
lifecycle = new HubLifecycle({
  createSocket: () => new WebSocket(HUB_URL),
  identity: IDENTITY,
  log,
  onConnectivityState: (state) => scheduler.setConnectivity(state),
  onUnavailable: (category) => scheduler.setConnectivity("unavailable", category),
  onRegistered: () => scheduler.onHubRegistered((recipient, content) =>
    lifecycle.request("mesh.send", { from: IDENTITY, to: recipient, content })
  ),
});

lifecycle.start();
setInterval(() => {
  void scheduler.tick(lifecycle.isReady(), (reminder, content) =>
    lifecycle.request("mesh.send", { from: reminder.agent_id, to: reminder.agent_id, content })
      .catch((error) => {
        log("reminder_delivery_rpc_failed", { reminder_id: reminder.id, error_category: hubErrorCategory(error) });
        throw error;
      }));
}, POLL_MS);

log("scheduler_started", { db_path: DB_PATH, poll_ms: POLL_MS, identity: IDENTITY, overdue_policy: "hold_pending_operator_decision" });
