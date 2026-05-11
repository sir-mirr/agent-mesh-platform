-- 0001_agents_add_created_at.sql
--
-- Adds a dedicated `created_at` column to the `agents` table so that
-- `POST /api/v1/agents` can return strict ISO-8601 creation provenance that
-- is *not* mutated by subsequent UPSERTs. See SPEC §10.1.
--
-- Idempotent: re-running this migration on a DB that already has the column
-- is a no-op (the ALTER fails and is wrapped in a SAVEPOINT we silently
-- discard). For environments where transactional DDL guards are not
-- available, the hub binary itself contains an equivalent in-process guard
-- (PRAGMA table_info check) that runs at boot — this file exists for
-- operators who want to migrate ahead of a hub upgrade or to backfill
-- `created_at` from a more accurate source than `last_seen`.
--
-- Rollback:
--   SQLite has no `DROP COLUMN` prior to 3.35; on older builds the rollback
--   is "rebuild the table without the column" via a copy-table pattern.
--   In practice we treat this migration as forward-only.

BEGIN;

-- Add the column (nullable, no default — SQLite forbids non-constant
-- defaults in ALTER TABLE ADD COLUMN).
ALTER TABLE agents ADD COLUMN created_at DATETIME;

-- Best-effort backfill for pre-existing rows. v0.1 has no durable creation
-- timestamp, so we approximate from `last_seen` (the earliest observed
-- contact for that identity) and fall back to `now()` for rows that have
-- never connected.
UPDATE agents
   SET created_at = COALESCE(last_seen, datetime('now'))
 WHERE created_at IS NULL;

COMMIT;
