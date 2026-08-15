/**
 * § 8.5, § 8.6, § 8.7 — the reminder methods.
 *
 * The whole family had no integration coverage. They are the oldest surface in
 * the hub and the one nothing in 0.2 touched, which is exactly why they were
 * never looked at: the parts under active change get tested, the parts that
 * merely have to keep working do not.
 *
 * The requirement worth asserting is ownership. § 8.6 and § 8.7 are
 * owner-scoped, so a bug there is not a crash — it is one identity reading or
 * cancelling another's reminders, which nothing else in the system would notice.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { connectRpc, newPublicKey, provision, startMesh, type Mesh, type RpcClient } from "./harness";

let mesh: Mesh;
let alice: RpcClient;
let bob: RpcClient;

const soon = () => new Date(Date.now() + 3_600_000).toISOString();
/** A § 3.3 `once` spec. A bare timestamp is not one, and § 8.5 now refuses it. */
const onceSpec = (at = soon()) => JSON.stringify({ at });
let seq = 0;
const reminderId = () => `rem_${(seq++).toString(16).padStart(16, "0")}`;

beforeAll(async () => {
  mesh = await startMesh({ withHttp: false });
  await provision(mesh.hub, "rem-alice", "service");
  await provision(mesh.hub, "rem-bob", "service");
  alice = await connectRpc(mesh.hub);
  bob = await connectRpc(mesh.hub);
  await alice.call("mesh.connect", { identity: "rem-alice" });
  await bob.call("mesh.connect", { identity: "rem-bob" });
});

afterAll(() => {
  alice?.close();
  bob?.close();
  mesh?.stop();
});

const schedule = (rpc: RpcClient, over: Record<string, unknown> = {}) =>
  rpc.call("mesh.schedule_reminder", {
    id: reminderId(),
    type: "once",
    schedule_spec: onceSpec(),
    payload: "remember this",
    next_fire_at: soon(),
    ...over,
  });

describe("scheduling", () => {
  test("echoes what § 8.5 says it echoes", async () => {
    const id = reminderId();
    const at = soon();
    const res = await alice.call("mesh.schedule_reminder", {
      id, type: "once", schedule_spec: onceSpec(at), payload: "p", next_fire_at: at,
    });
    expect(res.error).toBeUndefined();
    expect(res.result).toMatchObject({ ok: true, id, type: "once", next_fire_at: at });
  });

  test("a missing required field is refused", async () => {
    for (const field of ["id", "type", "schedule_spec", "payload", "next_fire_at"]) {
      const params: Record<string, unknown> = {
        id: reminderId(), type: "once", schedule_spec: onceSpec(),
        payload: "p", next_fire_at: soon(),
      };
      delete params[field];
      const res = await alice.call("mesh.schedule_reminder", params);
      expect(res.error, `missing ${field}`).toMatchObject({ code: -32602 });
    }
  });

  test("a schedule the daemon could not read is refused rather than stored", async () => {
    // Storing it produces a row that looks scheduled and never fires, and the
    // caller learns of it by the reminder not arriving — which it cannot tell
    // apart from having arrived and been missed.
    const cases: Array<[string, unknown]> = [
      ["unknown type", { type: "weekly", schedule_spec: JSON.stringify({ every: "7d" }) }],
      ["interval with no every", { type: "interval", schedule_spec: "{}" }],
      ["interval with a unit that is not fixed-length", { type: "interval", schedule_spec: JSON.stringify({ every: "1mo" }) }],
      ["zero interval, which would fire in a loop", { type: "interval", schedule_spec: JSON.stringify({ every: "0s" }) }],
      ["cron with no expression", { type: "cron", schedule_spec: JSON.stringify({ tz: "UTC" }) }],
      ["once with neither in nor at", { type: "once", schedule_spec: "{}" }],
      ["a bare timestamp, which is not a spec", { type: "once", schedule_spec: soon() }],
      ["a spec that is not JSON", { type: "once", schedule_spec: "tomorrow" }],
    ];
    for (const [name, over] of cases) {
      const res = await schedule(alice, over as Record<string, unknown>);
      expect(res.error, name).toMatchObject({ code: -32602 });
      expect(res.error.message, name).toContain("schedule_spec");
    }
  });

  test("a refusal names the field without echoing the caller's value back", async () => {
    const res = await schedule(alice, {
      type: "interval",
      schedule_spec: JSON.stringify({ every: "<script>alert(1)</script>" }),
    });
    expect(res.error).toMatchObject({ code: -32602 });
    expect(res.error.message).not.toContain("script");
  });

  test("every § 3.3 form is accepted", async () => {
    const forms: Array<[string, string]> = [
      ["once", JSON.stringify({ in: "30s" })],
      ["once", JSON.stringify({ at: soon() })],
      ["interval", JSON.stringify({ every: "15m" })],
      ["cron", JSON.stringify({ cron: "0 9 * * *", tz: "Asia/Seoul" })],
      ["cron", JSON.stringify({ cron: "0 9 * * *" })],
    ];
    for (const [type, spec] of forms) {
      const res = await schedule(alice, { type, schedule_spec: spec });
      expect(res.error, `${type} ${spec}`).toBeUndefined();
      expect(res.result.ok, `${type} ${spec}`).toBe(true);
    }
  });

  test("a refused schedule stores nothing", async () => {
    const id = reminderId();
    const before = (await alice.call("mesh.list_reminders", { status: "all", limit: 200 })).result.rows.length;
    const res = await alice.call("mesh.schedule_reminder", {
      id, type: "interval", schedule_spec: "{}", payload: "p", next_fire_at: soon(),
    });
    expect(res.error).toMatchObject({ code: -32602 });
    const after = (await alice.call("mesh.list_reminders", { status: "all", limit: 200 })).result.rows;
    expect(after.length).toBe(before);
    expect(after.some((r: any) => r.id === id)).toBe(false);
  });

  test("a repeated idempotency_key is reported, not duplicated", async () => {
    // § 8.5: callers SHOULD treat this as success — the prior schedule is still
    // pending, so the intent is satisfied.
    const key = `idem-${Math.random().toString(36).slice(2)}`;
    const first = await schedule(alice, { idempotency_key: key });
    expect(first.result.ok).toBe(true);

    const second = await schedule(alice, { idempotency_key: key });
    expect(second.result).toMatchObject({ ok: false, error: "dedup", idempotency_key: key });

    const rows = (await alice.call("mesh.list_reminders", {})).result.rows;
    expect(rows.filter((r: any) => r.idempotency_key === key)).toHaveLength(1);
  });

  test("an unconnected socket cannot schedule", async () => {
    const stranger = await connectRpc(mesh.hub);
    const res = await schedule(stranger);
    stranger.close();
    expect(res.error).toMatchObject({ code: -32600 });
  });
});

