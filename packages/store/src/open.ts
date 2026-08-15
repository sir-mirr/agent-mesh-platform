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
import { join } from "node:path";

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
    db.exec("PRAGMA journal_mode = WAL;");
  }
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}
