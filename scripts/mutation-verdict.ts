export type Verdict =
  | { kind: "caught" }
  | { kind: "not-caught" }
  | { kind: "inconclusive"; why: string };

/** The marker bun prints, once, for each test that failed. */
export const FAIL_MARKER = "(fail)";

/**
 * What a test run actually said about a mutation.
 *
 * **A summary is not the same as a run**, and this function is the whole of
 * that distinction. `send-idempotent-retry` once came back `0 pass / 1 fail`
 * with `a beforeEach/afterEach hook timed out`: the mesh never came up, no test
 * executed, and the guard had no chance to object — yet the run was recorded as
 * a finding about the guard.
 *
 * The rule that followed was *`0 pass` means the file did not run*, on the
 * reasoning that one mutation breaks one guard while the rest of the file still
 * passes. True of every entry in the manifest until `message-status.test.ts`,
 * which holds **one test**: when its guard objected the summary was `0 pass / 1
 * fail`, and a correctly caught mutation was called inconclusive.
 *
 * So `0 pass` means two different things and the count cannot separate them —
 * the ambiguity this script exists to hunt, sitting in the script. What
 * separates them is why nothing passed, and that is what is read here.
 *
 * Extracted from the loop so it can be tested. The predicate deciding whether
 * every other verdict is believed was the one piece of this with no test of its
 * own.
 */
export function readVerdict(output: string, expect: string[], exitCode: number, named?: number): Verdict {
  // **The last counts, not the first.** Bun prints its summary at the end, and
  // everything before it is the run's own output — including a failure message
  // quoting a string that happens to read like a summary. That is not
  // hypothetical: `exiting-zero-is-reported-as-a-result` mutates a broadcast to
  // say `0 pass / 0 fail`, the assertion failure quotes it, and reading the
  // first match made a correctly caught mutation report as *nothing ran*. A
  // verdict this script produces about its own blindness is the failure it
  // exists to hunt, arriving one level up.
  const counts = (unit: string): number => {
    const seen = [...output.matchAll(new RegExp(`(\\d+) ${unit}`, "g"))];
    return Number(seen.at(-1)?.[1] ?? "0");
  };
  const passed = counts("pass");
  const failed = counts("fail");
  const expected = expect.every((e) => output.includes(e));
  // Bun's phrasing when a suite dies before its tests — read with the source
  // it echoes taken out.
  //
  // **A failing test is quoted back with its source, and a fixture is source.**
  // Bun prints the failing assertion's lines with an `NNN | ` prefix, so a
  // suite holding `"error: a beforeEach hook timed out"` as a fixture hands
  // this predicate its own words back. `an-elided-run-forgets-what-it-held`
  // planted cleanly, its guard objected, and the verdict came back *a hook
  // died* — measured, from the suite that tests this function.
  //
  // The same shape as reading the first `N pass` instead of the last: the run's
  // output and what the run quoted are not the same text.
  const hookDied = /\bhook (timed out|failed|threw)/i.test(output.replace(/^\s*\d+ \|.*$/gm, ""));

  // **A summary without the failures it counts is a cut-off run.** bun prints
  // one `(fail) suite > title` line per failing test, and with a large enough
  // error — a jsdom node in a failed `toBe(null)` serialises to its whole graph
  // — it cuts the output mid-token and the line never arrives, while the
  // summary at the end still says `1 fail`. Every string the entry names is
  // then missing for a reason that has nothing to do with the guard, and
  // `the-bell-moves-inside-the-trail` was written down as not caught on
  // exactly that: caught when run alone, missed in a batch of 112.
  //
  // Counted rather than measured against a size, because the size that drowns
  // a run depends on what it printed. Fewer names than failures is the run
  // saying it did not finish telling us.
  // **Whose hook died.** bun attributes a dead hook to the test above it:
  //
  // ```
  // (fail) what a reconnecting audit stream replays > (unnamed) [5032.93ms]
  //   ^ a beforeEach/afterEach hook timed out for this test.
  // ```
  //
  // A suite is not one test, and one dead hook does not mean nothing ran.
  // `the-poller-anchor-stands-still` planted cleanly, the guard it names
  // objected — its title on a `(fail)` line, 145 pass and 4 fail — and a
  // *different* test's `beforeEach` timed out in the same run. Reading the
  // hook first threw the verdict away and reported the entry as unmeasured on
  // every run there could ever be.
  //
  // So the hook decides only when it is the reason the expected message is
  // missing: nothing failed but hooks, or the expected string names a test
  // whose own hook is the one that died. Anything else and the run reached the
  // guard, whatever else went wrong around it.
  const failures = [...output.matchAll(/^\s*\(fail\) (.*)$/gm)];
  const killedByHook = new Set<string>();
  for (const failure of failures) {
    const rest = output.slice(failure.index! + failure[0].length, failure.index! + failure[0].length + 200);
    if (/^\s*\^\s*a [^\n]*hook (timed out|failed|threw)/m.test(rest)) killedByHook.add(failure[1]!);
  }
  const onlyHooksFailed = failures.length > 0 && killedByHook.size === failures.length;
  const expectedOnlyInADeadTest =
    expected && expect.every((e) => [...killedByHook].some((t) => t.includes(e)));

  if (hookDied && (!expected || onlyHooksFailed || expectedOnlyInADeadTest)) {
    return { kind: "inconclusive", why: "a hook died, so the guard was never reached" };
  }
  if (named !== undefined && failed > named) {
    return {
      kind: "inconclusive",
      why: `the run's output was cut short — ${failed} failed, ${named} named`,
    };
  }
  if (passed === 0 && failed === 0) return { kind: "inconclusive", why: "nothing ran" };
  // A silent guard and a broken suite look identical from here.
  if (passed === 0 && !expected) {
    return { kind: "inconclusive", why: "nothing passed and the expected message is absent" };
  }
  // **A browser that could not reach anything drew nothing.** Five entries in
  // one shard came back `not caught` together, each with 132 of 136 scenarios
  // failing on `net::ERR_INTERNET_DISCONNECTED`: the machine's network went
  // away mid-run. Re-measured with it back, they are caught. Nothing about a
  // guard was learned either way, and five findings against five guards is the
  // most expensive thing this tool can produce — a day spent in the wrong file.
  //
  // Only when the expected message is absent, for the same reason the hook rule
  // is: a scenario that asserts what an offline console does prints this string
  // while working perfectly, and it must still be allowed to decide.
  if (!expected && /net::ERR_[A-Z_]+/.test(output)) {
    return { kind: "inconclusive", why: "the browser could not reach the network, so nothing was drawn" };
  }
  // **A run whose services were killed under it measured nothing after that
  // point.** `bun test` reaps every subprocess it spawned when a test times
  // out, and says so in one line: `killed N dangling processes`. Measured on a
  // fixture holding two children, one of them `unref`ed — a 2s timeout took
  // both, and every test after it ran against nothing.
  //
  // The browser suite met this once. The mesh went down mid-file, thirty
  // scenarios failed to connect, and the anchor being measured was written
  // down as *not caught* when it had never been reached — a morning spent
  // looking for a fixture problem that was not there, and two wrong
  // attributions on the way.
  //
  // Only when the expected message is absent, for the same reason as the two
  // rules above: a guard that objected before the reaper arrived still decides.
  if (!expected && /killed \d+ dangling process/.test(output)) {
    return {
      kind: "inconclusive",
      why: "the runner reaped the services mid-run, so everything after that ran against nothing",
    };
  }
  return exitCode !== 0 && expected ? { kind: "caught" } : { kind: "not-caught" };
}

