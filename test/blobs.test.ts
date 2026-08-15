/**
 * Step 4 — upload authorisation (SPEC § 8.9.2, § 9.1).
 *
 * The assertions that matter are about what does NOT end up on disk. A
 * mismatched or truncated upload must leave nothing under a real key: a short
 * blob satisfies an existence check, so it would be referenced by an event as
 * present and corrupt it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, sign as edSign } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  deriveBlobKey, formatUploadAuthorization, uploadSignaturePreimage,
} from "@agent-mesh/contracts";

import {
  connectRpc, loginAsAdmin, newKeyPair, provision, startMesh,
  type KeyPair, type Mesh, type RpcClient,
} from "./harness";

let mesh: Mesh;
let kp: KeyPair;
let rpc: RpcClient;

const IDENTITY = "blob-agent";

beforeAll(async () => {
  mesh = await startMesh();
  const cookie = await loginAsAdmin(mesh.http);
  kp = newKeyPair();
  await provision(mesh.hub, IDENTITY, "ai-codex", null, kp.publicKey);
  await fetch(`${mesh.http.url}/api/v1/admin/keys/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ fingerprint: kp.fingerprint }),
  });
  rpc = await connectRpc(mesh.hub, { kid: kp.fingerprint, privateKey: kp.privateKey });
  await rpc.call("mesh.connect", { identity: IDENTITY });
});

afterAll(() => {
  rpc?.close();
  mesh?.stop();
});

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(Buffer.from(bytes)).digest("hex");

const uploadsDir = () => join(mesh.stateDir, "uploads");
const listUploads = () => (existsSync(uploadsDir()) ? readdirSync(uploadsDir()) : []);

async function prepare(bytes: Uint8Array, name: string) {
  const res = await rpc.call("mesh.audit.prepare_blobs", {
    event_id: "evt-1",
    blobs: [{ sha256: sha256(bytes), size: bytes.length, name }],
  });
  return res.result?.blobs?.[0] ?? res;
}

/**
 * Sign an upload.
 *
 * `blobKey` is passed explicitly rather than read off the grant: the key lives
 * on the prepare_blobs entry, not inside its `upload` member, and signing
 * `undefined` produces a valid signature over the wrong preimage — which the
 * server reports as "bad signature" with no hint that the caller assembled it
 * from the wrong field.
 */
function authHeader(
  nonce: string,
  blobKey: string,
  digest: string,
  size: number,
  key: KeyPair = kp,
): string {
  const signature = Buffer.from(
    edSign(
      null,
      Buffer.from(uploadSignaturePreimage({ nonce, blobKey, sha256: digest, size })),
      key.privateKey,
    ),
  ).toString("base64url");
  return formatUploadAuthorization({ kid: key.fingerprint, nonce, signature });
}

/**
 * Upload to the URL `prepare_blobs` returned, rather than to one this test
 * assembled.
 *
 * Every earlier version built the URL from `mesh.http.url`, which is how a
 * relative `url` in the response went unnoticed for a whole step: the tests
 * knew where the route was and the client did not, so they agreed with the hub
 * about everything except the one field the client actually follows.
 */
const putTo = (url: string, body: Uint8Array, headers: Record<string, string>) =>
  fetch(url, {
    method: "PUT",
    body: body.slice().buffer as ArrayBuffer,
    headers,
  });

const put = (blobKey: string, body: Uint8Array, headers: Record<string, string>) =>
  fetch(`${mesh.http.url}/api/v1/audit/blobs/${blobKey}`, {
    method: "PUT",
    // Sliced into its own ArrayBuffer: a Uint8Array view over a larger buffer
    // does not satisfy BodyInit, and the DOM lib's overloads pick
    // URLSearchParams for the union, which is not the error it looks like.
    body: body.slice().buffer as ArrayBuffer,
    headers,
  });

