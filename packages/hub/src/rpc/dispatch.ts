/**
 * Method dispatch (SPEC § 8).
 *
 * An unknown method is `-32601` rather than a dropped connection: a client
 * speaking a newer protocol should learn what is missing, not be disconnected.
 */

import { INVALID_REQUEST, METHOD_NOT_FOUND, PARSE_ERROR, rpcError, type JsonRpcRequest } from "../jsonrpc";
import { wsIdentities } from "../presence";
import { verifyRequest, type SignatureEnvelope } from "../signature";
import { handleListAgents } from "./agents";
import { handleConnect, handleRegister } from "./connect";
import { handleFetchMessages } from "./messages";
import { handleCancelReminder, handleListReminders, handleScheduleReminder } from "./reminders";
import { handlePrepareBlobs } from "./audit";
import { handleSend } from "./send";

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
      return rpcError(req.id, verdict.code, verdict.message, verdict.data);
    }
  }

  switch (req.method) {
    case "mesh.connect":
      return handleConnect(ws, params, req.id);
    case "mesh.register":
      return handleRegister(ws, params, req.id);
    case "mesh.send":
      return handleSend(ws, params, req.id);
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
    case "mesh.audit.prepare_blobs":
      return handlePrepareBlobs(ws, params, req.id);
    default:
      return rpcError(req.id, METHOD_NOT_FOUND, `Method not found: ${req.method}`);
  }
}
