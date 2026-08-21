/**
 * The four behaviour metrics this server reads for itself, and the three ways
 * a store can fail to answer.
 *
 * The distinction under test throughout is `null` against `0`. Four of these
 * six read `0` when the mesh is calm, so an unreadable source that returns `0`
 * is the one wrong number an operator has no reason to question — and one of
 * them did exactly that until this file was written: the key queue was read
 * from a field the helper does not return, so `?? 0` answered for it and
 * telemetry showed an empty queue with proposals waiting in it.
 *
 * This file owns the `tb-` prefix.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { parseSqliteUtc, readBehaviour, type BehaviourDeps } from "./telemetry-behaviour";

const NOW = Date.parse("2027-05-05T12:00:00.000Z");
/** SQLite's `CURRENT_TIMESTAMP` shape: UTC, space-separated, no zone marker. */
const stamp = (msAgo: number) =>
  new Date(NOW - msAgo).toISOString().replace("T", " ").slice(0, 19);

/**
 * The message age is computed by SQLite against `'now'`, which is the real
 * clock and not the injected one — so these stamps are anchored to it. The
 * seam does not reach into SQL, and pretending otherwise would test a
 * subtraction this code does not do.
 */
const sqlStamp = (msAgo: number) =>
  new Date(Date.now() - msAgo).toISOString().replace("T", " ").slice(0, 19);

function hub(messages: Array<{ id: string; status: string; ts: string }> = []): () => Database {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE messages (id TEXT PRIMARY KEY, status TEXT, ts TEXT)");
  const insert = db.prepare("INSERT INTO messages (id, status, ts) VALUES (?, ?, ?)");
  for (const m of messages) insert.run(m.id, m.status, m.ts);
  return () => db;
}

const deps = (over: Partial<BehaviourDeps> = {}): BehaviourDeps => ({
  pendingKeys: () => ({ status: 200, body: { ok: true, keys: [] } }),
  pendingApprovals: () => [],
  openHub: hub(),
  now: () => NOW,
  ...over,
});

describe("the key-proposal queue", () => {
  /**
   * **The regression this file exists for.** `listPending` answers
   * `{ ok, keys }`; the route read `body.proposals?.length ?? 0`, so the count
   * was `0` for every deployment that has ever run — indistinguishable from a
   * queue that is genuinely empty, and read by an operator as *nothing to do*.
   */
  test("counts the proposals the helper actually returns", () => {
    const keys = [{ identity: "one" }, { identity: "two" }];
    expect(readBehaviour(deps({ pendingKeys: () => ({ status: 200, body: { ok: true, keys } }) })).pendingKeys)
      .toBe(2);
  });

  test("reads an empty queue as zero, not as unreadable", () => {
    expect(readBehaviour(deps()).pendingKeys).toBe(0);
  });

  /** A body with no `keys` at all is still an answer: the helper said 200. */
  test("reads a body carrying no list as an empty queue", () => {
    expect(readBehaviour(deps({ pendingKeys: () => ({ status: 200, body: { ok: true } }) })).pendingKeys)
      .toBe(0);
  });

  test("does not count a refusal as an empty queue", () => {
    expect(readBehaviour(deps({ pendingKeys: () => ({ status: 503, body: { ok: false } }) })).pendingKeys)
      .toBeNull();
  });

  test("does not count a store that threw as an empty queue", () => {
    expect(readBehaviour(deps({ pendingKeys: () => { throw new Error("agents.db is gone"); } })).pendingKeys)
      .toBeNull();
  });
});

