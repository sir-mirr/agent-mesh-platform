/**
 * The stand-in `node:crypto` the browser build aliases.
 *
 * A module that exists to be swapped in at build time has one property worth
 * asserting: the surface the code that reaches for it actually calls. Two
 * modules in this package import `createHash` on a path a bundler follows into
 * the browser, where there is no `node:crypto` to answer — a stub missing a
 * link in that chain is a blank screen, not a type error.
 */
import { describe, expect, test } from "bun:test";

import stub, { createHash } from "./crypto";

describe("the browser's node:crypto stand-in", () => {
  test("answers the whole chain a caller writes, in one expression", () => {
    expect(createHash("sha256").update("anything").digest("hex")).toBe("");
  });

  test("is reachable both ways it is imported", () => {
    expect(stub.createHash).toBe(createHash);
    expect(stub.createHash("sha256").update("x").digest()).toBe("");
  });

  /**
   * **A digest, never a wrong digest.** It returns the empty string rather than
   * something hash-shaped: a stub answering 64 plausible hex characters in the
   * browser would be compared against a real digest somewhere and agree with
   * nothing, which is a defect that looks like data.
   */
  test("does not answer anything that could be mistaken for a digest", () => {
    const digest = createHash("sha256").update("x").digest("hex");
    expect(digest).toBe("");
    expect(digest).not.toMatch(/[0-9a-f]{8}/);
  });
});
