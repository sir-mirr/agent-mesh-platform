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

import { PROVISION_ERROR, PUBLIC_KEY_RE, keyFingerprint } from "@agent-mesh/contracts";
import { agentsSchema, keys } from "@agent-mesh/store";

import {
  agentsDb,
  stmtAgentExists,
  stmtInsertKeyEvent,
  stmtKeysOfAgent,
  stmtRevokeKeysOfAgent,
  stmtInsertAgentIfAbsent,
  stmtSelectAgent,
  stmtSetCanProxy,
  stmtSoftDeleteAgent,
  stmtUpsertAgentTyped,
} from "../db";
import { log } from "../log";
import { recordIdentityEvent } from "../rpc/audit";

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
  publicKey: string | null;
  canProxy: boolean | null;
  createOnly: boolean;
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
  const publicKey = body.public_key ?? null;
  const canProxy = body.can_proxy === undefined ? null : body.can_proxy;
  const createOnly = body.create_only === true;
  if (body.create_only !== undefined && typeof body.create_only !== "boolean") {
    return jsonResponse(400, { ok: false, error: "create_only must be a boolean" });
  }

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
  const typeRow = agentsSchema.getType(agentsDb, type);
  if (!typeRow) {
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
      code: PROVISION_ERROR.IDENTITY_DELETED,
      identity,
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

  if (publicKey !== null) {
    if (typeof publicKey !== "string" || !PUBLIC_KEY_RE.test(publicKey)) {
      return jsonResponse(400, {
        ok: false,
        error: "public_key must be a raw Ed25519 key, base64url, 43 characters",
      });
    }
    // A key already held by someone else (SPEC § 10.1). Refused **here**,
    // before the row is written, because `agent_keys` is keyed on the
    // fingerprint alone: the INSERT would silently do nothing and leave a
    // `requires_key` identity with no key — the state the check below exists
    // to prevent, reached from the other side.
    //
    // The holder's name is compared and discarded. Reporting it would make
    // this route a fingerprint-to-identity lookup for anyone who can reach the
    // port, which is the direction § 10.2 keeps closed.
    const holder = keys.fingerprintHolder(agentsDb, keyFingerprint(publicKey));
    if (holder !== null && holder !== identity) {
      return jsonResponse(409, {
        ok: false,
        code: PROVISION_ERROR.KEY_HELD_BY_ANOTHER_IDENTITY,
        identity,
        error: "that public key is already registered to a different identity",
      });
    }
  }

  // SPEC § 10.1. A `requires_key` type registered without one could otherwise
  // connect unsigned forever: § 8.1 has no unsigned path for such a type, so the
  // identity would exist and be permanently unusable. Refusing here is the only
  // point at which that is a clear error rather than a puzzling `-32014` later.
  //
  // An identity that already holds a key may re-register without re-sending it;
  // requiring it every time would mean a caller updating a description had to
  // carry the key to do it.
  if (typeRow.requires_key === 1 && publicKey === null && !keys.approvedKey(agentsDb, identity)) {
    if (!keys.pendingKey(agentsDb, identity)) {
      return jsonResponse(400, {
        ok: false,
        error: `type '${type}' requires a signing key; supply public_key`,
      });
    }
  }

  if (canProxy !== null && typeof canProxy !== "boolean") {
    return jsonResponse(400, { ok: false, error: "can_proxy must be a boolean" });
  }

  return { identity, type, description, publicKey, canProxy, createOnly };
}

/**
 * Record the key, if one came with the request (SPEC § 10.2).
 *
 * Separate from the row upsert because it is separately idempotent: a client
 * re-registering with the key it already holds must get its current status back
 * with nothing changed, and must not have an approved key knocked back to
 * pending by its own restart.
 */
function recordKey(route: string, r: ProvisionRequest): { fingerprint: string; status: string } | null {
  if (!r.publicKey) return null;
  const result = keys.proposeKey(agentsDb, r.identity, r.publicKey, "api");
  log(
    `${route}: key ${result.fingerprint} for ${r.identity} -> ${result.status}` +
      (result.created ? " (new proposal)" : " (already on record)"),
  );
  return { fingerprint: result.fingerprint, status: result.status };
}

