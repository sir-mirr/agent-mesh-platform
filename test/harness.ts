/**
 * Integration test harness.
 *
 * Starts the real services as child processes against a throwaway state
 * directory. They are spawned rather than imported because each entrypoint
 * calls `Bun.serve` at module scope — importing one would bind a port as a
 * side effect of loading it, and two tests could never run in the same
 * process.
 *
 * This exists because the bugs worth catching here are wiring bugs. Unit tests
 * cover the handlers; nothing covered the fact that they are reachable, that
 * the two services find each other, or that a page still renders after being
 * moved to another file.
 */

import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer as createNetServer } from "node:net";
import { generateKeyPairSync, randomUUID, sign as edSign } from "node:crypto";
import { keyFingerprint, requestSignaturePreimage } from "@agent-mesh/contracts";
import { join } from "node:path";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

export interface Service {
  port: number;
  url: string;
  /**
   * The process, so a test can end it the way something else would.
   *
   * `stop()` is the orderly exit this harness asks for; a timeout, an OOM or a
   * crash are not, and the difference is the whole subject of the announcement
   * below.
   */
  pid: number;
  /**
   * Why this service is gone, if it went without being asked — otherwise null.
   *
   * Read by every request helper before it dials, so a test that runs after
   * the death says what actually happened instead of `Unable to connect`.
   * The socket error is true and it describes the wrong subject: it reports
   * this test's failure to reach a port, when the fact is that a previous
   * test killed the server and this one measured nothing at all.
   *
   * That difference is what a rerun cannot recover. A flake and a real defect
   * both show as *n* failures; if the debris is indistinguishable from the
   * cause, a second real failure hiding in the debris is invisible, and the
   * rerun that would have separated them comes back red either way with
   * nothing to say about which.
   */
  died(): string | null;
  /** Everything the process wrote, for assertions and for failure output. */
  output(): string;
  stop(): void;
  /**
   * Resolves when the process is actually gone.
   *
   * `stop()` sends a signal, which is a request. Anything that reads the files
   * the process owns has to wait for this instead — a shutdown now checkpoints
   * its stores, so "killed" and "finished" are a real interval apart.
   */
  exited: Promise<number>;
}

export interface Mesh {
  hub: Service;
  http: Service;
  stateDir: string;
  stop(): void;
}

/**
 * Ports come from the OS rather than a fixed number so concurrent runs — and a
 * developer with a hub already running — do not collide.
 */
/**
 * A free port **on the address the health check will use**.
 *
 * `Bun.serve({ port: 0 })` binds every interface, so it reports a port free on
 * `0.0.0.0` — which says nothing about `127.0.0.1`, where a service started by
 * something else may already be listening. This test suite then started a hub
 * on that port, watched `http://127.0.0.1:<port>/health` answer `403`, and
 * failed with a timeout naming the port.
 *
 * The `403` is what identified it: nothing in the hub sends one on that route.
 * An Electron process was holding `127.0.0.1:57566` and answering instead.
 *
 * Probing on the same address the caller will use is the whole fix, and it is
 * what `scripts/e2e-harness.ts` has always done — which is why the flake
 * appeared here and never there.
 */
/**
 * A port the OS is not using, for a caller that has to name one.
 *
 * Exported because `fe-render.test.ts` had a fixed 3195 with `--strictPort`, so
 * two runs of the suite could not coexist: the second failed to bind and every
 * scenario after it failed to reach a server. A red run from two people testing
 * at once is indistinguishable from a red run from a defect.
 */
export function freePort(): Promise<number> {
  // **A listener, not a server.** `Bun.serve` needs a `fetch` handler, and that
  // handler is a function nothing can ever call: the port is bound to learn its
  // number and released in the next statement. It sat here as an uncovered
  // function with no way to reach it — which is the shape D-751 says to delete
  // rather than to hold. `node:net` binds without asking for one.
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : null;
      server.close(() => {
        if (port == null) reject(new Error("could not obtain an ephemeral port"));
        else resolve(port);
      });
    });
  });
}

/**
 * Wait for a port to answer, and say what it said if it never does.
 *
 * **Exported for its failure, not its success.** The sentence it throws is the
 * first thing a person reads when a suite goes red for a reason that is not the
 * code, and `bootRetryable` reads it too — it strips this exact wording to ask
 * whether the *child* said anything. Two readers of one string, and until this
 * was exported neither the wording nor the last error it carries had ever been
 * checked.
 */
