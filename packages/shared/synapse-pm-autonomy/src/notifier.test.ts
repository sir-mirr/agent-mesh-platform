import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { AUTONOMY_IDENTITY, AutonomyStore, PM_TARGET } from "./autonomy";
import { OutboundPmNotifier, readOutboundNotifierConfig } from "./notifier";
import { BoundaryError } from "./policy";

const hubs: Array<{ stop: (closeActiveConnections?: boolean) => void }> = [];
afterEach(() => { for (const hub of hubs.splice(0)) hub.stop(true); });

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

  test("rejects missing or non-fixed identity and credential-bearing hub URL", () => {
    expectBoundary(() => readOutboundNotifierConfig({ SYNAPSE_PM_AUTONOMY_HUB_URL: "ws://127.0.0.1:3100/ws", SYNAPSE_PM_AUTONOMY_IDENTITY: undefined }), "OUTBOUND_REJECTED");
    expectBoundary(() => readOutboundNotifierConfig({ SYNAPSE_PM_AUTONOMY_HUB_URL: "ws://127.0.0.1:3100/ws", SYNAPSE_PM_AUTONOMY_IDENTITY: "other-agent" }), "OUTBOUND_REJECTED");
    expectBoundary(() => readOutboundNotifierConfig({ SYNAPSE_PM_AUTONOMY_HUB_URL: "ws://user:pass@127.0.0.1:3100/ws", SYNAPSE_PM_AUTONOMY_IDENTITY: AUTONOMY_IDENTITY }), "OUTBOUND_REJECTED");
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
});
