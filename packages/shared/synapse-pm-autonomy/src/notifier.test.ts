import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { AUTONOMY_IDENTITY, AutonomyStore, PM_TARGET } from "./autonomy";
import { sendAutonomyControl } from "./client";
import { WATCHDOG_INTERVAL_MS, composeAutonomyDaemon, startAutonomyRuntime, type WatchdogScheduler } from "./main";
import { OutboundPmNotifier, readOutboundNotifierConfig } from "./notifier";
import { BoundaryError } from "./policy";

const hubs: Array<{ stop: (closeActiveConnections?: boolean) => void }> = [];
const fixtureRoots: string[] = [];
afterEach(() => {
  for (const hub of hubs.splice(0)) hub.stop(true);
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type RpcFrame = { jsonrpc: "2.0"; id: number; method: string; params: Record<string, unknown> };

function createLocalHub(sendInboundNoise = false): { url: string; frames: RpcFrame[] } {
  const frames: RpcFrame[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response("WebSocket only", { status: 426 });
    },
    websocket: {
      message(socket, raw) {
        const frame = JSON.parse(String(raw)) as RpcFrame;
        frames.push(frame);
        if (frame.method === "mesh.connect") {
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { ok: true, identity: AUTONOMY_IDENTITY } }));
          return;
        }
        if (sendInboundNoise) {
          socket.send(JSON.stringify({ jsonrpc: "2.0", method: "mesh.message", params: { from: "untrusted", to: AUTONOMY_IDENTITY, content: "do not act" } }));
          return;
        }
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { id: "fixture-message", status: "delivered" } }));
      },
    },
  });
  hubs.push(server);
  return { url: `ws://127.0.0.1:${server.port}/ws`, frames };
}

function fixtureRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "pm-autonomy-notifier-"));
  fixtureRoots.push(root);
  return root;
}

class ManualScheduler implements WatchdogScheduler {
  private nextHandle = 1;
  private readonly callbacks = new Map<number, () => Promise<void>>();
  readonly intervals: number[] = [];

  setInterval(callback: () => Promise<void>, intervalMs: number): number {
    this.intervals.push(intervalMs);
    const handle = this.nextHandle++;
    this.callbacks.set(handle, callback);
    return handle;
  }

  clearInterval(handle: unknown): void { if (typeof handle === "number") this.callbacks.delete(handle); }
  get activeCount(): number { return this.callbacks.size; }
  async fireAll(): Promise<void> { await Promise.all([...this.callbacks.values()].map((callback) => callback())); }
  async fireConcurrently(): Promise<void> {
    const callback = this.callbacks.values().next().value as (() => Promise<void>) | undefined;
    if (!callback) return;
    await Promise.all([callback(), callback()]);
  }
}

function fixtureSocketValidator(socketPath: string): (candidate: string) => string {
  return (candidate) => {
    if (candidate !== socketPath || !candidate.endsWith(".sock")) throw new Error("fixture socket rejected");
    return candidate;
  };
}

function expectBoundary(run: () => unknown, code: string): void {
  try { run(); } catch (error) {
    expect(error).toBeInstanceOf(BoundaryError);
    expect((error as BoundaryError).code).toBe(code);
    return;
  }
  throw new Error(`expected boundary rejection: ${code}`);
}

