/**
 * The coverage number, and what is not in it.
 *
 * `bun test --coverage` has no path-ignore option — `--coverage-reporter` and
 * `--coverage-dir` are the whole surface — so an exclusion has to happen after
 * the fact. Doing it here rather than in a config key means it can be *counted*:
 * this prints the number with the excluded files and the number without, so a
 * reader can see what the exclusion is worth rather than taking the smaller
 * denominator on trust.
 *
 * `packages/http/src/ui/` is excluded by the owner's decision, relayed through
 * `agent-mesh-local-pm`. The four files there are server-rendered HTML —
 * `chat.ts` alone is over a thousand lines of template — reached by a browser
 * rather than by a caller.
 *
 * **Bun reports only the files a test loaded.** A file nobody imports is absent
 * from the report, not `0%`, so the fastest way to raise this number is to stop
 * importing the hard parts. `packages/platform-web/src/every-module.test.ts`
 * exists to stop that, and this script prints the file count beside the
 * percentage for the same reason.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Excluded from the denominator, by decision rather than by accident. */
const EXCLUDED = [/^packages\/http\/src\/ui\//];

export type FileCoverage = { path: string; lines: number; hit: number; funcs: number; funcsHit: number };

/** One record per file, out of an lcov report. */
export function parseLcov(text: string): FileCoverage[] {
  const files: FileCoverage[] = [];
  let current: FileCoverage | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) {
      current = { path: line.slice(3).trim(), lines: 0, hit: 0, funcs: 0, funcsHit: 0 };
    } else if (!current) {
      continue;
    } else if (line.startsWith("LF:")) current.lines = Number(line.slice(3));
    else if (line.startsWith("LH:")) current.hit = Number(line.slice(3));
    else if (line.startsWith("FNF:")) current.funcs = Number(line.slice(4));
    else if (line.startsWith("FNH:")) current.funcsHit = Number(line.slice(4));
    else if (line.startsWith("end_of_record")) { files.push(current); current = null; }
  }
  return files;
}

const pct = (hit: number, total: number) => (total === 0 ? 100 : (hit / total) * 100);

/**
 * The number as this script *prints* it — two decimals.
 *
 * The floor below compares against this rather than against the raw ratio, so
 * that the number a reader is shown and the number the check judges are the
 * same number. The alternative loses runs to a third decimal nothing displays:
 * 98.995 prints as `99.00` and would fail a check reading the full ratio, and
 * "the report says 99.00 and CI says it is below 99" is not a failure anybody
 * can act on.
 */
const shown = (value: number) => Number(value.toFixed(2));

/** One summary row: the label, both percentages, and the file count. */
export function line(label: string, files: FileCoverage[]): string {
  const m = measure(files);
  return (
    `${label.padEnd(22)} ${m.funcs.toFixed(2).padStart(6)} funcs · ` +
    `${m.lines.toFixed(2).padStart(6)} lines · ${String(files.length).padStart(3)} files`
  );
}

/** Both totals over a set of files, as percentages. */
export function measure(files: FileCoverage[]): { funcs: number; lines: number } {
  const sum = (pick: (f: FileCoverage) => number) => files.reduce((n, f) => n + pick(f), 0);
  return {
    funcs: pct(sum((f) => f.funcsHit), sum((f) => f.funcs)),
    lines: pct(sum((f) => f.hit), sum((f) => f.lines)),
  };
}

export type Shortfall = { metric: "funcs" | "lines"; value: number };

/**
 * The metrics that fell through the floor, if any.
 *
 * D-749 closed the coverage track with one condition: a measurement below 99
 * on *either* metric reopens it, without a new instruction. A condition that
 * reopens a track automatically has to be measured by something that runs on
 * its own — until this existed, nothing in CI ran this script at all, so the
 * only way to reach the condition was for somebody to go looking for it, which
 * is the opposite of automatic.
 *
 * An empty denominator is 0 here and 100 in `measure`, and the difference is
 * deliberate. A file with no functions in it displays as covered because there
 * is nothing in it to miss; a *run* that measured no functions at all measured
 * nothing, and a floor that passes on nothing is the check that can never fail.
 * Every way this measurement breaks — a filter matching no test, a report read
 * from the wrong directory — arrives as an empty set.
 */
export type Recorded = { funcs: number; lines: number };

