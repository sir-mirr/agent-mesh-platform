#!/usr/bin/env bun
/**
 * Bring a real mesh up for another repository's end-to-end runner.
 *
 * The client drives the cross-repository scenarios; this is the platform's side
 * of that contract. It starts the actual hub and http processes — not fakes —
 * on OS-assigned ephemeral ports, so a run never collides with a dev mesh or
 * with another run, and tears everything down on SIGTERM.
 *
 *   bun run e2e:harness -- --ready-file <path> [--state-dir <path>]
 *
 * The ready file is written **atomically**, once both services answer. A runner
 * can therefore watch for the file rather than poll a port and guess how long
 * to wait, and it will never read a half-written one:
 *
 *   { base_url, rpc_ws, api_http, admin_test_handle, state_dir, pid }
 *
 * `admin_test_handle` carries the credentials for the local admin account, so a
 * scenario can approve a key. That is the one thing a runner cannot do for
 * itself: § 10.2 puts approval behind the admin gate precisely so that a caller
 * cannot approve its own key, and a test that needs an approved key needs a way
 * through that gate rather than around it. **There is no test-only bypass on
 * the hub** — the handle is an ordinary login, and it exists only because this
 * script is the thing that knows the ephemeral port and the seeded password.
 */

import { spawn } from "bun";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

interface Args {
  readyFile: string;
  stateDir?: string;
  keep: boolean;
  /** SPEC § 17.4 — `MeshRequirement.receiveLeaseSeconds`. */
  receiveLeaseSeconds?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = { keep: false };

  /**
   * The value after a flag, refused when it is missing.
   *
   * `argv[++i]` is `string | undefined`, and assigning that straight through
   * made `--state-dir` with nothing after it mean "no state directory" rather
   * than an error — the harness would then invent a temporary one and remove it
   * on exit, so a runner that asked to keep state got a mesh whose files were
   * gone. `--ready-file` survived only because a later check happens to reject
   * a falsy value.
   *
   * This file was outside the typecheck until now, which is why an assignment
   * `exactOptionalPropertyTypes` exists to catch went uncaught.
   */
  const value = (flag: string, at: number): string => {
    const v = argv[at];
    if (v === undefined || v.startsWith("--")) {
      throw new Error(`${flag} needs a value`);
    }
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--ready-file":
        args.readyFile = value("--ready-file", ++i);
        break;
      case "--state-dir":
        args.stateDir = value("--state-dir", ++i);
        break;
      // Leave the state directory behind for inspection after a failure.
      case "--keep-state":
        args.keep = true;
        break;
      // A scenario carrying `mesh: { receiveLeaseSeconds }` (SPEC § 17.4) needs
      // a mesh shaped that way. A flag rather than leaving each runner to reach
      // for the environment variable: `client-claude` got there by exploiting
      // that `spawnService` merges `process.env`, which works and is *their*
      // method — two runners inventing two ways to satisfy one requirement are
      // no longer running the same scenario, which is the guarantee the shared
      // list exists for.
      case "--receive-lease-seconds": {
        const raw = value("--receive-lease-seconds", ++i);
        const n = Number(raw);
        // Rejected rather than defaulted. A typo that silently restores the
        // 30-second lease makes E2E-RECEIVE-002 pass by never reaching the
        // lapse it is about.
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error(`--receive-lease-seconds must be a positive number, got "${raw}"`);
        }
        args.receiveLeaseSeconds = n;
        break;
      }
      default:
        throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  if (!args.readyFile) {
    throw new Error("--ready-file is required: the runner watches it to know the mesh is up");
  }
  return args as Args;
}

/** Ask the OS for a port, then release it. */
function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolvePort(port));
    });
  });
}

const ADMIN_USER = "admin";
const ADMIN_PASSWORD = "admin";
const JWT_SECRET = "e2e-harness-secret";

const repoRoot = resolve(import.meta.dir, "..");

