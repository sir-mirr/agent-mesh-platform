/**
 * Identity teardown (SPEC § 9.3), against the store it acts on.
 *
 * It was reachable only through the admin route, and the one call a coverage
 * run saw tore down an identity holding no keys — so the half that matters,
 * the revocation and the history it writes, ran nowhere. § 10.2 requires each
 * transition to carry who caused it, and a teardown that recorded a revocation
 * without recording who is answerable for it satisfies neither.
 *
 * This file owns the `td-` prefix.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import * as agentsSchema from "./schema/agents";
import { teardownIdentity } from "./teardown";

let n = 0;
const uniq = (p: string) => `td-${p}-${++n}-${process.pid}`;

function store(): Database {
  const db = new Database(":memory:");
  agentsSchema.migrate(db);
  return db;
}

function agent(db: Database, identity = uniq("agent")): string {
  db.prepare("INSERT INTO agents (identity, description, last_seen, created_at) VALUES (?, '', datetime('now'), datetime('now'))")
    .run(identity);
  return identity;
}

function key(db: Database, identity: string, status: string): string {
  const fingerprint = uniq("fp").padEnd(64, "0");
  db.prepare("INSERT INTO agent_keys (fingerprint, identity, public_key, status) VALUES (?, ?, 'pk', ?)")
    .run(fingerprint, identity, status);
  return fingerprint;
}

const statusOf = (db: Database, fingerprint: string) =>
  (db.prepare("SELECT status FROM agent_keys WHERE fingerprint = ?").get(fingerprint) as { status: string }).status;

const events = (db: Database, identity: string) =>
  db.prepare("SELECT fingerprint, action, reason, actor FROM agent_key_events WHERE identity = ? ORDER BY fingerprint")
    .all(identity) as Array<{ fingerprint: string; action: string; reason: string; actor: string }>;

describe("teardownIdentity", () => {
  test("an identity with no row is not found, and nothing is written", () => {
    const db = store();
    const identity = uniq("never-existed");

    expect(teardownIdentity(db, identity, "operator-1")).toEqual({ identity, action: "not-found", revoked: [] });
    expect(events(db, identity)).toEqual([]);
  });

  test("soft-deletes, revokes every live key, and says which", () => {
    const db = store();
    const identity = agent(db);
    const pending = key(db, identity, "pending");
    const approved = key(db, identity, "approved");

    const result = teardownIdentity(db, identity, "operator-1");

    expect(result.action).toBe("soft-deleted");
    expect(result.deletedAt).toBeTruthy();
    expect([...result.revoked].sort()).toEqual([pending, approved].sort());
    expect(statusOf(db, pending)).toBe("revoked");
    expect(statusOf(db, approved)).toBe("revoked");
  });

  /**
   * **The whole point of routing this through an authenticated caller.** A
   * teardown that could only write `"hub"` records that a revocation happened
   * without recording who is answerable for it.
   */
  test("writes one history row per revoked key, naming the actor and the reason", () => {
    const db = store();
    const identity = agent(db);
    const first = key(db, identity, "approved");
    const second = key(db, identity, "pending");

    teardownIdentity(db, identity, "operator-1");

    expect(events(db, identity)).toEqual(
      [first, second]
        .sort()
        .map((fingerprint) => ({ fingerprint, action: "revoked", reason: "teardown", actor: "operator-1" })),
    );
  });

  test("a key already revoked is left where it is, and writes no second event", () => {
    const db = store();
    const identity = agent(db);
    const old = key(db, identity, "revoked");
    const live = key(db, identity, "approved");

    const result = teardownIdentity(db, identity, "operator-1");

    expect(result.revoked).toEqual([live]);
    expect(events(db, identity).map((e) => e.fingerprint)).toEqual([live]);
    expect(statusOf(db, old)).toBe("revoked");
  });

  test("another identity's keys are not touched", () => {
    const db = store();
    const torn = agent(db);
    const bystander = agent(db);
    key(db, torn, "approved");
    const theirs = key(db, bystander, "approved");

    teardownIdentity(db, torn, "operator-1");

    expect(statusOf(db, theirs)).toBe("approved");
    expect(events(db, bystander)).toEqual([]);
  });

  test("tearing down twice is success and does not write a second history", () => {
    const db = store();
    const identity = agent(db);
    key(db, identity, "approved");
    const first = teardownIdentity(db, identity, "operator-1");

    const again = teardownIdentity(db, identity, "operator-2");

    expect(again).toEqual({ identity, action: "already-deleted", deletedAt: first.deletedAt ?? null, revoked: [] });
    expect(events(db, identity)).toHaveLength(1);
    expect(events(db, identity)[0]!.actor).toBe("operator-1");
  });

  test("an identity holding no keys is torn down all the same", () => {
    const db = store();
    const identity = agent(db);

    const result = teardownIdentity(db, identity, "operator-1");

    expect(result.action).toBe("soft-deleted");
    expect(result.revoked).toEqual([]);
    expect(events(db, identity)).toEqual([]);
  });
});
