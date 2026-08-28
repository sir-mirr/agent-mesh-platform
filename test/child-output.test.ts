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
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runChild } from "./child-output.ts";

/**
 * The two places a pipe is still the only thing that can answer.
 *
 * Both read a child that is **still running** — one waits for a boot message
 * before killing the service, the other for a mutation to land before killing
 * the tool. A file cannot answer *has it said this yet*, so these keep the
 * pipe, and the exposure is named rather than left to be rediscovered.
 *
 * Keyed by file and by what makes it the exception, so a file that stops being
 * one is a red here rather than a line nobody revisits.
 */
const STILL_RUNNING: Record<string, string> = {
  "misconfigured-boot.test.ts": "waits for a service to say it came up, then kills it — the read is before the exit",
  "mutation-verdict.test.ts": "waits for the mutation to appear in `git status`, then kills the tool mid-plant",
};

describe("the sweep off pipes", () => {
  test("leaves a pipe only where the child is still running", () => {
    const dir = import.meta.dir;
    const offenders: string[] = [];
    let scanned = 0;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".ts") || name.startsWith("child-output")) continue;
      scanned++;
      const text = readFileSync(join(dir, name), "utf8");
      const reads = text
        .split("\n")
        .filter((line) => /new Response\(\w+\.std(out|err)\)/.test(line) && !/^\s*(\/\/|\*)/.test(line));
      if (reads.length > 0 && !(name in STILL_RUNNING)) offenders.push(`${name} (${reads.length})`);
    }
    expect(
      offenders,
      "a suite went back to reading a child through a pipe — EBADF out of that read failed main's CI twice, with the child running correctly",
    ).toEqual([]);
    // The denominator. A scan that read nothing reports the same empty list as
    // a repository with nothing wrong in it, which is the failure this whole
    // file is about, one level up.
    expect(scanned, "the scan read no test files, so the empty list above is about nothing").toBeGreaterThan(50);
  });

  test("names no exception that has stopped being one", () => {
    // The other direction, and the one an allow-list rots in: a file listed
    // here that no longer reads a pipe keeps its licence for the next person.
    const stale = Object.keys(STILL_RUNNING).filter((name) => {
      const text = readFileSync(join(import.meta.dir, name), "utf8");
      return !text.split("\n").some((line) => /new Response\(\w+\.std(out|err)\)/.test(line) && !/^\s*(\/\/|\*)/.test(line));
    });
    expect(stale, "these are listed as needing a pipe and no longer read one").toEqual([]);
  });
});

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

  test("hands the child what it was told to write on its stdin, and an end of file otherwise", async () => {
    // A hook reads its turn off stdin. Handed nothing, it must still see a
    // closed stream rather than waiting for one that never ends.
    const read = `process.stdout.write(await new Response(Bun.stdin.stream()).text() || "nothing-was-piped")`;
    const piped = await runChild(["bun", "-e", read], { stdin: "the turn's own input" });
    const bytes = await runChild(["bun", "-e", read], { stdin: new TextEncoder().encode("as bytes") });
    const none = await runChild(["bun", "-e", read]);
    expect({ piped: piped.stdout, bytes: bytes.stdout, none: none.stdout }).toEqual({
      piped: "the turn's own input",
      bytes: "as bytes",
      none: "nothing-was-piped",
    });
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
