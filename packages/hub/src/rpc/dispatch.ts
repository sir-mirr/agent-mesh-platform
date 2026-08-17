/**
 * Method dispatch (SPEC § 8).
 *
 * An unknown method is `-32601` rather than a dropped connection: a client
 * speaking a newer protocol should learn what is missing, not be disconnected.
 */

import { INVALID_REQUEST, METHOD_NOT_FOUND, PARSE_ERROR, rpcError, type JsonRpcRequest } from "../jsonrpc";
import { keys, sources } from "@agent-mesh/store";

import { agentsDb } from "../db";
import { wsIdentities, wsProxies } from "../presence";
import { handleReceive } from "./receive";
import { KEY_NOT_APPROVED, verifyRequest, type SignatureEnvelope } from "../signature";
import { dropConnection } from "../presence";
import { handleListAgents } from "./agents";
import { handleConnect, handleRegister } from "./connect";
import { handleFetchMessages } from "./messages";
import { handleCancelReminder, handleListReminders, handleScheduleReminder } from "./reminders";
import { handleAuditAppend, handlePrepareBlobs } from "./audit";
import { handleSend } from "./send";

/**
 * Dispatch a request that arrived over HTTP rather than a socket (SPEC § 8.10).
 *
 * A participant driven by an application rather than a daemon is awake only
 * while it is answering, so it can neither hold a socket nor be pushed to. It
 * gets the same methods over one request each.
 *
 * **The identity comes from the signature**, resolved through `sig.kid`. At most
 * one key per identity is approved, so a fingerprint names exactly one
 * participant — and a caller that instead *claimed* an identity alongside its
 * signature would be stating something the signature already settles, which is
 * an opportunity to disagree with itself.
 *
 * A signature is therefore required here even for a type that may connect
 * unsigned over a socket. That is not an extra rule so much as the absence of
 * one: without a socket to have connected on, an unsigned request carries
 * nothing that says who is asking.
 */
export function dispatchHttp(raw: string, observed: string | null = null): { status: number; body: string } {
  let req: JsonRpcRequest & { sig?: SignatureEnvelope };
  try {
    req = JSON.parse(raw);
  } catch {
    return { status: 400, body: rpcError(null, PARSE_ERROR, "Parse error") };
  }
  if (!req.method || typeof req.method !== "string") {
    return { status: 400, body: rpcError(req.id, INVALID_REQUEST, "Invalid request: missing method") };
  }

  const kid = typeof req.sig?.kid === "string" ? req.sig.kid : null;
  if (!kid) {
    return {
      status: 401,
      body: rpcError(req.id, INVALID_REQUEST, "requests over HTTP must be signed — there is no socket to identify the caller"),
    };
  }

  const identity = keys.identityForFingerprint(agentsDb, kid);
  if (!identity) {
    // § 8.10 carries § 8.1's error codes over unchanged, so this is
    // `-32014` with `key_status` — not a generic invalid request. A client
    // reaching the mesh this way has no `mesh.connect` to have learned its
    // state from, so this response is the only thing that tells it whether to
    // wait for an operator or to stop.
    //
    // The identity is not named. `identityForFingerprint` answers for approved
    // keys only, and reporting the holder here would build the key-to-identity
    // lookup the contract deliberately lacks.
    const keyStatus = keys.statusOfFingerprint(agentsDb, kid);
    return {
      status: 403,
      body: rpcError(req.id, KEY_NOT_APPROVED, `no approved key with fingerprint ${kid}`, {
        code: "KEY_NOT_APPROVED",
        key_status: keyStatus,
      }),
    };
  }

  const verdict = verifyRequest(identity, req.method, req.sig, raw);
  if (!verdict.ok) {
    return { status: 401, body: rpcError(req.id, verdict.code, verdict.message, verdict.data) };
  }

  // § 8.11. After the signature verifies and before anything acts on it: the
  // record is of an *authenticated* request, so an unverified one must not
  // create a source row for an identity it only claimed.
  sources.recordSource(agentsDb, identity, observed);

  const params = req.params ?? {};

  // A stand-in socket, registered only for the life of this call. It is never
  // put in `onlineAgents`, which is correct rather than a shortcut: there is
  // nowhere to push to, so the caller must not appear online to a sender who
  // would then be told its message was delivered.
  // § 8.11.2 reads this off the caller; a socketless request has no socket
  // to hang it on, so the stand-in carries it.
  const caller = { httpCaller: true, identity, observed };
  wsIdentities.set(caller, identity);
  try {
    switch (req.method) {
      case "mesh.receive":
        return { status: 200, body: handleReceive(identity, params, req.id)! };
      case "mesh.send":
        return { status: 200, body: handleSend(caller, params, req.id, raw, req.sig)! };
      case "mesh.list_agents":
        return { status: 200, body: handleListAgents(caller, params, req.id)! };
      case "mesh.fetch_messages":
        return { status: 200, body: handleFetchMessages(caller, params, req.id)! };
      case "mesh.audit.prepare_blobs":
        return { status: 200, body: handlePrepareBlobs(caller, params, req.id)! };
      case "mesh.audit.append":
        return { status: 200, body: handleAuditAppend(caller, params, req.id, raw, req.sig)! };
      // mesh.connect and mesh.register are absent on purpose: they mark a socket
      // online, and there is no socket. An HTTP caller is never online.
      default:
        return {
          status: 404,
          body: rpcError(req.id, METHOD_NOT_FOUND, `Method not available over HTTP: ${req.method}`),
        };
    }
  } finally {
    wsIdentities.delete(caller);
    wsProxies.delete(caller);
  }
}

