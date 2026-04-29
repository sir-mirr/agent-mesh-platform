import type { DiscordInboundPayload, DiscordLogFn, DiscordToolService } from "./types";
import type { DiscordDriverConfig } from "./types";

interface MeshMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  reply_to?: string | null;
  ts?: string;
}

interface ReplyRouteState {
  chatId: string;
  replyToMessageId?: string;
  observedAt: number;
}

function normalizeWebSocketData(data: MessageEvent["data"]): string {
  return typeof data === "string" ? data : String(data);
}

function trimRouteMap<K>(map: Map<K, ReplyRouteState>, maxEntries: number): void {
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export interface DiscordHubForwardRuntime {
  forwardInbound(payload: DiscordInboundPayload): Promise<void>;
  stop(): void;
}

export interface StartDiscordHubForwardOptions {
  config: DiscordDriverConfig & { hubForward: NonNullable<DiscordDriverConfig["hubForward"]> };
  tools: DiscordToolService;
  logger: DiscordLogFn;
}

class DiscordHubForwardBridge implements DiscordHubForwardRuntime {
  private ws: WebSocket | null = null;
  private connected = false;
  private closing = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private nextId = 100;
  private readyPromise: Promise<void> | null = null;
  private readonly pendingRpc = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly routeByHubMessageId = new Map<string, ReplyRouteState>();
  private latestRoute: ReplyRouteState | null = null;

  constructor(private readonly opts: StartDiscordHubForwardOptions) {}

  start(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.connect();
    return this.readyPromise;
  }

  stop(): void {
    this.closing = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    for (const [, pending] of this.pendingRpc) {
      clearTimeout(pending.timer);
      pending.reject(new Error("hub-forward shutting down"));
    }
    this.pendingRpc.clear();
    try {
      this.ws?.close(1000, "hub-forward shutdown");
    } catch {}
  }

  async forwardInbound(payload: DiscordInboundPayload): Promise<void> {
    await this.start();
    const result = await this.rpc<{ id: string }>("mesh.send", {
      to: this.opts.config.hubForward.targetAgent,
      content: payload.rawEnvelope,
    });
    const route: ReplyRouteState = {
      chatId: payload.replyRoute.channelId,
      replyToMessageId: payload.replyRoute.replyToMessageId,
      observedAt: Date.now(),
    };
    this.latestRoute = route;
    this.routeByHubMessageId.set(result.id, route);
    trimRouteMap(this.routeByHubMessageId, 200);
  }

  private async connect(): Promise<void> {
    const ws = new WebSocket(this.opts.config.hubForward.hubUrl);
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const onOpen = async () => {
        try {
          this.connected = true;
          await this.rpc("mesh.connect", {
            identity: this.opts.config.hubForward.hubIdentity,
            description: `Discord hub-forward for ${this.opts.config.hubForward.targetAgent}`,
          });
          this.opts.logger(
            `hub-forward connected identity=${this.opts.config.hubForward.hubIdentity} target=${this.opts.config.hubForward.targetAgent}`,
          );
          resolve();
        } catch (error) {
          reject(error);
        }
      };

      const onError = (event: Event) => {
        const error = (event as Event & { message?: string }).message ?? "hub-forward ws error";
        reject(new Error(error));
      };

      ws.onopen = () => {
        void onOpen();
      };
      ws.onerror = onError;
      ws.onmessage = (event) => {
        void this.handleMessage(event);
      };
      ws.onclose = (event) => {
        this.connected = false;
        this.failPending(new Error(`hub-forward disconnected code=${event.code}`));
        if (!this.closing) {
          this.opts.logger(`hub-forward disconnected code=${event.code} reason="${event.reason}"`);
          this.readyPromise = null;
          this.scheduleReconnect();
        }
      };
    });
  }

  private scheduleReconnect(): void {
    if (this.closing) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.readyPromise = this.connect().catch((error) => {
        this.opts.logger(`hub-forward reconnect failed: ${error}`);
        this.readyPromise = null;
        this.scheduleReconnect();
      });
    }, 5000);
  }

  private failPending(error: Error): void {
    for (const [, pending] of this.pendingRpc) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRpc.clear();
  }

  private rpc<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 10_000,
  ): Promise<T> {
    if (!this.connected || !this.ws) {
      return Promise.reject(new Error("hub-forward not connected"));
    }
    const id = this.nextId += 1;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingRpc.delete(id)) {
          reject(new Error(`hub-forward rpc timeout: ${method}`));
        }
      }, timeoutMs);
      this.pendingRpc.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        this.ws!.send(JSON.stringify({ jsonrpc: "2.0", method, params, id }));
      } catch (error) {
        clearTimeout(timer);
        this.pendingRpc.delete(id);
        reject(error);
      }
    });
  }

  private async handleMessage(event: MessageEvent): Promise<void> {
    let data: any;
    try {
      data = JSON.parse(normalizeWebSocketData(event.data));
    } catch {
      return;
    }

    if (typeof data.id === "number" && this.pendingRpc.has(data.id)) {
      const pending = this.pendingRpc.get(data.id)!;
      this.pendingRpc.delete(data.id);
      clearTimeout(pending.timer);
      if (data.error) pending.reject(new Error(data.error.message ?? "hub-forward rpc error"));
      else pending.resolve(data.result);
      return;
    }

    if (data.method === "mesh.message" && data.params) {
      await this.handleMeshMessage(data.params as MeshMessage);
    }
  }

  private async handleMeshMessage(message: MeshMessage): Promise<void> {
    if (message.to !== this.opts.config.hubForward.hubIdentity) return;
    const route =
      (message.reply_to ? this.routeByHubMessageId.get(message.reply_to) : undefined) ??
      this.latestRoute;
    if (!route) {
      this.opts.logger(
        `hub-forward drop: no reply route for from=${message.from} reply_to=${message.reply_to ?? "-"}`,
      );
      return;
    }

    try {
      await this.opts.tools.reply({
        chat_id: route.chatId,
        text: message.content,
        ...(route.replyToMessageId ? { reply_to: route.replyToMessageId } : {}),
      });
    } catch (error) {
      this.opts.logger(`hub-forward outbound failed: ${error}`);
    }
  }
}

export async function startDiscordHubForwardBridge(
  options: StartDiscordHubForwardOptions,
): Promise<DiscordHubForwardRuntime> {
  const bridge = new DiscordHubForwardBridge(options);
  await bridge.start();
  return bridge;
}
