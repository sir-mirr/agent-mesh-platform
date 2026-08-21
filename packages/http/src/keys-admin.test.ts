/**
 * An operator's decision on one key (SPEC § 10.2), driven directly.
 *
 * Three things this layer decides, none of them visible from the route:
 *
 * - **The actor is recorded.** An approval nobody is named for is an approval
 *   nobody can be asked about.
 * - **A revocation requires a reason**, and not for form's sake: a routine
 *   `rotation` says nothing about signatures made before it, while
 *   `compromise` casts doubt on the whole window preceding it. Only the
 *   recorded reason lets a verifier tell those apart afterwards, and by then
 *   nobody remembers.
 * - **404 and 409 are different answers.** An operator acting on a stale
 *   listing needs to know whether they have the wrong string or whether
 *   somebody got there first.
 *
 * This file owns the `ka-` prefix.
 */
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";

import { STORE_FILES, agentsSchema, keys, openAt, stateDir } from "@agent-mesh/store";
import { join } from "node:path";

import { agentsDb, decide, keyHistory, listPending } from "./keys-admin";

let n = 0;
const uniq = (p: string) => `ka-${p}-${++n}-${process.pid}`;

/**
 * Created here because `agentsDb()` opens with `create: false` — the http
 * server never makes this file, the hub does. Run alone, this file is the
 * first to touch it, and "the store is not there" is not the failure any case
 * below is about.
 */
agentsSchema.migrate(openAt(join(stateDir(), STORE_FILES.agents), { create: true }));

const db = agentsDb();

function publicKey(): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return Buffer.from(der.subarray(der.length - 32)).toString("base64url");
}

/** An identity holding one proposed key, waiting on a decision. */
function proposed(identity = uniq("agent")) {
  db.prepare(`INSERT OR IGNORE INTO agents (identity, type) VALUES (?, 'ai-claude')`).run(identity);
  const { fingerprint } = keys.proposeKey(db, identity, publicKey(), "keys-admin-test");
  return { identity, fingerprint };
}

const body = (r: { body: Record<string, unknown> }) => r.body as any;

describe("what is waiting", () => {
  test("lists a proposal with what an operator decides on, and no key material", () => {
    const k = proposed();
    const listed = body(listPending()).keys.find((e: any) => e.fingerprint === k.fingerprint);

    expect(listed).toBeDefined();
    expect(listed.identity).toBe(k.identity);
    expect(listed.proposed_at).toBeTruthy();
    // The comparison is against what the agent's operator reports out of band,
    // so the fingerprint is the thing to show. The key is on the row.
    expect(listed.public_key).toBeTruthy();
  });

  test("drops a proposal from the queue once it is decided", () => {
    const k = proposed();
    expect(decide("approve", k.fingerprint, "operator-1", null).status).toBe(200);
    expect(body(listPending()).keys.map((e: any) => e.fingerprint)).not.toContain(k.fingerprint);
  });
});

describe("one identity's history", () => {
  test("carries every transition, newest first, with who decided", () => {
    const k = proposed();
    decide("approve", k.fingerprint, "operator-1", null);

    const history = body(keyHistory(k.identity));
    expect(history.ok).toBe(true);
    expect(history.identity).toBe(k.identity);
    expect(history.keys.map((e: any) => e.status)).toContain("approved");
    expect(history.keys.find((e: any) => e.fingerprint === k.fingerprint).decided_by)
      .toBe("operator-1");
  });

  test("answers an identity nobody has proposed for with an empty history", () => {
    const history = body(keyHistory(uniq("nobody")));
    expect(history.ok).toBe(true);
    expect(history.keys).toEqual([]);
  });
});

describe("deciding", () => {
  test("records who approved it, and when", () => {
    const k = proposed();
    const r = decide("approve", k.fingerprint, "operator-1", null);
    expect(r.status).toBe(200);
    expect(body(r)).toMatchObject({
      ok: true, fingerprint: k.fingerprint, identity: k.identity,
      status: "approved", decided_by: "operator-1",
    });
    expect(body(r).decided_at).toBeTruthy();
  });

  test("records a denial the same way", () => {
    const k = proposed();
    const r = decide("deny", k.fingerprint, "operator-2", "not this one");
    expect(body(r)).toMatchObject({ status: "denied", decided_by: "operator-2" });
  });

  /**
   * **A revocation without a reason is refused before anything is written.**
   * `rotation` and `compromise` mean different things about every signature
   * made before the revocation, and only the recorded reason tells them apart.
   */
  test("refuses a revocation that gives no reason", () => {
    const k = proposed();
    decide("approve", k.fingerprint, "operator-1", null);

    const r = decide("revoke", k.fingerprint, "operator-1", null);
    expect(r.status).toBe(400);
    expect(body(r).error).toContain("reason");

    // Nothing was written: the key is still approved.
    expect(body(keyHistory(k.identity)).keys.find((e: any) => e.fingerprint === k.fingerprint).status)
      .toBe("approved");
  });

  test("revokes with the reason it was given", () => {
    const k = proposed();
    decide("approve", k.fingerprint, "operator-1", null);
    const r = decide("revoke", k.fingerprint, "operator-1", "compromise");
    expect(r.status).toBe(200);
    expect(body(r).status).toBe("revoked");
  });

  /**
   * **404 and 409 answer different questions.** One says the operator has the
   * wrong string; the other says somebody got there first — and an operator
   * acting on a listing that has moved on needs to know which.
   */
  test("tells a wrong fingerprint apart from one already decided", () => {
    const missing = decide("approve", "f".repeat(64), "operator-1", null);
    expect(missing.status).toBe(404);

    const k = proposed();
    decide("approve", k.fingerprint, "operator-1", null);
    const again = decide("approve", k.fingerprint, "operator-2", null);
    expect(again.status).toBe(409);
    expect(body(again).error).toBeTruthy();
  });
});
