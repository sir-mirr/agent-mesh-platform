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
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
    // **The two files that contain the phrases by definition.** Planting caught
    // this: an `expect` phrase is a string literal in the manifest, so a corpus
    // holding the manifest finds every phrase in itself and the check passes for
    // anything — including the renamed title this exists to refuse. It looked
    // like it worked because a handful of phrases carry escaped quotes and do
    // not match their own source. The question is whether anything *else* in
    // the tree prints the phrase, so the two files that merely name it are not
    // part of the corpus that answers it.
    if (path === "scripts/mutation-check.ts" || path === "test/mutation-expect-phrases.test.ts") continue;
    try {
      parts.push(readFileSync(join(ROOT, path), "utf8"));
    } catch {
      /* a path listed but not present is somebody else's failure, not this one */
    }
  }
  /**
   * The contract's own text, which this repository pins rather than holds.
   *
   * `E2E-EGRESS-001` and `body.events.0.event_type` are scenario ids and step
   * assertions out of `@agent-mesh/contracts`: the suite drives them from
   * `E2E_SCENARIOS`, so the strings a failing run prints belong to the package,
   * not to any file `git ls-files` lists. Reading the tracked tree alone called
   * seventeen entries orphaned that are pinned to exactly the thing pinning a
   * tag is for.
   */
  const contracts = join(ROOT, "node_modules", "@agent-mesh", "contracts", "src");
  if (existsSync(contracts)) {
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|json)$/.test(entry.name)) parts.push(readFileSync(full, "utf8"));
      }
    };
    walk(contracts);
  }

  return parts.join("\n");
})();

/**
 * Phrases that exist only once something has run.
 *
 * **Shapes rather than a list of strings.** Every one of these is a template
 * literal somewhere — `${r.event_id}: row.${k} and payload.${k} disagree`,
 * `${f}-*: table says ${n}`, a JSON path the scenario runner builds out of the
 * field it compared, bun printing the compared object. Listing the
 * instantiations would mean a new line every time an entry pins a different
 * field, and a list that grows on every use stops being read.
 *
 * This is still an exemption list, which is the shape a check gets weakened
 * through, so each shape is narrow, carries its reason, and is checked from the
 * other end below: a shape no phrase needs is removed rather than kept.
 */
const COMPOSED: Array<{ pattern: RegExp; why: string }> = [
  {
    pattern: /^\((send|receive|connect|http)\)/,
    why: "the scenario runner labels a step by the verb it ran — `(send): error code` is built from the step, never written down",
  },
  {
    pattern: /^body\.[a-z]/,
    why: "a JSON path the scenario runner prints for the field it compared, assembled from the path it walked",
  },
  {
    pattern: /^"[a-z_]+": /,
    why: "bun prints the object an assertion compared as JSON, so a key is quoted in the output and bare in the source",
  },
  {
    pattern: /^row\.[a-z_]+ and payload\./,
    why: "`audit-integrity` names the column it found disagreeing: `row.${k} and payload.${k} disagree`",
  },
  {
    pattern: /^SC-[A-Z0-9]+-\*/,
    why: "an axis label `scenario-ids` composes from a family name, as `${f}-*: table says ${n}`",
  },
  {
    pattern: /^expect\(received\)/,
    why: "bun's own assertion banner, printed by the runner rather than by anything in this repository",
  },
  {
    pattern: /^SC-[A-Z0-9]+(?:-[A-Z0-9]+)+ at \S+\.test\.tsx?$/,
    why: "`scenario-ids` names a duplicate as `${id} at ${file}`, and the file half is whichever suite registered it twice",
  },
  {
    pattern: /\.env\.example cannot start the /,
    why: "`readme` names the file and the service it could not start: `${example} cannot start the ${service} as documented`",
  },
  {
    pattern: /^no start command found for the /,
    why: "the other half of the same check, naming the service and the document it read",
  },
  {
    pattern: / answers 200 and says which happened$/,
    why: "`delete-absence` registers one test per delete route, titled from the route it walked",
  },
  {
    pattern: /^\/api\/v1\/\S+ is not/,
    why: "`mailbox-path` builds the sibling name it is refusing out of the prefix under test",
  },
  {
    pattern: /^[a-z-]+ was folded$/,
    why: "`SC-DEL-*` names the teardown result it could not tell apart: `${action} was folded into another teardown result`",
  },
  {
    pattern: /^folded [a-z]+ into another state$/,
    why: "`SC-DOWN-15` names the reading a panel folded away: `${panel.prefix} folded ${reading} into another state`",
  },
  {
    pattern: /^the session cookie is set in \d+ places$/,
    why: "`set-cookie-survives` counts the sites it found and prints the count with them",
  },
  {
    pattern: / hands the browser a script it can parse$/,
    why: "`ui-behaviour` registers one test per page, titled from the page it walked",
  },
];

/** Each suite's source, read once — two tests ask the same files. */
const SUITES = new Map<string, string>(
  [...new Set(MANIFEST.map((entry) => entry.suite))].map((suite) => {
    try {
      return [suite, readFileSync(join(ROOT, suite), "utf8")] as const;
    } catch {
      return [suite, ""] as const;
    }
  }),
);

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
      const suite = SUITES.get(entry.suite) ?? "";
      for (const phrase of entry.expect) {
        // The suite first: that is where a title or an assertion message lives,
        // and it is where all but a few of these are found.
        if (suite.includes(phrase)) continue;
        // Then anywhere — a phrase can be something the product prints, and
        // `SQLITE_CANTOPEN` is not in the suite that reads it.
        if (CORPUS.includes(phrase)) continue;
        // Last: a phrase that only exists once something has run.
        if (COMPOSED.some(({ pattern }) => pattern.test(phrase))) continue;
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
    // A shape is earned by a phrase that needs it: one that matches nothing, or
    // matches only phrases the tree contains anyway, is an exemption standing in
    // front of nothing and would go on excusing whatever grew into its shape.
    const needing = MANIFEST.flatMap((entry) =>
      entry.expect.filter((phrase) => {
        const suite = SUITES.get(entry.suite) ?? "";
        return !suite.includes(phrase) && !CORPUS.includes(phrase);
      }),
    );
    expect(
      COMPOSED.filter(({ pattern }) => !needing.some((phrase) => pattern.test(phrase))).map((s) => String(s.pattern)),
      "a shape is exempting nothing — no phrase in the manifest needs it",
    ).toEqual([]);
  });
});