describe("ownership", () => {
  test("a reminder belongs to the identity that scheduled it", async () => {
    const id = reminderId();
    await schedule(alice, { id, payload: "alice's" });

    const hers = (await alice.call("mesh.list_reminders", {})).result.rows;
    expect(hers.map((r: any) => r.id)).toContain(id);

    // § 8.5: other identities cannot read it.
    const his = (await bob.call("mesh.list_reminders", {})).result.rows;
    expect(his.map((r: any) => r.id)).not.toContain(id);
  });

  test("one identity cannot cancel another's", async () => {
    // The failure this guards is silent: not a crash, but one participant
    // quietly cancelling another's schedule.
    const id = reminderId();
    await schedule(alice, { id });

    const attempt = await bob.call("mesh.cancel_reminder", { id });
    expect(attempt.result.changes).toBe(0);

    // Still hers, still active.
    const hers = (await alice.call("mesh.list_reminders", {})).result.rows;
    expect(hers.find((r: any) => r.id === id)?.status).toBe("active");
  });
});

describe("cancelling", () => {
  test("transitions an active reminder and reports one change", async () => {
    const id = reminderId();
    await schedule(alice, { id });
    expect((await alice.call("mesh.cancel_reminder", { id })).result.changes).toBe(1);

    const rows = (await alice.call("mesh.list_reminders", { status: "cancelled" })).result.rows;
    expect(rows.map((r: any) => r.id)).toContain(id);
  });

  test("cancelling twice reports no second change", async () => {
    // A terminal row is left alone — the caller learns nothing happened rather
    // than being told it succeeded again.
    const id = reminderId();
    await schedule(alice, { id });
    await alice.call("mesh.cancel_reminder", { id });
    expect((await alice.call("mesh.cancel_reminder", { id })).result.changes).toBe(0);
  });

  test("cancelling something that never existed is 0, not an error", async () => {
    expect((await alice.call("mesh.cancel_reminder", { id: "rem_nonexistent" })).result.changes)
      .toBe(0);
  });

  test("a missing id is refused", async () => {
    expect((await alice.call("mesh.cancel_reminder", {})).error).toMatchObject({ code: -32602 });
  });
});

