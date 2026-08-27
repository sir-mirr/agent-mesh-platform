#!/usr/bin/env bun
/**
 * Did the nightly mutation run actually run?
 *
 * ## The failure this exists for
 *
 * The nightly files a GitHub issue when a shard comes back red, and the issue
 * list is where it is read from: `gh issue list --label nightly-mutation`. An
 * empty list is the everyday answer and it means *a quiet night* — except when
 * it means the schedule stopped firing, or the run died before it reached the
 * step that files anything, or the job was never dispatched at all. Those look
 * identical from the issue list, and the identical-looking one is the one that
 * matters: a check nobody runs reports the same silence as a check that passed.
 *
 * The workflow already learned a smaller version of this. Its first red night
 * filed nothing, because the default token could not create issues and the
 * label did not exist — "there were none to read, and no way to tell that from
 * a quiet night", in the comment that now sits above the alarm. This is the
 * same sentence one level up: the alarm can be missing because the run was.
 *
 * So the question is asked of the runs rather than of the issues.
 *
 * ## Ages, not conclusions alone
 *
 * A green run from four days ago is not evidence about tonight. The age is the
 * first thing read, and the limit is deliberately close to the schedule — a day
 * and a half against a daily cron — because a limit an order of magnitude above
 * its subject is a limit that holds while the thing it guards is long gone.
 */

export interface ScheduledRun {
  createdAt: string;
  conclusion: string | null;
  databaseId: number;
  headSha: string;
}

export type Freshness =
  | { kind: "green"; ran: string }
  | { kind: "running"; ran: string }
  | { kind: "red"; ran: string; why: string }
  | { kind: "stale"; why: string };

/** A day and a half against a nightly cron: one missed night is visible, a slow start is not. */
export const MAX_AGE_HOURS = 36;

export function readFreshness(
  runs: readonly ScheduledRun[],
  now: Date,
  maxAgeHours: number = MAX_AGE_HOURS,
): Freshness {
  if (runs.length === 0) {
    return {
      kind: "stale",
      why: "no scheduled run is recorded at all — the nightly has never fired, or the schedule was removed",
    };
  }
  // **The newest, not the first.** `gh run list` answers newest-first today,
  // and a verdict that depends on the order a tool happens to return is a
  // verdict about the tool.
  const newest = [...runs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0]!;
  const ageHours = (now.getTime() - Date.parse(newest.createdAt)) / 3_600_000;
  if (ageHours > maxAgeHours) {
    return {
      kind: "stale",
      why: `the last scheduled run was ${Math.round(ageHours)} hours ago, past the ${maxAgeHours} the schedule allows — an empty issue list is not evidence about a nightly that stopped running`,
    };
  }
  if (newest.conclusion === null) return { kind: "running", ran: newest.createdAt };
  if (newest.conclusion === "success") return { kind: "green", ran: newest.createdAt };
  return {
    kind: "red",
    ran: newest.createdAt,
    why: `the last scheduled run concluded ${newest.conclusion} on ${newest.headSha.slice(0, 7)} — read the shard issues, and if there are none the alarm did not fire either`,
  };
}

/** One line, and an exit code that means the same thing. */
export function say(freshness: Freshness): { line: string; code: number } {
  switch (freshness.kind) {
    case "green":
      return { line: `nightly: ran ${freshness.ran} and every shard passed`, code: 0 };
    case "running":
      return { line: `nightly: started ${freshness.ran} and has not concluded`, code: 0 };
    case "red":
      return { line: `nightly: ${freshness.why}`, code: 1 };
    case "stale":
      return { line: `nightly: ${freshness.why}`, code: 1 };
  }
}

if (import.meta.main) {
  const proc = Bun.spawnSync(
    ["gh", "run", "list", "--workflow", "ci.yml", "--event", "schedule", "--limit", "10", "--json", "databaseId,conclusion,createdAt,headSha"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = proc.stdout.toString().trim();
  if (proc.exitCode !== 0 || !out) {
    // **Not silence, and not a pass.** Whatever this run could not ask, it did
    // not learn — and a tool that says nothing when it could not measure is the
    // shape this script exists to remove.
    console.error(`nightly: could not ask GitHub — ${proc.stderr.toString().trim().slice(0, 300) || "gh printed nothing"}`);
    process.exit(2);
  }
  const said = say(readFreshness(JSON.parse(out) as ScheduledRun[], new Date()));
  console.log(said.line);
  process.exit(said.code);
}
