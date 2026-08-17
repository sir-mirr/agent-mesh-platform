/**
 * The § 11 capability table in `SPEC.md` is the same list the code enforces.
 *
 * **It was not.** The table held eight names while `ALL_CAPABILITIES` held
 * twelve, and one of the eight — `inbox.read.depth` — had been renamed to
 * `mailbox.read.depth` when the mailbox rename landed and never followed. So
 * the normative document named a capability that cannot be granted, and omitted
 * four that can, including the two added the same day.
 *
 * Nothing noticed, because nothing compared them. `SPEC.md` is the contract any
 * implementation satisfies and `capabilities-rbac.ts` is what this one enforces;
 * two copies of one list, drifting, is the shape this repository has removed
 * from the verb set, the ignore list, the substitution fields and the local-run
 * ports — six times in a week, and this was the seventh sitting in the SPEC
 * itself.
 *
 * Parsed rather than restated here, for the same reason `test/auth-sweep.test.ts`
 * parses the § 9.1 route table: a third copy would go stale silently, and a
 * capability dropped from it is simply a capability this stops checking.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ALL_CAPABILITIES } from "@agent-mesh/contracts";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

/** The backticked names in § 11's capability table. */
function capabilitiesFromSpec(): string[] {
  const spec = readFileSync(join(REPO_ROOT, "SPEC.md"), "utf8");
  const start = spec.indexOf("| Capability | |");
  expect(start, "§ 11's capability table is gone from SPEC.md").toBeGreaterThan(0);
  const table = spec.slice(start, spec.indexOf("\n\n", start));

  const names: string[] = [];
  for (const line of table.split("\n")) {
    const m = /^\|\s*`([a-z]+\.[a-z.]+)`\s*\|/.exec(line);
    if (m) names.push(m[1]!);
  }
  return names;
}

describe("§ 11's capability table", () => {
  test("names exactly what the code enforces", () => {
    const documented = new Set(capabilitiesFromSpec());
    const enforced = new Set(ALL_CAPABILITIES as readonly string[]);

    const undocumented = [...enforced].filter((c) => !documented.has(c)).sort();
    const unenforceable = [...documented].filter((c) => !enforced.has(c)).sort();

    // Reported separately. They are different mistakes: the first is a
    // capability an operator cannot discover, the second is one a reader would
    // try to grant and be refused by a route that has never heard of it.
    expect(undocumented, "enforced but missing from § 11's table").toEqual([]);
    expect(unenforceable, "in § 11's table but not a real capability").toEqual([]);
  });

  test("the parse actually found the table", () => {
    // Without this, a table that stopped matching the row pattern parses to
    // nothing, both sets above are compared against an empty one, and the check
    // reports agreement it never established.
    const documented = capabilitiesFromSpec();
    expect(documented.length, "parsed no capabilities out of SPEC.md").toBeGreaterThan(5);
    expect(documented).toContain("key.approve");
  });
});
