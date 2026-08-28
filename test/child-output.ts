/**
 * Run a child and read what it said **from a file, never from a pipe**.
 *
 * `test/tree-lock.test.ts` read a child's stdout and stderr with
 * `new Response(child.stdout).text()`. On 2026-08-27 that threw
 * `EBADF: bad file descriptor, epoll_ctl` inside CI's coverage job and failed
 * the test — while the child itself had run correctly and exited with the code
 * the test was actually asking for. Two pushes to `main` went red that way, and
 * the investigation goes to the tree lock, which was fine.
 *
 * The pipe is not only droppable, it is *throwable*: the same day, elsewhere in
 * this repository, a pipe returned 787 KB of a 248 MB run with none of the
 * markers in it. A verdict carried on a pipe is a verdict that can be lost or
 * can take the reader down with it; a file and an exit code are neither.
 *
 * So the child writes into two temporary files and this reads them after it has
 * exited.
 *
 * ## The exit code is not safe either, and that was the actual defect
 *
 * Moving the streams to files did not stop CI going red. The same `EBADF` came
 * back one line further down, out of `await child.exited` — so the throw was
 * never about reading a pipe. It is the runtime failing to watch the child at
 * all: `epoll_ctl` on a descriptor it no longer holds. The pipe read was
 * simply the first place that failure surfaced, and reading it as the cause was
 * wrong.
 *
 * A parent that cannot watch its child has **measured nothing** — the child ran
 * and exited correctly. `awaitExit` below says so rather than letting the
 * exception fail a test about something else.
 */

import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ChildSaid {
  /** What the process exited with — the part a pipe cannot drop. */
  code: number;
  stdout: string;
  stderr: string;
  /** Both streams, in the order most callers assert against. */
  said: string;
}

/** What `awaitExit` needs of a child, so the failing path can be handed one. */
export interface Watchable {
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  readonly pid: number;
}

const isEbadf = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "EBADF";

/** Is that process still there? A pid that has gone is one whose exit happened. */
const stillRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * The child's exit code, including when the runtime loses its watcher.
 *
 * `EBADF: bad file descriptor, epoll_ctl` out of `child.exited` is not the
 * child failing — it is this process losing the ability to be told. So the
 * error is caught, the pid is watched until it goes, and the code the runtime
 * did record is used. **If there is none, this throws saying exactly that**: a
 * run nobody could observe must not come back as a zero.
 */
/**
 * Real timers and no injected clock. A seam here would be two arrow functions
 * nothing but the seam ever runs — uncovered source in the file that argues a
 * path nothing runs is a path nobody has checked. The waiting below is bounded
 * and only happens on a failure that has occurred twice in CI.
 */
export async function awaitExit(child: Watchable): Promise<number> {
  try {
    return await child.exited;
  } catch (error) {
    if (!isEbadf(error)) throw error;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) return child.exitCode;
      if (!stillRunning(child.pid)) break;
      await Bun.sleep(10);
    }
    if (child.exitCode !== null) return child.exitCode;
    throw new Error(
      `the runtime lost track of pid ${child.pid} (EBADF from epoll_ctl) and it left no exit code — ` +
        "this run measured nothing, and whatever it was asked is still unanswered",
    );
  }
}

export async function runChild(
  cmd: readonly string[],
  options: { cwd?: string; env?: Record<string, string | undefined>; stdin?: string | Uint8Array } = {},
): Promise<ChildSaid> {
  const dir = mkdtempSync(join(tmpdir(), "child-said-"));
  const outPath = join(dir, "stdout");
  const errPath = join(dir, "stderr");
  const out = openSync(outPath, "w");
  const err = openSync(errPath, "w");
  try {
    const child = Bun.spawn([...cmd], {
      // A hook reads its turn off stdin; `"ignore"` gives it an immediate end
      // of file, which several of these children treat as *no input given*.
      stdin: options.stdin === undefined
        ? "ignore"
        : typeof options.stdin === "string"
          ? new TextEncoder().encode(options.stdin)
          : options.stdin,
      stdout: out,
      stderr: err,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    const code = await awaitExit(child);
    const stdout = readFileSync(outPath, "utf8");
    const stderr = readFileSync(errPath, "utf8");
    return { code, stdout, stderr, said: stdout + stderr };
  } finally {
    closeSync(out);
    closeSync(err);
    rmSync(dir, { recursive: true, force: true });
  }
}
