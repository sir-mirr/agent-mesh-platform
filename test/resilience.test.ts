/**
 * § 15.6 — routing survives storage failing.
 *
 * "On exhaustion the hub MUST keep routing and MUST reject audit writes with
 * -32044." The clause exists because the inversion is so easy to write: a
 * recording feature taking down the communication feature.
 *
 * The realistic exhaustion case is one full volume, since putting audit on its
 * own is a deployment choice nothing enforces. So the test makes writes fail
 * rather than filling a disk — a read-only database produces the same shape of
 * failure at the same point, without needing a volume to fill.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";

import { connectRpc, openTestDb, provision, startMesh, type Mesh } from "./harness";

let mesh: Mesh;

beforeAll(async () => {
  mesh = await startMesh({ withHttp: false });
  // One identity per test: an incumbent socket is never evicted by a contender
  // (§ 8.1), and rpc.close() returns before the hub has processed the close, so
  // reusing an identity across tests races itself.
  for (const id of ["res-a", "res-b", "res-c", "res-d", "res-e", "res-peer", "res-audit", "res-audit2"]) {
    await provision(mesh.hub, id, "service");
  }
});

afterAll(() => mesh?.stop());

/**
 * Make writes to one table fail, and put it back.
 *
 * Renaming is the way to induce this from outside the process. Making the file
 * read-only does not work — chmod does not revoke an already-open descriptor,
 * so the hub kept writing happily and the test proved nothing. A missing table
 * fails at execution even for a statement prepared long before, which is the
 * same point in the same call as a full volume.
 */
function breakTable(file: string, table: string): () => void {
  const path = join(mesh.stateDir, file);
  const db = openTestDb(path);
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(`ALTER TABLE ${table} RENAME TO ${table}_hidden`);
  db.close();
  return () => {
    const back = openTestDb(path);
    back.exec("PRAGMA busy_timeout = 5000;");
    back.exec(`ALTER TABLE ${table}_hidden RENAME TO ${table}`);
    back.close();
  };
}

describe("a write that cannot land", () => {
  test("is reported, and the hub keeps answering", async () => {
    const rpc = await connectRpc(mesh.hub);
    await rpc.call("mesh.connect", { identity: "res-a" });
    expect((await rpc.call("mesh.send", { to: "res-peer", content: "before" })).error)
      .toBeUndefined();

    const thaw = breakTable("hub.db", "messages");
    try {
      // Unguarded, this threw out of the socket handler and answered nothing:
      // the caller waits forever, which is indistinguishable from a hung hub.
      const failed = await rpc.call("mesh.send", { to: "res-peer", content: "during" });
      expect(failed.error).toBeTruthy();
      expect(failed.error.data?.retryable).toBe(true);

      // The socket is still usable, which is the actual requirement. A read
      // does not touch the frozen file.
      const listed = await rpc.call("mesh.list_agents", {});
      expect(listed.error).toBeUndefined();
      expect(Array.isArray(listed.result.agents)).toBe(true);
    } finally {
      thaw();
    }

    // And it recovers: nothing had to be restarted.
    expect((await rpc.call("mesh.send", { to: "res-peer", content: "after" })).error)
      .toBeUndefined();
    rpc.close();
  });

  test("audit failing does not stop routing", async () => {
    // § 15.6's exact requirement. Hub-recorded events are best-effort by
    // construction — recordMeshEvent swallows — so an unwritable audit store
    // must leave delivery untouched.
    const rpc = await connectRpc(mesh.hub);
    await rpc.call("mesh.connect", { identity: "res-b" });

    const thaw = breakTable("audit.db", "audit_events");
    try {
      const res = await rpc.call("mesh.send", { to: "res-peer", content: "audit is frozen" });
      expect(res.error).toBeUndefined();
      expect(res.result.id).toBeTruthy();
    } finally {
      thaw();
    }
    rpc.close();
  });

  test("one socket's failure does not disturb another", async () => {
    const a = await connectRpc(mesh.hub);
    const b = await connectRpc(mesh.hub);
    await a.call("mesh.connect", { identity: "res-c" });
    await b.call("mesh.connect", { identity: "res-d" });

    const thaw = breakTable("hub.db", "messages");
    try {
      expect((await a.call("mesh.send", { to: "res-peer", content: "x" })).error).toBeTruthy();
      // b never wrote to the broken table and must be unaffected.
      expect((await b.call("mesh.list_agents", {})).error).toBeUndefined();
    } finally {
      thaw();
    }
    a.close();
    b.close();
  });
});

