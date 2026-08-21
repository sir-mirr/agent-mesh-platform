/**
 * Upload grants (SPEC § 8.9.2, § 9.1), which nothing had exercised.
 *
 * `nonces.ts` read 9.30%. It is a table rather than memory because the two ends
 * are different processes — `mesh.audit.prepare_blobs` on the hub issues a
 * grant, `agent-mesh-http` checks it when the bytes arrive — and that split is
 * exactly why no single suite had ever run both halves.
 *
 * The half worth asserting is `checkGrant`. Every bound field is compared
 * rather than trusted from the request, because the request is what is being
 * authorised: a grant for one key must not authorise a write to another, or an
 * upload could be redirected over an unrelated blob. Five refusals say so, and
 * each is its own reason so the http side can answer differently.
 *
 * Its own database in its own directory. Nothing here touches a handle another
 * module holds open.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as agentsSchema from "./schema/agents";
import { checkGrant, issueGrant, sweepExpired } from "./nonces";
import { openAt } from "./open";

const dir = mkdtempSync(join(tmpdir(), "upload-grants-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
function fresh() {
  const db = openAt(join(dir, `g-${++n}.db`), { create: true });
  agentsSchema.migrate(db);
  return db;
}

const SHA = "a".repeat(64);
const grantFor = (db: ReturnType<typeof fresh>, identity = "uploader", key = "blob/one.png", size = 12) =>
  issueGrant(db, identity, key, SHA, size);

/** Push a grant's expiry into the past without waiting for it. */
const expire = (db: ReturnType<typeof fresh>, nonce: string) =>
  db.prepare(`UPDATE upload_nonces SET expires_at = datetime('now', '-1 hour') WHERE nonce = ?`).run(nonce);

describe("issuing a grant", () => {
  test("returns the binding, and an expiry a client can compare", () => {
    const db = fresh();
    const g = grantFor(db);
    expect(g.identity).toBe("uploader");
    expect(g.blob_key).toBe("blob/one.png");
    expect(g.size).toBe(12);
    expect(g.sha256).toBe(SHA);
    // Rendered rather than handed over as SQLite's own format: a client parses
    // this, and `YYYY-MM-DD HH:MM:SS` is not a date in a browser.
    expect(g.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(Date.parse(g.expires_at)).toBeGreaterThan(Date.now() - 60_000);
  });

  test("and a fresh nonce each time, for the same blob", () => {
    const db = fresh();
    expect(grantFor(db).nonce).not.toBe(grantFor(db).nonce);
  });
});

describe("checking a grant against the upload that presents it", () => {
  test("accepts the upload it was issued for", () => {
    const db = fresh();
    const g = grantFor(db);
    const r = checkGrant(db, g.nonce, "uploader", "blob/one.png", 12);
    expect(r.ok).toBe(true);
    expect(r.ok === true && r.grant.sha256).toBe(SHA);
  });

  /**
   * **Not single-use, on purpose.** A grant is bound to `(identity, blob_key,
   * size)` and the signature over it also covers the digest, so replaying one
   * authorises writing identical bytes to an identical key — which deduplicates
   * to no effect. Single-use would buy nothing and would break the retry of an
   * upload that failed midway, which is the case this path actually meets.
   */
  test("and accepts it again, because retrying a half-finished upload is the case", () => {
    const db = fresh();
    const g = grantFor(db);
    expect(checkGrant(db, g.nonce, "uploader", "blob/one.png", 12).ok).toBe(true);
    expect(checkGrant(db, g.nonce, "uploader", "blob/one.png", 12).ok).toBe(true);
  });

  test("a nonce that was never issued", () => {
    const db = fresh();
    const r = checkGrant(db, "no-such-nonce", "uploader", "blob/one.png", 12);
    expect(r.ok === false && r.reason).toBe("unknown");
  });

  test("a grant whose window has passed", () => {
    const db = fresh();
    const g = grantFor(db);
    expire(db, g.nonce);
    const r = checkGrant(db, g.nonce, "uploader", "blob/one.png", 12);
    expect(r.ok === false && r.reason).toBe("expired");
  });

  /**
   * The three bindings, each on its own. They are separate reasons rather than
   * one refusal because the http side answers differently — and because a
   * single "invalid grant" would hide which of them an operator is looking at.
   */
  test("another identity presenting it", () => {
    const db = fresh();
    const g = grantFor(db);
    const r = checkGrant(db, g.nonce, "someone-else", "blob/one.png", 12);
    expect(r.ok === false && r.reason).toBe("wrong-identity");
  });

  test("a write aimed at a different key", () => {
    const db = fresh();
    const g = grantFor(db);
    const r = checkGrant(db, g.nonce, "uploader", "blob/other.png", 12);
    expect(r.ok === false && r.reason).toBe("wrong-blob");
  });

  test("a body that is not the length the grant was issued for", () => {
    const db = fresh();
    const g = grantFor(db);
    const r = checkGrant(db, g.nonce, "uploader", "blob/one.png", 13);
    expect(r.ok === false && r.reason).toBe("wrong-size");
  });

  /** Expiry is checked before the bindings: a stale grant is stale whoever holds it. */
  test("and an expired grant is expired before it is anyone's", () => {
    const db = fresh();
    const g = grantFor(db);
    expire(db, g.nonce);
    const r = checkGrant(db, g.nonce, "someone-else", "blob/other.png", 99);
    expect(r.ok === false && r.reason).toBe("expired");
  });
});

describe("sweeping", () => {
  /**
   * Not on the upload path: an expired row is already refused by the check, so
   * sweeping there would make every upload pay for the whole table to reclaim
   * space nothing is reading.
   */
  test("removes what has expired, counts it, and leaves what has not", () => {
    const db = fresh();
    const live = grantFor(db, "uploader", "blob/live.png");
    const dead = grantFor(db, "uploader", "blob/dead.png");
    expire(db, dead.nonce);

    expect(sweepExpired(db)).toBe(1);
    expect(checkGrant(db, dead.nonce, "uploader", "blob/dead.png", 12).ok === false
      && (checkGrant(db, dead.nonce, "uploader", "blob/dead.png", 12) as any).reason).toBe("unknown");
    expect(checkGrant(db, live.nonce, "uploader", "blob/live.png", 12).ok).toBe(true);
  });

  test("and reports zero when there is nothing to drop", () => {
    const db = fresh();
    grantFor(db);
    expect(sweepExpired(db)).toBe(0);
  });
});
