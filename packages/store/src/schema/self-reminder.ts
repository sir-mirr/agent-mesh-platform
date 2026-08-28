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
  migrateSchedulerState(db);
}

/**
 * The scheduler's own state tables (SPEC § 3.3, D-810).
 *
 * Exported separately because `ReminderScheduler` calls only this: its unit
 * tests build a `reminders` table by hand, and running the full `migrate` over
 * one would try to index a column that fixture does not have. Splitting keeps
 * one DDL per table without making the scheduler own a schema it does not.
 */
export function migrateSchedulerState(db: Database): void {
  //
  // **Moved here for the reason the header above already gives.** These three
  // lived in `ReminderScheduler`'s private `migrate()`, so they existed only
  // where the daemon had run — and `reminders` and `audit_log` were moved here
  // after exactly that shape broke the hub's reminder RPCs on a directory the
  // daemon had not touched.
  //
  // D-810 puts an admin route on `agent-mesh-http` over `overdue_decisions` and
  // the hold state, which makes it three processes reading tables one of them
  // declared privately. A route asking "what is held?" against a daemonless
  // directory would have got `no such table`, and a route that turned that into
  // an empty page would report a healthy mesh — `부재≠성공` in the direction
  // that matters least to notice and most to get wrong.
  db.exec(`
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
    CREATE INDEX IF NOT EXISTS idx_scheduler_events_type_time
      ON scheduler_events(event_type, created_at DESC);
    -- Keyed on the slot, not the reminder: a decision is about the fire that
    -- was missed, and a repeating id would let one decision answer for a slot
    -- the operator never saw.
    CREATE TABLE IF NOT EXISTS overdue_decisions (
      reminder_id TEXT NOT NULL,
      scheduled_at DATETIME NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN ('replay','skip')),
      approval_ref TEXT NOT NULL,
      decided_at DATETIME NOT NULL,
      PRIMARY KEY (reminder_id, scheduled_at)
    );
  `);

  // `decided_by` — D-810. Who made the call, not just that a call was made.
  //
  // Added rather than declared inline above so a database written before this
  // gains it: `CREATE TABLE IF NOT EXISTS` would skip the existing table and
  // leave the column absent, which is the silence this file has already been
  // caught by twice.
  //
  // Nullable, and deliberately: rows written before the column existed have no
  // decider, and inventing one — the service, the first admin, anybody — would
  // put a name against a decision that person did not make. `null` here means
  // *recorded before deciders were recorded*, which is a true statement.
  const decisions = db.prepare(`PRAGMA table_info(overdue_decisions)`).all() as Array<{ name: string }>;
  if (!decisions.some((c) => c.name === "decided_by")) {
    db.exec(`ALTER TABLE overdue_decisions ADD COLUMN decided_by TEXT`);
  }
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
