import type {
  MeshAgent,
  MeshMessage,
  MeshMessageHistoryEntry,
} from "./mesh-types";

export type HubMessageHandler = (message: MeshMessage) => void;

export interface HubClientOptions {
  url: string;
  identity: string;
  description?: string | null;
  proxyFor?: string[];
  onMessage: HubMessageHandler;
  reconnectDelayMs?: number;
}

export class HubClient {
  private ws: WebSocket | null = null;
  private nextId = 100;
  private connected = false;
  private closing = false;
  private pendingRpc = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: HubClientOptions) {}

  start(): void {
    this.connect();
  }

  stop(): void {
    this.closing = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try {
      this.ws?.close(1000, "runtime-claude shutdown");
    } catch {}
  }

  isConnected(): boolean {
    return this.connected;
  }

  private connect(): void {
    log(`connecting to ${this.opts.url}`);
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url);
    } catch (error) {
      log(`connect threw: ${error}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = async () => {
      this.connected = true;
      try {
        await this.register();
        log(
          `registered as "${this.opts.identity}" (proxy_for=[${(this.opts.proxyFor ?? []).join(",")}])`,
        );
      } catch (error) {
        log(`register failed: ${error}`);
        try {
          ws.close();
        } catch {}
      }
    };

    ws.onmessage = (event) => {
      let data: any;
      try {
        data = JSON.parse(
          typeof event.data === "string" ? event.data : String(event.data),
        );
      } catch {
        return;
      }

      if (data.method === "mesh.message" && data.params) {
        try {
          this.opts.onMessage(data.params as MeshMessage);
        } catch (error) {
          log(`onMessage handler threw: ${error}`);
        }
        return;
      }

      if (typeof data.id === "number" && this.pendingRpc.has(data.id)) {
        const pending = this.pendingRpc.get(data.id)!;
        this.pendingRpc.delete(data.id);
        if (data.error)
          pending.reject(new Error(data.error.message ?? "rpc error"));
        else pending.resolve(data.result);
      }
    };

    ws.onclose = (event) => {
      this.connected = false;
      this.failPending(new Error("hub disconnected"));
      log(`disconnected (code=${event.code} reason="${event.reason}")`);
      if (!this.closing) this.scheduleReconnect();
    };

    ws.onerror = (event) => {
      log(`ws error: ${(event as any)?.message ?? "unknown"}`);
    };
  }

  private scheduleReconnect(): void {
    if (this.closing) return;
    const delay = this.opts.reconnectDelayMs ?? 5000;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private failPending(error: Error): void {
    for (const [, pending] of this.pendingRpc) pending.reject(error);
    this.pendingRpc.clear();
  }

  private rpc<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 10_000,
  ): Promise<T> {
    if (!this.connected || !this.ws) {
      return Promise.reject(new Error("hub not connected"));
    }
    const id = (this.nextId += 1);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingRpc.delete(id)) {
          reject(new Error(`hub rpc timeout: ${method}`));
        }
      }, timeoutMs);
      this.pendingRpc.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.ws!.send(
          JSON.stringify({ jsonrpc: "2.0", method, params, id }),
        );
      } catch (error) {
        this.pendingRpc.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  private register(): Promise<unknown> {
    return this.rpc("mesh.connect", {
      identity: this.opts.identity,
      description: this.opts.description ?? null,
      proxy_for: this.opts.proxyFor ?? [],
    });
  }

  send(opts: {
    to: string;
    from: string;
    content: string;
    reply_to: string | null;
  }): Promise<unknown> {
    return this.rpc("mesh.send", opts);
  }

  async listAgents(): Promise<MeshAgent[]> {
    const result = await this.rpc<{ agents?: MeshAgent[] }>(
      "mesh.list_agents",
      {},
    );
    return result.agents ?? [];
  }

  async fetchMessages(opts: {
    agentId: string;
    limit?: number;
  }): Promise<MeshMessageHistoryEntry[]> {
    const result = await this.rpc<{ messages?: MeshMessageHistoryEntry[] }>(
      "mesh.fetch_messages",
      {
        agent_id: opts.agentId,
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      },
    );
    return result.messages ?? [];
  }
}

function log(...args: unknown[]) {
  console.error("[runtime-claude-finja] [hub]", ...args);
}
