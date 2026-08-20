/**
 * The predicate that decides whether every other verdict is believed.
 *
 * `mutation-check.ts` is the only evidence that any guard in this repository
 * guards anything, and `readVerdict` is the sentence in it that turns a test
 * run into a verdict. It had no test of its own, and it has now been wrong
 * twice in opposite directions:
 *
 * ```
 * once   a run where the mesh never came up was read as a finding about a guard
 * later  a one-test suite whose guard objected was read as no run at all
 * ```
 *
 * Both mistakes came from the same reading — `0 pass` — which means *nothing
 * ran* and *everything failed* and cannot say which. That is the ambiguity this
 * whole script exists to hunt, and it was living inside the hunter.
 *
 * The fixtures below are bun's real output shapes, kept verbatim rather than
 * paraphrased: the predicate reads text, so a test that invents the text tests
 * a format nothing produces.
 */

import { describe, expect, test } from "bun:test";

import { markFor, readVerdict, summarise, verdictsAgree } from "../scripts/mutation-verdict";

const EXPECT = ["a socket that dropped the frame"];

/**
 * **Two entries answered to one name and the run said `2/2 caught`.**
 *
 * `bun scripts/mutation-check.ts <id>` filters by id, and a name typed twice
 * makes that filter select two mutations — the summary counts them both and
 * reads as a clean result for the entry somebody meant to run. Caught only
 * because the count was two and the work was one; a duplicate on a bigger
 * filter would not show at all.
 *
 * The same shape is already written down one level up: two scenarios sharing an
 * `SC-` id made `-t "SC-WRITE-07"` run two tests, and the guard that was
 * supposed to stop it compared titles instead of ids.
 */
describe("the manifest's own names", () => {
  test("no id answers to two entries", async () => {
    const source = await Bun.file(new URL("../scripts/mutation-check.ts", import.meta.url)).text();
    const ids = [...source.matchAll(/^\s{4}id: "([^"]+)",$/gm)].map((m) => m[1]!);
    // A read that found nothing would make the comparison below vacuously true,
    // which is the failure this file exists to name.
    expect(ids.length, "no manifest ids were parsed — the entry shape changed").toBeGreaterThan(100);
    const seen = new Set<string>();
    const twice = ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
    expect(twice, "an id is used by more than one manifest entry, so filtering by it runs both").toEqual([]);
  });
});

describe("reading a run", () => {
  test("a guard that objected is caught", () => {
    const output = "(fail) a socket that dropped the frame\n\n 12 pass\n 1 fail\n";
    expect(readVerdict(output, EXPECT, 1)).toEqual({ kind: "caught" });
  });

  test("a guard that stayed quiet is not caught", () => {
    // The mutation applied and every test still passed: the guard does not
    // guard. This is the verdict the whole script exists to produce.
    const output = " 13 pass\n 0 fail\n";
    expect(readVerdict(output, EXPECT, 0)).toEqual({ kind: "not-caught" });
  });

  test("a one-test suite whose only test failed is still a verdict", () => {
    // **The regression.** `message-status.test.ts` holds one test, so a caught
    // mutation reports `0 pass / 1 fail` — indistinguishable by count from a
    // file that never ran, and it was read as the latter.
    const output = "(fail) a socket that dropped the frame\n\n 0 pass\n 1 fail\n";
    expect(readVerdict(output, EXPECT, 1)).toEqual({ kind: "caught" });
  });
});

describe("refusing to read a run that did not happen", () => {
  test("a dead hook is inconclusive, whatever the summary says", () => {
    // The original case: the mesh never came up, so no test executed and the
    // guard was never reached. The summary still shows a failure.
    const output = "error: a beforeEach/afterEach hook timed out\n\n 0 pass\n 1 fail\n";
    const v = readVerdict(output, EXPECT, 1);
    expect(v.kind).toBe("inconclusive");
    expect(v).toHaveProperty("why", "a hook died, so the guard was never reached");
  });

  test("a hook that dies while tests also pass is still inconclusive", () => {
    // Ordering matters: the hook check runs first. A file where some tests ran
    // and a hook then died has a partial result, and a partial result is not a
    // verdict about this guard.
    const output = "error: a beforeAll hook failed\n\n 4 pass\n 2 fail\n";
    expect(readVerdict(output, EXPECT, 1).kind).toBe("inconclusive");
  });

  test("no tests at all is inconclusive", () => {
    const output = " 0 pass\n 0 fail\n";
    const v = readVerdict(output, EXPECT, 1);
    expect(v.kind).toBe("inconclusive");
    expect(v).toHaveProperty("why", "nothing ran");
  });

  test("nothing passed and no expected message is inconclusive, not a finding", () => {
    // Here a silent guard and a broken suite are genuinely indistinguishable,
    // so neither verdict is available. Calling it `not-caught` would be a claim
    // about a guard from a run that may never have reached it — the exact
    // mistake this function was extracted to stop.
    const output = "(fail) something else entirely\n\n 0 pass\n 1 fail\n";
    const v = readVerdict(output, EXPECT, 1);
    expect(v.kind).toBe("inconclusive");
    expect(v).toHaveProperty("why", "nothing passed and the expected message is absent");
  });
});

