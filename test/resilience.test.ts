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

import { connectRpc, provision, startMesh, type Mesh } from "./harness";

let mesh: Mesh;

beforeAll(async () => {
  mesh = await startMesh({ withHttp: false });
  // One identity per test: an incumbent socket is never evicted by a contender
  // (§ 8.1), and rpc.close() returns before the hub has processed the close, so
  // reusing an identity across tests races itself.
  for (const id of ["res-a", "res-b", "res-c", "res-d", "res-e", "res-peer"]) {
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
  const db = new Database(path);
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(`ALTER TABLE ${table} RENAME TO ${table}_hidden`);
  db.close();
  return () => {
    const back = new Database(path);
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