describe("the admission queue", () => {
  test("counts who is waiting and how long the oldest has", () => {
    const r = readBehaviour(deps({
      pendingApprovals: () => [
        { requested_at: stamp(60_000) },
        { requested_at: stamp(3_600_000) },
        { requested_at: stamp(1_000) },
      ],
    }));
    expect(r.pendingUsers).toBe(3);
    expect(r.oldestPendingUserMs).toBe(3_600_000);
  });

  /**
   * **UTC, stamped rather than assumed** — and asserted from a machine that is
   * not on it.
   *
   * `CURRENT_TIMESTAMP` carries no zone marker, so handing it to `Date.parse`
   * reads it as local time: a queue reported older or younger than it is by
   * exactly the server's offset. UTC is the one machine where that is
   * harmless, and `bun test` runs with `TZ=UTC` by default — so the registered
   * mutation that drops the `Z` survived this test until it moved the zone.
   * A property only observable off UTC has to be asserted off UTC.
   */
  test("reads the stamp as UTC, from a machine that is not", () => {
    const real = process.env.TZ;
    process.env.TZ = "Asia/Seoul";                       // +09:00
    try {
      expect(new Date().getTimezoneOffset()).not.toBe(0);   // the premise, not the property
      expect(parseSqliteUtc("2027-05-05 11:00:00")).toBe(Date.parse("2027-05-05T11:00:00.000Z"));
      const r = readBehaviour(deps({
        pendingApprovals: () => [{ requested_at: "2027-05-05 11:00:00" }],
      }));
      expect(r.oldestPendingUserMs).toBe(3_600_000);
    } finally {
      if (real === undefined) delete process.env.TZ;
      else process.env.TZ = real;
    }
  });

  /** Nobody waiting is an age of zero — the question was answered. */
  test("reports no age rather than no answer when the queue is empty", () => {
    const r = readBehaviour(deps());
    expect(r.pendingUsers).toBe(0);
    expect(r.oldestPendingUserMs).toBe(0);
  });

  /** A row whose stamp will not parse is still a person waiting. */
  test("counts a row it cannot date, and does not let it set the age", () => {
    const r = readBehaviour(deps({
      pendingApprovals: () => [{ requested_at: "not a date" }, { requested_at: stamp(5_000) }],
    }));
    expect(r.pendingUsers).toBe(2);
    expect(r.oldestPendingUserMs).toBe(5_000);
  });

  test("reports no age when no row can be dated", () => {
    const r = readBehaviour(deps({ pendingApprovals: () => [{}, { requested_at: "" }] }));
    expect(r.pendingUsers).toBe(2);
    expect(r.oldestPendingUserMs).toBe(0);
  });

  test("does not report an empty queue when the store threw", () => {
    const r = readBehaviour(deps({ pendingApprovals: () => { throw new Error("users.db is gone"); } }));
    expect(r.pendingUsers).toBeNull();
    expect(r.oldestPendingUserMs).toBeNull();
  });
});

describe("the message store", () => {
  test("counts everything accepted, whatever its status", () => {
    const r = readBehaviour(deps({
      openHub: hub([
        { id: "m1", status: "sent", ts: sqlStamp(10_000) },
        { id: "m2", status: "pending", ts: sqlStamp(5_000) },
        { id: "m3", status: "failed", ts: sqlStamp(1_000) },
      ]),
    }));
    expect(r.accepted).toBe(3);
  });

  /** The age is computed in SQL, where the stamp was written. */
  test("ages the oldest message still pending, and ignores the ones that moved", () => {
    const r = readBehaviour(deps({
      openHub: hub([
        { id: "m1", status: "sent", ts: sqlStamp(3_600_000) },
        { id: "m2", status: "pending", ts: sqlStamp(60_000) },
      ]),
    }));
    expect(r.oldestPendingMs).toBeGreaterThanOrEqual(59_000);
    expect(r.oldestPendingMs).toBeLessThanOrEqual(61_000);
  });

  /** Nothing pending is a real zero: the query ran and the answer was none. */
  test("reads an empty pending set as zero, not as unreadable", () => {
    const r = readBehaviour(deps({ openHub: hub([{ id: "m1", status: "sent", ts: sqlStamp(1_000) }]) }));
    expect(r.oldestPendingMs).toBe(0);
    expect(r.accepted).toBe(1);
  });

  test("reports both as unread when the store will not answer", () => {
    const r = readBehaviour(deps({ openHub: () => new Database(":memory:") }));  // no `messages`
    expect(r.oldestPendingMs).toBeNull();
    expect(r.accepted).toBeNull();
  });

  test("reports both as unread when the handle cannot be opened", () => {
    const r = readBehaviour(deps({ openHub: () => { throw new Error("hub.db is not there"); } }));
    expect(r.oldestPendingMs).toBeNull();
    expect(r.accepted).toBeNull();
  });
});

describe("one source failing", () => {
  /** Each store is read in its own `try`: a failure narrows the answer, not the report. */
  test("does not take the others down with it", () => {
    const r = readBehaviour(deps({
      pendingKeys: () => { throw new Error("agents.db is gone"); },
      pendingApprovals: () => [{ requested_at: stamp(2_000) }],
      openHub: hub([{ id: "m1", status: "pending", ts: sqlStamp(1_000) }]),
    }));
    expect(r.pendingKeys).toBeNull();
    expect(r.pendingUsers).toBe(1);
    expect(r.accepted).toBe(1);
  });
});
