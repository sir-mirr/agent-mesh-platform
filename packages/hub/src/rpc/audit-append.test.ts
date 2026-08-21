/**
 * What `mesh.audit.append` and `mesh.audit.prepare_blobs` actually *do*, once
 * a request gets past the refusals `audit.test.ts` beside it covers.
 *
 * That file deliberately stopped at the validation surface, because every
 * refusal returns before touching a store and needs no database. The rest —
 * the duplicate check, the blob verification, the transaction and the ACK —
 * is where the method's promises live, and it read as uncovered for the usual
 * reason: it runs inside the hub, which is another process.
 *
 * **It does not need one.** These are exported functions over this module's own
 * handles, so the run's shared state directory is enough, the way
 * `messages.test.ts` and `receive.test.ts` use it: unique ids, no cleanup,
 * nothing read that this file did not write.
 *
 * Three promises are load-bearing and each has a case here:
 *
 * - **The ACK comes after the commit**, never before — a client told its
 *   outbox entry is safe drops it.
 * - **A retry is safe and a collision is not.** The same bytes under the same
 *   id is the client not hearing the ACK; different bytes under one id is a
 *   defect retrying cannot fix, so it is permanent rather than transient.
 * - **Nothing commits while a referenced blob is absent or the wrong length.**
 *   A file of the right name and the wrong size is an interrupted upload, and
 *   accepting it records truncated bytes as verified.
 *
 * This file owns the `aap-` prefix.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

import { deriveBlobKey } from "@agent-mesh/contracts";

import { auditDb } from "../db";
import { wsIdentities } from "../presence";
import { UPLOAD_DIR, blobPath } from "../blobs";
import { AUDIT_MISSING_BLOBS, handleAuditAppend, handlePrepareBlobs } from "./audit";

let n = 0;
const uniq = (p: string) => `aap-${p}-${++n}-${process.pid}`;

const connected = (identity = uniq("adapter")) => {
  const ws = {};
  wsIdentities.set(ws, identity);
  return { ws, identity };
};

type Answer = {
  result?: Record<string, any>;
  error?: { code: number; message: string; data?: Record<string, any> };
};

/**
 * Call `append` the way the dispatcher does: the parsed params *and* the raw
 * bytes they came in, because § 8.9.3 digests what was received rather than
 * what a re-serialisation would produce.
 */
function append(ws: object, params: Record<string, unknown>, sig: unknown = null): Answer {
  const raw = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "mesh.audit.append", params });
  return JSON.parse(handleAuditAppend(ws, params, 1, raw, sig));
}

const event = (over: Record<string, unknown> = {}): Record<string, any> => ({
  schema_version: 1,
  event_id: uniq("evt"),
  event_type: "app.thing.happened",
  occurred_at: "2027-06-06T00:00:00.000Z",
  ...over,
});

const storedRow = (eventId: string) =>
  auditDb
    .prepare(
      `SELECT event_id, event_type, identity, payload_digest, producer_id, correlation_id, stored_at
         FROM audit_events WHERE event_id = ?`,
    )
    .get(eventId) as Record<string, unknown> | undefined;

const blobRows = (eventId: string) =>
  auditDb.prepare(`SELECT sha256, size, name FROM audit_event_blobs WHERE event_id = ?`).all(eventId) as
    Array<{ sha256: string; size: number; name: string }>;

/** Bytes on disk under the key the contract derives, so the hub can verify them. */
function storedBlob(content: string, name: string) {
  const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
  const blobKey = deriveBlobKey(sha256, name);
  mkdirSync(UPLOAD_DIR, { recursive: true });
  writeFileSync(blobPath(blobKey), content);
  return { sha256, name, size: Buffer.byteLength(content), blobKey };
}

