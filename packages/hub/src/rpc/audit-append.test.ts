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
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { deriveBlobKey } from "@agent-mesh/contracts";

import { auditDb } from "../db";
import { wsIdentities } from "../presence";
import { UPLOAD_DIR, blobPath } from "../blobs";
import {
  AUDIT_BUSY,
  AUDIT_MISSING_BLOBS,
  AUDIT_STORAGE_EXHAUSTED,
  handleAuditAppend,
  handlePrepareBlobs,
  recordDelivered,
  recordIdentityEvent,
  recordRecalled,
} from "./audit";

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
    // **And the equality above cannot see the defect.** The column's default
    // is `strftime('%Y-%m-%dT%H:%M:%fZ','now')` and a stamp beside it would be
    // `new Date().toISOString()` — the same format, and equal whenever both
    // land in one millisecond, which on this path they always do. A mutation
    // replacing the read-back with a fresh stamp passed here, twice, with the
    // comment above still explaining why it could not. So where the answer
    // comes from is read out of the source: the row, selected by id, after the
    // transaction.
    const source = readFileSync(join(import.meta.dir, "audit.ts"), "utf8");
    const readBack = /const stored = ([^\n]*)\n/.exec(source)?.[1] ?? "";
    expect(
      { readBack, answers: /stored_at: stored\.stored_at/.test(source) },
      "the ACK's `stored_at` no longer comes from the committed row",
    ).toEqual({ readBack: "stmtSelectAuditEvent.get(eventId) as { stored_at: string };", answers: true });
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

/**
 * The hub's own records: what it writes about messages and identities without
 * anybody calling a method.
 *
 * These are the events § 8.9.4 and § 8.9.5 require the hub to produce itself —
 * a delivery it observed, a recall a sender asked for, a type change a route
 * made. Each is an exported function over the same store, so none of them
 * needs the process either.
 *
 * **None of them throws.** § 15.6: provisioning and delivery do not fail
 * because the audit store is unwritable. That makes the recorded row the only
 * evidence any of them ran, which is why each case reads one back.
 */