export function dispatch(ws: any, raw: string | Buffer): string | null {
  const text = typeof raw === "string" ? raw : raw.toString();

  let req: JsonRpcRequest & { sig?: SignatureEnvelope };
  try {
    req = JSON.parse(text);
  } catch {
    return rpcError(null, PARSE_ERROR, "Parse error");
  }

  if (!req.method || typeof req.method !== "string") {
    return rpcError(req.id, INVALID_REQUEST, "Invalid request: missing method");
  }

  const params = req.params ?? {};

  // The identity the request speaks as. A connect names it in params — there is
  // no socket identity yet — and everything else inherits it from the socket.
  // Verification is against that identity's key, so a connect that lies about
  // it fails against the wrong key rather than succeeding.
  const speakingAs =
    req.method === "mesh.connect" || req.method === "mesh.register"
      ? typeof (params as any).identity === "string"
        ? (params as any).identity
        : null
      : wsIdentities.get(ws) ?? null;

  // No identity yet means nothing to verify against; the handler will reject it
  // for its own reasons — a connect without `identity`, or a call before
  // connecting. Checking here would replace those errors with a vaguer one.
  if (speakingAs) {
    const verdict = verifyRequest(speakingAs, req.method, req.sig, text);
    if (!verdict.ok) {
      // § 8.1: the hub MUST close any connection it holds for an identity whose
      // key is not approved, as soon as it observes that — which, because key
      // state is read per request, is here.
      //
      // Returning the error alone left the socket in `onlineAgents`, so a
      // revoked identity still read as online to `mesh.list_agents` and still
      // received pushed messages. Revocation that leaves the connection
      // receiving is not revocation.
      if (verdict.code === KEY_NOT_APPROVED) {
        const error = rpcError(req.id, verdict.code, verdict.message, verdict.data);
        // Sent before the close so the client learns why rather than seeing an
        // unexplained disconnect; 1008 is the policy-violation close § 8.1 uses
        // for its other two eviction cases.
        try { ws.send(error); } catch {}
        dropConnection(ws, speakingAs);
        try { ws.close(1008, "key not approved"); } catch {}
        return null;
      }
      return rpcError(req.id, verdict.code, verdict.message, verdict.data);
    }
  }

  switch (req.method) {
    case "mesh.connect":
      return handleConnect(ws, params, req.id);
    case "mesh.register":
      return handleRegister(ws, params, req.id);
    case "mesh.send":
      return handleSend(ws, params, req.id, text, req.sig);
    case "mesh.list_agents":
      return handleListAgents(ws, params, req.id);
    case "mesh.fetch_messages":
      return handleFetchMessages(ws, params, req.id);
    case "mesh.schedule_reminder":
      return handleScheduleReminder(ws, params, req.id);
    case "mesh.cancel_reminder":
      return handleCancelReminder(ws, params, req.id);
    case "mesh.list_reminders":
      return handleListReminders(ws, params, req.id);
    case "mesh.receive":
      return handleReceive(wsIdentities.get(ws) ?? null, params, req.id);
    case "mesh.audit.prepare_blobs":
      return handlePrepareBlobs(ws, params, req.id);
    case "mesh.audit.append":
      // `text` and `req.sig` are passed through because the record's digest is
      // over the received bytes and its attestation is the verified signature —
      // neither can be rebuilt from the parsed object (SPEC § 8.9.3).
      return handleAuditAppend(ws, params, req.id, text, req.sig);
    default:
      return rpcError(req.id, METHOD_NOT_FOUND, `Method not found: ${req.method}`);
  }
}
