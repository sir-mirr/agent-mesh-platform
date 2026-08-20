import { apiClient, failureKind, refusedCapability } from "./client.ts";

/**
 * **What `/api/v1/admin/ai-usage` actually answers.**
 *
 * This carried `cpu_usage_pct`, `memory_used_mb`, `memory_total_mb` and
 * `p99_latency_ms` for as long as it existed, and no producer in this repository
 * ever wrote them: the ingest route reads `accounts`, `schema_version`, `source`
 * and `ts`, and `AiUsageSnapshot` holds those plus `last_updated_at`. AI account
 * usage and machine telemetry are different domains, and a route cannot invent
 * what nothing sends it — `platform-claude` confirmed there is no plan to add
 * them, so these were not a contract in transit.
 *
 * Every `!= null` guard reading them was therefore dead, and about twenty-five
 * of them across three screens each rendered a fallback that looked like a
 * measurement: `0ms`, `0%`, a dash where a number belongs. What is measured and
 * carries its own unknowns is `GET /api/v1/admin/telemetry/behaviour`, whose
 * every metric is `{value, unavailable}`.
 */
export interface SystemTelemetry {
  active_sockets: number;
  /** `null` when `/api/v1/health` did not answer. Not the registry's length. */
  total_agents: number | null;
  total_messages: number | null;
  health_status?: string | undefined;
  server_uptime_seconds?: number | undefined;
  build_version?: string | undefined;
  /**
   * The six behavioural metrics § D-1 chose over CPU and memory gauges
   * (`SC-SCR10-01`). `null` inside each one means it could not be read — never
   * a stand-in, because four of the six read `0` when all is well.
   */
  behaviour: BehaviourMetrics | null;
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
export interface Metric {
  value: number | null;
  unavailable?: string;
}

export interface BehaviourMetrics {
  counting_since: string | null;
  pending_keys: Metric;
  oldest_pending_ms: Metric;
  signature_refusals: Metric;
  rate_limited: Metric;
  egress_refusals: Metric;
  accepted: Metric;
}

const PANELS = [
  { key: "usage", path: "/api/v1/admin/ai-usage", panel: "CPU · memory · p99", capability: "usage.read" },
  { key: "agents", path: "/api/v1/agents", panel: "agents", capability: "" },
  { key: "mailbox", path: "/api/v1/admin/mailbox", panel: "queue depth", capability: "mailbox.read.depth" },
  { key: "health", path: "/api/v1/health", panel: "health", capability: "" },
  { key: "behaviour", path: "/api/v1/admin/telemetry/behaviour", panel: "behaviour metrics", capability: "usage.read" },
] as const;

export async function fetchTelemetry(): Promise<SystemTelemetry> {
  const refused: Array<{ panel: string; capability: string }> = [];
  const results = await Promise.all(
    PANELS.map((p) =>
      apiClient<any>(p.path).catch((err: unknown) => {
        // **Read the status, not the sentence.** This matched
        // `/forbidden|capability|permission/i` against the error message, which
        // is the thing `ApiError` exists to stop: § 11.3's refusal carries
        // `capability` as a field, and the sibling comment in `client.ts` says
        // so. Matching prose got it wrong in both directions — a `500` whose
        // body happened to say "forbidden" was drawn as a capability the
        // operator lacks, and a `403` phrased any other way ("not allowed",
        // "insufficient scope") was drawn as the backend being down. Every
        // other reader on this console already uses `failureKind`.
        if (failureKind(err) === "refused") {
          refused.push({ panel: p.panel, capability: refusedCapability(err) ?? p.capability });
        }
        return null;
      }),
    ),
  );
  const [usage, agents, mailbox, health, behaviour] = results;

  if (results.every((r) => r === null)) {
    throw new Error("Failed to fetch telemetry from server: all endpoints unreachable");
  }

  const agentList: any[] = Array.isArray(agents) ? agents : agents?.agents ?? [];
  // **Two tables, two questions.** `health.agent_count` counts mesh identities
  // that are alive (`agents`, `deleted_at IS NULL`); `agentList.length` counts
  // rows in this server's own chat registry. Neither contains the other — a
  // hub-only identity is not in the registry and a web user is only there — so
  // substituting one for the other puts a different quantity under the same
  // label and nothing says it changed. Measured on the standing stack the day
  // this was written: 12 against 13.
  const totalAgents = health?.agent_count ?? null;
  const activeSockets = agentList.filter((a: any) => a.status === "active" || a.channel === "web").length;

  return {
    active_sockets: activeSockets,
    total_agents: totalAgents,
    // `fetchAdminMailbox` has already summed the route's own `pending`
    // column and left `null` for "the route did not answer with a list".
    // Re-deriving it here is what produced the second copy of the defect:
    // both this line and the one it called read `total_queued` and `depth`,
    // two names no route sends, so the panel showed `0` messages queued on a
    // mesh with a backlog.
    total_messages: mailbox?.total_queued ?? null,
    health_status: health?.status ?? undefined,
    server_uptime_seconds: health?.uptime ?? undefined,
    build_version: health?.version ?? undefined,
    behaviour: behaviour ?? null,
    refused,
  };
}
