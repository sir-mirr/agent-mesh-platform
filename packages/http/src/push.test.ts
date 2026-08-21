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

// --- The send loop (sendPushForMessage) ------------------------------------
//
// It was 24 lines inside `main.ts` that nothing could reach: the first line is
// a VAPID check, and setting those keys for a test sets them for every other
// file in the process — every send in the suite would start dialling a push
// service. The loop moved here and takes its wiring as an argument, which is
// the same move `readPushFailure` above is the result of.

import { sendPushForMessage, type PushDeps, type PushTarget } from "./push";

const device = (n: number): PushTarget => ({
  endpoint: `https://push.example/${n}`, p256dh: `p${n}`, auth: `a${n}`,
});

/** Deps that record what was asked of them, with everything wired to succeed. */
function wiring(over: Partial<PushDeps> = {}) {
  const sent: Array<{ target: PushTarget; payload: string }> = [];
  const dropped: string[] = [];
  const asked: string[] = [];
  const deps: PushDeps = {
    configured: true,
    watching: () => false,
    devices: (u) => { asked.push(u); return [device(1)]; },
    send: (target, payload) => { sent.push({ target, payload }); return Promise.resolve(); },
    drop: (endpoint) => { dropped.push(endpoint); },
    ...over,
  };
  return { deps, sent, dropped, asked };
}

/** Let the `.catch` on each send run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("whether to send at all", () => {
  /** No keys is not a failure to report — it is a deployment that does not push. */
  test("sends nothing, and asks nothing, without VAPID keys", () => {
    const w = wiring({ configured: false });
    sendPushForMessage(w.deps, "kim", "agent", "hello");
    expect(w.sent).toEqual([]);
    expect(w.asked).toEqual([]);
  });

  /**
   * **An open stream is the message arriving.** A notification beside it is the
   * same message twice, on a device the person is already holding.
   */
  test("sends nothing to somebody already watching", () => {
    const w = wiring({ watching: () => true });
    sendPushForMessage(w.deps, "kim", "agent", "hello");
    expect(w.sent).toEqual([]);
    expect(w.asked).toEqual([]);
  });

  test("asks about the recipient, not the sender", () => {
    const w = wiring();
    sendPushForMessage(w.deps, "kim", "agent", "hello");
    expect(w.asked).toEqual(["kim"]);
  });

  test("does nothing for somebody with no devices", () => {
    const w = wiring({ devices: () => [] });
    sendPushForMessage(w.deps, "kim", "agent", "hello");
    expect(w.sent).toEqual([]);
  });
});

describe("what lands on the lock screen", () => {
  test("names the sender, and carries where to go", () => {
    const w = wiring();
    sendPushForMessage(w.deps, "kim", "some-agent", "hello there");
    expect(w.sent).toHaveLength(1);
    expect(JSON.parse(w.sent[0]!.payload)).toEqual({
      title: "some-agent",
      body: "hello there",
      data: { agent: "some-agent", url: "/chat" },
    });
  });

  /**
   * A hundred characters exactly is the whole message. The ellipsis is a claim
   * that something was left out, and adding it to a complete message is a lie
   * the reader cannot check.
   */
  test("truncates past a hundred characters, and not at a hundred", () => {
    const w = wiring();
    sendPushForMessage(w.deps, "kim", "agent", "x".repeat(100));
    sendPushForMessage(w.deps, "kim", "agent", "y".repeat(101));
    expect(JSON.parse(w.sent[0]!.payload).body).toBe("x".repeat(100));
    expect(JSON.parse(w.sent[1]!.payload).body).toBe("y".repeat(100) + "...");
  });

  test("sends to every device the person registered", () => {
    const w = wiring({ devices: () => [device(1), device(2), device(3)] });
    sendPushForMessage(w.deps, "kim", "agent", "hello");
    expect(w.sent.map((s) => s.target.endpoint)).toEqual([
      "https://push.example/1", "https://push.example/2", "https://push.example/3",
    ]);
    // One payload, built once and shared — the message does not depend on the device.
    expect(new Set(w.sent.map((s) => s.payload)).size).toBe(1);
  });
});

describe("what a failure costs", () => {
  test("removes only the endpoint the service said was gone", async () => {
    const w = wiring({
      devices: () => [device(1), device(2), device(3)],
      send: (target) => target.endpoint.endsWith("/2")
        ? Promise.reject(Object.assign(new Error("gone"), { statusCode: 410 }))
        : Promise.resolve(),
    });
    sendPushForMessage(w.deps, "kim", "agent", "hello");
    await settle();
    expect(w.dropped).toEqual(["https://push.example/2"]);
  });

  /** A push service having a bad minute is not a browser that unsubscribed. */
  test("keeps a subscription through a service failure", async () => {
    for (const error of [
      Object.assign(new Error("slow down"), { statusCode: 429 }),
      Object.assign(new Error("broken"), { statusCode: 500 }),
      new Error("getaddrinfo ENOTFOUND"),
    ]) {
      const w = wiring({ send: () => Promise.reject(error) });
      sendPushForMessage(w.deps, "kim", "agent", "hello");
      await settle();
      expect(w.dropped).toEqual([]);
    }
  });

  /**
   * **A rejected send must not reach the sender.** Push is best effort; a
   * message that was delivered does not become undelivered because a phone
   * could not be told about it.
   */
  test("does not throw, and does not reject, when a send fails", async () => {
    const w = wiring({ send: () => Promise.reject(new Error("nope")) });
    expect(() => sendPushForMessage(w.deps, "kim", "agent", "hello")).not.toThrow();
    await settle();
  });

  /**
   * The subscription lookup itself can fail — a locked database, a missing
   * table. That means no device was even asked, which is worth a line, and it
   * still must not fail the send.
   */
  test("survives a subscription store that will not answer", () => {
    const w = wiring({ devices: () => { throw new Error("database is locked"); } });
    expect(() => sendPushForMessage(w.deps, "kim", "agent", "hello")).not.toThrow();
    expect(w.sent).toEqual([]);
  });
});

describe("what it says it did", () => {
  /**
   * **Queued, not sent.** The line runs while every send is still in flight,
   * so wording it as a delivery would claim one that has not happened — and it
   * would print unchanged if all of them failed.
   */
  test("claims a queue rather than a delivery", () => {
    const real = console.log;
    const lines: string[] = [];
    console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
    try {
      const w = wiring({ devices: () => [device(1), device(2)] });
      sendPushForMessage(w.deps, "kim", "agent", "hello");
    } finally {
      console.log = real;
    }
    expect(lines.join("\n")).toContain("push queued to 2 device(s) for kim from agent");
    expect(lines.join("\n")).not.toContain("push sent");
  });
});