/**
 * Do repeated runs of the same mutation agree?
 *
 * **One run cannot tell a guard from a coin.** `wal-reminder-fold` was written
 * down as caught on the run that added it, then passed three of three on the
 * next full pass: the behaviour it removed — `close()` folding a write-ahead log
 * — happens only when no prepared statement survives to exit, which is the
 * collector's timing rather than the guard's doing. Nothing here was looking,
 * and it surfaced because a full pass happened to disagree with an earlier
 * filtered one. That is luck, and luck is not a mechanism.
 *
 * A disagreement is reported as its own kind rather than folded into
 * `not-caught`, because the two ask for different repairs: `not-caught` says
 * write a guard, a flap says the guard is measuring something it does not
 * control.
 *
 * A single run agrees with itself. That is not a special case to be defended
 * against — it is what `--repeat 1` means, and it keeps the default honest
 * about having checked nothing here.
 */
export function verdictsAgree(kinds: Array<Verdict["kind"]>): boolean {
  return new Set(kinds).size <= 1;
}

/**
 * One line for a run, with the failures separated by what they mean.
 *
 * `✗` used to carry three different facts. agent-mesh-local-pm read
 * `✗ signed-rate-limit` as a guard that missed something when it was the tool
 * refusing to measure — the tree had changed under it — and said so: **one line
 * with two meanings**. The script already knew the difference; the screen threw
 * it away.
 *
 * They are different findings and they ask different things:
 *
 * ```
 * not-caught     the guard missed it            → write or fix the guard
 * no-match       the entry's pattern is gone    → the manifest is stale
 * inconclusive   the run decided nothing        → measure again
 * flapped        the runs disagreed             → the guard is not measuring the guard
 * ```
 *
 * Only the first is a statement about the code. Folding the other three into it
 * is how a tooling problem gets recorded as a defect, which is the failure this
 * script exists to prevent — sitting in the script's own output.
 */
