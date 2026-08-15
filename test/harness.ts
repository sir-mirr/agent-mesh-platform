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

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

export interface Service {
  port: number;
  url: string;
  /** Everything the process wrote, for assertions and for failure output. */
  output(): string;
  stop(): void;
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
async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("") });
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

  return {
    port,
    output: () => chunks.join(""),
    stop: () => proc.kill(),
  };
}

export interface StartOptions {
  /** Skip the http server when a test only needs the hub. */
  withHttp?: boolean;
  env?: Record<string, string>;
}

/** Start a mesh on a fresh state directory. Always pair with `stop()`. */
export async function startMesh(opts: StartOptions = {}): Promise<Mesh> {
  const withHttp = opts.withHttp ?? true;
  const stateDir = mkdtempSync(join(tmpdir(), "agent-mesh-it-"));
  const hubPort = await freePort();

  const shared = { AGENT_MESH_STATE_DIR: stateDir, ...opts.env };

  const hubProc = spawnService("packages/hub/src/main.ts", hubPort, {
    ...shared,
    AGENT_MESH_HUB_PORT: String(hubPort),
  });
  const hub: Service = { ...hubProc, url: `http://127.0.0.1:${hubPort}` };

  let http: Service;
  try {
    await waitForHealth(`${hub.url}/health`);

    if (withHttp) {
      const httpPort = await freePort();
      const httpProc = spawnService("packages/http/src/main.ts", httpPort, {
        ...shared,
        AGENT_MESH_HTTP_PORT: String(httpPort),
        AGENT_MESH_HUB_URL: `ws://127.0.0.1:${hubPort}/ws`,
        // Startup fails without one, and a fixed value keeps issued cookies
        // reproducible across a test run.
        JWT_SECRET: "integration-test-secret",
      });
      http = { ...httpProc, url: `http://127.0.0.1:${httpPort}` };
      await waitForHealth(`${http.url}/api/v1/health`);
    } else {
      http = {
        port: 0,
        url: "",
        output: () => "",
        stop: () => {},
      };
    }
  } catch (err) {
    // Surface what the process said; a bare timeout tells you nothing.
    hubProc.stop();
    throw new Error(`${err instanceof Error ? err.message : String(err)}\n--- hub output ---\n${hubProc.output()}`);
  }

  return {
    hub,
    http,
    stateDir,
    stop() {
      http.stop();
      hub.stop();
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

/** Provision an identity, which every connecting agent must have (SPEC § 8.1). */
export async function provision(
  hub: Service,
  identity: string,
  type = "service",
  description: string | null = null,
): Promise<Response> {
  return fetch(`${hub.url}/api/v1/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity, type, description }),
  });
}

export interface RpcClient {
  /** Send a request and wait for the response with a matching id. */
  call(method: string, params: unknown): Promise<any>;
  /** Server-pushed notifications received so far (SPEC § 8.8). */
  notifications(): any[];
  close(): void;
}

/** Open a hub WebSocket and correlate responses by JSON-RPC id. */
export async function connectRpc(hub: Service): Promise<RpcClient> {
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

  return {
    call(method, params) {
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
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      });
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
