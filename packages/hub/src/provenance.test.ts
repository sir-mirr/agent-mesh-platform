/**
 * What this process says about which checkout it is (SPEC § 7).
 *
 * The value is read once at import and every answer but one needs a repository
 * that is not this one: a tarball with no `.git`, a detached head, a `git` that
 * will not spawn. Those are the answers worth checking — a hub that reports its
 * commit correctly is a hub nobody has to think about, and the two multi-message
 * investigations this file exists to prevent both started from an instance that
 * could not say what it was running.
 *
 * So the runner is a parameter. Nothing here breaks the checkout it runs in.
 */
import { describe, expect, test } from "bun:test";

import { PROVENANCE, readProvenance, type GitResult, type GitRunner } from "./provenance";

const ok = (out: string): GitResult => ({ success: true, stdout: new TextEncoder().encode(out) });
const failed: GitResult = { success: false, stdout: new Uint8Array() };

/** A `git` that answers by subcommand, and remembers everything it was asked. */
function stubGit(answers: Record<string, GitResult>): { run: GitRunner; asked: string[][] } {
  const asked: string[][] = [];
  return {
    asked,
    run: (argv) => {
      asked.push(argv);
      // `git -C <root>` is the first three; the question is the rest.
      return answers[argv.slice(3).join(" ")] ?? failed;
    },
  };
}

describe("what a checkout says it is", () => {
  test("the commit, the branch, and whether the bytes match it", () => {
    const git = stubGit({
      "rev-parse HEAD": ok("6f1d3c2aa11e4b7c9d0e5f8a2b3c4d5e6f708192\n"),
      "rev-parse --abbrev-ref HEAD": ok("main\n"),
      "status --porcelain": ok(""),
    });

    expect(readProvenance(git.run)).toEqual({
      commit: "6f1d3c2aa11e4b7c9d0e5f8a2b3c4d5e6f708192",
      branch: "main",
      dirty: false,
    });
  });

  /**
   * **Uncommitted work makes the commit a claim about the wrong bytes.** An
   * instance running a dirty tree answers with a commit that does not describe
   * what it is serving, which is the failure this whole file exists to catch —
   * so the flag is the part that must not go missing.
   */
  test("a tree with uncommitted work says so", () => {
    const git = stubGit({
      "rev-parse HEAD": ok("6f1d3c2"),
      "rev-parse --abbrev-ref HEAD": ok("fe-admin-requirements"),
      "status --porcelain": ok(" M packages/hub/src/main.ts\n?? scratch.ts\n"),
    });

    expect(readProvenance(git.run).dirty).toBe(true);
  });

  /**
   * It asks about the directory this file is in, not the one somebody started
   * the process from. Without `-C` a hub launched from a home directory reports
   * whatever checkout happens to be there — or nothing, which reads identically
   * to a tarball.
   */
  test("it asks about its own checkout, not the working directory", () => {
    const git = stubGit({ "rev-parse HEAD": ok("6f1d3c2") });
    readProvenance(git.run);

    expect(git.asked.length).toBeGreaterThan(0);
    for (const argv of git.asked) {
      expect(argv[0]).toBe("git");
      expect(argv[1]).toBe("-C");
      // An absolute path, and the repository root rather than this package.
      expect(argv[2]!.startsWith("/")).toBe(true);
      expect(argv[2]!.endsWith("/packages/hub")).toBe(false);
    }
  });
});

describe("what it says when it cannot tell", () => {
  /**
   * A deployment from a tarball is legitimate and has no `.git`. `unknown` is
   * the honest answer, and it is still more than the nothing this replaced: an
   * instance saying `unknown` is telling you it cannot be identified, which is
   * itself the answer to "which commit is this".
   */
  test("no commit is unknown, not a failure", () => {
    const git = stubGit({});

    expect(readProvenance(git.run)).toEqual({ commit: "unknown", branch: "unknown", dirty: false });
    // And it stopped asking. The other two questions cannot have answers.
    expect(git.asked).toHaveLength(1);
  });

  /**
   * The `git` that will not spawn at all — no binary on the PATH, a process
   * table with no room. Reported the same way as a tarball, because from here
   * the two are the same fact: this instance cannot be identified.
   */
  test("a git that throws is caught, not carried up", () => {
    const run: GitRunner = () => { throw new Error("spawn git ENOENT"); };

    expect(() => readProvenance(run)).not.toThrow();
    expect(readProvenance(run)).toEqual({ commit: "unknown", branch: "unknown", dirty: false });
  });

  /** A commit with no branch name still identifies the bytes. */
  test("a commit whose branch cannot be named is still a commit", () => {
    const git = stubGit({ "rev-parse HEAD": ok("6f1d3c2"), "status --porcelain": ok("") });

    expect(readProvenance(git.run)).toEqual({ commit: "6f1d3c2", branch: "detached", dirty: false });
  });
});

/**
 * The exported constant is what every caller actually reads — `PROVENANCE` is
 * embedded in the mailbox route's `platform`. Read at import, so this asserts
 * the shape rather than the value: the machine running the suite may be a
 * checkout or may not.
 */
test("the value read at import is one of the two shapes", () => {
  expect(Object.keys(PROVENANCE).sort()).toEqual(["branch", "commit", "dirty"]);
  expect(typeof PROVENANCE.dirty).toBe("boolean");
  if (PROVENANCE.commit === "unknown") {
    expect(PROVENANCE.branch).toBe("unknown");
  } else {
    expect(PROVENANCE.commit).toMatch(/^[0-9a-f]{7,40}$/);
    expect(PROVENANCE.branch.length).toBeGreaterThan(0);
  }
});
