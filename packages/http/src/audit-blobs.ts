/**
 * `PUT /api/v1/audit/blobs/{key}` (SPEC § 9.1).
 *
 * **Streams.** The existing `POST /api/v1/upload` reads the whole body into
 * memory, and at the 100 MiB blob limit a handful of concurrent uploads takes
 * the process down — so this route cannot reuse it. Bytes are hashed as they
 * arrive and written to a temporary file; the file is renamed into place only
 * once the digest matches what was authorised. An upload that dies midway
 * leaves a temp file, never a short blob under a real key, which matters
 * because a short blob would satisfy an existence check and corrupt an event.
 *
 * Authorised by `Authorization: AgentMeshSig` over `uploadSignaturePreimage` —
 * a construction separate from the JSON-RPC one (§ 8.1), with its own domain
 * separator, so neither signature can be replayed into the other's position.
 *
 * The grant is not single-use. Its signature covers the digest and the size, so
 * a replay authorises writing the identical bytes under the identical key,
 * which deduplicates to no effect. Single-use would buy nothing and would break
 * retrying an upload that failed partway, which is the case this path meets.
 */

import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

import {
  AUDIT_CAPABILITY_DEFAULTS,
  UPLOAD_AUTH_SCHEME,
  parseUploadAuthorization,
  uploadSignaturePreimage,
  BLOB_KEY_ACCEPT_RE,
} from '@agent-mesh/contracts'
import { checkpointForShutdown, openAt, stateDir, STORE_FILES, nonces, verify } from '@agent-mesh/store'
import type { Database } from 'bun:sqlite'

/**
 * SPEC § 8.9.1, from the contract rather than restated.
 *
 * These have to agree with what the hub advertises or a client sizes its
 * uploads against one number and is refused by another — and the refusal would
 * arrive after the bytes were sent.
 */
export const MAX_BLOB_BYTES = AUDIT_CAPABILITY_DEFAULTS.max_blob_bytes
export const UPLOAD_TIMEOUT_MS = AUDIT_CAPABILITY_DEFAULTS.upload_timeout_seconds * 1000

const UPLOAD_DIR = join(stateDir(), 'uploads')
mkdirSync(UPLOAD_DIR, { recursive: true })

let _agentsDb: Database | null = null
function agentsDb(): Database {
  if (!_agentsDb) _agentsDb = openAt(join(stateDir(), STORE_FILES.agents), { create: false })
  return _agentsDb
}

export function closeBlobDb(): void {
  if (_agentsDb) {
    checkpointForShutdown(_agentsDb)
    _agentsDb.close()
  }
  _agentsDb = null
}

export interface BlobPutResult {
  status: number
  body: Record<string, unknown>
}

function refuse(status: number, error: string): BlobPutResult {
  return { status, body: { ok: false, error } }
}

/**
 * Handle one upload.
 *
 * `identity` is not taken from the request: it comes from the grant the nonce
 * resolves to, and the signature is then verified against *that* identity's
 * approved key. A caller therefore cannot name an identity it does not hold a
 * key for, and a stolen nonce is useless without the key it was issued to.
 */
