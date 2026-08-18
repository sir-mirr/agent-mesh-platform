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
