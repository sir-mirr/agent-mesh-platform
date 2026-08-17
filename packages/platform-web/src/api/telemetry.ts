import { apiClient } from "./client.ts";

export interface SystemTelemetry {
  cpu_usage_pct: number;
  memory_used_mb: number;
  memory_total_mb: number;
  active_sockets: number;
  total_agents: number;
  total_messages: number;
  p99_latency_ms: number;
}

export async function fetchTelemetry(): Promise<SystemTelemetry> {
  const [usage, agents, mailbox] = await Promise.all([
    apiClient<any>("/api/v1/admin/ai-usage").catch(() => null),
    apiClient<any>("/api/v1/agents").catch(() => []),
    apiClient<any>("/api/v1/admin/mailbox").catch(() => null),
  ]);

  const agentList: any[] = Array.isArray(agents) ? agents : agents?.agents ?? [];
  const totalAgents = agentList.length;
  const activeSockets = agentList.filter((a: any) => a.status === "active" || a.channel === "web").length;

  return {
    cpu_usage_pct: usage?.cpu_pct ?? 0,
    memory_used_mb: usage?.memory_mb ?? 0,
    memory_total_mb: usage?.memory_total_mb ?? 0,
    active_sockets: activeSockets,
    total_agents: totalAgents,
    total_messages: mailbox?.total_queued ?? 0,
    p99_latency_ms: usage?.p99_latency_ms ?? 0,
  };
}
