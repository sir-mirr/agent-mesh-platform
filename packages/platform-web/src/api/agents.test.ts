/**
 * The registry reader, the key queue mid-rename, and "how long ago".
 *
 * Two things here have already been wrong on a screen. `fingerprint` defaulted
 * to the literal `sha256:verified_mesh_identity`, so every agent matched under
 * a column an operator compares by eye; and `lastSeen` used to return Korean
 * prose from a module with no dictionary in reach, which printed Korean into an
 * English console. Both are shapes, not sentences, now — and a shape is
 * assertable without a browser.
 */
import { describe, it, expect, mock, afterEach } from "bun:test";
import { setSystemTime } from "bun:test";
import {
  agentMemberIdentities, agentRegistryEntries, callableAgentRegistryEntries, fetchAgents, fetchPendingKeys, approveKeyProposal, denyKeyProposal,
  createPairingCodeApi, teardownAgentApi, lastSeen, lastSeenText, hasBeenSeen,
  type TeardownAction, type TeardownResponse,
} from "./agents.ts";

const realFetch = globalThis.fetch;
/** bun:test has no global stubber, so the original goes back by hand — a
 *  forgotten restore would poison every file that runs after this one. */
const stub = (fn: unknown) => { globalThis.fetch = fn as typeof globalThis.fetch; };

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const spyOn = (body: unknown) => {
  const spy = mock(async (_input: RequestInfo | URL, _init?: RequestInit) => json(body));
  stub(spy);
  return spy;
};

afterEach(() => { globalThis.fetch = realFetch; setSystemTime(); });

describe("fetchAgents", () => {
  it("keeps the unified response intact and lets agent-labelled views remove people", async () => {
    spyOn({ agents: [
      { id: "admin", type: "user", tenant: "default", deleted_at: null },
      { id: "worker-1", type: "worker", tenant: "acme", deleted_at: null },
      { id: "relay-1", type: "service", tenant: "acme", deleted_at: null },
    ] });

    const registry = await fetchAgents();
    // The API reader still represents the server's whole unified registry.
    expect(registry.map((entry) => entry.identity)).toEqual(["admin", "worker-1", "relay-1"]);
    // The view rule is narrower: a person never becomes an agent count or row.
    expect(agentRegistryEntries(registry).map((entry) => entry.identity)).toEqual(["worker-1", "relay-1"]);
    expect(registry.map((entry) => entry.tenant)).toEqual(["default", "acme", "acme"]);
  });

  it("keeps teardown history in inventory and removes it only from callable choices", async () => {
    spyOn({ agents: [
      { id: "never-seen-live", type: "worker", tenant: "acme", last_seen_at: null, deleted_at: null },
      {
        id: "seen-then-torn-down",
        type: "worker",
        tenant: "acme",
        last_seen_at: "2026-08-28T01:00:00Z",
        deleted_at: "2026-08-28T02:00:00Z",
      },
    ] });

    const registry = await fetchAgents();
    expect(registry.map((entry) => [entry.identity, entry.deleted_at])).toEqual([
      ["never-seen-live", null],
      ["seen-then-torn-down", "2026-08-28T02:00:00Z"],
    ]);
    // Inventory answers what happened to a name, so both rows remain.
    expect(agentRegistryEntries(registry).map((entry) => entry.identity))
      .toEqual(["never-seen-live", "seen-then-torn-down"]);
    // A destination answers who can be called. The live-but-never-seen row is
    // retained, proving this branches on deleted_at and not last_seen_at.
    expect(callableAgentRegistryEntries(registry).map((entry) => entry.identity))
      .toEqual(["never-seen-live"]);
  });

  it("asks the registry for one tenant when a group picker names it", async () => {
    const spy = spyOn({ agents: [{ id: "worker-1", type: "worker", tenant: "lane/a" }] });
    await fetchAgents("lane/a");

    expect(String(spy.mock.calls[0]![0])).toMatch(/\/api\/v1\/agents\?tenant=lane%2Fa$/);
  });

  it("keeps only registry-confirmed agents inside a mixed identity group", () => {
    const registry = [
      { identity: "admin", type: "user" },
      { identity: "worker-1", type: "worker" },
      { identity: "relay-1", type: "service" },
    ];

    expect(agentMemberIdentities(["admin", "worker-1", "unknown", "relay-1"], registry))
      .toEqual(["worker-1", "relay-1"]);
  });

  it("leaves an absent fingerprint absent", async () => {
    spyOn({ agents: [{ id: "a-1", name: "a-1", type: "agent", channel: "native" }] });
    const [row] = await fetchAgents();
    // A constant here makes every agent match the one an operator is checking
    // against, and the word `verified` in it invites skipping the check.
    expect(row!.fingerprint).toBe(null);
    expect(row!.tenant).toBe(null);
  });

  /**
   * These two replace a pair that asserted the fallbacks.
   *
   * One fed `[{ id }, { name }, {}]` and required `["by-id", "by-name",
   * "unknown"]`; the other fed a bare array. Both passed, and neither row shape
   * is one `GET /api/v1/agents` can produce — the route answers `{ agents }`
   * and every row has an `id`, because it is the table's primary key. A test
   * written from the reader's fallback list checks that the fallbacks are still
   * there, which is not the same as checking the reader is right.
   *
   * What is worth holding is the pair of facts that survive: the name the route
   * actually sends is the one read, and a body that is not the agreed shape
   * draws nothing rather than throwing.
   */
  it("takes the row's `id` as the identity, which is the name the route sends", async () => {
    spyOn({ agents: [{ id: "by-id", name: "By Id", type: "agent", channel: "native", tenant: "default" }] });
    expect((await fetchAgents()).map((a) => a.identity)).toEqual(["by-id"]);
  });

  it("refuses a body it does not recognise instead of reporting an empty mesh", async () => {
    // A type is a claim about a correct server; an old build, a proxy or an
    // error page can still answer anything. `[]` here would be a claim about
    // the mesh made out of a fact about the read, and the screen has a
    // separate state for a read that failed.
    spyOn([{ identity: "a-1" }]);
    expect(fetchAgents()).rejects.toThrow(/does not know that shape/);
  });
});