export async function waitForHealth(
  url: string,
  timeoutMs = 15_000,
  /**
   * Why the process is gone, if it is — `Service.died()`.
   *
   * **Waiting fifteen seconds for a process that exited two hundred
   * milliseconds ago** is the difference between "the mesh could not start" and
   * "the mesh took too long", and only the first is true. Worse, the wait hides
   * what the child said: by the time this gives up, the reason has been sitting
   * in `output()` for the whole timeout. Asked every attempt, so a boot that
   * cannot happen fails in the time it takes to fail.
   */
  epitaph: () => string | null = () => null,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no attempt made";
  while (Date.now() < deadline) {
    const gone = epitaph();
    if (gone) throw new Error(`service at ${url} exited before it answered: ${gone}`);
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastError = `status ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await Bun.sleep(50);
  }
  throw new Error(`service at ${url} never became healthy: ${lastError}`);
}

function spawnService(
  entry: string,
  port: number,
  env: Record<string, string>,
): Omit<Service, "url"> {
  const chunks: string[] = [];
  const proc = Bun.spawn(["bun", join(REPO_ROOT, entry)], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });

  const drain = async (stream: ReadableStream<Uint8Array> | null) => {
    if (!stream) return;
    const decoder = new TextDecoder();
    for await (const chunk of stream) chunks.push(decoder.decode(chunk));
  };
  void drain(proc.stdout as ReadableStream<Uint8Array>);
  void drain(proc.stderr as ReadableStream<Uint8Array>);

  /**
   * Say so when a service dies on its own, and print what it said on the way
   * out.
   *
   * **Its output was captured and never read.** Every test after an early exit
   * fails with `Unable to connect`, which is true of the socket and says
   * nothing about why — so a suite where the hub crashed in test 6 shows
   * fifteen identical failures, none of them naming the crash, and the stack
   * trace that explains all fifteen sits in `chunks` where only a test that
   * thought to call `output()` would find it. Nothing did.
   *
   * `stopped` distinguishes the two exits that look identical from here: the
   * one `stop()` asked for at the end of a suite, and the one nobody asked
   * for.
   */
  void proc.exited.then((code) => {
    if (stopped) return;
    const said = chunks.join("").trimEnd();
    epitaph = `${entry} exited on its own (code ${code}, signal ${proc.signalCode ?? "none"}) before this test ran`;
    console.error(
      `\n─── ${entry} exited on its own (code ${code}, signal ${proc.signalCode ?? "none"}, port ${port}) ───\n` +
        `${said || "(it printed nothing)"}\n` +
        `─── every test after this one will fail to connect ───\n`,
    );
  });

  let stopped = false;
  let epitaph: string | null = null;
  return {
    port,
    pid: proc.pid,
    died: () => epitaph,
    output: () => chunks.join(""),
    exited: proc.exited,
    stop: () => {
      stopped = true;
      proc.kill();
    },
  };
}

/**
 * Give a spawned process an address that refuses to be used after it dies.
 *
 * **One place, because there is no other one.** Every way a test reaches a
 * service — the helpers below, and the raw `fetch` calls the suites make
 * directly — reads `service.url` first. Putting the check on that read covers
 * all of them; putting it in the helpers would cover most, and a log where
 * most of the debris explains itself and the rest still says `Unable to
 * connect` is a log a reader has to sort by hand, which is the cost this is
 * spent to remove.
 *
 * A throwing getter is unusual and this is the state that earns it: the
 * process is gone, so every subsequent request fails regardless, and the only
 * question left is whether the report names the death or the socket.
 */
function addressable(svc: Omit<Service, "url">, url: string): Service {
  return {
    ...svc,
    get url() {
      const epitaph = svc.died();
      if (epitaph) {
        throw new Error(
          `${epitaph} — this test reached nothing and measured nothing. ` +
            `It is a consequence of the earlier failure, not a finding of its own; ` +
            `look above for the banner naming the exit.`,
        );
      }
      return url;
    },
  };
}

export interface StartOptions {
  /** Skip the http server when a test only needs the hub. */
  withHttp?: boolean;
  env?: Record<string, string>;
}

/** Start a mesh on a fresh state directory. Always pair with `stop()`. */
async function startMeshOnce(opts: StartOptions = {}): Promise<Mesh> {
  const withHttp = opts.withHttp ?? true;
  const stateDir = mkdtempSync(join(tmpdir(), "agent-mesh-it-"));
  const hubPort = await freePort();

  const shared = { AGENT_MESH_STATE_DIR: stateDir, ...opts.env };

  // Chosen before the hub starts, because the hub has to be told where blob
  // uploads are served — it names an absolute URL on a route the other process
  // owns, and cannot discover that address for itself.
  const httpPort = withHttp ? await freePort() : 0;

  const hubProc = spawnService("packages/hub/src/main.ts", hubPort, {
    ...shared,
    AGENT_MESH_HUB_PORT: String(hubPort),
    AGENT_MESH_BLOB_BASE_URL: `http://127.0.0.1:${httpPort}`,
    // § 8.2. The http server proxies for the people signed into it, and a
    // deployment declares that rather than the process asserting it.
    AGENT_MESH_PROXY_IDENTITIES: "http-server,http-server-dev",
  });
  const hub: Service = addressable(hubProc, `http://127.0.0.1:${hubPort}`);

  let http: Service;
  let httpProc: ReturnType<typeof spawnService> | undefined;
  try {
    await waitForHealth(`${hub.url}/health`, 15_000, () => hubProc.died());

    if (withHttp) {
      httpProc = spawnService("packages/http/src/main.ts", httpPort, {
        ...shared,
        AGENT_MESH_HTTP_PORT: String(httpPort),
        AGENT_MESH_HUB_URL: `ws://127.0.0.1:${hubPort}/ws`,
        // Startup fails without one, and a fixed value keeps issued cookies
        // reproducible across a test run.
        JWT_SECRET: "integration-test-secret",
        // § 15.2. Small, because the refusal path is only reachable by
        // exceeding it and a test that must send ten megabytes to get there is
        // one that gets skipped.
        AGENT_MESH_UPLOAD_MAX_BYTES: "65536",
      });
      http = addressable(httpProc, `http://127.0.0.1:${httpPort}`);
      await waitForHealth(`${http.url}/api/v1/health`, 15_000, () => httpProc!.died());

      /**
       * Past the first-login password gate, in the file rather than through the
       * product.
       *
       * The seeded account is created with `must_change_password`, so a session
       * that has not changed it is refused everywhere but three routes
       * (§ I-085). Every suite here wants the session after that point.
       *
       * **Cleared, not performed.** Doing the change for real would rotate the
       * password out from under the twenty-odd tests that sign in with
       * `admin`/`admin` themselves, and the harness would be deciding what
       * their credentials are. The gate has its own tests; this is a fixture
       * standing where a first login already happened.
       */
      const httpDb = new Database(join(stateDir, "agent-mesh.db"));
      httpDb.prepare(`UPDATE local_users SET must_change_password = 0`).run();
      httpDb.close();
    } else {
      http = absentService();
    }
  } catch (err) {
    // Surface what the process said; a bare timeout tells you nothing.
    //
    // **Both of them.** This appended the hub's output alone, so an http server
    // that died on startup was reported with the hub's healthy log underneath
    // it — and the retry above, which reads this message for the port-taken
    // line, could only ever see half the races.
    hubProc.stop();
    httpProc?.stop();
    const said = err instanceof Error ? err.message : String(err);
    throw new Error(bootFailureMessage(said, hubProc.output(), httpProc ? httpProc.output() : null));
  }

  return {
    hub,
    http,
    stateDir,
    /**
     * Stop both services and remove the state directory — in that order, which
     * it was not.
     *
     * The removal used to run on the line after the kills, while both processes
     * were still shutting down. That shutdown now checkpoints their stores, so
     * the removal races two writers into the files it is deleting: on POSIX the
     * open descriptors outlive the unlink, nothing errors, and what is left
     * behind is a directory that may or may not still exist.
     *
     * Deliberately still synchronous. Every caller is an `afterEach` that does
     * not await, and making them would be a large edit for a cleanup nobody
     * observes; ordering the removal behind the exits fixes the race without
     * asking anyone to wait for it.
     */
    stop() {
      const gone = Promise.all([http.exited, hub.exited]);
      http.stop();
      hub.stop();
      void removeStateDirWhenGone(gone, stateDir);
    },
  };
}

