/**
 * The arrangement that makes the mutation manifest something CI actually runs.
 *
 * **It was in front of every push and could not have passed.** `check` carried
 * `bun run mutation-check` — the whole manifest, one suite per entry, seventy-two
 * of them the browser suite — inside a ten-minute job. Fifteen consecutive red
 * runs hid it: something above it failed first every time, so the step never
 * reached the timeout that would have said so. The first green integration run
 * in weeks is what finally showed the shape.
 *
 * So the pass moved to a clock and split into shards, and what stays in front
 * of a push is the part that fits: the anchors, which read every entry against
 * the tree in a second and catch the failure this repository keeps producing —
 * a refactor that leaves an entry pointing at text that is gone, which plants
 * nothing and reads as *the guard did not catch it*.
 *
 * Checked here because the split has a quiet failure of its own: shard counts
 * that disagree. Eight jobs each asking for `k/4` runs half the manifest twice
 * and the other half never, and every job is green.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ci = readFileSync(join(import.meta.dir, "..", ".github", "workflows", "ci.yml"), "utf8");

describe("what CI does with the mutation manifest", () => {
  test("every push reads the anchors, and none of them plants the whole manifest", () => {
    const beforeJobs = ci.slice(0, ci.indexOf("\n  coverage-floor:"));

    expect(
      { anchors: /mutation-check -- --anchors/.test(beforeJobs) },
      "nothing checks the anchors before a merge, so an entry pointing at deleted text passes as a caught mutation",
    ).toEqual({ anchors: true });
    expect(
      beforeJobs.includes("run: bun run mutation-check\n"),
      "the full manifest is back in front of a push, where it cannot finish",
    ).toBe(false);
  });

  test("the sharded pass runs on a clock, and asks for as many shards as it has jobs", () => {
    const matrix = /shard: \[([0-9, ]+)\]/.exec(ci);
    const asked = /--shard \$\{\{ matrix\.shard \}\}\/(\d+)/.exec(ci);

    expect({ scheduled: /^\s+schedule:$/m.test(ci), matrix: matrix !== null, asked: asked !== null }).toEqual({
      scheduled: true,
      matrix: true,
      asked: true,
    });

    const jobs = matrix![1]!.split(",").map((n) => Number(n.trim()));
    expect(
      { jobs: jobs.length, denominator: Number(asked![1]) },
      "the shard count and the number of jobs disagree — some entries run twice and some never run, all green",
    ).toEqual({ jobs: jobs.length, denominator: jobs.length });
    // 1..n, each once: a matrix missing `3` is a shard nothing runs.
    expect(jobs, "the shards are not 1..n exactly once").toEqual(jobs.map((_, i) => i + 1));
  });

  /**
   * **A nightly nobody reads is not a check**, which was the condition attached
   * to moving the pass off the push path. Two halves and both have to be there:
   * a red shard has to leave something durable, and somebody has to be told
   * where it lands. The second half is a line in `CLAUDE.md`, which every
   * session reads — and a label that stops matching on either side is a report
   * filed where nobody looks.
   */
  test("a red shard files a labelled issue, and the label is one somebody is told to read", () => {
    const claude = readFileSync(join(import.meta.dir, "..", "CLAUDE.md"), "utf8");
    const filed = /--label (\S+)/.exec(ci.slice(ci.indexOf("if: failure()")));
    const told = /gh issue list --label (\S+)/.exec(claude);

    expect({ files: filed !== null, tells: told !== null }, "a red nightly goes nowhere, or nobody is told where").toEqual({
      files: true,
      tells: true,
    });
    expect(
      { filed: filed![1], told: told![1] },
      "the workflow files under one label and the instructions read another",
    ).toEqual({ filed: told![1], told: told![1] });
  });

  /**
   * **The alarm may not depend on somebody having created the label.**
   *
   * The first red nightly filed nothing. Every shard reached the step and every
   * shard died on `could not add label: 'nightly-mutation' not found` — a label
   * that had never existed in this repository, named by a workflow, in a step
   * nothing had ever run. The test above passes on that state: it compares the
   * name in `ci.yml` against the name in `CLAUDE.md`, and both agreed about a
   * label neither of them could see was missing.
   *
   * A name matching a name is not the property. The property is that a red
   * shard leaves an issue, so the step ensures the label itself and files
   * without it if that still fails. Whether the issue is labelled is a
   * convenience; whether it exists is the check.
   */
  /**
   * **Scope, which is the half a name check cannot see.**
   *
   * The label existed and the step still filed nothing: this repository's
   * default workflow permission is `read`, and the job asked for no more, so
   * `gh issue create` had no scope to create with. Two red nightlies in a row
   * reported a failure nobody could find, for two different reasons, and both
   * looked identical from outside — a quiet night.
   */
  test("the job that files the issue is allowed to open one", () => {
    const job = ci.slice(ci.indexOf("\n  mutation:"));
    const permissions = /permissions:\s*\n\s+contents: read\s*\n\s+issues: write/.test(job);

    expect(
      { asksForIssueScope: permissions },
      "the nightly's alarm runs with a read-only token, so a red shard files nothing",
    ).toEqual({ asksForIssueScope: true });
  });

  test("a red shard files its issue even when the label is not there", () => {
    const step = ci.slice(ci.indexOf("if: failure()"));
    const ensures = /gh label create (\S+)/.exec(step);
    // The fallback is the second `gh issue create` — the one reached by `||`,
    // carrying no `--label`.
    const creates = [...step.matchAll(/gh issue create[^\n]*/g)].map((m) => m[0]);
    const unlabelled = creates.filter((c) => !c.includes("--label"));

    expect(
      { ensuresLabel: ensures?.[1], filesAnyway: unlabelled.length },
      "the step needs a label somebody created by hand, so the night it goes red it files nothing",
    ).toEqual({ ensuresLabel: "nightly-mutation", filesAnyway: 1 });
  });
});
