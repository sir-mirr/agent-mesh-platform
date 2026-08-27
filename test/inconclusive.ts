/**
 * A scenario that ran but measured nothing.
 *
 * bun has no third verdict, so an inconclusive scenario is reported as a pass.
 * agent-mesh-local-pm named the risk concretely on the three exits in
 * SC-WRITE-08: change the placeholder that scenario finds its field by and it
 * goes inconclusive **for ever**, leaving a green line that says a check exists
 * while nothing is checked.
 *
 * The reasons are not all alike, and that is what this module is for. A
 * scenario that cannot measure because *this machine* is too fast to be made
 * slow has found a property of the machine, and failing on it turns a laptop
 * into a defect. A scenario that cannot measure because the field is gone, the
 * form never left `/login`, or the mesh refused the write has found the
 * subject broken — that is a red wearing a skip's clothes.
 *
 * So the machine-shaped reasons are named here, once, and everything else
 * fails the run. Adding a silent skip now means adding a line to this list,
 * where it is visible and has to be argued for.
 */
export const INCONCLUSIVE_BY_DESIGN: ReadonlyMap<string, string> = new Map([
  [
    "SC-HARNESS-02",
    "throttles the CPU until the interim screen is readable; a machine that reaches the terminal state before the read has nothing to show it",
  ],
]);

export type Inconclusive = { readonly scenario: string; readonly why: string };

/**
 * The entries that are not explained by {@link INCONCLUSIVE_BY_DESIGN}.
 *
 * Returned rather than thrown so the caller can print all of them — a run that
 * lost three scenarios should say three, not stop at the first.
 */
export function unexplainedInconclusive(entries: readonly Inconclusive[]): Inconclusive[] {
  return entries.filter((entry) => !INCONCLUSIVE_BY_DESIGN.has(entry.scenario));
}

/**
 * Print the run's inconclusive scenarios, then fail unless every one of them
 * is explained by the machine.
 *
 * Lives here rather than inside the suite's `afterAll` so it can be run
 * directly: with nothing inconclusive on this machine — the state the suite is
 * in and should stay in — an `afterAll` that throws is dormant code, and
 * dormant code is exactly what cannot be shown to work.
 */
export function reportInconclusive(
  entries: readonly Inconclusive[],
  warn: (message: string) => void = console.warn,
): void {
  if (entries.length === 0) return;
  const say = (entry: Inconclusive) => `  ${entry.scenario} — ${entry.why}`;
  warn(
    `\n─── ${entries.length} scenario(s) ran without measuring anything ───\n` +
      entries.map(say).join("\n") +
      `\n─── each of these is reported above as a pass ───\n`,
  );
  const unexplained = unexplainedInconclusive(entries);
  if (unexplained.length > 0) {
    throw new Error(
      `${unexplained.length} scenario(s) measured nothing for a reason that is not about this machine, ` +
        `and each was reported above as a pass:\n${unexplained.map(say).join("\n")}`,
    );
  }
}
