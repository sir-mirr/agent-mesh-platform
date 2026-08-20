/**
 * Per-tenant traffic, which is a question about a window.
 *
 * The route counts over the last `hours` hours and reports the window it used;
 * a total since the beginning answers "how much traffic" only on the first day.
 * This module takes no argument, so it can never narrow that window — which
 * makes the number on the column header the server's, and pinning that is the
 * point of the first test here: a `hours` query added on this side without
 * being reported back would put one period's count under another's label.
 *
 * The rest is pass-through, and that is worth an assertion of its own. Nothing
 * is defaulted here — an absent list stays absent rather than becoming an empty
 * one — and a refusal reaches the caller as a refusal instead of a tenant list
 * with nothing in it.
 */
import { describe, it, expect, mock, afterEach } from "bun:test";
import { fetchTenantTraffic } from "./tenants.ts";
import { ApiError, failureKind } from "./client.ts";

const realFetch = globalThis.fetch;
/** bun:test has no global stubber, so the original goes back by hand — a
 *  forgotten restore would poison every file that runs after this one. */
const stub = (fn: unknown) => { globalThis.fetch = fn as typeof globalThis.fetch; };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const spyOn = (body: unknown, status = 200) => {
  const spy = mock(async (_input: RequestInfo | URL, _init?: RequestInit) => json(body, status));
  stub(spy);
  return spy;
};

afterEach(() => { globalThis.fetch = realFetch; });

describe("fetchTenantTraffic", () => {
  it("asks for no window, so the one reported back is the server's", async () => {
    const spy = spyOn({ ok: true, hours: 24, tenants: [] });
    await fetchTenantTraffic();
    const url = String(spy.mock.calls[0]![0]);
    expect(url).toMatch(/\/api\/v1\/admin\/tenants$/);
    // No `?hours=`: the route clamps its own default, and a value sent from
    // here that the answer did not echo would label the table with a period the
    // counts were not taken over.
    expect(url).not.toContain("hours");
    // A plain GET, with no body to be dropped by a proxy that strips them.
    expect(spy.mock.calls[0]![1]!.method).toBeUndefined();
  });

  it("reports the window the counts were actually taken over", async () => {
    // Not the 24 the screen starts on. The route answers with the `hours` it
    // clamped to, and the header is drawn from this value rather than from the
    // request, so a screen showing 24h over 6h of data is what this prevents.
    spyOn({ ok: true, hours: 6, tenants: [] });
    expect((await fetchTenantTraffic()).hours).toBe(6);
  });

  it("hands each row through under the route's own column names", async () => {
    // `received`, `recipients`, `senders`, `via_mailbox`, `last_at` — the names
    // the SQL aliases to. Nothing is mapped here, so this row is the whole
    // contract, and a rename on either side fails it instead of rendering an
    // empty cell that reads as a zero.
    const row = {
      tenant: "acme",
      received: 42,
      recipients: 3,
      senders: 2,
      via_mailbox: 7,
      last_at: "2026-08-20T11:30:00Z",
    };
    spyOn({ ok: true, hours: 24, tenants: [row] });
    expect((await fetchTenantTraffic()).tenants[0]).toEqual(row);
  });

  it("keeps a null last delivery null", async () => {
    // `MAX(ts)` has no answer for a tenant with nothing in the window. A
    // placeholder in a timestamp column an operator compares by eye is worse
    // than a blank, and `0` would date it to 1970.
    spyOn({ ok: true, hours: 24, tenants: [{ tenant: "quiet", received: 0, recipients: 0, senders: 0, via_mailbox: 0, last_at: null }] });
    expect((await fetchTenantTraffic()).tenants[0]!.last_at).toBe(null);
  });

  it("does not invent an empty list for a body that carried none", async () => {
    // Deliberate, and it is why `TenantTrafficPage` keeps its own `|| []`. A
    // list defaulted here would let a body that answered nothing about tenants
    // render identically to one that answered "no tenants" — and the declared
    // return type already promises an array this function never checks for.
    spyOn({ ok: true, hours: 24 });
    expect((await fetchTenantTraffic()).tenants).toBeUndefined();
  });

  it("refuses rather than reporting a mesh with no tenants", async () => {
    // `tenant.read.stats` is a capability an operator can be missing, and the
    // screen says so with the server's own word for it. An empty table here
    // would be this console making a claim about the platform's traffic.
    spyOn({ error: "not allowed", capability: "tenant.read.stats" }, 403);
    const err = await fetchTenantTraffic().then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(failureKind(err)).toBe("refused");
    expect((err as ApiError).capability).toBe("tenant.read.stats");
  });

  it("calls a server that never answered unreachable, not refused", async () => {
    // The distinction this console has crossed twice: `status: null` is no
    // answer at all, and it is not a `4xx`.
    stub(mock(async () => { throw new TypeError("Failed to fetch"); }));
    const err = await fetchTenantTraffic().then(() => null, (e: unknown) => e);
    expect((err as ApiError).status).toBe(null);
    expect(failureKind(err)).toBe("unreachable");
  });
});
