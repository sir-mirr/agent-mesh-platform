/**
 * Every module in this package, imported.
 *
 * **This file exists to fix the denominator.** Bun's coverage reports the files
 * a test loaded; a file nobody imports is not `0%`, it is absent — so a package
 * can read 85% while two thirds of it has never been opened, and the way to
 * raise that number is to stop importing the hard parts. Measured before this
 * file: 13 of 55 files in the table. vitest has `coverage.all` for this; bun
 * does not, and an import is what it would have done anyway.
 *
 * Loading a module is not testing it. What the percentage means afterwards is
 * "of everything here", which is the only reading worth quoting, and the
 * uncovered lines it exposes are the work list.
 *
 * It also asserts something real, if small: that every module in this package
 * can be loaded at all. Half of these run only inside a browser today, where a
 * module-scope throw shows up as a blank screen and a console line nobody is
 * watching.
 */
import { describe, expect, test, afterAll } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
import { registerDom } from "./register-dom";

// Components reach for `document` at module scope by way of React; registered
// once per process, as everywhere else in this package.
registerDom();

const SRC = join(import.meta.dir);

function everyModule(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return everyModule(full);
    if (!/\.tsx?$/.test(full)) return [];
    // Tests are not the subject, and `main.tsx` mounts the app into a document
    // it expects to own.
    if (/\.test\.tsx?$/.test(full) || full.endsWith("main.tsx")) return [];
    return [full];
  });
}

const MODULES = everyModule(SRC);

describe("every module in this package", () => {
  test("the list is derived, and is not empty", () => {
    // A floor: a walk that stopped matching would make every assertion below
    // vacuous, which is the failure mode of a test that derives its own subject.
    expect(MODULES.length).toBeGreaterThan(40);
  });

  /**
   * The same list, read by something that does not share this walk's opinions.
   *
   * **The floor above cannot see half of a miss.** This package is 42 `.tsx`
   * modules and 16 `.ts` ones, so a walk that stopped matching `.ts` still
   * returns 42 and clears a floor of 40 — sixteen modules leave the import list
   * and nothing says so. The coverage number does not say so either: a
   * denominator that shrinks makes a ratcheted 100% *easier* to hold, which is
   * the direction no check is watching.
   *
   * git is the second reader because it fails differently: it knows what is
   * tracked and nothing about extensions or directory walks. The exclusions are
   * restated here rather than shared with `everyModule` — a filter both readers
   * import is one reader wearing two hats.
   */
  test("agrees with what git says is in this package", () => {
    const tracked = new Set(
      Bun.spawnSync(["git", "ls-files", "packages/platform-web/src"], { cwd: REPO_ROOT })
        .stdout.toString()
        .split("\n")
        .filter((line) => /\.tsx?$/.test(line))
        .filter((line) => !/\.test\.tsx?$/.test(line) && !line.endsWith("main.tsx"))
        .map((line) => line.replace("packages/platform-web/src/", "")),
    );
    const walked = new Set(MODULES.map((file) => relative(SRC, file)));

    // Both directions. Missing files are the defect this exists for; extra ones
    // mean the walk is reaching outside the package, which is its own bug.
    expect(
      {
        walkedButUntracked: [...walked].filter((f) => !tracked.has(f)).sort(),
        trackedButUnwalked: [...tracked].filter((f) => !walked.has(f)).sort(),
      },
      "the module walk and git disagree about what is in this package",
    ).toEqual({ walkedButUntracked: [], trackedButUnwalked: [] });

    // And that the second reader found anything at all — an empty set agrees
    // with every walk, including one that returns nothing.
    expect(tracked.size, "git listed no modules, so the comparison above is vacuous")
      .toBeGreaterThan(40);
  });

  for (const file of MODULES) {
    test(`${relative(SRC, file)} loads`, async () => {
      const mod = await import(file);
      expect(mod).toBeDefined();
    });
  }
});
