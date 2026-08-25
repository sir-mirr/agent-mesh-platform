/**
 * The wrapper that runs the repository's checks, and the exit code it owes.
 *
 * A verification whose exit code cannot go red is the shape this repository
 * keeps finding behind its own checks. This one had it: a `;` chain of
 * `cmd | tail` reports the last pipeline's status, so `10 fail` released a
 * measuring window with `exit 0` — read off a single broadcast by both other
 * agents within a minute of each other.
 *
 * The steps are injected, so this asserts the wrapper's arithmetic rather than
 * running the whole repository again.
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const VERIFY = resolve(import.meta.dir, "..", "scripts", "verify.ts");

async function verify(steps: Array<{ name: string; command: string[] }>) {
  const proc = Bun.spawn(["bun", VERIFY], {
    env: { ...process.env, AGENT_MESH_VERIFY_STEPS: JSON.stringify(steps) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [said, complained, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, said, complained };
}

const passes = (name: string) => ({ name, command: ["bun", "-e", `console.log("${name}: 3 pass\\n 0 fail")`] });
const fails = (name: string) => ({ name, command: ["bun", "-e", `console.log("${name}: 1 fail"); process.exit(1)`] });

describe("the verification wrapper", () => {
  test("exits zero only when every step did", async () => {
    const run = await verify([passes("first"), passes("second")]);
    expect({ code: run.code, said: run.said.includes("verification passed") }).toEqual({ code: 0, said: true });
  }, 60_000);

  test("a failing step makes the whole verification red", async () => {
    // The defect: this exited zero because the last pipeline did.
    const run = await verify([fails("test/"), passes("coverage floor")]);
    expect(run.code).toBe(1);
    expect(run.said).toContain("verification failed: test/ (exit 1)");
  }, 60_000);

  test("names every step that failed, not just the first", async () => {
    // One broken thing and two are different situations, and a wrapper that
    // stops at the first hides which.
    const run = await verify([fails("typecheck"), passes("packages/"), fails("test/")]);
    expect(run.code).toBe(1);
    expect(run.said).toContain("typecheck (exit 1)");
    expect(run.said).toContain("test/ (exit 1)");
  }, 60_000);

  test("every step runs even after one has failed", async () => {
    const run = await verify([fails("typecheck"), passes("the one after")]);
    expect(run.said).toContain("the one after: 3 pass");
  }, 60_000);

  test("the verdict comes from the exit code, not from what the step printed", async () => {
    // A suite that prints a clean summary and exits non-zero is the case that
    // matters: bun does this when a file fails to load.
    const run = await verify([
      { name: "prints clean, exits red", command: ["bun", "-e", 'console.log(" 0 fail"); process.exit(1)'] },
    ]);
    expect(run.code).toBe(1);
  }, 60_000);
});
