/**
 * Self-reminder scheduler entrypoint.
 *
 * The scheduler keeps reminder payload/context inside the delivery path only;
 * lifecycle and health logs intentionally contain identifiers, counts and error
 * categories rather than reminder content or credentials.
 */
import { Database } from "bun:sqlite";
import { selfReminderSchema } from "@agent-mesh/store";
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
selfReminderSchema.migrate(db);

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
    // No `from`: this daemon is the sender, so the socket's own identity is
    // correct and stating it again would make the hub treat an ordinary send as
    // a proxied one (§ 8.2).
    lifecycle.request("mesh.send", { to: recipient, content })
  ),
});

lifecycle.start();
setInterval(() => {
  void scheduler.tick(lifecycle.isReady(), (reminder, content) =>
    // **From this daemon, not from the owner.** A fired reminder is sent by the
    // scheduler; the owner scheduled it earlier, which the payload records. It
    // used to claim `from: reminder.agent_id`, which the hub reads as a proxied
    // send — and § 8.2 refuses proxying any identity that holds its own key,
    // because such an identity signs for itself. Every reminder owned by an
    // `ai-*` runtime was therefore refused with -32013 and retried until the
    // overdue hold parked it.
    //
    // Sending as the owner would need entitlement to allow speaking for a
    // key-holding identity, which is the one rule that makes entitlement mean
    // anything. This is also simply truer.
    lifecycle.request("mesh.send", { to: reminder.agent_id, content })
      .catch((error) => {
        log("reminder_delivery_rpc_failed", { reminder_id: reminder.id, error_category: hubErrorCategory(error) });
        throw error;
      }));
}, POLL_MS);

log("scheduler_started", { db_path: DB_PATH, poll_ms: POLL_MS, identity: IDENTITY, overdue_policy: "hold_pending_operator_decision" });
