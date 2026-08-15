/**
 * Upload grants (SPEC § 8.9.2, § 9.1).
 *
 * `mesh.audit.prepare_blobs` issues one per blob the store does not already
 * hold; the http server checks it when the bytes arrive. The two are different
 * processes, which is why this is a table rather than memory — unlike the
 * request-nonce window (§ 8.1), which is checked by the process that issued
 * nothing and only has to remember for two minutes.
 *
 * **Not single-use, on purpose.** A grant is bound to `(identity, blob_key,
 * size)` and the signature over it also covers the digest, so replaying one
 * authorises writing the identical bytes to the identical key — which
 * deduplicates to no effect. Making it single-use would buy nothing and would
 * break the retry of an upload that failed midway, which is the case this path
 * actually meets.
 */

import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";

import { UPLOAD_NONCE_TTL_SECONDS } from "@agent-mesh/contracts";

export interface UploadGrant {
  nonce: string;
  identity: string;
  blob_key: string;
  size: number;
  sha256: string;
  expires_at: string;
}

/** Issue a grant for one blob. */
export function issueGrant(
  db: Database,
  identity: string,
  blobKey: string,
  sha256: string,
  size: number,
): UploadGrant {
  const nonce = randomUUID();
  const row = db
    .prepare(
      `INSERT INTO upload_nonces (nonce, identity, blob_key, size, sha256, expires_at)
       VALUES (?, ?, ?, ?, ?, datetime('now', '+' || ? || ' seconds'))
       RETURNING nonce, identity, blob_key, size, sha256,
                 strftime('%Y-%m-%dT%H:%M:%SZ', expires_at) AS expires_at`,
    )
    .get(nonce, identity, blobKey, size, sha256, UPLOAD_NONCE_TTL_SECONDS) as UploadGrant;
  return row;
}

export type GrantRefusal = "unknown" | "expired" | "wrong-identity" | "wrong-blob" | "wrong-size";

export type GrantCheck =
  | { ok: true; grant: UploadGrant }
  | { ok: false; reason: GrantRefusal };

/**
 * Resolve a grant and check it describes this upload.
 *
 * Every bound field is compared rather than trusted from the request, because
 * the request is what is being authorised. A grant for one key must not
 * authorise a write to another, or an upload could be redirected to overwrite
 * an unrelated blob.
 */
export function checkGrant(
  db: Database,
  nonce: string,
  identity: string,
  blobKey: string,
  size: number,
): GrantCheck {
  const row = db
    .prepare(
      `SELECT nonce, identity, blob_key, size, sha256,
              strftime('%Y-%m-%dT%H:%M:%SZ', expires_at) AS expires_at,
              (expires_at < datetime('now')) AS expired
         FROM upload_nonces WHERE nonce = ?`,
    )
    .get(nonce) as (UploadGrant & { expired: number }) | undefined;

  if (!row) return { ok: false, reason: "unknown" };
  if (row.expired) return { ok: false, reason: "expired" };
  if (row.identity !== identity) return { ok: false, reason: "wrong-identity" };
  if (row.blob_key !== blobKey) return { ok: false, reason: "wrong-blob" };
  if (row.size !== size) return { ok: false, reason: "wrong-size" };
  return { ok: true, grant: row };
}

/**
 * Drop expired grants.
 *
 * Not on the upload path: an expired row is already refused by the check, so
 * sweeping there would make every upload pay for the whole table to save space
 * nothing is reading.
 */
export function sweepExpired(db: Database): number {
  return db.prepare(`DELETE FROM upload_nonces WHERE expires_at < datetime('now')`).run()
    .changes as number;
}
