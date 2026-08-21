/**
 * Taking delivery, and settling what was taken before (SPEC § 8.10.1).
 *
 * 115 lines that nothing had ever executed. `agent-mesh-local-pm` ranked the
 * uncovered files and found this one at `0.00 / 0.00`, then asked the owner's
 * question back: dead code, or an end-to-end path nobody wrote? Neither — it
 * runs inside the hub on every socketless receive, and the hub is a separate
 * process, so no in-process instrument had ever followed it.
 *
 * **It needs nothing the hub has, and says so in its own header.** The handle,
 * the statements and the `onSettled` hook all arrive as arguments, which is the
 * boundary that keeps the queue from learning the hub exists — and which makes
 * an in-memory database enough to exercise every branch.
 *
 * The statements come from `@agent-mesh/store`, which owns the table, rather
 * than being written out here: the lease window, what counts as leasable, and
 * *only what the caller holds* are the semantics under test, and a second copy
 * of that SQL would drift from the one the product runs.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { captureConsole, eventCounts, resetCountsForTest } from "@agent-mesh/log";
import { hubSchema } from "@agent-mesh/store";
import { receive } from "./receive";

let db: Database;
let stmt: ReturnType<typeof hubSchema.createMailboxStatements>;

const LEASE = 300;

const put = (id: string, to: string, content = "hello") =>
  db
    .prepare("INSERT INTO messages (id, from_agent, to_agent, content, status) VALUES (?, 'sender', ?, ?, 'pending')")
    .run(id, to, content);

const statusOf = (id: string) =>
  (db.prepare("SELECT status FROM messages WHERE id = ?").get(id) as { status: string } | null)?.status ?? null;

const leaseOf = (id: string) =>
  (db.prepare("SELECT leased_until FROM messages WHERE id = ?").get(id) as { leased_until: string | null } | null)
    ?.leased_until ?? null;

beforeEach(() => {
  db = new Database(":memory:");
  hubSchema.migrate(db);
  stmt = hubSchema.createMailboxStatements(db);
});

const take = (identity: string, opts: Partial<Parameters<typeof receive>[0]> = {}) =>
  receive({ db, stmt, identity, limit: 10, ackIds: [], leaseSeconds: LEASE, ...opts });

describe("handing out a batch", () => {
  test("gives a caller only its own queue", () => {
    put("m1", "alice");
    put("m2", "bob");
    const taken = take("alice");
    expect(taken.messages.map((m) => m.id)).toEqual(["m1"]);
    // Nothing of bob's was leased on the way past.
    expect(leaseOf("m2")).toBe(null);
  });

  test("leases what it hands out, so a second caller sees none of it", () => {
    put("m1", "alice");
    expect(take("alice").messages).toHaveLength(1);
    // The lease is what stops two workers holding one message. Without it this
    // second call would hand the same batch out again.
    expect(take("alice").messages).toEqual([]);
    expect(leaseOf("m1")).not.toBe(null);
  });

  test("hands a message back when its lease has lapsed", () => {
    put("m1", "alice");
    take("alice");
    // A caller's turn may have ended before it could persist the batch, so an
    // expired lease returns the message rather than losing it.
    db.prepare("UPDATE messages SET leased_until = datetime('now', '-1 second') WHERE id = ?").run("m1");
    expect(take("alice").messages.map((m) => m.id)).toEqual(["m1"]);
  });

  test("counts what is still waiting after the lease, not before", () => {
    for (const id of ["m1", "m2", "m3"]) put(id, "alice");
    const taken = take("alice", { limit: 2 });
    expect(taken.messages).toHaveLength(2);
    // Two are now leased, so one remains leasable. Counting before the lease
    // would report three and tell a caller to come straight back for a batch
    // it is already holding.
    expect(taken.remaining).toBe(1);
  });

  test("carries the lease window back with the batch", () => {
    put("m1", "alice");
    // A caller that does not know the window cannot decide when to ack.
    expect(take("alice").lease_seconds).toBe(LEASE);
  });

  test("oldest first", () => {
    put("m2", "alice");
    db.prepare("UPDATE messages SET ts = datetime('now', '-1 hour') WHERE id = ?").run("m2");
    put("m1", "alice");
    expect(take("alice").messages.map((m) => m.id)).toEqual(["m2", "m1"]);
  });
});

describe("settling the batch before it", () => {
  test("marks acknowledged messages delivered", () => {
    put("m1", "alice");
    take("alice");
    take("alice", { ackIds: ["m1"] });
    expect(statusOf("m1")).toBe("delivered");
  });

  test("ignores an id the caller does not hold rather than refusing the call", () => {
    put("m1", "alice");
    put("m2", "bob");
    // A caller retrying an ambiguous receive re-sends the same acknowledgements.
    // Failing the retry would strand the very batch it is trying to settle.
    const taken = take("alice", { ackIds: ["m2", "never-existed"] });
    expect(taken.messages.map((m) => m.id)).toEqual(["m1"]);
    // And bob's message is untouched: `to_agent` is part of the acknowledgement.
    expect(statusOf("m2")).toBe("pending");
  });

  test("reports each settled message once, on acknowledgement rather than hand-out", () => {
    // § 8.9.4. A leased batch may be redelivered, and recording each attempt
    // would put several `delivered` events behind one message.
    const settled: string[] = [];
    put("m1", "alice");
    take("alice", { onSettled: (row) => settled.push((row as { id: string }).id) });
    expect(settled).toEqual([]);

    take("alice", { ackIds: ["m1"], onSettled: (row) => settled.push((row as { id: string }).id) });
    expect(settled).toEqual(["m1"]);

    // Acknowledged twice, reported once: the second `ack` changes no row.
    take("alice", { ackIds: ["m1"], onSettled: (row) => settled.push((row as { id: string }).id) });
    expect(settled).toEqual(["m1"]);
  });

  test("settles and leases in one transaction", () => {
    // There is no instant at which a caller has settled one batch and not yet
    // claimed the next: the two are the same act.
    put("m1", "alice");
    put("m2", "alice");
    take("alice", { limit: 1 });
    const taken = take("alice", { ackIds: ["m1"], limit: 1 });
    expect(statusOf("m1")).toBe("delivered");
    expect(taken.messages.map((m) => m.id)).toEqual(["m2"]);
  });
});

/**
 * A lease that lapsed is the only redelivery this service does (T-022).
 *
 * It is the design working: the caller's turn ended before it could persist
 * what it was handed, so the batch comes back. It is also what a caller stuck
 * in a crash loop looks like from here, and the rows cannot tell the two apart
 * — the same message goes out again either way, and it did so silently.
 */
