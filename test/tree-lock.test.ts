/**
 * The marker that keeps one repository's mutation run out of another's CI.
 *
 * `mutation-check` edits source in place and restores it between entries; two
 * of its entries neuter `packages/hub/src/signature.ts`. Another agent's e2e
 * runner builds a mesh from this same tree, ran inside that window, and went
 * red at a commit that was fine — eighteen scenarios passing at 11:52 and ten
 * at 11:58, every failure a signature refusal. Ports, state directories and
 * ready files were all isolated; the source tree was the fourth thing and
 * nothing was looking at it.
 *
 * **The check that fires and accuses the wrong side is the expensive one**, and
 * this module is the answer to it. It had no test of its own.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runChild } from "./child-output.ts";

const MARKER = resolve(import.meta.dir, "..", ".agent-mesh-mutating");
const LOCK = resolve(import.meta.dir, "..", "scripts", "tree-lock.ts");

/** Whatever this file wrote goes, whichever way the test ended. */
afterEach(() => rmSync(MARKER, { force: true }));

/**
 * `assertTreeUsable` decides by exiting, so it is asked in its own process.
 *
 * **The answer is the exit code, not a line on stdout.** This printed
 * `started` and looked for it, and CI came back `code: 0, started: false` —
 * a child that ran to the end and exited cleanly with its eight bytes of
 * stdout gone. Measured elsewhere in this repository the same day: a pipe
 * returned 787 KB of a 248 MB run with none of the markers in it. A verdict
 * carried on a pipe is a verdict that can be dropped, and an exit code cannot.
 *
 * `7` rather than `0`, so "the caller started" is a thing the child said and
 * not the default a process exits with when it does nothing at all.
 */
const STARTED = 7;
/**
 * **And it is read from a file, not a pipe.** This read both streams with
 * `new Response(child.stdout).text()`, and CI's coverage job answered
 * `EBADF: bad file descriptor, epoll_ctl` — thrown out of the read, failing the
 * test, while the child had run correctly and exited `7`. Two pushes to
 * `main` went red that way, both pointing at the tree lock, which was fine.
 * `runChild` is the same call with the streams landing in files.
 */
async function ask(): Promise<{ code: number; said: string }> {
  return await runChild([
    "bun",
    "-e",
    `import { assertTreeUsable } from ${JSON.stringify(LOCK)}; assertTreeUsable("a-probe"); process.exit(${STARTED});`,
  ]);
}

/** Wait for the marker to appear, rather than for the holder to finish. */
async function marked(): Promise<boolean> {
  for (let i = 0; i < 200; i++) {
    if (existsSync(MARKER)) return true;
    await Bun.sleep(25);
  }
  return false;
}

/** Wait for the marker to go, which a released hold does on its way out. */
async function unmarked(): Promise<boolean> {
  for (let i = 0; i < 200; i++) {
    if (!existsSync(MARKER)) return true;
    await Bun.sleep(25);
  }
  return false;
}

