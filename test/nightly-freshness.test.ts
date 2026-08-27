/**
 * The nightly's silence has two meanings, and this is what separates them.
 *
 * `gh issue list --label nightly-mutation` is empty on a quiet night and empty
 * on a night the schedule never fired. The second is the one worth catching:
 * every anchor in the manifest is measured by that job and by nothing else, so
 * a nightly that stopped running takes 1181 guards with it and reports the same
 * empty list it reports when they all held.
 */

import { describe, expect, test } from "bun:test";
import { MAX_AGE_HOURS, readFreshness, say, type ScheduledRun } from "../scripts/nightly-freshness";

const NOW = new Date("2026-08-27T15:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

const run = (over: Partial<ScheduledRun> = {}): ScheduledRun => ({
  createdAt: hoursAgo(2),
  conclusion: "success",
  databaseId: 1,
  headSha: "abcdef1234567890",
  ...over,
});

describe("what the last scheduled run says", () => {
  test("a green run from tonight is the answer the issue list implies", () => {
    expect(readFreshness([run()], NOW)).toEqual({ kind: "green", ran: hoursAgo(2) });
  });

  test("a run still going has not said anything yet", () => {
    expect(readFreshness([run({ conclusion: null })], NOW).kind).toBe("running");
  });

  test("a red run is red whether or not it managed to file an issue", () => {
    const verdict = readFreshness([run({ conclusion: "failure" })], NOW);
    expect(verdict.kind, "a nightly that concluded failure was read as a quiet night").toBe("red");
    expect(say(verdict).code).toBe(1);
  });

  test("a run old enough to be about a different week is not evidence about tonight", () => {
    // 50 hours against a daily cron: two nights missed. The limit sits close to
    // the schedule on purpose — one an order of magnitude above it would hold
    // while the nightly had been gone for a fortnight.
    const verdict = readFreshness([run({ createdAt: hoursAgo(50) })], NOW);
    expect(verdict.kind, `a run ${50 - MAX_AGE_HOURS} hours past the limit was accepted as current`).toBe("stale");
    expect(verdict).toHaveProperty("why", expect.stringContaining("50 hours ago"));
    expect(say(verdict).code, "a stale nightly exited zero, which is what a green one does").toBe(1);
  });

  test("no scheduled run at all is the loudest case, not the quietest", () => {
    const verdict = readFreshness([], NOW);
    expect(verdict.kind).toBe("stale");
    expect(verdict).toHaveProperty("why", expect.stringContaining("never fired"));
  });

  test("reads the newest run, whatever order they arrive in", () => {
    // `gh run list` answers newest-first today. A verdict that depends on that
    // is a verdict about the tool: handed the same two runs oldest-first, this
    // one used to report the stale one.
    const oldestFirst = [run({ createdAt: hoursAgo(50), databaseId: 1 }), run({ createdAt: hoursAgo(2), databaseId: 2 })];
    expect(readFreshness(oldestFirst, NOW), "the older of two runs decided the verdict")
      .toEqual({ kind: "green", ran: hoursAgo(2) });
  });

  test("says something a reader can act on, with an exit code that agrees", () => {
    const green = say(readFreshness([run()], NOW));
    const stale = say(readFreshness([], NOW));
    expect({ green: green.code, stale: stale.code }, "the exit code and the line disagree about the same run")
      .toEqual({ green: 0, stale: 1 });
    expect(green.line).toContain("every shard passed");
  });
});
