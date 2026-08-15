/**
 * `mesh.send` — route an envelope to another identity (SPEC § 8.2).
 */

import { randomUUID } from "node:crypto";

import { stmtInsertMessage, stmtUpdateMessageStatus } from "../db";
import { INVALID_PARAMS, INVALID_REQUEST, rpcError, rpcNotification, rpcResult } from "../jsonrpc";
import { log } from "../log";
import { onlineAgents, proxyMap, wsIdentities } from "../presence";

export function handleSend(
  ws: any,
  params: Record<string, any>,
  id: string | number | null | undefined
): string {
  const senderIdentity = wsIdentities.get(ws);
  if (!senderIdentity) {
    return rpcError(id, INVALID_REQUEST, "Not connected. Call mesh.connect first (or legacy mesh.register).");
  }

  const to = params.to;
  const content = params.content;
  if (!to || typeof to !== "string") {
    return rpcError(id, INVALID_PARAMS, "params.to is required");
  }
  if (content === undefined || content === null) {
    return rpcError(id, INVALID_PARAMS, "params.content is required");
  }

  const msgId = `msg_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const replyTo = params.reply_to ?? null;
  // Allow overriding sender identity (for proxied messages, e.g. from http-server on behalf of a user)
  const effectiveSender = (params.from && typeof params.from === "string") ? params.from : senderIdentity;

  const recipientWs = onlineAgents.get(to) ?? proxyMap.get(to);
  const isOnline = !!recipientWs;
  const status = isOnline ? "delivered" : "pending";

  // Persist message
  stmtInsertMessage.run(msgId, effectiveSender, to, String(content), replyTo, status);

  // Deliver immediately if recipient is online
  if (recipientWs) {
    try {
      recipientWs.send(
        rpcNotification("mesh.message", {
          id: msgId,
          from: effectiveSender,
          to,
          content: String(content),
          reply_to: replyTo,
          ts: new Date().toISOString(),
        })
      );
      log(`delivered: ${effectiveSender} → ${to} (${msgId})`);
      // Notify sender that message was delivered (for typing indicator)
      const senderWs = onlineAgents.get(effectiveSender) ?? proxyMap.get(effectiveSender);
      if (senderWs && senderWs !== recipientWs) {
        try {
          senderWs.send(rpcNotification("mesh.delivered", {
            id: msgId, from: effectiveSender, to, ts: new Date().toISOString(),
          }));
        } catch {}
      }
    } catch (err) {
      // If send fails, mark as pending
      stmtUpdateMessageStatus.run("pending", msgId);
      log(`delivery failed: ${effectiveSender} → ${to} (${msgId}), queued`);
      return rpcResult(id, { id: msgId, status: "pending" });
    }
  } else {
    log(`queued: ${senderIdentity} → ${to} (${msgId})`);
  }

  return rpcResult(id, { id: msgId, status });
}
