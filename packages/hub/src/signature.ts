/**
 * Request signature verification (SPEC § 8.1).
 *
 * Every request over the hub socket — `mesh.connect` included — carries a `sig`
 * member alongside `method` and `params`. It is not inside `params` because
 * JSON-RPC has no header slot and `params` belongs to each method's schema.
 *
 * Whether a signature is *required* is a property of the identity's type, not
 * of whether it happens to have a key. `requires_key = 1` means there is no
 * unsigned path at all. An earlier draft verified only where an approved key
 * already existed, which read as backward compatibility and was an open door:
 * register without a key, then connect unsigned, skipping the authentication
 * the audit trail depends on.
 */

import {
  SIGNATURE_FRESHNESS_WINDOW_SECONDS,
  requestSignaturePreimage,
} from "@agent-mesh/contracts";
import { agentsSchema, verify } from "@agent-mesh/store";

import { agentsDb, stmtSelectAgent } from "./db";
import { rawParams } from "./raw-params";
import { recordRefusal } from "./refusals";
import { log } from "./log";

export const SIGNATURE_INVALID = -32012;
export const KEY_NOT_APPROVED = -32014;

const nonces = new verify.NonceWindow(SIGNATURE_FRESHNESS_WINDOW_SECONDS);

// Sweeping on a timer rather than per request: a busy identity would otherwise
// pay for the whole map on every call, and an entry outliving its window by a
// few seconds costs a map slot, not correctness.
setInterval(() => nonces.sweep(Math.floor(Date.now() / 1000)), 60_000).unref?.();

export interface SignatureEnvelope {
  alg?: unknown;
  kid?: unknown;
  nonce?: unknown;
  iat?: unknown;
  value?: unknown;
}

/**
 * The bounded label a refusal is counted under.
 *
 * **A field, not a sentence to be read back.** It was derived by matching the
 * message this file had just written — and one of the seven never matched:
 * the unsigned case says *identity 'x' requires a signature on every request*
 * while the map looked for `signature required`, so every request from an agent
 * that is not signing at all was counted as `invalid`. Those are opposite
 * diagnoses. `invalid` says somebody is sending signatures that do not verify,
 * which is what an attack looks like; `unsigned` says a client is misconfigured
 * and its operator has to load a key. The first was the one an operator saw.
 *
 * Naming the reason where the refusal is decided cannot drift, because there is
 * no second copy of the message to keep in step.
 */
export type SignatureRefusal =
  | "unsigned"
  | "malformed"
  | "stale"
  | "replayed-nonce"
  | "key-not-approved"
  | "wrong-key"
  | "invalid";

export type SignatureVerdict =
  | { ok: true; signed: boolean }
  | { ok: false; code: number; message: string; reason: SignatureRefusal; data?: Record<string, unknown> };

const OK_UNSIGNED: SignatureVerdict = { ok: true, signed: false };
const OK_SIGNED: SignatureVerdict = { ok: true, signed: true };

function requiresKey(identity: string): boolean {
  const agent = stmtSelectAgent.get(identity) as { type: string | null } | undefined;
  if (!agent?.type) return false;
  return agentsSchema.getType(agentsDb, agent.type)?.requires_key === 1;
}

/**
 * Check the signature on one request.
 *
 * `identity` is the one the request speaks as — from `params.identity` on a
 * connect, from the socket otherwise. It is the subject of the verification,
 * so a connect that lies about it fails against the wrong key rather than
 * succeeding.
 */
export function verifyRequest(
  identity: string,
  method: string,
  sig: SignatureEnvelope | undefined,
  raw: string,
): SignatureVerdict {
  const verdict = verifyRequestInner(identity, method, sig, raw);
  // **Counted here, at the one exit, rather than at each refusal.** There are
  // six `ok: false` returns below and a seventh added next year would be
  // missed silently — a counter that undercounts reads as calm, which is the
  // failure this exists to prevent. Wrapping cannot drift.
  //
  // The label travels on the verdict rather than being read back off the
  // message; `SignatureRefusal` says what that cost.
  if (!verdict.ok) recordRefusal("signature", verdict.reason);
  return verdict;
}