/** Both metrics over the whole set, with the empty denominator counted as nothing measured. */
export function metrics(files: FileCoverage[]): Recorded {
  const sum = (pick: (f: FileCoverage) => number) => files.reduce((n, f) => n + pick(f), 0);
  const ratio = (hit: number, total: number) => (total === 0 ? 0 : (hit / total) * 100);
  return {
    funcs: ratio(sum((f) => f.funcsHit), sum((f) => f.funcs)),
    lines: ratio(sum((f) => f.hit), sum((f) => f.lines)),
  };
}

export function floorFailures(files: FileCoverage[], floor: number): Shortfall[] {
  const m = metrics(files);
  return (["funcs", "lines"] as const)
    .map((metric) => ({ metric, value: m[metric] }))
    .filter((s) => shown(s.value) < floor);
}

/** D-751: 99 is the minimum, whatever the record says. A ratchet cannot lower it. */
export const RATCHET_MINIMUM = 99;

export type Rise = { metric: Shortfall["metric"]; from: number; to: number };

/**
 * The measurement judged against a recorded floor that rises with it.
 *
 * D-751 set two numbers rather than one: 99 is the minimum and 100 is the
 * goal. A fixed floor at 99 states the first and abandons the second — a tree
 * measuring 100.00 can lose a whole point without anything going red, and
 * nothing would name the day it happened. The record here is the measurement
 * itself, so what has been reached is what has to be held.
 *
 * `RATCHET_MINIMUM` is the reason the record is a floor and not just a
 * remembered number: a record that somehow said 40 would make the check pass
 * on 40, which is the check that cannot fail again.
 *
 * A *rise* is reported rather than silently accepted, and that is the whole
 * design. Writing the new number is not enough: on CI the write lands in a
 * checkout that is thrown away at the end of the job, so a ratchet that raised
 * quietly would raise nothing and read as green for ever. Reporting it makes
 * the record travel the only way it can — in a commit.
 */
export function ratchetVerdict(
  files: FileCoverage[],
  recorded: Recorded,
): { fallen: Shortfall[]; risen: Rise[]; floor: Recorded } {
  const floor: Recorded = {
    funcs: Math.max(RATCHET_MINIMUM, shown(recorded.funcs)),
    lines: Math.max(RATCHET_MINIMUM, shown(recorded.lines)),
  };
  const m = metrics(files);
  const fallen: Shortfall[] = [];
  const risen: Rise[] = [];
  for (const metric of ["funcs", "lines"] as const) {
    const value = shown(m[metric]);
    if (value < floor[metric]) fallen.push({ metric, value: m[metric] });
    else if (value > floor[metric]) risen.push({ metric, from: floor[metric], to: value });
  }
  return { fallen, risen, floor };
}

/**
 * The record, or an error naming what is wrong with it.
 *
 * An unreadable record is not a missing floor: it is a check whose standard
 * nobody can state, and passing on it would be the same failure the empty
 * denominator is guarded against above.
 */
export function readRecorded(text: string): Recorded {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("coverage: the recorded floor is not JSON");
  }
  const r = parsed as Partial<Recorded>;
  if (!Number.isFinite(r?.funcs) || !Number.isFinite(r?.lines)) {
    throw new Error('coverage: the recorded floor needs both numbers, as in {"funcs": 100, "lines": 100}');
  }
  return { funcs: Number(r.funcs), lines: Number(r.lines) };
}

/** What gets written back when the measurement has risen above the record. */
export function recordedText(floor: Recorded): string {
  return `${JSON.stringify(
    {
      funcs: floor.funcs,
      lines: floor.lines,
      note: "Raised by `bun scripts/coverage.ts --ratchet coverage-floor.json`. Never below 99 (D-751).",
    },
    null,
    2,
  )}\n`;
}

/**
 * The files with something left in them, worst first by uncovered lines.
 *
 * **A file with no uncovered lines and an uncovered function belongs here.**
 * Sorting by uncovered lines puts it last, at zero, which is right — it is the
 * smallest work in the report — but dropping it was not, and that is what the
 * report did until the last functions in this repository turned out to live
 * nowhere else. `FNF`/`FNH` are the only function records Bun's lcov writes:
 * how many a file has and how many ran, with no name and no line for the ones
 * that did not, so this list is the whole of what a report can say about them
 * and the rest is reading the file.
 */
export function uncoveredRows(files: FileCoverage[]): FileCoverage[] {
  return files
    .filter((f) => f.lines - f.hit > 0 || f.funcs - f.funcsHit > 0)
    .sort((a, b) => (b.lines - b.hit) - (a.lines - a.hit) || (b.funcs - b.funcsHit) - (a.funcs - a.funcsHit));
}

