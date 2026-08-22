/**
 * Four panels, one call, and the difference between *may not* and *cannot*.
 *
 * `fetchTelemetry` asks four routes at once and each may fail on its own. A
 * refusal is the operator lacking a capability and is worth naming on the
 * screen; anything else is the backend being unreachable, which the empty state
 * already says. Getting that wrong in either direction has shipped here before:
 * a dashboard telling a member the server was down when it had answered `403`.
 *
 * The counting is the other half. `total_agents` comes from `health`, never
 * from the length of the agent list — two tables answering two questions, 12
 * against 13 on the standing stack the day it was measured.
 */
import { describe, it, expect, mock, afterEach } from "bun:test";
import { fetchTelemetry } from "./telemetry.ts";

const realFetch = globalThis.fetch;
/** bun:test has no global stubber, so the original goes back by hand — a
 *  forgotten restore would poison every file that runs after this one. */
const stub = (fn: unknown) => { globalThis.fetch = fn as typeof globalThis.fetch; };

const PATHS = {
  usage: "/api/v1/admin/ai-usage",
  agents: "/api/v1/agents",
  mailbox: "/api/v1/admin/mailbox",
  health: "/api/v1/health",
  behaviour: "/api/v1/admin/telemetry/behaviour",
};

/** Answer each route from a table; anything not in it is a 403 refusal. */
function routes(table: Partial<Record<keyof typeof PATHS, unknown>>, missing = 403) {
  const spy = mock(async (input: RequestInfo | URL) => {
    const url = String(input);
    const hit = (Object.keys(PATHS) as (keyof typeof PATHS)[]).find((k) => url.includes(PATHS[k]));
    const body = hit ? table[hit] : undefined;
    if (body === undefined) {
      // **Not the word "forbidden".** This used to be classified by matching
      // the message against /forbidden|capability|permission/i, so a refusal
      // phrased any other way was drawn as the backend being unreachable. The
      // status and the `capability` field are what decide it.
      return new Response(JSON.stringify({ error: "not allowed", capability: "usage.read" }),
        { status: missing, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  stub(spy);
  return spy;
}

afterEach(() => { globalThis.fetch = realFetch; });

describe("fetchTelemetry", () => {
  it("counts agents from health, not from the length of the registry list", async () => {
    routes({
      health: { status: "ok", agent_count: 12, uptime: 99, version: "0.2" },
      agents: { agents: [{ status: "active" }, { channel: "web" }, { status: "idle" }] },
      mailbox: { ok: true, mailboxes: [], total_queued: 7 },
      behaviour: { counting_since: null },
      usage: { ok: true },
    });
    const t = await fetchTelemetry();
    // 12, not 3: the registry list and the mesh identity count are different
    // quantities and putting one under the other's label says nothing changed.
    expect(t.total_agents).toBe(12);
    expect(t.web_channel_identities).toBe(1);
    expect(t.total_messages).toBe(7);
    expect(t.health_status).toBe("ok");
    expect(t.refused).toEqual([]);
  });

  it("keeps the server's refusal details when one panel is refused", async () => {
    routes({
      health: { status: "ok", agent_count: 1 },
      agents: { agents: [] },
      behaviour: { counting_since: null },
      // `mailbox` unanswered → 403
    });
    const t = await fetchTelemetry();
    // The capability comes from the server's field, not from the panel's guess.
    expect(t.refused.map((r) => r.capability)).toContain("usage.read");
    // The rest of the dashboard still draws.
    expect(t.total_agents).toBe(1);
  });

  it("does not call a 500 a refusal", async () => {
    routes({
      health: { status: "ok", agent_count: 1 },
      agents: { agents: [] },
      mailbox: { ok: true, mailboxes: [], total_queued: 0 },
      behaviour: { counting_since: null },
    }, 500);
    const t = await fetchTelemetry();
    // Being unable to ask is not being told no; the empty state says the rest.
    expect(t.refused).toEqual([]);
  });

  it("leaves a missing queue count null rather than drawing zero", async () => {
    routes({
      health: { status: "ok", agent_count: 1 },
      agents: { agents: [] },
      mailbox: { ok: true, mailboxes: [] },
      behaviour: { counting_since: null },
      usage: { ok: true },
    });
    // `0 queued` on a mesh with a backlog is the defect this null prevents.
    expect((await fetchTelemetry()).total_messages).toBe(null);
  });

  it("leaves the web-channel count null when the registry did not answer", async () => {
    routes({
      health: { status: "ok", agent_count: 1 },
      mailbox: { ok: true, mailboxes: [], total_queued: 0 },
      behaviour: { counting_since: null },
    });
    expect((await fetchTelemetry()).web_channel_identities).toBe(null);
  });

  it("throws only when every panel failed", async () => {
    routes({});
    await expect(fetchTelemetry()).rejects.toThrow(/unreachable/);
  });
});
