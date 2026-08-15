/**
 * Identity provisioning and teardown over HTTP (SPEC § 9.2, § 9.3, § 10.1).
 *
 * These routes live on the hub listener, not the http server, because the hub
 * owns `agents`. They replaced the pattern of an operator INSERTing into the
 * database with `sqlite3` directly — which is also why pre-registration
 * exists: `mesh.register` only ever wrote `(identity, description)`, so new
 * identities arrived with `type = NULL` and the UI showed them as "Unknown"
 * until someone fixed it by hand.
 *
 * Authentication: none, on the assumption the hub binds to a trust-bounded
 * interface. That is recorded as an open question rather than a conclusion —
 * see docs/open-questions.md and SPEC § 10.1.
 */

import { randomUUID } from "node:crypto";

import { agentsSchema } from "@agent-mesh/store";

import {
  agentsDb,
  stmtAgentExists,
  stmtInsertKeyEvent,
  stmtKeysOfAgent,
  stmtRevokeKeysOfAgent,
  stmtSelectAgent,
  stmtSoftDeleteAgent,
  stmtUpsertAgentTyped,
} from "../db";
import { log } from "../log";

/**
 * SPEC § 10.1. A letter or digit, then letters, digits and hyphens.
 *
 * Kebab-case is recommended and is what every baseline identity uses, but it is
 * a convention. 0.1 enforced it, which was right while every identity was a
 * service an operator named and wrong once § 10.3 admitted `human`: a person's
 * identity is a login they already have, and the systems people federate from
 * permit uppercase. Comparison is case-sensitive, matching SQLite's default
 * collation — `Codex` and `codex` are two identities.
 */
const IDENTITY_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
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
      error: "identity must match ^[A-Za-z0-9][A-Za-z0-9-]*$",
    });
  }
  if (!type || typeof type !== "string") {
    return jsonResponse(400, { ok: false, error: "type is required (string)" });
  }

  // The registry, not a hardcoded set (SPEC § 10.3). A deployment adds a row
  // and a new runtime is accepted with no change here.
  if (!agentsSchema.getType(agentsDb, type)) {
    const known = agentsSchema.listTypes(agentsDb).map((t) => t.type);
    return jsonResponse(400, {
      ok: false,
      error: `type must be one of: ${known.join(", ")}`,
    });
  }

  // A soft-deleted identity is not re-registrable (SPEC § 9.3). Reusing the
  // string would let this registration inherit the previous holder's history.
  const existing = stmtSelectAgent.get(identity) as { deleted_at: string | null } | undefined;
  if (existing?.deleted_at) {
    return jsonResponse(409, {
      ok: false,
      error: `identity '${identity}' was deleted and cannot be re-registered`,
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
 * `DELETE /api/agents/{identity}` (SPEC § 9.3) — a **soft** delete.
 *
 * Sets `deleted_at`, revokes the identity's keys, and leaves `messages`
 * untouched. Hard deletion is incompatible with two other rules: discarding a
 * key makes every past signature permanently unverifiable, and freeing the
 * identity string lets a later registration inherit the previous holder's
 * message and audit history.
 *
 * Because nothing outside `agents.db` is touched, this is a single-file
 * transaction — SQLite does not guarantee atomic commit across attached
 * databases in WAL mode.
 */
export function handleDeleteAgent(identity: string): Response {
  if (!IDENTITY_RE.test(identity)) {
    return jsonResponse(400, {
      ok: false,
      error: "invalid identity format (must match ^[A-Za-z0-9][A-Za-z0-9-]*$)",
    });
  }

  const existing = stmtSelectAgent.get(identity) as
    | { identity: string; deleted_at: string | null }
    | undefined;

  if (!existing) {
    log(`DELETE /api/agents/${identity}: not-found`);
    return jsonResponse(200, { ok: true, identity, action: "not-found" });
  }
  if (existing.deleted_at) {
    log(`DELETE /api/agents/${identity}: already-deleted`);
    return jsonResponse(200, {
      ok: true,
      identity,
      action: "already-deleted",
      deleted_at: existing.deleted_at,
    });
  }

  try {
    agentsDb.exec("BEGIN");
    stmtSoftDeleteAgent.run(identity);
    // Record every key that is about to change state before changing it, so
    // the history explains the transition rather than merely showing the
    // result.
    const keys = stmtKeysOfAgent.all(identity) as Array<{ fingerprint: string }>;
    stmtRevokeKeysOfAgent.run(identity);
    for (const { fingerprint } of keys) {
      stmtInsertKeyEvent.run(
        randomUUID(),
        identity,
        fingerprint,
        "revoked",
        "teardown",
        "hub",
      );
    }
    agentsDb.exec("COMMIT");
  } catch (err) {
    try { agentsDb.exec("ROLLBACK"); } catch {}
    const msg = err instanceof Error ? err.message : String(err);
    log(`DELETE /api/agents/${identity} db error: ${msg}`);
    return jsonResponse(500, { ok: false, error: `db error: ${msg}` });
  }

  const row = stmtSelectAgent.get(identity) as { deleted_at: string | null } | undefined;
  log(`DELETE /api/agents/${identity}: soft-deleted`);
  return jsonResponse(200, {
    ok: true,
    identity,
    action: "soft-deleted",
    deleted_at: row?.deleted_at ?? null,
  });
}
