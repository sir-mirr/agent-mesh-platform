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

import { deriveBlobKey } from "@agent-mesh/contracts";
import { nonces } from "@agent-mesh/store";

import { agentsDb } from "../db";
import { INVALID_PARAMS, INVALID_REQUEST, rpcError, rpcResult } from "../jsonrpc";
import { wsIdentities } from "../presence";
import { blobPath, blobStat } from "../blobs";

/** SPEC § 8.9.1 capability limits. Advertised so a client can size a batch. */
export const AUDIT_LIMITS = {
  max_attachments_per_event: 32,
  max_attachments_bytes_per_event: 512 * 1024 * 1024,
  max_blob_bytes: 100 * 1024 * 1024,
  upload_timeout_seconds: 300,
} as const;

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

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
        url: `/api/v1/audit/blobs/${blobKey}`,
        nonce: grant.nonce,
        expires_at: grant.expires_at,
      },
    };
  });

  return rpcResult(id, { blobs: result });
}

export { blobPath };
