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

  test("nor when the bucket is a fraction of a token short", () => {
    // **The case the test above cannot reach.** With `capacity: 1,
    // refillPerSecond: 0.1` the deficit is a whole token and the answer is 10,
    // so every rounding — ceil, floor, round — and the `Math.max(1, …)` floor
    // itself all agree. Deleting that floor leaves the suite green, and it was
    // on a list of guards nothing checks for exactly that reason.
    //
    // A partial refill is where they stop agreeing. Buckets fill continuously,
    // so `tokens` is a fraction most of the time: 0.3 of a token short at one
    // per second is `ceil → 1` and `floor → 0`, and a caller told to retry in
    // zero seconds does it immediately, forever.
    //
    // This still does not catch removing `Math.max(1, …)` alone, and cannot:
    // under `ceil` a positive deficit can never round to zero, so that
    // mutation is equivalent rather than uncaught. What it catches is the
    // change that makes the floor load-bearing.
    const c = at();
    const l = new RateLimiter("t", { capacity: 1, refillPerSecond: 1 }, c.now);
    expect(l.take("k").ok).toBe(true);
    c.advance(0.7); // 0.7 of a token back, so the next spend is 0.3 short.
    const denied = l.take("k");
    expect(denied.ok, "the bucket refilled enough to allow this — the case is gone").toBe(false);
    expect(denied.retryAfter, "a caller told to retry in 0s retries immediately").toBeGreaterThanOrEqual(1);
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

describe("what an operator can see", () => {
  test("a refusal is counted, and an allowed spend is not", () => {
    // **Nothing counted these.** § 14 says a limit exists; it did not say
    // whether one had ever fired, and a limit protecting a mesh looks exactly
    // like a limit set so wide it is decoration — no errors either way.
    const c = at();
    const l = new RateLimiter("t", { capacity: 2, refillPerSecond: 1 }, c.now);
    expect(l.stats().refusals).toBe(0);

    expect(l.take("k").ok).toBe(true);
    expect(l.take("k").ok).toBe(true);
    expect(l.stats().refusals, "an allowed spend was counted as a refusal").toBe(0);

    expect(l.take("k").ok).toBe(false);
    expect(l.take("k").ok).toBe(false);
    expect(l.stats().refusals).toBe(2);
  });

  test("the count does not reset when the buckets are swept", () => {
    // A counter that resets has a zero meaning either 'nothing happened' or
    // 'it just reset', and telling those apart needs a fact nobody has.
    const c = at();
    const l = new RateLimiter("t", { capacity: 1, refillPerSecond: 1 }, c.now);
    l.take("k");
    expect(l.take("k").ok).toBe(false);

    c.advance(3600);
    expect(l.sweep(), "the bucket was not swept, so this proves nothing").toBeGreaterThan(0);
    expect(l.stats().refusals, "sweeping forgot a refusal that did happen").toBe(1);
    expect(l.stats().keys).toBe(0);
  });
});
