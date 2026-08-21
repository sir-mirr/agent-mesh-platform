/**
 * `mesh.audit.prepare_blobs` (SPEC § 8.9.2).
 *
 * Reports which attachment blobs the store already holds and issues an upload
 * grant for those it does not, so a client uploads only what is missing rather
 * than pushing every attachment and letting the store discard duplicates.
 *
 * **The hub derives `blob_key` and returns it.** A client must use the value
 * that comes back rather than computing its own: the key retains the file
 * extension (§ 15.2), so `sha256` alone does not determine it, and two
 * implementations of one normalisation rule are two chances to disagree. A
 * disagreement here does not fail loudly — it splits one blob into two, which
 * is discovered much later as storage that will not deduplicate.
 */

import { createHash } from "node:crypto";

import { MESH_ERROR, deriveBlobKey } from "@agent-mesh/contracts";
import { nonces } from "@agent-mesh/store";

import { agentsDb, auditDb, stmtInsertAuditBlob, stmtInsertAuditEvent, stmtSelectAuditEvent } from "../db";
import { INVALID_PARAMS, INVALID_REQUEST, rpcError, rpcResult } from "../jsonrpc";
import { log } from "../log";
import { rawParams } from "../raw-params";
import { AUDIT_LIMITS, MAX_SCHEMA_VERSION } from "./audit-limits";
import { wsIdentities } from "../presence";
import { blobPath, blobStat } from "../blobs";

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * Where blob uploads are served (SPEC § 9.1).
 *
 * **Absolute, and it has to be.** The blob route lives on `agent-mesh-http`
 * while this method answers on the hub — two services on two ports. A relative
 * URL is resolved by the client against whatever origin it happened to be
 * talking to, which is this one, and the upload 404s against a service that
 * does not serve that route. The client found exactly that.
 *
 * The hub cannot derive the address: it never connects to http, http connects
 * to it. So a deployment states it, and the default is the port § 9.1 assigns.
 */
export const BLOB_BASE_URL = (
  process.env.AGENT_MESH_BLOB_BASE_URL ??
  process.env.AGENT_MESH_HTTP_URL ??
  "http://127.0.0.1:3000"
).replace(/\/+$/, "");

interface BlobRequest {
  sha256: string;
  size: number;
  name: string;
}

export function handlePrepareBlobs(
  ws: any,
  params: Record<string, any>,
  id: string | number | null | undefined,
): string {
  const identity = wsIdentities.get(ws);
  if (!identity) {
    return rpcError(id, INVALID_REQUEST, "Not connected. Call mesh.connect first.");
  }

  const eventId = params.event_id;
  if (!eventId || typeof eventId !== "string") {
    return rpcError(id, INVALID_PARAMS, "params.event_id is required");
  }

  const requested = params.blobs;
  if (!Array.isArray(requested)) {
    return rpcError(id, INVALID_PARAMS, "params.blobs must be an array");
  }
  if (requested.length > AUDIT_LIMITS.max_attachments_per_event) {
    return rpcError(
      id,
      INVALID_PARAMS,
      `too many attachments: ${requested.length} > ${AUDIT_LIMITS.max_attachments_per_event}`,
    );
  }

  const blobs: BlobRequest[] = [];
  let declaredTotal = 0;
  for (const entry of requested) {
    if (!entry || typeof entry !== "object") {
      return rpcError(id, INVALID_PARAMS, "each blob must be an object");
    }
    const { sha256, size, name } = entry as Record<string, unknown>;
    if (typeof sha256 !== "string" || !SHA256_HEX_RE.test(sha256)) {
      return rpcError(id, INVALID_PARAMS, "blob.sha256 must be 64 lowercase hex characters");
    }
    if (typeof size !== "number" || !Number.isInteger(size) || size < 0) {
      return rpcError(id, INVALID_PARAMS, "blob.size must be a non-negative integer");
    }
    if (size > AUDIT_LIMITS.max_blob_bytes) {
      return rpcError(
        id,
        INVALID_PARAMS,
        `blob ${sha256} is ${size} bytes, over max_blob_bytes ${AUDIT_LIMITS.max_blob_bytes}`,
      );
    }
    // `name` is required because the key retains the extension (§ 15.2); the
    // digest alone does not determine where the bytes land.
    if (typeof name !== "string" || name.length === 0) {
      return rpcError(id, INVALID_PARAMS, "blob.name is required — the storage key derives from it");
    }
    declaredTotal += size;
    blobs.push({ sha256, size, name });
  }

  if (declaredTotal > AUDIT_LIMITS.max_attachments_bytes_per_event) {
    return rpcError(
      id,
      INVALID_PARAMS,
      `declared attachments total ${declaredTotal} bytes, over ` +
        `max_attachments_bytes_per_event ${AUDIT_LIMITS.max_attachments_bytes_per_event}`,
    );
  }

  const result = blobs.map((b) => {
    const blobKey = deriveBlobKey(b.sha256, b.name);
    const existing = blobStat(blobKey);

    // Present only when the stored size matches. A file of the right name and
    // the wrong length is a partial write from an interrupted upload, and
    // reporting it present would leave the event referencing truncated bytes.
    if (existing && existing.size === b.size) {
      return { sha256: b.sha256, blob_key: blobKey, status: "present" as const };
    }

    const grant = nonces.issueGrant(agentsDb, identity, blobKey, b.sha256, b.size);
    return {
      sha256: b.sha256,
      blob_key: blobKey,
      status: "missing" as const,
      upload: {
        method: "PUT" as const,
        url: `${BLOB_BASE_URL}/api/v1/audit/blobs/${blobKey}`,
        nonce: grant.nonce,
        expires_at: grant.expires_at,
      },
    };
  });

  return rpcResult(id, { blobs: result });
}


