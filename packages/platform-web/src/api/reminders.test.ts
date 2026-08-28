import { afterEach, describe, expect, it, mock } from "bun:test";

import { decideOverdueReminder, fetchOverdueReminders } from "./reminders.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("overdue reminder API", () => {
  it("reads held slots and recorded decisions together from the operator route", async () => {
    const reply = {
      ok: true,
      reminders: [{
        reminder_id: "once:billing",
        agent_id: "agent-7",
        scheduled_at: "2026-08-29T01:02:03.000Z",
        held_since: "2026-08-29T01:07:03.000Z",
        overdue_ms: 300_000,
        status: "active",
      }],
      decisions: [{
        reminder_id: "once:closed",
        scheduled_at: "2026-08-28T08:00:00.000Z",
        decision: "skip",
        approval_ref: "APPROVED: incident-71",
        decided_at: "2026-08-28T08:10:00.000Z",
        decided_by: "operator-kim",
      }],
    };
    const fetchSpy = mock(async (_input: RequestInfo | URL, _options?: RequestInit) => json(reply));
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    expect(await fetchOverdueReminders()).toEqual({
      reminders: reply.reminders,
      decisions: reply.decisions,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain("/api/v1/admin/reminders/overdue");
  });

  it("refuses to call a malformed holds response an empty queue", async () => {
    globalThis.fetch = mock(async () => json({ ok: true, decisions: [] })) as unknown as typeof globalThis.fetch;
    await expect(fetchOverdueReminders()).rejects.toThrow("'reminders' array");
  });

  it("refuses to hide a malformed decision history behind an empty list", async () => {
    globalThis.fetch = mock(async () => json({ ok: true, reminders: [] })) as unknown as typeof globalThis.fetch;
    await expect(fetchOverdueReminders()).rejects.toThrow("'decisions' array");
  });

  it("posts replay against the exact listed slot key and preserves the approval", async () => {
    const fetchSpy = mock(async (_input: RequestInfo | URL, _options?: RequestInit) => json({ ok: true }));
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    const scheduledAt = "2026-08-29T01:02:03.000Z";

    await decideOverdueReminder("once/billing", {
      scheduled_at: scheduledAt,
      decision: "replay",
      approval_ref: "APPROVED: incident-72",
    });

    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain(
      "/api/v1/admin/reminders/overdue/once%2Fbilling/decision",
    );
    const options = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(options.method).toBe("POST");
    expect(JSON.parse(String(options.body))).toEqual({
      scheduled_at: scheduledAt,
      decision: "replay",
      approval_ref: "APPROVED: incident-72",
    });
  });

  it("posts skip as skip instead of folding both decisions together", async () => {
    const fetchSpy = mock(async (_input: RequestInfo | URL, _options?: RequestInit) => json({ ok: true }));
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await decideOverdueReminder("once-skip", {
      scheduled_at: "2026-08-29T02:03:04.000Z",
      decision: "skip",
      approval_ref: "APPROVED: incident-73",
    });

    const options = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(options.body))).toEqual({
      scheduled_at: "2026-08-29T02:03:04.000Z",
      decision: "skip",
      approval_ref: "APPROVED: incident-73",
    });
  });
});
