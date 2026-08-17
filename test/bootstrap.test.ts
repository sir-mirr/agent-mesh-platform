/**
 * § 10 — the bootstrap script.
 *
 * This runs as `ExecStartPost` on the hub unit, so it executes on every
 * production hub start and its exit code decides whether the unit comes up. It
 * had no coverage at all: the one piece of the system that runs before anyone
 * is watching was the one piece nothing checked.
 *
 * The script is exercised as a subprocess against a real hub, because the
 * requirements in § 10 are about what it does to the hub — provisioning over
 * loopback, idempotence, not touching `messages` — and none of that is visible
 * from reading its output.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startMesh, type Mesh, type Service } from "./harness";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const SCRIPT = join(REPO_ROOT, "ops/bin/bootstrap-hub-service-identities.sh");

let mesh: Mesh | null = null;
const tempDirs: string[] = [];

afterEach(() => {
  mesh?.stop();
  mesh = null;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An `env/` tree shaped the way § 10 says the script reads one. */
function envRoot(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "agent-mesh-env-"));
  tempDirs.push(root);
  mkdirSync(join(root, "shared"), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(root, "shared", name), body);
  }
  return root;
}

interface Run {
  code: number;
  stderr: string;
  stdout: string;
}

async function run(env: Record<string, string>): Promise<Run> {
  const proc = Bun.spawn(["bash", SCRIPT], {
    cwd: REPO_ROOT,
    env: {
      PATH: process.env.PATH!,
      HOME: process.env.HOME!,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/**
 * Which of the baseline identities the hub has, asked one at a time.
 *
 * **There is no list route, and the version of this that pretended otherwise
 * returned `[]` in every run.** It fetched `GET /api/v1/agents`, which the hub
 * answers `405 method not allowed; use POST` — measured, not assumed — and then
 * returned `[]` on 405 under a comment saying it would "fall back to
 * per-identity lookups". That fallback was never written, so the idempotence
 * check below compared `[]` to `[]` and observed nothing: a script that
 * duplicated an identity, renamed one, or wiped the registry on its second run
 * passed it unchanged.
 *
 * Read through the hub rather than by opening `hub.db`: § 10 forbids that of
 * the script, and a test that did it would be asserting against a file the
 * script is not allowed to know exists.
 */
async function identities(hub: Service): Promise<string[]> {
  // The identities the env layout seeds, plus one that must never appear. A
  // probe for an absent name is what turns this from "the ones we expected are
  // there" into "and nothing else arrived".
  const probe = ["http-server", "self-reminder", "not-provisioned-by-bootstrap"];
  const present: string[] = [];
  for (const id of probe) if (await exists(hub, id)) present.push(id);
  return present.sort();
}

async function exists(hub: Service, identity: string): Promise<boolean> {
  const res = await fetch(`${hub.url}/api/v1/agents/${encodeURIComponent(identity)}/keys`);
  return res.status === 200;
}

describe("§ 10 bootstrap script", () => {
  test("provisions the baseline service identities over loopback", async () => {
    mesh = await startMesh({ withHttp: false });
    const root = envRoot({ "http.env": "", "self-reminder.env": "" });

    const result = await run({
      AGENT_MESH_ENV_ROOT: root,
      AGENT_MESH_HUB_API_URL: `${mesh.hub.url}/api/v1/agents`,
      HUB_BOOTSTRAP_MAX_RETRIES: "3",
    });

    expect(result.code).toBe(0);
    expect(await exists(mesh.hub, "http-server")).toBe(true);
    expect(await exists(mesh.hub, "self-reminder")).toBe(true);
  }, 30_000);

  test("a retry count that would skip every attempt is refused, not obeyed", async () => {
    // **The loop that never runs.** `for (( attempt = 1; attempt <= MAX_RETRIES;
    // … ))` with `MAX_RETRIES=0` never enters its body, the function falls off
    // the end returning the status of the `for` — which is 0 — and `main`
    // proceeds. The unit's `ExecStartPost` then reports success having
    // registered nothing and logged nothing.
    //
    // Measured before it was fixed, because the exit status of a loop nobody
    // entered is not something to reason about from memory:
    //
    //     MAX_RETRIES='30'  -> body ran, exit 0
    //     MAX_RETRIES='0'   -> body never ran, exit 0
    //     MAX_RETRIES='abc' -> body never ran, exit 0
    //
    // `abc` matters as much as `0`: bash arithmetic reads any non-numeric
    // string as zero, so a typo in a unit file is the same defect with no
    // number in sight. Both are refused at configuration rather than defaulted,
    // because a value that was set and is unusable means an operator believes
    // something this script is not doing.
    const root = envRoot({ "http.env": "", "self-reminder.env": "" });

    for (const bad of ["0", "abc", "-1", "1.5"]) {
      const result = await run({
        AGENT_MESH_ENV_ROOT: root,
        AGENT_MESH_HUB_API_URL: "http://127.0.0.1:1/api/v1/agents",
        HUB_BOOTSTRAP_MAX_RETRIES: bad,
      });
      expect(result.code, `HUB_BOOTSTRAP_MAX_RETRIES=${bad} was accepted`).toBe(2);
      expect(result.stderr).toContain("must be a positive integer");
    }
  }, 30_000);

  test("a usable retry count still runs, so the check above is not refusing everything", async () => {
    // The other half. A guard that rejected every value would satisfy the test
    // above and stop the hub from ever coming up — and it runs before anyone is
    // watching, which is the whole reason this file exists.
    mesh = await startMesh({ withHttp: false });
    const root = envRoot({ "http.env": "", "self-reminder.env": "" });

    const result = await run({
      AGENT_MESH_ENV_ROOT: root,
      AGENT_MESH_HUB_API_URL: `${mesh.hub.url}/api/v1/agents`,
      HUB_BOOTSTRAP_MAX_RETRIES: "1",
    });

    expect(result.code).toBe(0);
    expect(await exists(mesh.hub, "http-server")).toBe(true);
  }, 30_000);

  test("NODE_ENV=development provisions the -dev identity instead", async () => {
    mesh = await startMesh({ withHttp: false });
    const root = envRoot({ "http.env": "NODE_ENV=development\n", "self-reminder.env": "" });

    const result = await run({
      AGENT_MESH_ENV_ROOT: root,
      AGENT_MESH_HUB_API_URL: `${mesh.hub.url}/api/v1/agents`,
      HUB_BOOTSTRAP_MAX_RETRIES: "3",
    });

    expect(result.code).toBe(0);
    expect(await exists(mesh.hub, "http-server-dev")).toBe(true);
    // Not both. A deployment that provisioned the production identity as well
    // would leave a name nobody holds, which is a name nobody can be given.
    expect(await exists(mesh.hub, "http-server")).toBe(false);
  }, 30_000);

  test("SELF_REMINDER_IDENTITY is honoured", async () => {
    mesh = await startMesh({ withHttp: false });
    const root = envRoot({
      "http.env": "",
      "self-reminder.env": "SELF_REMINDER_IDENTITY=reminders-prod\n",
    });

    const result = await run({
      AGENT_MESH_ENV_ROOT: root,
      AGENT_MESH_HUB_API_URL: `${mesh.hub.url}/api/v1/agents`,
      HUB_BOOTSTRAP_MAX_RETRIES: "3",
    });

    expect(result.code).toBe(0);
    expect(await exists(mesh.hub, "reminders-prod")).toBe(true);
    expect(await exists(mesh.hub, "self-reminder")).toBe(false);
  }, 30_000);

  test("repeated invocations change nothing (§ 10.3)", async () => {
    // It runs on every hub start, including restarts triggered by `Restart=always`
    // — so a script that was not idempotent would be a script that corrupted the
    // registry a little more on every crash loop.
    mesh = await startMesh({ withHttp: false });
    const root = envRoot({ "http.env": "", "self-reminder.env": "" });
    const env = {
      AGENT_MESH_ENV_ROOT: root,
      AGENT_MESH_HUB_API_URL: `${mesh.hub.url}/api/v1/agents`,
      HUB_BOOTSTRAP_MAX_RETRIES: "3",
    };

    expect((await run(env)).code).toBe(0);
    const first = await identities(mesh.hub);
    // Not an empty comparison. The first run must actually have provisioned
    // something, or the two sides below agree about nothing.
    expect(first, "the first run provisioned no identity — this compares nothing").not.toEqual([]);

    expect((await run(env)).code).toBe(0);
    expect((await run(env)).code).toBe(0);
    expect(await identities(mesh.hub)).toEqual(first);
  }, 30_000);

  test("HUB_BOOTSTRAP_DRY_RUN logs the intent and posts nothing", async () => {
    mesh = await startMesh({ withHttp: false });
    const root = envRoot({ "http.env": "", "self-reminder.env": "" });

    const result = await run({
      AGENT_MESH_ENV_ROOT: root,
      // Pointed at a port nothing is listening on. A dry run that reached the
      // network at all would fail here, which is the assertion.
      AGENT_MESH_HUB_API_URL: "http://127.0.0.1:1/api/v1/agents",
      HUB_BOOTSTRAP_DRY_RUN: "true",
      HUB_BOOTSTRAP_MAX_RETRIES: "1",
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("dry-run register http-server");
    expect(result.stderr).toContain("dry-run register self-reminder");
    expect(await exists(mesh.hub, "http-server")).toBe(false);
  }, 30_000);

  test("every truthy spelling of the dry-run flag is honoured", async () => {
    for (const value of ["1", "true", "TRUE", "yes", "On"]) {
      const root = envRoot({ "http.env": "", "self-reminder.env": "" });
      const result = await run({
        AGENT_MESH_ENV_ROOT: root,
        AGENT_MESH_HUB_API_URL: "http://127.0.0.1:1/api/v1/agents",
        HUB_BOOTSTRAP_DRY_RUN: value,
        HUB_BOOTSTRAP_MAX_RETRIES: "1",
      });
      expect(result.code, `HUB_BOOTSTRAP_DRY_RUN=${value}`).toBe(0);
      expect(result.stderr, `HUB_BOOTSTRAP_DRY_RUN=${value}`).toContain("dry-run register");
    }
  }, 30_000);

  test("an unreachable hub exits non-zero, so the unit start fails (§ 10.4)", async () => {
    // The whole point of `ExecStartPost`. A script that swallowed the failure
    // would leave a hub running with no service identities and nothing said.
    const root = envRoot({ "http.env": "", "self-reminder.env": "" });
    const result = await run({
      AGENT_MESH_ENV_ROOT: root,
      AGENT_MESH_HUB_API_URL: "http://127.0.0.1:1/api/v1/agents",
      HUB_BOOTSTRAP_MAX_RETRIES: "2",
      HUB_BOOTSTRAP_RETRY_SLEEP_SEC: "0",
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("failed to register");
  }, 30_000);

  test("it retries while the hub is still warming up", async () => {
    const root = envRoot({ "http.env": "", "self-reminder.env": "" });
    const result = await run({
      AGENT_MESH_ENV_ROOT: root,
      AGENT_MESH_HUB_API_URL: "http://127.0.0.1:1/api/v1/agents",
      HUB_BOOTSTRAP_MAX_RETRIES: "3",
      HUB_BOOTSTRAP_RETRY_SLEEP_SEC: "0",
    });
    // Reported once, after the attempts are spent — not once per attempt.
    expect(result.stderr.match(/failed to register/g)?.length).toBe(1);
    expect(result.stderr).toContain("after 3 attempts");
  }, 30_000);

  test("the API URL is derived from a ws:// hub url, and from wss://", async () => {
    // § 10.2's fallback chain. Getting this wrong posts to a path that 404s,
    // and the script would report a hub that never came up.
    mesh = await startMesh({ withHttp: false });
    const root = envRoot({ "http.env": "", "self-reminder.env": "" });

    const result = await run({
      AGENT_MESH_ENV_ROOT: root,
      AGENT_MESH_HUB_URL: `ws://127.0.0.1:${mesh.hub.port}/ws`,
      HUB_BOOTSTRAP_MAX_RETRIES: "3",
    });
    expect(result.code).toBe(0);
    expect(await exists(mesh.hub, "http-server")).toBe(true);

    const dry = await run({
      AGENT_MESH_ENV_ROOT: root,
      HUB_URL: "wss://mesh.example/ws",
      HUB_BOOTSTRAP_DRY_RUN: "1",
    });
    expect(dry.code).toBe(0);
  }, 30_000);

  test("a hub url it cannot reshape is refused rather than guessed at", async () => {
    const root = envRoot({ "http.env": "", "self-reminder.env": "" });
    const result = await run({
      AGENT_MESH_ENV_ROOT: root,
      AGENT_MESH_HUB_URL: "tcp://127.0.0.1:3100",
      HUB_BOOTSTRAP_DRY_RUN: "1",
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("unsupported hub url");
  }, 30_000);

  test("it never opens hub.db, whatever the state directory holds", async () => {
    // § 10: the script provisions over HTTP precisely so it cannot race the
    // hub's own migrations. Reading the file is the failure mode, so the check
    // is that the script's own source does not name it.
    const source = await Bun.file(SCRIPT).text();
    expect(source).not.toContain("hub.db");
    expect(source).not.toContain("sqlite");
    expect(source).not.toContain("DELETE");
    expect(source).not.toContain("messages");
  });

  test("it provisions with a type that needs no key", async () => {
    // § 10.1 refuses a `requires_key` type with no `public_key`, and this
    // script holds no key material — so a type change here would fail every
    // hub start with a 400.
    const source = await Bun.file(SCRIPT).text();
    expect(source).toContain('"type":"service"');
  });

  test("it runs under bash 3.2, which is what a developer's Mac has", async () => {
    // Not hypothetical: `declare -A` and `${var,,}` are bash 4, and under
    // `set -euo pipefail` they abort with `declare: -A: invalid option` — an
    // ExecStartPost failure whose message names nothing an operator can act on.
    // Comments stripped: the script explains in prose why it avoids these, and
    // matching its own explanation would fail for the reason it was written.
    const source = (await Bun.file(SCRIPT).text())
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(source).not.toContain("declare -A");
    expect(source).not.toMatch(/\$\{[A-Za-z_][A-Za-z0-9_]*,,\}/);
  });

  test("the hub unit runs it as ExecStartPost (§ 3.1)", async () => {
    // The script is only a bootstrap contract if something invokes it. Nothing
    // else in the repository would notice this line being dropped.
    const unit = await Bun.file(join(REPO_ROOT, "ops/systemd/agent-mesh-hub-lab.service")).text();
    expect(unit).toMatch(/^ExecStartPost=.*bootstrap-hub-service-identities\.sh$/m);
  });
});
