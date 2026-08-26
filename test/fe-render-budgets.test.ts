/**
 * The timeouts in `fe-render.test.ts` are ordered, and the order is checked.
 *
 * **Two numbers in two libraries that agreed by habit.** `setDefaultTimeout`
 * gives each test twenty seconds; Playwright gives each navigation thirty
 * unless told otherwise, and nothing said otherwise. A navigation that runs
 * long therefore cannot report itself: the test fails first, on its own budget,
 * and the navigation's rejection lands afterwards as
 * `Unhandled error between tests` — attributed by bun to whichever scenario is
 * running when it arrives. One `/platform/tenants` navigation under load was
 * read that way for an entire run before the timestamps were compared.
 *
 * Read out of the source rather than imported, because importing that file
 * starts a browser, a vite server and a mesh. This is a check about two
 * constants; it should not cost a suite to run.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(import.meta.dir, "fe-render.test.ts"), "utf8");

/** A `12_000`-style literal, as the source writes it. */
function literal(name: RegExp): number {
  const m = name.exec(SOURCE);
  if (!m) throw new Error(`${name} matched nothing in fe-render.test.ts — the constant was renamed`);
  return Number(m[1]!.replace(/_/g, ""));
}

describe("the budgets in the render suite", () => {
  test("a navigation cannot outlive the test that started it", () => {
    const perTest = literal(/setDefaultTimeout\((\d[\d_]*)\)/);
    const perNavigation = literal(/const NAVIGATION_BUDGET = (\d[\d_]*);/);

    expect(
      { perTest, perNavigation, ordered: perNavigation < perTest },
      "a navigation is allowed to run longer than the test holding it, so its timeout is reported against a later scenario",
    ).toEqual({ perTest, perNavigation, ordered: true });
  });

  test("and the navigation budget is actually installed on the context", () => {
    // Otherwise the constant above is a number nothing reads, and Playwright's
    // thirty-second default is still what runs.
    expect(
      SOURCE.includes("ctx.setDefaultNavigationTimeout(NAVIGATION_BUDGET)"),
      "NAVIGATION_BUDGET is declared but never given to a browser context",
    ).toBe(true);
  });
});