describe("Synapse PM autonomy outbound notifier", () => {
  test("uses the standard outbound handshake and fixed PM-only message route", async () => {
    const hub = createLocalHub();
    const notifier = new OutboundPmNotifier({ hubUrl: hub.url, identity: AUTONOMY_IDENTITY });
    const originalWrite = process.stderr.write;
    let stderr = "";
    process.stderr.write = ((chunk: unknown) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
    try {
      await notifier.send({ from: AUTONOMY_IDENTITY, to: PM_TARGET, content: "AUTONOMY HEARTBEAT task=task-one" });
    } finally {
      process.stderr.write = originalWrite;
    }
    expect(stderr).toBe("");
    expect(hub.frames).toEqual([
      {
        jsonrpc: "2.0", id: 1, method: "mesh.connect",
        params: { identity: AUTONOMY_IDENTITY, description: "Synapse PM autonomy outbound notifier", proxy_for: [] },
      },
      {
        jsonrpc: "2.0", id: 2, method: "mesh.send",
        params: { to: PM_TARGET, from: AUTONOMY_IDENTITY, content: "AUTONOMY HEARTBEAT task=task-one", reply_to: null },
      },
    ]);
  });

  test("rejects missing or non-fixed identity and every credential-bearing hub URL before connecting", () => {
    expectBoundary(() => readOutboundNotifierConfig({ SYNAPSE_PM_AUTONOMY_HUB_URL: "ws://127.0.0.1:3100/ws", SYNAPSE_PM_AUTONOMY_IDENTITY: undefined }), "OUTBOUND_REJECTED");
    expectBoundary(() => readOutboundNotifierConfig({ SYNAPSE_PM_AUTONOMY_HUB_URL: "ws://127.0.0.1:3100/ws", SYNAPSE_PM_AUTONOMY_IDENTITY: "other-agent" }), "OUTBOUND_REJECTED");
    for (const hubUrl of ["ws://127.0.0.1:3100/ws?token=fixture", "ws://user:pass@127.0.0.1:3100/ws", "wss://127.0.0.1:3100/ws#fragment"]) {
      expectBoundary(() => readOutboundNotifierConfig({ SYNAPSE_PM_AUTONOMY_HUB_URL: hubUrl, SYNAPSE_PM_AUTONOMY_IDENTITY: AUTONOMY_IDENTITY }), "OUTBOUND_REJECTED");
    }
    expect(readOutboundNotifierConfig({ SYNAPSE_PM_AUTONOMY_HUB_URL: "ws://127.0.0.1:3100/ws", SYNAPSE_PM_AUTONOMY_IDENTITY: AUTONOMY_IDENTITY }).hubUrl).toBe("ws://127.0.0.1:3100/ws");
    expect(readOutboundNotifierConfig({ SYNAPSE_PM_AUTONOMY_HUB_URL: "wss://example.invalid/ws", SYNAPSE_PM_AUTONOMY_IDENTITY: AUTONOMY_IDENTITY }).hubUrl).toBe("wss://example.invalid/ws");
  });

  test("closes fail-safe on inbound mesh noise without changing autonomy state", async () => {
    const hub = createLocalHub(true);
    const store = new AutonomyStore(new Database(":memory:"));
    store.create({ taskId: "task-one", manifestRef: "manifests/task.json", manifestSha256: "a".repeat(64), phase: "build", nextAction: "test" });
    const before = store.get("task-one")!;
    const notifier = new OutboundPmNotifier({ hubUrl: hub.url, identity: AUTONOMY_IDENTITY });
    await expect(notifier.send({ from: AUTONOMY_IDENTITY, to: PM_TARGET, content: "AUTONOMY NUDGE task=task-one" })).rejects.toMatchObject({ code: "OUTBOUND_REJECTED" });
    const after = store.get("task-one")!;
    expect(after.status).toBe("active");
    expect(after.last_progress_at).toBe(before.last_progress_at);
    expect(hub.frames.map((frame) => frame.method)).toEqual(["mesh.connect", "mesh.send"]);
  });

  test("watchdog commits no event or task timestamp when an inbound frame fails outbound delivery", async () => {
    let current = new Date("2026-07-26T00:00:00.000Z");
    const store = new AutonomyStore(new Database(":memory:"), () => current);
    store.create({ taskId: "task-one", manifestRef: "manifests/task.json", manifestSha256: "a".repeat(64), phase: "build", nextAction: "test" });
    current = new Date("2026-07-26T00:15:01.000Z");
    const before = store.get("task-one")!;
    const beforeEvents = store.eventCount("task-one");
    const hub = createLocalHub(true);
    const notifier = new OutboundPmNotifier({ hubUrl: hub.url, identity: AUTONOMY_IDENTITY });
    await expect(store.watchdog(notifier)).rejects.toMatchObject({ code: "OUTBOUND_REJECTED" });
    expect(store.get("task-one")).toEqual(before);
    expect(store.eventCount("task-one")).toBe(beforeEvents);
    expect(hub.frames.map((frame) => frame.method)).toEqual(["mesh.connect", "mesh.send"]);
  });

  test("production composition runs its watchdog send path before its local daemon remains active", async () => {
    const root = fixtureRoot(); const manifests = path.join(root, "manifests"); const artifacts = path.join(root, "artifacts");
    mkdirSync(manifests); mkdirSync(artifacts);
    let current = new Date("2026-07-26T00:00:00.000Z");
    const hub = createLocalHub();
    const runtime = composeAutonomyDaemon({
      stateRoot: path.join(root, "state"), manifestsRoot: manifests, artifactsRoot: artifacts,
      socketPath: "/run/synapse-pm-autonomy/control.sock", daemonUid: 1000, clock: () => current,
      environment: { SYNAPSE_PM_AUTONOMY_HUB_URL: hub.url, SYNAPSE_PM_AUTONOMY_IDENTITY: AUTONOMY_IDENTITY },
    });
    runtime.store.create({ taskId: "task-one", manifestRef: "manifests/task.json", manifestSha256: "a".repeat(64), phase: "build", nextAction: "test" });
    current = new Date("2026-07-26T00:15:01.000Z");
    let daemonStarted = false;
    const started = await startAutonomyRuntime({
      start: () => { daemonStarted = true; return "fixture-daemon"; },
      runWatchdog: runtime.runWatchdog,
    });
    expect(started).toBe("fixture-daemon");
    expect(daemonStarted).toBeTrue();
    expect(hub.frames.map((frame) => frame.method)).toEqual(["mesh.connect", "mesh.send"]);
    expect(runtime.store.eventCount("task-one")).toBe(2);
    expect(runtime.store.get("task-one")?.last_heartbeat_at).toBe(current.toISOString());
  });

  test("recurs through a post-start local UDS task once, then closes without a timer or later send", async () => {
    const root = fixtureRoot(); const manifests = path.join(root, "manifests"); const artifacts = path.join(root, "artifacts"); const socketPath = path.join(root, "control.sock");
    mkdirSync(manifests); mkdirSync(artifacts); writeFileSync(path.join(manifests, "task.json"), "{\"fixture\":true}\n");
    const scheduler = new ManualScheduler(); const validator = fixtureSocketValidator(socketPath); const hub = createLocalHub();
    let current = new Date("2026-07-26T00:00:00.000Z");
    const runtime = composeAutonomyDaemon({
      stateRoot: path.join(root, "state"), manifestsRoot: manifests, artifactsRoot: artifacts, socketPath,
      daemonUid: process.getuid?.() ?? 0, clock: () => current, socketPathValidator: validator, scheduler,
      environment: { SYNAPSE_PM_AUTONOMY_HUB_URL: hub.url, SYNAPSE_PM_AUTONOMY_IDENTITY: AUTONOMY_IDENTITY },
    });
    const server = await startAutonomyRuntime(runtime);
    if (!server.listening) await once(server, "listening");
    expect(scheduler.intervals).toEqual([WATCHDOG_INTERVAL_MS]);
    expect(scheduler.activeCount).toBe(1);
    expect(await startAutonomyRuntime(runtime)).toBe(server);
    expect(scheduler.activeCount).toBe(1);
    const created = await sendAutonomyControl(socketPath, { op: "create", input: { task_id: "task-one", manifest_ref: "task.json", phase: "build", next_action: "test" } }, validator);
    expect(created).toMatchObject({ task_id: "task-one", status: "active" });
    current = new Date("2026-07-26T00:15:01.000Z");
    await scheduler.fireConcurrently();
    expect(hub.frames.map((frame) => frame.method)).toEqual(["mesh.connect", "mesh.send"]);
    expect(runtime.store.eventCount("task-one")).toBe(2);
    expect(runtime.store.get("task-one")?.last_heartbeat_at).toBe(current.toISOString());
    const closed = once(server, "close"); server.close(); await closed;
    expect(scheduler.activeCount).toBe(0);
    await scheduler.fireAll();
    expect(hub.frames.map((frame) => frame.method)).toEqual(["mesh.connect", "mesh.send"]);
  });
});
