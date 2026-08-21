/**
 * The two answers a degraded audit store has to give.
 *
 * Both were unreachable for the same reason, and it is not the usual one: the
 * code was fine and the *only* way to run it was to break a database. That was
 * tried once — `hub.db` renamed without its `-wal` — and eight later tests
 * failed on a mismatched WAL, in files that had nothing to do with the audit.
 * A broken database in a shared test process is carried into whatever runs
 * next.
 *
 * So both take what they need as an argument now. Breaking the store becomes
 * passing a different function, and the assertions below are about the two
 * decisions rather than about SQLite:
 *
 * - **An empty list is an answer and a failed query is not one.** Returning
 *   `{ agents: [] }` from the catch made *the audit holds nobody* and *the
 *   query did not run* one sentence (D-736).
 * - **A read that cannot be recorded does not happen.** § 15.6 lets delivery
 *   survive an unwritable audit store, and copying that here would be wrong
 *   for a reason that looks like consistency: a delivery failing open loses
 *   nothing that was going to be recorded, and an access log failing open
 *   loses the only record that the access happened.
 *
 * This file owns the `deg-` prefix.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { auditAgents } from "./audit-agents";
import { recordContentReadOrRefuse } from "./audit-access-log";

/** A hub store with the messages named, in memory and belonging to one test. */
function hubWith(rows: Array<[string, string]>): () => Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE messages (id TEXT PRIMARY KEY, from_agent TEXT, to_agent TEXT)`);
  rows.forEach(([from, to], i) => {
    db.prepare(`INSERT INTO messages (id, from_agent, to_agent) VALUES (?, ?, ?)`)
      .run(`deg-${i}`, from, to);
  });
  return () => db;
}

describe("who appears in the audit", () => {
  test("names both ends of every message, once each", () => {
    const r = auditAgents(hubWith([["alice", "bob"], ["bob", "alice"], ["alice", "carol"]]));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ agents: ["alice", "bob", "carol"] });
  });

  /** An operator picks from this list. `Zeta` before `alpha` is a list nobody can scan. */
  test("sorts without regard to case", () => {
    const r = auditAgents(hubWith([["Zeta", "alpha"], ["Beta", "Zeta"]]));
    expect((r.body as { agents: string[] }).agents).toEqual(["alpha", "Beta", "Zeta"]);
  });

  test("drops a blank name rather than offering it", () => {
    const r = auditAgents(hubWith([["", "bob"], ["alice", ""]]));
    expect((r.body as { agents: string[] }).agents).toEqual(["alice", "bob"]);
  });

  /** An audit with nothing in it is `200` and an empty list. That answer is fine. */
  test("answers an empty list for an empty audit", () => {
    const r = auditAgents(hubWith([]));
    expect(r).toEqual({ status: 200, body: { agents: [] } });
  });

  /**
   * **The distinction the route existed to lose.** A store that will not answer
   * is `503` with a code, not `200` with the same body an empty audit produces.
   */
  test("refuses rather than reporting an empty audit, when the store will not answer", () => {
    const r = auditAgents(() => { throw new Error("unable to open database file"); });
    expect(r.status).toBe(503);
    expect(r.body).toEqual({
      ok: false,
      error: "the audit store did not answer, so who appears in it is unknown",
      code: "AUDIT_AGENTS_UNAVAILABLE",
    });
    expect(r.body).not.toHaveProperty("agents");
  });

  /** A handle that opens and then fails on the query is the same situation. */
  test("refuses when the query fails rather than the connection", () => {
    const empty = new Database(":memory:");   // no `messages` table at all
    const r = auditAgents(() => empty);
    expect(r.status).toBe(503);
    expect((r.body as { code: string }).code).toBe("AUDIT_AGENTS_UNAVAILABLE");
  });

  /** A thrown non-Error still produces a refusal rather than a crash. */
  test("survives a failure that is not an Error", () => {
    const r = auditAgents(() => { throw "just a string"; });
    expect(r.status).toBe(503);
  });
});

describe("a read that could not be recorded", () => {
  const read = { actor: "deg-operator", target: "deg-target", query: { q: "x" } };

  test("proceeds when the record is written", () => {
    let recorded: unknown = null;
    expect(recordContentReadOrRefuse(read, (r) => { recorded = r; })).toBeNull();
    expect(recorded).toEqual(read);
  });

  /**
   * **Fails closed.** The refusal is a returned value rather than an exception,
   * because the closed path is the one nobody exercises and a `throw` a caller
   * forgets to catch fails open by accident.
   */
  test("refuses, and says so in a shape a caller can act on", () => {
    const refusal = recordContentReadOrRefuse(read, () => { throw new Error("disk is full"); });
    expect(refusal).toEqual({
      ok: false,
      error: "content reads are recorded, and the record could not be written",
      code: "AUDIT_READ_UNRECORDABLE",
    });
  });

  /**
   * The reason goes to the log, not to the caller. One sentence out, because a
   * refusal that varies its wording with the failure hands whoever is probing
   * it a description of the deployment's internals.
   */
  test("keeps the failure's own words out of the answer", () => {
    const refusal = recordContentReadOrRefuse(read, () => {
      throw new Error("SQLITE_READONLY: /var/lib/agent-mesh/audit.db");
    });
    expect(JSON.stringify(refusal)).not.toContain("/var/lib");
    expect(JSON.stringify(refusal)).not.toContain("SQLITE_READONLY");
  });

  test("refuses a non-Error failure too", () => {
    expect(recordContentReadOrRefuse(read, () => { throw "nope"; })?.code)
      .toBe("AUDIT_READ_UNRECORDABLE");
  });
});