/** Provision an identity, which every connecting agent must have (SPEC § 8.1). */
/** A real Ed25519 public key, base64url — SPKI wraps the raw 32 bytes. */
/**
 * The same, retried when another process took the port between choosing it and
 * binding it.
 *
 * `freePort` binds an ephemeral port, reads its number and lets it go, so the
 * number is free at the instant it is returned and not a moment longer. One
 * suite alone never loses that gap. Two — this one and a second checkout's,
 * which is the ordinary state of this machine — do, and the child then exits
 * saying the port is taken, while every test in the file reports `Unable to
 * connect`.
 *
 * That is not merely a red file. `bun test` counted such a run as **`1 fail`**
 * while thirty tests in `audit.test.ts` never ran at all, so the number at the
 * bottom of the suite was smaller than it looked and said nothing about it.
 *
 * Narrow on purpose: only an exit that says the port was taken is retried. A
 * service that crashes for its own reasons must still fail loudly and once.
 *
 * **Matched against what the runtime actually prints**, which is not the errno.
 * This read the message for `EADDRINUSE` and could never have fired: Bun says
 *
 *     error: Failed to start server. Is port 60147 in use?
 *
 * and never the name. That line is from a real failure of this harness, not
 * from a guess about one — the first version of this retry was written against
 * a token no service in this tree emits, and shipped looking like a guard.
 */
export const PORT_TAKEN = /EADDRINUSE|Failed to start server|address (already )?in use/i;

/**
 * What a boot that never came up says on the way out.
 *
 * **Both children, always.** This appended the hub's output alone, so an http
 * server that died on startup was reported with the hub's healthy log
 * underneath it — and `bootRetryable` reads this same string to decide whether
 * the failure is worth another port, so half the races it exists for were
 * invisible to it. The two are tested against each other for that reason.
 *
 * `null` for the http output rather than an empty string: a mesh that never got
 * as far as starting an http server is a different report from one whose http
 * server started and said nothing, and an empty section reads as the second.
 */
export function bootFailureMessage(said: string, hubOutput: string, httpOutput: string | null): string {
  const httpSaid = httpOutput === null ? "" : `\n--- http output ---\n${httpOutput}`;
  return `${said}\n--- hub output ---\n${hubOutput}${httpSaid}`;
}

/**
 * The harness's own wrapper around a boot that never answered.
 *
 * Stripped before asking whether the *child* said anything, because this
 * sentence is the harness's opinion and not the service's.
 */
