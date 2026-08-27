/**
 * Did this run stop measuring partway through?
 *
 * `bun test` kills every subprocess it spawned when a test times out, and says
 * so in one line — `killed 4 dangling processes`. Measured on a fixture holding
 * two children, one of them `unref`ed: a two-second budget slept through took
 * both. When those children are the mesh a suite is testing against, every test
 * after that line ran against nothing, and the run's red is an accident rather
 * than a finding.
 *
 * **This repository has now paid for that reading twice.** Once in a mutation
 * run, where an anchor that was never reached was written down as *not caught*
 * and cost a morning in the wrong file — and once in `verify`, where a coverage
 * step reported `46 fail` after `[SC-QUEUE-01] ... [997773.49ms]` and three
 * reaper lines. Both numbers are about the machine, not the tree.
 *
 * `mutation-verdict.ts` already read the line for its own verdict. It is here
 * so the reading is one thing rather than three copies, and so a shell — CI's
 * coverage step — can ask the same question of a log it just captured.
 */

/** How much a run lost, when it lost some. */
export interface Reaped {
  /** How many times the runner reaped. More than one means several files. */
  lines: number;
  /** How many processes it took, summed across those lines. */
  processes: number;
}

const REAPER = /killed (\d+) dangling process/g;

/**
 * `null` when the text shows no reap — an ordinary result, not an absence of
 * information.
 */
export function reapedMidRun(text: string): Reaped | null {
  let lines = 0;
  let processes = 0;
  for (const match of text.matchAll(REAPER)) {
    lines++;
    processes += Number(match[1]);
  }
  return lines === 0 ? null : { lines, processes };
}

/** One line for a person, naming what the numbers below it are worth. */
export function say(reaped: Reaped): string {
  const times = reaped.lines === 1 ? "once" : `${reaped.lines} times`;
  return (
    `the runner reaped ${times}, taking ${reaped.processes} process(es) with it — ` +
    `everything after that ran against nothing, so this run's result is about the machine and not about the tree`
  );
}

/**
 * **Exit `0` means *yes, this log was reaped*.**
 *
 * Backwards from a test's convention, and deliberate: the only caller is a
 * shell deciding whether to retry, and `if bun scripts/reaped.ts log; then` is
 * the shape that reads correctly there. `1` is a clean run and `2` is a log
 * that could not be read, which is neither answer.
 */
export function report(text: string | null, out: (line: string) => void): number {
  if (text === null) {
    out("reaped: could not read the log, so this answers nothing");
    return 2;
  }
  const reaped = reapedMidRun(text);
  if (!reaped) {
    out("reaped: no — the runner kept its children for the whole run");
    return 1;
  }
  out(`reaped: yes — ${say(reaped)}`);
  return 0;
}

/**
 * The log, or `null` when there is no reading it.
 *
 * Exported and separate from the line below for a measured reason: a coverage
 * run only instruments the process it is in, so anything reachable solely by
 * spawning this file as a command counts as uncovered source however
 * thoroughly a test drives it. Nine lines of `import.meta.main` body took the
 * floor from 100.00 to 99.95 — and the floor was right to complain, because a
 * missing file and an unreadable one were being told apart by code no case
 * here executed.
 */
export async function readLog(path: string | undefined): Promise<string | null> {
  if (path === undefined) return null;
  try {
    return await Bun.file(path).text();
  } catch {
    return null;
  }
}

if (import.meta.main) process.exit(report(await readLog(process.argv[2]), console.log.bind(console)));
