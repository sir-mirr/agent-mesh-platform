export interface SocketLike {
  readonly readyState: number;
  on(event: "open" | "message" | "close" | "error", listener: (...args: any[]) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface HubLifecycleOptions {
  createSocket: () => SocketLike;
  identity: string;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  rpcTimeoutMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  log?: (event: string, fields?: Record<string, unknown>) => void;
  onConnectivityState?: (state: "connecting" | "registered" | "unavailable") => void;
  onUnavailable?: (category: string) => void;
  onRegistered?: () => void | Promise<void>;
}

/**
 * A hub refusal, carrying the category the hub gave for it.
 *
 * Exported because `hubErrorCategory` below is exported and does nothing except
 * read this class: a caller could ask the question and had no way to construct
 * the case where the answer is interesting, which is how the scheduler came to
 * hardcode the fallback in three places with no test able to object.
 */
export class HubRpcError extends Error {
  constructor(message: string, readonly category: string) {
    super(message);
  }
}

interface PendingRpc {
  generation: number;
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * Owns exactly one registration attempt/socket and exactly one reconnect timer.
 * Event callbacks are tied to an incrementing generation, so an old socket cannot
 * clear a newer registered connection when it finally closes.
 */
export class HubLifecycle {
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly rpcTimeoutMs: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  private readonly log: (event: string, fields?: Record<string, unknown>) => void;
  private generation = 0;
  private current: { generation: number; ws: SocketLike } | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private ready = false;
  private stopped = false;
  private sequence = 0;
  private readonly pending = new Map<string, PendingRpc>();

  constructor(private readonly options: HubLifecycleOptions) {
    this.reconnectBaseMs = options.reconnectBaseMs ?? 1_000;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 30_000;
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? 10_000;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.log = options.log ?? (() => {});
  }

  isReady(): boolean {
    return this.ready;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearReconnectTimer();
    const current = this.current;
    this.current = null;
    this.ready = false;
    if (current) {
      this.rejectGeneration(current.generation, new HubRpcError("hub lifecycle stopped", "stopped"));
      try { current.ws.close(1000, "self-reminder stopping"); } catch {}
    }
  }

  request(method: string, params: Record<string, unknown>): Promise<any> {
    const current = this.current;
    if (!this.ready || !current || current.ws.readyState !== 1) {
      return Promise.reject(new HubRpcError("hub is not registered", "hub_unavailable"));
    }
    return this.requestOn(current, method, params);
  }

  private connect(): void {
    if (this.stopped || this.current || this.reconnectTimer) return;
    const generation = ++this.generation;
    let ws: SocketLike;
    try {
      ws = this.options.createSocket();
    } catch {
      this.markUnavailable("connect_create_failed");
      this.scheduleReconnect();
      return;
    }
    this.current = { generation, ws };
    this.ready = false;
    this.options.onConnectivityState?.("connecting");
    this.log("hub_connecting", { generation });

    ws.on("open", () => {
      if (!this.owns(generation, ws)) return;
      void this.register(generation, ws);
    });
    ws.on("message", (data: unknown) => this.handleMessage(generation, ws, data));
    ws.on("close", () => this.handleClose(generation, ws));
    ws.on("error", () => {
      if (!this.owns(generation, ws)) return;
      this.log("hub_socket_error", { generation });
    });
  }

  private async register(generation: number, ws: SocketLike): Promise<void> {
    try {
      await this.requestOn({ generation, ws }, "mesh.connect", {
        identity: this.options.identity,
        description: "SelfReminder service",
      });
      if (!this.owns(generation, ws)) return;
      this.ready = true;
      this.reconnectAttempt = 0;
      this.options.onConnectivityState?.("registered");
      this.log("hub_registered", { generation });
      // **Named for a failure it cannot observe.** `onHubRegistered` catches
      // every `sendAlert` rejection inside its own loop and does not rethrow,
      // so this handler never sees an alert that failed to send — those are
      // reported by the scheduler, per recipient, with the real category.
      //
      // What can reach here is everything else in that method: the state
      // writes, the due-count query, the event insert. So it is renamed for
      // what it actually covers and now carries the reason, which it was
      // discarding. An `error_category` alongside the other calls in this file,
      // and the message too — a category alone says which family, and the
      // family for anything that is not a hub error is the unhelpful one.
      void Promise.resolve(this.options.onRegistered?.()).catch((error) => {
        this.log("hub_post_registration_failed", {
          generation,
          error_category: hubErrorCategory(error),
          error: error instanceof Error ? error.message : String(error),
        });
      });
    } catch (error) {
      if (!this.owns(generation, ws)) return;
      const category = error instanceof HubRpcError ? error.category : "registration_failed";
      this.log("hub_registration_rejected", { generation, error_category: category });
      this.rejectAndReconnect(generation, ws, category);
    }
  }

  private requestOn(current: { generation: number; ws: SocketLike }, method: string, params: Record<string, unknown>): Promise<any> {
    if (!this.owns(current.generation, current.ws) || current.ws.readyState !== 1) {
      return Promise.reject(new HubRpcError("hub socket is not open", "hub_unavailable"));
    }
    const id = `${current.generation}-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timeout = this.setTimer(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        reject(new HubRpcError(`rpc timeout: ${method}`, "rpc_timeout"));
      }, this.rpcTimeoutMs);
      this.pending.set(id, { generation: current.generation, resolve, reject, timeout });
      try {
        current.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch {
        this.pending.delete(id);
        this.clearTimer(timeout);
        reject(new HubRpcError("rpc send failed", "rpc_send_failed"));
      }
    });
  }

  private handleMessage(generation: number, ws: SocketLike, data: unknown): void {
    if (!this.owns(generation, ws)) return;
    let message: any;
    try {
      message = JSON.parse(String(data));
    } catch {
      this.log("hub_message_parse_error", { generation });
      return;
    }
    if (message.id === undefined || message.id === null) return;
    const id = String(message.id);
    const pending = this.pending.get(id);
    if (!pending || pending.generation !== generation) return;
    this.pending.delete(id);
    this.clearTimer(pending.timeout);
    if (message.error) {
      pending.reject(new HubRpcError(
        typeof message.error.message === "string" ? message.error.message : "hub rpc error",
        String(message.error.data?.code ?? "rpc_error").toLowerCase()
      ));
    } else {
      pending.resolve(message.result);
    }
  }

  private handleClose(generation: number, ws: SocketLike): void {
    if (!this.owns(generation, ws)) return;
    this.current = null;
    this.ready = false;
    this.rejectGeneration(generation, new HubRpcError("hub socket closed", "hub_closed"));
    this.markUnavailable("hub_closed");
    this.scheduleReconnect();
  }

  private rejectAndReconnect(generation: number, ws: SocketLike, category: string): void {
    if (!this.owns(generation, ws)) return;
    this.current = null;
    this.ready = false;
    this.rejectGeneration(generation, new HubRpcError("hub registration rejected", category));
    this.markUnavailable(category);
    try { ws.close(1008, "registration rejected"); } catch {}
    this.scheduleReconnect();
  }

  private markUnavailable(category: string): void {
    this.options.onConnectivityState?.("unavailable");
    this.options.onUnavailable?.(category);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const exponent = Math.min(this.reconnectAttempt++, 10);
    const delay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** exponent);
    this.log("hub_reconnect_scheduled", { delay_ms: delay, attempt: this.reconnectAttempt });
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    this.clearTimer(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private owns(generation: number, ws: SocketLike): boolean {
    return this.current?.generation === generation && this.current.ws === ws;
  }

  private rejectGeneration(generation: number, error: HubRpcError): void {
    for (const [id, pending] of this.pending) {
      if (pending.generation !== generation) continue;
      this.pending.delete(id);
      this.clearTimer(pending.timeout);
      pending.reject(error);
    }
  }
}

export function hubErrorCategory(error: unknown): string {
  return error instanceof HubRpcError ? error.category : "hub_rpc_failed";
}
