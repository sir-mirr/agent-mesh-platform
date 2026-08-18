/**
 * Self-reminder scheduler entrypoint.
 *
 * The scheduler keeps reminder payload/context inside the delivery path only;
 * lifecycle and health logs intentionally contain identifiers, counts and error
 * categories rather than reminder content or credentials.
 */
import { createHash } from "node:crypto";

import { checkpointForShutdown, openAt, selfReminderSchema } from "@agent-mesh/store";
import WebSocket from "ws";

import { HubLifecycle, hubErrorCategory } from "./lifecycle";
import { ReminderScheduler } from "./scheduler";

/**
 * One key per (recipient, recovery). The alert text carries `outage_started`,
 * so hashing it keys the retry to the outage rather than to the attempt.
 */
function recoveryAlertKey(recipient: string, content: string): string {
  return createHash("sha256").update(`${recipient} ${content}`).digest("hex").slice(0, 32);
}

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

// `openAt` rather than `new Database` with the two pragmas repeated here. They
// were identical, which is exactly how a second copy stays invisible: WAL and
// `busy_timeout` are what make it safe for the hub to write this same file for
// § 8.5 reminder RPCs, and a copy that drifts drops that without a symptom.
const db = openAt(DB_PATH, { create: true });
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
    //
    // Keyed on the outage it reports, so a retry after a lost response does not
    // page the same operator twice for one recovery.
    lifecycle.request("mesh.send", {
      to: recipient,
      content,
      client_message_id: recoveryAlertKey(recipient, content),
    })
  ),
});

lifecycle.start();
const poll = setInterval(() => {
  void scheduler.advanceDue(lifecycle.isReady(), (reminder, content, clientMessageId) =>
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
    lifecycle.request("mesh.send", { to: reminder.agent_id, content, client_message_id: clientMessageId })
      .catch((error) => {
        log("reminder_delivery_rpc_failed", { reminder_id: reminder.id, error_category: hubErrorCategory(error) });
        throw error;
      }));
}, POLL_MS);

/**
 * Stop without leaving the log behind.
 *
 * This daemon had no signal handler at all, so `systemctl stop` killed it
 * mid-poll and `self-reminder.db-wal` survived every restart. Nothing was lost
 * — the store is written for abrupt death, which is why the `firing` rows are
 * recovered on the way up — but "no data is lost" and "nothing is left" are
 * different claims and only the first one was true.
 *
 * The checkpoint is what folds the log; `close()` alone does not (see
 * `checkpointForShutdown`). The unit sets no `KillSignal` or `TimeoutStopSec`,
 * so this runs under SIGTERM with the systemd default to finish in, and the
 * checkpoint's own budget is 250ms.
 */
function shutdown(signal: string): void {
  log("shutting_down", { signal });
  clearInterval(poll);
  try {
    lifecycle.stop();
  } catch {
    // Stopping a socket that never opened is not a reason to skip the store.
  }
  checkpointForShutdown(db);
  db.close();
  log("shutdown_complete", {});
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

log("scheduler_started", { db_path: DB_PATH, poll_ms: POLL_MS, identity: IDENTITY, overdue_policy: "hold_pending_operator_decision" });
