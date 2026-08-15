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

BEGIN;

DROP INDEX IF EXISTS idx_autonomy_events_task_time;
DROP INDEX IF EXISTS idx_autonomy_tasks_status_progress;

DROP TABLE IF EXISTS autonomy_events;
DROP TABLE IF EXISTS autonomy_tasks;

COMMIT;

-- Reclaim the freed pages. Must run outside the transaction above.
VACUUM;
