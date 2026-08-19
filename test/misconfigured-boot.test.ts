/**
 * A misconfiguration that runs is one nobody finds.
 *
 * `packages/http/src/auth.ts` refuses to start without `JWT_SECRET`, and the
 * comment above it gives the reason: signing sessions with a default would mean
 * anyone who has read the file can forge them. The alternative shape — start,
 * serve, and fail only when somebody tries to log in — is the failure this
 * repository has spent the week removing everywhere else: something that looks
 * like it is working.
 *
 * Measured because it had never been. It was the last row of
 * agent-mesh-local-pm's feature table still resting on *the source says so*,
 * and the source said something slightly different from the table: the table
 * had it serving a redirect with no cookie, which is what would happen if the
 * check were not there.
 *
 * The exit code and the message are both asserted. An exit code alone would
 * pass for a process that died of anything, including the missing state
 * directory this test also has to supply.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { freePort } from "./harness";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

test("the http server refuses to start without a JWT secret", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "no-secret-"));
  try {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    // Removed rather than emptied: an empty string is falsy here too, and the
    // configuration this guards against is the variable being absent.
    delete env.JWT_SECRET;
    env.AGENT_MESH_STATE_DIR = stateDir;
    env.AGENT_MESH_HTTP_PORT = String(await freePort());

    const proc = Bun.spawn(["bun", join(REPO_ROOT, "packages/http/src/main.ts")], {
      cwd: REPO_ROOT,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const said = out + err;

    expect({ code, tail: said.slice(-500) }).toMatchObject({ code: 1 });

    // **It never served.** The message is printed before the exit, so a version
    // that warned and carried on with a default would still satisfy the two
    // assertions below — the first draft of this test did exactly that and the
    // mutation went uncaught. What separates refusing from complaining is
    // whether the port was ever opened.
    expect({ served: said.includes("listening") }).toEqual({ served: false });

    // Naming the variable is the difference between a fixable start-up failure
    // and one an operator has to bisect.
    expect({ names: said.includes("JWT_SECRET") }).toEqual({ names: true });
    expect({ says: said.includes("Refusing to start") }).toEqual({ says: true });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}, 60_000);
