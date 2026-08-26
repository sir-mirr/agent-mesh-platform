/**
 * The run writes to a temporary state directory, never a real one.
 *
 * `scripts/test-state-dir.ts` is preloaded by `bunfig.toml` before any test
 * file, because the paths built from `AGENT_MESH_STATE_DIR` — `agent-mesh.db`,
 * `agents.db`, `hub.db` — are computed when their module *loads*, and bun runs a
 * whole suite in one process. The first import fixes the path for every file
 * after it, so a file setting the variable at its own top level finds the
 * decision already made.
 *
 * **What it prevents is not a failed test.** With the assignment gone,
 * `stateDir()` answers the default, and a suite opens the mesh somebody is
 * actually running — on this machine, the standing hub, http and console on
 * 3100/3000/3005. The tests would pass. They would pass while writing rows into
 * a live deployment, and the first sign would be data nobody put there.
 *
 * It is asserted in this process rather than in a child on purpose: the
 * preload's whole subject is *this* process's environment, and a child proves
 * something about a child.
 */

import { describe, expect, test } from "bun:test";
import { homedir, tmpdir } from "node:os";

describe("the state directory this run was given", () => {
  test("is set, and is under the temporary directory", () => {
    const dir = process.env.AGENT_MESH_STATE_DIR;
    expect(dir, "no state directory was set, so every path falls back to a real one").toBeTruthy();
    // `realpath` differs from `tmpdir()` on macOS — `/private/var/…` against
    // `/var/…` — so this compares on the segment the preload actually chose
    // rather than on a prefix two spellings disagree about.
    expect(
      { underTmp: dir!.includes(tmpdir().replace(/^\/private/, "")), named: dir!.includes("agent-mesh-") },
      `the state directory is ${dir}, which is not one this preload made`,
    ).toEqual({ underTmp: true, named: true });
  });

  test("is not the one a real deployment would use", () => {
    // The other end of the same assertion. A path under the home directory is
    // the shape `DEFAULT_STATE_DIR` has, and it is the one thing this must
    // never be — a suite writing there writes into whatever is running.
    const dir = process.env.AGENT_MESH_STATE_DIR ?? "";
    expect(
      dir.startsWith(homedir()),
      `the suite would write to ${dir}, which is inside the home directory a running mesh uses`,
    ).toBe(false);
  });
});
