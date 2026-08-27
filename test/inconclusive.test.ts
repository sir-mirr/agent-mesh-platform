import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INCONCLUSIVE_BY_DESIGN, reportInconclusive, unexplainedInconclusive } from "./inconclusive.ts";

/**
 * The screen suite has no third verdict: a scenario that runs but measures
 * nothing is reported as a pass. `inconclusive.ts` is what decides which of
 * those are allowed, and on a healthy machine none of it runs inside the
 * screen suite at all — so it is run here instead, where the entries can be
 * handed in directly and the failure can be observed.
 */
describe("a scenario that measured nothing", () => {
  const MACHINE = { scenario: "SC-HARNESS-02", why: "this machine cannot be made slow enough" };
  const BROKEN = { scenario: "SC-WRITE-08", why: "no identity field is rendered" };

  it("is a failure when the reason is not about this machine", () => {
    const said: string[] = [];
    expect(() => reportInconclusive([BROKEN], (m) => said.push(m))).toThrow(/SC-WRITE-08/);
    // Printed as well as thrown: a run that loses three scenarios should be
    // able to show all three, and the throw carries one message.
    expect(said.join("\n"), "the failing run never printed the list it failed over")
      .toContain("no identity field is rendered");
  });

  it("names every unexplained scenario, not the first", () => {
    const two = [BROKEN, { scenario: "SC-AUTH-08", why: "the form never left /login" }];
    let message = "";
    try {
      reportInconclusive(two, () => {});
    } catch (error) {
      message = String(error);
    }
    expect({ first: /SC-WRITE-08/.test(message), second: /SC-AUTH-08/.test(message) }, `the failure read: ${message}`)
      .toEqual({ first: true, second: true });
  });

  it("survives when the reason is a property of the machine", () => {
    const said: string[] = [];
    expect(() => reportInconclusive([MACHINE], (m) => said.push(m))).not.toThrow();
    // Still printed. An allowed skip is not an invisible one.
    expect(said.join("\n"), "an allowed skip went by without being reported at all").toContain("SC-HARNESS-02");
  });

  it("says nothing at all when every scenario measured something", () => {
    const said: string[] = [];
    reportInconclusive([], (m) => said.push(m));
    expect(said, "a clean run printed an empty inconclusive list").toEqual([]);
  });

  it("keeps the unexplained ones and drops the rest", () => {
    expect(unexplainedInconclusive([MACHINE, BROKEN]).map((e) => e.scenario)).toEqual(["SC-WRITE-08"]);
  });
});

/**
 * The list only means something if it matches the suite. A name on it that no
 * scenario uses is a stale exemption, and a call site whose name is *not* on it
 * is a skip that can only ever fail — which is to say it should have been an
 * assertion at the site, where the failure can say what broke.
 */
describe("the inconclusive-by-design list and the suite it exempts", () => {
  const suite = readFileSync(join(import.meta.dir, "fe-render.test.ts"), "utf8");
  const called = [...suite.matchAll(/cannotMeasure\(\s*"([A-Z0-9-]+)"/g)].map((m) => m[1]!);

  it("is read against call sites that exist", () => {
    // The denominator. With no call sites both directions below hold for a
    // reason that has nothing to do with the policy.
    expect(called.length, "no cannotMeasure call site was found — the two checks below compare empty sets")
      .toBeGreaterThan(0);
  });

  it("exempts only scenarios that ask to be exempt", () => {
    const stale = [...INCONCLUSIVE_BY_DESIGN.keys()].filter((id) => !called.includes(id));
    expect(stale, "these are exempt from failing and no scenario asks for it").toEqual([]);
  });

  it("leaves no skip that is not on it", () => {
    const unlisted = [...new Set(called)].filter((id) => !INCONCLUSIVE_BY_DESIGN.has(id));
    expect(
      unlisted,
      "these scenarios exit without measuring for a reason nobody argued for — either the reason is about this machine and belongs on the list, or the subject is broken and it belongs in an expect() at the site",
    ).toEqual([]);
  });

  it("is what the suite actually consults at the end of a run", () => {
    // The wiring, not the policy: a suite that collected the entries and never
    // reported them would pass every test above.
    expect(suite, "the screen suite no longer reports what it could not measure")
      .toContain("reportInconclusive(inconclusive)");
  });
});
