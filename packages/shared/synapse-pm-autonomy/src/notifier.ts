import { AUTONOMY_IDENTITY, PM_TARGET, type OutboundNotifier } from "./autonomy";
import { BoundaryError } from "./policy";

export const AUTONOMY_HUB_URL_ENV = "SYNAPSE_PM_AUTONOMY_HUB_URL";
export const AUTONOMY_IDENTITY_ENV = "SYNAPSE_PM_AUTONOMY_IDENTITY";

export interface OutboundNotifierConfig {
  hubUrl: string;
  identity: typeof AUTONOMY_IDENTITY;
}

export type RuntimeEnvironment = Record<typeof AUTONOMY_HUB_URL_ENV | typeof AUTONOMY_IDENTITY_ENV, string | undefined>;

/** Read exactly the two non-secret autonomy runtime values. */
export function readOutboundNotifierConfig(environment: RuntimeEnvironment): OutboundNotifierConfig {
  const hubUrl = environment[AUTONOMY_HUB_URL_ENV];
  const identity = environment[AUTONOMY_IDENTITY_ENV];
  if (identity !== AUTONOMY_IDENTITY) throw new BoundaryError("OUTBOUND_REJECTED", "autonomy mesh identity must be exactly synapse-pm-autonomy");
  if (typeof hubUrl !== "string" || !hubUrl) throw new BoundaryError("OUTBOUND_REJECTED", "autonomy hub URL is required");
  let parsed: URL;
  try { parsed = new URL(hubUrl); } catch { throw new BoundaryError("OUTBOUND_REJECTED", "autonomy hub URL is invalid"); }
  if ((parsed.protocol !== "ws:" && parsed.protocol !== "wss:") || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new BoundaryError("OUTBOUND_REJECTED", "autonomy hub URL must be a credential-free ws/wss endpoint");
  }
  return { hubUrl: parsed.toString(), identity: AUTONOMY_IDENTITY };
}

type FixedMessage = { from: typeof AUTONOMY_IDENTITY; to: typeof PM_TARGET; content: string };
const CONNECT_TIMEOUT_MS = 5_000;

function assertFixedMessage(message: FixedMessage): void {
  if (message.from !== AUTONOMY_IDENTITY || message.to !== PM_TARGET || typeof message.content !== "string" || !message.content) {
    throw new BoundaryError("OUTBOUND_REJECTED", "outbound autonomy messages must use the fixed PM route");
  }
}

function closeQuietly(socket: WebSocket): void { try { socket.close(1000, "outbound message complete"); } catch {} }

/**
 * One-shot outbound-only client for the repository-standard hub JSON-RPC flow.
 * It never exposes a listener, registers a proxy, or dispatches an inbound event.
 */
export class OutboundPmNotifier implements OutboundNotifier {
  constructor(private readonly config: OutboundNotifierConfig) {}

  async send(message: FixedMessage): Promise<void> {
    assertFixedMessage(message);
    const socket = new WebSocket(this.config.hubUrl);
    try {
      await this.open(socket);
      await this.rpc(socket, 1, "mesh.connect", {
        identity: AUTONOMY_IDENTITY,
        description: "Synapse PM autonomy outbound notifier",
        proxy_for: [],
      });
      await this.rpc(socket, 2, "mesh.send", {
        to: PM_TARGET,
        from: AUTONOMY_IDENTITY,
        content: message.content,
        reply_to: null,
      });
    } finally {
      closeQuietly(socket);
    }
  }

  private open(socket: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { closeQuietly(socket); reject(new BoundaryError("OUTBOUND_REJECTED", "hub connection timed out")); }, CONNECT_TIMEOUT_MS);
      socket.onopen = () => { clearTimeout(timer); resolve(); };
      socket.onerror = () => { clearTimeout(timer); reject(new BoundaryError("OUTBOUND_REJECTED", "hub connection failed")); };
      socket.onclose = () => { clearTimeout(timer); reject(new BoundaryError("OUTBOUND_REJECTED", "hub closed before connection")); };
    });
  }

  private rpc(socket: WebSocket, id: number, method: "mesh.connect" | "mesh.send", params: Record<string, unknown>): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { closeQuietly(socket); reject(new BoundaryError("OUTBOUND_REJECTED", `${method} timed out`)); }, CONNECT_TIMEOUT_MS);
      socket.onmessage = (event) => {
        let frame: unknown;
        try { frame = JSON.parse(typeof event.data === "string" ? event.data : String(event.data)); }
        catch { clearTimeout(timer); closeQuietly(socket); reject(new BoundaryError("OUTBOUND_REJECTED", "hub sent invalid JSON")); return; }
        if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
          clearTimeout(timer); closeQuietly(socket); reject(new BoundaryError("OUTBOUND_REJECTED", "hub sent an invalid frame")); return;
        }
        const response = frame as Record<string, unknown>;
        if (response.id !== id || response.jsonrpc !== "2.0" || response.method !== undefined) {
          clearTimeout(timer); closeQuietly(socket); reject(new BoundaryError("OUTBOUND_REJECTED", "inbound mesh frames are not accepted")); return;
        }
        clearTimeout(timer);
        if (response.error !== undefined || response.result === undefined) reject(new BoundaryError("OUTBOUND_REJECTED", `${method} was rejected by the hub`));
        else resolve();
      };
      socket.onerror = () => { clearTimeout(timer); reject(new BoundaryError("OUTBOUND_REJECTED", `${method} connection failed`)); };
      try { socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); }
      catch { clearTimeout(timer); reject(new BoundaryError("OUTBOUND_REJECTED", `${method} could not be sent`)); }
    });
  }
}
