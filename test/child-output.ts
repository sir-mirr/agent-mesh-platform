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
 * exited. The exit code still comes from `child.exited`, which is the part no
 * buffering can affect.
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
    const code = await child.exited;
    const stdout = readFileSync(outPath, "utf8");
    const stderr = readFileSync(errPath, "utf8");
    return { code, stdout, stderr, said: stdout + stderr };
  } finally {
    closeSync(out);
    closeSync(err);
    rmSync(dir, { recursive: true, force: true });
  }
}
