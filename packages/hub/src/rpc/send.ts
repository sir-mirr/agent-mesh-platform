/**
 * `mesh.send` — route an envelope to another identity (SPEC § 8.2).
 */

import { createHash, randomUUID } from "node:crypto";

import { MAILBOX_ERROR } from "@agent-mesh/contracts";
import { entitlement } from "@agent-mesh/store";

import {
  agentsDb,
  db,
  stmtAgentDeleted,
  stmtInsertIdempotency,
  stmtInsertMessage,
  stmtSelectIdempotency,
  stmtUpdateMessageStatus,
} from "../db";
import { INVALID_PARAMS, INVALID_REQUEST, NOT_ENTITLED, rpcError, rpcNotification, rpcResult } from "../jsonrpc";
import { log } from "../log";
import { recordMeshEvent } from "./audit";
import { rawParams } from "../raw-params";
import { onlineAgents, proxyMap, wsIdentities, wsProxies } from "../presence";

const SEND_CONFLICT = MAILBOX_ERROR.SEND_CONFLICT;

/** The sender as it will be recorded, for the idempotency digest. */
function effectiveSenderPreview(params: Record<string, any>, fallback: string): string {
  return params.from && typeof params.from === "string" ? params.from : fallback;
}

export function handleSend(
  ws: any,
  params: Record<string, any>,
  id: string | number | null | undefined,
  raw?: string,
  sig?: unknown,
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

  let idempotencyDigest: string | null = null;

  // Idempotency (SPEC § 8.2). The hub can commit a message and then fail to
  // deliver the response — a lost HTTP reply, an ambiguous disconnect — after
  // which a retry is indistinguishable from a new send *to the hub*. Only the
  // caller knows which it is, so only the caller can supply the key.
  const clientMessageId = params.client_message_id;
  if (clientMessageId !== undefined) {
    if (typeof clientMessageId !== "string" || clientMessageId.length === 0 || clientMessageId.length > 128) {
      return rpcError(id, INVALID_PARAMS, "client_message_id must be a non-empty string of at most 128 chars");
    }
    const digest = createHash("sha256")
      .update(`${to}\u0000${effectiveSenderPreview(params, senderIdentity)}\u0000${String(content)}\u0000${params.reply_to ?? ""}`)
      .digest("hex");
    const prior = stmtSelectIdempotency.get(senderIdentity, clientMessageId) as
      | { request_digest: string; message_id: string; status: string }
      | undefined;
    if (prior) {
      if (prior.request_digest === digest) {
        // The original answer, not a second message. The caller's retry is
        // doing the right thing and must not be punished for it.
        return rpcResult(id, { id: prior.message_id, status: prior.status, duplicate: true });
      }
      // Permanent. The key is how a retry is told from a new send, so a key
      // that means two things means neither — and no amount of retrying fixes
      // a caller that reused one.
      return rpcError(
        id,
        SEND_CONFLICT,
        `client_message_id '${clientMessageId}' was already used for a different message`,
        { code: "SEND_CONFLICT", client_message_id: clientMessageId },
      );
    }
    idempotencyDigest = digest;
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

  // SPEC § 8.2. Two conditions, checked against the database rather than
  // against what the socket claimed at connect: an operator who withdraws the
  // grant, or tears the subject down, means it from that moment rather than
  // from whenever this socket next reconnects. The declared `proxy_for` set is
  // also required, so a socket cannot speak for someone it never announced.
  if (proxied) {
    const verdict = entitlement.mayProxy(agentsDb, senderIdentity, effectiveSender);
    if (!verdict.ok) {
      log(`refused: ${senderIdentity} claimed to be ${effectiveSender} (${verdict.reason})`);
      return rpcError(id, NOT_ENTITLED, entitlement.refusalMessage(effectiveSender, verdict.reason!));
    }
    if (!wsProxies.get(ws)?.has(effectiveSender)) {
      log(`refused: ${senderIdentity} did not declare ${effectiveSender} in proxy_for`);
      return rpcError(
        id,
        NOT_ENTITLED,
        `'${effectiveSender}' was not declared in this socket's proxy_for`,
      );
    }
  }
  const route = proxied
    ? `${effectiveSender} (via ${senderIdentity}) → ${to}`
    : `${effectiveSender} → ${to}`;

  const recipientWs = onlineAgents.get(to) ?? proxyMap.get(to);
  const isOnline = !!recipientWs;
  const status = isOnline ? "delivered" : "pending";

  // The message and its idempotency record commit together, so a crash between
  // them cannot leave a key that names a message which does not exist, or a
  // message a retry would duplicate.
  const persist = db.transaction(() => {
    stmtInsertMessage.run(msgId, effectiveSender, to, senderIdentity, String(content), replyTo, status);
    if (idempotencyDigest !== null && typeof clientMessageId === "string") {
      stmtInsertIdempotency.run(senderIdentity, clientMessageId, idempotencyDigest, msgId, status);
    }
  });
  persist();

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

  // Recorded after the routing decision, so the event states what actually
  // happened rather than what was attempted (SPEC § 8.9.4).
  recordMeshEvent(status === "delivered" ? "mesh.message.delivered" : "mesh.message.pending", {
    messageId: msgId,
    from: effectiveSender,
    to,
    sentBy: senderIdentity,
    content: String(content),
    replyTo: replyTo,
    senderSig: sig,
    senderParams: raw ? rawParams(raw) ?? "{}" : "{}",
  });

  return rpcResult(id, { id: msgId, status });
}
