/**
 * Agent-Mesh — JSON-RPC hub.
 *
 * The WebSocket broker every agent connects to, plus the small REST control
 * plane that provisions and tears down identities (SPEC § 3.1, § 9.2).
 *
 * This file is wiring: config, the server, and shutdown. The method handlers
 * live in `rpc/`, the REST routes in `rest/`, connection state in
 * `presence.ts` and the statements in `db.ts`.
 */

import { closeDatabases, stmtUpdateLastSeen } from "./db";
import { log } from "./log";
import { connectionOwnership, onlineAgents, proxyMap, wsIdentities, wsProxies } from "./presence";
import { handleDeleteAgent, handlePostAgents, handlePostAgentsV1, jsonResponse } from "./rest/agents";
import { dispatch } from "./rpc/dispatch";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const HUB_PORT = parseInt(process.env.AGENT_MESH_HUB_PORT ?? "3100", 10);
const HEARTBEAT_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------
//
// A failed ping is how a half-open socket is noticed: the peer is gone but the
// close event never arrived. `last_seen` is touched before the entry is
// dropped so the registry still records when it was last reachable.

const heartbeatInterval = setInterval(() => {
  for (const [identity, ws] of onlineAgents) {
    try {
      ws.ping();
    } catch {
      log(`heartbeat failed for ${identity}, removing`);
      if (connectionOwnership.owner(identity) === ws) {
        connectionOwnership.release(ws);
        onlineAgents.delete(identity);
      }
      stmtUpdateLastSeen.run(identity);
    }
  }
}, HEARTBEAT_INTERVAL_MS);

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = Bun.serve({
  port: HUB_PORT,

  fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade
    if (server.upgrade(req)) {
      return undefined as any;
    }

    // Simple health / info endpoint
    if (url.pathname === "/" || url.pathname === "/health") {
      const agentCount = onlineAgents.size;
      return new Response(
        JSON.stringify({
          service: "Agent Mesh Hub",
          version: "2.0.0",
          online_agents: agentCount,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // REST: pre-register identity with type (collection endpoint)
    if (url.pathname === "/api/agents") {
      if (req.method === "POST") {
        return handlePostAgents(req);
      }
      return jsonResponse(405, { ok: false, error: "method not allowed; use POST" });
    }

    // REST: SPEC §9/§10 versioned provisioning endpoint
    // /api/v1/agents is the canonical identity-provisioning route for
    // cross-VM lane bootstrap. /api/agents remains as a legacy alias.
    if (url.pathname === "/api/v1/agents") {
      if (req.method === "POST") {
        return handlePostAgentsV1(req);
      }
      return jsonResponse(405, { ok: false, error: "method not allowed; use POST" });
    }

    // REST: single-identity endpoint — /api/agents/{identity}
    // Currently supports DELETE (teardown). POST is only on the collection
    // endpoint above, so a POST here returns 405 like any other method.
    if (url.pathname.startsWith("/api/agents/")) {
      const rawIdentity = url.pathname.slice("/api/agents/".length);
      // Guard against trailing slashes and multi-segment paths (no /api/agents/foo/bar)
      if (!rawIdentity || rawIdentity.includes("/")) {
        return jsonResponse(404, { ok: false, error: "not found" });
      }
      const identity = decodeURIComponent(rawIdentity);
      if (req.method === "DELETE") {
        return handleDeleteAgent(identity);
      }
      return jsonResponse(405, { ok: false, error: "method not allowed; use DELETE" });
    }

    return new Response("Not Found", { status: 404 });
  },

  websocket: {
    open(ws) {
      log(`connection opened`);
    },

    message(ws, msg) {
      const response = dispatch(ws, msg as string | Buffer);
      if (response) {
        ws.send(response);
      }
    },

    close(ws, code, reason) {
      const identity = wsIdentities.get(ws);
      if (identity) {
        // Release only when this socket is still owner. A stale close must not
        // remove a newer owner that won after an incumbent-close race.
        const released = connectionOwnership.release(ws);
        if (released?.wasOwner && onlineAgents.get(identity) === ws) {
          onlineAgents.delete(identity);
        }
        // Clean up proxy entries for this ws
        const proxied = wsProxies.get(ws);
        if (proxied) {
          for (const pid of proxied) {
            if (proxyMap.get(pid) === ws) proxyMap.delete(pid);
          }
          wsProxies.delete(ws);
        }
        wsIdentities.delete(ws);
        stmtUpdateLastSeen.run(identity);
        log(`disconnected: ${identity} (code=${code})`);
      } else {
        log(`unregistered connection closed (code=${code})`);
      }
    },
  },
});

log(`Hub server listening on ws://0.0.0.0:${server.port}`);

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function shutdown() {
  log("shutting down...");
  clearInterval(heartbeatInterval);

  // Update last_seen for all online agents
  for (const [identity] of onlineAgents) {
    stmtUpdateLastSeen.run(identity);
  }

  try {
    closeDatabases();
  } catch {}

  log("shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
