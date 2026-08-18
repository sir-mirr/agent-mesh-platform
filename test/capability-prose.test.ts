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
  // Added once the rule stopped depending on position: this page writes its
  // subtitle as a JSX attribute, which the previous rule could not see. It
  // names `role.grant` four times, correctly, and is the shape that would have
  // slipped through.
  "pages/tenant/RbacManagementPage.tsx",
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
 * The strings on a line that a person could read.
 *
 * **The keys look exactly like capability names.** `"server.kpi.sockets"`,
 * `"tenant.title"`, `"audit.title"` — a first attempt flagged seventy-one of
 * them, which was not an allow-list problem but the wrong scope: a translation
 * key is an identifier in a map and nobody sees it.
 *
 * The first rule was positional — drop the first quoted string, keep the rest —
 * and `agent-mesh-local-pm` found what it costs: a display string that *is* the
 * first string on its line becomes invisible, which is what happens the day a
 * formatter folds a long value onto its own line, or the day a JSX attribute
 * (`subtitle="…"`) or an array element is added. Long values are exactly the
 * ones that fold, and a sentence explaining a capability is long.
 *
 * So the rule is about shape instead of position. **A key never contains
 * whitespace and a sentence always does**, so a quoted string is display text
 * if it holds whitespace, wherever it sits on the line — and a bare identifier
 * is treated as a key only when it leads, which is where keys are written.
 *
 * Their suggested guard — assert no line starts with a quote — would have been
 * red on arrival: 448 lines of `I18nContext.tsx` start with one, because that
 * is where a key begins. The dependency was narrower than the assertion, and
 * removing the dependency was cheaper than stating it.
 */
function displayStrings(line: string): string[] {
  const quoted = [...line.matchAll(/"(?:[^"\\]|\\.)*"/g)];
  return quoted
    .filter((m, i) => /\s/.test(m[0]) || i > 0)
    .map((m) => m[0]);
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
        for (const match of displayStrings(line).join(" ").matchAll(NAMESPACED)) {
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
    const found = source.split("\n").flatMap((l) => [...displayStrings(l).join(" ").matchAll(NAMESPACED)].map((m) => m[0]));
    expect(found.length, "the scan found no namespaced names anywhere, so it proves nothing")
      .toBeGreaterThan(0);
  });
});

describe("the shapes a display string can arrive in", () => {
  // Each of these is a line the previous, positional rule could not see, found
  // by agent-mesh-local-pm trying to defeat the check rather than run it. A
  // formatter folding one long value produces the second; the RbacManagement
  // page already writes the third.
  const CASES: Array<[string, string]> = [
    ["key and value on one line", '    "nav.audit.desc": "audit.read_content 기반 열람",'],
    ["value folded onto its own line", '      "audit.read_content 기반 열람 — 긴 설명문",'],
    ["JSX attribute", '        subtitle="audit.read_content 기반 열람"'],
    ["array element", '      "audit.read_content 를 보유해야 합니다",'],
  ];

  for (const [name, line] of CASES) {
    test(`a wrong name is seen in ${name}`, () => {
      const found = [...displayStrings(line).join(" ").matchAll(NAMESPACED)].map((m) => m[0]);
      expect(found, `${name}: the scan cannot see this shape`).toContain("audit.read_content");
    });
  }

  test("and a bare key is still not display text", () => {
    // The whole reason the positional rule existed. Losing it must not bring
    // back the seventy-one.
    const found = displayStrings('    "server.kpi.sockets": "소켓 수",');
    expect(found.join(" "), "the key came back as display text").not.toContain("server.kpi.sockets");
  });
});
