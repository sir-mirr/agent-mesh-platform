/**
 * A destructive migration refuses a database it was not written for.
 *
 * `0002_drop_autonomy_tables.sql` is `DROP ... IF EXISTS` throughout, which is
 * deliberate: it must be a no-op on a self-reminder database created after the
 * feature was removed. The cost is that **pointing it at the wrong database
 * completed with exit 0 having done nothing**, and that is indistinguishable
 * from the intended no-op — so an operator who ran it against `hub.db` had
 * every reason to believe the migration had run.
 *
 * The header says the target is `self-reminder.db` and not `hub.db`. A comment
 * is not a guard: it is read by the person who already knows.
 *
 * `reminders` is the table `self-reminder.db` always has and no other database
 * here does, so a temp table with a CHECK on that count stops the run instead
 * of reporting success.
 *
 * Both directions, because a guard that refused everything would satisfy the
 * refusal and quietly stop the migration from ever being applicable — and it is
 * a migration, so nobody would find out until the tables were still there.
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { openTestDb } from "./harness";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runChild } from "./child-output.ts";

const MIGRATION = join(import.meta.dir, "..", "ops", "migrations", "0002_drop_autonomy_tables.sql");

/**
 * Apply the file the way the header tells an operator to.
 *
 * Through `sqlite3` rather than `db.exec`, because the guard's effect is on the
 * run — the exit status and the error a person sees — and running the
 * statements another way would test a different thing than the documented one.
 */
async function apply(dbPath: string) {
  const sql = await Bun.file(MIGRATION).text();
  // Read from files, not pipes: `new Response(child.stdout).text()` threw
  // `EBADF: bad file descriptor` out of a reader in CI and failed a test whose
  // child had run correctly. See `test/child-output.ts`.
  const ran = await runChild(["sqlite3", dbPath], { stdin: sql });
  return { code: ran.code, stderr: ran.stderr };
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "agent-mesh-migration-"));
}

describe("0002 drop autonomy tables", () => {
  test("refuses a database that is not self-reminder.db", async () => {
    const dir = scratch();
    try {
      const path = join(dir, "hub.db");
      const db = openTestDb(path);
      db.exec(`CREATE TABLE messages (id TEXT PRIMARY KEY)`);
      db.close();

      const { code, stderr } = await apply(path);

      expect(code, "the wrong database was migrated successfully, having done nothing").not.toBe(0);
      expect(stderr).toContain("CHECK constraint failed");

      // And it left the database alone.
      const after = openTestDb(path, { readonly: true });
      const tables = (after.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>)
        .map((r) => r.name);
      after.close();
      expect(tables).toContain("messages");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test("drops the autonomy tables on a self-reminder database", async () => {
    // The half that keeps the refusal honest. A guard that rejected every
    // database would pass the test above and stop this file from ever applying
    // — and a migration that never runs is discovered when the tables are still
    // there, which is much later.
    const dir = scratch();
    try {
      const path = join(dir, "self-reminder.db");
      const db = openTestDb(path);
      db.exec(`
        CREATE TABLE reminders (id TEXT PRIMARY KEY);
        CREATE TABLE autonomy_tasks (id TEXT PRIMARY KEY);
        CREATE TABLE autonomy_events (id TEXT PRIMARY KEY);
      `);
      db.prepare(`INSERT INTO autonomy_tasks (id) VALUES ('t1')`).run();
      db.close();

      const { code, stderr } = await apply(path);
      expect(code, stderr).toBe(0);

      const after = openTestDb(path, { readonly: true });
      const tables = (after.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>)
        .map((r) => r.name);
      after.close();

      expect(tables).toContain("reminders");
      expect(tables, "the migration did not drop what it exists to drop").not.toContain("autonomy_tasks");
      expect(tables).not.toContain("autonomy_events");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test("is still a no-op on a self-reminder database that never had them", async () => {
    // The idempotence the `IF EXISTS` clauses are for, which the guard must not
    // have taken away: this is the case every database created after the
    // removal commit is in.
    const dir = scratch();
    try {
      const path = join(dir, "self-reminder.db");
      const db = openTestDb(path);
      db.exec(`CREATE TABLE reminders (id TEXT PRIMARY KEY)`);
      db.close();

      const { code, stderr } = await apply(path);
      expect(code, stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
