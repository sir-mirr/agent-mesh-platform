import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { floorFailures, parseArgs, parseLcov, type FileCoverage } from "../scripts/coverage";

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
