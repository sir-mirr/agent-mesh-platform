/**
 * A delivery is recorded when the frame lands, not when a socket is present
 * (SPEC § 8.9.4).
 *
 * **`ws.send` reports a dropped frame by returning `0`, and both delivery paths
 * were written as though it threw.** `mesh.send` read `onlineAgents`, decided
 * `delivered` from the map alone, and wrote that into the row and the audit
 * trail before knowing anything about the frame. The replay in `deliverPending`
 * sent and then flipped the row on the next line, with a `catch`/`break` for a
 * closed socket that no exception could ever reach.
 *
 * Measured, because the whole fix rests on one runtime fact:
 *
 * ```
 * open socket    ws.send("hi")          →  2
 * after close    ws.send("after close") →  0, and no exception
 * ```
 *
 * The consequence is not a wrong log line, which is recoverable. A row that is
 * no longer `pending` is never replayed, so the message is gone and the audit
 * trail says the recipient received it. `mailbox.test.ts` asserts the same
 * principle for the § 8.10 path — *acknowledgement is what records delivery,
 * not hand-out* — and the socket path had no equivalent, which is exactly why
 * this survived every green run.
 *
 * ## One file for two paths, deliberately
 *
 * These were two files for an hour. `../db` opens its stores at import from
 * `AGENT_MESH_STATE_DIR`, and bun runs a directory's test files in one process,
 * so the second file's temp directory was never used and the first file's
 * `afterAll` deleted the database both were holding — `disk I/O error`, in a
 * suite where each file passed alone. The singleton is the constraint; one file
 * makes it visible instead of accidental.
 *
 * Fake sockets rather than real ones, for the reason `heartbeat.test.ts` gives:
 * the interesting state is a socket the hub still believes in whose frames go
 * nowhere, and reaching it with a real connection is a race against the close
 * handshake. Here it is a return value.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Set before the modules below are pulled in: the hub opens its stores at
// import time, and a test that shares a developer's real state directory is one
// that edits it.
const stateDir = mkdtempSync(join(tmpdir(), "agent-mesh-delivery-"));
process.env.AGENT_MESH_STATE_DIR = stateDir;

const { handleSend } = await import("./send");
const { deliverPending } = await import("./connect");
const { db, agentsDb, auditDb } = await import("../db");
const { onlineAgents, wsIdentities } = await import("../presence");

afterAll(() => rmSync(stateDir, { recursive: true, force: true }));

/**
 * A socket whose sends land, or do not, on demand.
 *
 * `sent` is kept so a test can tell "the frame was refused" from "the loop
 * never got that far" — without it, a replay that stopped early and one that
 * sent everything and recorded nothing look identical from the database.
 */
function socket(result: number) {
  const sent: string[] = [];
  return { sent, send(frame: string) { sent.push(frame); return result; } };
}

const register = (identity: string) =>
  agentsDb
    .prepare(`INSERT OR IGNORE INTO agents (identity, type) VALUES (?, 'ai-claude')`)
    .run(identity);

const queue = (identity: string, ids: string[]) => {
  for (const id of ids) {
    db.prepare(
      `INSERT INTO messages (id, from_agent, to_agent, content, status, ts)
       VALUES (?, 'sender', ?, 'hello', 'pending', datetime('now'))`,
    ).run(id, identity);
  }
};

const statusOf = (id: string) =>
  (db.prepare(`SELECT status FROM messages WHERE id = ?`).get(id) as { status: string } | null)?.status ?? null;

const eventTypes = () =>
  (auditDb.prepare(`SELECT event_type FROM audit_events ORDER BY rowid`).all() as Array<{ event_type: string }>)
    .map((r) => r.event_type);

beforeEach(() => {
  db.exec(`DELETE FROM messages`);
  auditDb.exec(`DELETE FROM audit_events`);
  // `wsIdentities` is a WeakMap and needs no clearing: every test builds its
  // own socket objects, so no entry from a previous one is reachable.
  onlineAgents.clear();
  register("alice");
  register("bob");
});

