/**
 * The mailbox does not know the hub exists (SPEC § 8.10, and
 * `docs/decisions/mailbox-and-hub.md`).
 *
 * **This is the whole claim of that design, and a convention cannot hold it.**
 * The arrangement it replaces had `rest/inbox.ts` importing hub presence, the
 * hub's database handle and three RPC handlers — reaching them by faking a
 * WebSocket so the handlers would accept the caller. Nothing about that was
 * accidental or hard to read; it was simply never forbidden, and each import
 * was reasonable on the day it was added.
 *
 * Two things follow from the boundary, and neither survives an import:
 *
 * - **Mail is accepted while the hub is down.** That window is the reason
 *   store-and-forward exists, and a mailbox sharing the hub's lifetime is a
 *   queue that vanishes exactly when it becomes necessary.
 * - **The hub is an optimisation.** It shortens the wait when both ends happen
 *   to be present. A dependency pointing the other way makes it a requirement
 *   for conversations with no realtime component at all.
 *
 * ## Why source text rather than a bundler
 *
 * A dependency graph would be more thorough and would need a build step to
 * answer a question the imports already answer in the clear. What goes wrong
 * here is somebody adding `import { onlineAgents } from "../presence"` because
 * it is right there — which this catches, in the file, at the line.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const MAILBOX = join(ROOT, "packages/mailbox/src");

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (entry.endsWith(".ts")) out.push(path);
  }
  return out;
}

/** Every module specifier a file imports, `import` and `require` alike. */
function importsOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  return [
    ...text.matchAll(/(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g),
  ].map((m) => m[1]!);
}

describe("the mailbox package", () => {
  test("imports nothing from the hub", () => {
    const offences: string[] = [];
    for (const file of sources(MAILBOX)) {
      for (const spec of importsOf(file)) {
        // A relative path is only an offence if it climbs out of the package;
        // `../store/...` is a sibling and allowed, `@agent-mesh/hub` never is.
        const escapes = spec.startsWith(".") && !resolve(join(file, ".."), spec).startsWith(MAILBOX);
        const named = spec.includes("agent-mesh/hub") || /(^|\/)hub(\/|$)/.test(spec);
        if (named || (escapes && !resolve(join(file, ".."), spec).includes("/packages/store/"))) {
          offences.push(`${relative(ROOT, file)} → ${spec}`);
        }
      }
    }
    expect(
      offences,
      `the mailbox must not know the hub exists:\n${offences.join("\n")}`,
    ).toEqual([]);
  });

  test("there is something to check", () => {
    // The empty-set failure this repository keeps meeting: with no sources
    // found, the test above passes for a package that does not exist.
    const found = sources(MAILBOX);
    expect(found, "no mailbox sources were found").not.toEqual([]);
    expect(found.some((f) => f.endsWith("index.ts")), "no entry point").toBe(true);
  });

  test("the check can still say no", () => {
    // And the matcher-cannot-fail failure, which this repository has met twice.
    // A hub import is constructed here rather than waiting for one to appear.
    const wouldOffend = "../../hub/src/presence";
    expect(/(^|\/)hub(\/|$)/.test(wouldOffend), "the detector accepts a hub import").toBe(true);
  });
});
