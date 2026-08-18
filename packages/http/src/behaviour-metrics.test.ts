/**
 * A zero that was read, and a zero that was not.
 *
 * Four of the six metrics on `/platform/telemetry` read `0` when everything is
 * well — no signature refusals, no egress refusals, nothing rate-limited,
 * nothing queued. That is what makes this screen the worst place in the product
 * to substitute a zero for an unknown: it is the answer the reader is hoping
 * for, so it is the one nobody checks.
 *
 * agent-mesh-local-pm asked for this rule before a line was written, having
 * found four screens the same evening that drew what they could not know —
 * `ONLINE` for an absent status, `0` for an unreported queue depth, `verified`
 * for a fingerprint the route never carried, and `1` for a group with no
 * members.
 */

import { describe, expect, test } from "bun:test";
import { shapeMetrics, type Sources } from "./behaviour-metrics.ts";

const READ: Sources = {
  limits: { counting_since: "2026-08-19T00:00:00.000Z", limiters: [{ refusals: 2 }], refusals: [
    { kind: "signature", count: 3 },
    { kind: "egress", count: 0 },
  ] },
  pendingKeys: 0,
  oldestPendingMs: 0,
  accepted: 41,
};

describe("shapeMetrics", () => {
  test("a zero that was read is a value", () => {
    const m = shapeMetrics(READ);
    expect(m.egress_refusals).toEqual({ value: 0 });
    expect(m.pending_keys).toEqual({ value: 0 });
    expect(m.oldest_pending_ms).toEqual({ value: 0 });
    expect(m.signature_refusals).toEqual({ value: 3 });
    expect(m.rate_limited).toEqual({ value: 2 });
    expect(m.accepted).toEqual({ value: 41 });
  });

  test("a hub that did not answer produces no numbers at all", () => {
    const m = shapeMetrics({ ...READ, limits: null });
    // Not zero. The three the hub holds are unknown, and each says so.
    for (const metric of [m.signature_refusals, m.egress_refusals, m.rate_limited]) {
      expect(metric.value).toBeNull();
      expect(metric.unavailable).toBe("hub did not answer /api/v1/limits");
    }
    // The two this process reads itself are unaffected — partial is the point.
    expect(m.accepted).toEqual({ value: 41 });
  });

  test("counts without a window are not offered as counts", () => {
    // The hub answered but did not say when it started counting. Its counters
    // reset on restart, so `0` would mean either "nothing was refused" or "this
    // hub is ninety seconds old", and the two are not the same report.
    const m = shapeMetrics({ ...READ, limits: { refusals: [{ kind: "signature", count: 0 }] } });
    expect(m.counting_since).toBeNull();
    expect(m.signature_refusals).toEqual({
      value: null,
      unavailable: "hub answered without counting_since",
    });
  });

  test("an unreadable store does not become an empty one", () => {
    const m = shapeMetrics({ ...READ, pendingKeys: null, oldestPendingMs: null, accepted: null });
    expect(m.pending_keys.value).toBeNull();
    expect(m.oldest_pending_ms.value).toBeNull();
    expect(m.accepted.value).toBeNull();
    expect(m.pending_keys.unavailable).toBe("key proposals could not be read");
  });

  test("no metric is ever both", () => {
    // A value and a reason together would let a reader take either, and the two
    // disagree by construction.
    for (const s of [READ, { ...READ, limits: null }, { ...READ, accepted: null }]) {
      for (const m of Object.values(shapeMetrics(s as Sources))) {
        if (typeof m !== "object" || m === null) continue;
        expect({ both: m.value !== null && m.unavailable !== undefined }).toEqual({ both: false });
      }
    }
  });
});
