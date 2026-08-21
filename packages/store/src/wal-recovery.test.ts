/**
 * A write-ahead log that outlived the process that wrote it (T-022).
 *
 * Nothing is lost when one does -- SQLite replays it on the next open, and the
 * comment on `checkpointForShutdown` says as much. What was missing is that it
 * happened at all: a service that dies mid-write and one that shuts down
 * cleanly produce the same quiet next boot, and "every shutdown was clean" is
 * the reading somebody takes from silence.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { captureConsole, eventCounts, resetCountsForTest } from "@agent-mesh/log";

import { checkpointForShutdown, openAt } from "./open";

const dirs: string[] = [];
const dbPath = () => {
  const dir = mkdtempSync(join(tmpdir(), "wal-recovery-"));
  dirs.push(dir);
  return join(dir, "probe.db");
};

/** Leave a log behind: write, and go without folding it. */
function leaveALogBehind(path: string): number {
  const db = openAt(path, { create: true });
  db.exec("CREATE TABLE t (v TEXT)");
  const insert = db.prepare("INSERT INTO t (v) VALUES (?)");
  for (let i = 0; i < 200; i++) insert.run("x".repeat(400));
  // No checkpoint: `close()` alone does not fold the log, which is the whole
  // reason `checkpointForShutdown` exists.
  db.close();
  return statSync(`${path}-wal`).size;
}

afterEach(() => {
  resetCountsForTest();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("opening a store somebody left a log on", () => {
  test("says so, with how much is waiting", () => {
    const path = dbPath();
    const carried = leaveALogBehind(path);
    expect(carried, "the fixture folded the log, so this proves nothing").toBeGreaterThan(0);

    const capture = captureConsole();
    try {
      openAt(path).close();
    } finally {
      capture.restore();
    }

    const line = capture.lines.find((l) => l.includes('"event":"wal_recovered"'));
    expect(line, "a log was recovered without a word").toBeDefined();
    expect(line).toContain('"level":"warn"');
    expect(line).toContain('"component":"store"');
    expect(line).toContain('"reason":"unfolded_log"');
    expect(JSON.parse(line!.slice(line!.lastIndexOf(' {"ts":"') + 1)).wal_bytes).toBe(carried);
  });

  test("counts it, so a boot that recovered nothing is still an answer", () => {
    const path = dbPath();
    leaveALogBehind(path);

    const capture = captureConsole();
    try {
      openAt(path).close();
    } finally {
      capture.restore();
    }

    expect(eventCounts()).toEqual([
      { component: "store", event: "wal_recovered", reason: "unfolded_log", count: 1 },
    ]);
  });

  test("a store folded on the way out is opened in silence", () => {
    const path = dbPath();
    leaveALogBehind(path);
    const db = openAt(path);
    checkpointForShutdown(db);
    db.close();
    resetCountsForTest();

    const capture = captureConsole();
    try {
      openAt(path).close();
    } finally {
      capture.restore();
    }

    expect(capture.lines).toEqual([]);
    expect(eventCounts()).toEqual([]);
  });

  test("a database being created has no log to recover", () => {
    const capture = captureConsole();
    try {
      openAt(dbPath(), { create: true }).close();
    } finally {
      capture.restore();
    }
    expect(capture.lines).toEqual([]);
  });

  test("an in-memory store is not a file, and is not read as one", () => {
    const capture = captureConsole();
    try {
      openAt(":memory:").close();
    } finally {
      capture.restore();
    }
    expect(capture.lines).toEqual([]);
  });

  test("a read-only open does not claim a recovery it did not do", () => {
    const path = dbPath();
    leaveALogBehind(path);

    const capture = captureConsole();
    try {
      openAt(path, { readonly: true }).close();
    } finally {
      capture.restore();
    }

    expect(capture.lines.filter((l) => l.includes('"event":"wal_recovered"'))).toEqual([]);
  });
});

describe("a checkpoint that cannot run", () => {
  test("says why, because it decides what the next boot reports", () => {
    const path = dbPath();
    const db = openAt(path, { create: true });
    db.exec("CREATE TABLE t (v TEXT)");
    db.close();

    const capture = captureConsole();
    try {
      // A handle already closed: the shape the shutdown path can actually meet.
      checkpointForShutdown(db);
    } finally {
      capture.restore();
    }

    const line = capture.lines.find((l) => l.includes('"event":"wal_checkpoint_failed"'));
    expect(line, "a checkpoint failed without a word").toBeDefined();
    expect(line).toContain('"reason":"checkpoint_refused"');
    expect(line).toContain('"outcome":"left_unfolded"');
    expect(eventCounts()).toEqual([
      { component: "store", event: "wal_checkpoint_failed", reason: "checkpoint_refused", count: 1 },
    ]);
  });

  test("a checkpoint that runs says nothing at all", () => {
    const path = dbPath();
    leaveALogBehind(path);
    const db = openAt(path);
    resetCountsForTest();

    const capture = captureConsole();
    try {
      checkpointForShutdown(db);
    } finally {
      capture.restore();
    }
    db.close();

    expect(capture.lines).toEqual([]);
    expect(statSync(`${path}-wal`).size).toBe(0);
  });
});
