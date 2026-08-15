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
import { Heartbeat } from "./heartbeat";
import { SERVER_ERROR, rpcError } from "./jsonrpc";
import { log } from "./log";
import { connectionOwnership, dropConnection, onlineAgents, proxyMap, wsIdentities, wsProxies } from "./presence";
import { handleDeleteAgent, handlePostAgents, handlePostAgentsV1, jsonResponse,
  handleGetAgentKeys,
} from "./rest/agents";
import { dispatch, dispatchHttp } from "./rpc/dispatch";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const HUB_PORT = parseInt(process.env.AGENT_MESH_HUB_PORT ?? "3100", 10);

// SPEC § 3.1 fixes the production value at 30 seconds. It is overridable
// because a test of half-open detection has to wait out two sweeps, and a test
// that waits a minute is one nobody runs.
const HEARTBEAT_INTERVAL_MS = parseInt(
  process.env.AGENT_MESH_HEARTBEAT_MS ?? "30000",
  10,
);

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------
//
// Detection lives in `heartbeat.ts`, which holds the reasoning; this is the
// wiring. Every path the peer can prove it is alive on has to feed `alive`, or
// a working connection gets dropped after two quiet sweeps.

const heartbeat = new Heartbeat({
  online: onlineAgents,
  touchLastSeen: (identity) => stmtUpdateLastSeen.run(identity),
  drop: (ws, identity) => dropConnection(ws, identity),
  log,
});

const heartbeatInterval = setInterval(() => heartbeat.sweep(), HEARTBEAT_INTERVAL_MS);

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

    // The socketless transport (SPEC § 8.10). A participant driven by an
    // application rather than a daemon is awake only while it is answering, so
    // it can neither hold a socket nor be pushed to. Same methods, one request
    // each, identity from the signature.
    if (url.pathname === "/api/v1/rpc") {
      if (req.method !== "POST") {
        return jsonResponse(405, { ok: false, error: "method not allowed; use POST" });
      }
      return req.text().then((body) => {
        const { status, body: out } = dispatchHttp(body);
        return new Response(out, {
          status,
          headers: { "Content-Type": "application/json" },
        });
      });
    }

    // REST: key record for one identity (SPEC § 10.2). Read-only: the hub
    // never approves, because it cannot authenticate the caller doing it.
    if (url.pathname.startsWith("/api/v1/agents/") && url.pathname.endsWith("/keys")) {
      const identity = url.pathname.slice("/api/v1/agents/".length, -"/keys".length);
      if (!identity || identity.includes("/")) {
        return jsonResponse(404, { ok: false, error: "not found" });
      }
      if (req.method !== "GET") {
        return jsonResponse(405, { ok: false, error: "method not allowed; use GET" });
      }
      return handleGetAgentKeys(decodeURIComponent(identity));
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

    // A pong is the answer the heartbeat asked for (SPEC § 3.1). Bun does not
    // surface it unless this handler exists, so without it every socket would
    // look silent and the sweep would drop the whole mesh every two intervals.
    pong(ws) {
      heartbeat.alive(ws);
    },

    message(ws, msg) {
      // Any inbound frame is proof of life, not only a pong.
      heartbeat.alive(ws);

      // The last guard. A handler that throws here would otherwise take the
      // exception out of the socket callback and answer nothing — the caller
      // waits for a reply that never comes, which is indistinguishable from a
      // hung hub. § 15.6 requires routing to survive storage failing; this is
      // what makes that true for anything not anticipated in a handler.
      let response: string | null;
      try {
        response = dispatch(ws, msg as string | Buffer);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`unhandled error dispatching a request: ${message}`);
        response = rpcError(null, SERVER_ERROR, `internal error: ${message}`);
      }
      if (response) {
        ws.send(response);
      }
    },

    close(ws, code, reason) {
      heartbeat.forget(ws);
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
