/**
 * What the harness says when a service dies without being asked to.
 *
 * **This is a test of the test harness**, which needs a reason. The reason is
 * an hour spent on CI run 32059573317, where one test exceeded its budget and
 * the report was fifteen failures reading `Unable to connect`. Every one of
 * them was true about the socket and none said why the socket was gone: Bun
 * signals spawned children when a test times out, so the mesh a suite shares
 * shuts down gracefully and everything after it fails to connect to nothing.
 *
 * The hub's own account of its exit was captured the whole time — `output()`
 * held it — and nothing printed it, because printing it was nobody's job. The
 * announcement under test is that job. A diagnostic with no test is the same
 * shape as the bug it exists to expose: it works until it silently does not,
 * and the run where it was needed is the run that finds out.
 *
 * The distinction being tested is orderly versus not. `stop()` at the end of a
 * suite is an exit somebody asked for and must stay silent, or the banner
 * appears after every file and stops being a signal.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { startMesh, type Mesh } from "./harness";

/**
 * Collect `console.error` while something runs.
 *
 * Restored in a `finally`, so a failing assertion does not leave the rest of
 * the file unable to report anything.
 */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const said: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { said.push(args.map(String).join(" ")); };
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return said.join("\n");
}

let mesh: Mesh | undefined;
afterEach(() => { mesh?.stop(); mesh = undefined; });

describe("a service that dies on its own", () => {
  test("says so, and repeats what it said on the way out", async () => {
    mesh = await startMesh({ withHttp: false });
    const { pid } = mesh.hub;

    const said = await captureStderr(async () => {
      // SIGTERM is what a bun test timeout delivers, and what killed the hub
      // in the run this file exists because of. Not `stop()` — that is the
      // orderly exit, and the point is to tell them apart.
      process.kill(pid, "SIGTERM");
      // The announcement is on `proc.exited`, so it lands a tick after the
      // process actually goes. Poll rather than sleep a guessed interval.
      for (let i = 0; i < 100 && !isDead(pid); i++) await Bun.sleep(20);
      await Bun.sleep(100);
    });

    expect(said, "the hub died and the harness said nothing").toContain("exited on its own");
    expect(said, "the banner did not name which service").toContain("packages/hub/src/main.ts");
    // The captured output is the part that was there all along and unread. A
    // banner without it names the victim and still not the cause.
    expect(said, "the banner did not carry what the process printed")
      .toContain("Hub server listening");
    expect(said, "a reader is not told the failures after this one are consequences")
      .toContain("fail to connect");
  });

  test("but stop() is silent, because that exit was asked for", async () => {
    // Otherwise the banner prints after every suite that shuts down normally,
    // and a reader learns to skip it — which costs exactly as much as not
    // printing it at all, on the one run where it mattered.
    const m = await startMesh({ withHttp: false });
    const { pid } = m.hub;

    const said = await captureStderr(async () => {
      m.stop();
      for (let i = 0; i < 100 && !isDead(pid); i++) await Bun.sleep(20);
      await Bun.sleep(100);
    });

    expect(isDead(pid), "stop() did not actually end the process, so this proves nothing")
      .toBe(true);
    expect(said, "an orderly shutdown printed the crash banner").not.toContain("exited on its own");
  });
});

/** Signal 0 tests for a live process without touching it. */
function isDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}
