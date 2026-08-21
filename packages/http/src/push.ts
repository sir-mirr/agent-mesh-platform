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

/** One registered device, as the subscription table holds it. */
export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * Everything the send loop reaches outside itself.
 *
 * Injected for the same reason `readPushFailure` was split out: testing the
 * loop in place would mean standing up a push service, a VAPID keypair and a
 * live SSE connection, and none of those is the part that decides anything.
 * The decisions are which failures cost a subscription, whether to send at
 * all, and what the person sees on a locked screen.
 */
export interface PushDeps {
  /** Whether this deployment holds VAPID keys. Without them nothing can be sent. */
  configured: boolean;
  /** Whether the person already has the conversation open. */
  watching: (toUser: string) => boolean;
  /** The devices registered to them. */
  devices: (toUser: string) => PushTarget[];
  /** Hand one notification to the push service. */
  send: (target: PushTarget, payload: string) => Promise<unknown>;
  /** Remove a subscription the service says is gone. */
  drop: (endpoint: string) => void;
}

/** As much of a message as belongs on a lock screen. */
const PREVIEW_CHARS = 100;

/**
 * Notify someone's devices that a message arrived.
 *
 * **Best effort, and never in the sender's way.** A push that cannot be
 * attempted must not fail the send — but best-effort is not the same as
 * unobservable, so every path out of here says which one it took. The bare
 * `catch {}` this replaced meant a deployment could stop notifying anyone and
 * the only symptom was silence.
 *
 * **Nothing is sent to somebody who is already looking.** An open stream is
 * the message arriving; a notification beside it is the same message twice.
 */
export function sendPushForMessage(
  deps: PushDeps,
  toUser: string,
  fromAgent: string,
  content: string,
): void {
  if (!deps.configured) return;
  if (deps.watching(toUser)) return;
  try {
    const subs = deps.devices(toUser);
    if (subs.length === 0) return;
    const payload = JSON.stringify({
      title: fromAgent,
      body: content.length > PREVIEW_CHARS ? content.slice(0, PREVIEW_CHARS) + "..." : content,
      data: { agent: fromAgent, url: "/chat" },
    });
    for (const sub of subs) {
      deps.send(sub, payload).catch((error: unknown) => {
        // **Every rejection used to delete the subscription.** A push service
        // having a bad minute was treated exactly like a browser that had
        // unsubscribed: the row went, the device went quiet, and nothing was
        // logged — so the repair was for the person to notice and subscribe
        // again. Only 404 and 410 mean the endpoint is gone.
        const { drop, reason } = readPushFailure(error);
        if (drop) deps.drop(sub.endpoint);
        console.warn(
          `agent-mesh-http: push to ${toUser} failed — ${reason}` +
            `${drop ? " (subscription removed)" : " (subscription kept)"}`,
        );
      });
    }
    // **Queued, not sent.** This line runs while every send is still in
    // flight, so wording it as a delivery would claim one that has not
    // happened and would print unchanged if all of them failed.
    console.log(
      `agent-mesh-http: push queued to ${subs.length} device(s) for ${toUser} from ${fromAgent}`,
    );
  } catch (error) {
    // Was a bare `catch {}`. An exception here means no device was even asked,
    // and the sender is told nothing either way.
    console.error(
      `agent-mesh-http: push to ${toUser} could not be attempted:`,
      error instanceof Error ? error.message : String(error),
    );
  }
}
