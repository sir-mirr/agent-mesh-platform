/**
 * The shutdown path folds the logs, and the call it used to rely on does not.
 *
 * `closeDatabases()` has called `db.close()` on the hub's stores for as long as
 * it has existed, and agent-mesh-local-pm's `lsof` of the standing deployment
 * is what made that worth checking: two of four logs folded across a restart
 * and two did not, in an order neither "the last holder closes it" nor "the
 * leaked one stays" predicts. Neither story was the mechanism. The mechanism is
 * that **`close()` closed nothing**, so which logs folded was decided by
 * SQLite's own 1000-page threshold during the run and had nothing to do with
 * shutdown at all — visible in the deployment as a `hub.db` of 4096 bytes, one
 * page, beside 1.5 MB of log it had never checkpointed.
 *
 * The first test here is the contrast, because the fix is only worth its lines
 * if the thing it replaces is genuinely inert. The third is the failure mode:
 * a checkpoint that cannot run must cost a shutdown nothing.
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpointForShutdown } from "./open";

/** A store the way the hub holds one: written, and carrying a live statement. */
function loaded(dir: string) {
  const path = join(dir, "probe.db");
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, blob TEXT)");
  const insert = db.prepare("INSERT INTO t (blob) VALUES (?)");
  insert.run("seed");
  const wal = () => (existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0);
  const fill = (rows = 200) => {
    const payload = "x".repeat(4000);
    for (let i = 0; i < rows; i++) insert.run(payload);
  };
  return { db, path, insert, wal, fill };
}

describe("checkpointForShutdown", () => {
  test("folds a log that close() leaves whole", () => {
    const dir = mkdtempSync(join(tmpdir(), "ckpt-"));
    try {
      const closed = loaded(dir);
      closed.fill();
      const beforeClose = closed.wal();
      closed.db.close();
      // The call the shutdown path used to depend on. It marks the handle
      // closed to JavaScript and leaves the file exactly as it was.
      expect(beforeClose).toBeGreaterThan(500_000);
      expect(closed.wal()).toBe(beforeClose);

      const folded = loaded(mkdtempSync(join(tmpdir(), "ckpt-")));
      folded.fill();
      const beforeCheckpoint = folded.wal();
      checkpointForShutdown(folded.db);
      expect(beforeCheckpoint).toBeGreaterThan(500_000);
      expect(folded.wal()).toBe(0);
      // And the pages arrived somewhere rather than being dropped.
      expect(statSync(folded.path).size).toBeGreaterThan(500_000);
      folded.db.close();
      rmSync(folded.path, { force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("leaves the handle usable, because § 8.9 still writes after it", () => {
    const dir = mkdtempSync(join(tmpdir(), "ckpt-"));
    try {
      const s = loaded(dir);
      s.fill();
      checkpointForShutdown(s.db);
      expect(() => s.insert.run("after the checkpoint")).not.toThrow();
      expect((s.db.prepare("SELECT count(*) AS n FROM t").get() as { n: number }).n).toBe(202);
      s.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does nothing, quietly, when a reader is pinning the log", () => {
    const dir = mkdtempSync(join(tmpdir(), "ckpt-"));
    try {
      const s = loaded(dir);
      // The snapshot is taken before the writes it must not see, which is what
      // makes those frames unremovable rather than merely inconvenient.
      const reader = new Database(s.path, { readonly: true });
      reader.exec("BEGIN");
      reader.prepare("SELECT count(*) FROM t").get();

      s.fill();
      const before = s.wal();
      const started = Bun.nanoseconds();
      expect(() => checkpointForShutdown(s.db, 0)).not.toThrow();
      const elapsedMs = (Bun.nanoseconds() - started) / 1e6;

      // Refused, not waited on: a shutdown must not hang behind another
      // process's reader, and a log that stays large costs one more run.
      expect(s.wal()).toBeGreaterThanOrEqual(before);
      expect(elapsedMs).toBeLessThan(100);

      reader.exec("COMMIT");
      reader.close();
      s.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
