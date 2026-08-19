import { describe, expect, test } from "bun:test";

import { runLint } from "../scripts/lint-preview";

/**
 * `preview/` is a named deliverable — `docs/deliverables.md` lists sixty screens
 * and the hub page — and `scripts/lint-preview.ts` checks it against SPEC's route
 * tables and the capability vocabulary. It has been a good check that nobody ran.
 *
 * It is in no `package.json` script and no test imported it, so the only way it
 * ever executed was a person typing its path. A guard outside every denominator
 * is indistinguishable from one that does not exist, which is the shape this
 * repository met three times in one night: `rbacapi.mjs`'s hand-copied capability
 * map, `scenario-ids`' hand-written FILES list, and this file's own list of nine
 * capabilities while the contract held twelve.
 */
describe("the preview deliverable", () => {
  test("passes its own lint", () => {
    const r = runLint({ silent: true });

    // Non-vacuity first. A lint that read no files and parsed no routes reports
    // zero errors, and zero errors is what passing looks like.
    expect(
      { routes: r.totalAllowedRoutes > 0, references: r.totalRoutesFound > 0, capabilities: r.capabilityCount > 0 },
      "the lint found nothing to check, so its zero errors mean nothing",
    ).toEqual({ routes: true, references: true, capabilities: true });

    expect({ errors: r.errors }).toEqual({ errors: 0 });
  });

  test("counts capabilities from the contract rather than a list of its own", () => {
    const { CAPABILITY } = require("@agent-mesh/contracts");
    const contractCount = new Set(Object.values(CAPABILITY as Record<string, string>)).size;

    // The number the lint used to state was nine, written by hand, while the
    // contract had grown to twelve. Comparing the two is the only way that stays
    // true when a thirteenth arrives.
    expect({ lint: runLint({ silent: true }).capabilityCount }).toEqual({ lint: contractCount });
  });
});
