import WebSocket from "ws";

import type { MeshNotifier } from "./watchdog";

const IDENTITY = "synapse-pm-autonomy";

export interface OutboundMeshOptions {
  hubUrl: string;
  identity?: typeof IDENTITY;
  rpcTimeoutMs?: number;
  createSocket?: (url: string) => WebSocket;
}

interface RpcReply {
  id?: string;
  result?: unknown;
  error?: { message?: string };
}

/**
 * Deliberately small mesh client for the PM autonomy daemon. It registers one
 * dedicated service identity and exposes only outbound sends to synapse-pm;
 * it does not receive, dispatch, or proxy mesh messages.
 */
export class SynapsePmOutboundMeshNotifier implements MeshNotifier {
  private socket: WebSocket | null = null;
  private registered = false;
  private sequence = 0;
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly rpcTimeoutMs: number;
  private readonly createSocket: (url: string) => WebSocket;
  private connectPromise: Promise<void> | null = null;

  constructor(private readonly options: OutboundMeshOptions) {
    if (options.identity && options.identity !== IDENTITY) throw new Error("autonomy identity is fixed");
    if (!/^wss?:\/\//.test(options.hubUrl)) throw new Error("hubUrl must be a websocket URL");
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? 10_000;
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url));
  }

  async send(to: "synapse-pm", content: string): Promise<void> {
    if (to !== "synapse-pm") throw new Error("autonomy outbound target is fixed to synapse-pm");
    if (!content || content.length > 4_096) throw new Error("autonomy outbound content is invalid");
    await this.ensureRegistered();
    await this.rpc("mesh.send", { from: IDENTITY, to: "synapse-pm", content });
  }

  stop(): void {
    this.connectPromise = null;
    this.registered = false;
    const socket = this.socket;
    this.socket = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("autonomy mesh client stopped"));
    }
    this.pending.clear();
    socket?.close();
  }

  private async ensureRegistered(): Promise<void> {
    if (this.registered && this.socket?.readyState === WebSocket.OPEN) return;
    if (!this.connectPromise) this.connectPromise = this.connect();
    try { await this.connectPromise; } finally { this.connectPromise = null; }
  }

  private async connect(): Promise<void> {
    const socket = this.createSocket(this.options.hubUrl);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.on("message", (data) => this.onMessage(data.toString()));
    socket.on("close", () => this.onClose(socket));
    socket.on("error", () => undefined);
    await this.rpc("mesh.connect", { identity: IDENTITY, description: "Synapse PM autonomy outbound notifier", proxy_for: [] });
    if (this.socket !== socket) throw new Error("autonomy mesh socket superseded");
    this.registered = true;
  }

  private onMessage(raw: string): void {
    let reply: RpcReply;
    try { reply = JSON.parse(raw) as RpcReply; } catch { return; }
    if (typeof reply.id !== "string") return; // Inbound mesh events are intentionally ignored.
    const pending = this.pending.get(reply.id);
    if (!pending) return;
    this.pending.delete(reply.id);
    clearTimeout(pending.timer);
    if (reply.error) pending.reject(new Error(reply.error.message ?? "mesh rpc failed"));
    else pending.resolve(reply.result);
  }

  private onClose(socket: WebSocket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.registered = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("autonomy mesh socket closed"));
    }
    this.pending.clear();
  }

  private rpc(method: "mesh.connect" | "mesh.send", params: Record<string, unknown>): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("autonomy mesh is unavailable"));
    const id = `autonomy-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`mesh rpc timed out: ${method}`));
      }, this.rpcTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); }
      catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error instanceof Error ? error : new Error("mesh rpc send failed")); }
    });
  }
}
