-- 0002_drop_autonomy_tables.sql
--
-- Target DB: `self-reminder.db` (NOT `hub.db`).
--
-- Drops the `autonomy_tasks` / `autonomy_events` tables and their indexes.
-- These were created by the `AutonomyTaskStore` constructor inside
-- `ReminderScheduler` and driven live from the scheduler tick, so an existing
-- lab/production `self-reminder.db` MAY hold real task and event rows. The PM
-- autonomy feature has been removed from this repository; these tables are the
-- residue left in already-provisioned databases.
--
-- Idempotent: `DROP ... IF EXISTS` is a no-op on a DB that never carried the
-- tables (any self-reminder DB created after the removal commit).
--
-- DESTRUCTIVE. Rollback:
--   None. Operators MUST take a DB copy before running this file if the task
--   history has any audit value; recovery afterwards is restore-from-backup
--   only. Suggested pre-check:
--     sqlite3 <db> "SELECT count(*) FROM autonomy_tasks;"
--     sqlite3 <db> "SELECT count(*) FROM autonomy_events;"
--
-- Apply (adjust the path to match SELF_REMINDER_DB / AGENT_MESH_STATE_DIR):
--   sqlite3 /srv/agent-mesh-lab/state/shared/self-reminder.db \
--     < ops/migrations/0002_drop_autonomy_tables.sql
--
-- Pointing this at the wrong database is refused rather than reported as a
-- no-op; see the guard below. Measured both ways, with and without `-bail`:
--   wrong database   Runtime error ... CHECK constraint failed  → exit 1
--   self-reminder.db autonomy tables dropped, `reminders` kept  → exit 0

-- Refuse a database that is not `self-reminder.db`.
--
-- Every statement below is `IF EXISTS`, so pointing this file at `hub.db` — or
-- at any other database — completed with exit 0 having done nothing, which is
-- indistinguishable from the intended no-op on an already-migrated database.
-- An operator would have every reason to believe the migration had run.
--
-- `reminders` is the table `self-reminder.db` always has and no other database
-- here does. The CHECK fails when the count is 0, so the run stops with
-- `CHECK constraint failed` instead of reporting success.
CREATE TEMP TABLE _target_check (is_self_reminder INTEGER CHECK (is_self_reminder = 1));
INSERT INTO _target_check (is_self_reminder)
  SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'reminders';

BEGIN;

DROP INDEX IF EXISTS idx_autonomy_events_task_time;
DROP INDEX IF EXISTS idx_autonomy_tasks_status_progress;

DROP TABLE IF EXISTS autonomy_events;
DROP TABLE IF EXISTS autonomy_tasks;

COMMIT;

-- Reclaim the freed pages. Must run outside the transaction above.
VACUUM;
