/**
 * `mesh.connect`, its deprecated `mesh.register` alias, and the pending-message
 * replay that follows a successful connect (SPEC § 8.1, § 8.1a).
 */

import { stmtAgentExists, stmtPendingMessages, stmtUpdateLastSeen, stmtUpdateMessageStatus,
  agentsDb,
} from "../db";
import {
  DUPLICATE_IDENTITY,
  IDENTITY_NOT_REGISTERED,
  INVALID_PARAMS,
  rpcError,
  rpcNotification,
  rpcResult,
} from "../jsonrpc";
import { entitlement } from "@agent-mesh/store";

import { AUDIT_LIMITS, MAX_SCHEMA_VERSION } from "./audit-limits";

import { log } from "../log";
import { connectionOwnership, onlineAgents, proxyMap, wsIdentities, wsProxies } from "../presence";


/**
 * Core connect logic shared by `mesh.connect` (SSOT v2) and the legacy
 * `mesh.register` alias. Handles:
 *  - params validation
 *  - duplicate-identity ownership guard (first established owner wins)
 *  - pre-registration check (task #72 — `POST /api/v1/agents` is the registration SSOT; `/api/agents` is a legacy alias)
 *  - online map bookkeeping (onlineAgents / wsIdentities / proxyMap / wsProxies)
 *  - last_seen touch
 *  - pending message delivery
 *
 * NOTE: No DB UPSERT here. Registration (INSERT of identity/type/description)
 * is owned by `POST /api/v1/agents` (canonical; `/api/agents` is a legacy
 * alias — see SPEC §10.1). This handler only records the fact that the
 * agent is currently connected (via last_seen touch) and wires the online maps.
 *
 * @param via   "connect" | "register"  —  used for log prefix / deprecation tag
 */
export function performConnect(
  ws: any,
  params: Record<string, any>,
  id: string | number | null | undefined,
  via: "connect" | "register"
): string {
  const identity = params.identity;
  if (!identity || typeof identity !== "string") {
    return rpcError(id, INVALID_PARAMS, "params.identity is required");
  }

  // ── Pre-registration check (task #72 — POST /api/v1/agents is the SSOT) ─
  // With the provisioning endpoint shipped, every identity must exist in
  // the agents table before it can connect via WebSocket. Canonical route
  // is POST /api/v1/agents (SPEC §10.1); the unversioned /api/agents is a
  // legacy alias. This stops the old "mesh.register auto-creates a typeless
  // row" pattern that left new identities with type=NULL → UI showing
  // "Unknown" forever. A clear error lets the operator (or the agent-manage
  // skill) know to POST first. We also close the WebSocket (1008 policy
  // violation) shortly after emitting the error so the misconfigured client
  // can't keep the socket open.
  const exists = !!stmtAgentExists.get(identity);
  if (!exists) {
    log(
      `${via}-rejected: ${identity} (not pre-registered; POST /api/v1/agents required — ` +
      `task #72 SSOT policy)`
    );
    setTimeout(() => {
      try {
        ws.close(1008, "identity not registered");
      } catch {}
    }, 10);
    return rpcError(
      id,
      -32011,
      `identity '${identity}' not registered. POST /api/agents first.`,
      { code: "IDENTITY_NOT_REGISTERED", identity }
    );
  }

  // ── Connection ownership (P0 self-reminder stall remediation) ──────────
  // A live owner is never evicted by a contender, whether the collision is
  // immediate or much later. Metadata is server-generated connection sequence
  // only: it is sufficient to correlate a race without exposing source IP,
  // payload, context, or credentials.
  const ownership = connectionOwnership.claim(identity, ws);
  if (!ownership.ok) {
    log(
      `${via}-rejected duplicate identity=${identity} ` +
      `incumbent_generation=${ownership.incumbentGeneration} contender_generation=${ownership.contenderGeneration}`
    );
    setTimeout(() => {
      try { ws.close(1008, "duplicate identity owner active"); } catch {}
    }, 10);
    return rpcError(
      id,
      -32010,
      `duplicate identity "${identity}": an established owner remains connected`,
      {
        code: "DUPLICATE_IDENTITY",
        ownership: "incumbent_retained",
        incumbent_connection_generation: ownership.incumbentGeneration,
        contender_connection_generation: ownership.contenderGeneration,
        source_metadata: "server_connection_sequence",
      }
    );
  }

  // Touch last_seen (NOT a full UPSERT — registration happens via the
  // canonical POST /api/v1/agents endpoint; /api/agents is a legacy alias).
  stmtUpdateLastSeen.run(identity);

  // Track online state. `claim` above guarantees there is no different owner.
  onlineAgents.set(identity, ws);
  wsIdentities.set(ws, identity);

  // Handle proxy_for — a socket may only claim identities it is entitled to
  // proxy (SPEC § 8.2). Entries it may not claim are dropped rather than
  // failing the connect: the http server declares every approved person at
  // once, and refusing the whole connection over one bad entry would take the
  // entire web surface down. A dropped entry is not silent — it is logged, and
  // `mesh.send` refuses it with -32013, which attributes the failure to the one
  // person affected instead of to everyone.
  const proxyFor: string[] = Array.isArray(params.proxy_for) ? params.proxy_for : [];
  const granted: string[] = [];
  if (proxyFor.length > 0) {
    const proxiedSet = wsProxies.get(ws) ?? new Set<string>();
    const refused: string[] = [];
    for (const pid of proxyFor) {
      if (typeof pid !== "string" || pid.length === 0) continue;
      const verdict = entitlement.mayProxy(agentsDb, identity, pid);
      if (!verdict.ok) {
        refused.push(`${pid} (${verdict.reason})`);
        continue;
      }
      proxyMap.set(pid, ws);
      proxiedSet.add(pid);
      granted.push(pid);
    }
    wsProxies.set(ws, proxiedSet);
    if (granted.length > 0) {
      log(`${via === "connect" ? "connected" : "registered"} proxy: ${identity} → [${granted.join(", ")}]`);
    }
    if (refused.length > 0) {
      log(`refused proxy claims by ${identity}: ${refused.join(", ")}`);
    }
  }

  log(`${via === "connect" ? "connected" : "registered"}: ${identity}`);

  // Deliver pending messages
  deliverPending(identity, ws);

  // **Granted, not declared.** Replaying for a refused claim would hand this
  // socket another identity's queued mail and mark it delivered, so the
  // rightful recipient would never receive it — interception dressed as
  // routing. § 8.2 says a refused entry is not wired into the socket's
  // routing, and the replay is routing.
  for (const pid of granted) {
    deliverPending(pid, ws);
  }

  // Advertised so a client can tell a hub that accepts audit from one that
  // does not, and size a batch without guessing (SPEC § 8.9.1). Absent on a 0.1
  // hub, which is how a client detects one.
  return rpcResult(id, {
    ok: true,
    identity,
    capabilities: {
      // The contract's shape, in the contract's order. `schema_version_max` is
      // additive — § 8.9.1's `version` is the protocol version and this is the
      // highest event schema, and a client keying off the wrong one would gate
      // the whole audit surface on a field that moves for a different reason.
      audit: {
        ...AUDIT_LIMITS,
        schema_version_max: MAX_SCHEMA_VERSION,
      },
    },
  });
}

