/**
 * The nightly's split covers the manifest exactly once.
 *
 * **Eight green shards look the same either way.** An off-by-one in the index
 * runs some entries twice and others never, and the report on both nights is
 * eight jobs passing — the manifest measured with a hole in it is
 * indistinguishable, from the outside, from the manifest measured. Nothing in
 * the run says which one happened, so the property is asserted here instead.
 *
 * It was an expression inside the script until now, which is why it had no
 * test: `chosen.filter((_, i) => i % n === k - 1)`, correct and unmeasured.
 */

import { describe, expect, test } from "bun:test";
import { shardOf } from "../scripts/shard";

const entries = (count: number) => Array.from({ length: count }, (_, i) => `entry-${i}`);
const shards = <T>(all: readonly T[], n: number) => Array.from({ length: n }, (_, i) => shardOf(all, i + 1, n));

describe("splitting the manifest across the night's jobs", () => {
  test("gives every entry to exactly one shard", () => {
    // 1189 against 8: the real shape, where the count does not divide.
    const all = entries(1189);
    const parts = shards(all, 8);
    const seen = parts.flat();
    expect(
      { total: seen.length, distinct: new Set(seen).size },
      "an entry runs twice or never, and eight green shards say the same thing either way",
    ).toEqual({ total: all.length, distinct: all.length });
  });

  test("holds for a count that divides, and for one entry each", () => {
    for (const [count, n] of [[64, 8], [8, 8], [1, 1]] as const) {
      const all = entries(count);
      const seen = shards(all, n).flat();
      expect(new Set(seen).size, `${count} entries across ${n} shards lost or repeated one`).toBe(count);
    }
  });

  test("leaves no shard empty when there are entries enough to fill them", () => {
    const sizes = shards(entries(1189), 8).map((part) => part.length);
    expect(Math.min(...sizes), "a shard came back empty while entries were left over").toBeGreaterThan(0);
    // Round-robin sizes differ by at most one, which is what makes the night's
    // wall-clock the longest shard rather than the longest run of one subject.
    expect(Math.max(...sizes) - Math.min(...sizes), "the shards are lopsided, so one job decides the night")
      .toBeLessThanOrEqual(1);
  });

  test("spreads a cluster instead of handing it to one shard", () => {
    // The manifest is grouped by subject and the expensive suites cluster
    // inside a group: the first ten entries here stand for the browser ones. A
    // contiguous eighth would give all ten to shard 1 and none to the rest,
    // which is the split this one exists not to be.
    const all = entries(80).map((id, i) => (i < 10 ? "browser" : id));
    const perShard = shards(all, 8).map((part) => part.filter((e) => e === "browser").length);
    expect(
      { most: Math.max(...perShard), none: perShard.filter((n) => n === 0).length },
      `the expensive entries landed ${perShard.join("/")} across the shards — one job would carry the night`,
    ).toEqual({ most: 2, none: 0 });
  });
});
