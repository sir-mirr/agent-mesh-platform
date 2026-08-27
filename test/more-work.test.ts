/**
 * The hook that keeps a turn from ending while work is left.
 *
 * It fires on `Stop`, reads what is open, and blocks the turn with the list.
 * Every way it can fail is quiet: a heading convention it stops matching, a
 * section boundary it reads past, a root it reads from the wrong tree. None of
 * those make anything red — the hook simply says nothing, the turn ends, and
 * the work waits for somebody to notice it is waiting.
 *
 * **A hook that goes quiet is indistinguishable from a repository with nothing
 * to do**, which is the whole reason to measure it here rather than trust it.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { $ } from "bun";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mainWorktree, remainingWork } from "../.claude/hooks/remaining-work";

/** A tree with the two documents this hook reads, and no git remote. */
function tree(deferred: string, proposals = ""): string {
  const root = mkdtempSync(join(tmpdir(), "more-work-"));
  mkdirSync(join(root, "docs", "proposals"), { recursive: true });
  writeFileSync(join(root, "docs", "deferred.md"), deferred);
  writeFileSync(join(root, "docs", "proposals", "README.md"), proposals);
  return root;
}

describe("what counts as work left", () => {
  test("an entry nobody has looked at is asked about", async () => {
    const said = await remainingWork(tree("### the poller repeats a row\n\nSome detail.\n"));
    expect(said).toContain("the poller repeats a row");
  });

  test("a struck-through entry is closed and stays closed", async () => {
    // The convention `docs/deferred.md` already uses, read rather than
    // reinvented: `### ~~…~~` is done.
    const said = await remainingWork(tree("### ~~the poller repeats a row~~\n\nClosed.\n"));
    expect(said).toBeNull();
  });

  test("an entry with a stated reason is a decision, not a backlog item", async () => {
    const said = await remainingWork(
      tree("### the poller repeats a row\n\n**Why deferred:** it needs a contract change.\n"),
    );
    expect(said).toBeNull();
  });

  test("only the bullets under Still undecided are asked about", async () => {
    // **The section boundary is the test.** Reading past it turns every
    // settled proposal into an open question, and a hook that speaks on every
    // turn stops being read — the failure this one exists to prevent.
    const said = await remainingWork(
      tree(""),
      );
    expect(said).toBeNull();
    const withIndex = await remainingWork(
      tree(
        "",
        [
          "### Still undecided",
          "- **who owns the egress table** and when",
          "",
          "### Settled",
          "- **the audit schema version** decided in D-700",
          "",
        ].join("\n"),
      ),
    );
    expect(withIndex).toContain("who owns the egress table");
    expect(withIndex).not.toContain("the audit schema version");
  });

  test("a tree with nothing open says nothing at all", async () => {
    // Silence is the hook's normal state, and it has to be reachable — a hook
    // that always speaks is one nobody reads by the third turn.
    expect(await remainingWork(tree("", ""))).toBeNull();
  });

  test("the documents come from the root it was given", async () => {
    // The defect this found: `read` closed over the module's own root while
    // the parameter moved only the git count, so a caller got one worktree's
    // commits beside another's open items.
    const elsewhere = tree("### an item only this tree has\n");
    expect(await remainingWork(elsewhere)).toContain("an item only this tree has");
  });
});

describe("which tree it reads", () => {
  test("a directory that is not a repository answers with itself", async () => {
    // No worktree list to read, and inventing a sibling path would be a second
    // place recording where `main` lives.
    const root = mkdtempSync(join(tmpdir(), "not-a-repo-"));
    expect(await mainWorktree(root)).toBe(root);
  });

  test("a repository with no worktree on main answers with itself too", async () => {
    const root = mkdtempSync(join(tmpdir(), "no-main-"));
    await $`git -C ${root} init -q -b side`.quiet();
    expect(await mainWorktree(root)).toBe(root);
  });

  test("documents that are not there are not work left", async () => {
    // An empty read, not a crash: a tree without these files is a tree with
    // nothing to say, and the hook must stay silent rather than throw inside a
    // `Stop` handler.
    const bare = mkdtempSync(join(tmpdir(), "bare-"));
    expect(await remainingWork(bare)).toBeNull();
  });

  test("commits the remote has not seen are the first thing asked about", async () => {
    const root = mkdtempSync(join(tmpdir(), "unpushed-"));
    await $`git -C ${root} init -q -b main`.quiet();
    await $`git -C ${root} config user.email probe@example.com`.quiet();
    await $`git -C ${root} config user.name probe`.quiet();
    await Bun.write(join(root, "a.txt"), "one\n");
    await $`git -C ${root} add -A`.quiet();
    await $`git -C ${root} commit -qm one`.quiet();
    const base = (await $`git -C ${root} rev-parse HEAD`.quiet().text()).trim();
    await $`git -C ${root} update-ref refs/remotes/origin/main ${base}`.quiet();
    await Bun.write(join(root, "b.txt"), "two\n");
    await $`git -C ${root} add -A`.quiet();
    await $`git -C ${root} commit -qm two`.quiet();

    const said = await remainingWork(root);
    expect(said).toContain("1 commit(s) not on `origin/main`");
  }, 20_000);
});


/**
 * The two documents the question is asked of, in this repository.
 *
 * Every case above hands the reader a fixture, so all of them pass while the
 * real documents say nothing the parsers can see. That is not hypothetical:
 * `docs/proposals/README.md` lost its **Still undecided** section when D-753
 * closed the last open item, and `undecided()` keys on that heading — so the
 * hook's second question had been answering *nothing undecided* by reading a
 * section that was not there, and would have gone on doing it if the section
 * came back under another name. The document's own opening paragraph still
 * pointed at it.
 *
 * A parser and its subject in two files is the same shape as verify and CI, or
 * the manifest and the tree: each is individually right, and nothing compares
 * them.
 */
describe("the documents this repository actually keeps", () => {
  const read = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8");

  test("the deferred list still has entries in the form the reader looks for", () => {
    const deferred = read("docs/deferred.md");
    const headings = deferred.split("\n").filter((line) => line.startsWith("### "));
    expect(headings.length, "docs/deferred.md holds no ### entries, so the reader has nothing to read")
      .toBeGreaterThan(0);
  });

  test("the proposal index still has the section the reader keys on", () => {
    const index = read("docs/proposals/README.md");
    expect(
      index,
      "the section undecided() reads is gone from docs/proposals/README.md, so the hook reports nothing undecided whatever the file says",
    ).toContain("### Still undecided");
  });

  test("an empty section says so in words", () => {
    // A section that is gone and a section with nothing in it are the same
    // silence to a parser, and only one of them is a claim somebody made.
    const index = read("docs/proposals/README.md");
    const start = index.indexOf("### Still undecided");
    const rest = index.slice(start + 1);
    const end = rest.indexOf("\n### ");
    const section = end === -1 ? rest : rest.slice(0, end);
    const bullets = section.split("\n").filter((line) => line.startsWith("- **"));
    if (bullets.length === 0) {
      expect(
        section,
        "the undecided section is empty and does not say it is — which is what a heading nobody maintains looks like",
      ).toContain("Nothing in this set is undecided");
    } else {
      expect(section, "the section lists items and claims emptiness at the same time")
        .not.toContain("Nothing in this set is undecided");
    }
  });
});
