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
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Components reach for `document` at module scope by way of React; registered
// once per process, as everywhere else in this package.
if (!(globalThis as { document?: unknown }).document) GlobalRegistrator.register();

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

  for (const file of MODULES) {
    test(`${relative(SRC, file)} loads`, async () => {
      const mod = await import(file);
      expect(mod).toBeDefined();
    });
  }
});