describe("appending an event", () => {
  test("commits it, and answers only afterwards", () => {
    const { ws, identity } = connected();
    const e = event({ correlation_id: uniq("corr"), producer_id: "probe-producer" });
    const answered = append(ws, e);

    expect(answered.error).toBeUndefined();
    expect(answered.result).toMatchObject({
      ok: true, committed: true, duplicate: false, event_id: e.event_id,
      identity, attachments_verified: 0,
    });
    const row = storedRow(e.event_id)!;
    // **The `stored_at` it answers with is the row's.** Read back after the
    // transaction rather than stamped beside it: a client told its outbox
    // entry is safe drops it, so an ACK that predates the commit is how an
    // event is lost with both sides believing it was stored.
    expect(answered.result!.stored_at).toBe(row.stored_at);
    expect(row).toMatchObject({
      event_id: e.event_id,
      event_type: "app.thing.happened",
      producer_id: "probe-producer",
      correlation_id: e.correlation_id,
    });
  });

  /**
   * **The `who` is the hub's own knowledge.** § 8.9.3's record is only worth
   * reading if the identity comes from the connection; an event that states
   * who it is about is an event anyone can write about anyone.
   */
  test("records the connection's identity, not one the payload claims", () => {
    const { ws, identity } = connected();
    const e = event({ identity: "somebody-else", producer_id: "somebody-else" });
    append(ws, e);

    const row = storedRow(e.event_id)!;
    expect(row.identity).toBe(identity);
    // `producer_id` is the client's to state — it says which of its own
    // processes emitted the event — so it is kept as sent, and it is not the
    // field anything authorises against.
    expect(row.producer_id).toBe("somebody-else");
  });

  /** The digest is over the bytes received, not over a re-serialisation. */
  test("records the digest of what arrived", () => {
    const { ws } = connected();
    const e = event();
    append(ws, e);
    const expected = createHash("sha256").update(JSON.stringify(e), "utf8").digest("hex");
    expect(storedRow(e.event_id)!.payload_digest).toBe(expected);
  });

  /**
   * **A retry is the client not hearing the ACK.** Same id, same bytes: the
   * second call answers `duplicate: true` with the original `stored_at`, so
   * the client can drop the outbox entry it was retrying.
   */
  test("answers a retry with the original commit, not a second one", () => {
    const { ws } = connected();
    const e = event();
    const first = append(ws, e);
    const second = append(ws, e);

    expect(second.result).toMatchObject({ ok: true, committed: true, duplicate: true, event_id: e.event_id });
    expect(second.result!.stored_at).toBe(first.result!.stored_at);
    expect(
      (auditDb.prepare(`SELECT count(*) AS n FROM audit_events WHERE event_id = ?`).get(e.event_id) as { n: number }).n,
    ).toBe(1);
  });

  /**
   * **Different bytes under one id is permanent.** Retrying cannot fix a
   * client that reused an event id, and a transient classification would keep
   * it in an outbox forever.
   */
  test("refuses a second event that reuses an id with different bytes", () => {
    const { ws } = connected();
    const e = event();
    append(ws, e);
    const answered = append(ws, { ...e, event_type: "app.something.else" });

    expect(answered.error).toBeDefined();
    expect(answered.error!.data).toMatchObject({ code: "AUDIT_EVENT_CONFLICT", event_id: e.event_id });
    expect(storedRow(e.event_id)!.event_type).toBe("app.thing.happened");
  });

  test("keeps the sender's signature with the event, covering the params it signed", () => {
    const { ws } = connected();
    const e = event();
    append(ws, e, { alg: "ed25519", value: "probe-signature" });
    const att = auditDb
      .prepare(`SELECT attestation FROM audit_events WHERE event_id = ?`)
      .get(e.event_id) as { attestation: string };
    expect(JSON.parse(att.attestation)).toMatchObject({
      covers: "mesh.audit.append.params",
      sig: { alg: "ed25519", value: "probe-signature" },
    });
  });
});

