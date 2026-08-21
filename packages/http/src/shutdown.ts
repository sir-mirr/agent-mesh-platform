/**
 * Closing every handle this process opened, and leaving anyway.
 *
 * **The failure this exists for was an omission, not a bug.**
 * `closeAuditAccessLog` was imported by `main.ts` and never called, so the
 * read-write handle on `audit.db` went out unfolded and unclosed — the same
 * omission the hub had, in the other process. Nothing detected it, because a
 * store that is not closed looks exactly like one that is until the next
 * process opens it and finds a write-ahead log nobody folded in.
 *
 * So the list of closers is a *value* here rather than a sequence of
 * statements, and `test/` checks it against the closers `main.ts` imports. A
 * sixth store added later is either in the list or the check says so.
 *
 * **A closer that throws does not stop the others.** It used to: the calls ran
 * in a row, so the first failure skipped every close after it *and* the exit,
 * leaving a process that had been asked to stop still running. systemd then
 * `SIGKILL`s it after its timeout, which is exactly the ungraceful ending the
 * closers exist to avoid — one unclosable store would cost every other store
 * its clean close. Each is attempted, failures are logged, and the exit
 * happens regardless.
 */

import { log as httpLog } from "./log";

/** One store, named so a failure says which. */
export type Closer = readonly [name: string, close: () => void];

export interface ShutdownWiring {
  closers: readonly Closer[];
  /** Stop accepting connections. Runs after the stores, never before. */
  stop: () => void;
  /** How the process leaves. Injected so a test is not one. */
  exit: (code: number) => void;
  log?: (message: string) => void;
  warn?: (message: string, err: unknown) => void;
}

export function runShutdown(w: ShutdownWiring): void {
  const log = w.log ?? ((m: string) => httpLog.info(m, "shutdown_step", {}));
  const warn = w.warn ?? ((m: string, err: unknown) =>
    httpLog.error(m, "shutdown_step_failed", {
      outcome: "failed",
      reason: "close_threw",
      error: err instanceof Error ? err.message : String(err),
    }));
  log("agent-mesh-http: shutting down");

  for (const [name, close] of w.closers) {
    try {
      close();
    } catch (err) {
      warn(`agent-mesh-http: could not close ${name} cleanly`, err);
    }
  }

  // After the stores, not before. A request still in flight would otherwise be
  // answered by a handler whose database has already gone.
  try {
    w.stop();
  } catch (err) {
    warn("agent-mesh-http: could not stop the server cleanly", err);
  }

  w.exit(0);
}