describe("what an exit code alone cannot decide", () => {
  test("a failing run without the expected message is not caught", () => {
    // The mutation broke *something*, and not the guard named in the manifest.
    // Tests passed, so the run happened; the guard did not object.
    const output = "(fail) an unrelated assertion\n\n 11 pass\n 1 fail\n";
    expect(readVerdict(output, EXPECT, 1)).toEqual({ kind: "not-caught" });
  });

  test("the expected message with a zero exit is not caught", () => {
    // The string appearing in a passing run is a name in a log line, not an
    // objection. Both halves are required.
    const output = "ok: a socket that dropped the frame\n\n 12 pass\n 0 fail\n";
    expect(readVerdict(output, EXPECT, 0)).toEqual({ kind: "not-caught" });
  });
});

/**
 * The predicate that decides whether repeated runs of one mutation are saying
 * the same thing.
 *
 * It exists because a non-deterministic entry reads as `caught` on most runs, so
 * the manifest reports the difference as a defect in whatever else changed that
 * day — the false finding this whole script exists to prevent, one level up.
 */
describe("verdictsAgree", () => {
  test("runs that all caught agree", () => {
    expect(verdictsAgree(["caught", "caught", "caught"])).toBe(true);
  });

  test("runs that all missed agree — a guard can be absent consistently", () => {
    expect(verdictsAgree(["not-caught", "not-caught"])).toBe(true);
  });

  test("caught once and missed once is a flap, not a catch", () => {
    // The shape `wal-reminder-fold` had: caught on the run that added it, three
    // passes on the next. Believing the first is how it survived.
    expect(verdictsAgree(["caught", "not-caught", "not-caught"])).toBe(false);
  });

  test("an inconclusive run among caught ones is a flap too", () => {
    // Not folded into `caught`: a run that decided nothing is not evidence that
    // the other runs decided rightly.
    expect(verdictsAgree(["caught", "inconclusive"])).toBe(false);
  });

  test("a single run agrees with itself, which is what --repeat 1 claims", () => {
    expect(verdictsAgree(["caught"])).toBe(true);
    expect(verdictsAgree([])).toBe(true);
  });
});

/**
 * The line a run prints, with the failures kept apart.
 *
 * `✗` carried three different facts, and agent-mesh-local-pm read one of them
 * as the wrong one — `✗ signed-rate-limit` was the tool refusing to measure
 * because the tree had changed under it, not a guard that missed something.
 * They said so: **one line with two meanings.** The script already knew the
 * difference and the screen threw it away.
 *
 * Only `not-caught` is a statement about the code. Folding the rest into it is
 * how a tooling problem gets written down as a defect — which is the failure
 * this script exists to prevent, in the script's own output.
 */
describe("summarise", () => {
  test("a clean run says only what it caught", () => {
    expect(summarise([], 78)).toBe("78/78 caught");
  });

  test("a miss is named as a miss", () => {
    expect(summarise(["not-caught"], 78)).toBe("77/78 caught · 1 not caught");
  });

  test("a run that decided nothing is not a miss", () => {
    // The distinction the mark exists for: nothing here says the guard failed.
    expect(summarise(["inconclusive"], 78)).toBe("77/78 caught · 1 not measured");
    expect(summarise(["no-match"], 78)).toBe("77/78 caught · 1 not measured");
    expect(summarise(["flapped"], 78)).toBe("77/78 caught · 1 not measured");
  });

  test("both kinds appear when both happened", () => {
    expect(summarise(["not-caught", "flapped", "inconclusive"], 78)).toBe(
      "75/78 caught · 1 not caught · 2 not measured",
    );
  });

  test("the mark separates whose problem it is", () => {
    // The code's, the manifest's, the tool's.
    expect(markFor("not-caught")).toBe("✗");
    expect(markFor("no-match")).toBe("!");
    expect(markFor("inconclusive")).toBe("?");
    expect(markFor("flapped")).toBe("?");
  });
});
