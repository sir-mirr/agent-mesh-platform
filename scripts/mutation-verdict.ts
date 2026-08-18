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
  const passed = Number(/(\d+) pass/.exec(output)?.[1] ?? "0");
  const failed = Number(/(\d+) fail/.exec(output)?.[1] ?? "0");
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
