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
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootRetryable, freePort, openTestDb, startMesh, type Mesh } from "./harness";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const UNITS = join(REPO_ROOT, "ops", "systemd");

let mesh: Mesh | null = null;
afterAll(() => mesh?.stop());


/**
 * Spawn the http server on a free port, retrying when it loses the race.
 *
 * `freePort` releases the port before the child binds it, and two meshes in one
 * suite run can pick the same number — this file's own tests hit that with the
 * machine otherwise idle. `startMesh` retries for exactly this reason; these
 * tests spawn directly and inherited the gap rather than the fix.
 *
 * Narrow: only an exit whose output says the port was taken. A server that
 * refuses for its own reason — which is what two of these tests are about —
 * must still fail once and loudly.
 */
async function spawnHttp(
  env: Record<string, string>,
): Promise<{ proc: ReturnType<typeof Bun.spawn>; url: string; up: boolean; said: string }> {
  let last = { proc: null as any, url: "", up: false, said: "" };
  for (let attempt = 1; attempt <= 3; attempt++) {
    const port = await freePort();
    const proc = Bun.spawn(["bun", join(REPO_ROOT, "packages/http/src/main.ts")], {
      cwd: REPO_ROOT,
      env: { ...env, AGENT_MESH_HTTP_PORT: String(port) },
      stdout: "pipe",
      stderr: "pipe",
    });
    const url = `http://127.0.0.1:${port}`;
    let up = false;
    for (let i = 0; i < 200 && !up; i++) {
      try {
        up = (await fetch(`${url}/api/v1/health`)).ok;
      } catch {}
      if (!up) await Bun.sleep(50);
    }
    if (up) return { proc, url, up, said: "" };

    const said = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
    proc.kill();
    await proc.exited;
    last = { proc, url, up, said };
    // Silence gets another port; a refusal is the answer. See `bootRetryable`
    // — the narrow version retried only on a port message, so a boot that was
    // merely too slow to answer failed once and loudly for a reason that was
    // the machine's.
    if (!bootRetryable(said)) return last;
    console.error(`[misconfigured-boot] boot ${attempt}/3 said nothing; taking another port`);
  }
  return last;
}

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

test("the seeded admin takes the deployment's password when it states one", async () => {
  // `admin`/`admin` is the quickstart's login and every test's, so it stays the
  // default. What was missing is a way for a deployment not to have it: on a
  // host others can reach it is a published password, and the login form filled
  // both boxes in for the visitor until `963465a`.
  //
  // Refusing to start without one would take the local path away to close a
  // hole the local path does not have. A random password would be printed once
  // and lost. So: stated, or defaulted and said out loud.
  //
  // **A real mesh's state directory** — the same reason as the test above, and
  // the first version of this one ignored that comment sitting ten lines up. An
  // empty temp dir cannot boot the http server at all, so it measured *the
  // server did not start* and called it *the password did not take*.
  const own = await startMesh({ withHttp: false });
  try {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    env.AGENT_MESH_STATE_DIR = own.stateDir;
    env.AGENT_MESH_HTTP_PORT = String(await freePort());
    env.JWT_SECRET = "integration-test-secret";
    env.AGENT_MESH_ADMIN_PASSWORD = "not-the-default";

    const proc = Bun.spawn(["bun", join(REPO_ROOT, "packages/http/src/main.ts")], {
      cwd: REPO_ROOT,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const url = `http://127.0.0.1:${env.AGENT_MESH_HTTP_PORT}`;
      let up = false;
      for (let i = 0; i < 200 && !up; i++) {
        try {
          up = (await fetch(`${url}/api/v1/health`)).ok;
        } catch {}
        if (!up) await Bun.sleep(50);
      }
      // Asserted, not assumed: every claim below is about a server that answers.
      expect(up, "the http server never became healthy, so nothing below measured a password").toBe(true);

      const login = (password: string) =>
        fetch(`${url}/auth/local`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: `username=admin&password=${password}`,
          redirect: "manual",
        });

      expect((await login("not-the-default")).headers.get("set-cookie") ?? "", "the stated password did not work").toContain("mesh_token=");
      // The half that makes the other half worth anything.
      expect((await login("admin")).headers.get("set-cookie") ?? "", "`admin` still works, so stating one changed nothing").not.toContain("mesh_token=");
    } finally {
      proc.kill();
      await proc.exited;
    }
  } finally {
    own.stop();
  }
}, 40_000);

test("an account seeded before the flag existed is marked only if its password is still the initial one", async () => {
  // The seed's flag is set inside the `no rows yet` branch, so a database
  // written before the column existed never passes it. agent-mesh-local-pm
  // found that by signing in like a person on such a stack and landing on the
  // dashboard.
  //
  // Half of that is right: an upgrade must not lock out an operator who has
  // already chosen a password. The other half is not — if the password is
  // still the one it was seeded with, the account is exactly what the gate was
  // written for, and leaving it keeps `admin`/`admin` alive on every
  // deployment that upgraded rather than started fresh.
  //
  // So the pair: unchanged is marked, changed is left alone. Without the second
  // half a boot that marked every account would pass the first.
  const own = await startMesh({ withHttp: false });
  const dbPath = join(own.stateDir, "agent-mesh.db");
  const boot = async () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    env.AGENT_MESH_STATE_DIR = own.stateDir;
    env.JWT_SECRET = "integration-test-secret";
    const { proc, up } = await spawnHttp(env);
    proc?.kill();
    await proc?.exited;
    return up;
  };
  const flag = () => {
    const db = openTestDb(dbPath, { readonly: true });
    const row = db.prepare(`SELECT must_change_password AS f FROM local_users WHERE username = 'admin'`)
      .get() as { f: number } | undefined;
    db.close();
    return row?.f;
  };
  const setRow = async (password: string) => {
    const db = openTestDb(dbPath, { readwrite: true });
    db.prepare(`UPDATE local_users SET password_hash = ?, must_change_password = 0 WHERE username = 'admin'`)
      .run(await Bun.password.hash(password, { algorithm: "bcrypt" }));
    db.close();
  };

  try {
    expect(await boot(), "the first boot did not come up, so nothing below measured a seed").toBe(true);

    // Still `admin`: the row somebody upgraded and never touched.
    await setRow("admin");
    expect(await boot()).toBe(true);
    expect(flag(), "an account still on its initial password was left unflagged").toBe(1);

    // Already chosen: the operator who set one must not be locked out.
    await setRow("an-operator-chose-this");
    expect(await boot()).toBe(true);
    expect(flag(), "an account whose password was already changed was flagged anyway").toBe(0);
  } finally {
    own.stop();
  }
}, 60_000);