describe("what the hub records for itself", () => {
  const eventsFor = (correlationId: string) =>
    auditDb
      .prepare(
        `SELECT event_type, identity, payload, attestation
           FROM audit_events WHERE correlation_id = ? ORDER BY stored_at, event_id`,
      )
      .all(correlationId) as Array<Record<string, any>>;

  /**
   * **The sender's signature is kept verbatim**, because a recall is something
   * they asked for — unlike a delivery, which is the hub's own later
   * observation and carries no attestation.
   */
  test("keeps the sender's own signature on a recall, and none on a delivery", () => {
    const messageId = uniq("msg");
    const sig = { alg: "ed25519", value: "recall-signature" };
    recordRecalled({ id: messageId, from_agent: "a", to_agent: "b", sent_by: "a" }, sig);
    recordDelivered({
      id: messageId, from_agent: "a", to_agent: "b", sent_by: "a",
      content: "the body", reply_to: null,
    });

    const rows = eventsFor(messageId);
    const recalled = rows.find((r) => r.event_type === "mesh.message.recalled")!;
    const delivered = rows.find((r) => r.event_type === "mesh.message.delivered")!;

    expect(JSON.parse(recalled.attestation)).toMatchObject({ covers: "mesh.send.params", sig });
    expect(delivered.attestation).toBeNull();
  });

  /**
   * The body is not repeated on a recall: `sent` already carries it, retention
   * is indefinite (§ 15.6), and the pair reads as one story — sent, then
   * withdrawn before anyone saw it.
   */
  test("does not repeat the body it already recorded", () => {
    const messageId = uniq("msg");
    recordRecalled({ id: messageId, from_agent: "a", to_agent: "b", sent_by: null }, null);
    const [row] = eventsFor(messageId);
    const payload = JSON.parse(row!.payload);
    expect(payload.message.content).toBe("");
    // `sent_by` falls back to the sender when the row does not name a proxy.
    expect(payload.message.sent_by).toBe("a");
  });

  /**
   * § 8.9.5. An identity changing type has no message to hang off, so it is
   * correlated on the identity and carries who caused it — `null` when the
   * route genuinely cannot say, rather than a guess.
   */
  test("records an identity change against the identity, with its actor", () => {
    const identity = uniq("agent");
    recordIdentityEvent("mesh.identity.type_changed", {
      identity,
      change: { from: "ai-claude", to: "human" },
      actor: "operator-1",
    });

    const [row] = eventsFor(identity);
    expect(row!.event_type).toBe("mesh.identity.type_changed");
    expect(row!.identity).toBe(identity);
    const payload = JSON.parse(row!.payload);
    expect(payload).toMatchObject({
      identity, actor: "operator-1", change: { from: "ai-claude", to: "human" },
    });
  });

  test("records one whose cause is unknown, rather than inventing an actor", () => {
    const identity = uniq("agent");
    recordIdentityEvent("mesh.identity.type_changed", {
      identity, change: { from: "human", to: "ai-claude" }, actor: null,
    });
    expect(JSON.parse(eventsFor(identity)[0]!.payload).actor).toBeNull();
  });

  /**
   * **Time-ordered ids.** § 8.9.3 requires them because the query API pages by
   * `(stored_at, event_id)` and `stored_at` is millisecond precision — several
   * events land on one value under any load, and a random id breaks the tie
   * randomly, which lets a row inserted later sort before the cursor and be
   * skipped. The hub is a producer as much as any client.
   */
  test("gives its own events ids that sort the way they happened", () => {
    const identity = uniq("agent");
    for (let i = 0; i < 5; i++) {
      recordIdentityEvent("mesh.identity.type_changed", {
        identity, change: { step: i }, actor: null,
      });
    }
    const ids = (auditDb
      .prepare(`SELECT event_id FROM audit_events WHERE correlation_id = ? ORDER BY rowid`)
      .all(identity) as Array<{ event_id: string }>).map((r) => r.event_id);

    expect(ids).toHaveLength(5);
    expect(ids.every((id) => id.startsWith("evt_"))).toBe(true);
    expect([...ids].sort()).toEqual(ids);
  });
});

/**
 * What the method answers when the store itself will not take the event.
 *
 * § 15.6 forbids audit exhaustion taking message delivery with it, and § 8.9.3
 * divides the answers into transient and permanent — a conformant client
 * retries a transient one "with backoff and jitter and no maximum attempt
 * count". So which class a failure lands in is a promise about what the client
 * will do with it, and until now every one of these paths was reasoning with
 * nothing standing under it: the hub is a separate process in `test/`, and no
 * suite had ever made this store refuse.
 *
 * The refusals are made at the store, by the store: a table renamed away, and
 * a trigger that aborts with the message a full disk produces. Each is put
 * back in a `finally`, so a case that fails does not take the rest of the run
 * with it.
 */
