/**
 * `mesh.send` — route an envelope to another identity (SPEC § 8.2).
 */

import { randomUUID } from "node:crypto";

import { stmtAgentDeleted, stmtInsertMessage, stmtUpdateMessageStatus } from "../db";
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

  // Queueing for an unknown recipient is intended (SPEC § 3.1) — it may be
  // provisioned later. A torn-down one never will be, so the message would sit
  // pending forever with nobody noticing.
  if (stmtAgentDeleted.get(to)) {
    return rpcError(id, INVALID_PARAMS, `recipient '${to}' has been deleted`);
  }

  const msgId = `msg_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const replyTo = params.reply_to ?? null;

  // Two identities, and the difference is the point. `from` is who the message
  // is from and may be overridden by a proxy — the http server forwarding for a
  // logged-in web user, which is why the override exists at all. `senderIdentity`
  // is the socket that actually sent it, taken from the connection rather than
  // from params, so a caller cannot state it.
  //
  // Until this was recorded the override erased the transmitter: a proxied
  // message was stored as though the claimed sender wrote it, and nothing
  // anywhere said otherwise. Entitlement (SPEC § 8.2, step 6) decides whether an
  // override is *allowed*; recording the pair is what makes the answer auditable
  // either way, and it is the half that does not depend on entitlement existing.
  const effectiveSender = (params.from && typeof params.from === "string") ? params.from : senderIdentity;
  const proxied = effectiveSender !== senderIdentity;
  const route = proxied
    ? `${effectiveSender} (via ${senderIdentity}) → ${to}`
    : `${effectiveSender} → ${to}`;

  const recipientWs = onlineAgents.get(to) ?? proxyMap.get(to);
  const isOnline = !!recipientWs;
  const status = isOnline ? "delivered" : "pending";

  // Persist message
  stmtInsertMessage.run(msgId, effectiveSender, to, senderIdentity, String(content), replyTo, status);

  // Deliver immediately if recipient is online
  if (recipientWs) {
    try {
      recipientWs.send(
        rpcNotification("mesh.message", {
          id: msgId,
          from: effectiveSender,
          to,
          sent_by: senderIdentity,
          content: String(content),
          reply_to: replyTo,
          ts: new Date().toISOString(),
        })
      );
      log(`delivered: ${route} (${msgId})`);
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
      log(`delivery failed: ${route} (${msgId}), queued`);
      return rpcResult(id, { id: msgId, status: "pending" });
    }
  } else {
    log(`queued: ${route} (${msgId})`);
  }

  return rpcResult(id, { id: msgId, status });
}
