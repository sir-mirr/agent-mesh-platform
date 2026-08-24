/**
 * The predicate that decides whether every other verdict is believed.
 *
 * `mutation-check.ts` is the only evidence that any guard in this repository
 * guards anything, and `readVerdict` is the sentence in it that turns a test
 * run into a verdict. It had no test of its own, and it has now been wrong
 * twice in opposite directions:
 *
 * ```
 * once   a run where the mesh never came up was read as a finding about a guard
 * later  a one-test suite whose guard objected was read as no run at all
 * ```
 *
 * Both mistakes came from the same reading — `0 pass` — which means *nothing
 * ran* and *everything failed* and cannot say which. That is the ambiguity this
 * whole script exists to hunt, and it was living inside the hunter.
 *
 * The fixtures below are bun's real output shapes, kept verbatim rather than
 * paraphrased: the predicate reads text, so a test that invents the text tests
 * a format nothing produces.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { captureRun, condenseRun, markFor, readVerdict, summarise, verdictsAgree } from "../scripts/mutation-verdict";

const EXPECT = ["a socket that dropped the frame"];

/**
 * **Two entries answered to one name and the run said `2/2 caught`.**
 *
 * `bun scripts/mutation-check.ts <id>` filters by id, and a name typed twice
 * makes that filter select two mutations — the summary counts them both and
 * reads as a clean result for the entry somebody meant to run. Caught only
 * because the count was two and the work was one; a duplicate on a bigger
 * filter would not show at all.
 *
 * The same shape is already written down one level up: two scenarios sharing an
 * `SC-` id made `-t "SC-WRITE-07"` run two tests, and the guard that was
 * supposed to stop it compared titles instead of ids.
 */
/**
 * **Every entry still points at exactly one place.**
 *
 * An entry whose `from` is no longer in its file checks nothing, and one that
 * matches twice is worse: `String.replace` takes the first, so the mutation
 * lands somewhere the entry did not name and the verdict is about a line
 * nobody chose. The tool says so when somebody runs that entry — and a full
 * pass is one suite per entry, hours, so nobody does.
 *
 * It drifted under a morning of edits: fourteen of two hundred and thirty-one
 * had stopped pointing at anything, twelve of them because moving strings into
 * the dictionary and refactoring the bell took the lines they were anchored on.
 * Running entries by filter, which is the only affordable way, never touches
 * the rest.
 *
 * So the check belongs where every edit passes: here, in a second, off the
 * manifest the tool already owns rather than a parser of its syntax.
 */
