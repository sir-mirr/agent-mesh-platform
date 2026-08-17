import { apiClient } from "./client.ts";

export interface SystemTelemetry {
  cpu_usage_pct: number | null;
  memory_used_mb: number | null;
  memory_total_mb: number | null;
  active_sockets: number;
  total_agents: number;
  total_messages: number | null;
  p99_latency_ms: number | null;
}

export async function fetchTelemetry(): Promise<SystemTelemetry> {
  const [usage, agents, mailbox] = await Promise.all([
    apiClient<any>("/api/v1/admin/ai-usage"),
    apiClient<any>("/api/v1/agents"),
    apiClient<any>("/api/v1/admin/mailbox"),
  ]);

  const agentList: any[] = Array.isArray(agents) ? agents : agents?.agents ?? [];
  const totalAgents = agentList.length;
  const activeSockets = agentList.filter((a: any) => a.status === "active" || a.channel === "web").length;

  return {
    cpu_usage_pct: usage?.cpu_pct ?? null,
    memory_used_mb: usage?.memory_mb ?? null,
    memory_total_mb: usage?.memory_total_mb ?? null,
    active_sockets: activeSockets,
    total_agents: totalAgents,
    total_messages: mailbox?.total_queued != null ? mailbox.total_queued : (Array.isArray(mailbox?.mailboxes) && mailbox.mailboxes.length > 0 ? mailbox.mailboxes.reduce((acc: number, m: any) => acc + (m.depth || 0), 0) : null),
    p99_latency_ms: usage?.p99_latency_ms ?? null,
  };
}