/** Send from alice to bob, with bob online on a socket that behaves as given. */
function sendToBob(bobSocket: { send(f: string): number }) {
  const aliceWs = socket(64);
  wsIdentities.set(aliceWs, "alice");
  onlineAgents.set("alice", aliceWs);
  onlineAgents.set("bob", bobSocket);
  const reply = JSON.parse(handleSend(aliceWs, { to: "bob", content: "hello" }, 1));
  return reply.result ?? reply;
}

describe("an immediate delivery", () => {
  test("is recorded delivered when the frame lands", async () => {
    // The half that keeps the assertion below honest: without it, a handler
    // that reported `pending` unconditionally would pass the drop test and
    // break every working send.
    const result = sendToBob(socket(64));

    expect(result.status).toBe("delivered");
    expect(statusOf(result.id)).toBe("delivered");
    expect(eventTypes()).toEqual(["mesh.message.sent", "mesh.message.delivered"]);
  });

  test("is recorded pending when the socket drops the frame", async () => {
    // Bun's `0`. The recipient is in `onlineAgents` and received nothing.
    const result = sendToBob(socket(0));

    expect(result.status, "presence was reported to the caller as delivery").toBe("pending");
    expect(statusOf(result.id), "a message nobody received is not replayable").toBe("pending");
    expect(eventTypes(), "§ 8.9.4 recorded a delivery that did not happen")
      .toEqual(["mesh.message.sent", "mesh.message.pending"]);
  });

  test("still records the second event when delivery fails", async () => {
    // The failing branch used to return early, before § 8.9.4's outcome event.
    // That left a `sent` with nothing after it — a record that stops
    // mid-sentence, and the one case where an operator most wants the rest.
    const result = sendToBob(socket(0));

    expect(eventTypes()).toHaveLength(2);
    expect(statusOf(result.id)).not.toBeNull();
  });

  test("backpressure is a delivery, not a loss", async () => {
    // `-1` means buffered and about to flush. Demoting it to pending would
    // replay a message the recipient is already receiving.
    const result = sendToBob(socket(-1));

    expect(result.status, "backpressure was mistaken for a dropped frame").toBe("delivered");
  });
});

describe("replaying a queue into a socket", () => {
  test("records delivery when the frames land", async () => {
    // The other half of the pair. Without it, the assertion below is satisfied
    // by a `deliverPending` that never delivers anything at all — and a replay
    // that does nothing would pass the test named for the bug while breaking
    // every real client.
    queue("live", ["m1", "m2"]);
    const ws = socket(64);

    deliverPending("live", ws);

    expect(ws.sent, "the replay did not send both messages").toHaveLength(2);
    expect(statusOf("m1")).toBe("delivered");
    expect(statusOf("m2")).toBe("delivered");
    expect(eventTypes(), "§ 8.9.4 wants one delivery event per message")
      .toEqual(["mesh.message.delivered", "mesh.message.delivered"]);
  });

  test("leaves the queue pending when the socket drops the frame", async () => {
    queue("gone", ["m1", "m2"]);
    const ws = socket(0);

    deliverPending("gone", ws);

    expect(statusOf("m1"), "a dropped frame was recorded as a delivery").toBe("pending");
    expect(statusOf("m2")).toBe("pending");
    expect(eventTypes(), "the audit trail claims a recipient received nothing").toEqual([]);
  });

  test("stops at the first drop rather than walking the whole queue", async () => {
    // The `break` this restores. A socket that dropped one frame will drop the
    // next: continuing writes the same false record N times and costs a send
    // per queued message on a connection that is already gone.
    queue("gone", ["m1", "m2", "m3"]);
    const ws = socket(0);

    deliverPending("gone", ws);

    expect(ws.sent, "the loop kept sending after the socket dropped a frame").toHaveLength(1);
  });

  test("backpressure replays as a delivery too", async () => {
    queue("busy", ["m1"]);
    const ws = socket(-1);

    deliverPending("busy", ws);

    expect(statusOf("m1"), "backpressure was mistaken for a dropped frame").toBe("delivered");
  });
});
