/**
 * The hooks this repository documents are the hooks it registers.
 *
 * **Every test around the hooks spawns them.** `more-work-hook.test.ts` runs
 * the Stop hook as a process, `mailbox-hooks.test.ts` drives delivery end to
 * end — and all of it would go on passing with `settings.json` emptied. A hook
 * that is not registered is never run, and an unregistered mailbox hook is
 * indistinguishable from an empty inbox: the session goes quiet, the other
 * agent waits on an answer nobody read, and nothing anywhere goes red.
 *
 * That is the same silence the nightly has when its schedule stops firing, and
 * it is checked here the same way — against what the file actually says rather
 * than against the fact that the code behind it works.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SETTINGS = JSON.parse(readFileSync(join(ROOT, ".claude", "settings.json"), "utf8"));

/** Every command string in the settings, with the event it is registered on. */
const REGISTERED: Array<{ event: string; command: string }> = Object.entries(SETTINGS.hooks ?? {}).flatMap(
  ([event, groups]) =>
    (groups as Array<{ hooks?: Array<{ command?: string }> }>).flatMap((group) =>
      (group.hooks ?? []).map((hook) => ({ event, command: String(hook.command ?? "") })),
    ),
);

const eventsFor = (file: string) =>
  REGISTERED.filter((entry) => entry.command.includes(file)).map((entry) => entry.event).sort();

/**
 * What each file in `.claude/hooks/` is, and how it is reached.
 *
 * Every file has a row, so a hook arriving here is a decision somebody has to
 * write down rather than a file that quietly runs on nothing.
 */
const HOOKS: Record<string, { events: string[]; why: string; importedBy?: string }> = {
  "mailbox.ts": {
    events: ["Stop", "UserPromptSubmit"],
    why: "delivery: waiting mail before a turn starts, mail that landed during one after it ends",
  },
  "more-work.ts": {
    events: ["Stop"],
    why: "the question a turn has to answer before it may end",
  },
  "mailbox-watch.ts": {
    events: [],
    why: "armed with the Monitor tool for the length of a session, because neither hook event fires while nobody is typing — CLAUDE.md says so and this is the file that would contradict it",
  },
  "remaining-work.ts": {
    events: [],
    why: "the reading behind the Stop hook",
    importedBy: "more-work.ts",
  },
  "standing-order.ts": {
    events: [],
    why: "the sentence both mailbox components end on",
    importedBy: "mailbox.ts",
  },
};

describe("what settings.json registers", () => {
  test("registers something at all", () => {
    // The denominator. An empty hooks block would satisfy every "not
    // registered" row below and nothing else would notice.
    expect(REGISTERED.length, "settings.json registers no hooks at all").toBeGreaterThan(2);
  });

  test("runs each hook on exactly the events it is for", () => {
    const actual = Object.fromEntries(Object.keys(HOOKS).map((file) => [file, eventsFor(file)]));
    const wanted = Object.fromEntries(Object.entries(HOOKS).map(([file, row]) => [file, [...row.events].sort()]));
    expect(
      actual,
      "a hook is registered on events it is not for, or missing from the ones it is — an unregistered mailbox hook reads exactly like an empty inbox",
    ).toEqual(wanted);
  });

  test("registers nothing that is not there", () => {
    const missing = REGISTERED.filter((entry) => {
      const named = /\.claude\/hooks\/([\w-]+\.ts)/.exec(entry.command);
      return named ? !existsSync(join(ROOT, ".claude", "hooks", named[1]!)) : false;
    });
    expect(missing, "a registered command names a hook file that does not exist, so the event runs nothing")
      .toEqual([]);
  });

  test("accounts for every hook file in the directory", () => {
    const files = Bun.spawnSync(["git", "ls-files", ".claude/hooks"], { cwd: ROOT })
      .stdout.toString()
      .split("\n")
      .filter((path) => path.endsWith(".ts"))
      .map((path) => path.replace(".claude/hooks/", ""));
    expect(files.length, "no hook files were listed — every row above is about nothing").toBeGreaterThan(3);
    expect(
      files.filter((file) => !(file in HOOKS)),
      "a hook file arrived with no row saying what runs it, which is how one ends up running on nothing",
    ).toEqual([]);
  });

  test("the files that are not registered are reached the way their row says", () => {
    const wrong: string[] = [];
    for (const [file, row] of Object.entries(HOOKS)) {
      if (!row.importedBy) continue;
      const importer = readFileSync(join(ROOT, ".claude", "hooks", row.importedBy), "utf8");
      if (!importer.includes(file.replace(".ts", ""))) wrong.push(`${file} — ${row.importedBy} does not import it`);
    }
    expect(wrong, "a hook file is reached by nothing: not registered, and not imported by what its row names").toEqual([]);
  });
});
