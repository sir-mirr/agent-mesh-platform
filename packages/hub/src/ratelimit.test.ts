/**
 * SPEC § 14. A limiter is easy to write and easy to write wrongly, and both
 * failures are quiet: too tight and it fires during ordinary onboarding until
 * somebody disables it; too loose and it is decoration.
 */

import { describe, expect, test } from "bun:test";

import { RateLimiter } from "./ratelimit";

/** A clock the test moves, so nothing here waits. */
function at(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (seconds: number) => { t += seconds * 1000; } };
}

describe("spending", () => {
  test("a burst up to capacity is allowed, and the next one is not", () => {
    const c = at();
    const l = new RateLimiter("t", { capacity: 3, refillPerSecond: 1 }, c.now);
    expect([l.take("k").ok, l.take("k").ok, l.take("k").ok]).toEqual([true, true, true]);
    const denied = l.take("k");
    expect(denied.ok).toBe(false);
    expect(denied.remaining).toBe(0);
  });

  test("retryAfter is never 0 on a refusal", () => {
    // Telling a caller to retry immediately invites the tight loop this
    // exists to stop.
    const c = at();
    const l = new RateLimiter("t", { capacity: 1, refillPerSecond: 0.1 }, c.now);
    l.take("k");
    expect(l.take("k").retryAfter).toBeGreaterThanOrEqual(1);
  });

  test("keys do not share a budget", () => {
    // One lane misbehaving must not exhaust everything behind the same NAT.
    const c = at();
    const l = new RateLimiter("t", { capacity: 1, refillPerSecond: 1 }, c.now);
    expect(l.take("a").ok).toBe(true);
    expect(l.take("a").ok).toBe(false);
    expect(l.take("b").ok).toBe(true);
  });
});

describe("refilling", () => {
  test("time passing restores tokens", () => {
    const c = at();
    const l = new RateLimiter("t", { capacity: 2, refillPerSecond: 1 }, c.now);
    l.take("k"); l.take("k");
    expect(l.take("k").ok).toBe(false);
    c.advance(1);
    expect(l.take("k").ok).toBe(true);
  });

  test("refill is computed from elapsed time, not driven by a timer", () => {
    // A timer that stops leaves every bucket permanently empty. Arithmetic
    // fails the other way: it keeps working.
    const c = at();
    const l = new RateLimiter("t", { capacity: 5, refillPerSecond: 1 }, c.now);
    for (let i = 0; i < 5; i++) l.take("k");
    expect(l.take("k").ok).toBe(false);
    c.advance(3600);
    expect(l.take("k").ok).toBe(true);
  });

  test("it does not refill past capacity", () => {
    // Otherwise a long-idle key banks an unbounded burst, and the limit stops
    // limiting exactly for the caller who waited.
    const c = at();
    const l = new RateLimiter("t", { capacity: 2, refillPerSecond: 1 }, c.now);
    c.advance(10_000);
    expect([l.take("k").ok, l.take("k").ok, l.take("k").ok]).toEqual([true, true, false]);
  });
});

describe("sweeping", () => {
  test("a fully refilled bucket is dropped, because it is the same as absent", () => {
    // Without this, a route keyed on source address grows one entry per
    // address that ever called — a leak whose rate the caller chooses.
    const c = at();
    const l = new RateLimiter("t", { capacity: 2, refillPerSecond: 1 }, c.now);
    l.take("k");
    expect(l.size).toBe(1);
    c.advance(1);
    expect(l.sweep()).toBe(0);
    c.advance(60);
    expect(l.sweep()).toBe(1);
    expect(l.size).toBe(0);
  });

  test("a key swept and used again starts full, which is what absent means", () => {
    const c = at();
    const l = new RateLimiter("t", { capacity: 2, refillPerSecond: 1 }, c.now);
    l.take("k"); l.take("k");
    c.advance(60); l.sweep();
    expect([l.take("k").ok, l.take("k").ok]).toEqual([true, true]);
  });
});
