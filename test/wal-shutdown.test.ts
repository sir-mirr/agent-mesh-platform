/**
 * A stopped mesh leaves no write-ahead log behind.
 *
 * Both processes had the same defect and neither suite could see it, because
 * every assertion in this repository is about what a service answers while it
 * is running. What it leaves on disk when it stops was never checked, and
 * `close()` — the call both shutdown paths relied on — folds nothing when
 * statements are still prepared against the handle.
 *
 * This asserts on the files after the processes are gone, which is the only
 * place the difference shows. It runs its own mesh rather than the shared one
 * because it has to stop it.
 *
 * **`audit.db` is the one to watch.** The hub opens it and never closes it, and
 * the http server opens it read-write a second time for § 8.9 access records —
 * a handle that was imported into the shutdown path and never called. Both are
 * folded here without either being closed.
 */

import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { connectRpc, loginAsAdmin, newKeyPair, openTestDb, provision, startMesh, type Mesh } from "./harness";

const meshes: Mesh[] = [];
afterAll(() => {
  for (const m of meshes) rmSync(m.stateDir, { recursive: true, force: true });
});

/** Every log in the state directory, by store, size in bytes. */
function logs(dir: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of readdirSync(dir)) {
    if (!name.endsWith("-wal")) continue;
    out[name] = statSync(join(dir, name)).size;
  }
  return out;
}

/** Wait for a killed process to actually be gone; `kill` only asks. */
async function reaped(pid: number, budgetMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await Bun.sleep(25);
  }
  return false;
}