describe("prepare_blobs", () => {
  test("derives the key, retains the extension, and issues a grant", async () => {
    const bytes = new TextEncoder().encode("hello blob");
    const b = await prepare(bytes, "notes.TXT");
    expect(b.status).toBe("missing");
    // § 15.2: the key is <sha256>[.<ext>], lowercased — sha256 alone does not
    // determine where the bytes land, which is why `name` is required.
    expect(b.blob_key).toBe(deriveBlobKey(sha256(bytes), "notes.TXT"));
    expect(b.blob_key.endsWith(".txt")).toBe(true);
    expect(b.upload.nonce).toBeTruthy();
    expect(b.upload.method).toBe("PUT");
  });

  test("refuses a blob over the size limit before anything is issued", async () => {
    const res = await rpc.call("mesh.audit.prepare_blobs", {
      event_id: "evt-big",
      blobs: [{ sha256: "a".repeat(64), size: 200 * 1024 * 1024, name: "big.bin" }],
    });
    expect(res.error).toMatchObject({ code: -32602 });
    expect(res.error.message).toContain("max_blob_bytes");
  });

  test("requires name, because the key is not the digest alone", async () => {
    const res = await rpc.call("mesh.audit.prepare_blobs", {
      event_id: "evt-noname",
      blobs: [{ sha256: "b".repeat(64), size: 1 }],
    });
    expect(res.error).toMatchObject({ code: -32602 });
    expect(res.error.message).toContain("name is required");
  });
});

describe("the upload URL", () => {
  test("is absolute, and points at the service that serves the route", async () => {
    // The hub answers this; the route is on the http server, on another port. A
    // relative URL is resolved against whatever origin the client was talking
    // to — the hub — and 404s there.
    const bytes = new TextEncoder().encode("absolute url");
    const grant = await prepare(bytes, "url.txt");
    expect(grant.upload.url.startsWith("http")).toBe(true);
    expect(new URL(grant.upload.url).port).toBe(String(new URL(mesh.http.url).port));
    expect(new URL(grant.upload.url).port).not.toBe(String(new URL(mesh.hub.url).port));
  });

  test("following it verbatim works", async () => {
    // What a client actually does, and what no test did until the client
    // reported a 404 against a URL the hub had handed it.
    const bytes = new TextEncoder().encode("followed verbatim");
    const digest = sha256(bytes);
    const grant = await prepare(bytes, "follow.bin");
    const res = await putTo(grant.upload.url, bytes, {
      authorization: authHeader(grant.upload.nonce, grant.blob_key, digest, bytes.length),
    });
    expect(res.status).toBe(201);
  });
});

describe("a legitimate upload", () => {
  test("stores the bytes and reports the digest", async () => {
    const bytes = new TextEncoder().encode("the quick brown fox");
    const digest = sha256(bytes);
    const grant = await prepare(bytes, "fox.txt");

    const res = await put(grant.blob_key, bytes, {
      authorization: authHeader(grant.upload.nonce, grant.blob_key, digest, bytes.length),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ok: true, sha256: digest, size: bytes.length });
    expect(existsSync(join(uploadsDir(), grant.blob_key))).toBe(true);
  });

  test("re-uploading the same key deduplicates rather than conflicting", async () => {
    // Content-addressed, so the same key is the same bytes. This is what makes
    // retrying after an ambiguous failure safe.
    const bytes = new TextEncoder().encode("idempotent");
    const digest = sha256(bytes);
    const grant = await prepare(bytes, "dup.bin");
    const headers = {
      authorization: authHeader(grant.upload.nonce, grant.blob_key, digest, bytes.length),
    };
    expect((await put(grant.blob_key, bytes, headers)).status).toBe(201);
    const again = await put(grant.blob_key, bytes, headers);
    expect(again.status).toBe(200);
    expect((await again.json()).deduplicated).toBe(true);
  });

  test("a blob already held is reported present, with no grant issued", async () => {
    const bytes = new TextEncoder().encode("already here");
    const digest = sha256(bytes);
    const first = await prepare(bytes, "present.txt");
    await put(first.blob_key, bytes, {
      authorization: authHeader(first.upload.nonce, first.blob_key, digest, bytes.length),
    });

    const second = await prepare(bytes, "present.txt");
    expect(second.status).toBe("present");
    expect(second.upload).toBeUndefined();
  });
});

describe("what must not reach disk", () => {
  test("a digest mismatch is refused and leaves nothing behind", async () => {
    const authorised = new TextEncoder().encode("what was authorised");
    const sent = new TextEncoder().encode("something else ....");
    expect(sent.length).toBe(authorised.length); // same length, different bytes

    const grant = await prepare(authorised, "swap.bin");
    const before = listUploads();
    const res = await put(grant.blob_key, sent, {
      authorization: authHeader(grant.upload.nonce, grant.blob_key, sha256(authorised), authorised.length),
    });

    expect(res.status).toBe(422);
    expect(existsSync(join(uploadsDir(), grant.blob_key))).toBe(false);
    // Not even a temp file: a leftover .part would accumulate silently.
    expect(listUploads()).toEqual(before);
  });

  test("a body of a different length is refused before any byte is written", async () => {
    // The grant binds the size, so an upload of the wrong length is refused at
    // the grant check — before the stream is read at all. A short blob would
    // otherwise satisfy an existence check and be referenced by an event as
    // present, which is the failure this ordering exists to prevent.
    const bytes = new TextEncoder().encode("0123456789");
    const grant = await prepare(bytes, "short.bin");
    const before = listUploads();

    const res = await put(grant.blob_key, bytes.slice(0, 4), {
      authorization: authHeader(grant.upload.nonce, grant.blob_key, sha256(bytes), bytes.length),
    });

    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("wrong-size");
    expect(existsSync(join(uploadsDir(), grant.blob_key))).toBe(false);
    // Not even a temp file: a leftover .part would accumulate unnoticed.
    expect(listUploads()).toEqual(before);
  });
});

