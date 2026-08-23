import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defaults, floorFailures, parseArgs, parseLcov, runCoverage, uncoveredRows, type FileCoverage, type Io } from "../scripts/coverage";

const file = (over: Partial<FileCoverage> = {}): FileCoverage => ({
  path: "packages/http/src/main.ts", lines: 100, hit: 100, funcs: 100, funcsHit: 100, ...over,
});

/**
 * **D-749's reopen condition, and the thing that measures it.**
 *
 * The coverage track closed with one condition attached: a measurement below 99
 * on either metric reopens it, with no new instruction. Nothing in CI ran
 * `scripts/coverage.ts`, so as stated the condition could only fire when
 * somebody went looking — which is the same shape as `lint-preview.ts`, a good
 * check that nobody ran, and the same shape as the manifest CI now executes
 * because a documented mutation test decays exactly like the documentation it
 * replaced.
 *
 * So the floor is code, the code has a test, and the last test here reads the
 * workflow: a floor CI does not invoke is a number in a file.
 */
describe("the coverage floor", () => {
  test("names the metric that fell, and only that one", () => {
    const short = floorFailures([file({ funcs: 100, funcsHit: 98 })], 99);

    expect(short).toEqual([{ metric: "funcs", value: 98 }]);
  });

  test("names both when both fell", () => {
    const short = floorFailures([file({ funcsHit: 98, hit: 90 })], 99);

    expect(short.map((s) => s.metric)).toEqual(["funcs", "lines"]);
  });

  test("holds at the floor rather than just above it", () => {
    // 99 exactly is not below 99. An off-by-one here reopens the track on the
    // number that closed it.
    expect(
      floorFailures([file({ funcs: 100, funcsHit: 99, lines: 100, hit: 99 })], 99),
      "99 exactly was read as a fall, so the number that closed the track reopens it",
    ).toEqual([]);
  });

  test("judges the number it prints, not a decimal nobody sees", () => {
    // 98.995 — under the floor by any raw comparison, and printed as `99.00`
    // by every line of this script's report. Failing on it would put CI and the
    // report it quotes in direct contradiction, with nothing for a reader to do.
    const rounds = floorFailures([file({ funcs: 20_000, funcsHit: 19_799, lines: 20_000, hit: 19_799 })], 99);
    // One less. 98.99 prints as 98.99, and is a fall by the report's own number.
    const does = floorFailures([file({ funcs: 20_000, funcsHit: 19_798, lines: 20_000, hit: 19_798 })], 99);

    expect(
      { atNinetyNinePointZeroZero: rounds.length, below: does.map((s) => s.metric) },
      "the floor judged a decimal the report does not print, so CI and the number it quotes disagree",
    ).toEqual({ atNinetyNinePointZeroZero: 0, below: ["funcs", "lines"] });
  });

  test("fails when nothing was measured", () => {
    // The vacuous pass, which is how this check would break if it broke: an
    // empty report is not full coverage, and `pct` returning 100 for an empty
    // denominator is right for a file and wrong for a run.
    expect(
      floorFailures([], 99).map((s) => s.metric),
      "a run that measured nothing passed the floor",
    ).toEqual(["funcs", "lines"]);
  });
});

/**
 * **`--floor 99` leaves `99` in `argv`, and `99` is a test filter.**
 *
 * Every other option this script takes is a bare flag, so the argument parser
 * was one `startsWith("-")` filter and nothing else. Add an option that takes a
 * value to that and the value falls through to `bun test`, which runs the tests
 * whose names contain `99` — none — reports an empty lcov, and hands the floor
 * a measurement of nothing. The check that exists to fail would have passed on
 * every commit forever.
 */
describe("the coverage script's arguments", () => {
  test("consumes the floor's value rather than passing it to bun test", () => {
    expect(
      parseArgs(["--floor", "99"]),
      "the floor's value stayed in argv, where bun test reads it as a filter and measures nothing",
    ).toEqual({ targets: [], byFile: false, floor: 99 });
  });

  test("takes the joined form too", () => {
    expect(parseArgs(["--floor=99"])).toEqual({ targets: [], byFile: false, floor: 99 });
  });

  test("keeps the targets and the other flag", () => {
    expect(parseArgs(["packages/", "--by-file", "--floor", "99", "test/"]))
      .toEqual({ targets: ["packages/", "test/"], byFile: true, floor: 99 });
  });

  test("has no floor when none was asked for", () => {
    expect(parseArgs(["--by-file"]).floor).toBeNull();
  });

  test("refuses a floor that is not a number", () => {
    expect(() => parseArgs(["--floor", "--by-file"])).toThrow(/--floor takes a number/);
  });
});

