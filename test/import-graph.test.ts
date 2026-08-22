/**
 * The shape of this repository, as an assertion (T-021).
 *
 * Seven packages under `packages/<pkg>/src`, and the interesting thing about them is
 * what they *do not* do to each other. Four facts were established twice by
 * two methods that agreed — fe-codex's sweep and this file's own scan — and
 * they are worth holding because each one degrades silently:
 *
 * - **No cycles.** A cycle between modules is not a compile error in a bundler
 *   or in bun; it is a partially-initialised module at run time, and which half
 *   is missing depends on which file was imported first. That is a defect that
 *   moves when an unrelated import is added.
 * - **Cross-package imports land on a barrel.** `@agent-mesh/store` and
 *   `@agent-mesh/mailbox` are the two doors. A deep import reaches past
 *   whatever the barrel chose to export, so the package stops being able to
 *   move its own files.
 * - **Ten pairs, nine of them at run time.** The tenth is a test importing the
 *   schema its subject writes against, named below. A pair appearing here that
 *   is not in the table is a dependency somebody added without saying so.
 * - **One consumer from outside `packages/`.** `scripts/` and `test/` reach in
 *   through the barrel exactly once.
 *
 * ## The denominator, which is half of every number above
 *
 * Everything is measured over **every `.ts`/`.tsx` file under
 * `packages/<pkg>/src`, tests included** — 259 files and 391 resolved internal
 * edges at the commit this was pinned. Tests are in because a test that
 * imports across a boundary creates the same coupling as source does; it is
 * counted separately rather than excluded, which is why the fifth pair is
 * visible at all instead of hiding inside "no cross-package imports".
 *
 * `@agent-mesh/contracts` is **not** one of the seven. It is an external
 * dependency (`node_modules/@agent-mesh/contracts`, pinned to a tag of the
 * `agent-mesh-contracts` repository), so every package depending on it is the
 * intended shape and not a pair. Counting it would have made the table read
 * ten pairs and said nothing.
 *
 * Static and dynamic imports both count: `packages/http/src/*.test.ts` reaches
 * for `@agent-mesh/store` through `await import(...)`, which is the same edge
 * at run time and invisible to a scan that only reads the top of the file.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, normalize, relative, sep } from "node:path";

const ROOT = join(import.meta.dir, "..");

/**
 * The packages this repository builds, **read off the disk**.
 *
 * This was a hand-written list of six, and every measurement below was derived
 * from it: the file walk started there, and a cross-package edge was only
 * counted if both ends were in it. A seventh package was therefore invisible
 * -- its files unscanned, its edges filtered out -- and the denominator check
 * agreed, because it compared the packages found in `FILES` against the list
 * `FILES` was built from. `@agent-mesh/log` arrived in T-022 and nothing here
 * moved.
 *
 * Read from the filesystem, a new package shows up as a failure of the
 * expected-set assertion below -- one line to change, deliberately -- rather
 * than as silence.
 */
const PACKAGES = readdirSync(join(import.meta.dir, "..", "packages"))
  .filter((name) => existsSync(join(import.meta.dir, "..", "packages", name, "package.json")))
  .sort();
type Pkg = string;

function sources(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.tsx?$/.test(full) ? [full] : [];
  });
}

const FILES = PACKAGES.flatMap((p) => sources(join(ROOT, "packages", p, "src")));
const rel = (f: string) => relative(ROOT, f).split(sep).join("/");
const packageOf = (f: string) => rel(f).split("/")[1] as Pkg;
const isTest = (f: string) => /\.test\.tsx?$/.test(f);

/**
 * Every specifier a file imports from, however it is written.
 *
 * One expression for `import`, `import type`, a side-effect `import "x"`,
 * `export … from` and `await import("x")` — the last of which is how this
 * package's own tests reach a module, and an edge a top-of-file scan misses.
 */
