/**
 * A capability name is never shown directly to a person.
 *
 * Two things already guard the *guards*: `requiredCapability` is typed
 * `Capability`, so an invented name does not compile, and
 * `sidebar-guards.test.ts` compares the menu's table with the router's. Neither
 * reads a **display string**, and that is where the last one lived —
 * `"audit.read_content 기반 열람"` was shown to the user for as long as the
 * screen existed. `t()` takes a `string`, so nothing objected.
 *
 * The scan is by namespace rather than by exact name: both current contract
 * keys and plausible-but-invented keys are internal vocabulary. Friendly
 * labels belong on screen instead.
 *
 * The allow-list starts non-empty on purpose. An empty one is the shape that
 * passes because it excludes nothing and looks like it excludes something.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { ALL_CAPABILITIES } from "@agent-mesh/contracts";

const WEB = join(import.meta.dir, "..", "packages", "platform-web", "src");

/**
 * Files whose strings reach a screen — **read from the tree, not typed here.**
 *
 * The three named below used to *be* this list. A hand-written list covers what
 * the person writing it had already seen: a page added tomorrow that names
 * `policy.read` in its subtitle would not be scanned, and the test would stay
 * green while claiming "every namespaced name shown to a user is in the
 * contract". `agent-mesh-local-pm` found this shape in four of their sweeps on
 * the same day (mail #1078); this is its twin in mine.
 *
 * Widening cost nothing to run — 57 files, 0 offenders — because the rule is
 * about shape rather than scope: `displayStrings` already separates a key from
 * a sentence, so a file that is all translation keys contributes nothing.
 */
function screenFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory()
      ? screenFiles(full)
      : /\.tsx?$/.test(full) && !/\.test\.tsx?$/.test(full)
        ? [full.slice(WEB.length + 1)]
        : [];
  });
}

const FILES = screenFiles(WEB);
const DISPLAY_FILES = FILES.filter((file) => !file.startsWith("api/"));

/**
 * The three the check was built against, kept as a tripwire.
 *
 * Each was added for a reason worth not losing: `I18nContext.tsx` is where the
 * strings live, `Sidebar.tsx` is where the last wrong name was found, and
 * `RbacManagementPage.tsx` writes its subtitle as a JSX attribute — the shape
 * that defeated the first, positional rule. A rename leaves the derivation
 * green; these say so.
 */
const ANCHORS = [
  "contexts/I18nContext.tsx",
  "components/layout/Sidebar.tsx",
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
  test("the scan reaches every screen file, and the three it was built on", () => {
    // The loop below reports nothing for a directory it did not walk, and
    // nothing is what a clean tree also reports.
    expect(FILES.length, "no screen files found — the walk is the whole scope").toBeGreaterThan(20);
    // **A floor of twenty over a package of fifty-nine.** The number was
    // written as "not empty" and reads as "the walk is working", which are
    // different claims: a walk that stopped descending into `pages/` returns
    // thirty-odd files, clears this line, and quietly stops scanning two thirds
    // of the screens the rule is about. git is asked the same question in a way
    // that shares none of this walk's opinions — it knows what is tracked and
    // nothing about extensions, directories or recursion.
    // `-z` for the same reason `readme.test.ts` needs it: git quotes a path
    // with non-ASCII in it, and a quoted path is one this comparison would
    // report as a file the walk invented.
    const tracked = Bun.spawnSync(["git", "ls-files", "-z", "packages/platform-web/src"], {
      cwd: new URL("..", import.meta.url).pathname,
    })
      .stdout.toString()
      .split("\0")
      .filter((line) => /\.tsx?$/.test(line) && !/\.test\.tsx?$/.test(line))
      .map((line) => line.replace("packages/platform-web/src/", ""));
    expect(
      {
        walkedButUntracked: FILES.filter((f) => !tracked.includes(f)).sort(),
        trackedButUnwalked: tracked.filter((f) => !FILES.includes(f)).sort(),
      },
      "the screen walk and git disagree about what is in this package",
    ).toEqual({ walkedButUntracked: [], trackedButUnwalked: [] });
    expect(tracked.length, "git listed nothing, so the comparison above is vacuous").toBeGreaterThan(20);
    for (const anchor of ANCHORS) {
      expect(FILES, `${anchor} is gone or moved; the case it covers needs a new home`).toContain(anchor);
    }
  });

  test("no namespaced permission identifier is shown to a user", () => {
    const offenders: string[] = [];
    for (const f of DISPLAY_FILES) {
      const source = readFileSync(join(WEB, f), "utf8");
      for (const line of source.split("\n")) {
        // Comments explain names, including wrong ones deliberately.
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
        for (const match of displayStrings(line).join(" ").matchAll(NAMESPACED)) {
          const token = match[0];
          if (NOT_CAPABILITIES.has(token)) continue;
          offenders.push(`${f}: ${token}`);
        }
      }
    }
    expect(offenders, "an internal permission identifier is being shown to a person").toEqual([]);
  });

  test("the scan recognises a real capability in representative display copy", () => {
    // A clean product tree should contribute zero hits, so prove the scanner
    // itself is alive with a synthetic user-facing sentence.
    const capability = (ALL_CAPABILITIES as readonly string[]).find((name) =>
      /^(audit|role|tenant|group|agent|key|mailbox|source|user|usage)\./.test(name),
    );
    expect(capability, "the contract has no namespaced capability for the tripwire").toBeString();
    const found = [...displayStrings(`subtitle="Requires ${capability}"`).join(" ").matchAll(NAMESPACED)]
      .map((m) => m[0]);
    expect(found).toContain(capability!);
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
    //
    // **This is the boundary the rule buys, and it is chosen rather than
    // missed.** A display string that is alone on its line with no whitespace —
    // `"audit.read_content",` as an array element — is byte-for-byte a key, so
    // no rule reading one line can tell them apart. One of the two has to be
    // given up, and giving up the key costs seventy-one false alarms while
    // giving up that string costs one shape nothing currently writes: the
    // screen that lists capability names as chips renders a server-supplied
    // array, not literals. Read as a hole and someone will "fix" it by
    // scanning keys again.
    const found = displayStrings('    "server.kpi.sockets": "소켓 수",');
    expect(found.join(" "), "the key came back as display text").not.toContain("server.kpi.sockets");
  });
});
