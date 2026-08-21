/**
 * `mesh.receive`, called directly.
 *
 * `agent-mesh-local-pm` found `packages/mailbox/src/receive.ts` reading
 * `0.00 / 0.00` — 115 lines that nothing had executed — and asked whether that
 * was dead code or an end-to-end path nobody had written. It is neither: the
 * lease-and-settle logic runs inside the hub, which is a separate process, so
 * no in-process instrument had ever followed it.
 *
 * **In-process, in the run's shared state directory.** These tests were written
 * against a child of their own, for a real reason: `hub/src/db.ts` opens its
 * handles at module load and they are `const`, so a file that owns a temporary
 * directory and removes it leaves every later caller with `SQLITE_IOERR`. But a
 * child solves that by not needing the shared directory, and it also puts every
 * line it executes outside this process's coverage — the module still read
 * 40 uncovered lines out of 49 with the whole suite green.
 *
 * The directory is not the problem; owning and deleting one is. So this file
 * does what `messages.test.ts` beside it does: the shared directory, unique
 * identities, and no cleanup. Nothing here reads a row it did not write.
 */
import { describe, expect, test } from "bun:test";

import { auditDb, db } from "../db";
import { INVALID_PARAMS } from "../jsonrpc";
import { handleReceive, LEASE_SECONDS } from "./receive";

let n = 0;
const uniq = (p: string) => `rcv-${p}-${++n}-${process.pid}`;

/** A pending message waiting for `to`, written straight into the queue. */
function waiting(to: string, content = "hello", offsetSeconds = 0): string {
  const id = uniq("m");
  db.prepare(
    `INSERT INTO messages (id, from_agent, to_agent, sent_by, content, status, ts)
     VALUES (?, ?, ?, ?, ?, 'pending', datetime('now', ? || ' seconds'))`,
  ).run(id, uniq("sender"), to, uniq("sender"), content, String(offsetSeconds));
  return id;
}

/** How many `delivered` events the audit holds for one message (§ 8.9.4). */
const deliveredEvents = (messageId: string) =>
  (auditDb
    .prepare(
      `SELECT count(*) AS n FROM audit_events
        WHERE correlation_id = ? AND event_type = 'mesh.message.delivered'`,
    )
    .get(messageId) as { n: number }).n;

const statusOf = (id: string) =>
  (db.prepare(`SELECT status, leased_until FROM messages WHERE id = ?`).get(id) as
    | { status: string; leased_until: string | null }
    | undefined);

type Answer = {
  result?: { messages: Array<{ id: string; content: string }>; remaining: number; lease_seconds: number };
  error?: { code: number; message: string };
};

const call = (identity: string | null, params: Record<string, unknown> = {}): Answer =>
  JSON.parse(handleReceive(identity, params, 1));

describe("who may drain a mailbox", () => {
  test("refuses a request that carries no identity, and says why", () => {
    // The transport signs requests; an unsigned one has nobody to hand a
    // mailbox to. Naming the method is what stops a caller guessing which
    // parameter it was short of.
    const answered = call(null);
    expect(answered.error?.code).toBe(INVALID_PARAMS);
    expect(answered.error!.message).toContain("mesh.receive");
  });

  test("hands an empty mailbox back as an empty batch, not as a refusal", () => {
    // Nothing waiting is an answer. A worker polling an empty mailbox must be
    // able to tell it from a mailbox it was not allowed to read.
    const answered = call(uniq("nobody"));
    expect(answered.error).toBeUndefined();
    expect(answered.result!.messages).toEqual([]);
    expect(answered.result!.remaining).toBe(0);
  });

  test("says how long the lease it just granted lasts", () => {
    // The batch is leased rather than handed over, and the caller is told for
    // how long — one binding read by both this answer and
    // `/api/v1/capabilities`, because two readers of the environment is what
    // made the two disagree before.
    expect(call(uniq("nobody")).result!.lease_seconds).toBe(LEASE_SECONDS);
  });
});

describe("what comes back", () => {
  test("hands over what is waiting, oldest first", () => {
    const me = uniq("worker");
    const older = waiting(me, "first", -60);
    const newer = waiting(me, "second", -30);

    const batch = call(me).result!;
    expect(batch.messages.map((m) => m.id)).toEqual([older, newer]);
    expect(batch.messages.map((m) => m.content)).toEqual(["first", "second"]);
    expect(batch.remaining).toBe(0);
  });

  /**
   * **Handed out is not settled.** The row stays `pending` with a lease on it,
   * because a turn can end between the response arriving and anything being
   * written — a destructive read discards exactly what the caller did not
   * survive to persist.
   */
  test("leaves the batch pending, under a lease", () => {
    const me = uniq("worker");
    const id = waiting(me);
    call(me);
    const row = statusOf(id)!;
    expect(row.status).toBe("pending");
    expect(row.leased_until).not.toBeNull();
  });

  /** And a leased batch is invisible to the next call, rather than duplicated. */
  test("does not hand the same batch to the next call while the lease holds", () => {
    const me = uniq("worker");
    waiting(me);
    expect(call(me).result!.messages).toHaveLength(1);
    const second = call(me).result!;
    expect(second.messages).toEqual([]);
    // Leased, not gone: it is still the caller's to settle.
    expect(second.remaining).toBe(0);
  });

  /** `remaining` counts what is leasable now, so a full page says there is more. */
  test("says how much is left behind the page it handed over", () => {
    const me = uniq("worker");
    const ids = [waiting(me, "a", -30), waiting(me, "b", -20), waiting(me, "c", -10)];
    const batch = call(me, { limit: 1 }).result!;
    expect(batch.messages.map((m) => m.id)).toEqual([ids[0]!]);
    expect(batch.remaining).toBe(2);
  });
});

