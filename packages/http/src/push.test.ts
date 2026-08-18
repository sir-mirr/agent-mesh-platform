/**
 * A push that failed is not a subscription that is gone.
 *
 * The send loop deleted the subscription row on **any** rejection, so a push
 * service returning 500 for a minute unsubscribed every device it happened to
 * be asked about. Nothing was logged, so the person's phone went quiet and
 * neither they nor an operator had a way to find out why; the repair was for
 * them to notice and subscribe again.
 *
 * The distinction is in the protocol rather than a judgement call — 404 and 410
 * are the push service saying the endpoint no longer exists — which is what
 * makes it testable as a function of one error, and why it is one.
 */

import { describe, expect, test } from "bun:test";

import { readPushFailure } from "./push";

/** What `web-push` rejects with: an Error carrying the response status. */
function webPushError(statusCode: number, message = "push service said no") {
  return Object.assign(new Error(message), { statusCode });
}

describe("failures that mean the endpoint is gone", () => {
  test("410 Gone drops the subscription", () => {
    const { drop, reason } = readPushFailure(webPushError(410));
    expect(drop).toBe(true);
    expect(reason).toContain("410");
  });

  test("404 Not Found drops it too", () => {
    // Some services answer 404 rather than 410 for an expired endpoint.
    // Keeping it means retrying a dead endpoint for ever.
    expect(readPushFailure(webPushError(404)).drop).toBe(true);
  });
});

describe("failures that mean nothing about the subscription", () => {
  test("a 500 keeps it", () => {
    const { drop, reason } = readPushFailure(webPushError(500, "internal error"));
    expect(drop, "a push service outage unsubscribed the device").toBe(false);
    expect(reason).toContain("500");
  });

  test("a 429 keeps it", () => {
    // Rate limiting is the service asking for less traffic, and deleting the
    // row is the one response guaranteed to make the next attempt unnecessary
    // for the wrong reason.
    expect(readPushFailure(webPushError(429)).drop).toBe(false);
  });

  test("an error with no status at all keeps it", () => {
    // A DNS failure, an abort, a timeout: a plain Error with no `statusCode`.
    // **This is the case the old code got most wrong** — reading a missing
    // status gave `undefined`, and it deleted anyway. An error whose status is
    // unknown is not a subscription known to be gone.
    const { drop, reason } = readPushFailure(new Error("getaddrinfo ENOTFOUND"));
    expect(drop).toBe(false);
    expect(reason).toContain("without a status");
    expect(reason, "the reason lost the only detail there was").toContain("ENOTFOUND");
  });

  test("a non-Error rejection keeps it, and still says something", () => {
    // Nothing guarantees a rejection is an Error. A reason that reads
    // `[object Object]` is still a reason; an empty one is a log line that
    // says a push failed and nothing else.
    const { drop, reason } = readPushFailure("some string");
    expect(drop).toBe(false);
    expect(reason.length).toBeGreaterThan(0);
    expect(reason).toContain("some string");
  });
});

describe("what a status has to be to count", () => {
  test("a status that is not a number is not a status", () => {
    // `statusCode: "410"` from a wrapper or a serialised error must not be read
    // as 410 by coincidence of `Set.has` — it would delete on a value the
    // protocol never sent.
    expect(readPushFailure(Object.assign(new Error("x"), { statusCode: "410" })).drop).toBe(false);
  });
});
