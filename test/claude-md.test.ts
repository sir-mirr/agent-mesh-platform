/**
 * Every file and command `CLAUDE.md` sends an agent to still exists.
 *
 * **This document is the one thing every session reads before anything else.**
 * It names the mailbox hooks, the gate, the nightly, the three commands a
 * change has to pass, and where the reasoning for each of them was written
 * down. A pointer in it that has gone stale does not fail anywhere: the agent
 * follows it, finds nothing, and either guesses or asks — and the guess is what
 * the document exists to prevent.
 *
 * The same shape as the proposal index pointing at a section that had been
 * deleted, and the coverage document naming lines that had moved: a document
 * that names code is a copy of that code, and copies rot.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const CLAUDE = await Bun.file(join(ROOT, "CLAUDE.md")).text();
const SCRIPTS: Record<string, string> = JSON.parse(await Bun.file(join(ROOT, "package.json")).text()).scripts ?? {};

/** Every tracked path, and every basename, as git sees them. */
const TRACKED = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: ROOT }).stdout.toString().split("\0").filter(Boolean);
const BASENAMES = new Set(TRACKED.map((path) => path.split("/").pop()!));

const backticked = (pattern: RegExp) => [...new Set([...CLAUDE.matchAll(pattern)].map((m) => m[1]!))];

describe("what CLAUDE.md points at", () => {
  test("names paths, commands and files at all", () => {
    // Four denominators, because each list below is compared to nothing when
    // its pattern stops matching — and a document that names nothing passes
    // every check about what it names.
    expect(backticked(/`([\w./-]+\/[\w./-]+\.(?:md|ts|json))`/g).length, "no paths were read out of CLAUDE.md")
      .toBeGreaterThan(5);
    expect(backticked(/bun run ([\w:-]+)/g).length, "no `bun run` commands were read out of CLAUDE.md")
      .toBeGreaterThan(1);
    // One today — `mailbox-watch.ts`, the file CLAUDE.md discusses by name
    // because a person refers to it that way. The claim is that the pattern
    // still reads something, not that the document keeps a quota.
    expect(backticked(/`([\w-]+\.ts)`/g).length, "no bare filenames were read out of CLAUDE.md").toBeGreaterThan(0);
    expect(TRACKED.length, "git listed nothing, so every existence check below is vacuous").toBeGreaterThan(100);
  });

  test("every path it names is a file this repository has", () => {
    const named = backticked(/`([\w./-]+\/[\w./-]+\.(?:md|ts|json))`/g);
    expect(
      named.filter((path) => !existsSync(join(ROOT, path))),
      "CLAUDE.md sends a session to these and they are not there",
    ).toEqual([]);
  });

  test("every bare filename it names exists somewhere", () => {
    // `mailbox-watch.ts` is discussed by name rather than by path, which is how
    // a person refers to it — so the claim is that a file by that name exists,
    // not that it sits at the repository root.
    const named = backticked(/`([\w-]+\.ts)`/g);
    expect(named.filter((file) => !BASENAMES.has(file)), "CLAUDE.md discusses files this repository does not have")
      .toEqual([]);
  });

  test("every command it tells a session to run is one package.json defines", () => {
    const named = backticked(/bun run ([\w:-]+)/g);
    expect(
      named.filter((script) => !(script in SCRIPTS)),
      "CLAUDE.md tells a session to run these and package.json has no such script",
    ).toEqual([]);
  });

  test("every directory it names is a directory", () => {
    const named = backticked(/`([\w./-]+\/)`/g);
    expect(named.length, "no directories were read out of CLAUDE.md").toBeGreaterThan(1);
    expect(
      named.filter((dir) => !existsSync(join(ROOT, dir))),
      "CLAUDE.md points at these directories and they are not there",
    ).toEqual([]);
  });
});