/** Returns whether the row already existed, or the `500` to send back. */
function upsert(route: string, r: ProvisionRequest): boolean | Response {
  // `create_only`: refuse rather than adopt. Onboarding a new participant must
  // never take over an existing one — the default upsert would replace its
  // description and supersede its pending key, and answer 200.
  //
  // The insert is the check. Reading first and inserting after leaves a window
  // for a second caller to register between the two, which is the race this
  // exists to close.
  if (r.createOnly) {
    let created = false;
    try {
      created = stmtInsertAgentIfAbsent.run(r.identity, r.type, r.description).changes > 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`${route} db error for ${r.identity}: ${msg}`);
      return jsonResponse(500, { ok: false, error: `db error: ${msg}` });
    }
    if (!created) {
      log(`${route}: refused ${r.identity} — already exists (create_only)`);
      return jsonResponse(409, {
        ok: false,
        code: PROVISION_ERROR.IDENTITY_EXISTS,
        identity: r.identity,
        error: `identity '${r.identity}' already exists`,
      });
    }
    return false;
  }

  const existed = !!stmtAgentExists.get(r.identity);
  // Read before the write, because the upsert overwrites it and the event needs
  // both halves. § 10.1 step 6 mandates the overwrite, so this is not a guard —
  // it is the record the overwrite never left. `agents.type` is read at display
  // time, so changing it re-labels **every past audit event** for this identity
  // as having come from a different runtime; without this the trail says it
  // always was.
  const before = existed
    ? (stmtSelectAgent.get(r.identity) as { type: string | null } | undefined)?.type ?? null
    : null;
  try {
    stmtUpsertAgentTyped.run(r.identity, r.type, r.description);
    // Omitted means unchanged, not false. A caller updating a description must
    // not silently strip a grant it never mentioned (SPEC § 8.2).
    if (r.canProxy !== null) {
      stmtSetCanProxy.run(r.canProxy ? 1 : 0, r.identity);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`${route} db error for ${r.identity}: ${msg}`);
    return jsonResponse(500, { ok: false, error: `db error: ${msg}` });
  }
  if (existed && before !== r.type) {
    // After the write, not inside the try: a failed audit must not turn a
    // completed provisioning into a `500` (§ 15.6). `recordIdentityEvent`
    // swallows its own errors for the same reason.
    log(`${route}: ${r.identity} type ${before ?? "null"} -> ${r.type}`);
    recordIdentityEvent("mesh.identity.type_changed", {
      identity: r.identity,
      change: { from: before, to: r.type },
      // The route cannot authenticate its caller, so there is nobody to name.
      actor: null,
    });
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

  const key = recordKey("POST /api/agents", parsed);
  const action = existed ? "updated" : "inserted";
  log(`POST /api/agents: ${action} ${parsed.identity} (type=${parsed.type})`);
  return jsonResponse(200, {
    ok: true,
    identity: parsed.identity,
    type: parsed.type,
    action,
    ...(key ? { key } : {}),
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

  const key = recordKey("POST /api/v1/agents", parsed);
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
    // Present only when the request carried a key. Its `status` is what the
    // caller waits on: `pending` means an operator has not compared the
    // fingerprint yet, and § 10.2 is explicit that approval without that
    // comparison attests to nothing.
    ...(key ? { key } : {}),
  });
}

/**
 * `DELETE /api/agents/{identity}` — **refused here** (SPEC § 9.3).
 *
 * Teardown moved to `agent-mesh-http`, behind the admin JWT, for the reason
 * § 10.2 already gives for key approval: **the hub cannot authenticate a
 * caller.** It has no sessions and no tokens, so any route it serves is
 * reachable by anything that can reach the port.
 *
 * That was survivable for provisioning, which `create_only` makes safe to
 * offer openly. It was not survivable for this one. A single unauthenticated
 * request revoked every key of an identity, and § 9.3 forbids re-registering
 * the name afterwards — so recovery meant editing the database by hand, and
 * the names could be enumerated from `mesh.list_agents` first.
 *
 * The route is answered rather than dropped. A `404` reads as a typo and
 * invites a retry against a path that will never exist; this says where the
 * operation went.
 */
export function handleDeleteAgent(identity: string): Response {
  log(`DELETE /api/agents/${identity}: refused — teardown requires an admin session`);
  return jsonResponse(403, {
    ok: false,
    error:
      "teardown is not served by the hub — it cannot authenticate callers. " +
      "Use DELETE /api/v1/admin/agents/{identity} on agent-mesh-http with an admin session (SPEC § 9.3).",
    code: "TEARDOWN_REQUIRES_ADMIN",
  });
}

/**
 * `GET /api/v1/agents/{identity}/keys` — the key record for one identity.
 *
 * A client that proposed a key needs to know whether an operator has approved
 * it yet. Without this it can only find out by connecting and reading the
 * `key_status` on a `-32014`, which means learning the answer by being
 * rejected — and, once § 8.1 lands, by having its socket closed.
 *
 * Unauthenticated, like everything else the hub serves. A public key is public,
 * and a fingerprint is meant to be compared out loud: § 10.2 requires a lane to
 * log its own at startup and the approval surface to display it. Withholding
 * either would break the comparison the procedure depends on.
 */
export function handleGetAgentKeys(identity: string): Response {
  if (!IDENTITY_RE.test(identity)) {
    return jsonResponse(400, { ok: false, error: "invalid identity format" });
  }

  const agent = stmtSelectAgent.get(identity) as
    | { type: string | null; deleted_at: string | null }
    | undefined;
  if (!agent) {
    return jsonResponse(404, { ok: false, error: `identity '${identity}' is not registered` });
  }

  const rows = keys.listKeys(agentsDb, identity);
  return jsonResponse(200, {
    ok: true,
    identity,
    // The registered type, for a host reclaiming an identity it already holds
    // a key for.
    //
    // `mesh.list_agents` also carries it and is reachable without a socket over
    // § 8.10, so the gap this closes is **not** "no connection" — it is **no
    // approved key**. `/api/v1/rpc` resolves the caller by fingerprint and
    // refuses `-32014` for anything pending, denied or revoked, which is
    // exactly the state a host is in while it waits for an operator or after a
    // rotation. This route is unauthenticated, so it answers then.
    //
    // It is also the narrower answer where both work: `mesh.list_agents`
    // enumerates every agent's type, this answers for one name the caller
    // already knew. Name to attribute, never attribute to name.
    type: agent.type,
    deleted: !!agent.deleted_at,
    // Why the identity cannot sign, or null when it can — the same value § 8.1
    // puts in a `-32014`, so a client sees one answer from both surfaces.
    key_status: keys.noKeyReason(agentsDb, identity),
    keys: rows.map((k) => ({
      fingerprint: k.fingerprint,
      status: k.status,
      proposed_at: k.proposed_at,
      decided_at: k.decided_at,
      decided_by: k.decided_by,
    })),
    events: keys.listKeyEvents(agentsDb, identity).map((e) => ({
      action: e.action,
      fingerprint: e.fingerprint,
      reason: e.reason,
      actor: e.actor,
      occurred_at: e.occurred_at,
    })),
  });
}
