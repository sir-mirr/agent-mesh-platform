/**
 * The arrangement that makes the mutation manifest something CI actually runs.
 *
 * **It was in front of every push and could not have passed.** `check` carried
 * `bun run mutation-check` — the whole manifest, one suite per entry, seventy-two
 * of them the browser suite — inside a ten-minute job. Fifteen consecutive red
 * runs hid it: something above it failed first every time, so the step never
 * reached the timeout that would have said so. The first green integration run
 * in weeks is what finally showed the shape.
 *
 * So the pass moved to a clock and split into shards, and what stays in front
 * of a push is the part that fits: the anchors, which read every entry against
 * the tree in a second and catch the failure this repository keeps producing —
 * a refactor that leaves an entry pointing at text that is gone, which plants
 * nothing and reads as *the guard did not catch it*.
 *
 * Checked here because the split has a quiet failure of its own: shard counts
 * that disagree. Eight jobs each asking for `k/4` runs half the manifest twice
 * and the other half never, and every job is green.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ci = readFileSync(join(import.meta.dir, "..", ".github", "workflows", "ci.yml"), "utf8");

describe("what CI does with the mutation manifest", () => {
  test("every push reads the anchors, and none of them plants the whole manifest", () => {
    const beforeJobs = ci.slice(0, ci.indexOf("\n  coverage-floor:"));

    expect(
      { anchors: /mutation-check -- --anchors/.test(beforeJobs) },
      "nothing checks the anchors before a merge, so an entry pointing at deleted text passes as a caught mutation",
    ).toEqual({ anchors: true });
    expect(
      beforeJobs.includes("run: bun run mutation-check\n"),
      "the full manifest is back in front of a push, where it cannot finish",
    ).toBe(false);
  });

  test("the sharded pass runs on a clock, and asks for as many shards as it has jobs", () => {
    const matrix = /shard: \[([0-9, ]+)\]/.exec(ci);
    const asked = /--shard \$\{\{ matrix\.shard \}\}\/(\d+)/.exec(ci);

    expect({ scheduled: /^\s+schedule:$/m.test(ci), matrix: matrix !== null, asked: asked !== null }).toEqual({
      scheduled: true,
      matrix: true,
      asked: true,
    });

    const jobs = matrix![1]!.split(",").map((n) => Number(n.trim()));
    expect(
      { jobs: jobs.length, denominator: Number(asked![1]) },
      "the shard count and the number of jobs disagree — some entries run twice and some never run, all green",
    ).toEqual({ jobs: jobs.length, denominator: jobs.length });
    // 1..n, each once: a matrix missing `3` is a shard nothing runs.
    expect(jobs, "the shards are not 1..n exactly once").toEqual(jobs.map((_, i) => i + 1));
  });
});
