import type {
  MeshAgent,
  MeshMessageHistoryEntry,
  ReminderRow,
} from "./mesh-types";
import type { MeshToolsHub } from "./mesh-tools";

export interface HttpMeshToolsHubOptions {
  baseUrl: string;
  token: string | null;
  fetchImpl?: FetchLike;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type MeshToolAction =
  | "send"
  | "list_agents"
  | "fetch_messages"
  | "schedule_reminder"
  | "cancel_reminder"
  | "list_reminders";

function normalizeBaseUrl(raw: string): string {
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

/**
 * Calls the adapter's loopback action proxy. This deliberately has no hub
 * client or WebSocket dependency: the running adapter owns the sole hub
 * connection for its identity.
 */
export class HttpMeshToolsHub implements MeshToolsHub {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: HttpMeshToolsHubOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? (fetch as FetchLike);
  }

  private async action<T>(action: MeshToolAction, body: Record<string, unknown>): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/actions/mesh`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}),
        },
        body: JSON.stringify({ action, ...body }),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`adapter action proxy unavailable: ${detail}`);
    }

    const payload = await response.json().catch(() => null) as
      | { result?: T; error?: unknown; detail?: unknown }
      | null;
    if (!response.ok) {
      const detail = typeof payload?.detail === "string"
        ? payload.detail
        : typeof payload?.error === "string"
          ? payload.error
          : `HTTP ${response.status}`;
      throw new Error(`adapter action proxy failed: ${detail}`);
    }
    if (!payload || !("result" in payload)) {
      throw new Error("adapter action proxy returned an invalid response");
    }
    return payload.result as T;
  }

  send(opts: { to: string; from: string; content: string; reply_to: string | null }): Promise<unknown> {
    return this.action("send", {
      to: opts.to,
      content: opts.content,
      reply_to: opts.reply_to,
    });
  }

  async listAgents(): Promise<MeshAgent[]> {
    const result = await this.action<{ agents?: MeshAgent[] }>("list_agents", {});
    return result.agents ?? [];
  }

  async fetchMessages(opts: { agentId: string; limit?: number }): Promise<MeshMessageHistoryEntry[]> {
    const result = await this.action<{ messages?: MeshMessageHistoryEntry[] }>("fetch_messages", {
      agent_id: opts.agentId,
      ...(opts.limit === undefined ? {} : { limit: opts.limit }),
    });
    return result.messages ?? [];
  }

  scheduleReminder(opts: {
    id: string;
    type: "once" | "cron";
    scheduleSpec: string;
    payload: string;
    nextFireAt: string;
    context?: string;
    idempotencyKey?: string;
  }): Promise<{ ok: boolean; id: string; type: string; next_fire_at: string }> {
    return this.action("schedule_reminder", {
      id: opts.id,
      type: opts.type,
      schedule_spec: opts.scheduleSpec,
      payload: opts.payload,
      next_fire_at: opts.nextFireAt,
      ...(opts.context === undefined ? {} : { context: opts.context }),
      ...(opts.idempotencyKey === undefined ? {} : { idempotency_key: opts.idempotencyKey }),
    });
  }

  cancelReminder(id: string): Promise<{ changes: number }> {
    return this.action("cancel_reminder", { id });
  }

  async listReminders(opts: { status?: string; limit?: number }): Promise<ReminderRow[]> {
    const result = await this.action<{ rows?: ReminderRow[] }>("list_reminders", {
      ...(opts.status === undefined ? {} : { status: opts.status }),
      ...(opts.limit === undefined ? {} : { limit: opts.limit }),
    });
    return result.rows ?? [];
  }
}
