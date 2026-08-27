/**
 * The helper that stopped a child's own output from deciding a test.
 *
 * `test/tree-lock.test.ts` read a child through `new Response(child.stdout)`,
 * and CI's coverage job threw `EBADF: bad file descriptor, epoll_ctl` out of
 * that read. The child was fine; the reader was not, and the test failed
 * pointing at the tree lock. `runChild` moves both streams into files, so the
 * only thing a test waits on is the process exiting.
 *
 * These check it carries all three answers — code, stdout, stderr — because a
 * helper that returns the code and quietly drops a stream is the same defect
 * with a nicer signature.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";

import { runChild } from "./child-output.ts";

describe("reading a child through files", () => {
  test("carries the exit code, and both streams, unmixed", async () => {
    const said = await runChild([
      "bun",
      "-e",
      `process.stdout.write("out-side"); process.stderr.write("err-side"); process.exit(7);`,
    ]);
    expect({ code: said.code, stdout: said.stdout, stderr: said.stderr, said: said.said }).toEqual({
      code: 7,
      stdout: "out-side",
      stderr: "err-side",
      said: "out-sideerr-side",
    });
  }, 20_000);

  test("carries output the child wrote before failing, not only the code", async () => {
    // The case the pipe version was for: a non-zero exit whose reason is only
    // in what the child said. Dropping it leaves a verdict with no evidence.
    const said = await runChild(["bun", "-e", `console.error("the reason"); process.exit(2);`]);
    expect({ code: said.code, sawTheReason: said.said.includes("the reason") }).toEqual({ code: 2, sawTheReason: true });
  }, 20_000);

  test("runs where it was told to, with the environment it was given", async () => {
    const where = await runChild(["bun", "-e", `process.stdout.write(process.cwd())`], { cwd: tmpdir() });
    // macOS answers `/private/var/...` for a `/var/...` tmpdir, so this asks
    // that the child moved rather than that the two strings match.
    expect({ moved: where.stdout !== process.cwd(), empty: where.stdout === "" }).toEqual({ moved: true, empty: false });

    const withEnv = await runChild(["bun", "-e", `process.stdout.write(process.env.PROBE ?? "unset")`], {
      env: { ...process.env, PROBE: "handed-over" },
    });
    expect(withEnv.stdout).toBe("handed-over");
  }, 20_000);

  test("takes its temporary directories with it, and leaves the ones it did not make", async () => {
    // A helper that leaks a directory per call is one nobody can run in a loop.
    // Counted rather than inspected: the name is an implementation detail, but
    // *how many of them exist afterwards* is the thing that goes wrong.
    const ours = () => readdirSync(tmpdir()).filter((name) => name.startsWith("child-said-"));
    const before = ours().length;
    const said = await runChild(["bun", "-e", `process.stdout.write("x".repeat(4096)); process.exit(3)`]);
    expect(
      { code: said.code, wrote: said.stdout.length, left: ours().length - before },
      "the helper kept a temporary directory after the child it was for had gone",
    ).toEqual({ code: 3, wrote: 4096, left: 0 });
  }, 20_000);
});