const NEVER_HEALTHY = /service at \S+ never became healthy:[^\n]*/g;

/**
 * The section labels this file puts around the children's output.
 *
 * **Stripped for the same reason as the sentence above, and finding that out
 * cost a dead branch.** `bootRetryable` is handed the message
 * `bootFailureMessage` builds, and that message always carries at least
 * `--- hub output ---`. So *the child said nothing* — the case the silence rule
 * exists for, and the one its own comment describes — could not be reached from
 * the path that calls it: what was left after stripping was the harness's own
 * headers, which trim to something rather than to nothing. The rule was tested
 * against `""` and `"   \n\n  "`, which are shapes it is never handed.
 */
const HARNESS_SECTIONS = /^--- (?:hub|http) output ---$/gm;

/**
 * What the kernel says when it refused *the harness* a resource, rather than
 * anything a service said.
 *
 * `EBADF: bad file descriptor, epoll_ctl` out of `Bun.spawn` is the one this
 * was written for: the spawn never happened, so no child had an opinion about
 * anything, and the whole file it was booting for fails with a message about a
 * file descriptor. It is not slowness and it is not silence — the two cases
 * below — it is the machine refusing, which is transient by nature and never a
 * statement about this repository's code. The neighbours are here for the same
 * reason: a run that exhausts the fd table (`EMFILE`, `ENFILE`) or the process
 * table has said nothing about the mesh either.
 */
export const SPAWN_REFUSED = /\b(EBADF|EMFILE|ENFILE|EAGAIN|ENOMEM)\b/;

/**
 * Is a failed boot worth another port, or is it the answer?
 *
 * **A guard only makes a denominator out of what it recognises.** This retried
 * on `PORT_TAKEN` alone, so the only boot failure it could ever see was one
 * that named a port — and `freePort` is bind-then-release, which means the
 * race it exists for is won by whoever binds first and lost by whoever is
 * *slow*. A machine deep in swap boots `bun` past the ten-second health wait
 * and prints nothing about ports at all, so the retry never ran and the run
 * failed once, loudly, for a reason that had nothing to do with the code.
 * `agent-mesh-local-pm` measured the shape of it: a 10 870 ms failure against
 * a 200 x 50 ms wait, with no port message anywhere in the output.
 *
 * **Silence is the signal, not slowness.** A service that refuses says why —
 * that is exactly what `misconfigured-boot.test.ts` asserts of two of them —
 * so a child that exits having said nothing never reached the point of having
 * an opinion. Retrying a refusal would turn those two checks green against a
 * server that had stopped refusing; retrying silence cannot, because silence
 * is not something any of them assert.
 */
export function bootRetryable(said: string): boolean {
  if (SPAWN_REFUSED.test(said)) return true;
  if (PORT_TAKEN.test(said)) return true;
  return said.replace(NEVER_HEALTHY, "").replace(HARNESS_SECTIONS, "").trim() === "";
}

/** The removal itself, so a test can let the real one run against a real
 *  directory while the cases about failing to remove inject their own. */
export const removeStateDir = (dir: string): void => rmSync(dir, { recursive: true, force: true });

/**
 * Remove a mesh's state directory once both processes are gone, and say so
 * when it cannot be removed.
 *
 * This was `.catch(() => {})` on the end of the same promise chain: an empty
 * handler, which is both a swallow and — because it holds no statement — a
 * function no diagnostic can name when it turns out never to run. What it
 * swallowed is a run leaving its temporary directory behind, one per mesh,
 * silently, on the machine that is already low on the disk the suite filled.
 * Reporting it is not the repair — the directory is still there — it is the
 * difference between finding out now and finding out from `df`.
 *
 * The `await` covers the same ground the old `.catch` did: neither `exited`
 * promise is expected to reject, and an unhandled rejection out of a `stop()`
 * nobody awaits would land in whatever test is running five seconds later.
 */
