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

import { afterAll, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { freePort, startMesh, type Mesh } from "./harness";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const UNITS = join(REPO_ROOT, "ops", "systemd");

let mesh: Mesh | null = null;
afterAll(() => mesh?.stop());

test("the http server refuses to start without a JWT secret", async () => {
  /**
   * **A real mesh's state directory, so the secret is the only thing missing.**
   *
   * The first version pointed at an empty temporary directory and passed — and
   * kept passing with the check removed, because the server cannot boot there
   * at all: the hub owns the DDL, so `agents.db` does not exist and the open
   * fails with `unable to open database file`. The test was measuring *the
   * server did not start*, which is true for many reasons, rather than *this
   * check stopped it*. The mutation is what found that.
   */
  mesh = await startMesh({ withHttp: false });
  const stateDir = mesh.stateDir;
  {
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
  }
}, 60_000);

test("a unit refuses to start without the env file it was given", () => {
  // `EnvironmentFile=-path` is systemd's *optional* form: a missing file is not
  // an error, the service starts, and every variable in it takes a default.
  //
  // For these units that is silence with a wrong answer underneath. The http
  // server refuses without `JWT_SECRET` — the test above — so it fails loudly.
  // The hub does not: it starts, writes to the default state directory, and
  // hands every client `http://127.0.0.1:3000` as the place to upload
  // attachments, which is right on the machine the quickstart describes and
  // wrong on the one the unit is for. Nothing observable disagrees until an
  // attachment fails, later, for somebody else.
  //
  // agent-mesh-local-pm measured it: env examples copied as documented, three
  // variables absent, and only one of the three failures announced itself.
  const units = readdirSync(UNITS).filter((f) => f.endsWith(".service"));
  expect(units.length, "no unit files were read, so this test compared nothing").toBeGreaterThan(2);

  const optional = units.flatMap((file) =>
    readFileSync(join(UNITS, file), "utf8")
      .split("\n")
      .filter((line) => line.startsWith("EnvironmentFile=-"))
      .map((line) => `${file}: ${line}`),
  );
  expect(optional, "a missing env file would start the service on defaults instead of failing").toEqual([]);
});

test("a unit runs a file this repository actually has", () => {
  // systemd resolves these against `WorkingDirectory=/srv/agent-mesh-platform`,
  // so every one is a path in this tree — and a unit pointing at a file that
  // moved fails on the host, at deploy time, with the operator holding it.
  //
  // Two of these units have no test of any other kind, which is what
  // agent-mesh-local-pm was about to check with real systemd in a container
  // before that path was dropped. This is the part of it that needs no systemd:
  // the names can be checked here, the behaviour cannot.
  //
  // Fourteen scripts were deleted from this repository today. None was named by
  // a unit — checked by hand at the time, and by this from now on.
  const units = readdirSync(UNITS).filter((f) => f.endsWith(".service"));
  expect(units.length, "no unit files were read, so this test compared nothing").toBeGreaterThan(2);

  const targets = units.flatMap((file) => {
    const text = readFileSync(join(UNITS, file), "utf8");
    return [...text.matchAll(/^ExecStart(?:Pre|Post)?=(.+)$/gm)].flatMap((m) => {
      // `ExecStart=/abs/bun packages/hub/src/main.ts` — the interpreter is the
      // host's, the arguments are ours. Absolute paths belong to the deployment
      // image and cannot be checked from here; relative ones are this repo.
      const parts = m[1]!.trim().split(/\s+/).filter((a) => !a.startsWith("-"));
      return parts
        .filter((a) => !a.startsWith("/home/") && a.includes("/"))
        .map((a) => ({ file, path: a.replace(/^\/srv\/agent-mesh-platform\//, "") }));
    });
  });
  expect(targets.length, "no ExecStart target was parsed out of any unit").toBeGreaterThan(3);

  const missing = targets
    .filter((t) => !existsSync(join(REPO_ROOT, t.path)))
    .map((t) => `${t.file} runs ${t.path}, which is not in this repository`);
  expect(missing).toEqual([]);
});
