import { describe, expect, test } from "bun:test";

import { runLint } from "../scripts/lint-preview";

/**
 * What a check printed, without importing one.
 *
 * `@agent-mesh/log` exports exactly this, and `test/` deliberately does not
 * reach into the packages — it drives the services as processes, and
 * `import-graph.test.ts` holds that to one consumer through one barrel. Five
 * lines here is the cheaper side of that trade.
 */
function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const real = { log: console.log, error: console.error };
  const take = (...args: unknown[]) => { lines.push(args.join(" ")); };
  console.log = take;
  console.error = take;
  return { lines, restore: () => { console.log = real.log; console.error = real.error; } };
}

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

/**
 * **The linter's own four checks, moved out from behind a flag.**
 *
 * They lived in `scripts/lint-preview.ts` under `--test`, and no
 * `package.json` script and no CI job ever passed it — the only way they ran
 * was somebody typing the path. That is the same shape this file's first two
 * cases were written to end: a guard outside every denominator is
 * indistinguishable from one that does not exist.
 *
 * Each mutates one of the linter's inputs and requires it to complain. A lint
 * that reports zero errors on a broken input is the failure mode that matters,
 * because zero errors is also what passing looks like.
 */
describe("the linter catches what it is for", () => {
  test("catches a route the SPEC does not authorise", () => {
    const r = runLint({
      mockHtmlFiles: { "test.html": "<div>POST /api/v1/tenants/acme/quota</div>" },
      minFloorOverride: 1,
      silent: true,
    });
    expect({ invented: r.errors > 0 }).toEqual({ invented: true });
  });

  /**
   * **The floor is the check nobody thinks to write.** An extraction that
   * silently stops finding routes reports no unauthorised ones either, so it
   * passes — sixty modular pages must yield at least sixty references, and
   * seven is a parser that broke rather than a preview that shrank.
   */
  test("catches an extraction that has quietly stopped working", () => {
    // **An authorised route, repeated.** The version this replaces used
    // `/api/v1/inbox`, which SPEC does not authorise — so the unauthorised-route
    // check reported seven errors and the case passed with the floor removed
    // entirely. Two sufficient guards for one assertion measure neither.
    const authorised = "/api/v1/mailbox/in";
    const seven = { "test.html": `<div>${Array(7).fill(authorised).join(" ")}</div>` };

    // Below the floor: refused, and for the floor's reason alone.
    const degraded = runLint({ mockHtmlFiles: seven, minFloorOverride: 60, silent: true });
    expect({ degraded: degraded.errors > 0 }).toEqual({ degraded: true });

    // The same input under a floor it clears passes, which is what says the
    // refusal above came from the count rather than from the content.
    const fine = runLint({ mockHtmlFiles: seven, minFloorOverride: 7, silent: true });
    expect({ errors: fine.errors, found: fine.totalRoutesFound }).toEqual({ errors: 0, found: 7 });
  });

  test("catches an RBAC page missing a capability the contract defines", () => {
    const r = runLint({ mockRbac: "<div>key.approve only</div>", silent: true });
    expect({ missingCapability: r.errors > 0 }).toEqual({ missingCapability: true });
  });

  /**
   * The allowlist comes from SPEC's own section headers. A SPEC it cannot
   * parse yields no allowed routes, and every route in the preview would then
   * be unauthorised — so the linter must fail rather than report a preview
   * that suddenly agrees with nothing.
   */
  test("catches a SPEC it cannot read the route tables out of", () => {
    const r = runLint({ mockSpec: "# Invalid SPEC with no 9.1 section", silent: true });
    expect({ corruptSpec: r.errors > 0 }).toEqual({ corruptSpec: true });
  });
});

/**
 * The vocabulary is imported rather than restated, and the interesting part is
 * what happens when the import does not work.
 *
 * Falling back to a hand-written list is the one thing this check must never
 * do — it is the defect the check exists to catch, and a guard that reverts to
 * its own copy of the answer when the real one is unavailable reports agreement
 * with itself. So the source is a parameter, and these two cases are the reason
 * it is: reaching them otherwise means breaking `@agent-mesh/contracts` for
 * everything else in the process.
 */
describe("where the capability vocabulary comes from", () => {
  test("refuses to lint at all when the contract cannot be read", () => {
    const { lines, restore } = capture();
    let r;
    try {
      r = runLint({
        mockCapabilitySource: () => { throw new Error("Cannot find module '@agent-mesh/contracts'"); },
        silent: true,
      });
    } finally {
      restore();
    }

    expect(r.errors).toBeGreaterThan(0);
    // Zero capabilities checked, and said so — not a pass with an empty loop.
    expect(r.capabilityCount).toBe(0);
    // What went wrong, in the module system's own words, and the refusal.
    expect(lines.join("\n")).toContain("Cannot find module '@agent-mesh/contracts'");
    expect(lines.join("\n")).toContain("Not falling back to a hand-written list");
  });

  /**
   * **An empty vocabulary is the same defect wearing a passing coat.** The
   * check loops over the capabilities; zero of them means zero comparisons and
   * a clean report from a lint that verified nothing — which is exactly the
   * screen the nine-hand-written-names version showed while the contract held
   * twelve.
   */
  test("an empty vocabulary is a failure, not a clean run", () => {
    const { lines, restore } = capture();
    let r;
    try {
      r = runLint({ mockCapabilitySource: () => ({}), silent: true });
    } finally {
      restore();
    }

    expect(r.errors).toBeGreaterThan(0);
    expect(lines.join("\n")).toContain("CAPABILITY is empty");
  });

  /**
   * And the ordinary case still goes through the parameter, so the default is
   * not the only path with a test. Duplicate values collapse: the vocabulary is
   * the set of capability strings, not the number of names bound to them.
   */
  test("counts the distinct capabilities the source offers", () => {
    const r = runLint({
      mockCapabilitySource: () => ({ A: "key.approve", B: "key.approve", C: "user.admit" }),
      mockRbac: "<div>key.approve user.admit</div>",
      silent: true,
    });

    expect(r.capabilityCount).toBe(2);
  });
});
