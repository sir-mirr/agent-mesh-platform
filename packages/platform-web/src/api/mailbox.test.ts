/**
 * The queue depth, and the `0` that looked calm.
 *
 * This module summed the rows itself over a column named `depth` that the route
 * has never emitted, so the sum was of `undefined` and the dashboard drew `0`
 * messages queued whether the mesh was idle or backed up. The fix is two
 * decisions, and both are pinned here: the total is the route's own `count(*)`,
 * and it is `null` — not `0` — when the route did not send one.
 *
 * `null` and `0` are the whole point. `telemetry.ts` passes this straight to
 * the tile as `mailbox?.total_queued ?? null`, so anything that turns an absent
 * total into a number here reaches an operator as a statement about their mesh.
 */
import { describe, it, expect, mock, afterEach } from "bun:test";
import { fetchAdminMailbox } from "./mailbox.ts";
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

describe("fetchAdminMailbox", () => {
  it("reads the route's own count rather than summing the rows", async () => {
    // The two agree today because nothing limits the grouping. A `LIMIT` added
    // to that SQL later would make a sum taken here quietly small while this
    // stays right, and "quietly small" is a queue depth nobody re-checks.
    spyOn({
      ok: true,
      mailboxes: [{ identity: "a-1", pending: 1, leased: 0, oldest: "t" }],
      total_queued: 11,
    });
    expect((await fetchAdminMailbox()).total_queued).toBe(11);
  });

  it("leaves the total null when the route sent no total, and does not derive one", async () => {
    // The original defect, from the other side: rows are present and add up to
    // seven, and the answer is still `null`. Neither `0` (a mesh reported idle
    // while it holds a backlog) nor `7` (a number this layer invented from a
    // grouping it does not control).
    spyOn({ ok: true, mailboxes: [{ identity: "a-1", pending: 3 }, { identity: "a-2", pending: 4 }] });
    expect((await fetchAdminMailbox()).total_queued).toBe(null);
  });

  it("keeps a zero the route actually sent", async () => {
    // The mirror of the test above, and the one a `|| null` would fail: an
    // empty mesh is a measured `0`, and reporting it as "not answered" would
    // hide a working route behind the same blank as a broken one.
    spyOn({ ok: true, mailboxes: [], total_queued: 0 });
    const res = await fetchAdminMailbox();
    expect(res.total_queued).toBe(0);
    expect(res.mailboxes).toEqual([]);
  });

  it("does not read `depth`, or any other name no route emits", async () => {
    // `depth`, `unacked_count`, `oldest_message_ts` and `leased_count` were all
    // declared here once and none of them has ever been sent. A body carrying
    // one must not revive that reading by the back door.
    spyOn({ ok: true, mailboxes: [{ identity: "a-1", depth: 9 }], depth: 9, total: 9 });
    expect((await fetchAdminMailbox()).total_queued).toBe(null);
  });

  it("refuses a total that did not arrive as a number", async () => {
    // A count that came back as text is a count this screen cannot add to or
    // compare. Coercing it would put whatever the string happened to be under a
    // label that promises a measurement.
    spyOn({ ok: true, mailboxes: [], total_queued: "11" });
    expect((await fetchAdminMailbox()).total_queued).toBe(null);
  });

  it("hands the rows on under the route's own column names", async () => {
    // `count(*) AS pending`, `sum(...) AS leased`, `min(ts) AS oldest`. The rows
    // are passed through untouched, so a mapping reintroduced here — under any
    // name — fails this rather than reaching `LeaseQueuePage`, which reads
    // exactly these three.
    spyOn({
      ok: true,
      mailboxes: [{ identity: "a-1", pending: 11, leased: 2, oldest: "2026-08-20T11:00:00Z" }],
      total_queued: 11,
    });
    expect((await fetchAdminMailbox()).mailboxes[0]).toEqual({
      identity: "a-1", pending: 11, leased: 2, oldest: "2026-08-20T11:00:00Z",
    });
  });

  it("keeps an unlisted mailbox list empty rather than throwing at the caller", async () => {
    // Three shapes of "no list": the key is missing, the key is null, and the
    // whole body is null. The dashboard calls this on a timer and catches by
    // setting the panel to null, so a throw here would blank a panel that has
    // a perfectly good total beside it.
    spyOn({ ok: true, total_queued: 4 });
    expect((await fetchAdminMailbox()).mailboxes).toEqual([]);
    spyOn({ ok: true, mailboxes: null, total_queued: 4 });
    expect((await fetchAdminMailbox()).mailboxes).toEqual([]);
    spyOn(null);
    expect(await fetchAdminMailbox()).toEqual({ mailboxes: [], total_queued: null });
  });

  it("asks the admin mailbox route with a plain GET", async () => {
    const spy = spyOn({ ok: true, mailboxes: [], total_queued: 0 });
    await fetchAdminMailbox();
    expect(String(spy.mock.calls[0]![0])).toContain("/api/v1/admin/mailbox");
    // No trailing identity segment: `mailbox/:identity` is the per-agent route
    // and answers `{ messages }`, a body this reader would take as no mailboxes
    // at all.
    expect(String(spy.mock.calls[0]![0])).toMatch(/\/api\/v1\/admin\/mailbox$/);
    expect(spy.mock.calls[0]![1]!.method).toBeUndefined();
  });

  it("throws on a refusal instead of reporting an empty queue", async () => {
    // `mailbox.read.depth` is a capability an operator can be missing. Reading
    // that as `{ mailboxes: [], total_queued: null }` would tell them the mesh
    // is quiet, when what happened is that the server would not say.
    spyOn({ error: "not allowed", capability: "mailbox.read.depth" }, 403);
    const err = await fetchAdminMailbox().then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(failureKind(err)).toBe("refused");
    expect((err as ApiError).capability).toBe("mailbox.read.depth");
  });

  it("throws when there was no server at all, and does not call that an empty mesh", async () => {
    stub(mock(async () => { throw new TypeError("Failed to fetch"); }));
    const err = await fetchAdminMailbox().then(() => null, (e: unknown) => e);
    expect(failureKind(err)).toBe("unreachable");
    expect((err as ApiError).status).toBe(null);
  });
});