function spawnService(entry: string, env: Record<string, string>) {
  const proc = spawn({
    cmd: ["bun", join(repoRoot, entry)],
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  // Drained rather than inherited: a runner capturing this script's output
  // should see the harness's own lines, and a full pipe buffer would stall the
  // child it belongs to.
  const label = entry.includes("hub") ? "hub" : "http";
  // Decoded. A `Uint8Array` interpolated into a template string renders as its
  // comma-separated bytes, so a child that died printed its stack as four
  // thousand numbers — unreadable exactly when it is the only thing worth
  // reading.
  const decoder = new TextDecoder();
  void (async () => {
    for await (const chunk of proc.stdout) process.stdout.write(`[${label}] ${decoder.decode(chunk)}`);
  })();
  void (async () => {
    for await (const chunk of proc.stderr) process.stderr.write(`[${label}] ${decoder.decode(chunk)}`);
  })();
  return proc;
}

async function waitForHealth(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no attempt made";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await Bun.sleep(100);
  }
  throw new Error(`${url} did not become healthy within ${timeoutMs}ms (last: ${lastError})`);
}

/** Write through a temp file in the same directory, so a reader never sees a partial one. */
function writeAtomic(path: string, contents: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, contents);
  renameSync(tmp, path);
}

const args = parseArgs(process.argv.slice(2));
// Created, not assumed. `mkdtempSync` makes the directory when no path is
// given, so the flagged path was the only one that had to exist already — and
// when it did not, the services died on `SQLITE_CANTOPEN`, fifteen seconds
// before a health-check timeout that named the port instead of the directory.
const stateDir = args.stateDir ?? mkdtempSync(join(tmpdir(), "agent-mesh-e2e-"));
mkdirSync(stateDir, { recursive: true });

const hubPort = await freePort();
const httpPort = await freePort();
const shared = {
  AGENT_MESH_STATE_DIR: stateDir,
  ...(args.receiveLeaseSeconds !== undefined
    ? { AGENT_MESH_RECEIVE_LEASE_SECONDS: String(args.receiveLeaseSeconds) }
    : {}),
};

/**
 * Which checkout this mesh is running — **asked, not computed**.
 *
 * This used to shell out to `git` here. The hub now answers the same question on
 * `/api/v1/capabilities`, and two copies of one fact is how they come to
 * disagree: this one described the directory the *script* lives in, which is
 * only the same thing while nobody starts a service from anywhere else.
 * Somebody did — a long-running instance ran a branch ninety-three commits
 * behind `main` — and a harness computing its own answer would have reported
 * the wrong one confidently.
 *
 * Asking the process that is serving means the ready file says what *answered*,
 * which is the question a conformance report actually needs.
 */
async function provenance(base: string): Promise<Record<string, unknown>> {
  try {
    const res = await fetch(`${base}/api/v1/capabilities`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) return ((await res.json()) as { platform?: Record<string, unknown> }).platform ?? {};
  } catch {
    // A hub that cannot say is reported as not having said, rather than as
    // whatever this script would have guessed.
  }
  return { commit: "unknown" };
}

const hub = spawnService("packages/hub/src/main.ts", {
  ...shared,
  AGENT_MESH_HUB_PORT: String(hubPort),
  // § 8.2. The http server proxies for the people signed into it, and a
  // deployment declares that rather than the process asserting it.
  AGENT_MESH_PROXY_IDENTITIES: "http-server,http-server-dev",
  // The hub answers prepare_blobs with an absolute upload URL, and the route it
  // names is served by the other process. It cannot work the address out — http
  // connects to it, never the reverse — so the thing that chose both ports says
  // so.
  AGENT_MESH_BLOB_BASE_URL: `http://127.0.0.1:${httpPort}`,
});

let http: ReturnType<typeof spawnService> | null = null;
let shuttingDown = false;

function shutdown(code = 0): never {
  if (shuttingDown) process.exit(code);
  shuttingDown = true;
  http?.kill();
  hub.kill();
  rmSync(args.readyFile, { force: true });
  if (!args.stateDir && !args.keep) rmSync(stateDir, { recursive: true, force: true });
  process.exit(code);
}

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

