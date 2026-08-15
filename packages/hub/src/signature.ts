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

export type SignatureVerdict =
  | { ok: true; signed: boolean }
  | { ok: false; code: number; message: string; data?: Record<string, unknown> };

const OK_UNSIGNED: SignatureVerdict = { ok: true, signed: false };
const OK_SIGNED: SignatureVerdict = { ok: true, signed: true };

/**
 * Extract the exact bytes of the `params` member from the received text.
 *
 * **The preimage covers the bytes as they arrived, not a re-serialisation.**
 * JSON has no canonical byte form: key order, whitespace, number formatting and
 * string escaping all survive a parse/stringify round trip differently, so a
 * preimage rebuilt from the parsed object can differ from the one the client
 * signed even when the content is identical. That failure is intermittent — it
 * depends on what the client's serialiser happened to emit — which is worse
 * than a consistent one.
 *
 * The scan is string-aware because it has to be: `"params"` may legitimately
 * appear inside a string value, and matching it there would capture the wrong
 * span. Only a key at depth 1 counts.
 *
 * Returns null when there is no `params` member, which is a valid request with
 * no parameters — the caller signs `{}` in that case, matching the encoder.
 */
export function rawParams(text: string): string | null {
  let depth = 0;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i]!;

    if (ch === '"') {
      const start = i;
      i = skipString(text, i);
      // A key at depth 1 is followed by a colon; anything else is a value.
      if (depth === 1 && text.slice(start, i) === '"params"') {
        let j = i;
        while (j < n && /\s/.test(text[j]!)) j++;
        if (text[j] === ":") {
          j++;
          while (j < n && /\s/.test(text[j]!)) j++;
          const end = skipValue(text, j);
          return end > j ? text.slice(j, end) : null;
        }
      }
      continue;
    }

    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
    i++;
  }
  return null;
}

/** Index just past the closing quote of the string starting at `i`. */
function skipString(text: string, i: number): number {
  i++; // opening quote
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === '"') return i + 1;
    i++;
  }
  return i;
}

/** Index just past the JSON value starting at `i`. */
function skipValue(text: string, i: number): number {
  const ch = text[i];
  if (ch === '"') return skipString(text, i);
  if (ch === "{" || ch === "[") {
    let depth = 0;
    while (i < text.length) {
      const c = text[i]!;
      if (c === '"') {
        i = skipString(text, i);
        continue;
      }
      if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
    return i;
  }
  // A literal: number, true, false, null. Ends at the next structural character.
  while (i < text.length && !",}] \t\n\r".includes(text[i]!)) i++;
  return i;
}

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
  const mustSign = requiresKey(identity);

  if (!sig) {
    if (!mustSign) return OK_UNSIGNED;
    return {
      ok: false,
      code: SIGNATURE_INVALID,
      message: `identity '${identity}' requires a signature on every request`,
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
    return { ok: false, code: SIGNATURE_INVALID, message: "malformed sig" };
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - iat) > SIGNATURE_FRESHNESS_WINDOW_SECONDS) {
    return {
      ok: false,
      code: SIGNATURE_INVALID,
      message: `iat outside the ±${SIGNATURE_FRESHNESS_WINDOW_SECONDS}s freshness window`,
    };
  }

  // Freshness first, then replay. A stale request is rejected without its nonce
  // ever entering the window, so an attacker cannot fill the map with entries
  // that were never going to be accepted.
  if (!nonces.check(identity, nonce, iat)) {
    return { ok: false, code: SIGNATURE_INVALID, message: "nonce already seen in this window" };
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
    log(`rejected ${method} from ${identity}: ${outcome.keyStatus} key`);
    return {
      ok: false,
      code: KEY_NOT_APPROVED,
      message: `identity '${identity}' has no approved signing key`,
      data: { code: "KEY_NOT_APPROVED", identity, key_status: outcome.keyStatus },
    };
  }

  log(`rejected ${method} from ${identity}: ${outcome.reason}`);
  return {
    ok: false,
    code: SIGNATURE_INVALID,
    message:
      outcome.reason === "wrong-key"
        ? "signed with a key that is not this identity's approved key"
        : "signature does not verify",
  };
}

/** Test seam: the nonce window is process-wide and otherwise unreachable. */
export const nonceWindow = nonces;
