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

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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

describe("the inventory's own count", () => {
  // **§ 4 said 53 while § 4's own tables held 54, and called itself "분모 통계".**
  // Someone looking for the denominator reads the section named for it, so the
  // document contradicted itself in the place most likely to be believed. The
  // number was written by hand and the file grew three times in one day.
  //
  // Checked rather than corrected: correcting it buys until the next scenario.
  const INVENTORY = join(import.meta.dir, "..", "packages", "platform-web", "COVERAGE_INVENTORY.md");

  // **It counts mentions, not registrations**, and that is a proxy rather than
  // the thing. A scenario id named in a paragraph explaining what once drifted
  // is counted as registered, which is how correcting § 0 turned this red: three
  // ids appeared in prose and the stated total was suddenly three short.
  //
  // Left as a proxy on purpose. The alternative is parsing the matrix rows,
  // which is a second implementation of the document's structure living in a
  // test — and the reason § 0 drifted at all was a second declaration. The cost
  // is a rule for whoever edits the document: **name families in prose, not
  // ids.** Stated here rather than only in the document, because the person who
  // trips it will be reading this failure.
  test("the number it states is the number it holds", () => {
    const doc = readFileSync(INVENTORY, "utf8");
    const ids = new Set([...doc.matchAll(/SC-[A-Z0-9]+-[0-9]+/g)].map((m) => m[0]));

    // A regex that matched nothing would make the comparison 0 === 0 as soon as
    // the stated number went missing too.
    expect(ids.size, "no scenario ids were found in the inventory").toBeGreaterThan(20);

    const stated = /이 문서가 등록한 시나리오 ID\*\*:\s*\*\*([0-9]+)개/.exec(doc);
    expect(stated, "the inventory no longer states a count for this to check").not.toBeNull();
    expect(Number(stated![1]), "the inventory states a count it does not hold").toBe(ids.size);
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
    const rows = [...doc.matchAll(/^\| `(SC-[A-Z-]+)-\*` \|[^|]*\| ([0-9]+) \|$/gm)];
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