describe("authorisation", () => {
  test("no Authorization header is refused", async () => {
    const bytes = new TextEncoder().encode("unauthorised");
    const grant = await prepare(bytes, "noauth.bin");
    const res = await put(grant.blob_key, bytes, {});
    expect(res.status).toBe(401);
  });

  test("a grant for one key does not authorise another", async () => {
    // The signature covers blob_key, so a grant cannot be redirected to
    // overwrite an unrelated blob.
    const a = new TextEncoder().encode("blob a");
    const b = new TextEncoder().encode("blob b");
    const grantA = await prepare(a, "a.bin");
    const grantB = await prepare(b, "b.bin");

    const res = await put(grantB.blob_key, b, {
      // Signed for grant A's key, sent to grant B's — the signature covers
      // blob_key, so a grant cannot be redirected to overwrite another blob.
      authorization: authHeader(grantA.upload.nonce, grantA.blob_key, sha256(b), b.length),
    });
    expect(res.status).toBe(403);
    expect(existsSync(join(uploadsDir(), grantB.blob_key))).toBe(false);
  });

  test("an unknown nonce is refused", async () => {
    const bytes = new TextEncoder().encode("no grant");
    const grant = await prepare(bytes, "nogrant.bin");
    const res = await put(grant.blob_key, bytes, {
      authorization: authHeader(
        "00000000-0000-0000-0000-000000000000", grant.blob_key, sha256(bytes), bytes.length,
      ),
    });
    expect(res.status).toBe(403);
  });

  test("another identity's key cannot sign for this grant", async () => {
    // The identity comes from the grant, not the request, so a stolen nonce is
    // useless without the key it was issued to.
    const other = newKeyPair();
    await provision(mesh.hub, "blob-impostor", "ai-codex", null, other.publicKey);
    const bytes = new TextEncoder().encode("not yours");
    const grant = await prepare(bytes, "stolen.bin");

    const res = await put(grant.blob_key, bytes, {
      authorization: authHeader(grant.upload.nonce, grant.blob_key, sha256(bytes), bytes.length, other),
    });
    expect(res.status).toBe(403);
    expect(existsSync(join(uploadsDir(), grant.blob_key))).toBe(false);
  });
});

describe("size", () => {
  test("a large upload completes without the process holding the file", async () => {
    // 8 MiB is enough to exercise the streaming path. The point of the route is
    // that memory does not track file size — POST /api/v1/upload buffers whole
    // bodies, which is why this could not reuse it.
    const bytes = new Uint8Array(8 * 1024 * 1024);
    for (let i = 0; i < bytes.length; i += 4096) bytes[i] = i % 251;
    const digest = sha256(bytes);
    const grant = await prepare(bytes, "large.bin");

    const before = process.memoryUsage().heapUsed;
    const res = await put(grant.blob_key, bytes, {
      authorization: authHeader(grant.upload.nonce, grant.blob_key, digest, bytes.length),
    });
    const growth = process.memoryUsage().heapUsed - before;

    expect(res.status).toBe(201);
    expect((await res.json()).sha256).toBe(digest);
    // The test process holds the body it sent; what must not happen is the
    // *server* holding another copy. Asserted loosely — this is a smoke check,
    // not a memory benchmark.
    expect(growth).toBeLessThan(bytes.length * 4);
  });
});


/**
 * § 15.6 — orphan collection.
 *
 * The only collectable blob is one no event ever referenced, because audit
 * retention is indefinite and references are never released. The grace period
 * is a correctness condition rather than a tuning knob: § 8.9 uploads bytes
 * before the event that references them, so "no reference" is the normal state
 * for as long as the client takes to append.
 */