describe("fetchPendingKeys", () => {
  it("reads `keys`, the name D-689 moved the route to", async () => {
    spyOn({ ok: true, keys: [{ identity: "joiner", fingerprint: "sha256:aa" }] });
    expect((await fetchPendingKeys())[0]!.identity).toBe("joiner");
  });

  it("refuses the body rather than reading the other queue's name", async () => {
    // `admin/pending` (people) and `admin/keys/pending` (keys) answered the
    // same body one path segment apart. Reading `pending` here would make this
    // queue silently show that one — and answering `[]` would make a server
    // still on the old name look like a queue with nothing in it.
    spyOn({ ok: true, pending: [{ identity: "wrong-queue" }] });
    expect(fetchPendingKeys()).rejects.toThrow(/does not know that shape/);
  });
});

describe("the key decisions", () => {
  it("always sends a reason, so the audit row is never blank", async () => {
    let spy = spyOn({ ok: true });
    await approveKeyProposal("sha256:aa");
    expect(JSON.parse(String(spy.mock.calls[0]![1]!.body)).reason).toBeTruthy();
    spy = spyOn({ ok: true });
    await denyKeyProposal("sha256:aa");
    expect(JSON.parse(String(spy.mock.calls[0]![1]!.body)).reason).toBeTruthy();
  });

  it("carries the operator's own reason when they give one", async () => {
    const spy = spyOn({ ok: true });
    await denyKeyProposal("sha256:aa", "fingerprint did not match the one on the card");
    expect(JSON.parse(String(spy.mock.calls[0]![1]!.body)).reason)
      .toBe("fingerprint did not match the one on the card");
  });
});

describe("createPairingCodeApi", () => {
  it("defaults the lifetime rather than leaving it to the server", async () => {
    const spy = spyOn({ ok: true, code: "123456", identity: "a-1", expires_at: "", ttl_seconds: 300 });
    await createPairingCodeApi("a-1");
    expect(JSON.parse(String(spy.mock.calls[0]![1]!.body)).ttl_seconds).toBe(300);
  });
});

