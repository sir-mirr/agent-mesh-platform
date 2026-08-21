/**
 * One fact, declared in three places that cannot see each other.
 *
 * `teardown` answers one of three things — `soft-deleted`, `already-deleted`,
 * `not-found` — and teardown is irreversible, so which one it was is the most
 * expensive thing on that screen to get wrong.
 *
 * The store declares the union. The route passes it through. The console
 * declares its own copy, because `@agent-mesh/store` opens `bun:sqlite` and a
 * browser bundle must not take its type graph — the shared home is
 * `@agent-mesh/contracts`, which does not carry teardown yet. Until it does,
 * `fe-codex` keeps a local copy under a comment saying to keep it aligned and
 * that the platform owns the guard. This is the guard.
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
  test("the console's local copy matches the store's, in the same order", () => {
    // Order as well as membership: the union is read left to right by a person
    // comparing the two files, and a reordered copy is a copy nobody re-checks.
    expect(union(CONSOLE, "TeardownAction")).toEqual(union(STORE, "TeardownAction"));
  });

  test("and it is those three, so neither file drifted with the other", () => {
    // Both could agree and both be wrong. This is the third opinion.
    expect(union(STORE, "TeardownAction")).toEqual(["soft-deleted", "already-deleted", "not-found"]);
  });

  /**
   * The union can match while the envelope does not, and that is the same
   * defect one layer out: the console would read a field the route never sends.
   * `revoked` is on the store's result and deliberately absent from the wire.
   */
  test("the console expects exactly the fields the route sends", () => {
    // Scoped to the function first: `c.json({ ok: true, ... })` appears all over
    // this file, and an unscoped pattern would read some other route's answer
    // and call it this one's.
    const route = readFileSync(ROUTE, "utf8");
    const fn = /async function teardownAs\([\s\S]*?\n\}/.exec(route);
    expect(fn, "teardownAs is no longer a function in this file").not.toBeNull();
    const body = /return c\.json\(\{([\s\S]*?)\n\s*\}\)/.exec(fn![0]);
    expect(body, "the teardown route no longer answers with an object literal").not.toBeNull();
    const sent = new Set([...body![1]!.matchAll(/([a-z_]+):/g)].map((m) => m[1]!));
    expect(sent.has("identity")).toBe(true);
    expect(sent.has("action")).toBe(true);
    expect(sent.has("deleted_at")).toBe(true);
    // Not sent, on purpose — the revoked fingerprints are the store's business.
    expect(sent.has("revoked")).toBe(false);

    const iface = /export interface TeardownResponse \{([\s\S]*?)\}/.exec(readFileSync(CONSOLE, "utf8"));
    expect(iface, "the console no longer declares TeardownResponse").not.toBeNull();
    const declared = [...iface![1]!.matchAll(/^\s*([a-z_]+)\??:/gm)].map((m) => m[1]!);
    expect(declared.length).toBeGreaterThan(0);
    for (const field of declared) {
      expect(sent.has(field), `the console declares '${field}', which the route does not send`).toBe(true);
    }
  });
});