describe("the lcov reader", () => {
  test("reads one record per file, and the four totals", () => {
    const lcov = [
      "SF:packages/http/src/main.ts", "FNF:10", "FNH:9", "LF:100", "LH:98", "end_of_record",
      "SF:packages/http/src/ui/chat.ts", "FNF:4", "FNH:0", "LF:900", "LH:0", "end_of_record",
      "", // lcov ends with one, and a trailing blank line must not open a record
    ].join("\n");

    expect(parseLcov(lcov)).toEqual([
      { path: "packages/http/src/main.ts", lines: 100, hit: 98, funcs: 10, funcsHit: 9 },
      { path: "packages/http/src/ui/chat.ts", lines: 900, hit: 0, funcs: 4, funcsHit: 0 },
    ]);
  });

  test("ignores records with no file to attach to", () => {
    expect(parseLcov("FNF:10\nLF:100\nend_of_record\n")).toEqual([]);
  });
});

/**
 * **The last functions live in files with no uncovered lines.**
 *
 * `x.map(v => f(v))` is one line, covered whether or not the array had anything
 * in it, so an arrow nobody called sits inside a line everybody ran. At 99% the
 * remaining functions are all of that shape — and the by-file table skipped
 * every file whose lines were complete, which is precisely where they were.
 */
describe("the by-file table", () => {
  test("lists a file whose lines are all covered and whose functions are not", () => {
    const rows = uncoveredRows([
      file({ path: "packages/http/src/main.ts", funcs: 281, funcsHit: 272 }),
      file({ path: "test/harness.ts" }),
    ]);

    expect(
      rows.map((f) => f.path),
      "a file at 100% of lines with an uncovered function was left out of the only table that could name it",
    ).toEqual(["packages/http/src/main.ts"]);
  });

  test("puts the most uncovered lines first, and breaks a tie on functions", () => {
    const rows = uncoveredRows([
      file({ path: "a.ts", lines: 100, hit: 99 }),
      file({ path: "b.ts", lines: 100, hit: 40 }),
      file({ path: "c.ts", lines: 100, hit: 99, funcs: 10, funcsHit: 4 }),
    ]);

    expect(rows.map((f) => f.path)).toEqual(["b.ts", "c.ts", "a.ts"]);
  });
});


/**
 * **The tool that measures coverage, measured.**
 *
 * The moment this file imported the script, bun started counting it: 65
 * uncovered lines and four uncovered functions, and the *reported* number fell
 * below the floor the script had just been written to hold. Nothing here could
 * call `main()` — it spawned a suite, read a file, printed, and exited.
 *
 * So the four things it does to the outside are parameters, and these walk it
 * with all four held: a suite that fails, one that passes, the per-file table,
 * the excluded block, and both sides of the floor.
 */
