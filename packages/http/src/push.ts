/**
 * When a failed push means the subscription is gone, and when it means nothing.
 *
 * **Every rejection used to delete the subscription.** `sendNotification(...)
 * .catch(() => deletePushSubscription(sub.endpoint))` treats a push service
 * having a bad minute exactly like a browser that has unsubscribed: the row is
 * removed, the device stops receiving notifications, and nothing is logged —
 * so the person's phone goes quiet and neither they nor an operator has any way
 * to find out why. The repair is for them to notice and subscribe again.
 *
 * The web push protocol is explicit about which is which. **404 Not Found** and
 * **410 Gone** are the push service saying this endpoint no longer exists, and
 * deleting is the correct response — keeping it means retrying a dead endpoint
 * for ever. Everything else — a 429, a 500, a timeout, a DNS failure — is the
 * service, not the subscription, and the row must survive it.
 *
 * Split out from the send loop so the rule can be tested. Testing it in place
 * would mean standing up a push service that fails on demand; the decision is
 * one function of one error, and that is the part that was wrong.
 */

/** The two statuses that mean this endpoint is not coming back. */
const GONE = new Set([404, 410]);

export interface PushFailure {
  /** Whether the subscription row should be deleted. */
  drop: boolean;
  /** What to say about it, for the log. Never empty. */
  reason: string;
}

/**
 * Read a rejected `webpush.sendNotification`.
 *
 * Defensive about the shape because the rejection is not always a
 * `WebPushError`: a DNS failure or an abort arrives as a plain `Error` with no
 * status at all, and reading `statusCode` off it gives `undefined`. That case
 * must keep the subscription — an error whose status is unknown is not a
 * subscription known to be gone, and the old code's behaviour on it was to
 * delete.
 */
export function readPushFailure(error: unknown): PushFailure {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  const message = error instanceof Error ? error.message : String(error);

  if (typeof status === "number" && GONE.has(status)) {
    return { drop: true, reason: `endpoint is gone (${status})` };
  }
  if (typeof status === "number") {
    return { drop: false, reason: `push service returned ${status}: ${message}` };
  }
  return { drop: false, reason: `push failed without a status: ${message}` };
}
