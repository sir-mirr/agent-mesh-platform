/**
 * § 15.6 — orphan collection.
 *
 * The three requirements are that it runs out of process, that it is
 * idempotent, and that it is safe to run while the core is live. All three are
 * about a program that **deletes files**, and none of them had a test.
 *
 * The dangerous direction is not "fails to collect" — that costs disk. It is
 * "collects a blob an event references", or "collects an upload the client is
 * about to commit", either of which surfaces later as `-32040` for bytes
 * somebody knows they sent. So most of what is asserted here is what the sweep
 * leaves alone.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { startMesh, type Mesh } from "./harness";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const SCRIPT = join(REPO_ROOT, "scripts/collect-orphan-blobs.ts");

let mesh: Mesh | null = null;

afterEach(() => {
  mesh?.stop();
  mesh = null;
});

interface Run {
  code: number;
  out: string;
}

async function collect(stateDir: string, args: string[] = []): Promise<Run> {
  const proc = Bun.spawn(["bun", SCRIPT, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, AGENT_MESH_STATE_DIR: stateDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: stdout + stderr };
}

/** A blob file with a controllable age. */
function blob(stateDir: string, name: string, ageHours: number, bytes = "x"): string {
  const dir = join(stateDir, "uploads");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, bytes);
  const when = new Date(Date.now() - ageHours * 3_600_000);
  utimesSync(path, when, when);
  return path;
}

function uploads(stateDir: string): string[] {
  try {
    return readdirSync(join(stateDir, "uploads")).sort();
  } catch {
    return [];
  }
}

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

/** Reference a blob from the audit store, the way a committed event does. */
function reference(stateDir: string, blobKey: string): void {
  const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
  const db = new Database(join(stateDir, "audit.db"), { readwrite: true });
  db.prepare(
    `INSERT INTO audit_event_blobs (event_id, blob_key, sha256, size) VALUES (?, ?, ?, ?)`,
  ).run("01900000-0000-7000-8000-000000000000", blobKey, blobKey.slice(0, 64), 1);
  db.close();
}