describe("the coverage run", () => {
  const lcov = (rows: Array<[string, number, number, number, number]>) =>
    rows.map(([path, fnf, fnh, lf, lh]) =>
      `SF:${path}\nFNF:${fnf}\nFNH:${fnh}\nLF:${lf}\nLH:${lh}\nend_of_record`).join("\n");

  /** A run with every boundary held, and what it printed. */
  function walk(argv: string[], report: string, status = 0) {
    const said: string[] = [];
    const complained: string[] = [];
    const ran: Array<{ dir: string; targets: string[] }> = [];
    const state: { left: number | null } = { left: null };
    const io: Io = {
      scratch: () => "/scratch",
      run: (dir, targets) => { ran.push({ dir, targets }); return { status }; },
      read: () => report,
      say: (l) => { said.push(l); },
      complain: (l) => { complained.push(l); },
      // The real one never returns, and code after it must not run here either.
      exit: ((code: number) => { state.left = code; throw new Error(`exit ${code}`); }) as (code: number) => never,
    };
    try { runCoverage(argv, io); } catch (err) {
      if (!(err instanceof Error) || !err.message.startsWith("exit ")) throw err;
    }
    return { said: said.join("\n"), complained: complained.join("\n"), ran, left: state.left };
  }

  test("refuses to report a number about a broken tree", () => {
    const walked = walk([], lcov([["packages/a.ts", 10, 10, 100, 100]]), 1);

    expect(
      { complained: walked.complained.includes("the suite did not pass"), said: walked.said, left: walked.left },
      "a failing suite still produced a percentage, or left with a success code",
    ).toEqual({ complained: true, said: "", left: 1 });
  });

  test("carries a signal death out as a failure of its own", () => {
    // `spawnSync` answers `null` for a process a signal killed. `null !== 0`
    // is the branch, and `?? 1` is what keeps it from exiting zero.
    expect(
      walk([], "", null as unknown as number).left,
      "a run a signal killed left with a success code, so a measurement of nothing reads as a pass",
    ).toBe(1);
  });

  test("runs the two default targets, in one process", () => {
    // Both, and one run: Bun's coverage covers the process it ran in, so
    // splitting these into two runs measures neither.
    expect(walk([], lcov([["packages/a.ts", 10, 10, 100, 100]])).ran)
      .toEqual([{ dir: "/scratch", targets: ["packages/", "test/"] }]);
  });

  test("passes the targets it was given instead", () => {
    expect(walk(["packages/http/"], lcov([["packages/a.ts", 1, 1, 1, 1]])).ran[0]!.targets)
      .toEqual(["packages/http/"]);
  });

  test("prints the number with the excluded files and the number without", () => {
    const walked = walk([], lcov([
      ["packages/http/src/main.ts", 100, 99, 1000, 999],
      ["packages/http/src/ui/chat.ts", 4, 0, 1000, 0],
    ]));

    expect(
      {
        both: /everything measured\s+95\.19 funcs ·\s+49\.95 lines ·\s+2 files/.test(walked.said),
        counted: /reported\s+99\.00 funcs ·\s+99\.90 lines ·\s+1 files/.test(walked.said),
        named: walked.said.includes("packages/http/src/ui/chat.ts"),
      },
      "the exclusion was taken on trust: the two numbers or the excluded file list are missing",
    ).toEqual({ both: true, counted: true, named: true });
  });

  test("marks an excluded file in the per-file table rather than hiding it", () => {
    const walked = walk(["--by-file"], lcov([
      ["packages/http/src/ui/chat.ts", 4, 0, 1000, 0],
      ["packages/http/src/main.ts", 100, 99, 1000, 1000],
    ]));

    expect({
      excludedRow: /1000 lines\s+4 funcs.*chat\.ts \(excluded\)/.test(walked.said),
      // Lines complete, one function short — the row this table used to drop.
      funcsOnlyRow: /0 lines\s+1 funcs.*main\.ts$/m.test(walked.said),
      counted: walked.said.includes("0 file(s) with nothing uncovered"),
    }).toEqual({ excludedRow: true, funcsOnlyRow: true, counted: true });
  });

  test("says the floor held, on a tree that holds it", () => {
    const walked = walk(["--floor", "99"], lcov([["packages/a.ts", 100, 99, 100, 99]]));

    expect({ said: walked.said.includes("floor 99: held, on both metrics."), left: walked.left })
      .toEqual({ said: true, left: null });
  });

  test("names the metric that fell, and leaves with a failure", () => {
    const walked = walk(["--floor", "99"], lcov([["packages/a.ts", 100, 98, 100, 100]]));

    expect(
      {
        named: walked.complained.includes("funcs at 98.00 is below the floor of 99"),
        lines: walked.complained.includes("lines at"),
        d749: walked.complained.includes("D-749"),
        left: walked.left,
      },
      "a fall left with a success code, or did not say which metric fell",
    ).toEqual({ named: true, lines: false, d749: true, left: 1 });
  });

  test("does not call a report with no files in it a pass", () => {
    const walked = walk(["--floor", "99"], "");

    expect({ complained: walked.complained.includes("names no files"), left: walked.left })
      .toEqual({ complained: true, left: 1 });
  });

  test("prints the numbers and leaves quietly when no floor was asked for", () => {
    const walked = walk([], lcov([["packages/a.ts", 100, 1, 100, 1]]));

    expect({ left: walked.left, complained: walked.complained }).toEqual({ left: null, complained: "" });
  });
});

describe("the workflow", () => {
  test("runs the floor, so the reopen condition has something to fire it", () => {
    const ci = readFileSync(join(import.meta.dir, "..", ".github", "workflows", "ci.yml"), "utf8");

    // The number, not just the flag. A floor CI runs at 0 is a step that
    // passes on any tree, and reads from the outside exactly like this one.
    expect(
      { invokes: /bun scripts\/coverage\.ts --floor 99\b/.test(ci) },
      "CI does not run the floor at 99, so the reopen condition has nothing to fire it",
    ).toEqual({ invokes: true });
  });
});


/**
 * The three boundaries every case above replaces.
 *
 * Handing in fakes is what makes the rest of this file possible, and it left
 * the real spawn, the real read and the real scratch directory as functions
 * nothing ran — in the tool that reports which functions nothing runs. What can
 * be wrong with the spawn is the spelling of its flags, and a misspelt
 * `--coverage-reporter` writes no report rather than failing, so it is run here
 * against one small suite instead of being reasoned about.
 */
describe("the boundaries the fakes stand in for", () => {
  test("the scratch directory is fresh, and the read comes back out of it", () => {
    const dir = defaults.scratch();
    try {
      expect(existsSync(dir)).toBe(true);
      writeFileSync(join(dir, "lcov.info"), "SF:probe.ts\nDA:1,1\nend_of_record\n");

      expect(defaults.read(dir)).toContain("SF:probe.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the spawn asks bun for an lcov report, and gets one", () => {
    const dir = defaults.scratch();
    try {
      // One file, chosen for being fast and having no service behind it.
      const status = defaults.run(dir, ["packages/store/src/checkpoint.test.ts"]).status;

      expect({ status, wrote: existsSync(join(dir, "lcov.info")) }, "the flags this passes bun no longer produce a report").toEqual({
        status: 0,
        wrote: true,
      });
      // A report about the file that ran, not an empty one.
      expect(parseLcov(defaults.read(dir)).length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
