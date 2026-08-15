/**
 * Ed25519 verification against a registered key (SPEC § 8.1, § 9.1).
 *
 * In `store` rather than in the hub because two surfaces verify: the hub checks
 * a signature on every JSON-RPC request, and the http server checks the
 * `AgentMeshSig` header on a blob upload. They cover different preimages and
 * share this — the lookup of an identity's currently approved key, and the
 * verification itself.
 *
 * **The key is read per call, never cached.** Caching for the life of a
 * connection would make revocation take effect only when the connection
 * happened to close, which is precisely the case revocation exists for. The
 * cost does not justify it: reading the row was measured at ~1.7 µs against
 * ~32 µs for the verification it feeds, and cheaper than the `PRAGMA
 * data_version` check an invalidation scheme would need on the same path.
 */

import { createPublicKey, verify as nodeVerify } from "node:crypto";
import type { Database } from "bun:sqlite";

import { parsePublicKey } from "@agent-mesh/contracts";

import * as keys from "./keys";

/**
 * SPKI wrapper for a raw Ed25519 key.
 *
 * `node:crypto` will not take the bare 32 bytes, and the wire format is bare
 * because that is what every other implementation exchanges. The prefix is
 * fixed — SEQUENCE, AlgorithmIdentifier(id-Ed25519), BIT STRING — so building
 * it is concatenation rather than encoding.
 */
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function publicKeyObject(rawBase64Url: string) {
  const raw = Buffer.from(parsePublicKey(rawBase64Url));
  return createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

/**
 * Verify `signature` (base64url) over `preimage` using `publicKey` (base64url
 * raw Ed25519).
 *
 * Returns false rather than throwing on malformed input. A caller cannot act
 * differently on "the signature was garbage" than on "the signature was wrong",
 * and giving it two paths invites one of them to be handled less carefully.
 */
export function verifySignature(
  publicKey: string,
  preimage: Uint8Array,
  signature: string,
): boolean {
  try {
    const sig = Buffer.from(signature, "base64url");
    // Ed25519 signatures are exactly 64 bytes; node throws on other lengths.
    if (sig.length !== 64) return false;
    return nodeVerify(null, Buffer.from(preimage), publicKeyObject(publicKey), sig);
  } catch {
    return false;
  }
}

export type VerifyOutcome =
  | { ok: true; fingerprint: string }
  | { ok: false; reason: "no-approved-key"; keyStatus: keys.NoKeyReason }
  | { ok: false; reason: "wrong-key" }
  | { ok: false; reason: "bad-signature" };

/**
 * Verify a preimage against whatever key the identity currently has approved.
 *
 * `kid` is checked against that key rather than used to select one. Selecting
 * by `kid` would let a revoked key keep working as long as the caller kept
 * naming it — the identity has at most one approved key, and it is the only one
 * that may sign.
 */
export function verifyForIdentity(
  db: Database,
  identity: string,
  kid: string,
  preimage: Uint8Array,
  signature: string,
): VerifyOutcome {
  const key = keys.approvedKey(db, identity);
  if (!key) {
    return { ok: false, reason: "no-approved-key", keyStatus: keys.noKeyReason(db, identity)! };
  }
  if (key.fingerprint !== kid) return { ok: false, reason: "wrong-key" };
  if (!verifySignature(key.public_key, preimage, signature)) {
    return { ok: false, reason: "bad-signature" };
  }
  return { ok: true, fingerprint: key.fingerprint };
}

/**
 * Nonces seen inside the freshness window, per identity.
 *
 * In memory, and that is not a shortcut. A nonce only has to be unrepeatable
 * for the width of the window — outside it the `iat` check rejects the request
 * regardless — so nothing needs to survive a restart, and a restart discards a
 * window's worth of entries whose requests are about to expire anyway.
 *
 * Scoped per identity because a nonce is only meaningful against the key that
 * signed it: two identities colliding on one is not a replay of anything.
 */
export class NonceWindow {
  private readonly seen = new Map<string, Map<string, number>>();

  constructor(private readonly windowSeconds: number) {}

  /**
   * Record this nonce and report whether it was new. False means replay.
   *
   * **This writes.** It was called `check`, which reads as a question — and is
   * how a caller comes to believe it can ask twice, the second ask always
   * answering "replay" against its own first.
   *
   * The name matters more than usual because the write *is* the point: a
   * replay window that did not record on inspection would not be a window.
   */
  claim(identity: string, nonce: string, nowSeconds: number): boolean {
    let forIdentity = this.seen.get(identity);
    if (!forIdentity) {
      forIdentity = new Map();
      this.seen.set(identity, forIdentity);
    } else if (forIdentity.has(nonce)) {
      return false;
    }
    forIdentity.set(nonce, nowSeconds);
    return true;
  }

  /**
   * Drop entries whose `iat` has left the window. Called on a timer rather than
   * on every check: sweeping per request would make a busy identity pay for the
   * whole map, and an entry lingering a few seconds past its window costs a map
   * slot rather than correctness.
   */
  sweep(nowSeconds: number): void {
    const cutoff = nowSeconds - this.windowSeconds;
    for (const [identity, nonces] of this.seen) {
      for (const [nonce, at] of nonces) {
        if (at < cutoff) nonces.delete(nonce);
      }
      if (nonces.size === 0) this.seen.delete(identity);
    }
  }

  /** Entries currently held, for tests and diagnostics. */
  size(): number {
    let n = 0;
    for (const nonces of this.seen.values()) n += nonces.size;
    return n;
  }
}