/** A holder in its own process, so the pid in the marker is a live one. */
function holder(): { proc: Bun.Subprocess<"ignore", "pipe", "pipe">; done: Promise<number> } {
  const proc = Bun.spawn(
    ["bun", "-e", `import { holdTree } from ${JSON.stringify(LOCK)}; holdTree("a probe holding the tree"); console.log("held"); await new Promise((r) => setTimeout(r, 10_000));`],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  return { proc, done: proc.exited };
}

describe("a tree nobody is mutating", () => {
  test("lets a caller start", async () => {
    expect(existsSync(MARKER)).toBe(false);
    const { code, said } = await ask();
    expect({ started: code === STARTED }, `the caller did not start: exit ${code}, and it said ${JSON.stringify(said)}`).toEqual({
      started: true,
    });
  });
});

describe("a tree somebody is mutating", () => {
  test("refuses the caller, and says who holds it and why", async () => {
    const { proc } = holder();
    try {
      // Waited for by the marker rather than by the child's output: reading a
      // pipe to the end waits for the child to exit, and this one is holding
      // the tree on purpose.
      expect(await marked()).toBe(true);
      const { code, said } = await ask();
      expect({
        code,
        named: said.includes(`pid ${proc.pid}`),
        reason: said.includes("a probe holding the tree"),
        started: code === STARTED,
      }).toEqual({ code: 2, named: true, reason: true, started: false });
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 20_000);

  test("the holder takes its marker with it", async () => {
    const { proc, done } = holder();
    expect(await marked()).toBe(true);
    proc.kill("SIGTERM");
    await done;
    // **The common leak is ^C**, which is why the signal handlers exist. A
    // marker outliving its holder blocks every harness on the machine until
    // somebody finds a file they did not know to look for.
    expect(await unmarked()).toBe(true);
  }, 20_000);
});

describe("a marker whose holder is gone", () => {
  test("is cleared, out loud, and the caller starts", async () => {
    // A pid that cannot be running: `holdTree` never writes one, and nothing
    // else is allowed to be it.
    writeFileSync(MARKER, JSON.stringify({ pid: 2 ** 30, reason: "a run that died", since: "2026-08-24T00:00:00Z" }));
    const { code, said } = await ask();
    expect({
      started: code === STARTED,
      // Silence here would hide a mutation-check dying over and over.
      announced: said.includes("stale mutation marker"),
      gone: existsSync(MARKER),
    }).toEqual({ started: true, announced: true, gone: false });
  }, 20_000);
});

describe("a marker that cannot be read", () => {
  /**
   * **A torn write is written by somebody who is still here.** The only way to
   * catch a half-written marker is to look while it is being written, so an
   * unreadable one is the strongest evidence there is of a live holder — and
   * it carries no pid to check. Reading it as *stale* clears the marker and
   * lets the other runner build from a tree mid-mutation, which is the whole
   * failure this file exists to prevent.
   */
  test("is held, not stale — and says how to clear it", async () => {
    writeFileSync(MARKER, '{"pid": 1234, "reas');
    const { code, said } = await ask();
    expect({
      code,
      started: code === STARTED,
      kept: existsSync(MARKER),
      tellsHow: said.includes(".agent-mesh-mutating"),
    }).toEqual({ code: 2, started: false, kept: true, tellsHow: true });
  }, 20_000);
});

/**
 * The planter, against the marker it writes for everybody else.
 *
 * `mutation-check` wrote this marker from its first day and never read it, so
 * a second run overwrote the first's and the two interleaved — each planting
 * over the other's mutation in one tree. Three of them ran that way on
 * 2026-08-25 and produced verdicts about sources that never existed. The
 * marker was doing its job for every other tool and none for the one holding
 * the pen.
 */
describe("the tool that plants mutations", () => {
  const CHECK = resolve(import.meta.dir, "..", "scripts", "mutation-check.ts");

  test("refuses to start while another run holds the tree", async () => {
    const sleeper = Bun.spawn(["bun", "-e", "await new Promise(() => {})"], { stdout: "ignore", stderr: "ignore" });
    try {
      writeFileSync(
        MARKER,
        JSON.stringify({ pid: sleeper.pid, reason: "mutation-check (121 entries)", since: "2026-08-25T04:00:00.000Z" }),
      );
      // A planting run, not `--anchors`: reading the manifest touches no files
      // and is rightly allowed while somebody else is mid-mutation. The refusal
      // is about the pen, and it fires before any suite is started.
      const ran = await runChild(["bun", CHECK, "egress-deny"]);
      const complained = ran.stderr;
      expect(ran.code).toBe(2);
      expect(complained).toContain("mid-mutation");
      expect(complained).toContain(String(sleeper.pid));
    } finally {
      sleeper.kill();
      rmSync(MARKER, { force: true });
    }
  }, 60_000);
});
