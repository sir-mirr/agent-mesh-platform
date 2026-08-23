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
   *
   * **It is a floor on the parser, not on the table.** It was 20 against a
   * table of 24, and then six rows were retired by opening the code they
   * described — the audit poller, the two stream watermarks and the three SSE
   * keepalives, all of which were held for being inside a timer, which is a
   * reason about waiting rather than about the decision inside. Left at 20 it
   * would have read as a table that must not shrink, which is the opposite of
   * what this document is for: every row here is a line somebody could go and
   * cover, and the good ending for one is to leave.
   *
   * It moved five times, each time because the table shrank past it, and
   * chasing it down per commit is the wrong shape: a number that must be
   * lowered whenever the work goes well is not measuring the parser. So the
   * live check is against the document instead — every line that *looks* like a
   * row must have parsed into one, which catches a pattern that stopped
   * matching without caring how many rows there are. The floor stays only as
   * the case that check cannot see: a table with no rows at all, where nothing
   * looks like a row either.
   *
   * The floor is gone, and what replaced it is the sentence: under D-751 the
   * table was meant to empty, and it has — so *zero rows* is now the expected
   * state and no longer distinguishable from a parser that stopped matching by
   * counting alone. A person writes **The table is empty.** into the document;
   * a broken parser cannot. Both directions are held, because a document
   * claiming emptiness while rows sit under it is the same lie the other way
   * round.
   */
  test("the table is still a table", () => {
    // Every table line in the document, counted without the row parser: the
    // pipes, minus the header and its separator.
    const tableLines = text
      .split("\n")
      .filter((line) => line.startsWith("|"))
      .filter((line) => !line.startsWith("| File |") && !line.startsWith("|---"));

    expect(ROWS.length).toBe(tableLines.length);
    // **An empty table has to say so in words.** Zero rows is the ending this
    // document wants and also what a broken parser produces, and the two are
    // indistinguishable from a count. The sentence is written by a person; the
    // rows are not.
    if (ROWS.length === 0) {
      expect(
        text,
        "the table parsed as empty and the document does not say it is — which is what a parser that stopped matching looks like",
      ).toContain("**The table is empty.**");
      return;
    }
    expect(
      text.includes("**The table is empty.**"),
      "the document says the table is empty while rows are still in it",
    ).toBe(false);
    // A row that lost a cell parses into something, and it is not a row.
    expect(ROWS.filter((r) => !r.file || !r.anchor || !r.why)).toEqual([]);
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
