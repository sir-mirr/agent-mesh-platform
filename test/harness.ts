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
export async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = server.port;
  server.stop(true);
  if (port == null) throw new Error("could not obtain an ephemeral port");
  return port;
}

async function waitForHealth(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no attempt made";
  while (Date.now() < deadline) {
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
    await waitForHealth(`${hub.url}/health`);

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
      await waitForHealth(`${http.url}/api/v1/health`);
    } else {
      http = {
        port: 0,
        url: "",
        pid: 0,
        died: () => null,
        output: () => "",
        // Already gone, so a caller ordering cleanup behind the exits is not
        // left waiting on a service this mesh never started.
        exited: Promise.resolve(0),
        stop: () => {},
      };
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
    const httpSaid = httpProc ? `\n--- http output ---\n${httpProc.output()}` : "";
    throw new Error(`${said}\n--- hub output ---\n${hubProc.output()}${httpSaid}`);
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
      void gone.then(() => rmSync(stateDir, { recursive: true, force: true })).catch(() => {});
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

export async function startMesh(opts: StartOptions = {}): Promise<Mesh> {
  let last: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await startMeshOnce(opts);
    } catch (err) {
      last = err;
      const said = err instanceof Error ? err.message : String(err);
      if (!PORT_TAKEN.test(said)) throw err;
      console.error(`[harness] lost the port race (attempt ${attempt}/3); taking another port`);
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
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    throw new Error(
      `POST /api/v1/rpc (${method}) answered ${res.status} with a body that is not JSON: ${text.slice(0, 200)}`,
    );
  }
}

export interface Signer {
  /** Fingerprint of the key, as `sig.kid`. */
  kid: string;
  privateKey: import("node:crypto").KeyObject;
}

export async function connectRpc(hub: Service, signer?: Signer): Promise<RpcClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/ws`);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("websocket failed to open"));
  });

  let nextId = 1;
  const pending = new Map<number, (value: any) => void>();
  const pushed: any[] = [];

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
          () => reject(new Error(`no response to ${method} within 5s`)),
          5_000,
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
    close: () => ws.close(),
  };
}

/** Log in as the seeded local admin and return the session cookie. */
export async function loginAsAdmin(http: Service): Promise<string> {
  const res = await fetch(`${http.url}/auth/local`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "username=admin&password=admin",
    redirect: "manual",
  });
  const cookie = res.headers.get("set-cookie");
  if (!cookie) throw new Error(`login returned no cookie (status ${res.status})`);
  return cookie.split(";")[0]!;
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
 * `local_users` is written directly because no route creates one. That is the
 * only place this harness reaches past the API, and it is here rather than
 * scattered so a reader can see the whole of it.
 */
export async function capabilityViewer(
  mesh: Mesh,
  ...capabilities: string[]
): Promise<string> {
  const username = `viewer-${capabilities.join("-").replace(/[^a-z]+/g, "-")}`;
  // The http server is serving from this file while this writes to it.
  const db = openTestDb(join(mesh.stateDir, "agent-mesh.db"), { readwrite: true });
  if (!db.prepare("SELECT 1 FROM local_users WHERE username = ?").get(username)) {
    db.prepare(
      "INSERT INTO local_users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)",
    ).run(username, await Bun.password.hash(username, { algorithm: "bcrypt" }), username, "member");
  }
  db.close();

  const admin = await loginAsAdmin(mesh.http);
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
    body: JSON.stringify({ username, password: username }),
    redirect: "manual",
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  // **A 302 is not a session.** The cookie is what says the account exists and
  // signed in; reading the redirect as success cost an hour of somebody's night.
  if (!cookie.startsWith("mesh_token=")) {
    throw new Error(`${username} could not sign in: ${login.status}, no mesh_token`);
  }
  return cookie;
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
