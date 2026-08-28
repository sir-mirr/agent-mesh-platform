import type {
  RestAgentListResponse,
  RestBehaviourMetrics,
  RestBehaviourResponse,
  RestHealthResponse,
  RestMailboxResponse,
  RestMetric,
} from "@agent-mesh/contracts";

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
  /** Identities whose registry row explicitly reports the `web` channel. */
  web_channel_identities: number | null;
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
export type Metric = RestMetric;

/**
 * **This declared six of the eight the route sends.**
 *
 * `pending_users` and `oldest_pending_user_ms` are on the wire — the route
 * spreads `shapeMetrics(...)`, and `packages/http/src/behaviour-metrics.ts`
 * names all eight — and this copy could not see either. A narrower copy does
 * not fail: it compiles, and the two metrics arrive and are dropped, so a
 * screen cannot show how many people are waiting to be admitted or how long the
 * oldest has waited. Both files' prose still says "the six", which is what the
 * count was when § D-1 chose them.
 *
 * Taking the contract's declaration is what makes a ninth metric a compile
 * error here instead of a field nobody notices.
 */
export type BehaviourMetrics = RestBehaviourMetrics;

const PANELS = [
  { key: "agents", path: "/api/v1/agents", panel: "agents", capability: "" },
  { key: "mailbox", path: "/api/v1/admin/mailbox", panel: "queue depth", capability: "mailbox.read.depth" },
  { key: "health", path: "/api/v1/health", panel: "health", capability: "" },
  { key: "behaviour", path: "/api/v1/admin/telemetry/behaviour", panel: "behaviour metrics", capability: "usage.read" },
] as const;

export async function fetchTelemetry(): Promise<SystemTelemetry> {
  const refused: Array<{ panel: string; capability: string }> = [];
  /**
   * One panel's answer, or `null` with the refusal recorded.
   *
   * Typed per call rather than once for the whole `Promise.all`: the four
   * panels answer four different shapes, and a single type over the array is
   * how they were all `any`.
   */
  const panel = <T>(index: number): Promise<T | null> => {
    const p = PANELS[index]!;
    return apiClient<T>(p.path).catch((err: unknown) => {
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
    });
  };
  const results = await Promise.all([
    panel<RestAgentListResponse>(0),
    panel<RestMailboxResponse>(1),
    panel<RestHealthResponse>(2),
    panel<RestBehaviourResponse>(3),
  ]);
  const [agents, mailbox, health, behaviour] = results;

  if (results.every((r) => r === null)) {
    throw new Error("Failed to fetch telemetry from server: all endpoints unreachable");
  }

  // The bare-array branch went — `/api/v1/agents` answers `{ agents }` — and
  // the array check stays, because nothing about a socket is guaranteed by a
  // type.
  const agentList = Array.isArray(agents?.agents) ? agents.agents : [];
  // **Two tables, two questions.** `health.agent_count` counts mesh identities
  // that are alive (`agents`, `deleted_at IS NULL`); `agentList.length` counts
  // rows in this server's own chat registry. Neither contains the other — a
  // hub-only identity is not in the registry and a web user is only there — so
  // substituting one for the other puts a different quantity under the same
  // label and nothing says it changed. Measured on the standing stack the day
  // this was written: 12 against 13.
  const totalAgents = health?.agent_count ?? null;
  const webChannelIdentities = agents === null
    ? null
    : agentList.filter((a) => a.channel === "web").length;

  return {
    web_channel_identities: webChannelIdentities,
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
