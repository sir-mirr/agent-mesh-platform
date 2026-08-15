/**
 * `mesh.fetch_messages` — recent history with one peer (SPEC § 8.4).
 *
 * There is no cursor: § 8.4 dropped the `before` parameter as unimplemented,
 * so a caller can reach back only as far as `limit` allows.
 */

import { stmtFetchMessages } from "../db";
import { INVALID_PARAMS, INVALID_REQUEST, rpcError, rpcResult } from "../jsonrpc";
import { wsIdentities } from "../presence";

export function handleFetchMessages(
  ws: any,
  params: Record<string, any>,
  id: string | number | null | undefined
): string {
  const callerIdentity = wsIdentities.get(ws);
  if (!callerIdentity) {
    return rpcError(id, INVALID_REQUEST, "Not connected. Call mesh.connect first (or legacy mesh.register).");
  }

  const agentId = params.agent_id;
  if (!agentId || typeof agentId !== "string") {
    return rpcError(id, INVALID_PARAMS, "params.agent_id is required");
  }

  const limit = Math.min(Math.max(parseInt(params.limit ?? "20", 10) || 20, 1), 200);

  const rows = stmtFetchMessages.all(callerIdentity, agentId, limit) as Array<{
    id: string;
    from_agent: string;
    to_agent: string;
    sent_by: string | null;
    content: string;
    reply_to: string | null;
    status: string;
    ts: string;
  }>;

  const messages = rows.map((r) => ({
    id: r.id,
    from: r.from_agent,
    to: r.to_agent,
    sent_by: r.sent_by,
    content: r.content,
    reply_to: r.reply_to,
    status: r.status,
    ts: r.ts,
  }));

  return rpcResult(id, { messages });
}
