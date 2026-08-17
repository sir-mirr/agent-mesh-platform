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
}

export async function fetchTelemetry(): Promise<SystemTelemetry> {
  const [usage, agents, mailbox, health] = await Promise.all([
    apiClient<any>("/api/v1/admin/ai-usage").catch(() => null),
    apiClient<any>("/api/v1/agents").catch(() => null),
    apiClient<any>("/api/v1/admin/mailbox").catch(() => null),
    apiClient<any>("/api/v1/health").catch(() => null),
  ]);

  if (usage === null && agents === null && mailbox === null && health === null) {
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
  };
}