/**
 * mesh.connect — SSOT v2 runtime-connect signal (task #72).
 *
 * Marks a pre-registered identity as online. Registration SSOT is
 * `POST /api/v1/agents` (SPEC §10.1; `/api/agents` is a legacy alias);
 * this method only wires the WebSocket into the online maps. Returns
 * error -32011 IDENTITY_NOT_REGISTERED if the identity has not been
 * pre-registered.
 */
export function handleConnect(
  ws: any,
  params: Record<string, any>,
  id: string | number | null | undefined
): string {
  return performConnect(ws, params, id, "connect");
}

/**
 * mesh.register — DEPRECATED alias for mesh.connect (task #72).
 *
 * Existing agent server.ts clients still emit mesh.register on boot. The
 * alias keeps them working while we migrate the client code base to
 * mesh.connect. Logs a one-line deprecation warning per call so drift
 * shows up in `journalctl -u agent-mesh-hub`.
 */
export function handleRegister(
  ws: any,
  params: Record<string, any>,
  id: string | number | null | undefined
): string {
  const identity = typeof params.identity === "string" ? params.identity : "?";
  log(
    `DEPRECATED: mesh.register called by ${identity}; migrate clients to mesh.connect ` +
    `(task #72 — registration SSOT is POST /api/v1/agents; /api/agents is a legacy alias)`
  );
  return performConnect(ws, params, id, "register");
}


// ---------------------------------------------------------------------------

export function deliverPending(identity: string, ws: any) {
  const pending = stmtPendingMessages.all(identity) as Array<{
    id: string;
    from_agent: string;
    to_agent: string;
    sent_by: string | null;
    content: string;
    reply_to: string | null;
    status: string;
    ts: string;
  }>;

  if (pending.length === 0) return;

  log(`delivering ${pending.length} pending message(s) to ${identity}`);

  for (const msg of pending) {
    try {
      ws.send(
        rpcNotification("mesh.message", {
          id: msg.id,
          from: msg.from_agent,
          to: msg.to_agent,
          // Null for rows stored before the column existed; a replayed message
          // must not claim it was sent by the identity it is from.
          sent_by: msg.sent_by,
          content: msg.content,
          reply_to: msg.reply_to,
          ts: msg.ts,
        })
      );
      stmtUpdateMessageStatus.run("delivered", msg.id);
    } catch (err) {
      log(`failed to deliver pending ${msg.id} to ${identity}:`, err);
      break; // stop if connection is broken
    }
  }
}
