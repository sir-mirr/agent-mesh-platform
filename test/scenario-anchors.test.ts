/**
 * The reader that counts the scenario inventory, read back.
 *
 * **Its number goes into a report and nothing checked it.** `scenario-anchors`
 * is in no CI job, no `verify` step and no other script — so when its id
 * pattern read `SC-[A-Z0-9]+-\d+` and could not see `SC-USER-D4`, ten scenarios
 * were missing from the denominator, none were listed as unpinned, and the
 * `unparsed` tripwire stayed quiet because it counted headers with the same
 * expression that could not see them. A denominator and its own tripwire
 * derived from one pattern agree with each other whatever they miss.
 *
 * It was found by hand: `fe-codex` landed two scenarios and the total did not
 * move. That is not a check, that is somebody happening to look on the morning
 * the number was about to be quoted to the owner.
 *
 * These run the real script against fixture trees, because a reader is only
 * testable against a tree whose contents the test decides — hence `--root`.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { caughtInLog } from "../scripts/caught-in-log";

const SCRIPT = join(import.meta.dir, "..", "scripts", "scenario-anchors.ts");

/**
 * Fixture ids, interpolated rather than written into the fixture sources.
 *
 * A registration inside a string literal is still `it("[SC-…]")` on a line, and
 * the reader under test counts lines. Spelling them out here would make this
 * file eight registrations it never runs — which the reader reports, correctly,
 * as headers it could not read. Keeping the brackets empty of a literal id
 * leaves this file out of the inventory it is testing.
 */
const ID = {
  harness: "SC-HARNESS-01",
  auth: "SC-AUTH-01",
  userB5: "SC-USER-B5",
  userD4: "SC-USER-D4",
  apiAuth: "SC-API-AUTH-01",
  downAll: "SC-DOWN-ALL",
} as const;
const trees: string[] = [];
afterAll(() => {
  for (const dir of trees) rmSync(dir, { recursive: true, force: true });
});

/**
 * A tree holding the suites given, as `{ "name.test.ts": source }`.
 *
 * `SC-HARNESS-01` is added to every one of them because the reader's exemption
 * list names it, and an exemption that names no scenario is a stale exemption —
 * fatal, and correctly so. A fixture tree has to be a tree this reader accepts
 * for any *other* refusal to mean something.
 */
function treeWith(suites: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "scenario-anchors-"));
  trees.push(dir);
  mkdirSync(join(dir, "test"));
  writeFileSync(
    join(dir, "test", "harness.test.ts"),
    `it("[${ID.harness}] the harness handed over its addresses", async () => {});\n`,
  );
  for (const [name, source] of Object.entries(suites)) writeFileSync(join(dir, "test", name), source);
  return dir;
}

function read(root: string): { code: number; json: any; said: string } {
  const proc = Bun.spawnSync(["bun", SCRIPT, "--root", root, "--json"], { stdout: "pipe", stderr: "pipe" });
  const said = proc.stdout.toString() + proc.stderr.toString();
  let json: any = null;
  try {
    json = JSON.parse(proc.stdout.toString());
  } catch {
    /* left null — the assertion that wanted it will say so with `said` */
  }
  return { code: proc.exitCode ?? 1, json, said };
}

describe("counting the scenarios in a tree", () => {
  test("a letter in the number is still a number", () => {
    // The regression, as a fixture: `B5` and `D4` are ids this reader could not
    // see, beside one it always could.
    const { json, said } = read(
      treeWith({
        "one.test.ts": [
          `it("[${ID.userB5}] grants and revokes", async () => {});`,
          `it("[${ID.userD4}] settles the create action", async () => {});`,
          `it("[${ID.auth}] signs in", async () => {});`,
        ].join("\n"),
      }),
    );
    expect(json, `no JSON came back. it said: ${said}`).not.toBeNull();
    expect({ scenarios: json.scenarios, unparsed: json.unparsed }, "an id whose number carries a letter was not counted")
      .toEqual({ scenarios: 4, unparsed: [] });
  });

  test("both quote styles count, because one of them is how a route gets into a title", () => {
    // `SC-DOWN-ALL` is registered as a template literal — the route is
    // interpolated into the name — and it has no number in its last segment.
    // Two properties, each of which defeated a previous version of this reader.
    const { code, json, said } = read(
      treeWith({
        "two.test.ts": [
          `it("[${ID.apiAuth}] the API layer refuses without a session", async () => {});`,
          "it(`[" + ID.downAll + "] ${route} distinguishes disconnected from empty`, async () => {});",
        ].join("\n"),
      }),
    );
    expect(json, `no JSON came back. it said: ${said}`).not.toBeNull();
    expect(
      { scenarios: json.scenarios, unparsed: json.unparsed, code },
      "a three-segment id or a template-literal title went uncounted",
    ).toEqual({ scenarios: 3, unparsed: [], code: 0 });
  });

  test("a registration the two readings disagree about is reported, and the run fails", () => {
    // The title on its own line: the line-based reading sees a registration
    // with no id on it, the title-based one reads the id. Neither is wrong
    // about what it looked at, and the disagreement is the whole signal — a
    // denominator that shrinks quietly is what this reader exists to refuse.
    const { code, json, said } = read(
      treeWith({
        "three.test.ts": ["it(", `  "[${ID.auth}] signs in",`, "  async () => {},", ");"].join("\n"),
      }),
    );
    expect(json, `no JSON came back. it said: ${said}`).not.toBeNull();
    expect(
      { unparsed: json.unparsed.length, code },
      "the two readings disagreed and the run reported success",
    ).toEqual({ unparsed: 1, code: 1 });
    expect(json.unparsed[0]).toContain("read");
  });

  test("a tree it can read entirely comes back clean", () => {
    // The other half: if the exit code above were unconditional, every run
    // would fail and the check would be a constant.
    const { code, json } = read(treeWith({ "four.test.ts": `it("[${ID.auth}] signs in", async () => {});` }));
    expect({ code, unparsed: json?.unparsed, ambiguous: json?.ambiguous }, "a readable tree was reported as unreadable")
      .toEqual({ code: 0, unparsed: [], ambiguous: [] });
  });
});

