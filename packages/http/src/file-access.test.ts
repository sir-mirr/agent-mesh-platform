/**
 * The path policy behind `GET /api/v1/files`, driven directly.
 *
 * Both of its rules are here because something got through: the sibling
 * directory that `startsWith` accepted, and the `..` rule that could not fire
 * because the route resolved the path before handing it over. The second was
 * found by trying to cover the line — the branch was unreachable at every
 * input, so no test could have failed for it.
 *
 * This file owns the `fa-` prefix.
 */
import { describe, expect, test } from "bun:test";
import { isPathAllowed } from "./file-access";

const STATE = "/var/lib/agent-mesh";
const PREFIXES = [STATE, "/home/ubuntu/ai/workspaces/"] as const;
const allowed = (p: string) => isPathAllowed(p, PREFIXES);

describe("what it admits", () => {
  test("a file inside an allowed directory", () => {
    expect(allowed(`${STATE}/messages.db`)).toBe(true);
    expect(allowed("/home/ubuntu/ai/workspaces/one/notes.md")).toBe(true);
  });

  test("the directory itself", () => {
    expect(allowed(STATE)).toBe(true);
  });

  /** The second prefix already ends in a separator; both spellings work. */
  test("a prefix written with or without its trailing separator", () => {
    expect(allowed("/home/ubuntu/ai/workspaces/x")).toBe(true);
    expect(isPathAllowed(`${STATE}/x`, [`${STATE}/`])).toBe(true);
  });
});

describe("what it refuses", () => {
  /**
   * **A prefix is not a directory until it ends at a separator.** This route
   * answered `200` for exactly this path: any approved session could read a
   * sibling directory whose name merely began with the allowed one.
   */
  test("a sibling directory whose name starts with an allowed one", () => {
    expect(allowed(`${STATE}-backup/secret`)).toBe(false);
    expect(allowed(`${STATE}x`)).toBe(false);
  });

  test("a path outside every prefix", () => {
    expect(allowed("/etc/passwd")).toBe(false);
    expect(allowed("/home/ubuntu/ai/other/notes.md")).toBe(false);
  });

  /**
   * **Traversal that lands outside is refused by resolution**, which is the
   * defence that matters — this case would fail on the prefix check even with
   * the `..` rule gone.
   */
  test("a traversal that escapes the directory", () => {
    expect(allowed(`${STATE}/../../etc/passwd`)).toBe(false);
  });

  /**
   * **And traversal that lands back inside is refused by the rule.** This is
   * the case the prefix check cannot see: the resolved path is allowed, and
   * nobody writes `a/../b` meaning it. The branch was unreachable until the
   * route stopped resolving the path before the check — `resolve(resolve(p))`
   * is `resolve(p)`, so `resolved !== filePath` was false at every input.
   */
  test("a traversal that lands somewhere allowed anyway", () => {
    expect(allowed(`${STATE}/sub/../messages.db`)).toBe(false);
    expect(allowed("/home/ubuntu/ai/workspaces/one/../two/notes.md")).toBe(false);
  });

  /** An already-resolved path containing no `..` is judged on the prefix alone. */
  test("nothing merely because it was written absolutely", () => {
    expect(allowed(`${STATE}/a/b/c.txt`)).toBe(true);
  });

  test("an empty prefix list", () => {
    expect(isPathAllowed(`${STATE}/messages.db`, [])).toBe(false);
  });
});