describe("teardownAgentApi", () => {
  it("escapes the identity into the path", async () => {
    const spy = spyOn({ ok: true, identity: "lane/a b", action: "soft-deleted" });
    await teardownAgentApi("lane/a b");
    expect(String(spy.mock.calls[0]![0])).toContain("lane%2Fa%20b");
    expect(spy.mock.calls[0]![1]!.method).toBe("DELETE");
  });

  it("preserves each teardown action and each deleted_at state instead of folding them", async () => {
    const replies: TeardownResponse[] = [
      { ok: true, identity: "lane-a", action: "soft-deleted", deleted_at: "2026-08-28T05:00:00Z" },
      { ok: true, identity: "lane-a", action: "already-deleted", deleted_at: null },
      { ok: true, identity: "lane-a", action: "not-found" },
    ];
    const actions: TeardownAction[] = replies.map((reply) => reply.action);
    expect(actions).toEqual(["soft-deleted", "already-deleted", "not-found"]);
    for (const reply of replies) {
      spyOn(reply);
      const received = await teardownAgentApi("lane-a");
      expect(received).toEqual(reply);
      expect(Object.hasOwn(received, "deleted_at")).toBe(Object.hasOwn(reply, "deleted_at"));
    }
  });
});

describe("lastSeen", () => {
  it("calls no record `never`, which is not the same as offline", () => {
    // SPEC § 9.1: `last_seen_at: null` means the mesh holds no presence record.
    expect(lastSeen(null)).toEqual({ kind: "never" });
    expect(lastSeen(undefined)).toEqual({ kind: "never" });
    expect(lastSeen("not a date")).toEqual({ kind: "invalid" });
    expect(lastSeen("2026-08-20 12:00:00")).toEqual({ kind: "invalid" });
    expect(lastSeen("2026-08-20T12:00:00+09:00")).toEqual({ kind: "invalid" });
    expect(lastSeen("2026-02-30T12:00:00Z")).toEqual({ kind: "invalid" });
    expect(hasBeenSeen({ last_seen_at: null })).toBe(false);
    // Presence was reported even though its time cannot be parsed. Callers
    // needing that distinction use `lastSeen`, not this boolean projection.
    expect(hasBeenSeen({ last_seen_at: "not a date" })).toBe(true);
    expect(hasBeenSeen({ last_seen_at: "2026-08-20T12:00:00Z" })).toBe(true);
  });

  it("picks the unit by size and never goes negative", () => {
    setSystemTime(new Date("2026-08-20T12:00:00Z"));
    const at = (secondsAgo: number) =>
      new Date(Date.parse("2026-08-20T12:00:00Z") - secondsAgo * 1000).toISOString();
    expect(lastSeen(at(5))).toEqual({ kind: "ago", unit: "second", value: 5 });
    expect(lastSeen(at(59))).toEqual({ kind: "ago", unit: "second", value: 59 });
    expect(lastSeen(at(60))).toEqual({ kind: "ago", unit: "minute", value: 1 });
    expect(lastSeen(at(3599))).toEqual({ kind: "ago", unit: "minute", value: 59 });
    expect(lastSeen(at(3600))).toEqual({ kind: "ago", unit: "hour", value: 1 });
    expect(lastSeen(at(86_400))).toEqual({ kind: "ago", unit: "day", value: 1 });
    // A clock behind the server's would otherwise read "-3 seconds ago".
    expect(lastSeen(at(-30))).toEqual({ kind: "ago", unit: "second", value: 0 });
  });
});

describe("lastSeenText", () => {
  it("composes the sentence from the caller's dictionary, not its own", () => {
    setSystemTime(new Date("2026-08-20T12:00:00Z"));
    const t = (key: string, _fallback: string) => `[${key}]`;
    expect(lastSeenText(t, null)).toBe("[agents.neverSeen]");
    expect(lastSeenText(t, "not a date")).toBe("[agents.invalidLastSeen]");
    expect(lastSeenText(t, "2026-08-20T09:00:00Z")).toBe("3[agents.unit.hour] [agents.ago]");
  });
});
