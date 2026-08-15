/**
 * `mesh.list_agents` — the registry, with live presence folded in (SPEC § 8.3).
 *
 * Note the per-agent key is `id`, not `identity`. Clients read `agents[].id`.
 */

import { stmtListAgents } from "../db";
import { rpcResult } from "../jsonrpc";
import { onlineAgents } from "../presence";


export function handleListAgents(
  ws: any,
  _params: Record<string, any>,
  id: string | number | null | undefined
): string {
  const rows = stmtListAgents.all() as Array<{
    identity: string;
    description: string | null;
    last_seen: string | null;
    type: string | null;
  }>;

  const agents = rows.map((r) => ({
    id: r.identity,
    description: r.description,
    online: onlineAgents.has(r.identity),
    last_seen: r.last_seen,
    type: r.type,
  }));

  return rpcResult(id, { agents });
}
