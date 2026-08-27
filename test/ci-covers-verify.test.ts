/**
 * Everything `verify.ts` runs, CI runs too.
 *
 * **The two lists were already apart.** `scripts/verify.ts` has run the
 * scenario inventory since the day it was written, and `ci.yml` never did — so
 * the check that refuses an unreadable scenario header or a stale exemption
 * ran only where somebody happened to type `bun scripts/verify.ts`, and
 * anything landing through a pull request got a green tree from a step that
 * never looked. Nothing said so, because both files were individually right.
 *
 * This is the join. It reads the step list out of `verify.ts` and the `run:`
 * lines out of the workflow, expands `bun run <script>` through `package.json`
 * so the two can be compared as commands rather than as spellings, and refuses
 * a step that only one of them performs.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

/**
 * The commands `verify.ts` runs, read from its source.
 *
 * Read rather than imported: importing it runs the whole verification, which
 * is a browser suite and a coverage pass inside a unit test.
 */
export function verifySteps(source: string): string[] {
  const list = source.slice(source.indexOf("const DEFAULT_STEPS"), source.indexOf("function steps()"));
  return [...list.matchAll(/command:\s*\[([^\]]*)\]/g)].map((match) =>
    match[1]!
      .split(",")
      .map((part) => part.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean)
      .join(" "),
  );
}

/** Every `run:` line in the workflow, with `bun run <script>` expanded. */
export function ciCommands(workflow: string, packageJson: string): string[] {
  const scripts: Record<string, string> = JSON.parse(packageJson).scripts ?? {};
  return [...workflow.matchAll(/^\s*run:\s*(.+)$/gm)].map((match) => {
    const line = match[1]!.trim();
    const named = /^bun run ([\w:-]+)(.*)$/.exec(line);
    // `bun run typecheck` and the command it stands for are the same step, and
    // a comparison that cannot see through the alias reports drift on every
    // line CI writes the short way.
    return named && scripts[named[1]!] ? `${scripts[named[1]!]}${named[2] ?? ""}` : line;
  });
}

const STEPS = verifySteps(read("scripts/verify.ts"));
const CI = ciCommands(read(".github/workflows/ci.yml"), read("package.json"));

/** One command stands for another when either is how the other starts. */
const covers = (ci: string, step: string) => ci.startsWith(step) || step.startsWith(ci);

describe("what CI runs against what verify runs", () => {
  test("reads both lists", () => {
    // The denominator, twice. Either regex matching nothing would make the
    // comparison below hold over an empty set.
    expect(STEPS.length, "no steps were read out of verify.ts").toBeGreaterThanOrEqual(5);
    expect(CI.length, "no run: lines were read out of the workflow").toBeGreaterThanOrEqual(8);
  });

  test("leaves no step that only one of them performs", () => {
    const missing = STEPS.filter((step) => !CI.some((line) => covers(line, step)));
    expect(
      missing,
      "verify runs these and CI does not, so a tree can land green having never been asked them",
    ).toEqual([]);
  });

  test("sees through the package script CI calls a step by", () => {
    // `bun run typecheck` is the alias; without expanding it this check reports
    // the typecheck as missing and gets switched off for being noisy.
    expect(CI.some((line) => line.startsWith("bun --bun tsc -b tsconfig.base.json")), "the workflow's `bun run typecheck` was not recognised as the typecheck step")
      .toBe(true);
  });
});