export async function putBlob(blobKey: string, req: Request): Promise<BlobPutResult> {
  if (!BLOB_KEY_ACCEPT_RE.test(blobKey)) {
    return refuse(400, 'invalid blob key')
  }

  const header = req.headers.get('authorization')
  if (!header) {
    return refuse(401, `missing ${UPLOAD_AUTH_SCHEME} authorization`)
  }
  const auth = parseUploadAuthorization(header)
  if (!auth) {
    return refuse(401, `authorization must use the ${UPLOAD_AUTH_SCHEME} scheme`)
  }

  // Required and matched, not advisory. Without it the size bound could only be
  // enforced by counting bytes as they arrive, which means accepting an
  // unbounded stream before deciding to reject it.
  const declared = req.headers.get('content-length')
  if (declared === null) {
    return refuse(411, 'Content-Length is required')
  }
  const size = Number(declared)
  if (!Number.isInteger(size) || size < 0) {
    return refuse(400, 'Content-Length must be a non-negative integer')
  }
  if (size > MAX_BLOB_BYTES) {
    return refuse(413, `body is ${size} bytes, over the ${MAX_BLOB_BYTES} byte limit`)
  }

  const db = agentsDb()
  const grantRow = db
    .prepare(`SELECT identity FROM upload_nonces WHERE nonce = ?`)
    .get(auth.nonce) as { identity: string } | undefined
  if (!grantRow) {
    return refuse(403, 'unknown or expired upload grant')
  }

  const check = nonces.checkGrant(db, auth.nonce, grantRow.identity, blobKey, size)
  if (!check.ok) {
    // **One message for every refusal**, because naming which bound field
    // disagreed lets a caller holding a nonce probe what it was issued for —
    // key, size, or holder — one request at a time.
    //
    // The reason went into the message until now, under this comment saying it
    // must not: both arrived in the same commit, so it was never a drift. The
    // operator still needs it, so it goes where the operator is and the caller
    // is not.
    console.warn(`[audit-blobs] grant ${auth.nonce} refused for ${blobKey}: ${check.reason}`)
    return refuse(403, 'upload grant does not authorise this upload')
  }
  const grant = check.grant

  const outcome = verify.verifyForIdentity(
    db,
    grant.identity,
    auth.kid,
    uploadSignaturePreimage({
      nonce: auth.nonce,
      blobKey,
      sha256: grant.sha256,
      size: grant.size,
    }),
    auth.signature,
  )
  if (!outcome.ok) {
    return refuse(403, `signature does not verify (${outcome.reason})`)
  }

  const finalPath = join(UPLOAD_DIR, blobKey)
  // Content-addressed: the same key is the same bytes, so an existing blob of
  // the right length is success rather than a conflict. This is what makes a
  // retry after an ambiguous failure safe.
  try {
    const existing = statSync(finalPath)
    if (existing.isFile() && existing.size === grant.size) {
      return { status: 200, body: { ok: true, blob_key: blobKey, deduplicated: true } }
    }
  } catch {
    // Absent, which is the normal case.
  }

  if (!req.body) return refuse(400, 'request has no body')

  const tempPath = `${finalPath}.${auth.nonce}.part`
  const hash = createHash('sha256')
  const sink = createWriteStream(tempPath)
  let received = 0
  const deadline = setTimeout(() => sink.destroy(new Error('upload timed out')), UPLOAD_TIMEOUT_MS)

  try {
    for await (const chunk of req.body as any as AsyncIterable<Uint8Array>) {
      received += chunk.length
      // Checked as it arrives as well as against Content-Length: a sender may
      // declare one length and send another, and the declaration is the part
      // that is easy to get right by accident.
      if (received > grant.size) {
        throw new Error(`body exceeds the ${grant.size} bytes authorised`)
      }
      hash.update(chunk)
      if (!sink.write(chunk)) {
        await new Promise<void>((resolve, reject) => {
          sink.once('drain', resolve)
          sink.once('error', reject)
        })
      }
    }
    await new Promise<void>((resolve, reject) => {
      sink.end((err: unknown) => (err ? reject(err) : resolve()))
    })
  } catch (err) {
    clearTimeout(deadline)
    sink.destroy()
    rmSync(tempPath, { force: true })
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('timed out')) return refuse(408, 'upload timed out')
    if (message.includes('exceeds')) return refuse(413, message)
    return refuse(400, `upload failed: ${message}`)
  }
  clearTimeout(deadline)

  if (received !== grant.size) {
    rmSync(tempPath, { force: true })
    return refuse(400, `received ${received} bytes, expected ${grant.size}`)
  }

  const digest = hash.digest('hex')
  if (digest !== grant.sha256) {
    // The temp file goes, so a mismatched upload never becomes a blob an event
    // could later reference as present.
    rmSync(tempPath, { force: true })
    return refuse(422, `digest mismatch: received ${digest}, authorised ${grant.sha256}`)
  }

  // Rename last, and only once the digest matches. Until this line there is no
  // file under a name anything would look for.
  renameSync(tempPath, finalPath)
  return {
    status: 201,
    body: { ok: true, blob_key: blobKey, size: received, sha256: digest },
  }
}