describe("the inventory of this repository", () => {
  test("carries its tripwires beside its numbers", () => {
    // The JSON is what a machine reads. A summary that omits the tripwires
    // hands out a denominator with no way to ask whether it was complete —
    // which is the defect this file exists for, one layer up.
    const proc = Bun.spawnSync(["bun", SCRIPT, "--json"], { stdout: "pipe", stderr: "pipe" });
    const json = JSON.parse(proc.stdout.toString());
    expect(Object.keys(json).sort()).toEqual(
      ["ambiguous", "exempt", "observed", "pinned", "scenarios", "staleExemptions", "unparsed", "unpinned"],
    );
    expect(
      { unparsed: json.unparsed, ambiguous: json.ambiguous, stale: json.staleExemptions },
      "this repository's scenario inventory cannot be read completely",
    ).toEqual({ unparsed: [], ambiguous: [], stale: [] });
    expect(json.scenarios, "the inventory found no scenarios at all").toBeGreaterThan(150);
  });
});


/**
 * Turning *pinned* into *observed*.
 *
 * An entry pins a scenario the moment somebody writes it; whether the mutation
 * actually takes that scenario down is known only after a run. `--from-log`
 * is what carries one back, and until now it was the part of this reader that
 * nothing had read — a claim-versus-verdict tool with an unmeasured verdict.
 */
describe("what a mutation-check log records as caught", () => {
  test("takes the ticked entries and nothing else", () => {
    expect([...caughtInLog("✓ alpha\n✗ beta: not caught\n")]).toEqual(["alpha"]);
  });

  test("does not read the summary line, which names the misses too", () => {
    // A run ends by naming every id it was filtered to, caught and uncaught
    // alike. Reading ids from that line turns an entry that missed into an
    // observation that it did not.
    const log = [
      "✓ alpha",
      "✗ beta: not caught, or caught by the wrong check",
      "1/2 caught · 1 not caught — filtered to alpha, beta, of 1189 in the manifest",
      "",
    ].join("\n");
    expect([...caughtInLog(log)], "an entry that missed was counted as an observation").toEqual(["alpha"]);
  });

  test("reads a line the runner indented", () => {
    expect(caughtInLog("  ✓ alpha\n").has("alpha")).toBe(true);
  });

  test("says nothing about a log with no ticks in it", () => {
    expect([...caughtInLog("✗ beta: not caught\nverification failed\n")]).toEqual([]);
  });
});

describe("a night read out of its shards", () => {
  const logFile = (body: string) => {
    const dir = mkdtempSync(join(tmpdir(), "scenario-anchors-log-"));
    trees.push(dir);
    const path = join(dir, "shard.log");
    writeFileSync(path, body);
    return path;
  };

  test("counts every log it was given, not the first", () => {
    // The nightly is eight shards and a night is measured only once all eight
    // are read together. One shard answers for an eighth of the manifest.
    const first = logFile("✓ the-queue-screen-totals-the-wrong-column\n");
    const second = logFile("✓ a-refused-egress-toggle-keeps-the-new-cell\n");
    const one = Bun.spawnSync(["bun", SCRIPT, "--json", "--from-log", first], { stdout: "pipe", stderr: "pipe" });
    const both = Bun.spawnSync(["bun", SCRIPT, "--json", "--from-log", first, "--from-log", second], { stdout: "pipe", stderr: "pipe" });
    const observed = (proc: { stdout: Buffer }) => JSON.parse(proc.stdout.toString()).observed as number;
    expect(
      { one: observed(one), both: observed(both) },
      "a second shard's log added nothing, so a night would be read from an eighth of itself",
    ).toEqual({ one: 1, both: 2 });
  });
});
