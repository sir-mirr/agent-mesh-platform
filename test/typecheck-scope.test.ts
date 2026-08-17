/**
 * Every TypeScript file in this repository is inside the typecheck.
 *
 * **The failure this exists for.** `scripts/` and `.claude/hooks/` were outside
 * `tsconfig.base.json` for as long as they had existed. `bun run typecheck`
 * reported zero the whole time, and it was telling the truth about the files it
 * had been given — which did not include the harness that every cross-repository
 * conformance run starts, nor the hooks that deliver mail.
 *
 * Bringing them in surfaced two defects immediately: `--state-dir` with no value
 * after it silently meant "no state directory", so a runner asking to keep state
 * got a mesh whose files were removed on exit; and `mailbox-watch.ts` was not a
 * module, making every top-level `await` in it a syntax error nobody had run
 * `tsc` over.
 *
 * `client-claude` found the same shape on their side in the same hour (mail
 * #207): a runner directory absent from their `include`, so every "typecheck 0"
 * they had reported while editing that runner was a statement about the rest of
 * the repository.
 *
 * ## Why a test rather than a note
 *
 * The obvious fix is a line in a document saying the check must cover
 * everything. This session has watched a hardcoded verb list, a permitted skip and
 * an unlisted directory all keep the *appearance* of a check while checking
 * nothing, and in each case the document already said the right thing.
 *
 * A rule does not enforce itself. This does.
 *
 * ## Structural, not a second compile
 *
 * It reads the project references and their `include` globs rather than running
 * `tsc --listFiles`, which would double the slowest check in CI to answer a
 * question about configuration. What it catches is a directory nobody wired up,
 * which is the way this goes wrong — not a single file mysteriously excluded
 * from a directory that is otherwise covered.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

/**
 * The repository's TypeScript, as the repository itself defines it.
 *
 * The first version walked the tree past a hand-written set of directories to
 * ignore — `node_modules`, `dist`, and whatever else someone remembered. That
 * set is a second declaration of what counts as source, and a second
 * declaration is what this whole file exists because of: adding a name to it
 * removes a directory from the check, and **a file that is not enumerated
 * cannot be reported as uncovered.** The failure would be silent in the one
 * place built to make it loud.
 *
 * `git ls-files` with `--others --exclude-standard` is tracked files plus
 * untracked ones that are not ignored — the repository's own answer, declared
 * once in `.gitignore`. Nothing here restates it.
 *
 * The tradeoff is that a `.ts` file both untracked *and* ignored is invisible.
 * That is the correct reading: an ignored file is not source this repository
 * ships, and if it should be, `.gitignore` is where that gets said.
 */
function everyTsFile(): string[] {
  const out = Bun.spawnSync(
    ["git", "-C", ROOT, "ls-files", "--cached", "--others", "--exclude-standard", "*.ts"],
  );
  if (!out.success) throw new Error("git ls-files failed — cannot enumerate this repository");
  return new TextDecoder()
    .decode(out.stdout)
    .split("\n")
    .filter((f) => f && !f.endsWith(".d.ts"));
}

/** `tsc` allows comments; `JSON.parse` does not. */
const readJsonc = (path: string): any =>
  JSON.parse(readFileSync(path, "utf8").replace(/^\s*\/\/.*$/gm, ""));

/**
 * Every path pattern the build covers, as directory prefixes.
 *
 * A glob is reduced to the directory it starts from, which is all this needs:
 * the question is whether some project claims the directory a file is in.
 */
function coveredPrefixes(): string[] {
  const base = readJsonc(join(ROOT, "tsconfig.base.json"));
  const prefixes: string[] = [];
  for (const ref of base.references ?? []) {
    const projectPath = join(ROOT, ref.path);
    const projectDir = projectPath.replace(/\/tsconfig\.json$/, "");
    const project = readJsonc(projectPath);
    for (const pattern of project.include ?? []) {
      const upTo = pattern.indexOf("*");
      const head = upTo === -1 ? pattern : pattern.slice(0, upTo);
      prefixes.push(relative(ROOT, resolve(projectDir, head)) || ".");
    }
  }
  return prefixes;
}

/** Is `file` claimed by any project? */
const covers = (prefixes: string[], file: string): boolean =>
  prefixes.some((p) => file === p || file.startsWith(`${p}/`));

describe("the typecheck covers this repository", () => {
  test("no TypeScript file is outside every project", () => {
    const prefixes = coveredPrefixes();
    const uncovered = everyTsFile().filter((file) => !covers(prefixes, file));

    // Named individually. "3 files are uncovered" sends a reader looking; the
    // list sends them to the tsconfig that needs a reference.
    expect(
      uncovered,
      `outside \`bun run typecheck\` — add a project for them in tsconfig.base.json:\n${uncovered.join("\n")}`,
    ).toEqual([]);
  });

  test("the check is capable of failing", () => {
    // **A matcher that cannot say no is green under every configuration**, and
    // that is the fourth appearance of one shape in this session: a hardcoded
    // verb list, a permitted skip, an unlisted directory, and now a predicate
    // that could quietly become a constant. `client-claude` added this case to
    // their copy first (mail #209) and they are right that it belongs.
    //
    // The `.` prefix is the specific trapdoor. An include pattern anchored at
    // the repository root reduces to it, and the first draft of this file
    // treated `.` as covering everything — which is true, and would have made
    // the test above pass for any repository at all.
    const prefixes = coveredPrefixes();
    expect(prefixes, "no project claims anything").not.toEqual([]);
    expect(prefixes, "a project is anchored at the repository root, so every file is vacuously covered")
      .not.toContain(".");
    expect(
      covers(prefixes, "nowhere/at/all.ts"),
      "the matcher accepts a path no project mentions",
    ).toBe(false);
  });

  test("the walk actually finds this repository", () => {
    // **The other half of the same question**, and the half this file was
    // missing. The case above asks whether the pattern side can become
    // universal; nothing asked whether the *file* side could become empty. With
    // `everyTsFile` returning nothing, all three tests here pass and the check
    // covers a repository with no source in it.
    //
    // `client-claude` reached the pattern half from the other direction (mail
    // #211) — a full `**/*.ts` glob makes their matcher answer for any path at
    // all. Two implementations, two vacuity routes, one property.
    //
    // Named files rather than only a count, and deliberately these: the harness
    // is what the original defect hid in, and this file finding itself is the
    // cheapest proof the enumeration reaches where it claims to.
    //
    // Still needed with `git ls-files` doing the enumerating. It removes the
    // hand-written ignore list, not the possibility that the command changes,
    // fails softly, or is asked the wrong question.
    const found = everyTsFile();
    expect(found, "the walk found no source at all").not.toEqual([]);
    expect(found).toContain("scripts/e2e-harness.ts");
    expect(found).toContain("test/typecheck-scope.test.ts");
    expect(found).toContain("packages/hub/src/main.ts");
    // A floor, not a total. An exact number would fail on every file added,
    // which trains a reader to update it without reading why it moved.
    expect(found.length, "far fewer files than this repository has").toBeGreaterThan(50);
  });

  test("every referenced project exists", () => {
    // A reference to a path that is gone makes `tsc -b` fail loudly, so this is
    // not about catching a broken build. It is about the opposite: a project
    // renamed and its reference left behind reads as coverage that is not there.
    const base = readJsonc(join(ROOT, "tsconfig.base.json"));
    for (const ref of base.references ?? []) {
      expect(statSync(join(ROOT, ref.path)).isFile(), `${ref.path} does not exist`).toBe(true);
    }
  });
});
