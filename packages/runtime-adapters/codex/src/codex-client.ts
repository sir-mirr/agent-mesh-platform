import WS, { type RawData } from "ws";

export type CodexNotificationHandler = (method: string, params: unknown) => void;

export interface CodexClientOptions {
  url: string;
  authToken: string | null;
  optOutNotificationMethods: string[];
  clientInfo: { name: string; title: string; version: string };
  onNotification: CodexNotificationHandler;
  onReady: () => void;
  onDisconnect: () => void;
  reconnectDelayMs?: number;
}

type AnyWs = {
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
};

export class CodexClient {
  private ws: AnyWs | null = null;
  private nextId = 1;
  private connected = false;
  private initialized = false;
  private closing = false;
  private pendingRpc = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: CodexClientOptions) {}

  start(): void {
    this.connect();
  }

  stop(): void {
    this.closing = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try {
      this.ws?.close(1000, "runtime-codex shutdown");
    } catch {}
  }

  isReady(): boolean {
    return this.connected && this.initialized;
  }

  private connect(): void {
    log(`connecting to ${this.opts.url}`);
    const headers: Record<string, string> = {};
    if (this.opts.authToken) {
      headers.Authorization = `Bearer ${this.opts.authToken}`;
    }

    let ws: WS;
    try {
      ws = new WS(this.opts.url, { headers });
    } catch (error) {
      log(`connect threw: ${error}`);
      this.scheduleReconnect();
      return;
    }

    ws.on("open", async () => {
      this.connected = true;
      this.ws = {
        send: (data) => ws.send(data),
        close: (code, reason) => ws.close(code, reason),
      };
      try {
        await this.handshake();
        this.initialized = true;
        this.opts.onReady();
      } catch (error) {
        log(`handshake failed: ${error}`);
        try {
          ws.close();
        } catch {}
      }
    });

    ws.on("message", (raw: RawData) => {
      let data: any;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (typeof data.id === "number" && this.pendingRpc.has(data.id)) {
        const pending = this.pendingRpc.get(data.id)!;
        this.pendingRpc.delete(data.id);
        if (data.error) pending.reject(new Error(data.error.message ?? "rpc error"));
        else pending.resolve(data.result);
        return;
      }

      if (typeof data.method === "string" && data.id === undefined) {
        try {
          this.opts.onNotification(data.method, data.params ?? {});
        } catch (error) {
          log(`notification handler threw: ${error}`);
        }
        return;
      }

      if (typeof data.method === "string" && data.id !== undefined) {
        try {
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: data.id,
              error: { code: -32601, message: `runtime-codex does not handle ${data.method}` },
            }),
          );
        } catch {}
      }
    });

    ws.on("close", (code: number, reason: Buffer) => {
      this.connected = false;
      this.initialized = false;
      this.failPending(new Error("codex disconnected"));
      this.opts.onDisconnect();
      log(`disconnected (code=${code} reason="${reason.toString()}")`);
      if (!this.closing) this.scheduleReconnect();
    });

    ws.on("error", (error: Error) => {
      log(`ws error: ${error.message}`);
    });
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

  private async handshake(): Promise<void> {
    await this.rpc("initialize", {
      clientInfo: this.opts.clientInfo,
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: this.opts.optOutNotificationMethods,
      },
    });
    this.notify("initialized", {});
  }

  private notify(method: string, params: Record<string, unknown>): void {
    if (!this.ws) throw new Error("codex not connected");
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  rpc<T>(method: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
    if (!this.ws || !this.connected) {
      return Promise.reject(new Error("codex not connected"));
    }
    const id = this.nextId += 1;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingRpc.delete(id)) {
          reject(new Error(`codex rpc timeout: ${method}`));
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
        this.ws!.send(JSON.stringify({ jsonrpc: "2.0", method, params, id }));
      } catch (error) {
        this.pendingRpc.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  async threadStart(opts: {
    developerInstructions: string;
    cwd: string;
  }): Promise<{ threadId: string }> {
    const sandbox = (process.env.CODEX_SANDBOX ?? "danger-full-access").trim();
    const approvalPolicy = (process.env.CODEX_APPROVAL_POLICY ?? "never").trim();
    const response = await this.rpc<{ thread?: { id?: string }; threadId?: string }>(
      "thread/start",
      {
        cwd: opts.cwd,
        approvalPolicy,
        sandbox,
        developerInstructions: opts.developerInstructions,
      },
    );
    const threadId = response?.thread?.id ?? response?.threadId;
    if (!threadId) {
      throw new Error(`thread/start returned no thread.id (got ${JSON.stringify(response)})`);
    }
    return { threadId };
  }

  threadResume(threadId: string): Promise<unknown> {
    return this.rpc("thread/resume", { threadId });
  }

  turnStart(opts: {
    threadId: string;
    input: unknown[];
    cwd: string;
    timeoutMs?: number;
  }): Promise<{ turnId: string }> {
    const approvalPolicy = (process.env.CODEX_APPROVAL_POLICY ?? "never").trim();
    return this.rpc("turn/start", {
      threadId: opts.threadId,
      input: opts.input,
      cwd: opts.cwd,
      approvalPolicy,
    }, opts.timeoutMs);
  }

  turnSteer(opts: {
    threadId: string;
    input: unknown[];
    expectedTurnId: string;
  }): Promise<unknown> {
    return this.rpc("turn/steer", {
      threadId: opts.threadId,
      input: opts.input,
      expectedTurnId: opts.expectedTurnId,
    });
  }
}

function log(...args: unknown[]) {
  console.log("[runtime-codex] [codex]", ...args);
}
