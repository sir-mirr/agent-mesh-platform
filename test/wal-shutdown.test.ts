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
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { connectRpc, loginAsAdmin, newKeyPair, provision, startMesh, type Mesh } from "./harness";

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
async function busyMesh(): Promise<Mesh> {
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

  return mesh;
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
  const mesh = await busyMesh();
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
  const mesh = await busyMesh();
  const before = wroteEverything(mesh);

  const pids = [mesh.hub.pid, mesh.http.pid];
  mesh.hub.stop();
  expect({ pid: pids[0], reaped: await reaped(pids[0]!) }).toEqual({ pid: pids[0], reaped: true });
  mesh.http.stop();
  expect({ pid: pids[1], reaped: await reaped(pids[1]!) }).toEqual({ pid: pids[1], reaped: true });

  foldedEverything(mesh, before);
}, 120_000);
