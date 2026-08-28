/**
 * Which tables `self-reminder.db` actually has after the store declares it
 * (SPEC § 3.3, T-053).
 *
 * This file's sibling header records the defect once already: the schema
 * *lived inline in the daemon's `main.ts`, so the hub wrote a table it did not
 * declare and could not create*, and on any state directory where the daemon
 * had not run first every reminder RPC failed with nothing noticing. Moving
 * `reminders` and `audit_log` here fixed it for the hub.
 *
 * **Three tables had not moved.** `scheduler_health`, `scheduler_events` and
 * `overdue_decisions` were created by `ReminderScheduler`'s own private
 * `migrate()`, so they existed only where the daemon had run. That was
 * invisible while the daemon was their only reader — and D-810 puts an admin
 * route on two of them, which made it the same defect with a third process in
 * it. They are declared here now, and the scheduler calls this rather than
 * keeping a second copy: `CREATE TABLE IF NOT EXISTS` is silent about a table
 * that already exists in a different shape, so two DDLs for one file drift with
 * nothing able to notice.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openAt } from "../open";
import { migrate } from "./self-reminder";

const dirs: string[] = [];
const freshDb = () => {
  const dir = mkdtempSync(join(tmpdir(), "sr-tables-"));
  dirs.push(dir);
  const db = openAt(join(dir, "self-reminder.db"), { create: true });
  migrate(db);
  return db;
};

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const tablesOf = (db: ReturnType<typeof freshDb>): string[] =>
  (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
    .map((r) => r.name)
    .filter((n) => !n.startsWith("sqlite_"))
    .sort();

describe("what a state directory has before the daemon runs", () => {
  test("[T-053] the operator tables are among them", () => {
    // A deployment where the hub started first and the scheduler has not: the
    // store's `migrate` is what has run, and it is the only DDL an admin route
    // on `agent-mesh-http` can rely on.
    //
    // This asserted the opposite an hour ago, and the flip is the point. The
    // three were declared inside `ReminderScheduler`'s private `migrate()`, so
    // they existed only where the daemon had run — invisible while the daemon
    // was their only reader, and a defect the moment D-810 put a route on them.
    const db = freshDb();
    const tables = tablesOf(db);
    console.log(`[T-053] store-declared tables: ${tables.join(" ")}`);

    expect(tables).toEqual([
      "audit_log",
      "overdue_decisions",
      "reminders",
      "scheduler_events",
      "scheduler_health",
    ]);
  });

  test("[T-053] so an empty hold list means nothing is held, rather than nothing declared it", () => {
    // **The distinction a route depends on.** An operator screen asking "what
    // is held?" against a directory the scheduler has never touched used to get
    // `no such table`; a route turning that into an empty page would have
    // reported a healthy mesh. Now the table is there and empty, so the empty
    // answer is the true one.
    //
    // Both halves asserted: it reads, and it reads as empty. A query that threw
    // would fail the first; one answering rows on a fresh directory would fail
    // the second and mean the fixture had leaked.
    const db = freshDb();
    const held = db.prepare(`SELECT * FROM overdue_decisions`).all();
    expect(held).toEqual([]);

    // And the decision it will hold round-trips, including the slot key that
    // makes a decision belong to one fire rather than to the reminder.
    db.prepare(
      `INSERT INTO overdue_decisions (reminder_id, scheduled_at, decision, approval_ref, decided_at)
       VALUES ('r1', '2026-07-14 09:00:00', 'replay', 'APPROVED:ops-12', '2026-07-14T10:00:00.000Z')`,
    ).run();
    expect(db.prepare(`SELECT count(*) AS c FROM overdue_decisions`).get()).toEqual({ c: 1 });

    // The CHECK is the store's, not the daemon's, now that the DDL is here.
    expect(() =>
      db.prepare(
        `INSERT INTO overdue_decisions (reminder_id, scheduled_at, decision, approval_ref, decided_at)
         VALUES ('r2', '2026-07-14 09:00:00', 'maybe', 'APPROVED:ops-13', '2026-07-14T10:00:00.000Z')`,
      ).run(),
    ).toThrow(/CHECK constraint/i);
  });
  test("[T-053] the scheduler's own fixture builds a `reminders` this schema would not", () => {
    // **Found by moving the DDL.** `ReminderScheduler`'s constructor migrates,
    // and pointing it at the store's full `migrate` made 26 of its unit tests
    // fail with `no such column: idempotency_key` — because
    // `scheduler.test.ts` builds `reminders` by hand and that copy has drifted
    // from the real one. Measured, it is short two columns rather than the one
    // the error named: `created_at` is missing as well, and nothing had failed
    // over it because nothing in those tests reads it.
    //
    // `CREATE TABLE IF NOT EXISTS` is what hid it: the statement is silent
    // about a table that already exists in a different shape, so the fixture
    // won every time and nothing compared them. The scheduler now migrates only
    // its own three tables, which is the right layering anyway — but the drift
    // is real and this is what says so.
    //
    // Named as a gap, with the columns listed, so closing it is a diff rather
    // than an investigation.
    const db = freshDb();
    const columns = (
      db.prepare(`PRAGMA table_info(reminders)`).all() as Array<{ name: string }>
    ).map((c) => c.name).sort();

    const fixture = readFileSync(`${import.meta.dir}/../../../self-reminder/src/scheduler.test.ts`, "utf8");
    const missing = columns.filter((c) => !new RegExp(`\\b${c}\\b`).test(fixture));
    console.log(`[T-053] store columns absent from the scheduler fixture: ${missing.join(" ") || "none"}`);

    // The floor: the fixture must still build the table at all, or this reads
    // "no drift" for the wrong reason.
    expect(fixture, "the fixture no longer creates reminders").toContain("CREATE TABLE");
    expect(columns.length, "no columns were read from the store's table").toBeGreaterThan(5);
    expect(
      missing,
      `the fixture caught up — drop this check and let the scheduler migrate through the store instead`,
    ).toEqual(["created_at", "idempotency_key"]);
  });
});
