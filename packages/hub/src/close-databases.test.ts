/**
 * The hub's shutdown folds every log it owns, including the one it never closes.
 *
 * `checkpointForShutdown` is tested beside the store it acts on; this is the
 * wiring, and it is separate because the wiring is what was missing.
 * `closeDatabases()` opened four stores, closed three, folded none, and every
 * suite stayed green throughout — which is the whole argument for asserting on
 * the files rather than on the call.
 *
 * `audit` is named explicitly below: the store § 8.9 keeps indefinitely, the
 * one the hub opens and never closes, and the one an `auditDb.close()` repair
 * broke the suite over. It folds here without being closed.
 *
 * **Run in a child process, and that is not incidental.** `closeDatabases()`
 * acts on module-level singletons, so calling it in-process leaves every later
 * test in the same run holding a closed handle — eight of them, failing with
 * `Database has closed`, which is the same shape as the failures the earlier
 * repair attempt produced. A shutdown belongs at the end of a process; a test
 * that calls one has to supply the process.
 */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "hub-close-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const wal = (name: string) =>
  existsSync(join(dir, `${name}-wal`)) ? statSync(join(dir, `${name}-wal`)).size : 0;

/** Fill the stores and shut down, in a process that can afford to end. */
const SHUTDOWN = `
  const { db, auditDb, srDb, closeDatabases } = await import(${JSON.stringify(join(import.meta.dir, "db.ts"))});
  srDb();
  const payload = "x".repeat(4000);
  const message = db.prepare("INSERT INTO messages (id, from_agent, to_agent, content) VALUES (?, 'a', 'b', ?)");
  const event = auditDb.prepare(
    \`INSERT INTO audit_events (event_id, schema_version, event_type, occurred_at,
                                identity, recorded_by_kind, payload, payload_digest)
      VALUES (?, 1, 'test.event', datetime('now'), 'a', 'hub', ?, 'sha256:0')\`,
  );
  for (let i = 0; i < 200; i++) { message.run("m" + i, payload); event.run("e" + i, payload); }
  const { existsSync, statSync } = await import("node:fs");
  const wal = (n) => existsSync(process.env.AGENT_MESH_STATE_DIR + "/" + n + "-wal")
    ? statSync(process.env.AGENT_MESH_STATE_DIR + "/" + n + "-wal").size : 0;
  const before = { "hub.db": wal("hub.db"), "audit.db": wal("audit.db"), "agents.db": wal("agents.db") };
  closeDatabases();
  console.log(JSON.stringify(before));
`;

test("closeDatabases folds hub, agents and audit", async () => {
  const proc = Bun.spawn(["bun", "-e", SHUTDOWN], {
    env: { ...process.env, AGENT_MESH_STATE_DIR: dir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect({ code, err }).toEqual({ code: 0, err: "" });

  // Non-zero is the precondition, not "large": SQLite's own threshold folds a
  // log mid-run and never truncates it, so what separates the fix from the
  // default is exactly zero afterwards, not merely smaller.
  const before = JSON.parse(out.trim()) as Record<string, number>;
  for (const store of ["hub.db", "audit.db", "agents.db"]) {
    expect({ store, wrote: before[store]! > 0 }).toEqual({ store, wrote: true });
    expect({ store, wal: wal(store) }).toEqual({ store, wal: 0 });
  }
});
