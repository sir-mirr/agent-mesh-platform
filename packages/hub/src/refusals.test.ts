/**
 * The counters behind § 8.1 and § 12's refusals.
 *
 * `recordRefusal` was called from both refusal paths and `refusalCounts` was
 * read by nothing a coverage run can see, which is the shape this module was
 * written against in the first place: a number written and never read is a
 * number nobody can tell from a number that is right.
 *
 * The map is process-wide and other files in the run refuse things into it, so
 * every case here counts its own reasons and reads only those back.
 *
 * This file owns the `ref-` prefix.
 */
import { describe, expect, test } from "bun:test";

import { COUNTING_SINCE, recordRefusal, refusalCounts } from "./refusals";

let n = 0;
const uniq = (p: string) => `ref-${p}-${++n}-${process.pid}`;

/** Only the reasons this case recorded, in the order the module put them in. */
const mine = (...reasons: string[]) =>
  refusalCounts().filter((r) => reasons.includes(r.reason));

describe("refusalCounts", () => {
  test("reports what was recorded, under its kind", () => {
    const reason = uniq("bad-signature");

    recordRefusal("signature", reason);

    expect(mine(reason)).toEqual([{ kind: "signature", reason, count: 1 }]);
  });

  test("counts repeats of one reason rather than listing them", () => {
    const reason = uniq("no-egress-rule");

    recordRefusal("egress", reason);
    recordRefusal("egress", reason);
    recordRefusal("egress", reason);

    expect(mine(reason)).toEqual([{ kind: "egress", reason, count: 3 }]);
  });

  test("the same reason under two kinds is two counters", () => {
    const reason = uniq("shared");

    recordRefusal("signature", reason);
    recordRefusal("egress", reason);

    expect(mine(reason).map((r) => [r.kind, r.count]).sort()).toEqual([
      ["egress", 1],
      ["signature", 1],
    ]);
  });

  test("most frequent first, and ties broken by reason so the order is stable", () => {
    const loud = uniq("a-loud");
    const quiet = uniq("b-quiet");
    const alsoQuiet = uniq("a-also-quiet");

    recordRefusal("signature", quiet);
    recordRefusal("signature", alsoQuiet);
    for (let i = 0; i < 5; i++) recordRefusal("signature", loud);

    expect(mine(loud, quiet, alsoQuiet).map((r) => r.reason)).toEqual([loud, alsoQuiet, quiet]);
  });

  test("a reason nobody refused is absent, not zero", () => {
    expect(mine(uniq("never-happened"))).toEqual([]);
  });

  /**
   * **Without this a `0` cannot be read.** "No signature refusals" and "this
   * hub started ninety seconds ago" produce the same number, and on a screen
   * the second one looks like health.
   */
  test("says when it started counting, as a timestamp a reader can subtract", () => {
    expect(Number.isFinite(Date.parse(COUNTING_SINCE))).toBe(true);
    expect(Date.parse(COUNTING_SINCE)).toBeLessThanOrEqual(Date.now());
  });

  test("recording cannot fail the path that already decided to refuse", () => {
    expect(() => recordRefusal("signature", "")).not.toThrow();
    expect(refusalCounts().some((r) => r.reason === "" && r.kind === "signature")).toBe(true);
  });
});
