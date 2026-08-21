/**
 * The other end of an upload grant (SPEC § 8.9.2, § 9.1).
 *
 * `packages/store/src/nonces.ts` issues one and now says what `checkGrant`
 * refuses. This is what consumes it, and it read 13.93% — so the grant was
 * measured where it is written and not where it is spent, which is half a
 * contract.
 *
 * **`identity` is never taken from the request.** It comes from the grant the
 * nonce resolves to, and the signature is verified against *that* identity's
 * approved key — so a caller cannot name an identity it holds no key for, and a
 * stolen nonce is useless without the key it was issued to. Both halves are
 * asserted below, because either alone would look like authentication.
 *
 * In this process, against the run's shared state directory. Every blob key is
 * a fresh digest, so nothing here depends on what `<stateDir>/uploads` already
 * holds.
 */
import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, randomUUID, sign as edSign } from "node:crypto";

import { formatUploadAuthorization, uploadSignaturePreimage } from "@agent-mesh/contracts";
import { STORE_FILES, agentsSchema, keys, nonces, openAt, stateDir } from "@agent-mesh/store";
import { join } from "node:path";

import { MAX_BLOB_BYTES, putBlob } from "./audit-blobs";

/**
 * The same file `audit-blobs.ts` opens, opened here as well.
 *
 * It opens with `create: false` — the store belongs to another process and a
 * blob upload has no business bringing one into existence. That makes the file
 * a precondition rather than a side effect, so this test creates and migrates
 * it rather than depending on whichever suite happened to run first: bun orders
 * a directory's files by name, and `audit-blobs.test.ts` sorts before
 * `main.in-process.test.ts`, which is what used to create it.
 */
const AGENTS = join(stateDir(), STORE_FILES.agents);
const db = openAt(AGENTS, { create: true });
agentsSchema.migrate(db);
const agentsDb = () => db;

let n = 0;
const nextId = (p: string) => `blob-${p}-${++n}-${process.pid}`;

/** An identity that must sign, holding an approved key. */
function signer() {
  const type = "in-process-blob-signing";
  const db = agentsDb();
  db.prepare(`INSERT OR IGNORE INTO agent_types (type, requires_key) VALUES (?, 1)`).run(type);
  const identity = nextId("uploader");
  db.prepare(`INSERT OR IGNORE INTO agents (identity, type) VALUES (?, ?)`).run(identity, type);

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const raw = Buffer.from(der.subarray(der.length - 32)).toString("base64url");
  const { fingerprint } = keys.proposeKey(db, identity, raw, "in-process-test");
  keys.approveKey(db, fingerprint, "in-process-test");
  return { identity, privateKey, fingerprint };
}