try {
  await waitForHealth(`http://127.0.0.1:${hubPort}/health`);

  http = spawnService("packages/http/src/main.ts", {
    ...shared,
    AGENT_MESH_HTTP_PORT: String(httpPort),
    AGENT_MESH_HUB_URL: `ws://127.0.0.1:${hubPort}/ws`,
    JWT_SECRET,
  });
  await waitForHealth(`http://127.0.0.1:${httpPort}/api/v1/health`);

  writeAtomic(
    args.readyFile,
    `${JSON.stringify(
      {
        base_url: `http://127.0.0.1:${httpPort}`,
        rpc_ws: `ws://127.0.0.1:${hubPort}/ws`,
        api_http: `http://127.0.0.1:${hubPort}`,
        // **Which of the two above to call.** `api_http` is accurate from the
        // hub's side — it is where a signed `POST /api/v1/rpc` goes — and reads
        // from a browser's side as "the API I call", which it is not.
        //
        // A front end made exactly that mistake against the fixed ports and it
        // was caught by eye, because `3100` and `3000` reversed look wrong.
        // Here the ports are ephemeral, so `51234` and `51235` reversed look
        // like nothing at all. Naming the audience is cheaper than the
        // investigation that follows.
        //
        // Raised by `agent-mesh-local-pm` before it cost anybody anything
        // (mail #347), on the grounds that the notes already on
        // `admin_test_handle` had prevented a misreading the same day.
        addresses: {
          browser_and_admin: `http://127.0.0.1:${httpPort}`,
          agents_signed_rpc: `http://127.0.0.1:${hubPort}`,
          note: "Anything a person or an operator screen calls is base_url. api_http and rpc_ws are the agent-facing hub; a browser has no business there.",
        },
        // What this mesh is. A conformance report that quotes it is one the
        // other side can compare against; one that does not is a claim about an
        // unnamed checkout. See `provenance`.
        platform: await provenance(`http://127.0.0.1:${hubPort}`),
        // Echoed rather than assumed. A scenario asking for a two-second lease
        // and a harness that did not get the flag disagree silently otherwise,
        // and the scenario passes by never reaching the lapse it is about.
        mesh_config: {
          receive_lease_seconds: args.receiveLeaseSeconds ?? null,
        },
        admin_test_handle: {
          // An ordinary login against the seeded local account. Approval stays
          // behind the same gate it has in production — § 10.2 puts it there so
          // a caller cannot approve its own key, and a harness that bypassed it
          // would be testing a mesh nobody deploys.
          login_url: `http://127.0.0.1:${httpPort}/auth/local`,
          method: "POST",
          content_type: "application/x-www-form-urlencoded",
          body: `username=${ADMIN_USER}&password=${ADMIN_PASSWORD}`,
          // The login answers 302 and carries the session cookie on *that*
          // response. A client following redirects automatically consumes it
          // and ends up with nothing — send the request with redirects
          // disabled and read Set-Cookie from the 302.
          login_expect_status: 302,
          cookie_from: "Set-Cookie on the 302; do not follow redirects",
          approve_url: `http://127.0.0.1:${httpPort}/api/v1/admin/keys/approve`,
          deny_url: `http://127.0.0.1:${httpPort}/api/v1/admin/keys/deny`,
          revoke_url: `http://127.0.0.1:${httpPort}/api/v1/admin/keys/revoke`,
          pending_url: `http://127.0.0.1:${httpPort}/api/v1/admin/keys/pending`,
        },
        state_dir: stateDir,
        pid: process.pid,
      },
      null,
      2,
    )}\n`,
  );

  console.log(`[harness] hub ws://127.0.0.1:${hubPort}/ws  http http://127.0.0.1:${httpPort}`);
  console.log(`[harness] ready file ${args.readyFile}`);
  console.log(`[harness] state ${stateDir}`);
  console.log(`[harness] SIGTERM to stop`);
} catch (err) {
  console.error(`[harness] failed to start: ${err instanceof Error ? err.message : String(err)}`);
  shutdown(1);
}

// Nothing further to do; the services own the process from here. Exiting when
// either dies is deliberate — a runner watching this process learns that the
// mesh is gone rather than timing out against a port nobody is listening on.
const exited = await Promise.race([hub.exited, http!.exited]);
console.error(`[harness] a service exited (code ${exited}); shutting down`);
shutdown(exited === 0 ? 1 : (exited ?? 1));
