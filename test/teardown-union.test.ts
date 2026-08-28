/**
 * One fact, declared in two places that cannot see each other.
 *
 * `teardown` answers one of three things — `soft-deleted`, `already-deleted`,
 * `not-found` — and teardown is irreversible, so which one it was is the most
 * expensive thing on that screen to get wrong.
 *
 * **This used to be three places.** The store declared the union, the route
 * passed it through, and the console kept a third copy because
 * `@agent-mesh/store` opens `bun:sqlite` and a browser bundle must not take its
 * type graph. That copy carried a comment saying it was temporary "until
 * teardown is published from the contracts package". `v0.32.0` published it and
 * `v0.32.1` corrected the route named above it, so the console imports and the
 * comparison is down to two: the store's declaration, and the contract every
 * other implementation reads.
 *
 * Two is the floor, not zero. The store's copy cannot be deleted in favour of
 * the contract — that is the `bun:sqlite` problem in the other direction, since
 * `packages/store` is where the transaction lives and it must not depend on the
 * wire package to name its own result. So one fact still lives twice, and one
 * of the two can still gain a fourth member alone.
 *
 * **Compared as strings, not as types.** TypeScript erases before anything
 * runs, so a runtime check has nothing to compare; and `verbatimModuleSyntax`
 * will happily compile two unions that have drifted apart, because neither
 * module imports the other. Reading the source is the only way one of these can
 * catch the other.
 *
 * **Both sides must yield something.** A guard that passes when it found no
 * declaration is the failure it exists to prevent — `SC-SCR07-04` sat green for
 * weeks answering a route that did not exist, and this file would sit green the
 * day somebody renames the type.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const STORE = join(ROOT, "packages/store/src/teardown.ts");
const CONSOLE = join(ROOT, "packages/platform-web/src/api/agents.ts");
const ROUTE = join(ROOT, "packages/http/src/main.ts");
/**
 * The installed contract, not a checked-out one.
 *
 * Reading `node_modules` reads what the console actually compiles against. A
 * copy of the contracts repository somewhere on this machine is not that: the
 * pin can move without the checkout, or the checkout can move without the pin,
 * and either way the file the bundler resolves is this one.
 */
const CONTRACT = join(ROOT, "node_modules/@agent-mesh/contracts/src/teardown.ts");

/** The literals of a `export type <name> = "a" | "b";` declaration. */
function union(file: string, name: string): string[] {
  const source = readFileSync(file, "utf8");
  const m = new RegExp(`export type ${name}\\s*=([^;]*);`).exec(source);
  expect(m, `${file} no longer declares ${name} — this guard would pass on nothing`).not.toBeNull();
  const literals = [...m![1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
  expect(literals.length, `${name} in ${file} lists no literals`).toBeGreaterThan(0);
  return literals;
}

describe("the teardown outcome is the same three words everywhere", () => {
  test("the store's union matches the contract's, in the same order", () => {
    // Order as well as membership: the union is read left to right by a person
    // comparing the two files, and a reordered copy is a copy nobody re-checks.
    expect(union(STORE, "TeardownAction")).toEqual(union(CONTRACT, "TeardownAction"));
  });

  test("and it is those three, so neither file drifted with the other", () => {
    // Both could agree and both be wrong. This is the third opinion.
    expect(union(STORE, "TeardownAction")).toEqual(["soft-deleted", "already-deleted", "not-found"]);
  });

  test("the console takes the contract rather than restating it", () => {
    // The copy came out; this is what stops it coming back. A hand-written
    // union here would agree with the contract on the day it was written and
    // is the third declaration all over again — and it would be invisible to
    // the comparison above, which does not read this file.
    const source = readFileSync(CONSOLE, "utf8");
    expect(/export type TeardownAction\s*=\s*"/.test(source), "the console declared its own union again").toBe(false);
    expect(/export interface TeardownResponse\b/.test(source), "the console declared its own response again").toBe(false);
    expect(
      /export type \{[^}]*\bTeardownAction\b[^}]*\} from "@agent-mesh\/contracts"/.test(source),
      "the console no longer re-exports TeardownAction from the contract",
    ).toBe(true);
    expect(
      /import type \{[^}]*\bTeardownResponse\b[^}]*\} from "@agent-mesh\/contracts"/.test(source),
      "the console no longer types its teardown call from the contract",
    ).toBe(true);
  });

  /**
   * The union can match while the envelope does not, and that is the same
   * defect one layer out: the console would read a field the route never sends.
   * `revoked` is on the store's result and deliberately absent from the wire.
   */
  test("the contract expects exactly the fields the route sends", () => {
    // Scoped to the function first: `c.json({ ok: true, ... })` appears all over
    // this file, and an unscoped pattern would read some other route's answer
    // and call it this one's.
    const route = readFileSync(ROUTE, "utf8");
    const fn = /async function teardownAs\([\s\S]*?\n\}/.exec(route);
    expect(fn, "teardownAs is no longer a function in this file").not.toBeNull();
    // The **last** `c.json({...})` in the function, not the first. The first is
    // the `500` the catch answers, whose object is closed on its own line — so
    // a lazy match from there runs on through whatever the catch does before
    // it and reads those keys as fields the route sends. It did, once this
    // file's `console.error` became a multi-line `log.error`.
    const answers = [...fn![0].matchAll(/return c\.json\(\{([\s\S]*?)\n\s*\}\)/g)];
    expect(answers.length, "the teardown route no longer answers with an object literal").toBeGreaterThan(0);
    const sent = new Set(
      [...answers[answers.length - 1]![1]!.matchAll(/([a-z_]+):/g)].map((m) => m[1]!),
    );
    expect(sent.has("identity")).toBe(true);
    expect(sent.has("action")).toBe(true);
    expect(sent.has("deleted_at")).toBe(true);
    // Not sent, on purpose — the revoked fingerprints are the store's business.
    expect(sent.has("revoked")).toBe(false);

    const iface = /export interface TeardownResponse \{([\s\S]*?)\n\}/.exec(readFileSync(CONTRACT, "utf8"));
    expect(iface, "the contract no longer declares TeardownResponse").not.toBeNull();
    const declared = [...iface![1]!.matchAll(/^\s*([a-z_]+)\??:/gm)].map((m) => m[1]!);
    expect(declared.length).toBeGreaterThan(0);
    for (const field of declared) {
      expect(sent.has(field), `the contract declares '${field}', which the route does not send`).toBe(true);
    }
  });
});