describe("settling the last batch", () => {
  /**
   * **Acknowledged on the next call, not by a second round trip.** One call,
   * one transaction: there is no instant at which a caller has settled one
   * batch and not yet claimed the next, and a message arriving between a read
   * and a separate ack cannot be cleared by an ack that predates it.
   */
  test("settles the ids the caller carries back, and claims the next batch at once", () => {
    const me = uniq("worker");
    const first = waiting(me, "first", -60);
    call(me, { limit: 1 });

    const next = waiting(me, "second", -30);
    const batch = call(me, { limit: 1, ack_ids: [first] }).result!;

    expect(statusOf(first)!.status).toBe("delivered");
    expect(batch.messages.map((m) => m.id)).toEqual([next]);
  });

  /** Ids the caller does not hold are ignored, so an ambiguous retry is safe. */
  test("ignores an acknowledgement for somebody else's message", () => {
    const mine = uniq("worker");
    const theirs = uniq("worker");
    const notMine = waiting(theirs);

    const answered = call(mine, { ack_ids: [notMine] });
    expect(answered.error).toBeUndefined();
    expect(statusOf(notMine)!.status).toBe("pending");
  });

  /**
   * **A second acknowledgement of the same id settles nothing.** SQLite counts
   * a row rewritten with identical values as changed, so without the
   * `status = 'pending'` guard the settle hook fires twice and § 8.9.4's one
   * `delivered` event per message becomes two — on the retry the design
   * deliberately makes safe.
   */
  test("does not settle a message twice", () => {
    const me = uniq("worker");
    const id = waiting(me);
    call(me, { ack_ids: [] });
    call(me, { ack_ids: [id] });
    expect(statusOf(id)!.status).toBe("delivered");
    expect(deliveredEvents(id)).toBe(1);

    const again = call(me, { ack_ids: [id] });
    expect(again.error).toBeUndefined();
    expect(statusOf(id)!.status).toBe("delivered");
    // The status alone cannot tell the two apart — a second settle rewrites it
    // to the value it already had. The audit is where it shows.
    expect(deliveredEvents(id)).toBe(1);
  });

  /** Settling is what records the delivery, and it records it once. */
  test("records the delivery when the caller settles, not when it is handed over", () => {
    const me = uniq("worker");
    const id = waiting(me);
    call(me);
    expect(deliveredEvents(id)).toBe(0);
    call(me, { ack_ids: [id] });
    expect(deliveredEvents(id)).toBe(1);
  });

  /**
   * **Filtered, not trusted**, and the list an unfiltered version cannot
   * survive is the nested one: `bun:sqlite` reads an array as the whole
   * positional list, so `[["x"]]` raises *expected 2 values, received 1* from
   * inside the transaction. The settle step runs before the lease is granted,
   * so that throw does not merely fail to settle — it takes the batch down
   * with it, and the caller is handed nothing on a call it could not have
   * known was malformed. (A number, a null or an object is inert against these
   * statements; the array is the one that bites.)
   */
  test("takes ack ids only when they are strings", () => {
    const me = uniq("worker");
    const id = waiting(me);
    const other = waiting(me, "still here");
    call(me, { limit: 1 });
    const answered = call(me, { ack_ids: [id, 2, null, { id }, ["x"], true] as unknown[] });
    expect(answered.error).toBeUndefined();
    expect(statusOf(id)!.status).toBe("delivered");
    // The batch was still claimed: the malformed entries settled nothing and
    // stopped nothing.
    expect(answered.result!.messages.map((m) => m.id)).toContain(other);
  });

  test("takes no ack ids at all when the parameter is not a list", () => {
    const me = uniq("worker");
    waiting(me);
    expect(call(me, { ack_ids: "not-a-list" }).error).toBeUndefined();
  });
});

describe("the batch size", () => {
  /**
   * `limit` arrives from the wire. Both ends of the range are the mesh's to
   * decide: a request for none or for a million is answered on the hub's terms
   * rather than passed to a query.
   */
  test("is clamped rather than passed through", () => {
    const me = uniq("worker");
    for (let i = 0; i < 3; i++) waiting(me, `m${i}`, -30 + i);

    // Zero and negative mean one, not none — a caller asking for nothing would
    // otherwise poll forever against a queue that never empties.
    expect(call(uniq("fresh-a"), { limit: 0 }).error).toBeUndefined();
    const one = call(me, { limit: -5 }).result!;
    expect(one.messages).toHaveLength(1);
    expect(one.remaining).toBe(2);
  });

  test("falls back to the default when the limit is not a number", () => {
    const me = uniq("worker");
    waiting(me);
    expect(call(me, { limit: "not a number" }).result!.messages).toHaveLength(1);
  });

  test("does not exceed the advertised maximum", async () => {
    const { MAILBOX_CAPABILITY_DEFAULTS } = await import("@agent-mesh/contracts");
    const me = uniq("worker");
    waiting(me);
    const batch = call(me, { limit: 1_000_000 }).result!;
    expect(batch.messages.length).toBeLessThanOrEqual(MAILBOX_CAPABILITY_DEFAULTS.max_receive_batch);
  });
});
