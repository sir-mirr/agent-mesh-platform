/**
 * Database handles for the baseline services.
 *
 * Every store lives under `AGENT_MESH_STATE_DIR` on the core VM, and more than
 * one process opens some of them: SPEC § 3.1 has the hub and the http server
 * both holding `agents.db` read-write, and the http server reading `hub.db`.
 * WAL plus a busy timeout is what makes that safe, so it is applied here rather
 * than left to each caller to remember.
 *
 * **The hub owns the DDL** (SPEC § 3.1). Other services open a store expecting
 * its tables to exist; only the hub calls `migrate*`.
 */

import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { join } from "node:path";

import { createLogger } from "@agent-mesh/log";

const log = createLogger("store");

export const DEFAULT_STATE_DIR = "/srv/agent-mesh-lab/state/shared";

export function stateDir(env: Record<string, string | undefined> = process.env): string {
  return env.AGENT_MESH_STATE_DIR ?? DEFAULT_STATE_DIR;
}

/**
 * The files, and who writes them. See SPEC § 3.1.
 *
 * `agents` and `audit` are 0.2 and not yet split out — identity tables live in
 * `hub.db` today and audit does not exist. They are named here because the
 * split is decided, not because it has happened.
 */
export const STORE_FILES = {
  /** Identity, keys, key history. hub: rw, http: rw. **0.2** */
  agents: "agents.db",
  /** Message routing and history. hub: rw, http: ro. */
  hub: "hub.db",
  /** Audit events and their attachment references. hub: rw, http: ro. **0.2** */
  audit: "audit.db",
  /** Scheduler state. self-reminder: rw, hub: rw (reminder RPCs). */
  selfReminder: "self-reminder.db",
} as const;

export type StoreName = keyof typeof STORE_FILES;

export interface OpenOptions {
  /** Open read-only. A reader that never writes should say so. */
  readonly?: boolean;
  /** Create the file when absent. Only the DDL owner should pass this. */
  create?: boolean;
  env?: Record<string, string | undefined>;
}

/**
 * Open one of the stores.
 *
 * `busy_timeout` matters more than it looks: writes across processes serialise,
 * and without it a concurrent writer surfaces as an immediate `SQLITE_BUSY`
 * rather than a short wait.
 */
export function openStore(name: StoreName, opts: OpenOptions = {}): Database {
  const { env: _env, ...rest } = opts;
  return openAt(join(stateDir(opts.env), STORE_FILES[name]), rest);
}

/** Open an explicit path — for tests, and for the paths env vars still override. */
export function openAt(path: string, opts: Omit<OpenOptions, "env"> = {}): Database {
  // `readwrite` is stated rather than left implicit. Passing an options object
  // with neither flag makes bun:sqlite reject the open outright — "flags must
  // include SQLITE_OPEN_READONLY or SQLITE_OPEN_READWRITE" — and until http
  // needed to open an existing `agents.db` for writing, no caller had used that
  // combination, so the helper had a hole where its third case should be.
  const db = new Database(path, {
    ...(opts.readonly ? { readonly: true } : { readwrite: true }),
    ...(opts.create ? { create: true } : {}),
  });
  if (!opts.readonly) {
    // **Before the first statement runs**, because opening in WAL mode
    // recovers the log and the evidence is gone by the time anybody could ask.
    //
    // A `-wal` with bytes in it at open means the process that wrote it left
    // without folding it -- `checkpointForShutdown` is what folds it, and it is
    // reached only on a clean path. Nothing is lost either way; SQLite replays
    // it. What is worth knowing is that it happened, because the alternative
    // reading of a quiet service is that every shutdown was clean, and the two
    // look identical from outside (T-022 principle 3).
    const carried = walBytes(path);
    if (carried > 0) {
      log.warn("recovering a write-ahead log the last process left behind", "wal_recovered", {
        id: path,
        wal_bytes: carried,
        outcome: "recovered",
        reason: "unfolded_log",
      });
    }
    db.exec("PRAGMA journal_mode = WAL;");
  }
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}

/**
 * Fold a store's write-ahead log before the process leaves.
 *
 * `db.close()` is the obvious call for this and it does not do it. bun's close
 * is a *safe* close: with statements still prepared against the handle it marks
 * the database closed to JavaScript and leaves the file open, so nothing is
 * checkpointed and the log outlives the process. Measured on bun 1.3.13 against
 * a store with one live prepared statement:
 *
 *     db.close()            wal 2,476,152 -> 2,476,152   main     4,096
 *     db.close(true)        throws "database is locked"
 *     finalise, close()     wal 2,476,152 ->         0   main   827,392
 *
 * `packages/hub/src/db.ts` prepares thirty statements at module load and never
 * finalises them, which is why the standing deployment's `hub.db` is 4096 bytes
 * — one page, no checkpoint has ever completed — while 1.5 MB of it lives in
 * the log beside it. The shutdown path has been calling `close()` on that
 * handle for as long as it has existed and folding nothing.
 *
 * So checkpoint explicitly rather than close harder. The log folds, the handle
 * stays usable afterwards, and the failure mode is that nothing happens:
 *
 *     reader pinning an older snapshot, busy_timeout 250ms   folded in 151ms
 *     reader pinning an older snapshot, busy_timeout 0       busy:1, 2ms, no fold
 *
 * The timeout is lowered first because the default is five seconds **per
 * store**, and this runs on the way out: a shutdown that waits twenty seconds
 * is worse than a log that stays large for one more run.
 */
export function checkpointForShutdown(db: Database, timeoutMs = 250): void {
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(timeoutMs))};`);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } catch (err) {
    // A handle already closed, or a log some other process is pinning harder
    // than the timeout allows. Neither is worth failing a shutdown over — the
    // next open recovers the log, which is what has been happening all along.
    //
    // Said, though. This is the one place that decides whether the *next* boot
    // reports a recovery, so a shutdown that swallowed the reason left that
    // warning with no cause anybody could find.
    log.warn("could not fold a write-ahead log on the way out", "wal_checkpoint_failed", {
      outcome: "left_unfolded",
      reason: "checkpoint_refused",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * How much log is waiting to be replayed, or `0` when there is none to read.
 *
 * `:memory:` and a database being created have no `-wal` beside them, and a
 * store somebody else is mid-write on may answer nothing useful -- none of
 * which is a reason to fail an open.
 */
function walBytes(path: string): number {
  if (path === ":memory:" || path === "") return 0;
  try {
    return statSync(`${path}-wal`).size;
  } catch {
    return 0;
  }
}