export const AUDIT_MISSING_BLOBS = -32040;
export const AUDIT_EVENT_CONFLICT = -32041;
/** Retired. § 8.9.3 forbids reuse: an old client would read one meaning as the other. */
export const RETIRED_AUDIT_SEQUENCE_CONFLICT = -32042;
// Nothing calls this, and nothing should: it is a tombstone reserving the code
// against reuse, and deleting it is how the code gets used again by someone who
// has no way to know it was burned. `test/versioning.test.ts` excludes the same
// number by value — it reads this file as text rather than importing it — so
// the two are linked by name here and by comment there.
export const AUDIT_BUSY = -32043;
export const AUDIT_STORAGE_EXHAUSTED = -32044;

/**
 * `mesh.audit.append` (SPEC § 8.9.3).
 *
 * Four members are **not** request fields — `identity`, `recorded_by`,
 * `attestation` and `payload_digest`. They are the record's trust metadata, and
 * a field the client supplies cannot attest to the client. Each is constructed
 * here: the identity from the authenticated connection, `recorded_by` from
 * which component is writing, the attestation from the verified signature, and
 * the digest from the received bytes. A client that sends them has them
 * ignored rather than honoured.
 */
export function handleAuditAppend(
  ws: any,
  params: Record<string, any>,
  id: string | number | null | undefined,
  raw: string,
  sig: unknown,
): string {
  const identity = wsIdentities.get(ws);
  if (!identity) {
    return rpcError(id, INVALID_REQUEST, "Not connected. Call mesh.connect first.");
  }

  const { schema_version: schemaVersion, event_id: eventId, event_type: eventType, occurred_at: occurredAt } = params;

  if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion) || schemaVersion < 1) {
    return rpcError(id, INVALID_PARAMS, "params.schema_version must be a positive integer");
  }
  // Rejected rather than stored, and no data is lost: the client's outbox
  // retries and drains once the hub is upgraded. Storing an event it cannot
  // validate would record "validated" as a falsehood — which is why hubs are
  // upgraded before clients.
  if (schemaVersion > MAX_SCHEMA_VERSION) {
    return rpcError(
      id,
      INVALID_PARAMS,
      `schema_version ${schemaVersion} is newer than this hub understands (max ${MAX_SCHEMA_VERSION})`,
    );
  }
  if (!eventId || typeof eventId !== "string") {
    return rpcError(id, INVALID_PARAMS, "params.event_id is required");
  }
  if (!eventType || typeof eventType !== "string") {
    return rpcError(id, INVALID_PARAMS, "params.event_type is required");
  }
  if (!occurredAt || typeof occurredAt !== "string") {
    return rpcError(id, INVALID_PARAMS, "params.occurred_at is required");
  }
  if (params.producer_id !== undefined) {
    if (typeof params.producer_id !== "string" || params.producer_id.length > 64) {
      return rpcError(id, INVALID_PARAMS, "params.producer_id must be a string of at most 64 chars");
    }
  }

  const attachments = params.attachments ?? [];
  if (!Array.isArray(attachments)) {
    return rpcError(id, INVALID_PARAMS, "params.attachments must be an array");
  }
  if (attachments.length > AUDIT_LIMITS.max_attachments_per_event) {
    return rpcError(id, INVALID_PARAMS, "too many attachments");
  }

  // Over the received bytes, by the same rule § 8.1 applies to signatures. A
  // digest recomputed from the parsed object would differ from the client's for
  // reasons that have nothing to do with the content.
  const payload = rawParams(raw) ?? "{}";
  const payloadDigest = createHash("sha256").update(payload, "utf8").digest("hex");

  // Guarded like the write below. This read reaches the same file, so a store
  // that cannot be read fails here rather than at the transaction — and an
  // unguarded throw leaves the dispatcher's last-resort handler to answer,
  // which is a worse error than the one this returns.
  let existing: { payload_digest: string; stored_at: string } | undefined;
  try {
    existing = stmtSelectAuditEvent.get(eventId) as
      | { payload_digest: string; stored_at: string }
      | undefined;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("could not read the audit store to check for a duplicate", "audit_duplicate_check_failed", {
      id: eventId,
      outcome: "failed",
      reason: "store_unreadable",
      error: message,
    });
    return rpcError(id, MESH_ERROR.SERVER_ERROR, `audit append failed: ${message}`, {
      code: "AUDIT_APPEND_FAILED",
    });
  }
  if (existing) {
    // Identical bytes: the client did not hear the ACK and retried. Different
    // bytes under one id is a client defect that retrying cannot fix, so it is
    // permanent rather than transient.
    if (existing.payload_digest === payloadDigest) {
      return rpcResult(id, {
        ok: true,
        committed: true,
        duplicate: true,
        event_id: eventId,
        identity,
        attachments_verified: attachments.length,
        stored_at: existing.stored_at,
      });
    }
    return rpcError(
      id,
      AUDIT_EVENT_CONFLICT,
      `event_id '${eventId}' already exists with a different payload`,
      { code: "AUDIT_EVENT_CONFLICT", event_id: eventId },
    );
  }

  // Every blob must be on disk with the declared size before anything commits.
  // A file of the right name and the wrong length is an interrupted upload, and
  // accepting it would let the event reference truncated bytes as verified.
  const refs: Array<{ blobKey: string; sha256: string; size: number; name: string | null }> = [];
  const missing: string[] = [];
  for (const entry of attachments) {
    if (!entry || typeof entry !== "object") {
      return rpcError(id, INVALID_PARAMS, "each attachment must be an object");
    }
    const { sha256, size, name } = entry as Record<string, unknown>;
    if (typeof sha256 !== "string" || typeof size !== "number" || typeof name !== "string") {
      return rpcError(id, INVALID_PARAMS, "attachment requires sha256, size and name");
    }
    const blobKey = deriveBlobKey(sha256, name);
    const stat = blobStat(blobKey);
    if (!stat || stat.size !== size) {
      missing.push(sha256);
      continue;
    }
    refs.push({ blobKey, sha256, size, name });
  }

  if (missing.length > 0) {
    // Transient: the client uploads and retries. Nothing is committed, so a
    // retry is not a partial repair.
    return rpcError(id, AUDIT_MISSING_BLOBS, "referenced blobs are not present", {
      code: "AUDIT_MISSING_BLOBS",
      missing_sha256: missing,
    });
  }

  const attestation = sig ? JSON.stringify({ covers: "mesh.audit.append.params", sig }) : null;

  try {
    const tx = auditDb.transaction(() => {
      stmtInsertAuditEvent.run(
        eventId,
        schemaVersion,
        eventType,
        occurredAt,
        params.correlation_id ?? null,
        params.causation_event_id ?? null,
        params.producer_id ?? null,
        identity,
        "adapter",
        identity,
        payload,
        payloadDigest,
        attestation,
      );
      for (const r of refs) {
        stmtInsertAuditBlob.run(eventId, r.blobKey, r.sha256, r.size, r.name);
      }
    });
    tx();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Transient, and it needs an operator (§ 15.6). The hub keeps routing —
    // audit exhaustion must not take message delivery with it.
    if (/disk|full|SQLITE_FULL|no space/i.test(message)) {
      return rpcError(id, AUDIT_STORAGE_EXHAUSTED, "audit storage is exhausted", {
        code: "AUDIT_STORAGE_EXHAUSTED",
      });
    }
    if (/locked|busy/i.test(message)) {
      return rpcError(id, AUDIT_BUSY, "audit store is busy", {
        code: "AUDIT_BUSY",
        retry_after_ms: 250,
      });
    }
    // **Not AUDIT_BUSY.** § 8.9.3 classes that transient, and a conformant
    // client retries transient errors "with backoff and jitter and no maximum
    // attempt count". Reporting every unrecognised failure that way is the
    // infinite retry the same paragraph exists to prevent: a constraint
    // violation, a schema mismatch or a bug in this handler will fail
    // identically on every attempt, and the client would keep the event in its
    // outbox forever while hammering a path that is already broken.
    //
    // Permanent instead, so the client drops it and records the failure
    // locally — which puts it somewhere a person can see, rather than in a
    // retry loop nobody is watching.
    log.error("could not append to the audit store", "audit_append_failed", {
      id: eventId,
      outcome: "failed",
      reason: "store_unwritable",
      error: message,
    });
    return rpcError(id, MESH_ERROR.SERVER_ERROR, `audit append failed: ${message}`, {
      code: "AUDIT_APPEND_FAILED",
    });
  }

  // ACK only after the transaction commits. Acknowledging earlier would tell a
  // client its outbox entry is safe to drop before it is.
  const stored = stmtSelectAuditEvent.get(eventId) as { stored_at: string };
  return rpcResult(id, {
    ok: true,
    committed: true,
    duplicate: false,
    event_id: eventId,
    identity,
    attachments_verified: refs.length,
    stored_at: stored.stored_at,
  });
}

