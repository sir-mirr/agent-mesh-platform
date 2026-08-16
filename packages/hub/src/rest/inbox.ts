/**
 * The signed inbox surface (SPEC § 9.2.1).
 *
 * A REST naming of methods that already exist. `POST /api/v1/rpc` carries an
 * inbox and does not describe one: a JSON-RPC endpoint accepting six method
 * names tells a reader nothing about what an inbox can do, and the
 * lease-and-acknowledge contract — the part most likely to be got wrong — is
 * visible only to someone who reads § 8.10.1.
 *
 * **Nothing here is a second store.** Every route below runs the same handler
 * against the same rows, so a participant switching between a socket,
 * `/api/v1/rpc` and these routes is one identity with one inbox.
 *
 * Two shapes are worth reading before the code.
 *
 * `POST /api/v1/inbox` is a `POST` because it *acts*: it leases a batch,
 * settles the previous one, and writes an audit event. A `GET` would invite
 * every layer that treats `GET` as safe — a proxy, a retry, an operator with
 * `curl` — to consume a lease without meaning to. The standalone mailer's `GET`
 * marks messages read, and working around that is why the delivery hook has to
 * keep its own high-water mark.
 *
 * Recall is bounded by **hand-over, not acknowledgement**. A leased message was
 * returned in a response; the recipient holds it whether or not it survived to
 * say so. Withdrawing one they have already been given would make the sender
 * the owner of someone else's record.
 */

import { MESH_ERROR, MAILBOX_CAPABILITY_DEFAULTS, SURFACE_CAPABILITY_DEFAULTS } from "@agent-mesh/contracts";
import { outbox } from "@agent-mesh/store";

import { db as hubDb, stmtMessageById } from "../db";
import { OBSERVED } from "../observed-config";
import { log } from "../log";
import { AUDIT_LIMITS, MAX_SCHEMA_VERSION } from "../rpc/audit-limits";
import { recordRecalled } from "../rpc/audit";
import { handleFetchMessages } from "../rpc/messages";
import { handleReceive } from "../rpc/receive";
import { handleSend } from "../rpc/send";
import { wsIdentities, wsProxies } from "../presence";
import { authenticate, type SignedCaller } from "./signed";

const MAX_RECALLABLE_PAGE = 200;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Run a JSON-RPC handler for a caller with no socket.
 *
 * The stand-in is registered only for the life of the call and never enters
 * `onlineAgents` — a socketless participant is never online (§ 8.10), so a
 * sender addressing it must be told `pending` rather than `delivered`.
 */
function asCaller<T>(identity: string, run: (ws: object) => string): T {
  const ws = { restCaller: true, identity };
  wsIdentities.set(ws, identity);
  try {
    return JSON.parse(run(ws)) as T;
  } finally {
    wsIdentities.delete(ws);
    wsProxies.delete(ws);
  }
}

/** Unwrap a JSON-RPC envelope into a REST body, preserving the code. */
function unwrap(rpc: any, okStatus = 200): Response {
  if (rpc?.error) {
    // The JSON-RPC code travels in the body: a status code cannot carry the
    // retry policy, and `ERROR_CLASS` is keyed on the number.
    const status =
      rpc.error.code === MESH_ERROR.NOT_ENTITLED ? 403 :
      rpc.error.code === MESH_ERROR.IDENTITY_NOT_REGISTERED ? 404 :
      rpc.error.code === -32015 ? 409 :
      rpc.error.code === MESH_ERROR.INVALID_PARAMS ? 400 : 500;
    return json(status, {
      ok: false,
      error: rpc.error.message,
      ...(rpc.error.data?.code ? { code: rpc.error.data.code } : {}),
      rpc_code: rpc.error.code,
      ...(rpc.error.data ?? {}),
    });
  }
  return json(okStatus, { ok: true, ...rpc.result });
}

export interface InboxRequest {
  method: string;
  /** Path with query string, exactly as received — the signature covers it. */
  path: string;
  pathname: string;
  search: string;
  authorization: string | null;
  body: string;
  /** The hub's own observation of the peer (§ 8.11). */
  observed?: string | null;
}

/**
 * Route one request, or return null when the path is not ours.
 *
 * Returning null rather than 404 lets the caller fall through to the routes
 * that were already there, so this file cannot accidentally shadow one.
 */