/** Bytes, their digest, and the key they belong under. */
function payload(text: string) {
  const bytes = Buffer.from(text, "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { bytes, sha256, blobKey: `${sha256}.txt`, size: bytes.length };
}

const grantFor = (who: ReturnType<typeof signer>, p: ReturnType<typeof payload>) =>
  nonces.issueGrant(agentsDb(), who.identity, p.blobKey, p.sha256, p.size);

/** A request built the way an uploading client must build one. */
function request(
  who: ReturnType<typeof signer> | null,
  grantNonce: string,
  p: ReturnType<typeof payload>,
  over: { body?: BodyInit | null; contentLength?: string | null; header?: string | null; sign?: Partial<{ nonce: string; blobKey: string; sha256: string; size: number }> } = {},
) {
  const headers = new Headers();
  const declared = over.contentLength === undefined ? String(p.size) : over.contentLength;
  if (declared !== null) headers.set("content-length", declared);
  if (over.header !== undefined) {
    if (over.header !== null) headers.set("authorization", over.header);
  } else if (who) {
    const signed = {
      nonce: over.sign?.nonce ?? grantNonce,
      blobKey: over.sign?.blobKey ?? p.blobKey,
      sha256: over.sign?.sha256 ?? p.sha256,
      size: over.sign?.size ?? p.size,
    };
    headers.set(
      "authorization",
      formatUploadAuthorization({
        kid: who.fingerprint,
        nonce: grantNonce,
        signature: edSign(null, Buffer.from(uploadSignaturePreimage(signed)), who.privateKey).toString("base64url"),
      }),
    );
  }
  const body = over.body === undefined ? new Blob([p.bytes as any]) : over.body;
  return new Request("http://blob-host/api/v1/audit/blobs/key", { method: "PUT", headers, ...(body ? { body } : {}) });
}

describe("what an upload is refused for, before any byte is kept", () => {
  test("a key that is not a digest", async () => {
    const p = payload("x");
    for (const key of ["not-a-key", "../escape", "a".repeat(63), `${"a".repeat(64)}.this-extension-is-far-too-long`]) {
      const r = await putBlob(key, request(null, "n", p, { header: null }));
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("invalid blob key");
    }
  });

  test("no authorization at all", async () => {
    const p = payload("x");
    const r = await putBlob(p.blobKey, request(null, "n", p, { header: null }));
    expect(r.status).toBe(401);
    expect(String(r.body.error)).toContain("missing");
  });

  test("an authorization in some other scheme", async () => {
    const p = payload("x");
    for (const header of ["Bearer abc", "AgentMeshSig kid=\"k\"", "AgentMeshSignope"]) {
      const r = await putBlob(p.blobKey, request(null, "n", p, { header }));
      expect(r.status).toBe(401);
      expect(String(r.body.error)).toContain("scheme");
    }
  });

  /**
   * Required and matched, not advisory. Without a declared length the size
   * bound could only be enforced by counting bytes as they arrive, which means
   * accepting an unbounded stream before deciding to reject it.
   */
  test("no Content-Length", async () => {
    const p = payload("x");
    const who = signer();
    const g = grantFor(who, p);
    const r = await putBlob(p.blobKey, request(who, g.nonce, p, { contentLength: null }));
    expect(r.status).toBe(411);
  });

  test("a Content-Length that is not a non-negative integer", async () => {
    const p = payload("x");
    const who = signer();
    const g = grantFor(who, p);
    for (const declared of ["-1", "1.5", "many"]) {
      const r = await putBlob(p.blobKey, request(who, g.nonce, p, { contentLength: declared }));
      expect(r.status).toBe(400);
      expect(String(r.body.error)).toContain("non-negative integer");
    }
  });

  test("a declared length over the blob ceiling", async () => {
    const p = payload("x");
    const who = signer();
    const g = grantFor(who, p);
    const r = await putBlob(p.blobKey, request(who, g.nonce, p, { contentLength: String(MAX_BLOB_BYTES + 1) }));
    expect(r.status).toBe(413);
    expect(String(r.body.error)).toContain(String(MAX_BLOB_BYTES));
  });

  test("a nonce no grant was ever issued for", async () => {
    const p = payload("x");
    const who = signer();
    const r = await putBlob(p.blobKey, request(who, randomUUID(), p));
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("unknown or expired upload grant");
  });
});

describe("a grant that does not authorise this upload", () => {
  /**
   * The refusal is one sentence for every mismatch. Naming which bound field
   * disagreed would let a caller holding a nonce probe what it was issued for —
   * key, size, or holder — one request at a time.
   */
  test("a key the grant was not issued for", async () => {
    const mine = payload("mine");
    const theirs = payload("theirs");
    const who = signer();
    const g = grantFor(who, mine);
    const r = await putBlob(theirs.blobKey, request(who, g.nonce, theirs));
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("upload grant does not authorise this upload");
  });

  test("a length the grant was not issued for", async () => {
    const p = payload("exactly this");
    const who = signer();
    const g = grantFor(who, p);
    const r = await putBlob(p.blobKey, request(who, g.nonce, p, { contentLength: String(p.size + 1) }));
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("upload grant does not authorise this upload");
  });

  test("and a grant whose window has passed", async () => {
    const p = payload("stale");
    const who = signer();
    const g = grantFor(who, p);
    agentsDb().prepare(`UPDATE upload_nonces SET expires_at = datetime('now','-1 hour') WHERE nonce = ?`).run(g.nonce);
    const r = await putBlob(p.blobKey, request(who, g.nonce, p));
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("upload grant does not authorise this upload");
  });
});

describe("the signature, checked against the grant's identity rather than the request's", () => {
  /**
   * A stolen nonce is useless without the key it was issued to. The caller here
   * holds the grant's nonce and signs with a key of its own; the verification
   * reaches for the *grant holder's* approved key and refuses.
   */
  test("someone else's key over the right grant", async () => {
    const p = payload("not yours");
    const owner = signer();
    const thief = signer();
    const g = grantFor(owner, p);
    const r = await putBlob(p.blobKey, request(thief, g.nonce, p));
    expect(r.status).toBe(403);
    expect(String(r.body.error)).toContain("signature does not verify");
  });

  /** Signed over values other than the ones the grant binds. */
  test("a signature over a different size than the grant authorised", async () => {
    const p = payload("bound");
    const who = signer();
    const g = grantFor(who, p);
    const r = await putBlob(p.blobKey, request(who, g.nonce, p, { sign: { size: p.size + 1 } }));
    expect(r.status).toBe(403);
    expect(String(r.body.error)).toContain("signature does not verify");
  });
});

describe("what it does with bytes it accepts", () => {
  test("stores them and answers with the digest it computed", async () => {
    const p = payload(`stored ${nextId("body")}`);
    const who = signer();
    const g = grantFor(who, p);
    const r = await putBlob(p.blobKey, request(who, g.nonce, p));
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ ok: true, blob_key: p.blobKey, size: p.size, sha256: p.sha256 });
  });

  /**
   * Content-addressed: the same key is the same bytes, so an existing blob of
   * the right length is success rather than a conflict. That is what makes a
   * retry after an ambiguous failure safe, and it is why a grant is not
   * single-use.
   */
  test("and answers a second upload of the same blob as deduplicated", async () => {
    const p = payload(`twice ${nextId("body")}`);
    const who = signer();
    const first = grantFor(who, p);
    expect((await putBlob(p.blobKey, request(who, first.nonce, p))).status).toBe(201);

    const again = await putBlob(p.blobKey, request(who, first.nonce, p));
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ok: true, blob_key: p.blobKey, deduplicated: true });
  });

  /**
   * Counted as it arrives as well as against `Content-Length`: a sender may
   * declare one length and send another, and the declaration is the part that
   * is easy to get right by accident.
   */
  test("refuses a body longer than the declaration it was authorised on", async () => {
    const p = payload(`short ${nextId("body")}`);
    const who = signer();
    const g = grantFor(who, p);
    const longer = Buffer.concat([p.bytes, Buffer.from("extra")]);
    const r = await putBlob(p.blobKey, request(who, g.nonce, p, { body: new Blob([longer as any]) }));
    expect(r.status).toBe(413);
    expect(String(r.body.error)).toContain("authorised");
  });

  test("refuses a body shorter than the declaration", async () => {
    const p = payload(`padded ${nextId("body")}`);
    const who = signer();
    const g = grantFor(who, p);
    const r = await putBlob(p.blobKey, request(who, g.nonce, p, { body: new Blob([p.bytes.subarray(0, 2) as any]) }));
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toContain("expected");
  });

  /**
   * The temp file goes, so a mismatched upload never becomes a blob an event
   * could later reference as present. The rename is the last thing that
   * happens, and only once the digest matches.
   */
  test("refuses bytes whose digest is not the one the grant authorised", async () => {
    const p = payload(`honest ${nextId("body")}`);
    const who = signer();
    const g = grantFor(who, p);
    const other = Buffer.alloc(p.size, 0x41);
    const r = await putBlob(p.blobKey, request(who, g.nonce, p, { body: new Blob([other as any]) }));
    expect(r.status).toBe(422);
    expect(String(r.body.error)).toContain("digest mismatch");

    // And nothing is left behind under the key it was aiming at.
    const retry = await putBlob(p.blobKey, request(who, g.nonce, p));
    expect(retry.status).toBe(201);
  });
});