describe("§ 15.6 orphan collection", () => {
  test("an old unreferenced blob is collected", async () => {
    mesh = await startMesh({ withHttp: false });
    blob(mesh.stateDir, KEY_A, 48);

    const run = await collect(mesh.stateDir);

    expect(run.code).toBe(0);
    expect(uploads(mesh.stateDir)).not.toContain(KEY_A);
  }, 30_000);

  test("a referenced blob is never collected, however old", async () => {
    // Retention is indefinite, so a reference is never released. Collecting one
    // corrupts an audit event that says its attachment is present.
    mesh = await startMesh({ withHttp: false });
    blob(mesh.stateDir, KEY_A, 24 * 365);
    reference(mesh.stateDir, KEY_A);

    await collect(mesh.stateDir);

    expect(uploads(mesh.stateDir)).toContain(KEY_A);
  }, 30_000);

  test("a blob inside the grace period is left alone", async () => {
    // The normal state between upload and append (§ 8.9 uploads first).
    // Collecting here deletes bytes the client is about to commit, and the
    // client sees -32040 for an upload it knows succeeded.
    mesh = await startMesh({ withHttp: false });
    blob(mesh.stateDir, KEY_A, 1);

    await collect(mesh.stateDir);

    expect(uploads(mesh.stateDir)).toContain(KEY_A);
  }, 30_000);

  test("the grace period is the boundary, and it is configurable", async () => {
    mesh = await startMesh({ withHttp: false });
    blob(mesh.stateDir, KEY_A, 6);

    // Default is twelve hours: a six-hour-old blob survives.
    await collect(mesh.stateDir);
    expect(uploads(mesh.stateDir)).toContain(KEY_A);

    // Narrow it and the same blob goes.
    await collect(mesh.stateDir, ["--grace-hours", "1"]);
    expect(uploads(mesh.stateDir)).not.toContain(KEY_A);
  }, 30_000);

  test("--dry-run reports without deleting", async () => {
    mesh = await startMesh({ withHttp: false });
    blob(mesh.stateDir, KEY_A, 48);

    const run = await collect(mesh.stateDir, ["--dry-run"]);

    expect(run.out).toContain("would remove");
    expect(uploads(mesh.stateDir)).toContain(KEY_A);
  }, 30_000);

  test("a second run finds nothing left to do", async () => {
    // § 15.6 requires idempotence, and a timer with `Persistent=true` will run
    // it twice in a row after a missed schedule.
    mesh = await startMesh({ withHttp: false });
    blob(mesh.stateDir, KEY_A, 48);
    blob(mesh.stateDir, KEY_B, 48);
    reference(mesh.stateDir, KEY_B);

    const first = await collect(mesh.stateDir);
    const after = uploads(mesh.stateDir);
    const second = await collect(mesh.stateDir);

    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(uploads(mesh.stateDir)).toEqual(after);
    expect(second.out).toContain("removed 0");
  }, 30_000);

  test("it runs while the core is live and does not disturb it", async () => {
    // The requirement that makes a timer usable at all. It opens audit.db
    // read-only, so it must not block an append happening at the same moment.
    mesh = await startMesh();
    blob(mesh.stateDir, KEY_A, 48);

    const [run, health] = await Promise.all([
      collect(mesh.stateDir),
      fetch(`${mesh.hub.url}/health`).then((r) => r.status),
    ]);

    expect(run.code).toBe(0);
    expect(health).toBe(200);
    expect((await fetch(`${mesh.http.url}/api/v1/health`)).status).toBe(200);
  }, 30_000);

  test("a `.part` file left by a dead upload is collected once it ages out", async () => {
    // § 9.1 renames into place only after the digest matches, so a `.part` is
    // never referenced and never will be. The grace period is the only thing
    // protecting an upload still in progress.
    mesh = await startMesh({ withHttp: false });
    blob(mesh.stateDir, `${KEY_A}.nonce.part`, 48);
    blob(mesh.stateDir, `${KEY_B}.nonce.part`, 1);

    await collect(mesh.stateDir);

    const left = uploads(mesh.stateDir);
    expect(left).not.toContain(`${KEY_A}.nonce.part`);
    expect(left).toContain(`${KEY_B}.nonce.part`);
  }, 30_000);

  test("an unknown argument is refused rather than ignored", async () => {
    // It deletes files. An operator who typo'd `--grace-hours` must not get a
    // silent sweep at the default.
    mesh = await startMesh({ withHttp: false });
    const run = await collect(mesh.stateDir, ["--grace-hour", "1"]);
    expect(run.code).not.toBe(0);
  }, 30_000);

  test("a negative grace period is refused", async () => {
    mesh = await startMesh({ withHttp: false });
    blob(mesh.stateDir, KEY_A, 1);
    const run = await collect(mesh.stateDir, ["--grace-hours", "-1"]);
    expect(run.code).not.toBe(0);
    expect(uploads(mesh.stateDir)).toContain(KEY_A);
  }, 30_000);

  test("it never writes to the audit store", async () => {
    mesh = await startMesh({ withHttp: false });
    blob(mesh.stateDir, KEY_A, 48);
    const auditPath = join(mesh.stateDir, "audit.db");
    const before = statSync(auditPath).mtimeMs;

    await collect(mesh.stateDir);

    expect(statSync(auditPath).mtimeMs).toBe(before);
  }, 30_000);
});

describe("§ 15.6 scheduling", () => {
  test("a timer ships, so collection actually runs out of process", async () => {
    // "MUST run out of process (cron or systemd timer)" is not satisfied by a
    // script nothing invokes. This repository shipped the script and no unit.
    const timer = await Bun.file(
      join(REPO_ROOT, "ops/systemd/agent-mesh-collect-orphans-lab.timer"),
    ).text();
    expect(timer).toContain("OnCalendar=");
    // A missed sweep must not be skipped: an orphan nobody collects is an
    // orphan forever.
    expect(timer).toContain("Persistent=true");
    expect(timer).toContain("WantedBy=timers.target");
  });

  test("the unit it triggers runs the shipped script, as oneshot", async () => {
    const unit = await Bun.file(
      join(REPO_ROOT, "ops/systemd/agent-mesh-collect-orphans-lab.service"),
    ).text();
    expect(unit).toContain("scripts/collect-orphan-blobs.ts");
    // `simple` would report the sweep finished the moment it forked, and the
    // timer would have no idea whether two runs were overlapping.
    expect(unit).toContain("Type=oneshot");
    // § 15.6: safe to run while the core is live — so it must not be tied to
    // the hub's lifetime, which would stop it during exactly the crash loop
    // that leaves uncommitted uploads behind.
    expect(unit).not.toContain("Requires=agent-mesh-hub");
  });
});
