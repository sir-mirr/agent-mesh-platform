/**
 * Agent-Mesh v2 — JSON-RPC Hub Server
 *
 * Central WebSocket message broker for AI agents across machines.
 * Uses Bun native WebSocket support + bun:sqlite for persistence.
 */

import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";

import { ConnectionOwnership } from "./connection-ownership";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const STATE_DIR =
  process.env.AGENT_MESH_STATE_DIR ?? "/srv/agent-mesh-lab/state/shared";
const HUB_PORT = parseInt(process.env.AGENT_MESH_HUB_PORT ?? "3100", 10);
const HEARTBEAT_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// SelfReminder DB (shared with self-reminder poller)
// ---------------------------------------------------------------------------

const SR_DB_PATH =
  process.env.SELF_REMINDER_DB ??
  `${STATE_DIR}/self-reminder.db`;

let _srDb: Database | null = null;
function srDb(): Database {
  if (!_srDb) {
    _srDb = new Database(SR_DB_PATH);
    _srDb.exec("PRAGMA journal_mode = WAL;");
    _srDb.exec("PRAGMA busy_timeout = 5000;");
  }
  return _srDb;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(...args: unknown[]) {
  console.log(`[hub]`, new Date().toISOString(), ...args);
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const db = new Database(`${STATE_DIR}/hub.db`, { create: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA busy_timeout = 5000;");

db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    identity    TEXT PRIMARY KEY,
    description TEXT,
    last_seen   DATETIME,
    type        TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Idempotent migration for legacy hub.db files. PRAGMA returns rows
// describing every column; we add any columns that are missing.
//   - `type`       : introduced after initial schema (task #72 era).
//   - `created_at` : introduced for ISO-8601 provenance (see SPEC §10.1).
//                    Backfilled from `last_seen` to give existing rows a
//                    plausible best-effort value; operators that want a
//                    cleaner state apply `ops/migrations/0001_*.sql`.
{
  const cols = db.prepare(`PRAGMA table_info(agents)`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "type")) {
    db.exec(`ALTER TABLE agents ADD COLUMN type TEXT`);
  }
  if (!cols.some((c) => c.name === "created_at")) {
    // SQLite forbids non-constant defaults on ALTER TABLE ADD COLUMN, so we
    // add the column nullable then backfill in a single UPDATE.
    db.exec(`ALTER TABLE agents ADD COLUMN created_at DATETIME`);
    db.exec(
      `UPDATE agents SET created_at = COALESCE(last_seen, datetime('now')) WHERE created_at IS NULL`
    );
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id         TEXT PRIMARY KEY,
    from_agent TEXT NOT NULL,
    to_agent   TEXT NOT NULL,
    content    TEXT NOT NULL,
    reply_to   TEXT,
    status     TEXT DEFAULT 'pending',
    ts         DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Prepared statements
const stmtUpsertAgent = db.prepare(`
  INSERT INTO agents (identity, description, last_seen, created_at)
  VALUES (?, ?, datetime('now'), datetime('now'))
  ON CONFLICT(identity) DO UPDATE SET
    description = COALESCE(excluded.description, agents.description),
    last_seen   = datetime('now')
    -- created_at intentionally NOT updated (immutable post-insert; SPEC §10.1)
`);

const stmtUpdateLastSeen = db.prepare(`
  UPDATE agents SET last_seen = datetime('now') WHERE identity = ?
`);

const stmtInsertMessage = db.prepare(`
  INSERT INTO messages (id, from_agent, to_agent, content, reply_to, status, ts)
  VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
`);

const stmtUpdateMessageStatus = db.prepare(`
  UPDATE messages SET status = ? WHERE id = ?
`);

const stmtListAgents = db.prepare(`
  SELECT identity, description, last_seen, type FROM agents ORDER BY identity
`);

// ── REST: POST /api/agents (pre-register identity with type) ───────────────
const stmtAgentExists = db.prepare(`
  SELECT 1 AS one FROM agents WHERE identity = ?
`);

const stmtUpsertAgentTyped = db.prepare(`
  INSERT INTO agents (identity, type, description, last_seen, created_at)
  VALUES (?, ?, ?, datetime('now'), datetime('now'))
  ON CONFLICT(identity) DO UPDATE SET
    type        = excluded.type,
    description = excluded.description
    -- created_at intentionally NOT updated (immutable post-insert; SPEC §10.1)
`);

const stmtSelectAgent = db.prepare(`
  SELECT
    identity,
    type,
    description,
    last_seen,
    strftime('%Y-%m-%dT%H:%M:%SZ', created_at) AS created_at_iso
  FROM agents WHERE identity = ?
`);

// ── REST: DELETE /api/agents/{identity} (teardown identity) ────────────────
const stmtDeleteAgent = db.prepare(`
  DELETE FROM agents WHERE identity = ?
`);

const stmtDeleteMessagesOfAgent = db.prepare(`
  DELETE FROM messages WHERE from_agent = ? OR to_agent = ?
`);

const stmtFetchMessages = db.prepare(`
  SELECT id, from_agent, to_agent, content, reply_to, status, ts
  FROM messages
  WHERE (from_agent = ?1 AND to_agent = ?2)
     OR (from_agent = ?2 AND to_agent = ?1)
  ORDER BY ts DESC
  LIMIT ?3
`);

const stmtPendingMessages = db.prepare(`
  SELECT id, from_agent, to_agent, content, reply_to, status, ts
  FROM messages
  WHERE to_agent = ? AND status = 'pending'
  ORDER BY ts ASC
`);

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

interface AgentSocket {
  identity: string;
  ws: any; // Bun ServerWebSocket
}

/** identity → WebSocket */
const onlineAgents = new Map<string, any>();

/** ws → identity (reverse lookup) */
const wsIdentities = new WeakMap<object, string>();

/** proxied identity → proxy agent's WebSocket */
const proxyMap = new Map<string, any>();

/** ws → Set of proxied identities (for cleanup on close) */
const wsProxies = new WeakMap<object, Set<string>>();

/** First established socket owns an identity until its own close event. */
const connectionOwnership = new ConnectionOwnership<object>();

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc?: string;
  method: string;
  params?: Record<string, any>;
  id?: string | number | null;
}

function rpcResult(id: string | number | null | undefined, result: unknown) {
  return JSON.stringify({ jsonrpc: "2.0", result, id: id ?? null });
}

function rpcError(
  id: string | number | null | undefined,
  code: number,
  message: string,
  data?: unknown
) {
  return JSON.stringify({
    jsonrpc: "2.0",
    error: { code, message, ...(data !== undefined ? { data } : {}) },
    id: id ?? null,
  });
}

function rpcNotification(method: string, params: unknown) {
  return JSON.stringify({ jsonrpc: "2.0", method, params });
}

// Standard JSON-RPC error codes
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

// ---------------------------------------------------------------------------
// Method handlers
// ---------------------------------------------------------------------------

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
function performConnect(
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

  // Handle proxy_for — register proxied identities
  const proxyFor: string[] = Array.isArray(params.proxy_for) ? params.proxy_for : [];
  if (proxyFor.length > 0) {
    const proxiedSet = wsProxies.get(ws) ?? new Set<string>();
    for (const pid of proxyFor) {
      if (typeof pid === "string" && pid.length > 0) {
        proxyMap.set(pid, ws);
        proxiedSet.add(pid);
      }
    }
    wsProxies.set(ws, proxiedSet);
    log(`${via === "connect" ? "connected" : "registered"} proxy: ${identity} → [${proxyFor.join(", ")}]`);
  }

  log(`${via === "connect" ? "connected" : "registered"}: ${identity}`);

  // Deliver pending messages
  deliverPending(identity, ws);

  // Deliver pending messages for proxied identities
  for (const pid of proxyFor) {
    deliverPending(pid, ws);
  }

  return rpcResult(id, { ok: true, identity });
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
function handleConnect(
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
function handleRegister(
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

function handleSend(
  ws: any,
  params: Record<string, any>,
  id: string | number | null | undefined
): string {
  const senderIdentity = wsIdentities.get(ws);
  if (!senderIdentity) {
    return rpcError(id, INVALID_REQUEST, "Not connected. Call mesh.connect first (or legacy mesh.register).");
  }

  const to = params.to;
  const content = params.content;
  if (!to || typeof to !== "string") {
    return rpcError(id, INVALID_PARAMS, "params.to is required");
  }
  if (content === undefined || content === null) {
    return rpcError(id, INVALID_PARAMS, "params.content is required");
  }

  const msgId = `msg_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const replyTo = params.reply_to ?? null;
  // Allow overriding sender identity (for proxied messages, e.g. from http-server on behalf of a user)
  const effectiveSender = (params.from && typeof params.from === "string") ? params.from : senderIdentity;

  const recipientWs = onlineAgents.get(to) ?? proxyMap.get(to);
  const isOnline = !!recipientWs;
  const status = isOnline ? "delivered" : "pending";

  // Persist message
  stmtInsertMessage.run(msgId, effectiveSender, to, String(content), replyTo, status);

  // Deliver immediately if recipient is online
  if (recipientWs) {
    try {
      recipientWs.send(
        rpcNotification("mesh.message", {
          id: msgId,
          from: effectiveSender,
          to,
          content: String(content),
          reply_to: replyTo,
          ts: new Date().toISOString(),
        })
      );
      log(`delivered: ${effectiveSender} → ${to} (${msgId})`);
      // Notify sender that message was delivered (for typing indicator)
      const senderWs = onlineAgents.get(effectiveSender) ?? proxyMap.get(effectiveSender);
      if (senderWs && senderWs !== recipientWs) {
        try {
          senderWs.send(rpcNotification("mesh.delivered", {
            id: msgId, from: effectiveSender, to, ts: new Date().toISOString(),
          }));
        } catch {}
      }
    } catch (err) {
      // If send fails, mark as pending
      stmtUpdateMessageStatus.run("pending", msgId);
      log(`delivery failed: ${effectiveSender} → ${to} (${msgId}), queued`);
      return rpcResult(id, { id: msgId, status: "pending" });
    }
  } else {
    log(`queued: ${senderIdentity} → ${to} (${msgId})`);
  }

  return rpcResult(id, { id: msgId, status });
}

function handleListAgents(
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

// ---------------------------------------------------------------------------
// SelfReminder handlers
// ---------------------------------------------------------------------------

function handleScheduleReminder(
  ws: any,
  params: Record<string, any>,
  id: string | number | null | undefined
): string {
  const agent_id = wsIdentities.get(ws);
  if (!agent_id) return rpcError(id, INVALID_REQUEST, "not registered");

  const { id: remId, type, schedule_spec, payload, context, idempotency_key, next_fire_at } = params;
  if (!remId || !type || !schedule_spec || !payload || !next_fire_at) {
    return rpcError(id, INVALID_PARAMS, "missing required: id/type/schedule_spec/payload/next_fire_at");
  }

  try {
    srDb()
      .prepare(
        `INSERT INTO reminders
           (id, agent_id, type, schedule_spec, payload, context, idempotency_key,
            status, next_fire_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
      )
      .run(
        remId,
        agent_id,
        type,
        schedule_spec,
        payload,
        context ?? null,
        idempotency_key ?? null,
        next_fire_at,
        agent_id
      );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("UNIQUE") || msg.includes("idx_reminders_idem_active")) {
      return rpcResult(id, { ok: false, error: "dedup", idempotency_key: idempotency_key });
    }
    return rpcError(id, -32000, `db error: ${msg}`);
  }
  return rpcResult(id, { ok: true, id: remId, type, next_fire_at });
}

function handleCancelReminder(
  ws: any,
  params: Record<string, any>,
  id: string | number | null | undefined
): string {
  const agent_id = wsIdentities.get(ws);
  if (!agent_id) return rpcError(id, INVALID_REQUEST, "not registered");

  const remId = params.id;
  if (!remId) return rpcError(id, INVALID_PARAMS, "id required");

  const res = srDb()
    .prepare(
      `UPDATE reminders SET status = 'cancelled', updated_at = datetime('now')
       WHERE id = ? AND agent_id = ? AND status IN ('active','paused')`
    )
    .run(remId, agent_id);

  return rpcResult(id, { changes: (res as any).changes });
}

function handleListReminders(
  ws: any,
  params: Record<string, any>,
  id: string | number | null | undefined
): string {
  const agent_id = wsIdentities.get(ws);
  if (!agent_id) return rpcError(id, INVALID_REQUEST, "not registered");

  const status = ((params.status as string) ?? "active").toLowerCase();
  const limit = Math.min(Math.max(Number(params.limit ?? 50), 1), 200);

  const rows =
    status === "all"
      ? srDb()
          .prepare(
            `SELECT id, type, status, schedule_spec, payload, context, next_fire_at,
                    fire_count, last_fired_at, idempotency_key, created_at
               FROM reminders WHERE agent_id = ?
              ORDER BY COALESCE(next_fire_at, last_fired_at, created_at) DESC LIMIT ?`
          )
          .all(agent_id, limit)
      : srDb()
          .prepare(
            `SELECT id, type, status, schedule_spec, payload, context, next_fire_at,
                    fire_count, last_fired_at, idempotency_key, created_at
               FROM reminders WHERE agent_id = ? AND status = ?
              ORDER BY COALESCE(next_fire_at, last_fired_at, created_at) DESC LIMIT ?`
          )
          .all(agent_id, status, limit);

  return rpcResult(id, { rows });
}

// ---------------------------------------------------------------------------
// Original handlers (continued)
// ---------------------------------------------------------------------------

function handleFetchMessages(
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
    content: string;
    reply_to: string | null;
    status: string;
    ts: string;
  }>;

  const messages = rows.map((r) => ({
    id: r.id,
    from: r.from_agent,
    to: r.to_agent,
    content: r.content,
    reply_to: r.reply_to,
    status: r.status,
    ts: r.ts,
  }));

  return rpcResult(id, { messages });
}

// ---------------------------------------------------------------------------
// Deliver pending messages on reconnect
// ---------------------------------------------------------------------------

function deliverPending(identity: string, ws: any) {
  const pending = stmtPendingMessages.all(identity) as Array<{
    id: string;
    from_agent: string;
    to_agent: string;
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

// ---------------------------------------------------------------------------
// Request dispatcher
// ---------------------------------------------------------------------------

function dispatch(ws: any, raw: string | Buffer): string | null {
  let req: JsonRpcRequest;
  try {
    req = JSON.parse(typeof raw === "string" ? raw : raw.toString());
  } catch {
    return rpcError(null, PARSE_ERROR, "Parse error");
  }

  if (!req.method || typeof req.method !== "string") {
    return rpcError(req.id, INVALID_REQUEST, "Invalid request: missing method");
  }

  const params = req.params ?? {};

  switch (req.method) {
    case "mesh.connect":
      return handleConnect(ws, params, req.id);
    case "mesh.register":
      return handleRegister(ws, params, req.id);
    case "mesh.send":
      return handleSend(ws, params, req.id);
    case "mesh.list_agents":
      return handleListAgents(ws, params, req.id);
    case "mesh.fetch_messages":
      return handleFetchMessages(ws, params, req.id);
    case "mesh.schedule_reminder":
      return handleScheduleReminder(ws, params, req.id);
    case "mesh.cancel_reminder":
      return handleCancelReminder(ws, params, req.id);
    case "mesh.list_reminders":
      return handleListReminders(ws, params, req.id);
    default:
      return rpcError(req.id, METHOD_NOT_FOUND, `Method not found: ${req.method}`);
  }
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

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
// REST: POST /api/agents — pre-register identity with type
// ---------------------------------------------------------------------------
//
// Replaces the legacy "本体 PM directly INSERTs via Python sqlite3" pattern.
// The PM (or any internal caller on the Tailscale net) POSTs identity + type
// + description, and the hub upserts. Why pre-register: mesh.register only
// writes (identity, description) → new identities land with type=NULL → UI
// shows "Unknown" until manual SQL fix-up. Pre-registration lets the adder
// classify type up front.
//
// Authentication: none (1차 구현). The hub binds to the Tailscale interface
// and assumes internal-only access, same trust boundary as ws://arumhub:3100/ws
// and the existing un-authenticated mesh.register. If/when needed, gate on
// env HUB_API_TOKEN compared against body.authToken.

const VALID_AGENT_TYPES = new Set(["ai-claude", "ai-codex", "service"]);
const IDENTITY_RE = /^[a-z][a-z0-9-]*$/;
const MAX_DESCRIPTION_LEN = 256;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function handlePostAgents(req: Request): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { ok: false, error: "invalid JSON body" });
  }
  if (!body || typeof body !== "object") {
    return jsonResponse(400, { ok: false, error: "body must be a JSON object" });
  }

  const identity = body.identity;
  const type = body.type;
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

  const existed = !!stmtAgentExists.get(identity);
  try {
    stmtUpsertAgentTyped.run(identity, type, description);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`POST /api/agents db error for ${identity}: ${msg}`);
    return jsonResponse(500, { ok: false, error: `db error: ${msg}` });
  }

  const action = existed ? "updated" : "inserted";
  log(`POST /api/agents: ${action} ${identity} (type=${type})`);
  return jsonResponse(200, { ok: true, identity, type, action });
}

// ---------------------------------------------------------------------------
// REST: POST /api/v1/agents — versioned provisioning endpoint
// ---------------------------------------------------------------------------
//
// SPEC §9 ("Base prefix: /api/v1") + §10 ("identity provisioning for remote
// lanes goes through POST /api/v1/agents on the core hub") normatively pin
// the versioned path. The unversioned /api/agents endpoint remains as a
// backwards-compatible alias for older callers (本体 PM gateway scripts,
// destroy-shadow-agent.sh) and behaves identically aside from response shape.
//
// Differences vs /api/agents:
//   • Returns 201 on first insert, 200 on UPSERT-update — lets callers
//     distinguish "just provisioned" from "already existed" via HTTP status
//     alone (SPEC §9 convention: POST that creates returns 201).
//   • Response body carries the canonical row: { identity, type, description,
//     created_at } where created_at is the agents.created_at column value
//     (DATETIME DEFAULT CURRENT_TIMESTAMP, immutable post-insert per SPEC §10.1;
//     stmtSelectAgent strftime-formats it to strict ISO-8601 YYYY-MM-DDTHH:MM:SSZ).
//
// Validation, auth posture, and DB effects are identical to /api/agents — we
// share the same VALID_AGENT_TYPES / IDENTITY_RE / MAX_DESCRIPTION_LEN rules
// and the same stmtUpsertAgentTyped statement. Schema is unchanged.

async function handlePostAgentsV1(req: Request): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { ok: false, error: "invalid JSON body" });
  }
  if (!body || typeof body !== "object") {
    return jsonResponse(400, { ok: false, error: "body must be a JSON object" });
  }

  const identity = body.identity;
  const type = body.type;
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

  const existed = !!stmtAgentExists.get(identity);
  try {
    stmtUpsertAgentTyped.run(identity, type, description);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`POST /api/v1/agents db error for ${identity}: ${msg}`);
    return jsonResponse(500, { ok: false, error: `db error: ${msg}` });
  }

  const row = stmtSelectAgent.get(identity) as
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
  log(`POST /api/v1/agents: ${action} ${identity} (type=${type}) -> ${status}`);
  return jsonResponse(status, {
    ok: true,
    identity: row?.identity ?? identity,
    type: row?.type ?? type,
    description: row?.description ?? description,
    // SPEC §10.1: strict ISO-8601 'T' / 'Z' representation of agents.created_at.
    // Immutable post-insert — UPSERT (UPDATE branch) does not touch created_at.
    created_at: row?.created_at_iso ?? null,
    action,
  });
}

// ---------------------------------------------------------------------------
// REST: DELETE /api/agents/{identity} — teardown identity from hub.db
// ---------------------------------------------------------------------------
//
// Removes the agent row and all messages it authored or received, atomically
// in a single transaction. Complements POST /api/agents so the hub owns the
// full identity lifecycle (create ↔ delete). Authentication policy matches
// POST /api/agents (1차 unauthenticated — Tailscale-internal only).
//
// Response always carries counts so callers (destroy-shadow-agent.sh, the
// agent-manage skill) can verify the teardown actually happened.

function handleDeleteAgent(identity: string): Response {
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

  const action = agentsRemoved > 0 ? "deleted" : "not-found";
  log(
    `DELETE /api/agents/${identity}: ${action} ` +
    `(agents_removed=${agentsRemoved}, messages_removed=${messagesRemoved})`
  );
  return jsonResponse(200, {
    ok: true,
    identity,
    action,
    agents_removed: agentsRemoved,
    messages_removed: messagesRemoved,
  });
}

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
    db.close();
  } catch {}

  log("shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
