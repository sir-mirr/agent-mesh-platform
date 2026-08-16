/**
 * Authenticating a signed REST request (SPEC § 9.2.1).
 *
 * The JSON-RPC transport puts its signature in the request body as a `sig`
 * sibling. A REST route cannot: a `GET` has no body worth signing and a
 * `DELETE` may have none at all. So the signature moves to the header, over a
 * preimage with its own domain separator — one key now signs three
 * constructions, and two signatures replayable into each other's position are
 * one signature.
 *
 * This runs the same checks in the same order as `dispatchHttp`, and the order
 * is the interesting part:
 *
 *   1. header present and parseable
 *   2. freshness, *before* the nonce is recorded — otherwise anyone can fill
 *      the replay window with nonces that were never going to be accepted
 *   3. the nonce is **claimed**, spending it whether or not what follows
 *      succeeds (§ 8.1)
 *   4. the fingerprint resolves to an identity, or `-32014` says why not
 *   5. the signature verifies against that identity's approved key
 *
 * Step 4 answers with `key_status` and never with the holder's name. Reporting
 * the identity would build the key-to-identity lookup the contract deliberately
 * lacks, probeable by anyone who can reach the port.
 */

import { createHash } from "node:crypto";

import {
  MESH_ERROR,
  SIGNATURE_FRESHNESS_WINDOW_SECONDS,
  parseRestAuthorization,
  restSignaturePreimage,
} from "@agent-mesh/contracts";
import { keys, verify } from "@agent-mesh/store";

import { agentsDb } from "../db";
import { nonceWindow } from "../signature";

export interface SignedCaller {
  identity: string;
  kid: string;
}

export interface SignedRefusal {
  status: number;
  body: Record<string, unknown>;
}

export type SignedResult =
  | { ok: true; caller: SignedCaller }
  | { ok: false; refusal: SignedRefusal };

function refuse(
  status: number,
  rpcCode: number,
  error: string,
  code: string,
  extra: Record<string, unknown> = {},
): SignedResult {
  // The JSON-RPC code travels in the body because a status code cannot carry
  // the retry policy: `403` is permanent for NOT_ENTITLED and wait-approval for
  // KEY_NOT_APPROVED, and `ERROR_CLASS` is keyed on the number.
  return { ok: false, refusal: { status, body: { ok: false, error, code, rpc_code: rpcCode, ...extra } } };
}

/**
 * Verify one request.
 *
 * `path` must be what went on the wire, query string included — the preimage
 * covers it, so an attacker able to rewrite `?peer=` could otherwise redirect a
 * history read while the signature still verified.
 */
export function authenticate(method: string, path: string, headerValue: string | null, body: string): SignedResult {
  if (!headerValue) {
    return refuse(401, MESH_ERROR.SIGNATURE_INVALID, "requests to this surface must be signed", "SIGNATURE_INVALID");
  }
  const auth = parseRestAuthorization(headerValue);
  if (!auth) {
    return refuse(401, MESH_ERROR.SIGNATURE_INVALID, "malformed AgentMeshSig authorization", "SIGNATURE_INVALID");
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - auth.iat) > SIGNATURE_FRESHNESS_WINDOW_SECONDS) {
    return refuse(
      401,
      MESH_ERROR.SIGNATURE_INVALID,
      `iat outside the ±${SIGNATURE_FRESHNESS_WINDOW_SECONDS}s freshness window`,
      "SIGNATURE_INVALID",
    );
  }

  // Spent here, before anything else can fail. A request whose signature then
  // fails has still consumed it, so a retry needs a fresh one — recording only
  // on success would leave a captured request replayable without limit.
  if (!nonceWindow.claim(auth.kid, auth.nonce, auth.iat)) {
    return refuse(401, MESH_ERROR.SIGNATURE_INVALID, "nonce already seen in this window", "SIGNATURE_INVALID");
  }

  const identity = keys.identityForFingerprint(agentsDb, auth.kid);
  if (!identity) {
    return refuse(403, MESH_ERROR.KEY_NOT_APPROVED, `no approved key with fingerprint ${auth.kid}`, "KEY_NOT_APPROVED", {
      key_status: keys.statusOfFingerprint(agentsDb, auth.kid),
    });
  }

  const bodySha256 = body.length > 0 ? createHash("sha256").update(body, "utf8").digest("hex") : "";
  const outcome = verify.verifyForIdentity(
    agentsDb,
    identity,
    auth.kid,
    restSignaturePreimage({
      method,
      path,
      kid: auth.kid,
      nonce: auth.nonce,
      iat: auth.iat,
      bodySha256,
    }),
    auth.signature,
  );
  if (!outcome.ok) {
    return refuse(401, MESH_ERROR.SIGNATURE_INVALID, `signature does not verify (${outcome.reason})`, "SIGNATURE_INVALID");
  }

  return { ok: true, caller: { identity, kid: auth.kid } };
}

/**
 * The nonce window is keyed on the fingerprint rather than the identity here.
 *
 * On the JSON-RPC path the identity is resolved first and keys the window. Here
 * the nonce is claimed *before* resolution, because a request whose key is not
 * approved must not get a free replay of the same nonce once it is. The
 * fingerprint names the same holder and is available earlier.
 */
export const NONCE_KEYED_ON = "fingerprint" as const;