/** A mesh with enough traffic that every log is unmistakably non-empty. */
async function busyMesh(): Promise<{ mesh: Mesh; cookie: string }> {
  const mesh = await startMesh();
  meshes.push(mesh);
  const cookie = await loginAsAdmin(mesh.http);

  const sender = newKeyPair(), recipient = newKeyPair();
  await provision(mesh.hub, "wal-sender", "ai-claude", null, sender.publicKey);
  await provision(mesh.hub, "wal-recipient", "ai-claude", null, recipient.publicKey);
  for (const fingerprint of [sender.fingerprint, recipient.fingerprint]) {
    await fetch(`${mesh.http.url}/api/v1/admin/keys/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ fingerprint }),
    });
  }

  // Enough traffic that a log is unmistakably non-empty before the stop, so a
  // zero afterwards is a fold rather than a store nobody ever wrote to.
  const rpc = await connectRpc(mesh.hub, { kid: sender.fingerprint, privateKey: sender.privateKey });
  await rpc.call("mesh.connect", { identity: "wal-sender" });
  const content = "x".repeat(4000);
  for (let i = 0; i < 60; i++) await rpc.call("mesh.send", { to: "wal-recipient", content });
  rpc.close();
  await Bun.sleep(300);

  return { mesh, cookie };
}

/**
 * Read an audit event's content, which is what opens the § 8.9 access-log
 * handle. Nothing else in this file does: the store is only written when
 * somebody reads, so a run without this leaves `_db` null and a missing
 * `closeAuditAccessLog()` closes nothing because there is nothing open.
 */
async function readAuditContent(mesh: Mesh, cookie: string): Promise<void> {
  const list = await fetch(`${mesh.http.url}/api/v1/audit/events?limit=5`, { headers: { cookie } });
  expect({ route: "/api/v1/audit/events", status: list.status }).toEqual({ route: "/api/v1/audit/events", status: 200 });
  const events = ((await list.json()) as { events?: Array<{ event_id: string }> }).events ?? [];
  expect(events.length).toBeGreaterThan(0);
  for (const { event_id } of events) {
    const one = await fetch(`${mesh.http.url}/api/v1/audit/events/${event_id}`, { headers: { cookie } });
    expect({ event_id, status: one.status }).toEqual({ event_id, status: 200 });
  }
}

/** Assert every log the run produced is gone, and its pages are not. */
function foldedEverything(mesh: Mesh, before: Record<string, number>): void {
  const after = logs(mesh.stateDir);
  for (const store of Object.keys(before)) {
    expect({ store, wal: after[store] ?? 0 }).toEqual({ store, wal: 0 });
    const main = join(mesh.stateDir, store.replace(/-wal$/, ""));
    expect({ store, kept: existsSync(main) && statSync(main).size > 4096 }).toEqual({ store, kept: true });
  }
}

/** What the run wrote, checked to be worth folding before anything is stopped. */
function wroteEverything(mesh: Mesh): Record<string, number> {
  const before = logs(mesh.stateDir);
  expect(Object.keys(before).sort()).toEqual(["agent-mesh.db-wal", "agents.db-wal", "audit.db-wal", "hub.db-wal"]);
  for (const [store, size] of Object.entries(before)) {
    expect({ store, wrote: size > 0 }).toEqual({ store, wrote: true });
  }
  return before;
}

test("stopping the mesh folds every log both processes wrote", async () => {
  const { mesh, cookie } = await busyMesh();
  await readAuditContent(mesh, cookie);
  const before = wroteEverything(mesh);

  // http first, so its read-only handle on `hub.db` is not pinning the log the
  // hub is about to fold. This is the order an operator's stop unit uses.
  const pids = [mesh.http.pid, mesh.hub.pid];
  mesh.http.stop();
  mesh.hub.stop();
  for (const pid of pids) expect({ pid, reaped: await reaped(pid) }).toEqual({ pid, reaped: true });

  foldedEverything(mesh, before);
}, 120_000);

/**
 * The other order, which is the one that says whether each process folds *its
 * own*.
 *
 * With http stopped first the hub is last out and folds all three shared
 * stores, so the http server could fold nothing at all and the test above would
 * still pass. Stopping the hub first removes that cover: `agent-mesh.db` is
 * http's alone, and the § 8.9 access-log handle on `audit.db` is a second
 * read-write connection that only http can release.
 */
test("stopping the hub first still folds what only the http server holds", async () => {
  const { mesh, cookie } = await busyMesh();
  const before = wroteEverything(mesh);

  mesh.hub.stop();
  expect({ pid: mesh.hub.pid, reaped: await reaped(mesh.hub.pid) }).toEqual({ pid: mesh.hub.pid, reaped: true });

  // With the hub gone, the http server is the last writer to `audit.db` as well
  // as the only one holding `agent-mesh.db`. Reading here rather than before
  // the stop is the whole point: written earlier, the hub's own checkpoint
  // folds the log on its way out and covers for whatever http does next.
  await readAuditContent(mesh, cookie);
  expect({ store: "audit.db-wal", wrote: (logs(mesh.stateDir)["audit.db-wal"] ?? 0) > 0 })
    .toEqual({ store: "audit.db-wal", wrote: true });

  mesh.http.stop();
  expect({ pid: mesh.http.pid, reaped: await reaped(mesh.http.pid) }).toEqual({ pid: mesh.http.pid, reaped: true });

  foldedEverything(mesh, before);
}, 120_000);

/**
 * The third process, which had no shutdown at all.
 *
 * The hub and the http server at least *called* something on the way out. The
 * self-reminder daemon installed no signal handler, so `systemctl stop` killed
 * it mid-poll and `self-reminder.db-wal` outlived every restart. It was found by
 * looking for the defect rather than by anything failing — the store is written
 * for abrupt death, so nothing was ever lost and nothing ever complained.
 *
 * Started for real rather than by importing its module, because "installs a
 * SIGTERM handler" is a claim about a process and there is no way to assert it
 * from inside one.
 */
test("the self-reminder daemon folds its log on SIGTERM", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wal-reminder-"));
  const path = join(dir, "self-reminder.db");
  const wal = () => (existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0);

  const proc = Bun.spawn(["bun", "packages/self-reminder/src/main.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      AGENT_MESH_STATE_DIR: dir,
      // Nothing is listening; the daemon retries and keeps scheduling, which is
      // the state a stop most often arrives in.
      HUB_URL: "ws://127.0.0.1:1/ws",
      SELF_REMINDER_POLL_MS: "60000",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    // Wait for it to have opened and migrated the store, not merely to exist.
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let said = "";
    while (!said.includes("scheduler_started")) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`daemon exited before starting:\n${said}`);
      said += decoder.decode(value);
    }

    // Enough rows that a zero afterwards is a fold and not an empty store.
    const writer = openTestDb(path, { readwrite: true });
    writer.exec("PRAGMA busy_timeout = 5000;");
    const insert = writer.prepare(
      `INSERT INTO reminders (id, agent_id, type, schedule_spec, payload, created_by)
       VALUES (?, 'a', 'once', '2030-01-01T00:00:00Z', ?, 'test')`,
    );
    const payload = "x".repeat(4000);
    for (let i = 0; i < 200; i++) insert.run(`r${i}`, payload);
    writer.close();
    expect({ store: "self-reminder.db-wal", wrote: wal() > 0 }).toEqual({ store: "self-reminder.db-wal", wrote: true });

    proc.kill("SIGTERM");
    const code = await proc.exited;
    expect({ code, reaped: await reaped(proc.pid) }).toEqual({ code: 0, reaped: true });

    expect({ store: "self-reminder.db-wal", wal: wal() }).toEqual({ store: "self-reminder.db-wal", wal: 0 });
    expect({ store: "self-reminder.db", kept: statSync(path).size > 4096 }).toEqual({ store: "self-reminder.db", kept: true });
  } finally {
    proc.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
