/**
 * A state directory for the test process, so no test can write to a real one.
 *
 * `stateDir()` answers `AGENT_MESH_STATE_DIR ?? DEFAULT_STATE_DIR`, and the
 * paths built from it — `agent-mesh.db`, `agents.db`, `hub.db` — are computed
 * when their module is *loaded*. Bun runs a whole suite in one process, so the
 * first file to import one of those modules fixes the path for every file after
 * it, and a file that set the variable at its own top level found the decision
 * already made. `main.in-process.test.ts` failed that way and only when run
 * with its neighbours.
 *
 * Set here, before any test file is loaded, one directory holds for the run and
 * the default — somebody's actual mesh — is never the answer.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.AGENT_MESH_STATE_DIR) {
  process.env.AGENT_MESH_STATE_DIR = mkdtempSync(join(tmpdir(), "agent-mesh-test-state-"));
}
