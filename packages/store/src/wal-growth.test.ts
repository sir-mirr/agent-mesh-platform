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

import { openAt } from "./open";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A store, opened by the opener the services use.
 *
 * **Not a copy of it.** This began as `new Database` plus the same two pragmas
 * typed out again, which measures SQLite rather than this repository: the day
 * `openAt` stops setting `journal_mode = WAL`, or starts setting
 * `wal_autocheckpoint = 0`, the copy here goes on passing and says the shipped
 * configuration is self-limiting when it no longer is.
 */
function store(dir: string) {
  const path = join(dir, "probe.db");
  const db = openAt(path, { create: true });
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, blob TEXT)");
  db.prepare("INSERT INTO t (blob) VALUES (?)").run("seed");
  return { db, path, wal: () => (existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0) };
}

/**
 * Write well past the threshold and answer whether the log stayed bounded.
 *
 * **Bounded, not smaller.** The first version of this waited for the file to
 * shrink, which is not what a checkpoint promises: SQLite rewinds the log and
 * writes over it from the start, and whether the *file* shrinks depends on
 * `journal_size_limit`, which nothing here sets. It shrank on the machine this
 * was written on and did not in CI, so a true property was being read through
 * an accident of one filesystem — the same shape as the prediction this file
 * exists to have replaced.
 *
 * What is actually claimed by *self-limiting* is that the log stops tracking the
 * volume of writes. So: write until it passes the threshold, then write several
 * times the threshold again, and compare. Bounded means the peak did not follow.
 */
function fill(db: Database, wal: () => number, limit = 4000) {
  const payload = "x".repeat(8000);
  const insert = db.prepare("INSERT INTO t (blob) VALUES (?)");
  const THRESHOLD = 3_000_000;
  let peak = 0;
  let crossed = 0;
  let wroteAfter = 0;
  for (let i = 0; i < limit; i++) {
    insert.run(payload);
    if (crossed > 0) wroteAfter += payload.length;
    if (i % 50 !== 0) continue;
    const size = wal();
    if (size > peak) peak = size;
    if (crossed === 0 && peak > THRESHOLD) crossed = peak;
    // Four times the threshold written after crossing it. A log that is not
    // being checkpointed has no way to hide that.
    if (crossed > 0 && wroteAfter > THRESHOLD * 4) {
      return { peak, bounded: peak < crossed * 2 };
    }
  }
  return { peak, bounded: crossed > 0 && peak < crossed * 2 };
}

describe("the write-ahead log", () => {
  test("stops tracking the writes once it passes the threshold", () => {
    const dir = mkdtempSync(join(tmpdir(), "wal-fold-"));
    try {
      const { db, wal } = store(dir);
      const { peak, bounded } = fill(db, wal);
      db.close();

      // Guards the guard: folding at a peak of nothing would mean the writes
      // never reached the threshold and the test proved only that it is small.
      expect(peak, "the log never approached the threshold, so nothing was tested")
        .toBeGreaterThan(3_000_000);
      expect(bounded, "the log tracked the writes — `self-limiting` is not true of this configuration")
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

      const { peak, bounded } = fill(db, wal);
      reader.exec("COMMIT");
      reader.close();
      db.close();

      expect(bounded, "the log stayed bounded under an open reader, which contradicts the case above")
        .toBe(false);
      // Well past the threshold, so this is not "it had not got there yet".
      expect(peak, "the log stayed near the threshold, so the reader's effect is unproven")
        .toBeGreaterThan(8_000_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
