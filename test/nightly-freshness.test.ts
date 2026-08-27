/**
 * The nightly's silence has two meanings, and this is what separates them.
 *
 * `gh issue list --label nightly-mutation` is empty on a quiet night and empty
 * on a night the schedule never fired. The second is the one worth catching:
 * every anchor in the manifest is measured by that job and by nothing else, so
 * a nightly that stopped running takes 1181 guards with it and reports the same
 * empty list it reports when they all held.
 */

import { describe, expect, test } from "bun:test";
import { GH_QUERY, MAX_AGE_HOURS, ask, bunSpawn, readFreshness, report, say, type ScheduledRun, type Spawn } from "../scripts/nightly-freshness";

const NOW = new Date("2026-08-27T15:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

const run = (over: Partial<ScheduledRun> = {}): ScheduledRun => ({
  createdAt: hoursAgo(2),
  conclusion: "success",
  databaseId: 1,
  headSha: "abcdef1234567890",
  ...over,
});

describe("what the last scheduled run says", () => {
  test("a green run from tonight is the answer the issue list implies", () => {
    expect(readFreshness([run()], NOW)).toEqual({ kind: "green", ran: hoursAgo(2) });
  });

  test("a run still going has not said anything yet", () => {
    const verdict = readFreshness([run({ conclusion: null })], NOW);
    expect(verdict.kind).toBe("running");
    // Zero: a nightly that is halfway through is not a nightly that failed,
    // and a reader who runs this at 17:30 should not be sent to shard issues
    // that do not exist yet.
    const said = say(verdict);
    expect({ code: said.code, line: said.line }, "a run still in flight was reported as a problem")
      .toEqual({ code: 0, line: `nightly: started ${hoursAgo(2)} and has not concluded` });
  });

  test("a red run is red whether or not it managed to file an issue", () => {
    const verdict = readFreshness([run({ conclusion: "failure" })], NOW);
    expect(verdict.kind, "a nightly that concluded failure was read as a quiet night").toBe("red");
    expect(say(verdict).code).toBe(1);
  });

  test("a run old enough to be about a different week is not evidence about tonight", () => {
    // 50 hours against a daily cron: two nights missed. The limit sits close to
    // the schedule on purpose — one an order of magnitude above it would hold
    // while the nightly had been gone for a fortnight.
    const verdict = readFreshness([run({ createdAt: hoursAgo(50) })], NOW);
    expect(verdict.kind, `a run ${50 - MAX_AGE_HOURS} hours past the limit was accepted as current`).toBe("stale");
    expect(verdict).toHaveProperty("why", expect.stringContaining("50 hours ago"));
    expect(say(verdict).code, "a stale nightly exited zero, which is what a green one does").toBe(1);
  });

  test("no scheduled run at all is the loudest case, not the quietest", () => {
    const verdict = readFreshness([], NOW);
    expect(verdict.kind).toBe("stale");
    expect(verdict).toHaveProperty("why", expect.stringContaining("never fired"));
  });

  test("reads the newest run, whatever order they arrive in", () => {
    // `gh run list` answers newest-first today. A verdict that depends on that
    // is a verdict about the tool: handed the same two runs oldest-first, this
    // one used to report the stale one.
    const oldestFirst = [run({ createdAt: hoursAgo(50), databaseId: 1 }), run({ createdAt: hoursAgo(2), databaseId: 2 })];
    expect(readFreshness(oldestFirst, NOW), "the older of two runs decided the verdict")
      .toEqual({ kind: "green", ran: hoursAgo(2) });
  });

  test("says something a reader can act on, with an exit code that agrees", () => {
    const green = say(readFreshness([run()], NOW));
    const stale = say(readFreshness([], NOW));
    expect({ green: green.code, stale: stale.code }, "the exit code and the line disagree about the same run")
      .toEqual({ green: 0, stale: 1 });
    expect(green.line).toContain("every shard passed");
  });
});

describe("asking, and what comes back", () => {
  const answering = (over: Partial<{ exitCode: number; stdout: string; stderr: string }>): Spawn =>
    () => ({ exitCode: 0, stdout: "[]", stderr: "", ...over });

  test("asks about scheduled runs of this repository's workflow", () => {
    let asked: string[] = [];
    const spy: Spawn = (command) => {
      asked = command;
      return { exitCode: 0, stdout: JSON.stringify([run()]), stderr: "" };
    };
    expect(ask(spy, NOW).code).toBe(0);
    // The question decides the answer: dropping --event would count every push
    // as a nightly, and the freshest run would always be the last commit.
    expect(asked, "the question stopped naming scheduled runs of ci.yml").toEqual(GH_QUERY);
    expect(GH_QUERY.join(" ")).toContain("--event schedule");
  });

  test("a gh that could not answer is neither green nor red", () => {
    // Two, deliberately. Zero would make "I could not look" identical to "I
    // looked and it was fine"; one would send the reader to shard issues for a
    // shard that never ran.
    const said = ask(answering({ exitCode: 1, stdout: "", stderr: "gh: not logged in" }), NOW);
    expect({ code: said.code, named: said.line.includes("not logged in") }, `the line was: ${said.line}`)
      .toEqual({ code: 2, named: true });
  });

  test("a gh that answered nothing at all is the same case", () => {
    expect(ask(answering({ exitCode: 0, stdout: "   " }), NOW).code, "an empty answer was parsed as no runs and reported as a verdict")
      .toBe(2);
  });

  test("an answer that is not a run list is not read as one", () => {
    const said = ask(answering({ stdout: "<html>rate limited</html>" }), NOW);
    expect(said.code, "html was parsed into a verdict about the nightly").toBe(2);
  });

  test("reports the line and the code together", () => {
    const written: string[] = [];
    const code = report({ line: "nightly: something", code: 2 }, (l) => written.push(l));
    expect({ code, written }, "the reader was handed a code without the line that explains it")
      .toEqual({ code: 2, written: ["nightly: something"] });
  });

  test("the real spawn returns what the command actually printed", () => {
    // The adapter between this file and the outside. Untested it is four lines
    // nobody has run, sitting between a tested reader and the only caller.
    const said = bunSpawn(["echo", "ok"]);
    expect({ code: said.exitCode, out: said.stdout.trim() }).toEqual({ code: 0, out: "ok" });
  });
});