describe("orphan collection", () => {
  const collect = async (extra: string[] = []) => {
    const proc = Bun.spawn(
      ["bun", "scripts/collect-orphan-blobs.ts", ...extra],
      { cwd: process.cwd(), env: { ...process.env, AGENT_MESH_STATE_DIR: mesh.stateDir }, stdout: "pipe", stderr: "pipe" },
    );
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    await proc.exited;
    return { out, err, code: proc.exitCode };
  };

  test("leaves a referenced blob alone whatever its age", async () => {
    const bytes = new TextEncoder().encode("referenced forever");
    const digest = sha256(bytes);
    const grant = await prepare(bytes, "keep.txt");
    await putTo(grant.upload.url, bytes, {
      authorization: authHeader(grant.upload.nonce, grant.blob_key, digest, bytes.length),
    });
    const appended = await rpc.call("mesh.audit.append", {
      schema_version: 1, event_id: `evt_keep_${Math.random().toString(36).slice(2)}`,
      event_type: "channel.message.received", occurred_at: new Date().toISOString(),
      attachments: [{ sha256: digest, size: bytes.length, name: "keep.txt" }],
    });
    // Asserted, because a failed append would make the next assertion pass for
    // the wrong reason — an unreferenced blob is collectable, correctly.
    expect(appended.result?.attachments_verified).toBe(1);

    // Grace 0, so age cannot be the reason it survives — only the reference.
    const { code } = await collect(["--grace-hours", "0"]);
    expect(code).toBe(0);
    expect(existsSync(join(uploadsDir(), grant.blob_key))).toBe(true);
  });

  test("leaves an unreferenced blob inside the grace period", async () => {
    // The normal state of an upload whose append has not arrived. Removing it
    // would surface to the client as -32040 for bytes it knows it sent.
    const bytes = new TextEncoder().encode("just uploaded");
    const digest = sha256(bytes);
    const grant = await prepare(bytes, "young.bin");
    await putTo(grant.upload.url, bytes, {
      authorization: authHeader(grant.upload.nonce, grant.blob_key, digest, bytes.length),
    });

    await collect();
    expect(existsSync(join(uploadsDir(), grant.blob_key))).toBe(true);
  });

  test("removes an unreferenced blob past the grace period", async () => {
    const bytes = new TextEncoder().encode("nobody committed me");
    const digest = sha256(bytes);
    const grant = await prepare(bytes, "orphan.bin");
    await putTo(grant.upload.url, bytes, {
      authorization: authHeader(grant.upload.nonce, grant.blob_key, digest, bytes.length),
    });

    const { out, code } = await collect(["--grace-hours", "0"]);
    expect(code).toBe(0);
    expect(existsSync(join(uploadsDir(), grant.blob_key))).toBe(false);
    expect(out).toContain("removed");
  });

  test("--dry-run reports without removing", async () => {
    const bytes = new TextEncoder().encode("dry run subject");
    const digest = sha256(bytes);
    const grant = await prepare(bytes, "dry.bin");
    await putTo(grant.upload.url, bytes, {
      authorization: authHeader(grant.upload.nonce, grant.blob_key, digest, bytes.length),
    });

    const { out } = await collect(["--dry-run", "--grace-hours", "0"]);
    expect(out).toContain("would remove");
    expect(existsSync(join(uploadsDir(), grant.blob_key))).toBe(true);
  });

  test("is idempotent — a second run finds nothing left", async () => {
    // § 15.6 requires it, because this runs on a timer and a failed run is
    // retried by the next one rather than by anything cleverer.
    const first = await collect(["--grace-hours", "0"]);
    const second = await collect(["--grace-hours", "0"]);
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(second.out).toContain("removed 0");
  });
});

/**
 * Last on purpose. This is the only case where the server answers while the
 * client is still sending, which leaves the HTTP connection out of step — a
 * following request on it reads the tail of this one and fails for reasons that
 * have nothing to do with what it was testing. Keeping it at the end means no
 * other test pays for that.
 */
describe("a rejection mid-body", () => {
  test("Content-Length is required", async () => {
    const bytes = new TextEncoder().encode("no length");
    const grant = await prepare(bytes, "nolen.bin");
    const res = await fetch(`${mesh.http.url}/api/v1/audit/blobs/${grant.blob_key}`, {
      method: "PUT",
      headers: { authorization: authHeader(grant.upload.nonce, grant.blob_key, sha256(bytes), bytes.length) },
      body: new ReadableStream({
        start(controller) { controller.enqueue(bytes); controller.close(); },
      }),
      // @ts-expect-error — Bun requires this for a streaming body
      duplex: "half",
    });
    expect(res.status).toBe(411);
  });
});
