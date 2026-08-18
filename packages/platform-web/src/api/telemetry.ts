import { apiClient } from "./client.ts";

export interface SystemTelemetry {
  cpu_usage_pct: number | null;
  memory_used_mb: number | null;
  memory_total_mb: number | null;
  active_sockets: number;
  total_agents: number;
  total_messages: number | null;
  p99_latency_ms: number | null;
  health_status?: string | undefined;
  server_uptime_seconds?: number | undefined;
  build_version?: string | undefined;
  /**
   * Panels this session was refused, by the capability that would have opened
   * them. Empty when everything answered.
   *
   * **A refusal and an idle mesh looked identical before this.** Two of the
   * four endpoints are ungated — `/api/v1/agents` and `/api/v1/health`, because
   * none of § 11's twelve capabilities names reading the registry — so they
   * always answer, the "all four failed" throw below was unreachable for a
   * capability refusal, and the page rendered its normal layout with `—` in the
   * cells the caller was not allowed to see. agent-mesh-local-pm measured it as
   * 999 bytes before and 999 bytes after: **the screen made no statement about
   * the backend at all.**
   */
  refused: Array<{ panel: string; capability: string }>;
}

/**
 * What each endpoint is for, and what it costs to be told no.
 *
 * `null` from a fetch says only *nothing came back*. Which of the two reasons
 * it was — refused, or unreachable — is the thing the screen has to pass on,
 * and `.catch(() => null)` threw it away.
 */
const PANELS = [
  { key: "usage", path: "/api/v1/admin/ai-usage", panel: "CPU · memory · p99", capability: "usage.read" },
  { key: "agents", path: "/api/v1/agents", panel: "agents", capability: "" },
  { key: "mailbox", path: "/api/v1/admin/mailbox", panel: "queue depth", capability: "mailbox.read.depth" },
  { key: "health", path: "/api/v1/health", panel: "health", capability: "" },
] as const;

export async function fetchTelemetry(): Promise<SystemTelemetry> {
  const refused: Array<{ panel: string; capability: string }> = [];
  const results = await Promise.all(
    PANELS.map((p) =>
      apiClient<any>(p.path).catch((err: unknown) => {
        // The message `apiClient` throws carries the server's `error` field,
        // and § 11.3's refusal says `capability`. Anything else is the backend
        // being unreachable, which the empty state already communicates.
        if (p.capability && /forbidden|capability|permission/i.test(String(err))) {
          refused.push({ panel: p.panel, capability: p.capability });
        }
        return null;
      }),
    ),
  );
  const [usage, agents, mailbox, health] = results;

  if (results.every((r) => r === null)) {
    throw new Error("Failed to fetch telemetry from server: all endpoints unreachable");
  }

  const agentList: any[] = Array.isArray(agents) ? agents : agents?.agents ?? [];
  const totalAgents = health?.agent_count != null ? health.agent_count : agentList.length;
  const activeSockets = agentList.filter((a: any) => a.status === "active" || a.channel === "web").length;

  return {
    cpu_usage_pct: usage?.cpu_pct ?? null,
    memory_used_mb: usage?.memory_mb ?? null,
    memory_total_mb: usage?.memory_total_mb ?? null,
    active_sockets: activeSockets,
    total_agents: totalAgents,
    total_messages: mailbox?.total_queued != null ? mailbox.total_queued : (Array.isArray(mailbox?.mailboxes) && mailbox.mailboxes.length > 0 ? mailbox.mailboxes.reduce((acc: number, m: any) => acc + (m.depth || 0), 0) : null),
    p99_latency_ms: usage?.p99_latency_ms ?? null,
    health_status: health?.status ?? undefined,
    server_uptime_seconds: health?.uptime ?? undefined,
    build_version: health?.version ?? undefined,
    refused,
  };
}
