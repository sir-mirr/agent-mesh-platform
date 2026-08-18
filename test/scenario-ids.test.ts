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

/** Every `[SC-…]` id an `it(` in a file registers. */
function idsOf(file: string): string[] {
  const source = readFileSync(join(TESTS, file), "utf8");
  return [...source.matchAll(/\bit(?:\.skip)?\(\s*"\[([A-Z0-9-]+)\]/g)].map((m) => m[1]!);
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

  test("no id is registered twice in the same file either", () => {
    for (const f of FILES) {
      const ids = idsOf(f);
      const duplicated = ids.filter((id, i) => ids.indexOf(id) !== i);
      expect([...new Set(duplicated)], `${f} registers an id twice`).toEqual([]);
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
