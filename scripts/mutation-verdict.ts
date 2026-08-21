export type Verdict =
  | { kind: "caught" }
  | { kind: "not-caught" }
  | { kind: "inconclusive"; why: string };

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
export function readVerdict(output: string, expect: string[], exitCode: number): Verdict {
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
  // Bun's phrasing when a suite dies before its tests.
  const hookDied = /\bhook (timed out|failed|threw)/i.test(output);

  if (hookDied) return { kind: "inconclusive", why: "a hook died, so the guard was never reached" };
  if (passed === 0 && failed === 0) return { kind: "inconclusive", why: "nothing ran" };
  // A silent guard and a broken suite look identical from here.
  if (passed === 0 && !expected) {
    return { kind: "inconclusive", why: "nothing passed and the expected message is absent" };
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
