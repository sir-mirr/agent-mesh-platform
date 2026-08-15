/**
 * `self-reminder.db` — scheduled reminders and their delivery log (SPEC § 3.3).
 *
 * **Two processes write this file**, which is why the schema is here rather
 * than inside the daemon. The scheduler owns the firing loop, but the hub
 * writes rows directly on `mesh.schedule_reminder` (§ 8.5): the daemon may be
 * down when a reminder is scheduled, and a row written now is one it picks up
 * when it returns.
 *
 * It lived inline in the daemon's `main.ts`, so the hub wrote a table it did
 * not declare and could not create. On any state directory where the daemon had
 * not run first, every reminder RPC failed — and nothing noticed, because
 * nothing tested them.
 *
 * Only the hub calls `migrate` in production (SPEC § 3.1), but the daemon calls
 * it too: it may legitimately start first, and the statements are idempotent.
 */

import type { Database } from "bun:sqlite";

export function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('once','cron','interval')),
      schedule_spec TEXT NOT NULL,
      payload TEXT NOT NULL,
      context TEXT,
      idempotency_key TEXT,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active','firing','paused','fired','cancelled','exhausted','dead')),
      next_fire_at DATETIME,
      fire_count INTEGER NOT NULL DEFAULT 0,
      last_fired_at DATETIME,
      created_at DATETIME NOT NULL DEFAULT (datetime('now')),
      updated_at DATETIME NOT NULL DEFAULT (datetime('now')),
      created_by TEXT NOT NULL
    );
  `);

  // Partial, and scoped to `active`: § 8.5's dedup key is unique among a
  // caller's *pending* reminders, so the same key may be reused once the
  // previous one has fired or been cancelled.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_reminders_idem_active
      ON reminders (agent_id, idempotency_key)
      WHERE status = 'active' AND idempotency_key IS NOT NULL;
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_reminders_due
      ON reminders (next_fire_at) WHERE status = 'active' AND next_fire_at IS NOT NULL;
  `);
  // Every read the hub performs is owner-scoped (§ 8.6, § 8.7), so the owner
  // leads the index.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_reminders_owner ON reminders (agent_id, status);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reminder_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      scheduled_at DATETIME NOT NULL,
      fired_at DATETIME NOT NULL DEFAULT (datetime('now')),
      delivery_status TEXT NOT NULL
        CHECK (delivery_status IN ('firing','delivered','queued','failed','skipped','dedup')),
      hub_msg_id TEXT,
      attempt INTEGER NOT NULL DEFAULT 1,
      error TEXT
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_audit_reminder ON audit_log (reminder_id, fired_at);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_audit_agent_time ON audit_log (agent_id, fired_at DESC);
  `);
}

export type ReminderStatus =
  | "active" | "firing" | "paused" | "fired" | "cancelled" | "exhausted" | "dead";

export interface ReminderRow {
  id: string;
  agent_id: string;
  type: "once" | "cron" | "interval";
  schedule_spec: string;
  payload: string;
  context: string | null;
  idempotency_key: string | null;
  status: ReminderStatus;
  next_fire_at: string | null;
  fire_count: number;
  last_fired_at: string | null;
  created_at: string;
  updated_at: string;
  created_by: string;
}