describe("when the audit store will not take it", () => {
  /** This block's own reader: the outer one belongs to the block above it. */
  const recorded = (correlationId: string) =>
    auditDb
      .prepare(`SELECT event_type, payload FROM audit_events WHERE correlation_id = ?`)
      .all(correlationId) as Array<Record<string, any>>;

  /** Run `body` with `audit_events` renamed out from under the statements. */
  function withNoAuditTable<T>(body: () => T): T {
    auditDb.exec("ALTER TABLE audit_events RENAME TO audit_events_unavailable");
    try {
      return body();
    } finally {
      auditDb.exec("ALTER TABLE audit_events_unavailable RENAME TO audit_events");
    }
  }

  /** Run `body` with every insert aborting, as SQLite reports the named cause. */
  function withInsertsRefused<T>(cause: string, body: () => T): T {
    auditDb.exec(
      `CREATE TRIGGER aap_refuse_insert BEFORE INSERT ON audit_events
       BEGIN SELECT RAISE(ABORT, '${cause}'); END`,
    );
    try {
      return body();
    } finally {
      auditDb.exec("DROP TRIGGER aap_refuse_insert");
    }
  }

  test("a duplicate check that cannot be read is answered, not thrown", () => {
    const { ws } = connected();

    const answered = withNoAuditTable(() => append(ws, event()));

    expect(answered.error!.data!.code).toBe("AUDIT_APPEND_FAILED");
    expect(answered.error!.message).toContain("audit append failed");
    expect(answered.result).toBeUndefined();
  });

  test("a full volume is transient, and says so in its own code", () => {
    const { ws } = connected();

    const answered = withInsertsRefused("database or disk is full", () => append(ws, event()));

    expect(answered.error!.code).toBe(AUDIT_STORAGE_EXHAUSTED);
    expect(answered.error!.data!.code).toBe("AUDIT_STORAGE_EXHAUSTED");
  });

  test("a busy store is transient, and says how long to wait", () => {
    const { ws } = connected();

    const answered = withInsertsRefused("database is locked", () => append(ws, event()));

    expect(answered.error!.code).toBe(AUDIT_BUSY);
    expect(answered.error!.data).toMatchObject({ code: "AUDIT_BUSY", retry_after_ms: 250 });
  });

  /**
   * **Not `AUDIT_BUSY`.** A constraint violation, a schema mismatch or a bug in
   * this handler fails identically on every attempt, and a client told it is
   * transient keeps the event in its outbox forever while hammering a path that
   * is already broken. Permanent instead, so it drops it and records the
   * failure where a person can see it.
   */
  test("anything else is permanent, so the client stops rather than retrying forever", () => {
    const { ws } = connected();

    const answered = withInsertsRefused("CHECK constraint failed: schema_version", () => append(ws, event()));

    expect(answered.error!.code).not.toBe(AUDIT_BUSY);
    expect(answered.error!.data!.code).toBe("AUDIT_APPEND_FAILED");
    expect(answered.error!.message).toContain("CHECK constraint failed");
  });

  test("nothing is committed by a refused append", () => {
    const { ws } = connected();
    const e = event();

    withInsertsRefused("database or disk is full", () => append(ws, e));

    expect(storedRow(e.event_id) ?? undefined).toBeUndefined();
  });

  test("the store recovers: the same event appends once the refusal is lifted", () => {
    const { ws } = connected();
    const e = event();
    withInsertsRefused("database is locked", () => append(ws, e));

    const answered = append(ws, e);

    expect(answered.result).toMatchObject({ ok: true, committed: true, duplicate: false });
  });

  /**
   * The hub's own events are recorded on paths that must not fail — a delivery
   * that threw here would take the routing down with the audit store, which is
   * § 15.6 inverted. They are swallowed and logged instead, which is the one
   * place in this file where nothing is answered to anybody.
   */
  test("the hub's own message event is logged rather than thrown", () => {
    const messageId = uniq("msg");

    expect(() =>
      withNoAuditTable(() =>
        recordDelivered({
          id: messageId, from_agent: "a", to_agent: "b", sent_by: "a",
          content: "the body", reply_to: null,
        }),
      ),
    ).not.toThrow();
    expect(recorded(messageId)).toEqual([]);
  });

  test("the hub's own identity event is logged rather than thrown", () => {
    const identity = uniq("agent");

    expect(() =>
      withNoAuditTable(() =>
        recordIdentityEvent("mesh.identity.type_changed", {
          identity, change: { from: "human", to: "ai-claude" }, actor: null,
        }),
      ),
    ).not.toThrow();
    expect(recorded(identity)).toEqual([]);
  });

  test("recording resumes afterwards", () => {
    const identity = uniq("agent");
    withNoAuditTable(() =>
      recordIdentityEvent("mesh.identity.type_changed", { identity, change: {}, actor: null }),
    );

    recordIdentityEvent("mesh.identity.type_changed", { identity, change: {}, actor: "operator-1" });

    expect(recorded(identity)).toHaveLength(1);
  });
});
