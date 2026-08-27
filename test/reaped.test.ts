/**
 * The reading that tells a run that measured nothing from a run that failed.
 *
 * Both come back red. One is a finding about the tree and the other is an
 * accident on the machine, and this repository has acted on the wrong one
 * twice — a mutation anchor recorded as *not caught* when the mesh under it had
 * already been killed, and a `verify` that reported `46 fail` after a scenario
 * that sat for sixteen minutes.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reapedMidRun, report, say } from "../scripts/reaped.ts";
import { runChild } from "./child-output.ts";

const SCRIPT = join(import.meta.dir, "..", "scripts", "reaped.ts");

describe("reading a log for a run that stopped measuring", () => {
  test("a clean run is not reaped", () => {
    expect(reapedMidRun("3492 pass\n1 fail\nRan 3493 tests across 228 files.")).toBe(null);
  });

  test("one reaper line is one loss, with the count it named", () => {
    expect(reapedMidRun("(fail) something timed out\nkilled 4 dangling processes\n")).toEqual({
      lines: 1,
      processes: 4,
    });
  });

  test("the singular is the same event, and one process is still a reap", () => {
    // bun writes `killed 1 dangling process` with no `es`. A rule anchored on
    // the plural reads the smallest reap as a clean run.
    expect(reapedMidRun("killed 1 dangling process\n")).toEqual({ lines: 1, processes: 1 });
  });

  test("several files each reaping is counted as several, and the losses summed", () => {
    // The verify run that produced this: three lines, four then two then two.
    const log = "killed 4 dangling processes\n...\nkilled 2 dangling processes\n...\nkilled 2 dangling processes\n";
    expect(reapedMidRun(log)).toEqual({ lines: 3, processes: 8 });
  });

  test("says what the numbers under it are worth, and counts in words a person reads", () => {
    expect(say({ lines: 1, processes: 4 })).toContain("once");
    expect(say({ lines: 3, processes: 8 })).toContain("3 times");
    expect(say({ lines: 3, processes: 8 })).toContain("8 process(es)");
  });
});

describe("the answer a shell gets", () => {
  const said: string[] = [];
  const out = (line: string) => void said.push(line);

  test("0 for a reaped log, 1 for a clean one, 2 for one it could not read", () => {
    // Backwards from a test's convention on purpose — the caller is `if ...;
    // then retry`. Asserted here so the day somebody 'fixes' it, the retry
    // stops happening loudly rather than silently.
    expect({
      reaped: report("killed 2 dangling processes", out),
      clean: report("2 pass", out),
      unreadable: report(null, out),
    }).toEqual({ reaped: 0, clean: 1, unreadable: 2 });
  });

  test("says which of the three it is, every time", () => {
    expect(said.length).toBe(3);
    expect(said[0]).toContain("reaped: yes");
    expect(said[1]).toContain("reaped: no");
    expect(said[2]).toContain("could not read");
  });

  test("run as a command, it answers about a file on disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reaped-cli-"));
    const log = join(dir, "run.log");
    writeFileSync(log, "(fail) a scenario\nkilled 4 dangling processes\n");
    const reaped = await runChild(["bun", SCRIPT, log]);
    const missing = await runChild(["bun", SCRIPT, join(dir, "nothing-here.log")]);
    expect(
      { reaped: reaped.code, saidYes: reaped.said.includes("reaped: yes"), missing: missing.code },
      "the command's own answer differs from the function's, so a shell and a test would disagree",
    ).toEqual({ reaped: 0, saidYes: true, missing: 2 });
  }, 20_000);
});