export async function removeStateDirWhenGone(
  gone: Promise<unknown>,
  dir: string,
  remove: (dir: string) => void = removeStateDir,
  warn: (message: string) => void = console.warn.bind(console),
): Promise<void> {
  try {
    await gone;
    remove(dir);
  } catch (err) {
    warn(`harness: ${dir} was left behind: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * The `http` a hub-only mesh carries.
 *
 * `withHttp: false` still hands callers a `Service`, because the alternative is
 * every consumer of `mesh.http` learning that it might be absent — and the
 * suites that use it (`bootstrap.test.ts`) are about the hub coming up alone,
 * not about optional fields.
 *
 * **It answers like a service that has already stopped**, which is the whole
 * contract: `died()` says nothing died, `output()` has nothing to show,
 * `exited` is already resolved so a caller ordering cleanup behind the exits is
 * not left waiting on a process that never started, and `stop()` is a no-op
 * rather than a throw. Extracted so those four answers can be checked without
 * spawning a hub to reach them — as an object literal inside the boot they were
 * built by every hub-only suite and called by none.
 */
export function absentService(): Service {
  return {
    port: 0,
    url: "",
    pid: 0,
    died: () => null,
    output: () => "",
    exited: Promise.resolve(0),
    stop: () => {},
  };
}

/**
 * Three attempts at a mesh, and the policy for when a second one is honest.
 *
 * `boot` is a parameter so the policy can be exercised without booting
 * anything. It decides whether a red run is a flake or a defect, which is the
 * one judgement in this file that a person acts on without reading — and until
 * it was a parameter, the only way to see a retry happen was to lose the race
 * it exists for.
 */
export async function startMesh(
  opts: StartOptions = {},
  boot: (o: StartOptions) => Promise<Mesh> = startMeshOnce,
): Promise<Mesh> {
  let last: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await boot(opts);
    } catch (err) {
      last = err;
      const said = err instanceof Error ? err.message : String(err);
      if (!bootRetryable(said)) throw err;
      // Printed rather than swallowed: the next person to meet this window
      // should not have to reconstruct what the boot said from its timing.
      //
      // **The kernel's refusals are named as their own thing**, because a
      // retry that absorbs them quietly is how a machine that has started
      // refusing spawns looks exactly like a machine that is merely busy. The
      // two are repaired in different places — one by taking another port, the
      // other by the runner having fewer things open — and a log line saying
      // *port* about an `EBADF` sends the reader to the wrong one.
      const refused = SPAWN_REFUSED.exec(said)?.[1];
      console.error(
        refused
          ? `[harness] the spawn was refused with ${refused} (attempt ${attempt}/3); trying again. said: ${JSON.stringify(said.slice(0, 400))}`
          : `[harness] boot did not answer (attempt ${attempt}/3); taking another port. said: ${JSON.stringify(said.slice(0, 400))}`,
      );
    }
  }
  throw last;
}

export interface KeyPair {
  /** Raw Ed25519 public key, base64url — what `public_key` carries. */
  publicKey: string;
  /** node:crypto key object, for signing. */
  privateKey: import("node:crypto").KeyObject;
  fingerprint: string;
}

/**
 * A real key pair. The fingerprint comes from contracts, not from a local
 * computation — a test that derived it its own way would pass while disagreeing
 * with the hub about what it is verifying.
 */
export function newKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const raw = Buffer.from(der.subarray(der.length - 32)).toString("base64url");
  return { publicKey: raw, privateKey, fingerprint: keyFingerprint(raw) };
}

export function newPublicKey(): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return Buffer.from(der.subarray(der.length - 32)).toString("base64url");
}

/**
 * Register an identity.
 *
 * A key is generated when the type needs one and the caller did not supply one,
 * because that is what a real client does — an `ai-*` runtime holds a key, and
 * SPEC § 10.1 refuses to provision such a type without it. Making every test
 * that merely needs an agent to exist carry key material would be noise, and
 * would have obscured the tests that are actually about keys.
 *
 * `requiresKey` is inferred from the type prefix rather than read from the
 * registry: the hub is the authority and a test that guesses wrong gets a `400`
 * naming the reason, which is a clear enough failure.
 */
export async function provision(
  hub: Service,
  identity: string,
  type = "service",
  description: string | null = null,
  publicKey?: string,
): Promise<Response> {
  const key = publicKey ?? (type.startsWith("ai-") ? newPublicKey() : undefined);
  return fetch(`${hub.url}/api/v1/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity, type, description, ...(key ? { public_key: key } : {}) }),
  });
}

/**
 * Register an identity that may speak for others (SPEC § 8.2).
 *
 * Separate from `provision` because the grant is deliberately not something a
 * caller gets by default — an identity that has not been given it cannot claim
 * anyone, which is the point of the column.
 */
