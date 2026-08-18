/**
 * A capability name shown to a person is one the contract defines.
 *
 * Two things already guard the *guards*: `requiredCapability` is typed
 * `Capability`, so an invented name does not compile, and
 * `sidebar-guards.test.ts` compares the menu's table with the router's. Neither
 * reads a **display string**, and that is where the last one lived —
 * `"audit.read_content 기반 열람"` was shown to the user for as long as the
 * screen existed. `t()` takes a `string`, so nothing objected.
 *
 * The scan is by namespace rather than by exact name: `server.` and `policy.`
 * are not prefixes the contract uses at all, so their appearance is the signal.
 * A false positive here fails loudly and is added to the list below with a
 * reason, which is a cost worth paying — the alternative is a check that reads
 * prose and finds nothing in it.
 *
 * The allow-list starts non-empty on purpose. An empty one is the shape that
 * passes because it excludes nothing and looks like it excludes something.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ALL_CAPABILITIES } from "@agent-mesh/contracts";

const WEB = join(import.meta.dir, "..", "packages", "platform-web", "src");

/** Files whose strings reach a screen. */
const FILES = [
  "contexts/I18nContext.tsx",
  "components/layout/Sidebar.tsx",
];

/** Namespaces the contract uses, plus two it does not — those are the signal. */
const NAMESPACED =
  /\b(audit|role|tenant|group|agent|key|mailbox|source|user|usage|server|policy)\.[a-z_][a-z_.]*/g;

/**
 * Tokens that match the shape and are not capabilities.
 *
 * Named individually with a reason. A blanket rule here would swallow the next
 * real one.
 */
const NOT_CAPABILITIES = new Set([
  "agent.mesh",       // part of the product name in prose
  "user.name",        // a field, not a capability
]);

/**
 * The part of a line a person could read.
 *
 * **The keys look exactly like capability names.** `"server.kpi.sockets"`,
 * `"tenant.title"`, `"audit.title"` — a first attempt at this check flagged
 * seventy-one of them, which is not an allow-list problem but the wrong scope:
 * a translation key is an identifier in a map, and nobody sees it.
 *
 * Both shapes here put the key first — `"key": "value"` in the table, and
 * `t("key", "fallback")` at a call site — so dropping the first quoted string
 * leaves what is displayed. A line with no second string yields nothing to
 * scan, which is correct: there is nothing on it to read.
 */
function displayText(line: string): string {
  const first = /"(?:[^"\\]|\\.)*"/.exec(line);
  return first ? line.slice(first.index + first[0].length) : "";
}

describe("capability names in text a person reads", () => {
  test("the files are there and hold text", () => {
    // The loop below reports nothing for a file it could not read, and nothing
    // is what a clean file also reports.
    for (const f of FILES) {
      const source = readFileSync(join(WEB, f), "utf8");
      expect(source.length, `${f} is empty or missing`).toBeGreaterThan(500);
    }
  });

  test("every namespaced name shown to a user is in the contract", () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      const source = readFileSync(join(WEB, f), "utf8");
      for (const line of source.split("\n")) {
        // Comments explain names, including wrong ones deliberately.
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
        for (const match of displayText(line).matchAll(NAMESPACED)) {
          const token = match[0];
          if (NOT_CAPABILITIES.has(token)) continue;
          if ((ALL_CAPABILITIES as readonly string[]).includes(token)) continue;
          offenders.push(`${f}: ${token}`);
        }
      }
    }
    expect(offenders, "a name the contract does not define is being shown to a person").toEqual([]);
  });

  test("the scan can see a name at all", () => {
    // Otherwise the assertion above is satisfied by a regex that matches
    // nothing — the same green as a file with no problems in it.
    const source = readFileSync(join(WEB, "contexts/I18nContext.tsx"), "utf8");
    const found = source.split("\n").flatMap((l) => [...displayText(l).matchAll(NAMESPACED)].map((m) => m[0]));
    expect(found.length, "the scan found no namespaced names anywhere, so it proves nothing")
      .toBeGreaterThan(0);
  });
});
