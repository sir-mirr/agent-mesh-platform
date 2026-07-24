import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";

import { SynapsePmOutboundMeshNotifier } from "./outbound-mesh";

class FakeSocket extends EventEmitter {
  readyState = 1;
  readonly sent: Array<Record<string, unknown>> = [];

  constructor() {
    super();
    queueMicrotask(() => this.emit("open"));
  }

  send(raw: string): void {
    const request = JSON.parse(raw) as { id: string; method: string; params: Record<string, unknown> };
    this.sent.push(request as unknown as Record<string, unknown>);
    queueMicrotask(() => this.emit("message", JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} })));
  }

  close(): void { this.readyState = 3; this.emit("close"); }
}

describe("SynapsePmOutboundMeshNotifier", () => {
  test("registers the dedicated identity and can send only to synapse-pm", async () => {
    const socket = new FakeSocket();
    const notifier = new SynapsePmOutboundMeshNotifier({ hubUrl: "ws://127.0.0.1:3100/ws", createSocket: () => socket as never });
    await notifier.send("synapse-pm", "watchdog heartbeat");
    expect(socket.sent).toHaveLength(2);
    expect(socket.sent[0]?.params).toEqual({ identity: "synapse-pm-autonomy", description: "Synapse PM autonomy outbound notifier", proxy_for: [] });
    expect(socket.sent[1]?.params).toEqual({ from: "synapse-pm-autonomy", to: "synapse-pm", content: "watchdog heartbeat" });
    await expect(notifier.send("other" as never, "nope")).rejects.toThrow("fixed to synapse-pm");
    notifier.stop();
  });
});
