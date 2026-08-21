/**
 * One scenario id names one thing.
 *
 * Four ids were registered in both `fe-render.test.ts` and
 * `fe-scenarios.test.ts` — not by accident, and not as duplicates: one drove
 * the screen and one called the API. **The id is the unit the inventory
 * counts**, so an id spanning two layers cannot express the case where they
 * disagree, and that case is the worst defect found tonight: with
 * `capabilities: []` the API refused with 403 while the screen opened every
 * guarded page. "SC-AUTH-03 passes" had no way to mean only half of that.
 *
 * They are split now — `SC-API-AUTH-*` for the API layer, `SC-PROV-01` for the
 * provenance axis. This keeps them split, because the cheap way to add
 * coverage is to copy a scenario into the other file and keep its name.
 */

import { describe, expect, test, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const TESTS = join(import.meta.dir);
const FILES = ["fe-render.test.ts", "fe-scenarios.test.ts"];

/**
 * Every `[SC-…]` id an `it(` in a file registers.
 *
 * **One parser is one assumption.** agent-mesh-local-pm wrote three extraction
 * patterns tonight and each was narrow in a different way — `SC-[A-Z]+-[0-9]+`
 * missed `SC-SCR01-01`, `SC-DOWN-[0-9]+` missed `SC-DOWN-ALL`, and
 * `SC-[A-Z0-9]+-[A-Z0-9]+` missed `SC-API-AUTH-01`. Every one was written from
 * the ids in front of them, and every one reported a confident wrong number.
 *
 * So this reads the same file two ways and refuses to answer when they
 * disagree. The second reader is deliberately dumber — every bracketed token on
 * an `it(` line — so it fails differently from the first rather than sharing
 * its blind spot.
 */
function idsOf(file: string): string[] {
  const source = readFileSync(join(TESTS, file), "utf8");
  // Both quote styles. The first version required a double quote and was
  // therefore blind to every `SC-DOWN-ALL` — thirteen registrations written as
  // a template literal, because the route is interpolated into the title. The
  // second reader below is what surfaced it, on its first run.
  const strict = [...source.matchAll(/\bit(?:\.skip)?\(\s*["`]\[([A-Z0-9-]+)\]/g)].map((m) => m[1]!);
  const loose = source
    .split("\n")
    .filter((line) => /\bit(?:\.skip)?\(/.test(line))
    .flatMap((line) => [...line.matchAll(/\[([^\]\s]+)\]/g)].map((m) => m[1]!))
    .filter((id) => /^[A-Z]/.test(id));

  const missedByStrict = loose.filter((id) => !strict.includes(id));
  const missedByLoose = strict.filter((id) => !loose.includes(id));
  if (missedByStrict.length || missedByLoose.length) {
    throw new Error(
      `two readings of ${file} disagree — one of the patterns is narrow. ` +
        `strict missed [${missedByStrict.join(", ")}], loose missed [${missedByLoose.join(", ")}]`,
    );
  }
  return strict;
}

describe("scenario ids", () => {
  test("both files register ids at all", () => {
    // The comparison below is between two sets, and two empty sets never
    // intersect — a changed `it(` spelling would make this file green and
    // blind.
    for (const f of FILES) {
      expect(idsOf(f).length, `${f} registered no scenario ids`).toBeGreaterThan(3);
    }
  });

  test("no id is registered in more than one file", () => {
    const seen = new Map<string, string[]>();
    for (const f of FILES) {
      for (const id of idsOf(f)) {
        seen.set(id, [...(seen.get(id) ?? []), f]);
      }
    }
    const shared = [...seen.entries()]
      .filter(([, files]) => new Set(files).size > 1)
      .map(([id, files]) => `${id} in ${[...new Set(files)].join(" and ")}`);

    expect(shared, "one id covering two layers cannot report that they disagree").toEqual([]);
  });

  test("an id is registered from one `it(` line, so a repeat is a loop and not a second scenario", () => {
    // **The test below states this rule in prose and does not implement it.**
    // Its comment says the case that must not happen is "two *different*
    // scenarios wearing one id", and then it compares full titles — which two
    // different scenarios never share, because they are different. So the rule
    // most likely to be believed here was the one nothing checked, and the
    // defect it names went in and stayed green: `SC-WRITE-07` was minted a
    // second time in `fe-render.test.ts` for the playground receipt while it
    // already named an RBAC grant abort, and every suite stayed green. It was
    // found by `-t SC-WRITE-07` running two tests, not by this file.
    //
    // The distinction the prose is reaching for is on the source, not the
    // titles: `SC-DOWN-ALL` is thirteen registrations from **one** `it(` inside
    // a loop over routes, and two scenarios sharing an id are **two** `it(`
    // lines. One line is a check applied to many subjects; two lines are two
    // checks that cannot report disagreeing with each other.
    for (const f of FILES) {
      const source = readFileSync(join(TESTS, f), "utf8");
      const lines: Map<string, number[]> = new Map();
      source.split("\n").forEach((line, i) => {
        const m = /\bit(?:\.skip)?\(\s*["`]\[([A-Z0-9-]+)\]/.exec(line);
        if (m) lines.set(m[1]!, [...(lines.get(m[1]!) ?? []), i + 1]);
      });
      const twice = [...lines.entries()]
        .filter(([, at]) => at.length > 1)
        .map(([id, at]) => `${id} at ${f}:${at.join(", ")}`);
      expect(twice, "one id on two `it(` lines is two scenarios that cannot disagree").toEqual([]);
    }
  });

  test("an id repeated in one file is one check over many subjects, not two checks", () => {
    // **Repetition inside a file is not automatically wrong.** `SC-DOWN-ALL`
    // is registered thirteen times, once per screen, and that is one check
    // applied to thirteen subjects — the route is in the title. What must not
    // happen is two *different* scenarios wearing one id, which is the case
    // that cannot report a disagreement between them.
    //
    // So the rule is on the full titles: same id is fine, same title is not.
    for (const f of FILES) {
      const source = readFileSync(join(TESTS, f), "utf8");
      const titles = [...source.matchAll(/\bit(?:\.skip)?\(\s*["`]([^"`]+)["`]/g)].map((m) => m[1]!);
      const duplicated = titles.filter((t, i) => titles.indexOf(t) !== i);
      expect([...new Set(duplicated)], `${f} registers two scenarios with the same title`).toEqual([]);
    }
  });
});

/**
 * An id as the inventory writes one.
 *
 * `SC-DOWN-ALL` is the case that matters: the last segment is not a number, and
 * every hand-written count and the first version of this pattern missed it for
 * that reason. `\b(?!-\*)` keeps the family notations out — `SC-DOWN-*` names a
 * family and registers nothing, and without the word boundary the pattern
 * backtracks into `SC-API-AUT` to satisfy the lookahead.
 */
const ID_IN_DOC = /SC-(?:[A-Z0-9]+-)+[A-Z0-9]+\b(?!-\*)/g;

describe("the inventory's own count", () => {
  // **§ 4 said 53 while § 4's own tables held 54, and called itself "분모 통계".**
  // Someone looking for the denominator reads the section named for it, so the
  // document contradicted itself in the place most likely to be believed. The
  // number was written by hand and the file grew three times in one day.
  //
  // Checked rather than corrected: correcting it buys until the next scenario.
  const INVENTORY = join(import.meta.dir, "..", "packages", "platform-web", "COVERAGE_INVENTORY.md");

  // **It counts what the tables register**, not every id the file mentions.
  //
  // It used to count mentions, and that cost a rule: *name families in prose,
  // not ids*, because a paragraph explaining what had drifted would register the
  // ids it named. agent-mesh-local-pm found the rule leaking anyway, from the
  // other side — the pattern was `SC-[A-Z0-9]+-[0-9]+`, which asks **does it end
  // in digits** rather than **is it an id**, so `SC-DOWN-ALL` was invisible to
  // it. Those two questions had the same answer until `SC-DOWN-ALL` existed.
  //
  // That is precisely the blindness that made § 0's axis table say 8 with nine
  // registered: whoever counted read the numbered ones. **A guard went blind in
  // the same place as the thing it guards against**, in the same file where the
  // other check had already been fixed for it.
  //
  // Both are repaired here, and the second repair removes the rule rather than
  // restating it: scoped to table rows, a mention in prose is harmless, so
  // nobody has to remember not to write one. `-\*` is excluded because
  // `SC-DOWN-*` is a family, not an id.
  test("the number it states is the number it holds", () => {
    const doc = readFileSync(INVENTORY, "utf8");
    const registered = doc.split("\n").filter((line) => line.startsWith("|")).join("\n");
    const ids = new Set([...registered.matchAll(ID_IN_DOC)].map((m) => m[0]));

    // A regex that matched nothing would make the comparison 0 === 0 as soon as
    // the stated number went missing too.
    expect(ids.size, "no scenario ids were found in the inventory").toBeGreaterThan(20);

    const stated = /이 문서가 등록한 시나리오 ID\*\*:\s*\*\*([0-9]+)개/.exec(doc);
    expect(stated, "the inventory no longer states a count for this to check").not.toBeNull();
    expect(Number(stated![1]), "the inventory states a count it does not hold").toBe(ids.size);
  });

  /**
   * The pattern itself, on the shapes that broke the hand counts.
   *
   * Asserted directly rather than through the document, because the document
   * holds exactly one id of the awkward shape and a check that depends on that
   * stops checking the moment somebody rewrites a sentence. This is the branch
   * `SC-[A-Z0-9]+-[0-9]+` could not see, and seeing it is the repair.
   */
  test("it reads an id whose last segment is not a number", () => {
    const read = (text: string) => [...text.matchAll(ID_IN_DOC)].map((m) => m[0]);

    expect(read("`SC-DOWN-ALL` drove thirteen routes")).toEqual(["SC-DOWN-ALL"]);
    expect(read("`SC-API-AUTH-01` and `SC-SCR01-01`")).toEqual(["SC-API-AUTH-01", "SC-SCR01-01"]);

    // Families register nothing, and the word boundary is what stops the
    // pattern backtracking into `SC-API-AUT` to get past the lookahead.
    expect(read("| `SC-DOWN-*` | ... | 9 |")).toEqual([]);
    expect(read("| `SC-API-AUTH-*` | ... | 3 |")).toEqual([]);
  });

  test("and it still claims the screen count it documents", () => {
    // The one number in § 4 that was right, kept honest the same way.
    const doc = readFileSync(INVENTORY, "utf8");
    const screens = [...doc.matchAll(/^### [0-9]+\)/gm)].length;
    const stated = /대상 화면\*\*: 총 ([0-9]+)개/.exec(doc);
    expect(stated).not.toBeNull();
    expect(Number(stated![1]), "the inventory states a screen count it does not document").toBe(screens);
  });
});

/**
 * The axis table in § 0 counts what the screen matrix cannot hold, and it was
 * counting it by hand.
 *
 * § 0 exists because a screen × widget matrix has no row for a property that
 * crosses every screen, and it says so well. What it also did was **state the
 * per-family totals as literals** — a second declaration of what the test files
 * register, which is the shape this repository keeps meeting: write one fact in
 * two places and one of them goes quietly wrong.
 *
 * It had. `SC-DOWN-*` was 8 with nine registered (`SC-DOWN-ALL` is not a number
 * and the count was written by reading the numbered ones), `SC-WRITE-*` was 6
 * with eight, and `SC-AUTH-04`, `SC-AUTH-05` and `SC-HARNESS-02` had no row at
 * all. agent-mesh-local-pm found the total was 44 short; this is the half of it
 * that a check can hold.
 *
 * **A family with two or more ids must have a row.** Otherwise the drift comes
 * back as an omission rather than a wrong number, which is the direction that
 * reads as "not written yet" — and someone rewrites the scenario that already
 * exists. `SC-BELL-01` existed twice for exactly that reason.
 */
describe("the inventory's axis table", () => {
  const INVENTORY = join(import.meta.dir, "..", "packages", "platform-web", "COVERAGE_INVENTORY.md");

  /** `SC-WRITE-01` → `SC-WRITE`, `SC-API-AUTH-02` → `SC-API-AUTH`. */
  const familyOf = (id: string) => id.replace(/-[A-Z0-9]+$/, "");

  /** What the test files actually register, per family. */
  function registered(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const id of new Set(FILES.flatMap(idsOf))) {
      const family = familyOf(id);
      counts.set(family, (counts.get(family) ?? 0) + 1);
    }
    return counts;
  }

  /** What § 0's table claims, per family. */
  function claimed(): Map<string, number> {
    const doc = readFileSync(INVENTORY, "utf8");
    // **`[A-Z-]+` could not see a family with a digit in its name.** `SC-I18N-*`
    // was the first, and the row was there — this pattern simply did not match
    // it, so the family read as *declared nowhere* while sitting in the table.
    // The blindness is the one this file already records twice: a pattern
    // written from the ids in front of the author, and confident about the rest.
    const rows = [...doc.matchAll(/^\| `(SC-[A-Z0-9-]+)-\*` \|[^|]*\| ([0-9]+) \|$/gm)];
    return new Map(rows.map((m) => [m[1]!, Number(m[2]!)]));
  }

  test("every count it states is the count the tests hold", () => {
    const table = claimed();
    // A regex that matched nothing would make every comparison below vacuous,
    // which is how a check about a table survives the table being renamed.
    expect(table.size, "no axis rows were found — the table's shape changed").toBeGreaterThan(8);

    const actual = registered();
    const disagreements = [...table].filter(([family, n]) => (actual.get(family) ?? 0) !== n);
    expect(disagreements.map(([f, n]) => `${f}-*: table says ${n}, tests register ${actual.get(f) ?? 0}`)).toEqual([]);
  });

  test("every family with more than one id has a row", () => {
    const table = claimed();
    const actual = registered();
    // Screen scenarios are the matrix's own axis and are counted there; the
    // per-screen sections hold them, one row each.
    const missing = [...actual]
      .filter(([family, n]) => n > 1 && !family.startsWith("SC-SCR") && family !== "SC-RENDER")
      .filter(([family]) => !table.has(family))
      .map(([family, n]) => `${family}-* has ${n} ids and no row in § 0`);
    expect(missing).toEqual([]);
  });
});

/**
 * Every check above asks whether the inventory's *numbers* are right. None asks
 * whether a scenario the tests register is in the document at all.
 *
 * The two are not the same question, and the gap has a shape: the axis check
 * skips `SC-SCR*` and `SC-RENDER` because those live in the screen and render
 * matrices, and § 4's count reads ids **out of the document** rather than out of
 * the tests. So an id registered under one of the skipped families, and never
 * written into its screen's table, is in neither denominator — every number
 * agrees and the scenario is invisible.
 *
 * It had happened. `SC-SCR10-02` was registered by `187d500` and appeared
 * nowhere in the inventory; agent-mesh-local-pm found it by asking this
 * question of every id rather than of the families.
 *
 * An id counts as accounted for when the document names it, or when § 0 holds a
 * row for its family — those rows are checked against the registered count
 * above, so a family row is a real accounting and not a wildcard.
 */
describe("the inventory as a denominator", () => {
  const INVENTORY = join(import.meta.dir, "..", "packages", "platform-web", "COVERAGE_INVENTORY.md");

  test("accounts for every scenario the tests register", () => {
    const doc = readFileSync(INVENTORY, "utf8");
    const named = new Set([...doc.matchAll(/`(SC-[A-Z0-9-]+)`/g)].map((m) => m[1]!));
    const families = new Set(
      // Same widening as above, and **the same pattern written twice** is why
      // fixing one of them left this one blind: `SC-I18N-02` still read as
      // unaccounted while its family row sat in the table.
      [...doc.matchAll(/^\| `(SC-[A-Z0-9-]+)-\*` \|[^|]*\| [0-9]+ \|$/gm)].map((m) => m[1]!),
    );
    // Both readings must have found something. A document that stopped matching
    // would otherwise make every id below look unaccounted, which reads as a
    // pile of new work rather than as a broken check.
    expect(named.size, "no ids were named in the inventory — its formatting changed").toBeGreaterThan(20);
    expect(families.size, "no axis family rows were found — the table's shape changed").toBeGreaterThan(8);

    const registered = [...new Set(FILES.flatMap(idsOf))];
    expect(registered.length, "no scenario ids were registered — the parser changed").toBeGreaterThan(50);

    const orphans = registered
      .filter((id) => !named.has(id) && !families.has(id.replace(/-[A-Z0-9]+$/, "")))
      .map((id) => `${id} is registered by the tests and appears nowhere in the inventory`);
    expect(orphans).toEqual([]);
  });
});

/**
 * `FILES` is a hand-written list, and a hand-written list of what to measure is
 * the shape that goes quietly wrong in the one direction nobody checks.
 *
 * Everything above compares the inventory's numbers against what `FILES`
 * registers. So a scenario written into a file that is not on that list is not
 * "uncounted" — it is **invisible**, and every check above stays green over a
 * denominator that shrank. agent-mesh-local-pm measured that rather than
 * reasoning about it: a probe file registering `SC-DOWN-98` and a whole new
 * family `SC-NEWFAM-01` left this suite at **8 pass, 0 fail**.
 *
 * The same PM had the same hole in `audit/rbacapi.mjs` this morning — a
 * hard-coded route list that would have reported 434/434 while never testing
 * the route that had just been added. The fix there was to derive the list and
 * refuse when the derivation looks wrong; this is the cheaper half of that,
 * which keeps `FILES` explicit (it is also the parser's input, and widening it
 * silently would change what the counts mean) while making an omission loud.
 *
 * It asks the directory rather than the list, so it fails differently from
 * everything above — the same reason `idsOf` reads each file twice.
 */
describe("the list of files this suite reads", () => {
  test("covers every test file that registers a scenario id", () => {
    const registrar = /\bit(?:\.skip)?\(\s*["`]\[[A-Z0-9-]+\]/;
    const found = readdirSync(TESTS)
      .filter((name) => name.endsWith(".ts"))
      .filter((name) => registrar.test(readFileSync(join(TESTS, name), "utf8")));

    // A directory read that matched nothing would make the comparison vacuous —
    // which is exactly the failure this test exists to catch, one level up.
    expect(found.length, "no file in test/ registers a scenario id — the pattern stopped matching").toBeGreaterThan(1);

    const unread = found.filter((name) => !FILES.includes(name));
    expect(
      unread.map((name) => `${name} registers scenario ids and is not in FILES, so nothing above sees them`),
    ).toEqual([]);
  });
});

/**
 * A landmark that no longer exists on the screen.
 *
 * Three commits in a row renamed a message and left a scenario waiting for the
 * old sentence. The failure that produces is a thirty-second timeout followed
 * by `Target page, context or browser has been closed` for every scenario after
 * it — the whole suite reads as a crash, and twice it was nearly filed as
 * contention on a machine that was idle.
 *
 * A positive landmark (`shows(page, "…")`) is a claim that the product says
 * this. If no source file contains the string, the claim is already false and
 * the check can say so in a second instead of a minute.
 *
 * Negative landmarks are deliberately excluded: `not.toContain("0개 그룹")` is
 * about a sentence that *should* be absent, and its absence from the source is
 * the fix working.
 */
/**
 * **A `data-testid` a scenario waits for and the product does not emit.**
 *
 * `copy landmarks` does this for sentences. Nothing did it for testids, and the
 * failure is the expensive one: a renamed hook is a thirty-second timeout, and
 * the timeout closes the browser, so every scenario after it fails with
 * `Target page … closed`. One rename reads as ninety broken tests. That is the
 * third reason a mutation comes back `not caught` — something else died first
 * and ended the run — and it cost most of an hour this morning.
 *
 * The denominator is **every** testid the two scenario files name, not the ones
 * used in a shape this file recognises. A first version counted only
 * `locator(...).click()` and friends written as one expression, which is eleven
 * of sixty-eight — the rest are `const cell = page.locator(...)` on one line and
 * `await cell.click()` on another. Eleven of sixty-eight is a check that has
 * gone quiet.
 *
 * Some testids are named *because they must not exist* — `SC-AUTH-06` passes
 * when the role picker is gone. Those carry `absent-by-design` on the line, so
 * the exemption sits next to the assertion that needs it rather than in a list
 * somewhere else that nobody updates.
 */
describe("every screen a person can open", () => {
  /**
   * The denominator is **both** things that answer a browser, not one router.
   *
   * The scenario inventory was built from `App.tsx`'s path list, and for months
   * that was called "the screens". It is one app's routes. `agent-mesh-http`
   * serves whole HTML documents of its own — `/admin`, `/chat`,
   * `/chat/:agentId` — and nothing in the React app links to them, so an
   * inventory drawn from the router could not see them and nobody noticed the
   * absence. Three screens out of twenty-one had no scenario, and all three were
   * the three that came from the other source.
   *
   * The lesson is not "add those three". It is that a denominator taken from one
   * producer measures that producer. So this test builds the list from both and
   * fails when a screen exists that no scenario opens — the shape of the miss,
   * rather than the instances of it.
   */
  it("has a scenario that opens it", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const read = (p: string) => readFileSync(p, "utf8");

    // Server-drawn: a GET whose handler answers HTML.
    //
    // **The window ends at the next route, not after a fixed 1500 characters,
    // and `text/html` has to be a content type rather than a substring.** The
    // fixed window read into whatever followed the handler, and the file-serve
    // section's MIME map (`html: 'text/html'`) sits a few hundred characters
    // below `/api/v1/messages/:agent` — so deleting twenty unrelated lines
    // elsewhere in `main.ts` made a JSON route report as a screen with no
    // scenario. A denominator that moves when unrelated code moves is not
    // measuring the thing it names.
    const main = read("packages/http/src/main.ts");
    const server: string[] = [];
    const routeAt = [...main.matchAll(/\napp\.(get|post|put|delete|patch|use|all)\(/g)]
      .map((m) => m.index ?? 0);
    const HTML = /c\.html\(|content-type['"]?\s*:\s*['"]text\/html/i;
    for (const m of main.matchAll(/app\.get\(\s*'([^']+)'/g)) {
      const from = m.index! + m[0].length;
      const to = routeAt.find((i) => i > m.index!) ?? main.length;
      if (HTML.test(main.slice(from, to))) server.push(m[1]!);
    }
    // App-drawn: the router's own list.
    const app = read("packages/platform-web/src/App.tsx");
    const react = [...new Set([...app.matchAll(/path="([^"]+)"/g)].map((m) => m[1]!))].filter((p) => p !== "*");

    expect({ serverFound: server.length > 0, reactFound: react.length > 5 }, "one of the two producers stopped being readable — the denominator is the point").toEqual({
      serverFound: true,
      reactFound: true,
    });

    const tests = FILES.map((f) => read(join("test", f))).join("\n");
    // **A path handed to a helper is still a path opened.** The first version of
    // this only read literals sitting inside `goto(...)`, and missed `SC-SRV-01`
    // — which calls `page.goto(\`${mesh.http.url}${path}\`)` with the literal a
    // few lines up. Narrow extraction reported two covered screens as bare, which
    // is the same failure this test exists to catch, one level up.
    //
    // So: a path literal counts when a navigation call appears near it. Near, not
    // anywhere — a path named only in prose is not a scenario opening it.
    const NAV = /(?:goto|withPage|createAuthedPage|withUnauthedPage|withViewerPage)\s*\(/g;
    const navAt = [...tests.matchAll(NAV)].map((m) => m.index ?? 0);
    const opened = new Set<string>();
    for (const m of tests.matchAll(/["'`](\/[A-Za-z0-9_:/-]*)["'`]/g)) {
      const at = m.index ?? 0;
      if (!navAt.some((n) => Math.abs(n - at) < 400)) continue;
      const raw = (m[1] ?? "").split("?")[0] ?? "";
      opened.add(raw.replace(/\/$/, "") || "/");
    }

    const unopened = [...server.map((p) => ["server", p] as const), ...react.map((p) => ["react", p] as const)]
      .filter(([, p]) => !opened.has(p.replace(/\/$/, "") || "/"))
      .map(([kind, p]) => `${kind} ${p}`);

    expect(unopened, `screens exist that no scenario opens (${server.length} server + ${react.length} app)`).toEqual([
      // `/chat/:agentId` is one page with a path parameter; `SC-SRV-01` opens
      // `/chat`, which is the same module. Listed rather than pattern-matched so
      // the exception is one line somebody can delete when it is covered.
      "server /chat/:agentId",
    ]);
  });
});

describe("testid landmarks", () => {
  it("waits only for hooks the product still emits", () => {
    const WEB = join(import.meta.dir, "..", "packages", "platform-web", "src");
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
      );
    const source = walk(WEB)
      .filter((f) => /\.tsx?$/.test(f))
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");

    const emitted = new Set<string>();
    const prefixes: string[] = [];
    for (const m of source.matchAll(/data-testid=\{?["'`]([^"'`]*)["'`]/g)) {
      const value = m[1]!;
      if (value.includes("${")) prefixes.push(value.split("${")[0]!);
      else emitted.add(value);
    }
    // `valueTestId` hands the attribute down through a prop; the first version
    // of this reported `lease-available` missing because it only read the
    // attribute where it is finally written.
    for (const m of source.matchAll(/valueTestId=\{?["'`]([^"'`]*)["'`]/g)) emitted.add(m[1]!);
    for (const m of source.matchAll(/data-testid=\{([^}]*)\}/g))
      for (const q of m[1]!.matchAll(/["'`]([^"'`]+)["'`]/g)) emitted.add(q[1]!);

    expect(emitted.size, "no testids were read out of the product — the attribute's shape changed").toBeGreaterThan(20);

    const orphans: string[] = [];
    let named = 0;
    for (const file of FILES) {
      readFileSync(join(import.meta.dir, file), "utf8")
        .split("\n")
        .forEach((line, i) => {
          for (const m of line.matchAll(/data-testid=['"]([^'"\]$]+)['"]/g)) {
            const id = m[1]!;
            named++;
            if (emitted.has(id)) return;
            if (prefixes.some((head) => head.length > 3 && id.startsWith(head))) return;
            if (line.includes("absent-by-design")) return;
            orphans.push(`${file}:${i + 1} waits for [data-testid="${id}"], which no screen emits`);
          }
        });
    }
    expect(named, "no testids were found in the scenarios — the pattern stopped matching").toBeGreaterThan(30);
    expect(orphans).toEqual([]);
  });
});

describe("copy landmarks", () => {
  it("waits only for sentences the product still says", () => {
    const FILES = ["fe-render.test.ts", "fe-scenarios.test.ts"];
    const pins = new Set<string>();
    for (const f of FILES) {
      const text = readFileSync(join(import.meta.dir, f), "utf8");
      for (const m of text.matchAll(/shows\(page,\s*"([^"]*[가-힣][^"]*)"\)/g)) pins.add(m[1]!);
      // **`toContain` 도 기다림이다.** 오늘 `shows()` 만 보게 해뒀더니 문구를 바꾼 판에서
      // `toContain` 두 개가 남아 스윗이 90 fail 로 죽었다 — 이 검사는 1초에 이름을 대는데
      // 그 둘을 안 보고 있었다. `not.toContain` 은 **없어야 맞는 것**이라 뺀다.
      for (const m of text.matchAll(/(?<!not\.)toContain\(\s*"([^"]*[가-힣][^"]*)"\s*\)/g)) pins.add(m[1]!);
    }
    const ROOT = join(import.meta.dir, "..", "packages", "platform-web", "src");
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
      );
    const source = walk(ROOT)
      .filter((f) => /\.tsx?$/.test(f))
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");

    expect(pins.size, "no landmarks were found — the pattern stopped matching").toBeGreaterThan(10);
    // **보간을 넘는 앵커가 있다.** `서명 있음 · ed25519` 는 제품에서
    // `서명 있음 · ${alg}` 로 조립되므로 소스에 그 문자열은 없다 — 통째로 찾으면
    // 멀쩡한 앵커가 빨개진다. 그래서 **네 글자 이상 한글 덩어리 하나라도** 소스에
    // 있으면 통과로 본다: 문구가 통째로 바뀐 경우(오늘 넷)는 그 덩어리도 사라진다.
    // 한글 덩어리 **전부** 가 소스에 있어야 한다. `서명 있음 · ed25519` 는 제품에서
    // `서명 있음 · ${alg}` 로 조립되므로 통째로는 없지만 `서명`·`있음` 은 있다.
    // 문구를 바꾼 앵커는 덩어리 하나가 사라지므로(`불러올` → `불러오지`) 그대로 잡힌다.
    // ⚠ **한계**: 소스 전체에서 찾으므로, 바뀐 문구의 조각이 **다른 화면에 남아 있으면**
    // 그 앵커는 통과한다. 심어본 판(`불러오지` → `불러올`)이 실제로 그렇게 통과했다 —
    // 다른 화면이 아직 `불러올` 을 쓰고 있었다. 이 검사는 *문구가 트리에서 통째로 사라진 경우*
    // 를 1초에 잡는 것이고, **파일 단위 귀속은 못 한다**.
    const chunks = (pin: string) => (pin.match(/[가-힣]{2,}/g) ?? [pin]);
    const missing = [...pins].filter((pin) => !chunks(pin).every((c) => source.includes(c)));
    expect(
      missing,
      "a scenario waits for a sentence no screen contains — it will time out instead of failing",
    ).toEqual([]);
  });
});