describe("the manifest's anchors", () => {
  test("every entry names exactly one place", async () => {
    const proc = Bun.spawn(["bun", "scripts/mutation-check.ts", "--anchors"], {
      cwd: new URL("..", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
    const code = await proc.exited;
    // The tool prints `N/M anchors …`. A run that printed nothing decided
    // nothing — the failure this file exists to name, one level up.
    const counted = out.match(/(\d+)\/(\d+) anchors point at exactly one place/);
    expect(
      { printed: counted !== null, everyOne: counted ? counted[1] === counted[2] : false },
      `--anchors did not report, or some entry no longer names one place:\n${out}`,
    ).toEqual({ printed: true, everyOne: true });
    expect(code, "--anchors exited non-zero").toBe(0);
  }, 60_000);
});

/**
 * **A killed run must not leave the mutation behind.**
 *
 * The tool plants an edit, runs a suite, and restores with `git checkout --`.
 * Everything between those two is a window where the tree is deliberately
 * wrong, and nothing closed that window when the process was killed: a
 * ten-minute wrapper timeout sent `SIGTERM` mid-entry and `I18nContext.tsx`
 * kept a Korean string in its English dictionary. The tree lock's own handler
 * ran — the marker was released — so from outside the run looked tidy.
 *
 * What that costs is the whole point of the script. The next `git add -A`
 * stages the mutation, and a commit turns it into a guard nobody will ever see
 * fail: a check disabled by the tool that exists to prove checks work.
 */
describe("a run that is killed while a mutation is planted", () => {
  test("puts the file back before it goes", async () => {
    const root = new URL("..", import.meta.url).pathname;
    const status = async (...paths: string[]) => {
      const p = Bun.spawn(["git", "status", "--porcelain", ...paths], {
        cwd: root, stdout: "pipe", stderr: "pipe",
      });
      return (await new Response(p.stdout).text()).trim();
    };

    // **Asked before the spawn, because the tool refuses a tree with edits.**
    // That is the state a developer running this file is usually in and never
    // the state CI runs it in, and waiting thirty seconds to discover it is
    // waiting for a refusal that was already visible.
    if (await status()) {
      console.error("[killed-run restore] inconclusive: the working tree has edits, so nothing was planted to restore");
      // The shape CI measures below is read out of the source instead, so a
      // handler deleted while somebody had edits open is still caught.
      const script = readFileSync(join(import.meta.dir, "..", "scripts", "mutation-check.ts"), "utf8");
      expect(
        {
          restoresOnSignal: /for \(const sig of \["SIGINT", "SIGTERM", "SIGHUP"\] as const\) \{\n\s+process\.on\(sig, \(\) => \{\n\s+unplant\(\);/.test(script),
          restoresOnExit: /process\.on\("exit", unplant\);/.test(script),
        },
        "a killed run would leave its mutation in the tree",
      ).toEqual({ restoresOnSignal: true, restoresOnExit: true });
      return;
    }

    // A cheap entry: its suite is a few static reads, so the window is short
    // and this test is not waiting on a browser.
    const proc = Bun.spawn(["bun", "scripts/mutation-check.ts", "the-alarm-assumes-its-label-exists"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const dirty = async () => {
      const p = Bun.spawn(["git", "status", "--porcelain", ".github/workflows/ci.yml"], {
        cwd: root, stdout: "pipe", stderr: "pipe",
      });
      return (await new Response(p.stdout).text()).trim();
    };

    // Wait for the plant, then kill it there. A test that killed before the
    // edit landed would pass on a tool that never restores anything.
    let planted = "";
    const deadline = Date.now() + 30_000;
    while (!planted && Date.now() < deadline) {
      planted = await dirty();
      if (!planted) await Bun.sleep(20);
    }
    const said = () => new Response(proc.stderr).text();
    expect(planted, `the mutation never landed on a clean tree:\n${planted ? "" : (await said()).slice(0, 400)}`)
      .not.toBe("");

    proc.kill("SIGTERM");
    await proc.exited;
    // The handler restores; give the spawn it runs a moment to finish.
    const cleanBy = Date.now() + 10_000;
    let left = await dirty();
    while (left && Date.now() < cleanBy) {
      await Bun.sleep(50);
      left = await dirty();
    }

    expect(left, "the run was killed and left its mutation in the tree").toBe("");
  }, 60_000);
});

describe("the manifest's own names", () => {
  test("no id answers to two entries", async () => {
    const source = await Bun.file(new URL("../scripts/mutation-check.ts", import.meta.url)).text();
    const ids = [...source.matchAll(/^\s{4}id: "([^"]+)",$/gm)].map((m) => m[1]!);
    // A read that found nothing would make the comparison below vacuously true,
    // which is the failure this file exists to name.
    expect(ids.length, "no manifest ids were parsed — the entry shape changed").toBeGreaterThan(100);
    const seen = new Set<string>();
    const twice = ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
    expect(twice, "an id is used by more than one manifest entry, so filtering by it runs both").toEqual([]);
  });
});

describe("reading a run", () => {
  test("a guard that objected is caught", () => {
    const output = "(fail) a socket that dropped the frame\n\n 12 pass\n 1 fail\n";
    expect(readVerdict(output, EXPECT, 1)).toEqual({ kind: "caught" });
  });

  test("a guard that stayed quiet is not caught", () => {
    // The mutation applied and every test still passed: the guard does not
    // guard. This is the verdict the whole script exists to produce.
    const output = " 13 pass\n 0 fail\n";
    expect(readVerdict(output, EXPECT, 0)).toEqual({ kind: "not-caught" });
  });

  /**
   * **A failure message can quote something shaped like a summary.** Bun prints
   * its counts at the end and everything above them is the run's own output, so
   * reading the *first* `N pass` reads whatever the test happened to print.
   *
   * Observed, not imagined: `exiting-zero-is-reported-as-a-result` mutates a
   * broadcast into the words `0 pass / 0 fail`, the assertion failure quotes it
   * back, and a correctly caught mutation was reported as *nothing ran* — this
   * script producing a wrong verdict about its own blindness, which is the
   * failure it exists to hunt arriving one level up.
   */
  test("reads the summary at the end, not a summary the run quoted", () => {
    const output = [
      "(fail) a socket that dropped the frame",
      'Received: "[측정 종료] 0 pass / 0 fail · exit 0"',
      "",
      " 5 pass",
      " 1 fail",
      "",
    ].join("\n");
    expect(readVerdict(output, EXPECT, 1)).toEqual({ kind: "caught" });
  });

  test("a one-test suite whose only test failed is still a verdict", () => {
    // **The regression.** `message-status.test.ts` holds one test, so a caught
    // mutation reports `0 pass / 1 fail` — indistinguishable by count from a
    // file that never ran, and it was read as the latter.
    const output = "(fail) a socket that dropped the frame\n\n 0 pass\n 1 fail\n";
    expect(readVerdict(output, EXPECT, 1)).toEqual({ kind: "caught" });
  });
});

describe("refusing to read a run that did not happen", () => {
  test("a dead hook is inconclusive, whatever the summary says", () => {
    // The original case: the mesh never came up, so no test executed and the
    // guard was never reached. The summary still shows a failure.
    const output = "error: a beforeEach/afterEach hook timed out\n\n 0 pass\n 1 fail\n";
    const v = readVerdict(output, EXPECT, 1);
    expect(v.kind).toBe("inconclusive");
    expect(v).toHaveProperty("why", "a hook died, so the guard was never reached");
  });

  test("a hook that dies while tests also pass is still inconclusive", () => {
    // Ordering matters: the hook check runs first. A file where some tests ran
    // and a hook then died has a partial result, and a partial result is not a
    // verdict about this guard.
    const output = "error: a beforeAll hook failed\n\n 4 pass\n 2 fail\n";
    expect(readVerdict(output, EXPECT, 1).kind).toBe("inconclusive");
  });

  test("no tests at all is inconclusive", () => {
    const output = " 0 pass\n 0 fail\n";
    const v = readVerdict(output, EXPECT, 1);
    expect(v.kind).toBe("inconclusive");
    expect(v).toHaveProperty("why", "nothing ran");
  });

  test("nothing passed and no expected message is inconclusive, not a finding", () => {
    // Here a silent guard and a broken suite are genuinely indistinguishable,
    // so neither verdict is available. Calling it `not-caught` would be a claim
    // about a guard from a run that may never have reached it — the exact
    // mistake this function was extracted to stop.
    const output = "(fail) something else entirely\n\n 0 pass\n 1 fail\n";
    const v = readVerdict(output, EXPECT, 1);
    expect(v.kind).toBe("inconclusive");
    expect(v).toHaveProperty("why", "nothing passed and the expected message is absent");
  });
});

describe("what an exit code alone cannot decide", () => {
  test("a failing run without the expected message is not caught", () => {
    // The mutation broke *something*, and not the guard named in the manifest.
    // Tests passed, so the run happened; the guard did not object.
    const output = "(fail) an unrelated assertion\n\n 11 pass\n 1 fail\n";
    expect(readVerdict(output, EXPECT, 1)).toEqual({ kind: "not-caught" });
  });

  test("the expected message with a zero exit is not caught", () => {
    // The string appearing in a passing run is a name in a log line, not an
    // objection. Both halves are required.
    const output = "ok: a socket that dropped the frame\n\n 12 pass\n 0 fail\n";
    expect(readVerdict(output, EXPECT, 0)).toEqual({ kind: "not-caught" });
  });
});

/**
 * The predicate that decides whether repeated runs of one mutation are saying
 * the same thing.
 *
 * It exists because a non-deterministic entry reads as `caught` on most runs, so
 * the manifest reports the difference as a defect in whatever else changed that
 * day — the false finding this whole script exists to prevent, one level up.
 */
describe("verdictsAgree", () => {
  test("runs that all caught agree", () => {
    expect(verdictsAgree(["caught", "caught", "caught"])).toBe(true);
  });

  test("runs that all missed agree — a guard can be absent consistently", () => {
    expect(verdictsAgree(["not-caught", "not-caught"])).toBe(true);
  });

  test("caught once and missed once is a flap, not a catch", () => {
    // The shape `wal-reminder-fold` had: caught on the run that added it, three
    // passes on the next. Believing the first is how it survived.
    expect(verdictsAgree(["caught", "not-caught", "not-caught"])).toBe(false);
  });

  test("an inconclusive run among caught ones is a flap too", () => {
    // Not folded into `caught`: a run that decided nothing is not evidence that
    // the other runs decided rightly.
    expect(verdictsAgree(["caught", "inconclusive"])).toBe(false);
  });

  test("a single run agrees with itself, which is what --repeat 1 claims", () => {
    expect(verdictsAgree(["caught"])).toBe(true);
    expect(verdictsAgree([])).toBe(true);
  });
});

/**
 * The line a run prints, with the failures kept apart.
 *
 * `✗` carried three different facts, and agent-mesh-local-pm read one of them
 * as the wrong one — `✗ signed-rate-limit` was the tool refusing to measure
 * because the tree had changed under it, not a guard that missed something.
 * They said so: **one line with two meanings.** The script already knew the
 * difference and the screen threw it away.
 *
 * Only `not-caught` is a statement about the code. Folding the rest into it is
 * how a tooling problem gets written down as a defect — which is the failure
 * this script exists to prevent, in the script's own output.
 */
describe("summarise", () => {
  test("a clean run says only what it caught", () => {
    expect(summarise([], 78)).toBe("78/78 caught");
  });

  test("a miss is named as a miss", () => {
    expect(summarise(["not-caught"], 78)).toBe("77/78 caught · 1 not caught");
  });

  test("a run that decided nothing is not a miss", () => {
    // The distinction the mark exists for: nothing here says the guard failed.
    expect(summarise(["inconclusive"], 78)).toBe("77/78 caught · 1 not measured");
    expect(summarise(["no-match"], 78)).toBe("77/78 caught · 1 not measured");
    expect(summarise(["flapped"], 78)).toBe("77/78 caught · 1 not measured");
  });

  test("both kinds appear when both happened", () => {
    expect(summarise(["not-caught", "flapped", "inconclusive"], 78)).toBe(
      "75/78 caught · 1 not caught · 2 not measured",
    );
  });

  test("the mark separates whose problem it is", () => {
    // The code's, the manifest's, the tool's.
    expect(markFor("not-caught")).toBe("✗");
    expect(markFor("no-match")).toBe("!");
    expect(markFor("inconclusive")).toBe("?");
    expect(markFor("flapped")).toBe("?");
  });
});

/**
 * **The capture is part of the predicate.** `readVerdict` reads a string, and
 * for most of this script's life that string was whatever `$\`bun test …\`
 * .quiet()` handed back — about a megabyte, however much the child printed,
 * with the rest dropped and nothing said about it.
 *
 * `the-bell-moves-inside-the-trail` is what that costs. Its assertion was
 * `expect(node).toBe(null)` on a jsdom node, which serialises to the node's
 * whole graph; with the defect planted the suite printed 248 MB, and bun prints
 * the `(fail) suite > title` line an entry names in `expect` *after* the dump.
 * The line was produced, the capture threw it away, the summary at the very end
 * survived, and the verdict read *exit 1, a summary, no expected string* — a
 * guard that objected correctly, written down as one that did not. Caught when
 * run alone; missed in a batch of 112.
 *
 * Measured against the same suite, the three ways out differ:
 *
 * ```
 * $`…`.quiet()   787 KB back    no (fail) marker survived
 * a pipe         787 KB back    no (fail) marker survived
 * a file         248 MB back    every marker, and the title
 * ```
 *
 * So the run goes to a file, and what is dropped is dropped here instead —
 * deliberately, with the elision saying which of the strings the verdict turns
 * on were in the part that went.
 */
describe("condensing a run", () => {
  const stream = (...parts: string[]): AsyncIterable<Uint8Array> => ({
    async *[Symbol.asyncIterator]() {
      const encoder = new TextEncoder();
      for (const part of parts) yield encoder.encode(part);
    },
  });

  test("a run small enough to hold is held whole", async () => {
    const output = "(fail) a socket that dropped the frame\n\n 0 pass\n 1 fail\n";
    const captured = await condenseRun(stream(output), EXPECT, 1024);
    expect(captured.text).toBe(output);
    expect(captured.named).toBe(1);
  });

  test("a long run keeps both ends and says how much went", async () => {
    const captured = await condenseRun(stream("HEAD", "x".repeat(5000), "TAIL"), EXPECT, 64);
    expect(captured.text.startsWith("HEAD")).toBe(true);
    expect(captured.text.endsWith("TAIL")).toBe(true);
    expect(captured.text).toContain("characters not shown");
    // Everything is accounted for: what was kept plus what the note claims to
    // have dropped is what arrived.
    const dropped = Number(/… (\d+) characters/.exec(captured.text)![1]);
    expect(dropped + 64 * 2).toBe(5008);
  });

  test("an expected string in the part that went is still there to be read", async () => {
    // The bell, in miniature: the title bun printed after a dump nothing kept.
    const captured = await condenseRun(
      stream("x".repeat(4000), "(fail) a socket that dropped the frame\n", "y".repeat(4000), "\n 0 pass\n 1 fail\n"),
      EXPECT,
      64,
    );
    expect(readVerdict(captured.text, EXPECT, 1, captured.named)).toEqual({ kind: "caught" });
  });

  test("a string arriving in two pieces is one string", async () => {
    // A stream hands over whatever the read returned, and the string the whole
    // verdict rests on can be split anywhere in it.
    const captured = await condenseRun(
      stream("z".repeat(4000), "(fail) a socket that dro", "pped the frame", "z".repeat(4000), "\n 0 pass\n 1 fail\n"),
      EXPECT,
      64,
    );
    expect(readVerdict(captured.text, EXPECT, 1, captured.named)).toEqual({ kind: "caught" });
  });

  test("a hook the run only quoted is not a hook that died", async () => {
    // What bun echoes of a failing test's source, prefixed with its line
    // number. It is the test's text, not the run's, and reading it as the
    // run's is how this file broke its own verdict.
    const output = [
      "(fail) a socket that dropped the frame",
      '  437 |       stream("q".repeat(4000), "error: a beforeEach hook timed out\\n"),',
      "",
      " 0 pass",
      " 1 fail",
      "",
    ].join("\n");
    expect(readVerdict(output, EXPECT, 1, 1)).toEqual({ kind: "caught" });
  });

  test("a quoted hook does not turn a miss into an excuse", () => {
    // **The direction that still rests on this.** Once a dead hook is
    // attributed to the test it belongs to, a *quoted* one is harmless when the
    // guard objected — the failure is not hook-attributed either way. It is
    // when the guard stayed quiet that reading the quote matters: the run is a
    // finding about the guard, and reporting it as `a hook died` files the
    // manifest's own fixtures as a reason not to look.
    const output = [
      "(fail) something else entirely",
      '  437 |       stream("q".repeat(4000), "error: a beforeEach hook timed out\\n"),',
      "",
      " 3 pass",
      " 1 fail",
      "",
    ].join("\n");
    expect(readVerdict(output, EXPECT, 1, 1)).toEqual({ kind: "not-caught" });
  });

  test("a hook that died in the part that went still stops the verdict", async () => {
    // Not the entry's string, but one the verdict turns on all the same: a
    // suite whose hook died never reached the guard, whatever else it printed.
    // bun names no test for it, which is why the hook is read before the count
    // of names — otherwise every dead hook reads as a cut-off run.
    const captured = await condenseRun(
      stream("q".repeat(4000), "error: a beforeEach hook timed out\n", "q".repeat(4000), "\n 0 pass\n 1 fail\n"),
      EXPECT,
      64,
    );
    const verdict = readVerdict(captured.text, EXPECT, 1, captured.named);
    expect(verdict).toHaveProperty("why", "a hook died, so the guard was never reached");
  });

  test("the summary at the end survives, because it is what says anything ran", async () => {
    const captured = await condenseRun(stream("w".repeat(9000), "\n 3 pass\n 0 fail\n"), EXPECT, 64);
    expect(readVerdict(captured.text, EXPECT, 0, captured.named)).toEqual({ kind: "not-caught" });
  });

  test("failures named in the part that went are still counted", async () => {
    // Counted over the stream rather than over what survives, or this
    // function's own shortening would look like a run that was cut off.
    const captured = await condenseRun(
      stream("m".repeat(4000), "(fail) one\n(fail) two\n", "m".repeat(4000), "\n 0 pass\n 2 fail\n"),
      EXPECT,
      64,
    );
    expect(captured.named).toBe(2);
    expect(readVerdict(captured.text, EXPECT, 1, captured.named).kind).toBe("inconclusive");
  });

  test("a marker near a chunk boundary is counted once, not once per read", async () => {
    // Two ways to sit on a boundary, and only the second one can double: a
    // marker *split* by the boundary is stitched back together and counted
    // once whatever the arithmetic, while a marker lying wholly inside the
    // carried-over window is offered to the next read a second time.
    const split = await condenseRun(stream("(fa", "il) a socket that dropped the frame\n 0 pass\n 1 fail\n"), EXPECT, 1024);
    const carried = await condenseRun(stream("(fail) one\n", "(fail) two\n 0 pass\n 2 fail\n"), EXPECT, 1024);
    expect({ split: split.named, carried: carried.named }).toEqual({ split: 1, carried: 2 });
  });
});

/**
 * **A summary without the failures it counts is a run that stopped talking.**
 *
 * The size that drowns a run depends on what it printed, so nothing here
 * measures one. bun prints one `(fail)` marker per failing test and a count at
 * the end; fewer markers than the count is the run saying it did not finish.
 */
describe("a hook that died beside the guard, not under it", () => {
  /**
   * **A suite is not one test.** `the-poller-anchor-stands-still` planted
   * cleanly, the guard it names objected — 145 pass, 4 fail, its title on a
   * `(fail)` line — and a different test's `beforeEach` timed out in the same
   * run. Reading the hook first threw that verdict away and called the entry
   * unmeasured, on every run it could ever have.
   */
  const HOOK = "  ^ a beforeEach/afterEach hook timed out for this test.";

  test("a guard that objected is caught, whatever died elsewhere", () => {
    const output = [
      "(fail) what a reconnecting audit stream replays > (unnamed) [5032.93ms]",
      HOOK,
      "(fail) a socket that dropped the frame",
      "",
      " 145 pass",
      " 2 fail",
      "",
    ].join("\n");
    expect(readVerdict(output, EXPECT, 1, 2)).toEqual({ kind: "caught" });
  });

  test("a run where only hooks failed decided nothing", () => {
    const output = ["(fail) some suite > (unnamed) [5000.00ms]", HOOK, "", " 0 pass", " 1 fail", ""].join("\n");
    const verdict = readVerdict(output, EXPECT, 1, 1);
    expect(verdict).toHaveProperty("why", "a hook died, so the guard was never reached");
  });

  test("the guard's own dead hook is not the guard objecting", () => {
    // The title prints on the `(fail)` line either way, so a title-shaped
    // expectation would read a suite that never reached the assertion as a
    // guard that caught the defect.
    const output = [
      "(fail) a socket that dropped the frame [5001.00ms]",
      HOOK,
      "(fail) something else entirely",
      "",
      " 3 pass",
      " 2 fail",
      "",
    ].join("\n");
    const verdict = readVerdict(output, EXPECT, 1, 2);
    expect(verdict).toHaveProperty("why", "a hook died, so the guard was never reached");
  });
});

describe("a run whose output was cut short", () => {
  test("fewer failures named than counted decides nothing", () => {
    const output = "(fail) one\n\n 0 pass\n 2 fail\n";
    const verdict = readVerdict(output, EXPECT, 1, 1);
    expect(verdict.kind).toBe("inconclusive");
    expect(verdict).toHaveProperty("why", "the run's output was cut short — 2 failed, 1 named");
  });

  test("a guard that objected is still caught when the run finished", () => {
    const output = "(fail) a socket that dropped the frame\n\n 12 pass\n 1 fail\n";
    expect(readVerdict(output, EXPECT, 1, 1)).toEqual({ kind: "caught" });
  });

  test("more markers than failures is not a cut-off run", () => {
    // bun repeats names in its own summary block, and a dump can quote the
    // marker. Only the missing direction says anything.
    const output = "(fail) a socket that dropped the frame\n(fail) a socket that dropped the frame\n\n 0 pass\n 1 fail\n";
    expect(readVerdict(output, EXPECT, 1, 2)).toEqual({ kind: "caught" });
  });
});

/**
 * The capture, end to end, against a real child.
 *
 * **What is guarded here and what is not.** The spawn, the file, the stream and
 * the signals are all exercised below on a run that prints far more than the
 * capture keeps. The *choice* of a file over a pipe is not: measured on the
 * suite that produced this bug, a pipe and a file agreed at 3 MB and at 8 MB
 * and disagreed at 248 MB, and 248 MB of dump is not worth spending on every
 * run of this file. The reasoning for the choice is written down in
 * `captureRun`; this says only that the path taken works.
 */
describe("capturing a run that prints more than it keeps", () => {
  test("a failure named after the flood is still readable", async () => {
    const suite = join(tmpdir(), `mutation-capture-${process.pid}.test.ts`);
    // Named for the string the verdict looks for, because the line bun prints
    // it in — `(fail) suite > title` — is the one that used to be lost.
    await Bun.write(
      suite,
      [
        'import { expect, test } from "bun:test";',
        "",
        'test("a socket that dropped the frame", () => {',
        '  console.error("x".repeat(1_500_000));',
        "  expect(1).toBe(2);",
        "});",
        "",
      ].join("\n"),
    );
    try {
      const run = await captureRun(["bun", "test", suite], EXPECT, { ...process.env });
      expect({
        decided: readVerdict(run.output, EXPECT, run.exitCode, run.named).kind,
        named: run.named,
        held: run.output.length < 1_500_000,
      }).toEqual({ decided: "caught", named: 1, held: true });
    } finally {
      await rm(suite, { force: true });
    }
  }, 30_000);
});