describe("the attachments it will accept", () => {
  test("verifies and records the blobs an event references", () => {
    const { ws } = connected();
    const blob = storedBlob(uniq("bytes"), "notes.txt");
    const e = event({ attachments: [{ sha256: blob.sha256, size: blob.size, name: blob.name }] });

    const answered = append(ws, e);
    expect(answered.result).toMatchObject({ committed: true, attachments_verified: 1 });
    expect(blobRows(e.event_id)).toEqual([{ sha256: blob.sha256, size: blob.size, name: blob.name }]);
    rmSync(blobPath(blob.blobKey), { force: true });
  });

  /**
   * **Transient, and nothing is committed.** The client uploads and retries;
   * a partial repair would leave an event referencing bytes that are not there.
   */
  test("refuses an event whose blob is not on disk, and names which", () => {
    const { ws } = connected();
    const absent = createHash("sha256").update(uniq("never-uploaded"), "utf8").digest("hex");
    const e = event({ attachments: [{ sha256: absent, size: 12, name: "gone.txt" }] });

    const answered = append(ws, e);
    expect(answered.error!.code).toBe(AUDIT_MISSING_BLOBS);
    expect(answered.error!.data).toMatchObject({ code: "AUDIT_MISSING_BLOBS", missing_sha256: [absent] });
    expect(storedRow(e.event_id) ?? null).toBeNull();
  });

  /**
   * **The right name and the wrong length is an interrupted upload.** Treating
   * it as present would record truncated bytes as verified — the one thing the
   * size check is for.
   */
  test("refuses a blob whose stored size is not the declared one", () => {
    const { ws } = connected();
    const blob = storedBlob(uniq("short"), "partial.txt");
    const e = event({ attachments: [{ sha256: blob.sha256, size: blob.size + 100, name: blob.name }] });

    const answered = append(ws, e);
    expect(answered.error!.code).toBe(AUDIT_MISSING_BLOBS);
    expect(storedRow(e.event_id) ?? null).toBeNull();
    rmSync(blobPath(blob.blobKey), { force: true });
  });

  test("refuses an attachment that is not an object, or is missing a field", () => {
    const { ws } = connected();
    for (const attachment of [null, "a string", 7, {}, { sha256: "abc" }, { sha256: "abc", size: 1 }]) {
      const answered = append(ws, event({ attachments: [attachment] }));
      expect(answered.error).toBeDefined();
      expect(answered.error!.message).toMatch(/attachment/);
    }
  });
});

describe("asking where to upload", () => {
  const prepare = (ws: object, blobs: unknown[]): Answer =>
    JSON.parse(handlePrepareBlobs(ws, { event_id: uniq("evt"), blobs }, 1));

  /**
   * **Present only when the stored size matches**, for the same reason the
   * append path checks it: reporting a partial write as present leaves the
   * event referencing truncated bytes.
   */
  test("reports a blob already on disk as present, with no upload grant", () => {
    const { ws } = connected();
    const blob = storedBlob(uniq("already"), "here.txt");
    const answered = prepare(ws, [{ sha256: blob.sha256, size: blob.size, name: blob.name }]);

    expect(answered.result!.blobs).toEqual([
      { sha256: blob.sha256, blob_key: blob.blobKey, status: "present" },
    ]);
    rmSync(blobPath(blob.blobKey), { force: true });
  });

  test("reports one of the wrong length as missing, and grants an upload", () => {
    const { ws } = connected();
    const blob = storedBlob(uniq("truncated"), "partial.txt");
    const answered = prepare(ws, [{ sha256: blob.sha256, size: blob.size + 50, name: blob.name }]);

    const [only] = answered.result!.blobs;
    expect(only).toMatchObject({ sha256: blob.sha256, blob_key: blob.blobKey, status: "missing" });
    expect(only.upload).toMatchObject({ method: "PUT" });
    expect(only.upload.url).toContain(blob.blobKey);
    expect(only.upload.nonce).toBeTruthy();
    expect(only.upload.expires_at).toBeTruthy();
    rmSync(blobPath(blob.blobKey), { force: true });
  });

  /** The key keeps the extension (§ 15.2), so the name is part of where it lands. */
  test("grants an upload for one nobody has sent, keyed by digest and name", () => {
    const { ws } = connected();
    const sha256 = createHash("sha256").update(uniq("unsent"), "utf8").digest("hex");
    const answered = prepare(ws, [{ sha256, size: 10, name: "report.pdf" }]);

    const [only] = answered.result!.blobs;
    expect(only.status).toBe("missing");
    expect(only.blob_key).toBe(deriveBlobKey(sha256, "report.pdf"));
    expect(only.blob_key.endsWith(".pdf")).toBe(true);
  });
});