describe("listing", () => {
  test("defaults to active", async () => {
    const active = reminderId();
    const cancelled = reminderId();
    await schedule(alice, { id: active });
    await schedule(alice, { id: cancelled });
    await alice.call("mesh.cancel_reminder", { id: cancelled });

    const rows = (await alice.call("mesh.list_reminders", {})).result.rows;
    expect(rows.map((r: any) => r.id)).toContain(active);
    expect(rows.map((r: any) => r.id)).not.toContain(cancelled);
    expect(rows.every((r: any) => r.status === "active")).toBe(true);
  });

  test("status: all spans terminal states too", async () => {
    const id = reminderId();
    await schedule(alice, { id });
    await alice.call("mesh.cancel_reminder", { id });
    const rows = (await alice.call("mesh.list_reminders", { status: "all" })).result.rows;
    expect(rows.map((r: any) => r.id)).toContain(id);
  });

  test("limit is honoured and bounded", async () => {
    for (let i = 0; i < 4; i++) await schedule(alice);
    expect((await alice.call("mesh.list_reminders", { limit: 2 })).result.rows).toHaveLength(2);
    const wide = await alice.call("mesh.list_reminders", { limit: 100_000 });
    expect(wide.error).toBeUndefined();
    expect(wide.result.rows.length).toBeLessThanOrEqual(200);
  });

  test("an unconnected socket cannot list", async () => {
    const stranger = await connectRpc(mesh.hub);
    const res = await stranger.call("mesh.list_reminders", {});
    stranger.close();
    expect(res.error).toMatchObject({ code: -32600 });
  });
});

/**
 * § 3.3 — how a fired reminder actually reaches its owner.
 *
 * The scheduler's own tests inject a stub sender, so they proved the retry
 * machinery and nothing about the hub refusing the send. Every reminder owned
 * by a key-holding runtime was rejected with -32013 and retried until the
 * overdue hold parked it — a whole feature broken end to end, with green tests
 * on both sides of the seam.
 */
describe("a fired reminder reaches its owner", () => {
  test("delivered when the daemon sends as itself", async () => {
    await provision(mesh.hub, "self-reminder", "service");
    // A key-holding runtime: the case that failed, because § 8.2 refuses
    // proxying an identity that signs for itself.
    await provision(mesh.hub, "rem-owner", "ai-codex", null, newPublicKey());

    const daemon = await connectRpc(mesh.hub);
    await daemon.call("mesh.connect", { identity: "self-reminder" });

    // Exactly what the daemon sends now: no `from`, so the socket identity
    // stands and the hub does not read it as a proxied send.
    const res = await daemon.call("mesh.send", {
      to: "rem-owner", content: "your reminder fired",
    });
    daemon.close();

    expect(res.error).toBeUndefined();
    expect(res.result.id).toBeTruthy();
  });

  test("claiming the owner's identity is refused, which is why it is not done", async () => {
    // The old behaviour, asserted so it cannot come back as a "fix" for the
    // message reading as being from the scheduler.
    await provision(mesh.hub, "rem-owner-2", "ai-codex", null, newPublicKey());
    const daemon = await connectRpc(mesh.hub);
    await daemon.call("mesh.connect", { identity: "self-reminder" });

    const res = await daemon.call("mesh.send", {
      to: "rem-owner-2", from: "rem-owner-2", content: "pretending to be you",
    });
    daemon.close();
    expect(res.error).toMatchObject({ code: -32013 });
  });

  test("the owner sees the scheduler as the sender, and sent_by agrees", async () => {
    await provision(mesh.hub, "rem-watcher", "service");
    const daemon = await connectRpc(mesh.hub);
    await daemon.call("mesh.connect", { identity: "self-reminder" });

    const watcher = await connectRpc(mesh.hub);
    await watcher.call("mesh.connect", { identity: "rem-watcher" });
    await daemon.call("mesh.send", { to: "rem-watcher", content: "fired" });
    await Bun.sleep(150);
    daemon.close();

    const pushed = watcher.notifications().find((n) => n.method === "mesh.message");
    watcher.close();
    // Nothing proxied, so the two agree — which is the shape a consumer should
    // see for anything that is not forwarded on someone's behalf.
    expect(pushed.params).toMatchObject({ from: "self-reminder", sent_by: "self-reminder" });
  });
});