function verifyRequestInner(
  identity: string,
  method: string,
  sig: SignatureEnvelope | undefined,
  raw: string,
): SignatureVerdict {
  const mustSign = requiresKey(identity);

  if (!sig) {
    if (!mustSign) return OK_UNSIGNED;
    return {
      ok: false,
      code: SIGNATURE_INVALID,
      message: `identity '${identity}' requires a signature on every request`,
      reason: "unsigned",
    };
  }

  const { alg, kid, nonce, iat, value } = sig;
  if (
    alg !== "ed25519" ||
    typeof kid !== "string" ||
    typeof nonce !== "string" ||
    typeof iat !== "number" ||
    typeof value !== "string" ||
    !Number.isInteger(iat)
  ) {
    return { ok: false, code: SIGNATURE_INVALID, message: "malformed sig", reason: "malformed" };
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - iat) > SIGNATURE_FRESHNESS_WINDOW_SECONDS) {
    return {
      ok: false,
      code: SIGNATURE_INVALID,
      message: `iat outside the ±${SIGNATURE_FRESHNESS_WINDOW_SECONDS}s freshness window`,
      reason: "stale",
    };
  }

  // Freshness first, then replay. A stale request is rejected without its nonce
  // ever entering the window, so an attacker cannot fill the map with entries
  // that were never going to be accepted.
  //
  // **The nonce is spent here, before the signature is checked.** A request
  // whose signature then fails has still consumed it, so a client retrying
  // that request MUST use a fresh nonce (§ 8.1). The alternative — recording
  // only on success — would let an attacker replay a captured envelope
  // unboundedly against a hub whose key state had changed, because each
  // attempt would fail verification and leave the nonce spendable.
  if (!nonces.claim(identity, nonce, iat)) {
    return {
      ok: false,
      code: SIGNATURE_INVALID,
      message: "nonce already seen in this window",
      reason: "replayed-nonce",
    };
  }

  const preimage = requestSignaturePreimage({
    method,
    kid,
    nonce,
    iat,
    // UTF-8 bytes of the substring as it arrived. The encoder counts bytes,
    // not characters, which is why a multi-byte body has to reach it as bytes.
    rawParams: new TextEncoder().encode(rawParams(raw) ?? "{}"),
  });

  const outcome = verify.verifyForIdentity(agentsDb, identity, kid, preimage, value);
  if (outcome.ok) return OK_SIGNED;

  if (outcome.reason === "no-approved-key") {
    // Distinguished from a bad signature because a client acts differently:
    // `pending` means wait for an operator, `denied` or `revoked` mean stop and
    // ask a human. Reporting them all as one error would make a client retry
    // through a shutoff.
    log.warn(`rejected ${method}: the signing key is not approved`, "signature_rejected", {
      actor: identity,
      method,
      outcome: "refused",
      reason: `key_${outcome.keyStatus}`,
    });
    return {
      ok: false,
      code: KEY_NOT_APPROVED,
      message: `identity '${identity}' has no approved signing key`,
      reason: "key-not-approved",
      data: { code: "KEY_NOT_APPROVED", identity, key_status: outcome.keyStatus },
    };
  }

  log.warn(`rejected ${method}: the signature did not verify`, "signature_rejected", {
    actor: identity,
    method,
    outcome: "refused",
    reason: outcome.reason,
  });
  return {
    ok: false,
    code: SIGNATURE_INVALID,
    message:
      outcome.reason === "wrong-key"
        ? "signed with a key that is not this identity's approved key"
        : "signature does not verify",
    reason: outcome.reason === "wrong-key" ? "wrong-key" : "invalid",
  };
}

export { rawParams };

/** Test seam: the nonce window is process-wide and otherwise unreachable. */
export const nonceWindow = nonces;