const SPECIFIER =
  /(?:^[ \t]*import\s+(?:type\s+)?(?:[^'"();]*?\sfrom\s+)?|^[ \t]*export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s*(?:as\s+\w+\s*)?from\s+|\bimport\s*\(\s*)['"]([^'"]+)['"]/gm;

function specifiersOf(file: string): string[] {
  const out: string[] = [];
  for (const m of readFileSync(file, "utf8").matchAll(SPECIFIER)) out.push(m[1]!);
  return out;
}

/** A relative specifier's file, with the extensions bun would try. */
function resolveRelative(from: string, spec: string): string | null {
  const base = normalize(join(dirname(from), spec));
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

interface CrossEdge {
  from: string;
  fromPkg: Pkg;
  toPkg: Pkg;
  spec: string;
  test: boolean;
}

const internal = new Map<string, Set<string>>();
const cross: CrossEdge[] = [];

for (const file of FILES) {
  const targets = new Set<string>();
  for (const spec of specifiersOf(file)) {
    if (spec.startsWith("@agent-mesh/")) {
      const named = spec.split("/")[1] as Pkg;
      if (PACKAGES.includes(named) && named !== packageOf(file)) {
        cross.push({ from: rel(file), fromPkg: packageOf(file), toPkg: named, spec, test: isTest(file) });
      }
      continue;
    }
    if (!spec.startsWith(".")) continue;
    const target = resolveRelative(file, spec);
    if (!target) continue;
    targets.add(target);
    if (rel(target).startsWith("packages/") && packageOf(target) !== packageOf(file)) {
      cross.push({ from: rel(file), fromPkg: packageOf(file), toPkg: packageOf(target), spec, test: isTest(file) });
    }
  }
  internal.set(file, targets);
}

/** Every strongly connected component with more than one file in it. */
function cyclicComponents(): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const found: string[][] = [];
  let next = 0;

  const strong = (root: string): void => {
    const work: Array<{ node: string; edge: number }> = [{ node: root, edge: 0 }];
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const { node } = frame;
      if (frame.edge === 0) {
        index.set(node, next);
        low.set(node, next);
        next += 1;
        stack.push(node);
        onStack.add(node);
      }
      const targets = [...(internal.get(node) ?? [])].sort();
      let descended = false;
      while (frame.edge < targets.length) {
        const target = targets[frame.edge]!;
        frame.edge += 1;
        if (!index.has(target)) {
          work.push({ node: target, edge: 0 });
          descended = true;
          break;
        }
        if (onStack.has(target)) low.set(node, Math.min(low.get(node)!, index.get(target)!));
      }
      if (descended) continue;
      if (low.get(node) === index.get(node)) {
        const component: string[] = [];
        for (;;) {
          const w = stack.pop()!;
          onStack.delete(w);
          component.push(rel(w));
          if (w === node) break;
        }
        if (component.length > 1) found.push(component.sort());
      }
      work.pop();
      const parent = work[work.length - 1]?.node;
      if (parent !== undefined) low.set(parent, Math.min(low.get(parent)!, low.get(node)!));
    }
  };

  for (const file of FILES) if (!index.has(file)) strong(file);
  return found;
}

const pairKey = (e: CrossEdge) => `${e.fromPkg} -> ${e.toPkg}`;

describe("the repository's import graph", () => {
  /**
   * The denominator, asserted rather than described. A scan that stopped
   * finding files agrees with every claim below it, which is how a structural
   * check goes vacuous without failing.
   */
  test("scans every package's whole source tree", () => {
    // Stated, not derived. `FILES` comes from `PACKAGES`, so comparing the two
    // can only ever agree -- it agreed for the whole time `packages/log`
    // existed unscanned. This is the list a reader is asserting against.
    expect(PACKAGES).toEqual([
      "http",
      "hub",
      "log",
      "mailbox",
      "platform-web",
      "self-reminder",
      "store",
    ]);
    expect([...new Set(FILES.map(packageOf))].sort()).toEqual([...PACKAGES].sort());
    expect(FILES.length).toBeGreaterThan(200);
    expect(FILES.filter(isTest).length).toBeGreaterThan(60);
    expect([...internal.values()].reduce((n, s) => n + s.size, 0)).toBeGreaterThan(300);
  });

  /**
   * A cycle is not a compile error here — it is a module half-initialised at
   * run time, and which half depends on which file was loaded first.
   */
  test("has no import cycle anywhere in it", () => {
    expect(cyclicComponents()).toEqual([]);
  });

  test("has no file importing itself", () => {
    expect(FILES.filter((f) => internal.get(f)?.has(f)).map(rel)).toEqual([]);
  });

  /**
   * **The table, and it is the invariant.** Four pairs at run time; the fifth
   * is `receive.test.ts` reaching for the schema of the table its subject
   * writes to — the hub owns that DDL (SPEC § 3.1), so the test asserts
   * against the owner's definition rather than a second copy.
   */
  test("has exactly these package pairs, nine of them at run time", () => {
    const runtime = [...new Set(cross.filter((e) => !e.test).map(pairKey))].sort();
    const testOnly = [...new Set(cross.filter((e) => e.test).map(pairKey))].sort()
      .filter((p) => !runtime.includes(p));

    expect(runtime).toEqual([
      "http -> log",
      "http -> store",
      "hub -> log",
      "hub -> mailbox",
      "hub -> store",
      "mailbox -> log",
      "self-reminder -> log",
      "self-reminder -> store",
      "store -> log",
    ]);
    expect(testOnly).toEqual(["mailbox -> store"]);
    expect(new Set([...runtime, ...testOnly]).size).toBe(10);
  });

  test("names the one file the fifth pair rests on", () => {
    expect(cross.filter((e) => pairKey(e) === "mailbox -> store").map((e) => e.from))
      .toEqual(["packages/mailbox/src/receive.test.ts"]);
  });

  /**
   * A deep import reaches past whatever the barrel chose to export, which
   * takes away the importee's freedom to move its own files — and does it
   * silently, because both halves still compile.
   */
  test("every cross-package import lands on a barrel, and none goes deeper", () => {
    expect([...new Set(cross.map((e) => e.spec))].sort()).toEqual([
      "@agent-mesh/log",
      "@agent-mesh/mailbox",
      "@agent-mesh/store",
    ]);
    expect(cross.filter((e) => !e.spec.startsWith("@agent-mesh/")).map((e) => `${e.from} :: ${e.spec}`))
      .toEqual([]);
  });

  test("the two barrels are the files those specifiers name", () => {
    for (const barrel of [
      "packages/store/src/index.ts",
      "packages/mailbox/src/index.ts",
      "packages/log/src/index.ts",
    ]) {
      expect({ barrel, there: existsSync(join(ROOT, barrel)) }).toEqual({ barrel, there: true });
    }
  });

  /**
   * Everything outside `packages/` that reaches in — the ops scripts, through
   * the barrel. `test/` is not among them and is the reason the list stays
   * short: it drives the services as processes rather than importing them.
   *
   * Both entries are repairs an operator runs with the services stopped, and
   * both need the same thing from `@agent-mesh/store`: where the state
   * directory is and how to open a database in it. That is exactly what the
   * front door is for — the alternative is each script spelling the path and
   * the `busy_timeout` again, which is the drift this file exists to catch.
   */
  test("the consumers outside the packages use the front door", () => {
    const outside = ["scripts", "test", ".claude/hooks"]
      .flatMap((dir) => sources(join(ROOT, dir)))
      .flatMap((file) =>
        specifiersOf(file)
          .filter((spec) => spec.startsWith("@agent-mesh/"))
          .filter((spec) => PACKAGES.includes(spec.split("/")[1] as Pkg))
          .map((spec) => `${rel(file)} :: ${spec}`),
      )
      .sort();

    expect(outside).toEqual([
      "scripts/collect-orphan-blobs.ts :: @agent-mesh/store",
      "scripts/ghost-identity.ts :: @agent-mesh/store",
    ]);
  });

  /**
   * The architecture document names the packages, and it named four of them
   * for as long as there were seven. `mailbox`, `platform-web` and `log` each
   * arrived without the list moving — and a document naming four packages
   * reads exactly like a repository with four, so nobody reading it had any
   * way to notice.
   *
   * The list is read off the disk here already. Comparing it costs one
   * assertion and turns a silent drift into a failing test in the commit that
   * causes it.
   */
  test("the architecture document names every package there is", () => {
    const doc = readFileSync(join(ROOT, "docs", "architecture.md"), "utf8");
    const tree = /```\npackages\/\n([\s\S]*?)```/.exec(doc);
    expect(tree, "the package tree in docs/architecture.md moved or was renamed").not.toBeNull();

    const listed = [...tree![1]!.matchAll(/[├└]──\s+([a-z-]+)\//g)].map((m) => m[1]!).sort();
    expect(listed).toEqual([...PACKAGES].sort());
  });

  /**
   * A relative path that climbs out of its own package is the other way to
   * make a cross-package edge, and it would not be caught by reading
   * specifiers alone — `../../store/src/index` names no package.
   */
  test("no file reaches into another package by relative path", () => {
    const climbers = FILES.flatMap((file) =>
      specifiersOf(file)
        .filter((spec) => spec.startsWith("."))
        .map((spec) => ({ file, spec, target: resolveRelative(file, spec) }))
        .filter((e) => e.target !== null && packageOf(e.target!) !== packageOf(e.file))
        .map((e) => `${rel(e.file)} :: ${e.spec}`),
    );

    expect(climbers).toEqual([]);
  });
});