export type Options = {
  targets: string[];
  byFile: boolean;
  floor: number | null;
  ratchet: string | null;
};

/**
 * `--by-file` prints the per-file table, worst first by *uncovered lines*.
 *
 * The totals say how far there is to go and nothing about where to stand. A
 * percentage sorts small files to the top — a 12-line module at 0% looks worse
 * than a 900-line one at 60% and is worth a fiftieth as much — so the order
 * there is the count of lines nobody has run, which is the same thing as the
 * work each file is worth.
 *
 * It lists a file with **uncovered functions and no uncovered lines**, which
 * for a long time it silently did not. A single-line arrow sits inside a line
 * that ran — `x.map(v => f(v))` is covered whether or not the array had
 * anything in it — so the last functions left in a repository at 99% live
 * exclusively in files this table used to skip.
 *
 * `--floor 99` exits non-zero below that number. Its argument is consumed
 * here rather than filtered out by shape: a bare `99` left in `argv` becomes a
 * *test filter*, and `bun test 99` matches no test, reports an empty lcov, and
 * a floor over zero files passes at 100%. The failing check would have been the
 * one that always passes.
 */
export function parseArgs(argv: string[]): Options {
  const targets: string[] = [];
  let byFile = false;
  let floor: number | null = null;
  let ratchet: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--by-file") byFile = true;
    else if (arg === "--floor") floor = Number(argv[++i]);
    else if (arg.startsWith("--floor=")) floor = Number(arg.slice("--floor=".length));
    else if (arg === "--ratchet") ratchet = argv[++i] ?? "";
    else if (arg.startsWith("--ratchet=")) ratchet = arg.slice("--ratchet=".length);
    else if (!arg.startsWith("-")) targets.push(arg);
  }
  if (floor !== null && !Number.isFinite(floor)) {
    throw new Error("coverage: --floor takes a number, as in `--floor 99`");
  }
  // Both consume their argument, so neither leaves a stray word behind to
  // become a test filter — the failure the paragraph above is about.
  if (ratchet === "") {
    throw new Error("coverage: --ratchet takes a path, as in `--ratchet coverage-floor.json`");
  }
  if (floor !== null && ratchet !== null) {
    throw new Error("coverage: --floor and --ratchet judge the same number two ways; pass one");
  }
  return { targets, byFile, floor, ratchet };
}

/**
 * Everything this script does, with the four things it does *to the outside*
 * as parameters: run the suite, read the report, print, and leave.
 *
 * The seams are here because of what happened the moment this file grew a
 * floor. `test/coverage-floor.test.ts` imports it, so bun's report started
 * counting it — 65 uncovered lines and four uncovered functions in a file
 * nothing could call, and the *reported* number fell below the floor the file
 * had just been written to hold. A tool that measures coverage is not exempt
 * from being measured, and the honest fix is the same one this repository has
 * used everywhere else: bind the boundary, do not wrap it.
 */
export type Io = {
  /** Runs the suite. Returns its exit status, `null` for a signal. */
  run?: (dir: string, targets: string[]) => { status: number | null };
  /** Reads `lcov.info` out of the directory the run wrote to. */
  read?: (dir: string) => string;
  /** Where the run writes. A fresh directory each time, so nothing carries. */
  scratch?: () => string;
  /** Reads the recorded ratchet floor. */
  readText?: (path: string) => string;
  /** Writes it back, on the runs where the measurement has risen above it. */
  writeText?: (path: string, text: string) => void;
  say?: (line: string) => void;
  complain?: (line: string) => void;
  exit?: (code: number) => never;
};

/**
 * The boundary itself, exported so it can be run once.
 *
 * Every case below hands in fakes — that is the point of the seam — which left
 * the three real ones as functions nothing executed: the spawn, the read and
 * the scratch directory. The spawn is the one worth executing rather than
 * reasoning about, because what can be wrong with it is the flag spelling, and
 * a misspelt `--coverage-reporter` produces an empty report rather than an
 * error.
 */
export const defaults: Required<Io> = {
  run: (dir, targets) =>
    spawnSync(
      "bun",
      ["test", "--coverage", "--coverage-reporter=lcov", `--coverage-dir=${dir}`, ...targets],
      { stdio: ["ignore", "inherit", "inherit"] },
    ),
  read: (dir) => readFileSync(join(dir, "lcov.info"), "utf8"),
  readText: (path) => readFileSync(path, "utf8"),
  writeText: (path, text) => writeFileSync(path, text),
  scratch: () => mkdtempSync(join(tmpdir(), "agent-mesh-coverage-")),
  say: console.log.bind(console),
  complain: console.error.bind(console),
  exit: process.exit.bind(process) as (code: number) => never,
};

