/**
 * `self-reminder.db`'s schema, which nothing had run (SPEC § 3.3).
 *
 * It read `0.00%` — and `0` has three meanings. Not dead: `hub/src/db.ts` and
 * the daemon's `main.ts` both import it. Not outside the instrument: the module
 * is in the coverage report at all, and a file nobody imports is absent rather
 * than zero. It is the third case, the ordinary one — **reachable, and nothing
 * reached it**: the hub calls `migrate` from inside `srDb()`, a lazy getter no
 * measured suite had ever called.
 *
 * The decisions worth pinning are the ones a `CREATE TABLE` cannot explain to
 * the next reader. The dedup index is partial and scoped to `active`, so a key
 * may be reused once the reminder it belonged to has fired or been cancelled —
 * that is § 8.5's rule, written as an index, and it is the kind of thing that
 * survives a careless "make it unique" refactor only if something asserts it.
 *
 * The type union beside the table is checked against the table's own `CHECK`
 * list here, because nothing else can: TypeScript erases at compile time and
 * SQLite has never heard of it, so the two drift silently in either direction.
 *
 * Its own database in its own directory, opened directly. Nothing here touches
 * the `const` handles in `hub/src/db.ts`, so removing this directory cannot
 * leave a later caller with `SQLITE_IOERR`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { openAt } from "../open";
import { migrate } from "./self-reminder";

const dir = mkdtempSync(join(tmpdir(), "self-reminder-schema-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
/** A database this file owns, migrated. */
function fresh() {
  const db = openAt(join(dir, `sr-${++n}.db`), { create: true });
  migrate(db);
  return db;
}

const reminder = (over: Record<string, unknown> = {}) => ({
  id: `r-${++n}`,
  agent_id: "owner",
  type: "once",
  schedule_spec: "2026-01-01T00:00:00Z",
  payload: "{}",
  idempotency_key: null,
  status: "active",
  created_by: "owner",
  ...over,
});

const insert = (db: ReturnType<typeof fresh>, row: Record<string, unknown>) =>
  db
    .prepare(
      `INSERT INTO reminders (id, agent_id, type, schedule_spec, payload, idempotency_key, status, created_by)
       VALUES ($id, $agent_id, $type, $schedule_spec, $payload, $idempotency_key, $status, $created_by)`,
    )
    .run(Object.fromEntries(Object.entries(row).map(([k, v]) => [`$${k}`, v as any])));

describe("what migrate creates", () => {
  test("both tables, on a directory where neither process has run", () => {
    const db = fresh();
    const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
      .map((r) => r.name);
    expect(names).toContain("reminders");
    expect(names).toContain("audit_log");
  });

  /**
   * The hub calls this in production and the daemon calls it too, because
   * either may legitimately start first. That is only true if running it twice
   * is harmless — and it was inline in the daemon once, so the hub wrote a
   * table it could not create and every reminder RPC failed on a directory the
   * daemon had not touched.
   */
  test("and running it again changes nothing", () => {
    const path = join(dir, `idem-${++n}.db`);
    const first = openAt(path, { create: true });
    migrate(first);
    insert(first, reminder({ id: "survivor" }));
    migrate(first);
    expect(first.prepare(`SELECT id FROM reminders`).all()).toEqual([{ id: "survivor" }]);
  });

  test("the indexes the reads are shaped around", () => {
    const db = fresh();
    const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as Array<{ name: string }>)
      .map((r) => r.name);
    for (const idx of [
      "idx_reminders_idem_active",
      "idx_reminders_due",
      "idx_reminders_owner",
      "idx_audit_reminder",
      "idx_audit_agent_time",
    ]) {
      expect(names).toContain(idx);
    }
  });
});

