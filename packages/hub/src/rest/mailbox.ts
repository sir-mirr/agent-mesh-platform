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
 * `POST /api/v1/mailbox/in` is a `POST` because it *acts*: it leases a batch,
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
import { PROVENANCE } from "../provenance";
import { DORMANCY_SECONDS } from "../dormancy";
import { LEASE_SECONDS } from "../rpc/receive";
import { log } from "../log";
import { AUDIT_LIMITS, MAX_SCHEMA_VERSION } from "../rpc/audit-limits";
import { BLOB_BASE_URL, recordRecalled } from "../rpc/audit";
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

export interface MailboxRequest {
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
 * The signed paths this module answers.
 *
 * **One word, and the direction is the caller's.** `in` is what has arrived
 * for this caller; `out` is what they sent and may still recall. `inbox` and
 * `outbox` named the same two directions from whichever end the reader
 * happened to be standing at, which went wrong every time a proxy was in the
 * path — see docs/decisions/mailbox-and-hub.md.
 *
 * Exported because the dispatcher in `main.ts` used to decide the same thing a
 * second time, with `startsWith("/api/v1/mailbox")` — and the two disagreed.
 * A name-space claimed in two places is claimed twice differently sooner or
 * later; this is the one place that decides.
 */
export function isMailboxPath(pathname: string): boolean {
  return (
    pathname === "/api/v1/mailbox/in" ||
    pathname === "/api/v1/mailbox/history" ||
    pathname === "/api/v1/mailbox/out" ||
    pathname.startsWith("/api/v1/mailbox/out/")
  );
}

/**
 * Every path this module answers, signed surface and the unsigned route beside
 * it — what the hub's dispatcher must hand over and nothing more.
 *
 * **The boundary is the separator, not the word.** The dispatcher matched
 * `startsWith("/api/v1/mailbox")`, which also claimed `/api/v1/mailboxfoo`,
 * and that branch `return`s rather than falling through — so any route added
 * below it whose path merely began with those letters would be unreachable and
 * nothing would say so.
 *
 * Measured before changing, on a hub booted for it: `/api/v1/mailboxfoo`
 * answered `404 Not Found`, `text/plain`, nine bytes — byte-for-byte what an
 * unrouted path answers, and no log line either. It reached nothing, because
 * `isMailboxPath` above refuses before `authenticate` runs. So this was never
 * the defect `/api/v1/files` had; what it cost was the request body read above
 * a refusal, and a claim on names this module does not own.
 */
export function handlesPath(pathname: string): boolean {
  return pathname === "/api/v1/capabilities" || isMailboxPath(pathname);
}

/**
 * Route one request, or return null when the path is not ours.
 *
 * Returning null rather than 404 lets the caller fall through to the routes
 * that were already there, so this file cannot accidentally shadow one.
 */
export function handleMailboxRoute(req: MailboxRequest): Response | null {
  const { pathname, method } = req;

  // Unsigned, deliberately: the values matter most while a caller cannot yet
  // sign (§ 9.2.1). Checked before authentication so a `pending` key can read
  // the lease window it needs to size its retry loop.
  if (pathname === "/api/v1/capabilities") {
    if (method !== "GET") return json(405, { ok: false, error: "method not allowed; use GET" });
    return json(200, {
      // The deployment's window, not the default's — a client sizing its
      // behaviour on a constant would be sizing it on another deployment.
      mailbox: {
        ...MAILBOX_CAPABILITY_DEFAULTS,
        dormancy_seconds: DORMANCY_SECONDS,
        // Was left as the default while `dormancy_seconds` beside it was not,
        // under a comment saying to do exactly this. A stated principle does
        // not check itself.
        receive_lease_seconds: LEASE_SECONDS,
      },
      audit: {
        ...AUDIT_LIMITS,
        schema_version_max: MAX_SCHEMA_VERSION,
        // **The address this hub hands out for attachment uploads**, which it
        // cannot derive — http connects to the hub, never the reverse, so a
        // deployment states it and the default is § 9.1's port.
        //
        // Reported for the same reason `receive_lease_seconds` beside it is,
        // and it was the one still missing. A hub started on a non-default pair
        // whose operator forgot `AGENT_MESH_BLOB_BASE_URL` hands out `:3000`
        // URLs pointing at whatever else is listening there — silently, and not
        // until the first attachment. `client-claude` found this by noticing the
        // running-locally procedure passes every step with that value wrong
        // (mail #451): nothing observable disagrees, so nothing can check it.
        blob_base_url: BLOB_BASE_URL,
      },
      // `observed_source` is the running deployment's, not the default's
      // (§ 8.11). Reporting the constant would tell every caller `socket`
      // however the process was configured — the exact drift this route
      // exists to prevent.
      surface: { ...SURFACE_CAPABILITY_DEFAULTS, observed_source: OBSERVED.mode },
      // § 7. Which checkout is answering. A long-running instance served a
      // branch ninety-three commits behind `main` and the only way to tell was
      // to notice missing routes and reason backwards — twice, with the first
      // diagnosis wrong both times. Proposed by `client-claude` after the
      // second (mail #300).
      platform: PROVENANCE,
    });
  }

  if (!isMailboxPath(pathname)) return null;

  const auth = authenticate(method, req.path, req.authorization, req.body, req.observed ?? null);
  if (!auth.ok) return json(auth.refusal.status, auth.refusal.body);
  const caller = auth.caller;

  if (pathname === "/api/v1/mailbox/in") {
    if (method !== "POST") return json(405, { ok: false, error: "method not allowed; use POST" });
    let params: Record<string, unknown>;
    try {
      params = req.body ? JSON.parse(req.body) : {};
    } catch {
      return json(400, { ok: false, error: "invalid JSON body", rpc_code: MESH_ERROR.INVALID_PARAMS });
    }
    return unwrap(JSON.parse(handleReceive(caller.identity, params, 1)));
  }

  if (pathname === "/api/v1/mailbox/history") {
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

  if (pathname === "/api/v1/mailbox/out") {
    if (method === "POST") return sendOne(caller, req.body, req.observed ?? null);
    if (method === "GET") return listOutbox(caller, req.search);
    return json(405, { ok: false, error: "method not allowed; use GET or POST" });
  }

  const messageId = pathname.slice("/api/v1/mailbox/out/".length);
  if (method !== "DELETE") return json(405, { ok: false, error: "method not allowed; use DELETE" });
  return recallOne(caller, messageId, req.authorization);
}

function sendOne(caller: SignedCaller, body: string, observed: string | null): Response {
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
  return unwrap(JSON.parse(asCallerRaw(caller.identity, params, observed)));
}

function asCallerRaw(identity: string, params: Record<string, unknown>, observed: string | null): string {
  const ws = { restCaller: true, identity, observed };
  wsIdentities.set(ws, identity);
  try {
    // § 8.2a. This route *is* the mailbox, so anything arriving on it was sent
    // by mail, whatever the recipient happens to be holding at the time.
    return handleSend(ws, params, 1, undefined, undefined, "mailbox")!;
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
  log.info("recalled a message nobody had been handed", "message_recalled", {
    id: messageId,
    actor: caller.identity,
    outcome: "recalled",
  });
  return json(200, { ok: true, recalled: true, id: messageId });
}
