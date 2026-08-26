/**
 * Every phrase an entry expects names something that exists.
 *
 * **A phrase that names nothing can only pass by accident.** `expect` is what
 * makes a red run *evidence*: the suite has to fail, and it has to fail saying
 * the thing this entry is about. A phrase nothing in the tree ever prints
 * cannot be found in any output, so the entry is reported not-caught — but only
 * on the night that shard runs it, and only if somebody reads that shard.
 *
 * Twice in one session: a test renamed while its fixtures were fixed left the
 * entry planting it expecting the old title, and an entry written against a
 * check that fires *later* in the same test was reported as caught by the wrong
 * one. Both were found by planting. This finds the first kind in a second.
 *
 * It does not assert that a phrase is *sufficient* — that is what planting is
 * for, and no static reading substitutes for it. It asserts the weaker thing
 * that planting cannot tell you quickly: the phrase is a string this repository
 * actually contains.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/**
 * The manifest, read out of a child rather than imported.
 *
 * `test/tsconfig.json` does not list `scripts/`, so importing the manifest here
 * makes `tsc` refuse the whole project — and adding the directory to this one
 * would typecheck it twice under two configurations. A child that prints the
 * three fields this file needs costs a process and keeps the projects apart.
 */
const MANIFEST: Array<{ id: string; suite: string; expect: string[] }> = (() => {
  const dump =
    'const { MUTATIONS } = await import("./scripts/mutation-check.ts");' +
    "console.log(JSON.stringify(MUTATIONS.map((m) => ({ id: m.id, suite: m.suite, expect: m.expect }))));";
  const proc = Bun.spawnSync(["bun", "-e", dump], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const said = proc.stdout.toString();
  if (!said.trim()) throw new Error(`the manifest would not load: ${proc.stderr.toString().slice(0, 800)}`);
  return JSON.parse(said);
})();

/**
 * Everything tracked that can print a phrase, as one string.
 *
 * Read once. A `git grep` per phrase is a subprocess per phrase, and there are
 * two thousand of them.
 */
const CORPUS = (() => {
  const listed = Bun.spawnSync(["git", "ls-files"], { cwd: ROOT }).stdout.toString().split("\n");
  const parts: string[] = [];
  for (const path of listed) {
    if (!/\.(ts|tsx|md|json|css|html|yml)$/.test(path)) continue;
    try {
      parts.push(readFileSync(join(ROOT, path), "utf8"));
    } catch {
      /* a path listed but not present is somebody else's failure, not this one */
    }
  }
  return parts.join("\n");
})();

/**
 * Phrases that exist only once something has run.
 *
 * **An exemption list, which is the shape a check gets weakened through**, so
 * it is kept short, reasoned, and checked from both ends below: an entry here
 * that no entry uses is stale, and one whose phrase the corpus *does* contain
 * was never needed.
 */
const RUNTIME_FORMATTED: Record<string, string> = {
  '"digest": true': "bun prints the object an assertion compared as JSON. `digest` is a key of what `SC-WRITE-05` compares, so the source writes `digest:` and only a failing run writes the quoted form.",
};

describe("the phrases the manifest expects", () => {
  test("the manifest and the corpus both loaded", () => {
    // Both floors in one place: an empty manifest asserts nothing about
    // anything, and an empty corpus reports every entry at once, which reads as
    // the manifest rotting rather than as a reader that failed to open a file.
    expect(MANIFEST.length, "no entries were read out of the manifest").toBeGreaterThan(1000);
    // The floor that keeps the assertion below from being vacuous: an empty
    // corpus contains no phrase, so every entry would be reported, and a
    // corpus that failed to load would look like the whole manifest rotting at
    // once rather than like a broken reader.
    expect(CORPUS.length, "no tracked source was read, so nothing below is a finding").toBeGreaterThan(1_000_000);
    expect(CORPUS, "the corpus loaded but holds none of this repository").toContain("AGENT_MESH_STATE_DIR");
  });

  test("each one is a string this repository contains", () => {
    const orphaned: string[] = [];
    for (const entry of MANIFEST) {
      const suite = (() => {
        try {
          return readFileSync(join(ROOT, entry.suite), "utf8");
        } catch {
          return "";
        }
      })();
      for (const phrase of entry.expect) {
        // The suite first: that is where a title or an assertion message lives,
        // and it is where all but a few of these are found.
        if (suite.includes(phrase)) continue;
        // Then anywhere — a phrase can be something the product prints, and
        // `SQLITE_CANTOPEN` is not in the suite that reads it.
        if (CORPUS.includes(phrase)) continue;
        // Last: a phrase that only exists once something has run.
        if (phrase in RUNTIME_FORMATTED) continue;
        orphaned.push(`${entry.id}: "${phrase}" — not in ${entry.suite}, and nowhere else in the tree`);
      }
    }
    expect(orphaned, "an entry expects a phrase nothing in this repository prints").toEqual([]);
  });

  test("and every suite an entry names is something bun can run", () => {
    // The same failure one level up: a suite that was renamed leaves entries
    // pointing at nothing, and `bun test <missing>` exits non-zero, which reads
    // as *caught* — the mutation is credited with a failure it did not cause.
    //
    // A directory is a suite too. Ninety-odd entries name `packages/mailbox/`
    // and the like, which is what `bun test` is given and what it walks; a
    // reader that only accepts files calls every one of them missing.
    const missing = [...new Set(MANIFEST.filter((e) => !existsSync(join(ROOT, e.suite))).map((e) => e.suite))];
    expect(missing, "an entry names a suite this tree does not have").toEqual([]);
  });

  test("and the exemptions are still exemptions", () => {
    // Both ways an exemption goes wrong. One nobody uses is a line that says a
    // phrase is special when no entry asks for it; one the corpus contains is a
    // phrase that needs no exemption, and leaving it here would hide the day it
    // stops being printed.
    const used = new Set(MANIFEST.flatMap((entry) => entry.expect));
    expect(
      {
        unused: Object.keys(RUNTIME_FORMATTED).filter((phrase) => !used.has(phrase)),
        needless: Object.keys(RUNTIME_FORMATTED).filter((phrase) => CORPUS.includes(phrase)),
      },
      "an exemption names a phrase no entry expects, or one the tree contains anyway",
    ).toEqual({ unused: [], needless: [] });
  });
});
