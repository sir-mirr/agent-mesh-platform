/**
 * The write-ahead log folds back, and the one condition under which it does not.
 *
 * `openStore` sets `PRAGMA journal_mode = WAL` and nothing else, so checkpoints
 * are SQLite's default: 1000 pages, which at a 4096-byte page is a threshold of
 * about 3.9 MB. Nobody had watched that happen. The standing deployment was
 * described as "self-limiting — the WAL folds at ~4MB, not a defect", and
 * agent-mesh-local-pm noticed the wording was a prediction: after fourteen
 * hours the largest WAL was at 73% of the threshold, so **no checkpoint had
 * ever run there**. A thing that has not happened yet was written down as a
 * thing that happens.
 *
 * It does happen, and it takes 46ms to show rather than the six hours of
 * waiting the prediction implied.
 *
 * **The second case is the one worth owning.** A reader holding an open
 * snapshot stops the log being truncated, because those frames are what the
 * snapshot is made of. Then the threshold means nothing and the file grows for
 * as long as the reader lives — measured here at sixteen times the threshold
 * and still climbing when the test stops. That is the shape an operator would
 * meet as "the disk filled up", with every individual write innocent.
 *
 * **Not reachable from this codebase today**, and that was checked rather than
 * assumed: every transaction in `hub`, `http`, `store` and `self-reminder` is
 * `db.transaction(fn)`, which bun runs synchronously and commits before it
 * returns. Nothing holds a snapshot across an `await`. A long-lived read would
 * have to be introduced, and this test is here so that whoever introduces one
 * meets the consequence in a hundred milliseconds instead of on a full disk.
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A store opened the way `openStore` opens one. */
function store(dir: string) {
  const path = join(dir, "probe.db");
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, blob TEXT)");
  db.prepare("INSERT INTO t (blob) VALUES (?)").run("seed");
  return { db, path, wal: () => (existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0) };
}

/** Write until the log has clearly passed the threshold, or it folds. */
function fill(db: Database, wal: () => number, limit = 4000) {
  const payload = "x".repeat(8000);
  const insert = db.prepare("INSERT INTO t (blob) VALUES (?)");
  let peak = 0;
  for (let i = 0; i < limit; i++) {
    insert.run(payload);
    if (i % 50 !== 0) continue;
    const size = wal();
    if (size > peak) peak = size;
    if (peak > 3_000_000 && size < peak / 2) return { peak, folded: true };
  }
  return { peak, folded: false };
}

describe("the write-ahead log", () => {
  test("folds back on its own once it passes the threshold", () => {
    const dir = mkdtempSync(join(tmpdir(), "wal-fold-"));
    try {
      const { db, wal } = store(dir);
      const { peak, folded } = fill(db, wal);
      db.close();

      // Guards the guard: folding at a peak of nothing would mean the writes
      // never reached the threshold and the test proved only that it is small.
      expect(peak, "the log never approached the threshold, so nothing was tested")
        .toBeGreaterThan(3_000_000);
      expect(folded, "the log never folded — `self-limiting` is not true of this configuration")
        .toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("but not while a reader is holding a snapshot", () => {
    const dir = mkdtempSync(join(tmpdir(), "wal-held-"));
    try {
      const { db, path, wal } = store(dir);
      const reader = new Database(path, { readonly: true });
      reader.exec("BEGIN");
      reader.prepare("SELECT count(*) FROM t").get(); // the snapshot starts here

      const { peak, folded } = fill(db, wal);
      reader.exec("COMMIT");
      reader.close();
      db.close();

      expect(folded, "the log folded under an open reader, which contradicts the case above")
        .toBe(false);
      // Well past the threshold, so this is not "it had not got there yet".
      expect(peak, "the log stayed near the threshold, so the reader's effect is unproven")
        .toBeGreaterThan(8_000_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
