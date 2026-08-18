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

import { readVerdict } from "../scripts/mutation-verdict";

const EXPECT = ["a socket that dropped the frame"];

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