export { blobPath };
export { AUDIT_LIMITS, MAX_SCHEMA_VERSION };

/**
 * Events the hub records about its own routing (SPEC § 8.9.4).
 *
 * This is what makes mesh audit stronger evidence than channel audit. A channel
 * event is an adapter's report of its own activity; a mesh event is the hub's
 * observation, carrying **the sender's own signature** as the attestation. That
 * difference is a field — `recorded_by.kind` — rather than something inferred
 * by prefix-matching `event_type`.
 *
 * The event carries the message body rather than referencing `messages`, so
 * audit retention and operational retention stay independent: rotating the
 * message table must not hollow out the record of what was sent.
 *
 * Never throws. Routing does not stop because the audit store is unwritable —
 * § 15.6 requires the hub to keep delivering and reject audit writes instead,
 * and a delivery that failed because a disk filled would be the worse outcome.
 */
export function recordMeshEvent(
  eventType:
    | "mesh.message.sent"
    | "mesh.message.delivered"
    | "mesh.message.pending"
    | "mesh.message.recalled",
  fields: {
    messageId: string;
    from: string;
    to: string;
    sentBy: string;
    content: string;
    replyTo: string | null;
    /** The sender's `mesh.send` signature, kept verbatim so it stays verifiable. */
    senderSig: unknown;
    /** The sender's `params` bytes, exactly as received. */
    senderParams: string;
  },
): void {
  const payload = JSON.stringify({
    schema_version: 1,
    // UUIDv7, not v4. § 8.9.3 requires event ids to be time-ordered and the
    // query API's cursor pages by `(stored_at, event_id)` — `stored_at` is
    // millisecond precision, so several events land on the same value under any
    // load and the id is what breaks the tie. A random id breaks it randomly,
    // which lets a row inserted later sort before the cursor and be skipped.
    //
    // The hub is a producer as much as any client, and this requirement is one
    // it was placing on others while not meeting it.
    event_id: `evt_${Bun.randomUUIDv7()}`,
    event_type: eventType,
    occurred_at: new Date().toISOString(),
    correlation_id: fields.messageId,
    message: {
      id: fields.messageId,
      from: fields.from,
      to: fields.to,
      sent_by: fields.sentBy,
      content: fields.content,
      reply_to: fields.replyTo,
    },
  });
  const parsed = JSON.parse(payload);

  try {
    auditDb.transaction(() => {
      stmtInsertAuditEvent.run(
        parsed.event_id,
        1,
        eventType,
        parsed.occurred_at,
        fields.messageId,
        null,
        null,
        // The sending identity, not the transmitting socket. `sent_by` is in
        // the body; this is who the event is *about*.
        fields.from,
        "hub",
        null,
        payload,
        createHash("sha256").update(payload, "utf8").digest("hex"),
        fields.senderSig
          ? JSON.stringify({
              covers: "mesh.send.params",
              params: fields.senderParams,
              sig: fields.senderSig,
            })
          : null,
      );
    })();
  } catch (err) {
    log.error(`could not record ${eventType}, and the message went through anyway`, "audit_own_event_failed", {
      id: fields.messageId,
      event_type: eventType,
      outcome: "unrecorded",
      reason: "store_unwritable",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Record that a message queued earlier has now reached its recipient
 * (SPEC § 8.9.4).
 *
 * Without this the record showed `mesh.message.pending` and nothing else, for
 * ever — the audit trail said every queued message was still waiting, however
 * long ago it arrived. The one question an audit of delivery exists to answer
 * is whether something was delivered, and it could not answer it.
 *
 * No attestation: the sender signed the original `mesh.send`, and that
 * signature is on the `sent` and `pending` events. This is the hub's own later
 * observation, which the sender was not present for and cannot attest to.
 */
export function recordDelivered(row: {
  id: string;
  from_agent: string;
  to_agent: string;
  sent_by: string | null;
  content: string;
  reply_to: string | null;
}): void {
  recordMeshEvent("mesh.message.delivered", {
    messageId: row.id,
    from: row.from_agent,
    to: row.to_agent,
    sentBy: row.sent_by ?? row.from_agent,
    content: row.content,
    replyTo: row.reply_to,
    senderSig: null,
    senderParams: "{}",
  });
}

/**
 * Record something that happened to an **identity** rather than to a message
 * (SPEC § 8.9.5).
 *
 * `recordMeshEvent` cannot carry these. Its payload is a message — id, from,
 * to, content — and an identity changing type has none of that, so every
 * field would be a lie or a null. Three separate things were deferred waiting
 * for this shape: a type change leaving no record, audit reads leaving none,
 * and the re-attestation proposal's two events.
 *
 * **`attestation` is null and that is the honest answer.** § 8.9.4 keeps the
 * sender's `mesh.send` signature because a sender asked for that. Nobody signs
 * these: `POST /api/v1/agents` is unauthenticated (§ 9.2 †), so the hub can
 * record *that* a type changed and cannot record who is answerable for it. A
 * fabricated attestation would be worse than an absent one, and the absence is
 * itself information about the route.
 *
 * `correlation_id` is the identity, not a message id — it is what an operator
 * pages by when asking what has happened to one participant.
 *
 * Never throws, for § 15.6's reason: provisioning does not fail because the
 * audit store is unwritable.
 */
export function recordIdentityEvent(
  eventType: "mesh.identity.type_changed",
  fields: {
    identity: string;
    /** Merged into the payload under `change`. Shape is per event type. */
    change: Record<string, unknown>;
    /** Who caused it, when the route knows. `null` when it cannot. */
    actor: string | null;
  },
): void {
  const payload = JSON.stringify({
    schema_version: 1,
    // UUIDv7 for the same reason § 8.9.3 requires it of producers: the query
    // API pages by `(stored_at, event_id)` and millisecond `stored_at` ties.
    event_id: `evt_${Bun.randomUUIDv7()}`,
    event_type: eventType,
    occurred_at: new Date().toISOString(),
    correlation_id: fields.identity,
    identity: fields.identity,
    actor: fields.actor,
    change: fields.change,
  });
  const parsed = JSON.parse(payload);

  try {
    auditDb.transaction(() => {
      stmtInsertAuditEvent.run(
        parsed.event_id,
        1,
        eventType,
        parsed.occurred_at,
        fields.identity,
        null,
        null,
        fields.identity,
        "hub",
        null,
        payload,
        createHash("sha256").update(payload, "utf8").digest("hex"),
        null,
      );
    })();
  } catch (err) {
    log.error(`could not record ${eventType}, and the change went through anyway`, "audit_own_event_failed", {
      actor: fields.identity,
      event_type: eventType,
      outcome: "unrecorded",
      reason: "store_unwritable",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Record that a sender withdrew a message nobody had been handed (§ 9.2.1).
 *
 * Without it the trail holds a `mesh.message.sent` and nothing saying the
 * message was taken back — which is the standalone mailer's defect one level
 * down: the sender able to shape the record. The `messages` row is gone by
 * then, so this event is the only place the withdrawal exists.
 *
 * The body is not repeated. `sent` already carries it, audit retention is
 * indefinite (§ 15.6), and the pair reads as one story: sent, then withdrawn
 * before anyone saw it.
 *
 * The sender's `AgentMeshSig` is the attestation — this is a thing they asked
 * for, unlike `delivered`, which is the hub's own later observation.
 */
export function recordRecalled(
  row: { id: string; from_agent: string; to_agent: string; sent_by: string | null },
  senderSig: unknown,
): void {
  recordMeshEvent("mesh.message.recalled", {
    messageId: row.id,
    from: row.from_agent,
    to: row.to_agent,
    sentBy: row.sent_by ?? row.from_agent,
    content: "",
    replyTo: null,
    senderSig,
    senderParams: "{}",
  });
}
