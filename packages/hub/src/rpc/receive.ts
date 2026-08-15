/**
 * `mesh.receive` — drain what is waiting for the caller (SPEC § 8.5).
 *
 * Delivery has always been push-only: the hub replays pending messages when an
 * identity connects (§ 8.1) and pushes new ones while it stays connected. That
 * assumes a participant which can hold a socket, and some cannot — an agent
 * driven by an application rather than a daemon is awake only while it is
 * answering, and has nowhere to be pushed to in between.
 *
 * So this is the pull half of the same queue. It is not a second store: the
 * pending rows an adapter would have been handed on connect are the rows this
 * returns. The same identity reached either way sees the same inbox.
 *
 * **Reading marks delivered, in one transaction.** The alternative — read now,
 * acknowledge later — has a window in which arriving messages are cleared by an
 * acknowledgement that predates them, and a window that only opens under load
 * is the kind that is found in production. One round trip has no window.
 *
 * The cost is that a caller which drops the response loses those messages. That
 * is the honest trade: a caller can persist what it received before acting on
 * it, which is a thing it can control, whereas it cannot control how long its
 * own turn takes.
 */

import { db, stmtPendingMessages, stmtUpdateMessageStatus } from "../db";
import { INVALID_PARAMS, rpcError, rpcResult } from "../jsonrpc";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export function handleReceive(
  identity: string | null,
  params: Record<string, any>,
  id: string | number | null | undefined,
): string {
  if (!identity) {
    return rpcError(id, INVALID_PARAMS, "no identity: mesh.receive requires a signed request");
  }

  const limit = Math.min(
    Math.max(parseInt(params.limit ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT, 1),
    MAX_LIMIT,
  );

  const rows = stmtPendingMessages.all(identity) as Array<{
    id: string;
    from_agent: string;
    to_agent: string;
    sent_by: string | null;
    content: string;
    reply_to: string | null;
    ts: string;
  }>;

  const page = rows.slice(0, limit);

  // Oldest first, and marked as one unit. A partial mark would leave the caller
  // unable to tell which half it had been handed.
  const tx = db.transaction(() => {
    for (const m of page) stmtUpdateMessageStatus.run("delivered", m.id);
  });
  tx();

  return rpcResult(id, {
    messages: page.map((m) => ({
      id: m.id,
      from: m.from_agent,
      to: m.to_agent,
      sent_by: m.sent_by,
      content: m.content,
      reply_to: m.reply_to,
      ts: m.ts,
    })),
    // So a caller draining a backlog knows to come straight back rather than
    // waiting for its next scheduled check.
    remaining: Math.max(0, rows.length - page.length),
  });
}