describe("the dedup key is unique among pending reminders, not for ever", () => {
  /** § 8.5: unique among a caller's *active* ones. */
  test("two active reminders may not share a key", () => {
    const db = fresh();
    insert(db, reminder({ idempotency_key: "k" }));
    expect(() => insert(db, reminder({ idempotency_key: "k" }))).toThrow();
  });

  /**
   * The reuse the partial index exists for. A caller whose reminder has fired
   * may schedule another with the same key — otherwise a daily job could be
   * scheduled once and never again.
   */
  test("but the key is free once the first has fired or been cancelled", () => {
    for (const done of ["fired", "cancelled", "exhausted", "dead"]) {
      const db = fresh();
      insert(db, reminder({ idempotency_key: "k" }));
      db.prepare(`UPDATE reminders SET status = ? WHERE idempotency_key = 'k'`).run(done);
      expect(() => insert(db, reminder({ idempotency_key: "k" }))).not.toThrow();
    }
  });

  /** Two callers are two scopes; the index leads with the owner. */
  test("and two owners may hold the same key at once", () => {
    const db = fresh();
    insert(db, reminder({ agent_id: "a", idempotency_key: "k" }));
    expect(() => insert(db, reminder({ agent_id: "b", idempotency_key: "k" }))).not.toThrow();
  });

  /**
   * `NULL` is excluded from the index on purpose. Without that clause SQLite
   * would still allow the rows — NULLs do not collide — but the index would
   * carry every keyless reminder for nothing.
   */
  test("and reminders with no key do not collide with each other", () => {
    const db = fresh();
    insert(db, reminder({ idempotency_key: null }));
    expect(() => insert(db, reminder({ idempotency_key: null }))).not.toThrow();
  });
});

describe("the columns refuse what they are not for", () => {
  test("a schedule type outside the three", () => {
    const db = fresh();
    expect(() => insert(db, reminder({ type: "eventually" }))).toThrow();
    for (const type of ["once", "cron", "interval"]) {
      expect(() => insert(db, reminder({ type }))).not.toThrow();
    }
  });

  test("a status outside the seven", () => {
    const db = fresh();
    expect(() => insert(db, reminder({ status: "asleep" }))).toThrow();
  });

  test("a delivery status outside the six", () => {
    const db = fresh();
    const log = (status: string) =>
      db.prepare(
        `INSERT INTO audit_log (reminder_id, agent_id, scheduled_at, delivery_status)
         VALUES ('r', 'owner', datetime('now'), ?)`,
      ).run(status);
    expect(() => log("lost")).toThrow();
    for (const status of ["firing", "delivered", "queued", "failed", "skipped", "dedup"]) {
      expect(() => log(status)).not.toThrow();
    }
  });

  test("and fills in what a caller need not supply", () => {
    const db = fresh();
    insert(db, reminder({ id: "defaults" }));
    const row = db.prepare(`SELECT status, fire_count, created_at, updated_at FROM reminders WHERE id = 'defaults'`)
      .get() as Record<string, unknown>;
    expect(row.status).toBe("active");
    expect(row.fire_count).toBe(0);
    expect(typeof row.created_at).toBe("string");
    expect(typeof row.updated_at).toBe("string");
  });
});

/**
 * The union and the constraint are two statements of one fact, in two languages
 * neither of which can see the other. TypeScript erases before SQLite runs, so
 * adding a status to one and not the other compiles, migrates, and fails at the
 * first row that uses it.
 */
describe("the exported union and the table agree", () => {
  const source = readFileSync(join(dirname(new URL(import.meta.url).pathname), "self-reminder.ts"), "utf8");

  /** The `CHECK (status IN (...))` list, read out of the statement itself. */
  const checkList = (column: string): string[] => {
    const m = source.match(new RegExp(`CHECK \\(${column} IN \\(([^)]*)\\)\\)`));
    expect(m).not.toBeNull();
    return [...m![1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!).sort();
  };

  test("every ReminderStatus is a status the table accepts, and the reverse", () => {
    const union = [...source.matchAll(/export type ReminderStatus =([\s\S]*?);/g)]
      .flatMap((m) => [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!))
      .sort();
    expect(union.length).toBeGreaterThan(0);
    expect(union).toEqual(checkList("status"));
  });

  test("and the row type's schedule types match theirs", () => {
    const m = source.match(/type: "once" \| "cron" \| "interval";/);
    expect(m).not.toBeNull();
    expect(checkList("type")).toEqual(["cron", "interval", "once"]);
  });
});