describe("a lease that lapsed", () => {
  const lapsed = (id: string, to: string) => {
    put(id, to);
    db.prepare("UPDATE messages SET leased_until = datetime('now', '-1 seconds') WHERE id = ?").run(id);
  };

  beforeEach(() => resetCountsForTest());

  test("is handed back with a line naming who and how many", () => {
    lapsed("m1", "alice");
    lapsed("m2", "alice");

    const capture = captureConsole();
    let taken;
    try {
      taken = take("alice");
    } finally {
      capture.restore();
    }

    expect(taken.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    const line = capture.lines.find((l) => l.includes('"event":"lease_expired"'));
    expect(line, "a lapsed lease was re-offered without a word").toBeDefined();
    expect(line).toContain('"component":"mailbox"');
    expect(line).toContain('"level":"warn"');
    expect(line).toContain('"actor":"alice"');
    expect(line).toContain('"count":2');
    expect(line).toContain('"reason":"lease_lapsed"');
  });

  test("is counted, so a queue that never re-offers is still an answer", () => {
    lapsed("m1", "alice");
    const capture = captureConsole();
    try {
      take("alice");
    } finally {
      capture.restore();
    }

    expect(eventCounts()).toEqual([
      { component: "mailbox", event: "lease_expired", reason: "lease_lapsed", count: 1 },
    ]);
  });

  test("a first delivery is not one, and says nothing", () => {
    put("m1", "alice");
    const capture = captureConsole();
    try {
      take("alice");
    } finally {
      capture.restore();
    }

    expect(capture.lines).toEqual([]);
    expect(eventCounts()).toEqual([]);
  });

  test("a batch still under its lease is neither re-offered nor mentioned", () => {
    put("m1", "alice");
    take("alice");
    resetCountsForTest();

    const capture = captureConsole();
    let second;
    try {
      second = take("alice");
    } finally {
      capture.restore();
    }

    expect(second.messages).toEqual([]);
    expect(capture.lines).toEqual([]);
    expect(eventCounts()).toEqual([]);
  });

  test("counts the re-offered ones only, in a batch that mixes both", () => {
    lapsed("m1", "alice");
    put("m2", "alice");

    const capture = captureConsole();
    try {
      take("alice");
    } finally {
      capture.restore();
    }

    expect(eventCounts()).toEqual([
      { component: "mailbox", event: "lease_expired", reason: "lease_lapsed", count: 1 },
    ]);
    expect(capture.lines.find((l) => l.includes('"event":"lease_expired"'))).toContain('"count":1');
  });
});
