/**
 * Token buckets (SPEC § 14).
 *
 * The gap this closes is narrow and specific: **`POST /api/v1/agents` is
 * unauthenticated** (§ 9.2 †), so anything that can reach the port can call it
 * as fast as it likes. Nothing bounded that except the supersession rule,
 * which limits what a flood *achieves* rather than what it costs.
 *
 * ## In memory, and that is a real limit
 *
 * The hub does not scale horizontally — `onlineAgents` is one map in one
 * process, and `docs/architecture.md` records why. So a per-process bucket is
 * the whole deployment's bucket, which is correct here and would not be behind
 * two hubs. Recorded rather than assumed, because the day a second hub appears
 * this silently becomes a limit of `2n`.
 *
 * ## Keyed on what the caller cannot choose
 *
 * An unauthenticated route has no identity, so the key is the observed source
 * (§ 8.11) — which behind a proxy is `X-Forwarded-For` from a trusted hop, and
 * with no proxy configured is the socket. A key the caller picks is not a
 * limit; it is a suggestion.
 *
 * Where an identity *is* known, that is the better key: one lane misbehaving
 * should not exhaust the budget of everything else sharing its NAT.
 */

export interface BucketConfig {
  /** Tokens the bucket holds, and therefore the largest burst allowed. */
  capacity: number;
  /** Tokens added per second. Sustained rate. */
  refillPerSecond: number;
}

export interface Decision {
  ok: boolean;
  /** Whole seconds until one token is available. `0` when allowed. */
  retryAfter: number;
  remaining: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/**
 * A named family of buckets — one per key, all sharing a config.
 *
 * `sweep` matters more than it looks. Without it an unauthenticated route
 * keyed on source address accumulates a map entry per address that ever
 * called, which is a slow leak an attacker chooses the rate of.
 */
export class RateLimiter {
  #buckets = new Map<string, Bucket>();
  /**
   * Refusals since this process started.
   *
   * **Nothing counted them.** § 14 says a limit exists; it did not say whether
   * one had ever fired, and an operator watching a mesh cannot tell a limit
   * that is protecting it from one set so wide it is decoration. Both look
   * identical from outside — no errors either way.
   *
   * Since start, not a window: a counter that resets is one whose zero means
   * either 'nothing happened' or 'it just reset', and telling those apart needs
   * a second fact nobody has. A reader takes two readings and subtracts.
   */
  #refusals = 0;

  constructor(
    readonly name: string,
    private readonly config: BucketConfig,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Spend a token if there is one.
   *
   * Refill is computed from elapsed time rather than by a timer: a timer that
   * stops leaves every bucket permanently empty, and the failure mode of an
   * arithmetic refill is that it keeps working.
   */
  take(key: string, cost = 1): Decision {
    const t = this.now();
    const b = this.#buckets.get(key) ?? { tokens: this.config.capacity, updatedAt: t };
    const elapsed = Math.max(0, (t - b.updatedAt) / 1000);
    b.tokens = Math.min(this.config.capacity, b.tokens + elapsed * this.config.refillPerSecond);
    b.updatedAt = t;

    if (b.tokens >= cost) {
      b.tokens -= cost;
      this.#buckets.set(key, b);
      return { ok: true, retryAfter: 0, remaining: Math.floor(b.tokens) };
    }
    this.#buckets.set(key, b);
    this.#refusals++;
    const deficit = cost - b.tokens;
    return {
      ok: false,
      // Rounded **up**: telling a caller to retry in 0 seconds when the token
      // is not yet there invites a tight loop, which is the thing being
      // limited.
      retryAfter: Math.max(1, Math.ceil(deficit / this.config.refillPerSecond)),
      remaining: 0,
    };
  }

  /**
   * What an operator decides on: has this limit fired, and how hard is it set.
   *
   * `keys` is live buckets, which is the shape of the traffic — one key
   * refusing repeatedly and a thousand keys refusing once are different
   * situations behind the same refusal count.
   */
  stats(): { name: string; refusals: number; keys: number; capacity: number; refillPerSecond: number } {
    return {
      name: this.name,
      refusals: this.#refusals,
      keys: this.#buckets.size,
      capacity: this.config.capacity,
      refillPerSecond: this.config.refillPerSecond,
    };
  }

  /** Drop buckets that have refilled completely — they are indistinguishable from absent. */
  sweep(): number {
    const t = this.now();
    const full = (this.config.capacity / this.config.refillPerSecond) * 1000;
    let dropped = 0;
    for (const [key, b] of this.#buckets) {
      if (t - b.updatedAt > full) {
        this.#buckets.delete(key);
        dropped++;
      }
    }
    return dropped;
  }

  get size(): number {
    return this.#buckets.size;
  }
}

const int = (v: string | undefined, fallback: number) => {
  const n = parseInt(v ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * The unauthenticated provisioning route, which is the one that needs this.
 *
 * **Generous, and the first numbers were not.** `20` burst with one refill per
 * second looked defensible and broke fifty-eight tests — a suite bringing up
 * lanes as fast as it can is exactly the shape of a host onboarding a fleet,
 * and a limit that fires there is a limit somebody switches off. The comment
 * predicting that was already in this file when the numbers were chosen, which
 * is its own lesson: a stated principle does not check itself.
 *
 * What it stops is a sustained loop, not a burst. An attacker held to 600
 * provisioning attempts a minute is not achieving anything the supersession
 * rule does not already bound; one held to 20 was never the realistic threat.
 */
export const PROVISION_LIMIT = new RateLimiter("provision", {
  capacity: int(process.env.AGENT_MESH_PROVISION_BURST, 300),
  refillPerSecond: int(process.env.AGENT_MESH_PROVISION_PER_MINUTE, 600) / 60,
});

/**
 * Signed routes, keyed on identity.
 *
 * Higher, because a caller here has already produced a signature the hub
 * verified — the work is bounded by their key rather than by their bandwidth,
 * and the limit exists to stop one lane starving the others rather than to
 * stop an outsider.
 */
export const SIGNED_LIMIT = new RateLimiter("signed", {
  capacity: int(process.env.AGENT_MESH_SIGNED_BURST, 600),
  refillPerSecond: int(process.env.AGENT_MESH_SIGNED_PER_MINUTE, 3000) / 60,
});

/** Every limiter, so one interval can sweep them all. */
export const ALL_LIMITERS = [PROVISION_LIMIT, SIGNED_LIMIT];