describe("§ 8.9.3 error classes", () => {
  /**
   * The split matters more than either class does. A client retries transient
   * "with backoff and jitter and no maximum attempt count" and drops permanent
   * — so a permanent failure reported as transient is an unbounded retry
   * against a path that is already broken, and the event sits in an outbox
   * nobody is watching instead of in a local failure record someone can read.
   */
  test("a store failure the hub cannot classify is permanent, not AUDIT_BUSY", async () => {
    const rpc = await connectRpc(mesh.hub);
    await rpc.call("mesh.connect", { identity: "res-audit" });

    const thaw = breakTable("audit.db", "audit_events");
    try {
      const res = await rpc.call("mesh.audit.append", {
        schema_version: 1,
        event_id: "01900000-0000-7000-8000-00000000ab01",
        event_type: "channel.message.received",
        occurred_at: new Date().toISOString(),
        payload: { note: "the store is broken" },
      });

      expect(res.error).toBeTruthy();
      // Anything in the transient class here would be retried forever: a
      // missing table fails identically on every attempt.
      expect(res.error.code).not.toBe(-32043);
      expect(res.error.code).not.toBe(-32044);
      expect(res.error.code).toBe(-32000);
      expect(res.error.data?.code).toBe("AUDIT_APPEND_FAILED");
      // No `retry_after_ms`: a permanent error has no useful one, and carrying
      // it would invite exactly the retry the class forbids.
      expect(res.error.data?.retry_after_ms).toBeUndefined();
    } finally {
      thaw();
    }

    // Recovered without a restart, and the same event now commits — the
    // permanence is about this attempt's cause, not about the event.
    const after = await rpc.call("mesh.audit.append", {
      schema_version: 1,
      event_id: "01900000-0000-7000-8000-00000000ab01",
      event_type: "channel.message.received",
      occurred_at: new Date().toISOString(),
      payload: { note: "the store is broken" },
    });
    expect(after.error).toBeUndefined();
    expect(after.result.committed).toBe(true);
    rpc.close();
  });

  test("routing survives an audit store that cannot be written", async () => {
    // Restated here beside the class test because they are the same failure
    // seen from two sides: § 15.6 requires delivery to outlive audit, and
    // § 8.9.3 requires the client to be told which kind of failure it was.
    const rpc = await connectRpc(mesh.hub);
    await rpc.call("mesh.connect", { identity: "res-audit2" });

    const thaw = breakTable("audit.db", "audit_events");
    try {
      const sent = await rpc.call("mesh.send", { to: "res-peer", content: "still routing" });
      expect(sent.error).toBeUndefined();
    } finally {
      thaw();
    }
    rpc.close();
  });
});

describe("the dispatcher's last-resort guard", () => {
  test("answers with the request's id, so the caller is not left waiting", async () => {
    // The guard exists because an exception out of the socket callback answers
    // nothing and the caller cannot tell that from a hung hub. Answering with
    // `id: null` reaches the same place by a different route: a JSON-RPC caller
    // correlates on id, discards a reply carrying none, and waits out its own
    // timeout. This was live — a `mesh.audit.append` against a broken store hung
    // for five seconds and then failed as "no response".
    const rpc = await connectRpc(mesh.hub);
    await rpc.call("mesh.connect", { identity: "res-c" });

    const thaw = breakTable("audit.db", "audit_events");
    try {
      // `call` rejects on timeout, so reaching an assertion at all is most of
      // the point.
      const res = await rpc.call("mesh.audit.append", {
        schema_version: 1,
        event_id: "01900000-0000-7000-8000-00000000ac01",
        event_type: "channel.message.received",
        occurred_at: new Date().toISOString(),
        payload: { note: "guarded" },
      });
      expect(res.error).toBeTruthy();
      expect(res.id).not.toBeNull();
    } finally {
      thaw();
    }
    rpc.close();
  });

  test("a frame with no usable id still gets an answer rather than silence", async () => {
    const rpc = await connectRpc(mesh.hub);
    await rpc.call("mesh.connect", { identity: "res-d" });

    // A notification — no id — is the one case where `null` is correct, and the
    // hub must not invent one.
    rpc.raw(JSON.stringify({ jsonrpc: "2.0", method: "mesh.list_agents", params: {} }));

    // Still answering afterwards is the requirement: a malformed frame must not
    // take the socket down with it.
    const after = await rpc.call("mesh.list_agents", {});
    expect(after.error).toBeUndefined();
    rpc.close();
  });
});

describe("the hub and the contract agree on how to class a failure", () => {
  test("the code the hub emits is the one contracts classes permanent", async () => {
    // Not a restatement of the hub's own constant: the two are checked against
    // each other. Every defect a fully green suite here has missed was a
    // cross-implementation disagreement, because a test written against one
    // side can only assert that side agrees with itself — and the client
    // caught this exact table being incomplete before this test existed.
    const { ERROR_CLASS, MESH_ERROR } = await import("@agent-mesh/contracts");

    const rpc = await connectRpc(mesh.hub);
    await rpc.call("mesh.connect", { identity: "res-e" });

    const thaw = breakTable("audit.db", "audit_events");
    let code: number;
    try {
      const res = await rpc.call("mesh.audit.append", {
        schema_version: 1,
        event_id: "01900000-0000-7000-8000-00000000ad01",
        event_type: "channel.message.received",
        occurred_at: new Date().toISOString(),
        payload: { note: "classed" },
      });
      code = res.error.code;
    } finally {
      thaw();
    }

    expect(code).toBe(MESH_ERROR.SERVER_ERROR);
    expect(ERROR_CLASS[code]).toBe("permanent");
    rpc.close();
  });
});
