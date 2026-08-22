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
 * The rest is pass-through, and pass-through is the assertion: nothing is
 * mapped, nothing is defaulted — an absent list stays absent rather than
 * becoming an empty one — and a failure arrives as a failure instead of as a
 * tenant list with nothing in it. Since `fetch` is stubbed throughout, none of
 * that says anything about the route's own column names; `test/tenant-stats.test.ts`
 * is where those are held, against the real handler.
 */
import { describe, it, expect, mock, afterEach } from "bun:test";
import {
  createTenantApi,
  deleteTenantApi,
  fetchTenantDirectory,
  fetchTenantTraffic,
  renameTenantApi,
} from "./tenants.ts";

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
    // A read, which is the rule — not "the `method` key is absent", which is a
    // snapshot of what `apiClient` happens to pass and fires on `{ method:
    // "GET" }`, a request identical in every way that reaches the route. What
    // would change the answer is a verb that writes, or a body for a proxy to
    // strip.
    const init = spy.mock.calls[0]![1];
    expect((init?.method ?? "GET").toUpperCase()).toBe("GET");
    expect(init?.body).toBeUndefined();
  });

  it("hands the whole answer back exactly as it arrived", async () => {
    // One assertion over the whole body rather than a field each, because the
    // property is that no mapping layer exists between the route and the
    // screen — this function is `return apiClient(url)`, and a per-field test
    // of a pass-through asserts that JSON round-trips.
    //
    // What it does catch: `hours` is 6 here and never the 24 the screen starts
    // on, so a window taken from the request rather than the answer puts one
    // period's counts under another's label; the row keeps the names the SQL
    // aliases to; and `MAX(ts)` for a tenant with nothing in the window stays
    // null, where a placeholder in a column an operator compares by eye is
    // worse than a blank and `0` would date it to 1970.
    //
    // What it cannot catch, and does not claim to: fetch is stubbed, so a
    // rename on the *route's* side stays green here and renders a blank cell.
    // That half is held by `test/tenant-stats.test.ts`, which runs the real
    // handler against the real SQL.
    const body = {
      ok: true,
      hours: 6,
      tenants: [
        { tenant: "acme", received: 42, recipients: 3, senders: 2, via_mailbox: 7, last_at: "2026-08-20T11:30:00Z" },
        { tenant: "quiet", received: 0, recipients: 0, senders: 0, via_mailbox: 0, last_at: null },
      ],
    };
    spyOn(body);
    expect(await fetchTenantTraffic()).toEqual(body);
  });

  it("does not invent an empty list for a body that carried none", async () => {
    // Deliberate, and it is why `TenantTrafficPage` keeps its own `|| []`. A
    // list defaulted here would let a body that answered nothing about tenants
    // render identically to one that answered "no tenants" — and the declared
    // return type already promises an array this function never checks for.
    spyOn({ ok: true, hours: 24 });
    expect((await fetchTenantTraffic()).tenants).toBeUndefined();
  });

  it("answers nothing at all when the server refused, or was not there", async () => {
    // A table with nothing in it would be this console making a claim about the
    // platform's traffic out of a fact about the session, and `TenantTrafficPage`
    // has a `|| []` waiting to draw exactly that — so what this module owes is
    // to answer with nothing rather than with a body, for a server that refused
    // and for one that never answered alike. Telling those two apart —
    // `refused` against `unreachable`, and the capability the server named — is
    // `client.ts`'s decision, asserted in `client.test.ts` against these same
    // two responses. There is no third place it is made.
    spyOn({ error: "not allowed", capability: "tenant.read.stats" }, 403);
    expect(await fetchTenantTraffic().then((res) => res, () => "rejected")).toBe("rejected");
    stub(mock(async () => { throw new TypeError("Failed to fetch"); }));
    expect(await fetchTenantTraffic().then((res) => res, () => "rejected")).toBe("rejected");
  });
});

describe("the tenant directory contract", () => {
  it("keeps the directory route distinct from traffic statistics", async () => {
    const body = {
      ok: true,
      tenant: "default",
      tenants: [{ id: "default", name: "플랫폼", created_at: "now", deleted_at: null }],
    };
    const spy = spyOn(body);
    expect(await fetchTenantDirectory()).toEqual(body);
    expect(String(spy.mock.calls[0]![0])).toMatch(/\/api\/v1\/admin\/tenants\/directory$/);
    expect((spy.mock.calls[0]![1]?.method ?? "GET").toUpperCase()).toBe("GET");
  });

  it("creates with the id and display name the operator supplied", async () => {
    const spy = spyOn({ ok: true, tenant: null });
    await createTenantApi("tenant-a", "Tenant A");
    expect(String(spy.mock.calls[0]![0])).toMatch(/\/api\/v1\/admin\/tenants$/);
    expect(spy.mock.calls[0]![1]?.method).toBe("POST");
    expect(JSON.parse(String(spy.mock.calls[0]![1]?.body))).toEqual({ id: "tenant-a", name: "Tenant A" });
  });

  it("encodes a tenant id in rename and delete paths", async () => {
    const renameSpy = spyOn({ ok: true, tenant: null });
    await renameTenantApi("tenant/a", "Renamed");
    expect(String(renameSpy.mock.calls[0]![0])).toMatch(/\/api\/v1\/admin\/tenants\/tenant%2Fa$/);
    expect(renameSpy.mock.calls[0]![1]?.method).toBe("PATCH");
    expect(JSON.parse(String(renameSpy.mock.calls[0]![1]?.body))).toEqual({ name: "Renamed" });

    const deleteSpy = spyOn({ ok: true, action: "deleted", tenant: null });
    await deleteTenantApi("tenant/a");
    expect(String(deleteSpy.mock.calls[0]![0])).toMatch(/\/api\/v1\/admin\/tenants\/tenant%2Fa$/);
    expect(deleteSpy.mock.calls[0]![1]?.method).toBe("DELETE");
    expect(deleteSpy.mock.calls[0]![1]?.body).toBeUndefined();
  });

  it("does not turn a refused directory read into an empty directory", async () => {
    spyOn({ ok: false, error: "platform admin only" }, 403);
    expect(await fetchTenantDirectory().then(() => "resolved", () => "rejected")).toBe("rejected");
  });
});
