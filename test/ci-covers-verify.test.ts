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

/**
 * Every command the workflow runs, with `bun run <script>` expanded.
 *
 * **Including the ones inside a `run: |` block.** This read one line per
 * `run:` key, which for a block scalar is the `|` and nothing else — so every
 * command in a multi-line step was invisible to the comparison below, and a
 * step moved into a block would have read as *CI stopped running this* or, the
 * other way round, as covered by a line that is only a pipe character. The
 * `observed` job has been a block since the day it landed.
 */
export function ciCommands(workflow: string, packageJson: string): string[] {
  const scripts: Record<string, string> = JSON.parse(packageJson).scripts ?? {};
  const expand = (line: string) => {
    const named = /^bun run ([\w:-]+)(.*)$/.exec(line);
    // `bun run typecheck` and the command it stands for are the same step, and
    // a comparison that cannot see through the alias reports drift on every
    // line CI writes the short way.
    return named && scripts[named[1]!] ? `${scripts[named[1]!]}${named[2] ?? ""}` : line;
  };

  const lines = workflow.split("\n");
  const found: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    // `- run:` and `run:` are the same key; the dash is only how YAML starts a
    // list item, and a step written without a `name:` uses it.
    const key = /^(\s*(?:-\s+)?)run:\s*(.*)$/.exec(lines[i]!);
    if (!key) continue;
    const rest = key[2]!.trim();
    if (rest !== "" && !/^[|>][-+]?$/.test(rest)) {
      found.push(expand(rest));
      continue;
    }
    // A block scalar: everything indented past the key belongs to this step,
    // up to the first line that is not. Blank lines and comments carry no
    // command, and a shell continuation is part of the line above it.
    const indent = key[1]!.length;
    let carried = "";
    for (let j = i + 1; j < lines.length; j++) {
      const body = lines[j]!;
      if (body.trim() === "") continue;
      const depth = body.length - body.trimStart().length;
      if (depth <= indent) break;
      i = j;
      const text = body.trim();
      if (text.startsWith("#")) continue;
      if (carried) {
        carried = text.endsWith("\\") ? `${carried} ${text.slice(0, -1).trim()}` : `${carried} ${text}`;
        if (!text.endsWith("\\")) {
          found.push(expand(carried));
          carried = "";
        }
        continue;
      }
      if (text.endsWith("\\")) {
        carried = text.slice(0, -1).trim();
        continue;
      }
      found.push(expand(text));
    }
    if (carried) found.push(expand(carried));
  }
  return found;
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

  test("reads the commands inside a block step, not the pipe character", () => {
    // What this could not see: a step written as `run: |`. One `run:` key,
    // several commands, and the old reading took the key's value — `|` — as
    // the command. Every one of these lines was invisible.
    const workflow = [
      "jobs:",
      "  a:",
      "    steps:",
      "      - name: One line",
      "        run: bun run typecheck",
      "      - name: Several",
      "        run: |",
      "          set -o pipefail",
      "          # a comment carries no command",
      "",
      "          bun scripts/coverage.ts --ratchet coverage-floor.json",
      "      - name: After the block",
      "        run: echo done",
    ].join("\n");
    expect(ciCommands(workflow, JSON.stringify({ scripts: { typecheck: "tsc -b" } }))).toEqual([
      "tsc -b",
      "set -o pipefail",
      "bun scripts/coverage.ts --ratchet coverage-floor.json",
      "echo done",
    ]);
  });

  test("joins a shell continuation into the one command it is", () => {
    // `cmd \\` then its arguments is one command. Read as two, the first half
    // matches a verify step it does not actually run to completion.
    const workflow = ["    steps:", "      - run: |", "          bun scripts/coverage.ts \\", "            --ratchet coverage-floor.json"].join("\n");
    expect(ciCommands(workflow, "{}")).toEqual(["bun scripts/coverage.ts --ratchet coverage-floor.json"]);
  });

  test("the workflow's own block steps are among what it read", () => {
    // The synthetic cases above prove the parser; this proves it against the
    // file that matters, so a workflow rewritten in a shape the parser cannot
    // see is a red here rather than a quiet zero.
    expect(CI.some((line) => line.startsWith("bun scripts/scenario-anchors.ts")), "the observed job's block was not read")
      .toBe(true);
    expect(CI.includes("|"), "a block scalar's pipe character was read as a command").toBe(false);
  });

  test("sees through the package script CI calls a step by", () => {
    // `bun run typecheck` is the alias; without expanding it this check reports
    // the typecheck as missing and gets switched off for being noisy.
    expect(CI.some((line) => line.startsWith("bun --bun tsc -b tsconfig.base.json")), "the workflow's `bun run typecheck` was not recognised as the typecheck step")
      .toBe(true);
  });
});
