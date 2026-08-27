/**
 * The night's logs reach the reader that turns *pinned* into *observed*.
 *
 * `scenario-anchors.ts` keeps a claim and a verdict apart: an entry pins a
 * scenario when somebody writes it, and whether the mutation takes that
 * scenario down is known only after a run. The nightly is where those runs
 * happen, and until the `observed` job existed nothing carried their answer
 * back — so the pinned count had never been confronted with an observation.
 *
 * The wiring that carries it is three names agreeing across two jobs: the file
 * the shard writes, the artifact it is kept in, and the pattern the summary
 * downloads. Any two of them can be renamed without the third noticing, and
 * the failure is silent in the direction that matters — the summary reads no
 * logs, or the wrong ones, and reports a number rather than an absence.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WORKFLOW = readFileSync(join(import.meta.dir, "..", ".github", "workflows", "ci.yml"), "utf8");
const CI = (Bun as unknown as { YAML: { parse(text: string): any } }).YAML.parse(WORKFLOW);

const stepsOf = (job: string): any[] => CI.jobs[job].steps;
const named = (job: string, name: string) => stepsOf(job).find((step) => step.name === name);

describe("the nightly keeps what it measured", () => {
  test("has both jobs, and the summary waits for the shards", () => {
    // The denominator: every claim below is about these two jobs existing.
    expect(Object.keys(CI.jobs), "the nightly's jobs are not the ones this checks").toContain("mutation");
    expect(Object.keys(CI.jobs)).toContain("observed");
    expect(CI.jobs.observed.needs, "the summary no longer waits for the shards it reads").toBe("mutation");
    // `always()`: a red shard still measured seven eighths of its entries, and
    // a summary that runs only after a clean night is a summary that never
    // runs on the nights worth reading.
    expect(String(CI.jobs.observed.if), "the summary is skipped when a shard fails, which is when its reading matters most")
      .toContain("always()");
  });

  test("writes the shard log under the name the artifact keeps", () => {
    // `${{ matrix.shard }}` holds spaces, so the two names are compared with
    // every workflow expression collapsed to the same mark — the fixed part is
    // the half a rename breaks.
    const settled = (text: string) => text.replace(/\$\{\{.*?\}\}/g, "<expr>");
    const run = settled(String(named("mutation", "Mutation check").run));
    const kept = named("mutation", "Keep the log");
    const written = /tee\s+(\S+)/.exec(run)?.[1] ?? "";
    expect(written, "the shard no longer writes its output to a file at all").not.toBe("");
    expect(settled(String(kept.with.path)), `the shard writes ${written} and the artifact keeps ${kept?.with?.path}`)
      .toBe(written);
    expect(String(kept.if), "a red shard's log is thrown away, and that is the log worth keeping").toContain("always()");
  });

  test("downloads the artifacts it uploaded", () => {
    const uploadName = String(named("mutation", "Keep the log").with.name);
    const download = stepsOf("observed").find((step) => String(step.uses ?? "").startsWith("actions/download-artifact"));
    const pattern = String(download.with.pattern);
    // `mutation-log-${{ matrix.shard }}` against `mutation-log-*`: compare the
    // fixed part, which is the half a rename breaks.
    const prefix = pattern.replace(/\*+$/, "");
    expect(uploadName.startsWith(prefix), `the artifact is named ${uploadName} and the summary looks for ${pattern}`).toBe(true);
  });

  test("reads every log it downloaded into the inventory", () => {
    const summary = String(named("observed", "What the night observed").run);
    expect(summary, "the summary stopped feeding the logs to the reader that observes them").toContain("--from-log");
    expect(summary, "the summary no longer runs the scenario inventory").toContain("scenario-anchors.ts");
    // A loop, not one log: the manifest is split eight ways and one shard's
    // reading looks exactly like a whole night's.
    expect(summary, "only one shard's log reaches the reader, so a night is read from an eighth of itself")
      .toMatch(/for\s+\w+\s+in\s+\$logs/);
    // The absence case. Nothing downloaded and no complaint is a summary about
    // nothing, printed as a number.
    expect(summary, "a run that kept no logs would report a reading of nothing").toContain("exit 1");
  });
});
