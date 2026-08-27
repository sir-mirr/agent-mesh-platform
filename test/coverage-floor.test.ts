import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defaults, floorFailures, parseArgs, parseLcov, readRecorded, recordedText, runCoverage, uncoveredRows, type FileCoverage, type Io } from "../scripts/coverage";

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
    ).toEqual({ targets: [], byFile: false, floor: 99, ratchet: null });
  });

  test("takes the joined form too", () => {
    expect(parseArgs(["--floor=99"])).toEqual({ targets: [], byFile: false, floor: 99, ratchet: null });
  });

  test("keeps the targets and the other flag", () => {
    expect(parseArgs(["packages/", "--by-file", "--floor", "99", "test/"]))
      .toEqual({ targets: ["packages/", "test/"], byFile: true, floor: 99, ratchet: null });
  });

  test("has no floor when none was asked for", () => {
    expect(parseArgs(["--by-file"]).floor).toBeNull();
  });

  test("refuses a floor that is not a number", () => {
    expect(() => parseArgs(["--floor", "--by-file"])).toThrow(/--floor takes a number/);
  });

  test("consumes the ratchet's path in both spellings", () => {
    expect({
      split: parseArgs(["--ratchet", "coverage-floor.json"]).ratchet,
      joined: parseArgs(["--ratchet=coverage-floor.json"]).ratchet,
      targets: parseArgs(["--ratchet", "coverage-floor.json", "test/"]).targets,
    }, "the path stayed in argv, where bun test reads it as a filter and measures nothing").toEqual({
      split: "coverage-floor.json",
      joined: "coverage-floor.json",
      targets: ["test/"],
    });
  });

  test("refuses a ratchet with no path, and a run asking for both", () => {
    expect({
      empty: (() => { try { parseArgs(["--ratchet"]); return null; } catch (e) { return (e as Error).message; } })(),
      both: (() => { try { parseArgs(["--floor", "99", "--ratchet", "f.json"]); return null; } catch (e) { return (e as Error).message; } })(),
    }).toEqual({
      empty: "coverage: --ratchet takes a path, as in `--ratchet coverage-floor.json`",
      both: "coverage: --floor and --ratchet judge the same number two ways; pass one",
    });
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
const lcov = (rows: Array<[string, number, number, number, number]>) =>
  rows.map(([path, fnf, fnh, lf, lh]) =>
    `SF:${path}\nFNF:${fnf}\nFNH:${fnh}\nLF:${lf}\nLH:${lh}\nend_of_record`).join("\n");

/** A run with every boundary held, and what it printed. */
function walk(argv: string[], report: string, status = 0, record?: string) {
  const said: string[] = [];
  const complained: string[] = [];
  const ran: Array<{ dir: string; targets: string[] }> = [];
  const wrote: Array<{ path: string; text: string }> = [];
  const state: { left: number | null } = { left: null };
  const io: Io = {
    readText: () => {
      if (record === undefined) throw new Error("the run read a record this test did not give it");
      return record;
    },
    writeText: (path, text) => { wrote.push({ path, text }); },
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
  return { said: said.join("\n"), complained: complained.join("\n"), ran, wrote, left: state.left };
}

describe("the coverage run", () => {

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

  test("orders the excluded block by what the exclusion costs, worst first", () => {
    // Two files under the exclusion, because `sort` never calls a comparator
    // on a list of one — which is how ordering the block became the last
    // unexecuted function in the script that measures this repository, while
    // the mesh excluded exactly one directory. The order is the whole point of
    // printing the block: an exclusion is a decision somebody has to weigh
    // again later, and the file it costs the most is the one to weigh first.
    const walked = walk([], lcov([
      ["packages/http/src/ui/chat.ts", 4, 0, 300, 0],
      ["packages/http/src/ui/admin.ts", 6, 0, 1200, 0],
      ["packages/http/src/main.ts", 100, 99, 1000, 999],
    ]));
    const block = walked.said.slice(walked.said.indexOf("excluded by decision"));

    expect(
      {
        heading: block.startsWith("excluded by decision (2 files, 1500 lines):"),
        biggestFirst: block.indexOf("admin.ts") < block.indexOf("chat.ts"),
      },
      "the excluded block came out in the report's file order rather than by size",
    ).toEqual({ heading: true, biggestFirst: true });
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

/** Every way the workflow calls the coverage script, as the flags each was given. */
export function coverageInvocations(workflow: string): string[] {
  return [...workflow.matchAll(/bun scripts\/coverage\.ts([^\n]*)/g)].map((match) => match[1]!);
}

/**
 * **Every one of them, not one of them.**
 *
 * The floor step names the command twice — the run, and the retry after a run
 * whose services were reaped. A check asking whether `--ratchet` appears
 * *somewhere* in the workflow passes while the invocation that decides the job
 * has been changed to `--floor 0`. That is not hypothetical: pointing
 * `a-floor-ci-runs-at-zero` at the first line left it uncaught, because the
 * second line still said `--ratchet`.
 */
export function everyInvocationRatchets(workflow: string): boolean {
  return coverageInvocations(workflow).every((flags) => /^ --ratchet coverage-floor\.json\b/.test(flags));
}

describe("the workflow", () => {
  test("is read as every invocation it makes, not as the first one that looks right", () => {
    // The synthetic pair the real file cannot provide: today both of its
    // invocations ratchet, so `some` and `every` agree there and a check
    // written either way passes. Here they do not agree.
    const oneOfEach = ["run: |", "  bun scripts/coverage.ts --ratchet coverage-floor.json | tee a.log", "  bun scripts/coverage.ts --floor 0 | tee b.log"].join("\n");
    const bothRatchet = ["run: |", "  bun scripts/coverage.ts --ratchet coverage-floor.json | tee a.log", "  bun scripts/coverage.ts --ratchet coverage-floor.json | tee b.log"].join("\n");
    expect(
      { counted: coverageInvocations(oneOfEach).length, oneDrifted: everyInvocationRatchets(oneOfEach), bothHeld: everyInvocationRatchets(bothRatchet) },
      "a workflow with one drifted invocation was read as running the ratchet",
    ).toEqual({ counted: 2, oneDrifted: false, bothHeld: true });
  });

  test("runs the ratchet, so the reopen condition has something to fire it", () => {
    const ci = readFileSync(join(import.meta.dir, "..", ".github", "workflows", "ci.yml"), "utf8");
    const recorded = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "coverage-floor.json"), "utf8"),
    ) as { funcs: number; lines: number };

    const invocations = coverageInvocations(ci);

    // The record as well as the flag. A ratchet pointed at a file that is not
    // there fails loudly, but one pointed at a record below the minimum is a
    // step that passes on a tree D-751 says is red, and from the outside the
    // two commands read the same.
    expect(
      {
        invocations: invocations.length,
        everyOneRatchets: everyInvocationRatchets(ci),
        atLeastTheMinimum: recorded.funcs >= 99 && recorded.lines >= 99,
      },
      "CI does not run the ratchet, or runs it against a record below D-751's minimum",
    ).toEqual({ invocations: invocations.length, everyOneRatchets: true, atLeastTheMinimum: true });

    // The denominator: a workflow that stopped running coverage at all would
    // make `every` above true over nothing.
    expect(invocations.length, "the workflow does not run the coverage script anywhere").toBeGreaterThan(0);
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
/**
 * **The ratchet, which is D-751 written down as a check.**
 *
 * The decision set two numbers: 99 is the minimum and 100 is the goal. A fixed
 * floor states the first and forgets the second, so a tree that reached 100.00
 * could give a whole point back without a single run going red. The record is
 * the measurement, and what has been reached is what has to be held.
 *
 * The awkward case is a *rise*, and it is deliberate that it is not silently
 * green: the raise is written into the checkout, and on CI the checkout is
 * discarded, so a quiet raise raises nothing and the record lags for ever.
 * Failing is what makes it travel in a commit.
 */
describe("the ratchet", () => {
  const record = (funcs: number, lines: number) => JSON.stringify({ funcs, lines });

  test("holds when the measurement is the record", () => {
    const walked = walk(["--ratchet", "f.json"], lcov([["packages/a.ts", 10, 10, 100, 100]]), 0, record(100, 100));

    expect(
      { held: /ratchet 100 funcs · 100 lines: held/.test(walked.said), wrote: walked.wrote.length, left: walked.left },
      "a run that measured exactly the record did not pass quietly",
    ).toEqual({ held: true, wrote: 0, left: null });
  });

  test("reddens on the metric that slipped, and says which", () => {
    const walked = walk(["--ratchet", "f.json"], lcov([["packages/a.ts", 10, 10, 1000, 995]]), 0, record(100, 100));

    expect(
      {
        named: /lines at 99\.50 is below the recorded floor of 100/.test(walked.complained),
        quietAboutFuncs: !/funcs at/.test(walked.complained),
        reopens: walked.complained.includes("D-749"),
        left: walked.left,
      },
      "a point given back read as green, or the report blamed the metric that held",
    ).toEqual({ named: true, quietAboutFuncs: true, reopens: true, left: 1 });
  });

  test("raises the record, and refuses to pass on the raise", () => {
    const walked = walk(["--ratchet", "f.json"], lcov([["packages/a.ts", 10, 10, 100, 100]]), 0, record(99, 99));

    expect(
      {
        wrote: walked.wrote[0]?.path,
        recorded: walked.wrote[0] ? JSON.parse(walked.wrote[0].text) as Record<string, unknown> : null,
        says: /above the recorded floor of 99/.test(walked.complained) && walked.complained.includes("Commit it"),
        left: walked.left,
      },
      "the raise was written and the run passed, so on CI it would raise nothing and read green for ever",
    ).toEqual({
      wrote: "f.json",
      recorded: {
        funcs: 100,
        lines: 100,
        note: "Raised by `bun scripts/coverage.ts --ratchet coverage-floor.json`. Never below 99 (D-751).",
      },
      says: true,
      left: 1,
    });
  });

  /**
   * **The failing run is the one somebody needs the list from.** On CI there is
   * no asking again: the job took twenty minutes, the checkout is gone, and the
   * log is the only artefact. Measured on `8f06416` — CI reported 99.87 funcs
   * against this machine's 100.00, and nothing in the log could say which two
   * functions, because the table was behind a flag nobody had passed.
   */
  test("names the files with something left in them when it fails", () => {
    const walked = walk(
      ["--ratchet", "f.json"],
      lcov([["packages/a.ts", 10, 9, 100, 100], ["packages/b.ts", 5, 5, 10, 10]]),
      0,
      record(100, 100),
    );

    expect(
      {
        names: /packages\/a\.ts/.test(walked.complained),
        quietAboutTheCoveredOne: !/packages\/b\.ts/.test(walked.complained),
        left: walked.left,
      },
      "a floor failed without naming the file it failed on, which is a number and no next step",
    ).toEqual({ names: true, quietAboutTheCoveredOne: true, left: 1 });
  });

  test("cannot be lowered below 99 by the record it reads", () => {
    // A record saying 40 would make the check pass on 40, which is the check
    // that can never fail again. D-751's minimum is the floor under the floor.
    const walked = walk(["--ratchet", "f.json"], lcov([["packages/a.ts", 100, 98, 100, 98]]), 0, record(40, 40));

    // **Both metrics, named separately.** One regex over the whole complaint
    // reads as covered and is not: the clamp is written per metric, so a
    // mutation to either one leaves the other still saying `below the recorded
    // floor of 99` and a test that only greps for that sentence stays green.
    expect(
      {
        funcs: /funcs at 98\.00 is below the recorded floor of 99/.test(walked.complained),
        lines: /lines at 98\.00 is below the recorded floor of 99/.test(walked.complained),
        raised: walked.wrote.length,
        left: walked.left,
      },
      "a record below the minimum was honoured, so 98% passed a check D-751 says is red",
    ).toEqual({ funcs: true, lines: true, raised: 0, left: 1 });
  });

  test("does not call a report with no files in it a pass", () => {
    const walked = walk(["--ratchet", "f.json"], lcov([["packages/http/src/ui/chat.ts", 10, 0, 100, 0]]), 0, record(100, 100));

    expect(
      { complained: walked.complained.includes("no measurement for a floor to judge"), left: walked.left },
      "everything countable was excluded and the ratchet passed on nothing",
    ).toEqual({ complained: true, left: 1 });
  });

  test("refuses a record it cannot read", () => {
    expect(
      () => walk(["--ratchet", "f.json"], lcov([["packages/a.ts", 10, 10, 100, 100]]), 0, "not json at all"),
      "an unreadable record passed, which is a check whose standard nobody can state",
    ).toThrow(/recorded floor is not JSON/);

    expect(() => walk(["--ratchet", "f.json"], lcov([["packages/a.ts", 10, 10, 100, 100]]), 0, '{"funcs": 100}'))
      .toThrow(/needs both numbers/);
  });
});

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

  /**
   * The record's two ends, which every ratchet test above replaces with a fake.
   * A raise the run announces and does not write is the failure that reads
   * correct in the log, so the write has to be the real one somewhere.
   */
  test("the record is written where it is named, and read back", () => {
    const dir = defaults.scratch();
    const path = join(dir, "coverage-floor.json");
    try {
      defaults.writeText(path, recordedText({ funcs: 100, lines: 99.5 }));

      expect(
        { onDisk: existsSync(path), readBack: readRecorded(defaults.readText(path)) },
        "the recorded floor did not survive a round trip through the filesystem",
      ).toEqual({ onDisk: true, readBack: { funcs: 100, lines: 99.5 } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
