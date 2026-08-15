/**
 * Identity provisioning over HTTP (SPEC § 9.2, § 10.1).
 *
 * These routes live on the hub listener, not the http server, because the hub
 * owns `agents`. They replaced the pattern of an operator INSERTing into
 * `hub.db` with `sqlite3` directly — which is also why pre-registration
 * exists: `mesh.register` only ever wrote `(identity, description)`, so new
 * identities arrived with `type = NULL` and the UI showed them as "Unknown"
 * until someone fixed it by hand.
 *
 * Authentication: none, on the assumption the hub binds to a trust-bounded
 * interface. That assumption is recorded as an open question rather than a
 * conclusion — see docs/open-questions.md and SPEC § 10.1.
 */

import {
  db,
  stmtAgentExists,
  stmtDeleteAgent,
  stmtDeleteMessagesOfAgent,
  stmtSelectAgent,
  stmtUpsertAgentTyped,
} from "../db";
import { log } from "../log";

const VALID_AGENT_TYPES = new Set(["ai-claude", "ai-codex", "service"]);
const IDENTITY_RE = /^[a-z][a-z0-9-]*$/;
const MAX_DESCRIPTION_LEN = 256;

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface ProvisionRequest {
  identity: string;
  type: string;
  description: string | null;
}

/**
 * Both provisioning routes validate identically; only their responses differ.
 * Returns the parsed request, or the `400` to send back.
 */
async function parseProvisionRequest(req: Request): Promise<ProvisionRequest | Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { ok: false, error: "invalid JSON body" });
  }
  if (!body || typeof body !== "object") {
    return jsonResponse(400, { ok: false, error: "body must be a JSON object" });
  }

  const { identity, type } = body;
  const description = body.description ?? null;

  if (!identity || typeof identity !== "string") {
    return jsonResponse(400, { ok: false, error: "identity is required (string)" });
  }
  if (!IDENTITY_RE.test(identity)) {
    return jsonResponse(400, {
      ok: false,
      error: "identity must be kebab-case (^[a-z][a-z0-9-]*$)",
    });
  }
  if (!type || typeof type !== "string") {
    return jsonResponse(400, { ok: false, error: "type is required (string)" });
  }
  if (!VALID_AGENT_TYPES.has(type)) {
    return jsonResponse(400, {
      ok: false,
      error: `type must be one of: ${[...VALID_AGENT_TYPES].join(", ")}`,
    });
  }
  if (description !== null) {
    if (typeof description !== "string") {
      return jsonResponse(400, { ok: false, error: "description must be a string" });
    }
    if (description.length > MAX_DESCRIPTION_LEN) {
      return jsonResponse(400, {
        ok: false,
        error: `description exceeds ${MAX_DESCRIPTION_LEN} chars`,
      });
    }
  }

  return { identity, type, description };
}

/** Returns whether the row already existed, or the `500` to send back. */
function upsert(route: string, r: ProvisionRequest): boolean | Response {
  const existed = !!stmtAgentExists.get(r.identity);
  try {
    stmtUpsertAgentTyped.run(r.identity, r.type, r.description);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`${route} db error for ${r.identity}: ${msg}`);
    return jsonResponse(500, { ok: false, error: `db error: ${msg}` });
  }
  return existed;
}

/**
 * `POST /api/agents` — the unversioned alias kept for callers that predate
 * § 10.1. Always `200`, and its body omits `description` and `created_at`.
 */
export async function handlePostAgents(req: Request): Promise<Response> {
  const parsed = await parseProvisionRequest(req);
  if (parsed instanceof Response) return parsed;

  const existed = upsert("POST /api/agents", parsed);
  if (existed instanceof Response) return existed;

  const action = existed ? "updated" : "inserted";
  log(`POST /api/agents: ${action} ${parsed.identity} (type=${parsed.type})`);
  return jsonResponse(200, {
    ok: true,
    identity: parsed.identity,
    type: parsed.type,
    action,
  });
}

/**
 * `POST /api/v1/agents` — the canonical route (SPEC § 10.1).
 *
 * Differs from the alias in two ways: `201` on first insert so a caller can
 * tell "just provisioned" from "already existed" by status alone, and a body
 * carrying the stored row including `created_at`, which is immutable
 * post-insert and formatted as strict ISO-8601 by the statement.
 */
export async function handlePostAgentsV1(req: Request): Promise<Response> {
  const parsed = await parseProvisionRequest(req);
  if (parsed instanceof Response) return parsed;

  const existed = upsert("POST /api/v1/agents", parsed);
  if (existed instanceof Response) return existed;

  const row = stmtSelectAgent.get(parsed.identity) as
    | {
        identity: string;
        type: string | null;
        description: string | null;
        last_seen: string | null;
        created_at_iso: string | null;
      }
    | undefined;

  const status = existed ? 200 : 201;
  const action = existed ? "updated" : "inserted";
  log(`POST /api/v1/agents: ${action} ${parsed.identity} (type=${parsed.type}) -> ${status}`);
  return jsonResponse(status, {
    ok: true,
    identity: row?.identity ?? parsed.identity,
    type: row?.type ?? parsed.type,
    description: row?.description ?? parsed.description,
    created_at: row?.created_at_iso ?? null,
    action,
  });
}

/**
 * `DELETE /api/agents/{identity}` (SPEC § 9.3).
 *
 * Removes the agent row and every message it sent or received, in one
 * transaction. The counts come back so a caller can confirm the teardown
 * happened rather than inferring it from a `200`.
 *
 * SPEC 0.2 turns this into a soft delete: discarding a key makes every past
 * signature unverifiable, and freeing an identity string lets a later
 * registration inherit the previous holder's history.
 */
export function handleDeleteAgent(identity: string): Response {
  if (!IDENTITY_RE.test(identity)) {
    return jsonResponse(400, {
      ok: false,
      error: "invalid identity format (must be kebab-case ^[a-z][a-z0-9-]*$)",
    });
  }

  let agentsRemoved = 0;
  let messagesRemoved = 0;
  try {
    db.exec("BEGIN");
    const agentsRes = stmtDeleteAgent.run(identity) as { changes: number };
    const messagesRes = stmtDeleteMessagesOfAgent.run(identity, identity) as { changes: number };
    db.exec("COMMIT");
    agentsRemoved = agentsRes.changes ?? 0;
    messagesRemoved = messagesRes.changes ?? 0;
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch {}
    const msg = err instanceof Error ? err.message : String(err);
    log(`DELETE /api/agents/${identity} db error: ${msg}`);
    return jsonResponse(500, { ok: false, error: `db error: ${msg}` });
  }

  // "not-found" is still a 200: callers treat teardown as idempotent (SPEC § 9.3).
  const action = agentsRemoved > 0 ? "deleted" : "not-found";
  log(
    `DELETE /api/agents/${identity}: ${action} ` +
    `(agents_removed=${agentsRemoved}, messages_removed=${messagesRemoved})`,
  );
  return jsonResponse(200, {
    ok: true,
    identity,
    action,
    agents_removed: agentsRemoved,
    messages_removed: messagesRemoved,
  });
}
