/**
 * The lines `docs/decisions/what-the-coverage-number-leaves-out.md` says are
 * left uncovered, checked against the files they are left in.
 *
 * **A document naming code is a copy of that code, and copies rot.** This one
 * says a percentage stops where it does for reasons — a boot block, a
 * last-resort handler, a twenty-second timer — and each reason points at
 * something a reader can go and look at. A reason pointing at a line that has
 * since been deleted, renamed or covered is worse than no document: it reads as
 * a decision somebody made about the code that is there now.
 *
 * So every row's anchor has to still be in the file it names. That is what can
 * be checked cheaply and every run; what cannot is completeness — deciding
 * whether some *other* file has uncovered lines takes a coverage run, five
 * minutes and the browser suite. The document says so itself, in the section
 * this file deliberately does not try to enforce.
 *
 * The anchors are read out of the document rather than written here, so this
 * cannot agree with a version of the table that no longer exists.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DOC = "docs/decisions/what-the-coverage-number-leaves-out.md";
const text = readFileSync(join(ROOT, DOC), "utf8");

interface Row {
  file: string;
  anchor: string;
  why: string;
}

/**
 * The table rows, taken from the pipes.
 *
 * The header and its `---` separator are dropped by requiring the first cell
 * to be a backticked path — which also means a row that loses its formatting
 * disappears rather than arriving with a header for a filename, and the floor
 * below is what notices that.
 */
const ROWS: Row[] = text
  .split("\n")
  .filter((line) => line.startsWith("| `"))
  .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
  .filter((cells) => cells.length === 3)
  .map(([file, anchor, why]) => ({
    file: file!.replace(/^`|`$/g, ""),
    anchor: anchor!.replace(/^`|`$/g, ""),
    why: why!,
  }));

/** Tracked files, so a row cannot point at something only this working copy has. */
const TRACKED = new Set(
  Bun.spawnSync(["git", "-C", ROOT, "ls-files"]).stdout.toString().split("\n").filter(Boolean),
);

describe("what the coverage number leaves out", () => {
  /**
   * A parser that stopped matching agrees with everything, which is how a test
   * that reads its own subject goes quietly vacuous. The floor is well under
   * the current table and well over an empty one.
   */
  test("the table is still a table", () => {
    expect(ROWS.length).toBeGreaterThan(20);
    expect(new Set(ROWS.map((r) => r.file)).size).toBeGreaterThan(4);
  });

  test("every row names a tracked file", () => {
    expect(ROWS.filter((r) => !TRACKED.has(r.file)).map((r) => r.file)).toEqual([]);
  });

  /**
   * The anchor is the whole of the row's claim: the reason describes the lines
   * around it. Gone, and the reason describes nothing — which is the state this
   * file exists to fail on rather than to be discovered in a review.
   */
  test("every anchor is still in the file it names", () => {
    const missing = ROWS.filter((r) => !readFileSync(join(ROOT, r.file), "utf8").includes(r.anchor))
      .map((r) => `${r.file} :: ${r.anchor}`);
    expect(missing).toEqual([]);
  });

  test("every row says why, rather than only where", () => {
    // A blank reason is a row that survives every check above and tells the
    // next reader nothing, which is the failure this document was written
    // against — not an uncovered line, an unexplained one.
    expect(ROWS.filter((r) => r.why.length < 20).map((r) => r.file)).toEqual([]);
  });

  /**
   * `packages/http/src/ui/` is excluded from the denominator by the owner's
   * decision — a different thing from a line left uncovered inside it, and
   * `scripts/coverage.ts` prints the two separately. A row here for one of
   * those files would be a category error that reads as agreement.
   */
  test("no row claims a file the denominator already excludes", () => {
    expect(ROWS.filter((r) => r.file.startsWith("packages/http/src/ui/"))).toEqual([]);
  });
});