export function handleInboxRoute(req: InboxRequest): Response | null {
  const { pathname, method } = req;

  // Unsigned, deliberately: the values matter most while a caller cannot yet
  // sign (§ 9.2.1). Checked before authentication so a `pending` key can read
  // the lease window it needs to size its retry loop.
  if (pathname === "/api/v1/capabilities") {
    if (method !== "GET") return json(405, { ok: false, error: "method not allowed; use GET" });
    return json(200, {
      mailbox: MAILBOX_CAPABILITY_DEFAULTS,
      audit: { ...AUDIT_LIMITS, schema_version_max: MAX_SCHEMA_VERSION },
      // `observed_source` is the running deployment's, not the default's
      // (§ 8.11). Reporting the constant would tell every caller `socket`
      // however the process was configured — the exact drift this route
      // exists to prevent.
      surface: { ...SURFACE_CAPABILITY_DEFAULTS, observed_source: OBSERVED.mode },
    });
  }

  const isOurs =
    pathname === "/api/v1/inbox" ||
    pathname === "/api/v1/inbox/history" ||
    pathname === "/api/v1/outbox" ||
    pathname.startsWith("/api/v1/outbox/");
  if (!isOurs) return null;

  const auth = authenticate(method, req.path, req.authorization, req.body, req.observed ?? null);
  if (!auth.ok) return json(auth.refusal.status, auth.refusal.body);
  const caller = auth.caller;

  if (pathname === "/api/v1/inbox") {
    if (method !== "POST") return json(405, { ok: false, error: "method not allowed; use POST" });
    let params: Record<string, unknown>;
    try {
      params = req.body ? JSON.parse(req.body) : {};
    } catch {
      return json(400, { ok: false, error: "invalid JSON body", rpc_code: MESH_ERROR.INVALID_PARAMS });
    }
    return unwrap(JSON.parse(handleReceive(caller.identity, params, 1)));
  }

  if (pathname === "/api/v1/inbox/history") {
    if (method !== "GET") return json(405, { ok: false, error: "method not allowed; use GET" });
    const query = new URLSearchParams(req.search);
    const peer = query.get("peer");
    if (!peer) {
      return json(400, { ok: false, error: "peer is required", rpc_code: MESH_ERROR.INVALID_PARAMS });
    }
    const limit = query.get("limit");
    return unwrap(
      asCaller(caller.identity, (ws) =>
        handleFetchMessages(ws, { agent_id: peer, ...(limit ? { limit } : {}) }, 1),
      ),
    );
  }

  if (pathname === "/api/v1/outbox") {
    if (method === "POST") return sendOne(caller, req.body);
    if (method === "GET") return listOutbox(caller, req.search);
    return json(405, { ok: false, error: "method not allowed; use GET or POST" });
  }

  const messageId = pathname.slice("/api/v1/outbox/".length);
  if (method !== "DELETE") return json(405, { ok: false, error: "method not allowed; use DELETE" });
  return recallOne(caller, messageId, req.authorization);
}

function sendOne(caller: SignedCaller, body: string): Response {
  let params: Record<string, unknown>;
  try {
    params = JSON.parse(body || "{}");
  } catch {
    return json(400, { ok: false, error: "invalid JSON body", rpc_code: MESH_ERROR.INVALID_PARAMS });
  }
  // `raw` and `sig` are null: § 8.9.4 keeps the sender's `mesh.send` signature
  // as the audit attestation, and this caller signed a REST envelope instead.
  // Passing the REST signature would attest to bytes the audit record does not
  // hold — a signature over the wrong thing is worse than none.
  return unwrap(JSON.parse(asCallerRaw(caller.identity, params)));
}

function asCallerRaw(identity: string, params: Record<string, unknown>): string {
  const ws = { restCaller: true, identity };
  wsIdentities.set(ws, identity);
  try {
    return handleSend(ws, params, 1)!;
  } finally {
    wsIdentities.delete(ws);
    wsProxies.delete(ws);
  }
}

function listOutbox(caller: SignedCaller, search: string): Response {
  const raw = Number(new URLSearchParams(search).get("limit") ?? 50);
  const limit = Math.min(Math.max(Number.isFinite(raw) ? raw : 50, 1), MAX_RECALLABLE_PAGE);
  return json(200, {
    ok: true,
    messages: outbox.listRecallable(hubDb, caller.identity, limit),
  });
}

function recallOne(caller: SignedCaller, messageId: string, authorization: string | null): Response {
  if (!messageId || messageId.includes("/")) {
    return json(404, { ok: false, error: "not found" });
  }

  // Read before the delete, because the audit event needs the row and the
  // delete removes it. The read is not the decision — `recall` re-decides in
  // one statement, so a recipient taking delivery in between loses nothing.
  const row = stmtMessageById.get(messageId) as
    | { id: string; from_agent: string; to_agent: string; sent_by: string | null }
    | undefined;

  const outcome = outbox.recall(hubDb, caller.identity, messageId);
  if (outcome === "not-found") {
    return json(404, { ok: false, error: "no such message from this sender" });
  }
  if (outcome === "already-delivered") {
    return json(409, {
      ok: false,
      error: "the recipient has already been handed this message",
      code: "ALREADY_DELIVERED",
    });
  }

  if (row) recordRecalled(row, { scheme: "AgentMeshSig", authorization });
  log(`recalled ${messageId} for ${caller.identity}`);
  return json(200, { ok: true, recalled: true, id: messageId });
}