export async function provisionProxy(
  hub: Service,
  identity: string,
  type = "service",
  http?: Service,
): Promise<Response> {
  // § 8.2. Provisioning no longer accepts `can_proxy` — the route is
  // unauthenticated, so a grant made there is one the checked party wrote for
  // itself. Register, then grant as an operator, which is what a deployment
  // does.
  const created = await fetch(`${hub.url}/api/v1/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity, type }),
  });
  if (!created.ok) return created;
  // Two calls, deliberately visible. The grant is an operator action and the
  // registration is not, and collapsing them back into one would restore the
  // shape § 8.2 refuses.
  if (http) await grantProxy(http, identity);
  return created;
}

/** Grant or withdraw `can_proxy` the way an operator does (SPEC § 8.2). */
export async function setProxyGrant(
  http: Service,
  identity: string,
  canProxy: boolean,
  cookie?: string,
): Promise<Response> {
  const session = cookie ?? (await loginAsAdmin(http));
  return fetch(`${http.url}/api/v1/admin/agents/${encodeURIComponent(identity)}/can-proxy`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: session },
    body: JSON.stringify({ can_proxy: canProxy }),
  });
}

/** Grant it. */
export const grantProxy = (http: Service, identity: string, cookie?: string) =>
  setProxyGrant(http, identity, true, cookie);

export interface RpcClient {
  raw(text: string): void;
  /** Send a request and wait for the response with a matching id. */
  call(method: string, params: unknown, sigOverride?: Record<string, unknown>): Promise<any>;
  /** Server-pushed notifications received so far (SPEC § 8.8). */
  notifications(): any[];
  /**
   * The close code the hub sent, waiting up to `timeoutMs` for it.
   *
   * **The refusals in § 8.1 do not only answer — they close**, about ten
   * milliseconds later, and nothing here could observe that. A hub that
   * returned `-32014` and then held the socket open forever satisfied every
   * check in this repository, because the error is the message and the close is
   * the enforcement, and only the message was reachable.
   *
   * Resolves `null` on timeout rather than throwing: "it did not close" is an
   * answer a scenario may want to assert, and an exception would make it
   * indistinguishable from a broken runner.
   */
  closed(timeoutMs?: number): Promise<number | null>;
  close(): void;
}

/** Open a hub WebSocket and correlate responses by JSON-RPC id. */
/**
 * Call the hub over HTTP, the way a participant that cannot hold a socket does
 * (SPEC § 8.10).
 *
 * Signs over one serialisation and splices those exact bytes into the frame, as
 * the socket client does — assembling the envelope with JSON.stringify would
 * re-serialise the params and sign bytes the hub never receives.
 */
export async function callHttp(
  hub: Service,
  signer: Signer,
  method: string,
  params: unknown,
): Promise<{ status: number; body: any }> {
  const rawParams = JSON.stringify(params ?? {});
  const nonce = randomUUID();
  const iat = Math.floor(Date.now() / 1000);
  const value = Buffer.from(
    edSign(
      null,
      Buffer.from(
        requestSignaturePreimage({
          method,
          kid: signer.kid,
          nonce,
          iat,
          rawParams: new TextEncoder().encode(rawParams),
        }),
      ),
      signer.privateKey,
    ),
  ).toString("base64url");
  const sig = JSON.stringify({ alg: "ed25519", kid: signer.kid, nonce, iat, value });

  const res = await fetch(`${hub.url}/api/v1/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: `{"jsonrpc":"2.0","id":1,"method":${JSON.stringify(method)},"params":${rawParams},"sig":${sig}}`,
  });
  // Parsed defensively, and the failure names the response.
  //
  // `await res.json()` on a plain-text body throws a bare `SyntaxError` from
  // this line, which sends a reader to the harness rather than to the route
  // that answered. That is the right verdict reached by accident and reported
  // at the wrong address — a route moved out from under a caller looks like a
  // parser bug.
  const text = await res.text();
  return rpcAnswer(method, res.status, text);
}

/**
 * A response body, or a sentence naming the route that did not send one.
 *
 * The failure is the point. `await res.json()` on a plain-text body throws a
 * bare `SyntaxError`, which sends the reader to the harness rather than to the
 * route that answered — the right verdict at the wrong address, and a route
 * moved out from under a caller then looks like a parser bug. The status and
 * the first two hundred characters are what say which it is.
 */
export function rpcAnswer(method: string, status: number, text: string): { status: number; body: any } {
  try {
    return { status, body: JSON.parse(text) };
  } catch {
    throw new Error(
      `POST /api/v1/rpc (${method}) answered ${status} with a body that is not JSON: ${text.slice(0, 200)}`,
    );
  }
}

export interface Signer {
  /** Fingerprint of the key, as `sig.kid`. */
  kid: string;
  privateKey: import("node:crypto").KeyObject;
}

