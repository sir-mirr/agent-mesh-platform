/**
 * Why a proxy was refused, in words an operator can act on.
 *
 * The predicate beside these already decides; this is the sentence it produces,
 * and the four reasons are not interchangeable. *No such identity* and *that
 * identity signs for itself* send an operator to different places — one to
 * provisioning, the other to the agent's own key — and a single "not entitled"
 * for both sends them to neither.
 *
 * This file owns the `ent-` prefix.
 */
import { describe, expect, test } from "bun:test";

import { refusalMessage } from "./entitlement";

describe("the refusal a caller is given", () => {
  test("names the identity in every case", () => {
    for (const reason of ["not-a-proxy", "unknown-identity", "deleted", "self-signing"] as const) {
      expect(refusalMessage("lane-a", reason)).toContain("lane-a");
    }
  });

  /** Four reasons, four sentences: an operator reads which door to try. */
  test("says which of the four it is", () => {
    expect(refusalMessage("lane-a", "not-a-proxy")).toBe("not entitled to act for 'lane-a'");
    expect(refusalMessage("lane-a", "unknown-identity")).toContain("no such identity");
    expect(refusalMessage("lane-a", "deleted")).toContain("has been deleted");
    expect(refusalMessage("lane-a", "self-signing")).toContain("signs for itself");
  });

  test("gives each reason a distinct sentence", () => {
    const said = (["not-a-proxy", "unknown-identity", "deleted", "self-signing"] as const)
      .map((r) => refusalMessage("lane-a", r));
    expect(new Set(said).size).toBe(said.length);
  });
});