export function summarise(kinds: Array<FailureKindName>, total: number): string {
  const count = (k: FailureKindName) => kinds.filter((x) => x === k).length;
  const caught = total - kinds.length;
  const parts = [`${caught}/${total} caught`];
  if (count("not-caught")) parts.push(`${count("not-caught")} not caught`);
  const unmeasured = count("no-match") + count("inconclusive") + count("flapped");
  // Named rather than counted with the misses: a run that decided nothing says
  // nothing about the guard, and reading it as a miss is the whole complaint.
  if (unmeasured) parts.push(`${unmeasured} not measured`);
  return parts.join(" · ");
}

/** Kept here so `summarise` and the runner cannot disagree about the set. */
export type FailureKindName = "no-match" | "not-caught" | "inconclusive" | "flapped";

/** The mark a line carries, so the three are distinguishable at a glance. */
export function markFor(kind: FailureKindName): string {
  // `!` is the manifest's own problem, `?` is the tool's, `✗` is the code's.
  return kind === "not-caught" ? "✗" : kind === "no-match" ? "!" : "?";
}

import { open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * How much of each end of a run's output is kept when it has to be condensed.
 */
export const KEPT_ENDS = 128 * 1024;

/**
 * Phrases `readVerdict` decides on that are not the entry's own `expect`.
 *
 * They are listed here because a condensed run has to carry them out of the
 * part it drops: a hook that died in the middle of a 200 MB dump still means
 * the guard was never reached, and losing the sentence turns that into a
 * finding about the guard.
 */
export const VERDICT_PHRASES = ["hook timed out", "hook failed", "hook threw", "net::ERR_"];

/** A run's output, small enough to hold, with what the shortening would hide. */
export type CapturedRun = { text: string; named: number };

/**
 * A run's output, small enough to hold, without losing what decides it.
 *
 * **Capture truncates, and the truncation is silent.** The runner used to read
 * the suite through `$\`bun test …\`.quiet()`, which returns about a megabyte
 * however much the child printed. A jsdom node in a failed `toBe(null)`
 * serialises to its whole graph — one such assertion measured 248 MB — and bun
 * prints the `(fail) suite > title` line *after* the dump. So the line the
 * entry's `expect` names was produced, and thrown away between the child and
 * this script, while the summary at the very end survived. The verdict read
 * `exit 1, summary present, expected string absent` and reported a guard that
 * had objected correctly as one that had not: `the-bell-moves-inside-the-trail`,
 * caught alone and missed in the batch of 112.
 *
 * The child now writes to a file and the file is streamed, so nothing is lost
 * on the way in. What is dropped is dropped *here*, deliberately, and the
 * elision says which of the strings the verdict turns on were in it — the
 * decision stays honest without holding 248 MB in a string.
 */
export async function condenseRun(
  chunks: AsyncIterable<Uint8Array>,
  signals: string[],
  keep: number = KEPT_ENDS,
): Promise<CapturedRun> {
  const wanted = [...new Set([...signals, ...VERDICT_PHRASES])].filter((s) => s.length > 0);
  // **Matching spans chunk boundaries.** A stream hands over whatever the read
  // returned, so the string the whole verdict rests on can arrive in two
  // pieces. Carrying the last `longest - 1` characters into the next search is
  // the smallest window that cannot miss one.
  const longest = wanted.reduce((n, s) => Math.max(n, s.length), 0);
  const decoder = new TextDecoder();
  const found = new Set<string>();
  // Counted over the whole stream, not over what survives the elision: a
  // failure named in the part that is dropped here has still been named, and
  // reading the count off the condensed text would turn this function's own
  // shortening into a cut-off run.
  let named = 0;
  let carry = "";
  let seen = 0;
  let whole: string | null = "";
  let head = "";
  let tail = "";

  const take = (text: string) => {
    if (text.length === 0) return;
    seen += text.length;
    const window = carry + text;
    for (const s of wanted) if (window.includes(s)) found.add(s);
    // Over the stitched window minus what the carry already contributed. The
    // carry is a prefix of the window, so an occurrence lying wholly inside it
    // was counted last round, and adding the window's total would count every
    // marker near a chunk boundary twice.
    const markers = (t: string) => t.split(FAIL_MARKER).length - 1;
    named += markers(window) - markers(carry);
    carry = longest > 1 ? window.slice(-(longest - 1)) : "";
    if (whole !== null) {
      whole += text;
      if (whole.length > keep * 2) {
        head = whole.slice(0, keep);
        tail = whole.slice(-keep);
        whole = null;
      }
      return;
    }
    // The tail is what carries bun's summary, which is printed last and is the
    // only thing saying whether anything ran at all.
    tail = (tail + text).slice(-keep);
  };

  for await (const chunk of chunks) take(decoder.decode(chunk, { stream: true }));
  take(decoder.decode());

  if (whole !== null) return { text: whole, named };
  const dropped = seen - head.length - tail.length;
  const printed = [...found].map((s) => JSON.stringify(s)).join(", ");
  const note = printed
    ? `\n\n… ${dropped} characters not shown; the run printed ${printed} …\n\n`
    : `\n\n… ${dropped} characters not shown …\n\n`;
  return { text: head + note + tail, named };
}

/**
 * Run a suite and come back with what it said.
 *
 * **Through a file, and that is the whole of this function.** Measured against
 * one suite that fails a `toBe(null)` on a jsdom node:
 *
 * ```
 * $`bun test …`.quiet()   787 KB back    no (fail) marker survived
 * stdout/stderr as pipes  787 KB back    no (fail) marker survived
 * a file descriptor       248 MB back    every marker, and the title
 * ```
 *
 * bun prints the `(fail) suite > title` line after the failure's output, so on
 * either of the first two the string an entry names in `expect` is produced and
 * then dropped between the child and here — while the summary at the end
 * survives, leaving a verdict that reads *exit 1, a summary, no expected
 * string*. That is a guard which objected, written down as one that did not.
 *
 * Both streams share the descriptor so their interleave survives, and the file
 * goes as soon as it has been read. `condenseRun` decides what is kept.
 */
export async function captureRun(
  cmd: string[],
  expect: string[],
  env: Record<string, string | undefined>,
): Promise<{ output: string; named: number; exitCode: number }> {
  const log = join(tmpdir(), `mutation-run-${process.pid}-${cmd.length}-${Bun.hash(cmd.join(" ")).toString(36)}.log`);
  const sink = await open(log, "w");
  let exitCode: number;
  try {
    const child = Bun.spawn(cmd, { env, stdout: sink.fd, stderr: sink.fd });
    exitCode = await child.exited;
  } finally {
    await sink.close();
  }
  try {
    const captured = await condenseRun(Bun.file(log).stream(), expect);
    return { output: captured.text, named: captured.named, exitCode };
  } finally {
    await rm(log, { force: true });
  }
}

/**
 * git's index lock, held for a moment by somebody else.
 *
 * Two worktrees of this repository are checked out at once — one agent per
 * branch — and `.git` is shared between them, so an ordinary `git status` in
 * either can hold an index lock while this script is restoring a file. The
 * collision is brief and says so in its own words.
 */
const CONTENDED = /index\.lock|Another git process/i;

export interface RestoreAttempt {
  /** Did the file come back? */
  ok: boolean;
  /** How many times git was asked. Worth reporting: a retry is a fact about the machine. */
  tries: number;
  /** git's own words, when it did not come back. */
  stderr: string;
}

/**
 * Put a planted file back, waiting out a lock somebody else is holding.
 *
 * **A failed restore is the worst outcome this script has.** The mutation stays
 * in the tree, the next `git add -A` stages it, and a guard that no longer
 * guards anything is one commit from being permanent — the failure the whole
 * manifest exists to prevent, produced by the tool that proves it.
 *
 * It happened: a `git checkout --` lost a race for `index.lock` against another
 * process in the shared `.git`, threw, and took the run with it. The signal
 * handler saved that tree; on the exit path it would not have, because it
 * called `spawnSync` and never read the exit code — printing *restored* for a
 * file that still held the mutation.
 *
 * So contention is waited out rather than treated as failure, and anything else
 * fails immediately: a path git cannot check out is not going to become one.
 * The runner and the wait are parameters because a test that spawned git would
 * be measuring git, and one that slept would be measuring the clock.
 */
export function restoreFile(
  file: string,
  run: (path: string) => { code: number; stderr: string },
  wait: (ms: number) => void = Bun.sleepSync,
  attempts = 12,
): RestoreAttempt {
  let stderr = "";
  for (let tries = 1; tries <= attempts; tries++) {
    const result = run(file);
    if (result.code === 0) return { ok: true, tries, stderr: "" };
    stderr = result.stderr;
    if (!CONTENDED.test(stderr)) return { ok: false, tries, stderr };
    wait(150);
  }
  return { ok: false, tries: attempts, stderr };
}

/**
 * `restoreFile`'s runner, against a real git.
 *
 * `cwd` is a parameter with no default in the caller: the script runs in the
 * tree it is mutating, and a test needs a repository of its own to check that
 * this actually puts a file back. Nothing else about it is worth mocking —
 * that a file comes back is the one thing this function claims.
 */
export function gitRestore(path: string, cwd?: string): { code: number; stderr: string } {
  const where = cwd === undefined ? {} : { cwd };
  const done = Bun.spawnSync(["git", "checkout", "--", path], { ...where, stdout: "pipe", stderr: "pipe" });
  return { code: done.exitCode, stderr: new TextDecoder().decode(done.stderr) };
}
