/**
 * Every source file has had a defect planted in it at least once.
 *
 * **Coverage says the line ran; an anchor says somebody would notice if it were
 * wrong.** This repository holds 100.00% of both funcs and lines, and that
 * number has never been the goal on its own — the manifest is what makes it
 * mean something, and until now nothing counted the files the manifest reaches.
 * A new file arrives with tests, the tests pass, coverage stays at 100, and no
 * entry in the manifest has ever asked whether those tests object to anything.
 * That gap is invisible in exactly the way the ones this suite spent the week
 * closing were: nothing goes red, and the count nobody computes stays right.
 *
 * The exemptions are checked rather than declared. A barrel of re-exports and a
 * file of type declarations have no behaviour to break — the defect a person
 * would introduce there is a wrong symbol or a missing member, and `tsc`
 * refuses that before a suite runs. So each exempt file is read, and the
 * exemption falls away the moment somebody puts a statement in it.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/**
 * The files the manifest plants into, read out of a child.
 *
 * `test/tsconfig.json` does not list `scripts/`, so importing the manifest here
 * makes `tsc` refuse the whole project. Same reason and same shape as
 * `mutation-expect-phrases.test.ts`.
 */
const LIVE: Array<{ file: string; suite: string }> = (() => {
  const dump =
    'const { MUTATIONS } = await import("./scripts/mutation-check.ts");' +
    "console.log(JSON.stringify(MUTATIONS.filter((m) => m.from).map((m) => ({ file: m.file, suite: m.suite }))));";
  const proc = Bun.spawnSync(["bun", "-e", dump], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const said = proc.stdout.toString();
  if (!said.trim()) throw new Error(`the manifest would not load: ${proc.stderr.toString().slice(0, 800)}`);
  return JSON.parse(said);
})();

/** Files a defect has been planted into. */
const ANCHORED = new Set(LIVE.map((entry) => entry.file));

/** Suites an entry has ever routed a planted defect to. */
const ASKED = new Set(LIVE.map((entry) => entry.suite));

/** Every test file in the tree — the other half of the same question. */
const SUITES: string[] = Bun.spawnSync(["git", "ls-files"], { cwd: ROOT })
  .stdout.toString()
  .split("\n")
  .filter((path) => /\.test\.tsx?$/.test(path));

/** Everything tracked that a defect could be planted into. */
const SOURCES: string[] = Bun.spawnSync(["git", "ls-files"], { cwd: ROOT })
  .stdout.toString()
  .split("\n")
  .filter((path) => /^(packages\/[^/]+\/src\/|scripts\/|test\/)/.test(path))
  .filter((path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path) && !/\.d\.ts$/.test(path));

/**
 * Files with nothing to plant into, and why.
 *
 * A reason is not enough on its own — `stale exemptions` below reads each file
 * and refuses one that has grown a body since the reason was written.
 */
const NOTHING_TO_BREAK: ReadonlyMap<string, string> = new Map([
  [
    "packages/mailbox/src/index.ts",
    "the package surface: re-exports only, and a wrong one is a type error before any suite runs",
  ],
  [
    "packages/platform-web/src/components/index.ts",
    "a barrel of `export *` lines; dropping one is a missing import at build time, not a screen that lies",
  ],
  [
    "packages/platform-web/src/types/auth.ts",
    "type declarations and two re-exported constants — every defect available here is one tsc refuses",
  ],
]);

/**
 * True when a file declares and re-exports and does nothing else.
 *
 * Deliberately blunt: an arrow, a `function`, a branch or a loop is a body, and
 * a body can be wrong in a way no compiler catches. Anything this returns false
 * for needs an anchor rather than an exemption.
 */
export function onlyDeclaresAndReExports(source: string): boolean {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  return !/=>|\bfunction\b|\bif\s*\(|\bfor\s*\(|\bwhile\s*\(|\breturn\b/.test(withoutComments);
}

describe("what the manifest reaches", () => {
  test("counts a corpus that exists", () => {
    // The denominator. A filter that matched nothing would make every claim
    // below true about the empty set.
    expect(SOURCES.length, "no source files were found — the two checks below are about nothing")
      .toBeGreaterThan(100);
    expect(ANCHORED.size, "no anchored files were read out of the manifest").toBeGreaterThan(50);
  });

  test("leaves no source file nobody has ever planted a defect into", () => {
    const unreached = SOURCES.filter((path) => !ANCHORED.has(path) && !NOTHING_TO_BREAK.has(path));
    expect(
      unreached,
      "no entry in the manifest has ever planted a defect in these files, so nothing has shown that their tests would object to one — either write an entry or argue the file has no behaviour to break in NOTHING_TO_BREAK",
    ).toEqual([]);
  });

  test("leaves no suite that has never been asked a question", () => {
    // The other direction. A file with an anchor has been planted into; a suite
    // with an anchor has been shown to object to something. A test file no
    // entry ever routes to has never failed on purpose, and a suite nobody has
    // seen fail is a suite nobody has seen work.
    const nevernamed = SUITES.filter((path) => !ASKED.has(path));
    expect(
      nevernamed,
      "no manifest entry plants a defect these suites would catch, so nothing has shown they can fail at all",
    ).toEqual([]);
  });

  test("counts the suites it is reading", () => {
    expect(SUITES.length, "no test files were found — the check above is about nothing")
      .toBeGreaterThan(100);
  });

  test("keeps no stale exemptions", () => {
    const stale: string[] = [];
    for (const [path, why] of NOTHING_TO_BREAK) {
      if (!SOURCES.includes(path)) {
        stale.push(`${path} — exempt, and no longer a source file`);
        continue;
      }
      if (ANCHORED.has(path)) {
        stale.push(`${path} — exempt, and the manifest plants into it anyway`);
        continue;
      }
      if (!onlyDeclaresAndReExports(readFileSync(join(ROOT, path), "utf8"))) {
        stale.push(`${path} — exempt as "${why}", and it has grown a body since`);
      }
    }
    expect(stale, "an exemption stopped being true and the file went on being exempt").toEqual([]);
  });
});

describe("the reading that decides an exemption", () => {
  // The predicate is what stands between "this file has no behaviour" and a
  // file that quietly got some. Run against both, here, rather than only
  // against the three files that pass it today.
  test("a barrel is a barrel", () => {
    expect(onlyDeclaresAndReExports('export * from "./Button.tsx";\nexport type { User } from "./user";')).toBe(true);
  });

  test("a body is not", () => {
    const grown = 'export * from "./Button.tsx";\nexport const label = (n: number) => `${n} items`;';
    expect(onlyDeclaresAndReExports(grown), "a file with a function in it was read as having nothing to break").toBe(false);
  });

  test("a comment describing a body is not a body", () => {
    const commented = '// this used to hold a function, and the reason was:\n// return n => n + 1\nexport * from "./Button.tsx";';
    expect(onlyDeclaresAndReExports(commented), "prose about code was read as code").toBe(true);
  });
});