export function runCoverage(argv: string[], io: Io = {}): void {
  const { run, read, scratch, readText, writeText, say, complain, exit } = { ...defaults, ...io };
  const { targets, byFile, floor, ratchet } = parseArgs(argv);
  const dir = scratch();
  const status = run(dir, targets.length ? targets : ["packages/", "test/"]).status;
  if (status !== 0) {
    complain("\ncoverage: the suite did not pass, so the number below would be about a broken tree");
    return exit(status ?? 1);
  }

  const all = parseLcov(read(dir));
  const excluded = all.filter((f) => EXCLUDED.some((re) => re.test(f.path)));
  const counted = all.filter((f) => !EXCLUDED.some((re) => re.test(f.path)));

  say("");
  say(line("everything measured", all));
  say(line("reported", counted));
  const table = (files: FileCoverage[]) =>
    uncoveredRows(files).map((f) => {
      const mark = EXCLUDED.some((re) => re.test(f.path)) ? " (excluded)" : "";
      return (
        `  ${String(f.lines - f.hit).padStart(5)} lines  ${String(f.funcs - f.funcsHit).padStart(3)} funcs  ` +
        `${pct(f.hit, f.lines).toFixed(2).padStart(6)}% lines  ${pct(f.funcsHit, f.funcs).toFixed(2).padStart(6)}% funcs  ` +
        `${f.path}${mark}`
      );
    });

  if (byFile) {
    say("\nby file, worst first by lines nobody ran:\n");
    const rows = table(all);
    for (const row of rows) say(row);
    say(`\n  ${all.length - rows.length} file(s) with nothing uncovered, not listed`);
  }

  if (excluded.length > 0) {
    say(`\nexcluded by decision (${excluded.length} files, ${excluded.reduce((n, f) => n + f.lines, 0)} lines):`);
    for (const f of [...excluded].sort((a, b) => b.lines - a.lines)) {
      say(`  ${f.path.padEnd(40)} ${String(f.lines).padStart(5)} lines · ${pct(f.hit, f.lines).toFixed(2)}%`);
    }
  }

  if (ratchet !== null) {
    if (counted.length === 0) {
      complain("\ncoverage: the report names no files, so there is no measurement for a floor to judge");
      return exit(1);
    }
    const { fallen, risen, floor: at } = ratchetVerdict(counted, readRecorded(readText(ratchet)));
    for (const s of fallen) {
      complain(`\ncoverage: ${s.metric} at ${s.value.toFixed(2)} is below the recorded floor of ${at[s.metric]}`);
    }
    if (fallen.length > 0) {
      // **Named here rather than behind `--by-file`.** The run that fails is
      // the run somebody needs the list from, and on CI there is no second
      // chance to ask: the job took twenty minutes, the checkout is gone, and
      // the only artefact is this log. Measured on 8f06416 — CI reported
      // 99.87 funcs where this machine reported 100.00, and the log could not
      // say which two functions, because nobody had passed the flag.
      for (const row of table(counted)) complain(row);
      complain("D-749 reopens the coverage track on this, without waiting for a new instruction.");
      return exit(1);
    }
    if (risen.length > 0) {
      const raised = { ...at };
      for (const r of risen) {
        raised[r.metric] = r.to;
        complain(`\ncoverage: ${r.metric} is at ${r.to.toFixed(2)}, above the recorded floor of ${r.from}`);
      }
      writeText(ratchet, recordedText(raised));
      complain(
        `${ratchet} has been raised to what this run measured. Commit it: a raise written` +
        " inside a CI checkout goes away with the checkout, so the record only rises if it travels in a commit.",
      );
      return exit(1);
    }
    say(`\nratchet ${at.funcs} funcs · ${at.lines} lines: held, with nothing to raise.`);
    return;
  }

  if (floor === null) return;
  if (counted.length === 0) {
    complain("\ncoverage: the report names no files, so there is no measurement for a floor to judge");
  }
  const short = floorFailures(counted, floor);
  if (short.length === 0) {
    say(`\nfloor ${floor}: held, on both metrics.`);
    return;
  }
  for (const s of short) {
    complain(`\ncoverage: ${s.metric} at ${s.value.toFixed(2)} is below the floor of ${floor}`);
  }
  complain("D-749 reopens the coverage track on this, without waiting for a new instruction.");
  return exit(1);
}

if (import.meta.main) runCoverage(process.argv.slice(2));