export async function connectRpc(
  hub: Pick<Service, "port">,
  signer?: Signer,
  /**
   * How long a call waits before giving up.
   *
   * A parameter so the giving-up can be watched. Reaching it otherwise means a
   * hub that accepts a socket and answers nothing for five seconds, which is a
   * five-second test — so nothing ever ran the line, and "no response" is
   * exactly the sentence somebody reads when a suite goes red at 3am.
   */
  timeoutMs = 5_000,
): Promise<RpcClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/ws`);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("websocket failed to open"));
  });

  let nextId = 1;
  const pending = new Map<number, (value: any) => void>();
  const pushed: any[] = [];

  let closeCode: number | null = null;
  const closeWaiters: Array<(code: number) => void> = [];
  ws.onclose = (event) => {
    closeCode = event.code;
    for (const waiter of closeWaiters.splice(0)) waiter(event.code);
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)!(msg);
      pending.delete(msg.id);
    } else {
      pushed.push(msg);
    }
  };

  /**
   * Build the wire text, signing over the exact bytes that go out.
   *
   * `params` is serialised once and spliced into the envelope as text.
   * Assembling the envelope with JSON.stringify would re-serialise it, and the
   * preimage would then cover bytes the hub never received — the failure is
   * intermittent, because it depends on what each serialiser happens to emit.
   */
  function frame(id: number, method: string, params: unknown, override?: Partial<Record<string, unknown>>): string {
    const rawParams = JSON.stringify(params ?? {});
    if (!signer) {
      return `{"jsonrpc":"2.0","id":${id},"method":${JSON.stringify(method)},"params":${rawParams}}`;
    }
    const nonce = randomUUID();
    const iat = Math.floor(Date.now() / 1000);
    const sig = {
      alg: "ed25519",
      kid: signer.kid,
      nonce,
      iat,
      value: Buffer.from(
        edSign(
          null,
          Buffer.from(
            requestSignaturePreimage({
              method,
              kid: signer.kid,
              nonce,
              iat,
              rawParams: new TextEncoder().encode(rawParams),
            }),
          ),
          signer.privateKey,
        ),
      ).toString("base64url"),
      ...override,
    };
    return `{"jsonrpc":"2.0","id":${id},"method":${JSON.stringify(method)},"params":${rawParams},"sig":${JSON.stringify(sig)}}`;
  }

  return {
    call(method, params, override?: Record<string, unknown>) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`no response to ${method} within ${timeoutMs}ms`)),
          timeoutMs,
        );
        pending.set(id, (value) => {
          clearTimeout(timer);
          resolve(value);
        });
        ws.send(frame(id, method, params, override));
      });
    },
    /** Send a hand-built frame — for asserting on tampering. */
    raw(text: string) {
      ws.send(text);
    },
    notifications: () => [...pushed],
    closed(timeoutMs = 2_000) {
      if (closeCode !== null) return Promise.resolve(closeCode);
      return new Promise<number | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        closeWaiters.push((code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });
    },
    close: () => ws.close(),
  };
}

/**
 * The session cookie a sign-in produced, or a sentence saying there is none.
 *
 * **A 302 is not a session.** Reading the redirect as success cost an hour of
 * somebody's night: the account did not exist, the route redirected anyway, and
 * every later request went out with no cookie and came back 401 from somewhere
 * else entirely. The cookie, and specifically `mesh_token=`, is the thing that
 * says it worked.
 *
 * There were four copies of this rule and they had already drifted apart. This
 * one threw only when there was no `Set-Cookie` header at all, so any cookie
 * counted as a session; the first sign-in inside `provision` checked nothing
 * and let an empty string travel on to fail the password change with a 401 that
 * named neither cause. One copy remains, in `scripts/fixtures/fe-screens.ts` —
 * a standalone fixture script that imports nothing from here, and importing the
 * harness into it would drag two spawned services behind one string check.
 */
export function sessionCookie(who: string, status: number, setCookie: string | null): string {
  const cookie = (setCookie ?? "").split(";")[0] ?? "";
  if (!cookie.startsWith("mesh_token=")) {
    throw new Error(`${who} could not sign in: ${status}, no mesh_token`);
  }
  return cookie;
}

/**
 * The seeded administrator's username (T-026).
 *
 * `platform-admin`, because the account administers the installation rather
 * than a tenant.
 *
 * **Spelled here rather than imported**, and checked rather than trusted.
 * `test/` reaches into `packages/` through the barrel exactly once
 * (`test/import-graph.test.ts`), so importing `packages/http/src/db` for one
 * string would be a second edge across that boundary. `http.test.ts` reads
 * `SEED_ADMIN_USERNAME` out of the source and asserts it is this — which is
 * the drift a second copy would otherwise cause, caught at the one place the
 * two can be compared.
 */
export const SEED_ADMIN = "platform-admin";

/** Log in as the seeded local admin and return the session cookie. */
export async function loginAsAdmin(http: Service): Promise<string> {
  const res = await fetch(`${http.url}/auth/local`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `username=${encodeURIComponent(SEED_ADMIN)}&password=admin`,
    redirect: "manual",
  });
  return sessionCookie(SEED_ADMIN, res.status, res.headers.get("set-cookie"));
}

/** Tear down an identity the way an operator does — § 9.3, admin session. */
export async function teardown(
  http: Service,
  identity: string,
  cookie?: string,
): Promise<{ status: number; body: any }> {
  const session = cookie ?? (await loginAsAdmin(http));
  const res = await fetch(`${http.url}/api/v1/admin/agents/${encodeURIComponent(identity)}`, {
    method: "DELETE",
    headers: { cookie: session },
  });
  return { status: res.status, body: await res.json() };
}

/**
 * The login `capabilityViewer` gives an account holding exactly these.
 *
 * Exported because a browser scenario has to *find that account's row* — the
 * cookie says who you are signed in as, and says nothing about which row on a
 * matrix belongs to them. `SC-WRITE-07` picked "the first chip on the page"
 * instead, which is the seeded administrator's, whose chips are deliberately
 * unclickable: the click did nothing, the wait for a toast ran its full thirty
 * seconds, and bun killed the browser out from under the forty-seven scenarios
 * that had not run yet.
 */
export function capabilityViewerName(...capabilities: string[]): string {
  return `viewer-${capabilities.join("-").replace(/[^a-z]+/g, "-")}`;
}

/**
 * A signed-in account holding exactly the capabilities named, and no others.
 *
 * **§ 11's middle states had no caller.** Every gate has three outcomes — no
 * session, a session without the capability, a session with it — and only the
 * outer two could be produced: `admin` holds everything (`LEGACY_ADMIN_
 * CAPABILITIES` is `ALL_CAPABILITIES`) and a stranger holds nothing. So the
 * behaviour a route is *for*, the one it advertises to a partially-privileged
 * operator, was unreachable by construction.
 *
 * The username is the subject: `/auth/local` writes it into `users` as
 * `github_login`, and `requireCapability` reads exactly that.
 *
 * **It goes through the routes, all of it.** This used to write `local_users`
 * directly, with a comment saying no route created one. That stopped being true
 * the day `POST /api/v1/admin/users` landed, and the difference was not
 * cosmetic: `seedLocalUsers` approves every local account it finds **at boot**,
 * so a row inserted while the server is already up is never approved, and
 * `isUserApproved` — which reads `agent_registry`, never `users.approved` — says
 * no. Every viewer built that way was a member the signup path could not
 * produce, and checks counting rows on their screens were counting an empty
 * page. `agent-mesh-local-pm` measured it twice (mail #1104) while I argued from
 * a column the gate does not read.
 */
/**
 * Whether an admission opened an account, and what a refusal means.
 *
 * **Both refusals come from a live route**, which is what makes them this
 * harness's business rather than the server's: `409` is the account already
 * being there, which every second run of a file produces, and anything else is
 * a mesh that did not admit and did not say `409`. The second used to be a
 * branch inside `capabilityViewer` that only a broken deployment could reach,
 * so it had never run — and the sentence it throws is the whole of what a
 * person sees when the harness gives up.
 *
 * The response itself comes in, and the body is read here rather than at the
 * call site — on the reporting path only, so the success path does not consume
 * a stream it does not need. It used to arrive as a `() => admitted.text()`
 * beside the call, which put that read in an arrow no passing run executes.
 */
export async function admissionOpened(
  username: string,
  admitted: { ok: boolean; status: number; text: () => Promise<string> },
): Promise<boolean> {
  if (admitted.ok) return true;
  if (admitted.status === 409) return false;
  // The response itself, not a `() => admitted.text()` at the call site. A
  // forwarding arrow is a function too, and one that only runs when admission
  // fails is a function no passing run executes — which is how this line came
  // to be the last uncovered one in the harness. Taking the response moves the
  // read in here, where the failure case is a unit test's argument.
  throw new Error(`admitting ${username} answered ${admitted.status}: ${await admitted.text()}`);
}

/**
 * The password gate, which a new account has to walk out of before anything
 * else opens. A non-200 here means the account exists and cannot be used, and
 * every later failure in that file would be about a session that was never
 * issued — which is why it stops here, naming the status.
 */
export function leftThePasswordGate(username: string, status: number): void {
  if (status !== 200) {
    throw new Error(`${username} could not leave the password gate: ${status}`);
  }
}

export async function capabilityViewer(
  mesh: Mesh,
  ...capabilities: string[]
): Promise<string> {
  const username = capabilityViewerName(...capabilities);
  const password = `${username}-password`;
  const admin = await loginAsAdmin(mesh.http);

  const admitted = await fetch(`${mesh.http.url}/api/v1/admin/users`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: admin },
    body: JSON.stringify({ username, display_name: username, role: "member" }),
  });
  // **201, not 200.** The route answers Created, and a check for 200 sent every
  // first admission down the error path — caught by printing the body in the
  // message rather than the status alone.
  if (await admissionOpened(username, admitted)) {
    // Admission hands back a password that must be changed before anything else
    // opens, which is the first thing a real account does.
    const { temporary_password: temporary } = (await admitted.json()) as { temporary_password: string };
    const first = await fetch(`${mesh.http.url}/auth/local`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ username, password: temporary }),
      redirect: "manual",
    });
    const firstCookie = sessionCookie(username, first.status, first.headers.get("set-cookie"));
    const changed = await fetch(`${mesh.http.url}/auth/local/password`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: firstCookie },
      body: JSON.stringify({ current: temporary, next: password }),
    });
    leftThePasswordGate(username, changed.status);
  }

  for (const capability of capabilities) {
    const res = await fetch(`${mesh.http.url}/api/v1/admin/grants`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: admin },
      body: JSON.stringify({ subject: username, capability, scope: "*" }),
    });
    if (res.status >= 400) throw new Error(`granting ${capability} answered ${res.status}`);
  }

  const login = await fetch(`${mesh.http.url}/auth/local`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
    redirect: "manual",
  });
  return sessionCookie(username, login.status, login.headers.get("set-cookie"));
}

/**
 * Open a store the way the services open one.
 *
 * The pragma is the whole point. `openAt` in `@agent-mesh/store` sets
 * `busy_timeout = 5000` because writes across processes serialise and, without
 * it, a collision is an immediate `SQLITE_BUSY` rather than a short wait. This
 * tree deliberately does not import that package — it drives real processes
 * over the wire, and pulling the store's source in breaks that boundary and the
 * build with it (see the comment above `withDb` in `keys.test.ts`) — so the
 * value is declared once here instead of at forty-odd call sites.
 *
 * **Readers need it too, now.** In WAL a reader never blocked behind a writer,
 * which is why this was survivable; but a shutdown now ends with
 * `wal_checkpoint(TRUNCATE)`, and that takes an exclusive lock. A test reading
 * a store while some mesh is stopping is a collision that did not exist before
 * the checkpoint did.
 */
export function openTestDb(path: string, opts?: ConstructorParameters<typeof Database>[1]): Database {
  const db = new Database(path, opts);
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}
