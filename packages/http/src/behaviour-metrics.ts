/**
 * The six behavioural metrics `/platform/telemetry` draws (`SC-SCR10-01`).
 *
 * § D-1 settled that this screen shows what the mesh *did* rather than what the
 * host's CPU and memory are doing — a hub at 4% CPU that is refusing every
 * signature is not healthy, and the process gauges cannot say so. The six are
 * named in `packages/platform-web/COVERAGE_INVENTORY.md`; they are not chosen
 * here, because a decision that lives in two places has already started to
 * disagree.
 *
 * **Nothing new is counted.** Five of the six were already recorded and four of
 * them already served — `recordRefusal` has counted signature and egress
 * refusals since it was written, the limiters carry their own stats, and
 * `/api/v1/admin/keys/pending` has always answered. What was missing was a
 * route that put them where a screen could reach them.
 *
 * ## Why every value is nullable
 *
 * **`0` is the hoped-for answer for four of these six.** No signature
 * refusals, no egress refusals, nothing rate-limited, nothing queued: an
 * operator reading those wants zeros, so a zero drawn because a source could
 * not be reached is the one wrong number nobody will question. Every metric
 * therefore carries either a value or the reason there is none, and never a
 * stand-in.
 *
 * `counting_since` is part of the same problem and is easy to miss. The hub's
 * refusal counters live in memory and reset when it restarts, so "zero
 * refusals" and "this hub came up a minute ago" are the same figure. The window
 * travels with the numbers.
 */

export interface Metric {
  /** `null` when it could not be read. Never a substitute. */
  value: number | null;
  /** Why there is no value — absent when there is one. */
  unavailable?: string;
}

export interface BehaviourMetrics {
  /**
   * When the hub began counting the three it holds in memory.
   *
   * `null` if the hub did not answer, which also makes those three `null` —
   * a count without its window is not a metric.
   */
  counting_since: string | null;
  pending_keys: Metric;
  oldest_pending_ms: Metric;
  signature_refusals: Metric;
  rate_limited: Metric;
  egress_refusals: Metric;
  accepted: Metric;
}

const unread = (why: string): Metric => ({ value: null, unavailable: why });

/** What the hub's `/api/v1/limits` answers, as much of it as is read here. */
interface HubLimits {
  counting_since?: string;
  limiters?: Array<{ refusals?: number }>;
  refusals?: Array<{ kind: string; count: number }>;
}

export interface Sources {
  /** `GET {hub}/api/v1/limits`, or null if it could not be reached. */
  limits: HubLimits | null;
  /** Rows in the key-proposal queue, or null if that store could not be read. */
  pendingKeys: number | null;
  /** Age in ms of the oldest message still pending, `null` if unreadable. */
  oldestPendingMs: number | null;
  /** Messages the hub has accepted, `null` if unreadable. */
  accepted: number | null;
}

/**
 * Shape the six from what could be read.
 *
 * Separated from the reading so it can be tested against a source that failed,
 * which is the case that matters and the hardest to produce against a live
 * mesh.
 */
export function shapeMetrics(s: Sources): BehaviourMetrics {
  const NO_HUB = "hub did not answer /api/v1/limits";
  const countingSince = s.limits?.counting_since ?? null;

  const fromRefusals = (kind: string): Metric => {
    if (!s.limits) return unread(NO_HUB);
    // A count with no window cannot be read, so it is not offered as one.
    if (!countingSince) return unread("hub answered without counting_since");
    const rows = s.limits.refusals ?? [];
    return { value: rows.filter((r) => r.kind === kind).reduce((n, r) => n + r.count, 0) };
  };

  return {
    counting_since: countingSince,
    pending_keys:
      s.pendingKeys === null ? unread("key proposals could not be read") : { value: s.pendingKeys },
    oldest_pending_ms:
      s.oldestPendingMs === null ? unread("message store could not be read") : { value: s.oldestPendingMs },
    signature_refusals: fromRefusals("signature"),
    egress_refusals: fromRefusals("egress"),
    rate_limited: !s.limits
      ? unread(NO_HUB)
      : !countingSince
        ? unread("hub answered without counting_since")
        : { value: (s.limits.limiters ?? []).reduce((n, l) => n + (l.refusals ?? 0), 0) },
    accepted: s.accepted === null ? unread("message store could not be read") : { value: s.accepted },
  };
}
