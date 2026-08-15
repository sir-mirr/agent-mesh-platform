/**
 * Method dispatch (SPEC § 8).
 *
 * An unknown method is `-32601` rather than a dropped connection: a client
 * speaking a newer protocol should learn what is missing, not be disconnected.
 */

import { INVALID_REQUEST, METHOD_NOT_FOUND, PARSE_ERROR, rpcError, type JsonRpcRequest } from "../jsonrpc";
import { handleListAgents } from "./agents";
import { handleConnect, handleRegister } from "./connect";
import { handleFetchMessages } from "./messages";
import { handleCancelReminder, handleListReminders, handleScheduleReminder } from "./reminders";
import { handleSend } from "./send";

export function dispatch(ws: any, raw: string | Buffer): string | null {
  let req: JsonRpcRequest;
  try {
    req = JSON.parse(typeof raw === "string" ? raw : raw.toString());
  } catch {
    return rpcError(null, PARSE_ERROR, "Parse error");
  }

  if (!req.method || typeof req.method !== "string") {
    return rpcError(req.id, INVALID_REQUEST, "Invalid request: missing method");
  }

  const params = req.params ?? {};

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
    default:
      return rpcError(req.id, METHOD_NOT_FOUND, `Method not found: ${req.method}`);
  }
}
