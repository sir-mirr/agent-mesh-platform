# agent-mesh — Normative Specification

This document is the contract that any agent-mesh deployment, alternative
shared implementation, or external lane (runtime-adapter / channel-driver)
must satisfy.

Status: Draft, version 0.x. Subject to change before 1.0.

The keywords MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are used as
defined in RFC 2119 / RFC 8174.

---

## 1. Scope

This specification defines:

1. The **Baseline** contract — the three shared services (hub, http,
   self-reminder) that constitute the runtime backbone.
2. The **Add-on** contract — how a *lane* (runtime-adapter +
   channel-driver) attaches to the baseline.
3. The wire-level interfaces (JSON-RPC 2.0, HTTP REST, SSE).
4. The interfaces that runtime-adapters and channel-drivers must
   implement.
5. The conventions for systemd templating, port allocation, env/secret
   layout, and storage isolation.

### 1.1. Non-goals

- This document does not standardize specific runtimes (Codex, Claude
  Code, GPT, etc.) or specific channels (Discord, Telegram, ...) beyond
  the abstract adapter/driver interface.
- It does not specify the agent prompt format, persona model, or any
  application-level conversation policy.
- The legacy host plugin in `~/ai/plugins/agent-mesh/` and the legacy
  `md-viewer` are explicitly **out of scope** (see § 16).

---

## 2. Architectural model

agent-mesh is split into two strictly separated layers.

```
+---------------------------------------------------------+
|                  Baseline (shared)                      |
|  agent-mesh-hub   agent-mesh-http   agent-mesh-self-rem |
+----------------------------+----------------------------+
                             |
                hub WS  +  HTTP control plane
                             |
+----------------------------+----------------------------+
|                Add-ons — one or more lanes              |
|  runtime-adapter  +  channel-driver(s)                  |
+---------------------------------------------------------+
```

- The **baseline** MUST be runnable with zero registered agents.
- The **baseline** MUST NOT depend on any specific runtime-adapter or
  channel-driver implementation.
- An **add-on** MUST NOT bypass the baseline for cross-lane communication;
  all cross-agent traffic flows through the hub.

---

## 3. Baseline contract

### 3.1. `agent-mesh-hub` (`packages/shared/hub`)

| Property        | Requirement                                                 |
|-----------------|-------------------------------------------------------------|
| Transport       | WebSocket, JSON-RPC 2.0                                     |
| Default port    | `3100` (configurable via `AGENT_MESH_HUB_PORT`)             |
| Storage         | SQLite database `hub.db` (single file)                      |
| Identity model  | One agent ↔ one identity string (kebab-case recommended)    |
| Bootstrap hook  | `ExecStartPost` MUST run `ops/bin/bootstrap-hub-service-identities.sh` |

The hub MUST:

- Maintain an `agents` table keyed by `identity` with at least
  `(identity, type, description, created_at, last_seen)`.
- Persist all envelopes routed between agents in a `messages` table for
  later retrieval via `mesh.fetch_messages`.
- Treat unknown identities on `mesh.send` as a recoverable error
  (envelope is queued for later delivery).
- Emit notifications to subscribed clients when their inbox receives a
  new envelope (`mesh.message` / `mesh.delivered`, see § 8.9).
- Send a WebSocket-level `ping` frame to every connected agent every
  **30 seconds**. Agents MUST respond with a `pong` frame (the
  WebSocket runtime handles this transparently in most clients).
  Failure of the `ping` send marks the connection offline and removes
  it from the online map; `agents.last_seen` is touched before the
  socket is dropped.

The hub MUST NOT:

- Modify envelope payloads.
- Approve, register, or destructively mutate identities outside the
  bootstrap script (registration is via `POST /api/v1/agents`, see
  § 10.1; the deprecated `mesh.register` alias does **not** insert
  rows).

### 3.2. `agent-mesh-http` (`packages/shared/http`)

| Property        | Requirement                                                 |
|-----------------|-------------------------------------------------------------|
| Framework       | Hono                                                        |
| Default port    | `3000` (configurable via `AGENT_MESH_HTTP_PORT`)            |
| Auth            | GitHub OAuth → JWT (HS256), session cookie                  |
| Push            | Web Push, VAPID keys via env                                |
| PWA             | Static bundle served from the same origin                   |

The HTTP server is the single browser- and human-facing surface. It
proxies REST calls and SSE streams onto the hub via an internal hub
client.

### 3.3. `agent-mesh-self-reminder` (`packages/shared/self-reminder`)

A scheduler daemon that connects to the hub as `identity=self-reminder`.

| Schedule form   | Example                                  |
|-----------------|------------------------------------------|
| Relative once   | `{ "in": "30s" \| "5m" \| "2h" \| "1d" }` |
| Absolute once   | `{ "at": "2026-04-18T09:00:00Z" }`        |
| Repeating cron  | `{ "cron": "0 9 * * *", "tz": "Asia/Seoul" }` |

Delivery semantics: **at-least-once**. Consumers MUST be idempotent or
deduplicate via `idempotency_key`.

The names below are the **caller-facing helper / MCP tool surface** that
agent runtimes (Codex MCP server, Claude Code agent-mesh plugin, etc.)
expose to their operator. They are not the hub wire methods. Each helper
maps to a single JSON-RPC method on the hub:

| Helper / MCP tool name (caller surface) | Hub wire method (§ 8)     |
|-----------------------------------------|---------------------------|
| `schedule_self_reminder`                | `mesh.schedule_reminder`  |
| `cancel_reminder`                       | `mesh.cancel_reminder`    |
| `list_my_reminders`                     | `mesh.list_reminders`     |

Required helpers (delivered to identity `self-reminder` over the hub via
the wire methods above):

- `schedule_self_reminder(payload, schedule, idempotency_key?, context?, task_id?)`
- `cancel_reminder(reminder_id)` — owner-only
- `list_my_reminders(status?)`

Clients that talk to the hub directly (bypassing an MCP helper layer)
MUST emit the wire method names from § 8.5 / § 8.6 / § 8.7. Sending a
helper name (e.g. `"method": "schedule_self_reminder"`) over the hub
WebSocket will return `-32601` METHOD_NOT_FOUND.

---

## 4. Add-on contract — lanes

A **lane** is the unit of add-on deployment. A lane is identified by a
short kebab-case name (e.g. `prod-codex1`, `test-claude1`) which is also
its hub identity.

### 4.1. Composition

| Lane type   | Components                                                       |
|-------------|------------------------------------------------------------------|
| Codex lane  | `codex-app-server@<lane>` + `codex-adapter@<lane>` + `channel-discord@<lane>` |
| Claude lane | `channel-discord@<lane>` (+ external Claude Code MCP client)     |

Future lanes MAY use any combination of one runtime-adapter and one or
more channel-drivers.

### 4.2. Systemd templating

Each lane MUST be deployed as systemd template instances using the `@`
suffix. The template's `%i` substitution is the lane name. A single
deployment MAY run any number of lane instances concurrently, limited
only by port and resource availability.

### 4.3. Port allocation

Ports are derived from a small integer index `i` (1, 2, 3, ...) assigned
per lane:

| Component            | Port formula |
|----------------------|--------------|
| `codex-app-server@%i`| `4500 + i`   |
| `codex-adapter@%i`   | `4600 + i`   |
| `channel-discord@%i` | `4610 + i`   |

A deployment MUST track the `lane → i` mapping in a stable manifest so
that ports remain consistent across restarts.

### 4.4. Instance data layout

Per-lane data MUST live outside the code repository:

```
env/
  shared/        common.env, hub.env, http.env, self-reminder.env
  <lane>/        adapter.env, discord.env, app-server.env (codex)
                 discord.env (claude)
secrets/
  <lane>.env     DISCORD_BOT_TOKEN,
                 CODEX_ADAPTER_HTTP_TOKEN,
                 CHANNEL_DISCORD_HTTP_TOKEN
state/
  shared/uploads/
  codex/<lane>/  thread state, conversation files
attachments/
  <lane>/<msg_id>/
handoffs/<lane>/
channels/<lane>/
```

A lane MUST NOT read or write into another lane's directory.

### 4.5. HTTP control plane (intra-lane)

For lanes where driver and adapter are both in-tree (e.g. Codex lane),
the two MUST authenticate every HTTP request with a shared secret.

| Direction         | Header                            | Source env                       |
|-------------------|-----------------------------------|----------------------------------|
| driver → adapter  | `X-Adapter-Token`                 | `CODEX_ADAPTER_HTTP_TOKEN`       |
| adapter → driver  | `X-Channel-Token`                 | `CHANNEL_DISCORD_HTTP_TOKEN`     |

Tokens MUST be unique per lane.

---

## 5. `runtime-adapter` interface

A runtime-adapter wraps an external runtime (Codex CLI, Claude Code,
etc.) and exposes it to the mesh as a single hub identity.

Reference implementation: `packages/runtime-adapters/codex/src/`
(`adapter.ts`, `codex-client.ts`, `hub-client.ts`, `thread-manager.ts`,
`turn-envelope.ts`, `reply-dispatcher.ts`, `rotation-policy.ts`,
`queue.ts`, `http-server.ts`, `http-action-proxy.ts`).

### 5.1. Required behaviors

A runtime-adapter implementation MUST:

1. **Hub registration** — connect to the hub as a JSON-RPC 2.0 WS client
   and call `mesh.register` with `identity = <lane>`. It MAY pass
   `proxy_for[]` to claim ownership of derivative identities.
2. **Envelope ingest** — accept incoming envelopes from the hub and
   translate them into runtime-native turns/messages.
3. **Envelope emit** — translate runtime output into envelopes and
   forward via `mesh.send`. Envelopes MUST conform to
   `agent-mesh-core/envelope.ts`.
4. **Action proxying** — when the runtime emits a tool/action call,
   route it through the action-proxy contract
   (`agent-mesh-core/action-proxy.ts`).
5. **Thread lifecycle** — manage runtime-side threads/sessions including
   creation, rotation, and teardown. Rotation policy MUST be
   externalized (env or config), not hard-coded.
6. **HTTP control surface** — expose an HTTP endpoint authenticated by
   `CODEX_ADAPTER_HTTP_TOKEN` (or equivalent per-runtime token) for
   in-lane drivers to deliver inbound channel events.
7. **Reconnect** — on hub disconnect, retry with bounded exponential
   backoff. Buffered envelopes MUST NOT be dropped silently.

### 5.2. Required exports

```
adapter.start(config): Promise<void>
adapter.stop(): Promise<void>
```

---

## 6. `channel-driver` interface

A channel-driver wraps an external channel (Discord, Telegram, ...) and
maps channel events to mesh envelopes.

Reference implementation: `packages/channel-drivers/discord/src/`
(`main.ts`, `runtime.ts`, `envelope.ts`, `tools.ts`, `attachments.ts`,
`access.ts`, `channels.ts`, `chunk.ts`, `recent-sent.ts`,
`hub-forward.ts`, `http.ts`, `config.ts`, `types.ts`).

### 6.1. Required behaviors

A channel-driver implementation MUST:

1. **Channel ingest** — receive native channel events (messages,
   reactions, attachments) and normalize them into envelopes.
2. **Access control** — enforce per-channel access lists
   (`access.ts` model). Unknown senders MUST be rejected and never
   silently approved by the driver itself.
3. **Forwarding mode** — support two modes:
   - *Adapter mode* — POST envelopes to an in-tree runtime-adapter
     (HTTP, mutually authenticated).
   - *Hub-direct mode* — open a hub WS connection as
     `HUB_FORWARD_IDENTITY=<lane>` and `mesh.send` directly.
4. **Attachment handling** — persist attachments under
   `attachments/<lane>/<msg_id>/` and reference them in the envelope.
   In a cross-VM deployment (§ 14), the **core VM** is the primary
   attachment store and lane VMs fetch on demand; see § 14.7 for the
   cross-VM summary and § 15 for the full attachments contract.
5. **Chunking** — split outbound channel messages that exceed the
   channel's per-message limit (`chunk.ts` model).
6. **Recent-sent dedupe** — suppress duplicate outbound deliveries
   (`recent-sent.ts` model).
7. **Tool surface** — expose channel-specific tools (e.g. reactions,
   reply-to, edit) through the `tool-contract.ts` model.

### 6.2. Required exports

```
driver.start(config): Promise<void>
driver.stop(): Promise<void>
```

---

## 7. `agent-mesh-core` core types

`packages/agent-mesh-core/src/` is a pure type/utility package. No I/O.

| Module             | Role                                                       |
|--------------------|------------------------------------------------------------|
| `envelope.ts`      | `ChannelEnvelope` — canonical channel-source envelope (see § 7.1) |
| `action-proxy.ts`  | Tool/action call routing across runtime ↔ mesh boundaries  |
| `capabilities.ts`  | Per-identity capability declarations                       |
| `history.ts`       | History query/segment helpers                              |
| `hub.ts`           | Base hub client (used by adapters/drivers)                 |
| `ownership.ts`     | `proxy_for` / owner-of-identity model                      |
| `registry.ts`      | In-memory registry projection of `agents` table            |
| `tool-contract.ts` | Channel/runtime tool descriptor schema                     |

These types are normative — adapters and drivers MUST consume them
verbatim rather than defining parallel shapes.

### 7.1. `ChannelEnvelope`

`ChannelEnvelope` is the canonical channel-side envelope shape produced
by `channel-driver`s when they normalize a native channel event into a
mesh-routable payload. It carries the *origin metadata* of a channel
message (source, chat id, message id, sender) plus the human-readable
`text` body.

```
ChannelEnvelope = {
  source:           "agent-mesh" | "discord" | "telegram"   // required
  chatId:           string                                   // required
  messageId:        string                                   // required
  text:             string                                   // required
  user?:            string                                   // display name
  userId?:          string                                   // stable id
  ts?:              string                                   // ISO-8601
  replyTo?:         string                                   // peer message id
  attachmentCount?: number
  attachments?:     string                                   // serialized list
}
```

A `ChannelEnvelope` is **not** the wire payload of `mesh.send` itself
(see § 8.2). When a channel-driver forwards an inbound event to the
hub, it serializes the envelope into a `<channel …>…</channel>` tagged
string via `formatChannelEnvelope()` and sends that string as the flat
`content` field of `mesh.send`. The receiver MAY parse the wrapper back
into a `ChannelEnvelope` with `parseChannelEnvelope()`. Hub-internal
messages (agent ↔ agent without a channel origin) MAY skip the
`<channel …>` wrapper and use plain text content.

The legacy `{ id, from, to, kind, payload, meta, ts }` shape mentioned
in pre-v0.1 drafts is **not** implemented and is reserved for a future
breaking redesign (§ 13).

---

## 8. Hub JSON-RPC method signatures

All methods are over JSON-RPC 2.0 on a WebSocket. Errors follow the
JSON-RPC 2.0 error object form.

Identity registration (insertion of `(identity, type, description)`
rows into `hub.db:agents`) is **not** done over JSON-RPC; it is done
out of band via `POST /api/v1/agents` (see § 10.1). The JSON-RPC
methods below operate on *already-registered* identities.

### 8.1. `mesh.connect`

Marks a pre-registered identity as online on this WebSocket. This is
the SSOT runtime-connect signal — `mesh.register` (§ 8.1a) is a
deprecated alias retained for backward compatibility with older agent
clients.

```
params: {
  identity:    string         // kebab-case; MUST be pre-registered
  proxy_for?:  string[]       // additional identities this socket handles
}
result: {
  ok:       true
  identity: string            // canonical identity
}
```

Any param beyond `identity` and `proxy_for` is **ignored** by the hub.
In particular, `type` and `description` (if present, e.g. carried over
by older clients that grew them onto `mesh.register` before § 8.1a
explicitly demoted them) MUST NOT cause an error, MUST NOT update
`agents.type` or `agents.description`, and MUST NOT block the
connection. The hub deliberately silently drops these fields rather
than failing on unknown params, so a client that emits the older
`mesh.register`-shaped payload against `mesh.connect` still connects
cleanly. `type` and `description` are persisted only by
`POST /api/v1/agents` (§ 10.1) — `mesh.connect` is a pure
runtime-connect signal, not a provisioning call. The same rule applies
to the `mesh.register` alias of § 8.1a.

Errors:

- `-32602` INVALID_PARAMS — `params.identity` missing or non-string.
- `-32010` DUPLICATE_IDENTITY — another connection holds this identity
  and connected less than the deduplication window ago. `data` carries
  `{ code: "DUPLICATE_IDENTITY", elapsed_ms, window_ms }`.
- `-32011` IDENTITY_NOT_REGISTERED — the identity has no row in
  `hub.db:agents`. `data` carries `{ code: "IDENTITY_NOT_REGISTERED",
  identity }`. The hub closes the WebSocket with code `1008` shortly
  after returning this error.

On success the hub touches `agents.last_seen`, wires the socket into
the online map, and delivers any pending messages addressed to the
identity (and to each `proxy_for` entry).

### 8.1a. `mesh.register` (deprecated alias)

`mesh.register` is a deprecated alias for `mesh.connect`. It accepts
the same params and returns the same result. The hub logs a one-line
deprecation warning per call (`DEPRECATED: mesh.register called by
<identity>; migrate clients to mesh.connect`). Older client builds
emit `mesh.register` on boot; new clients SHOULD emit `mesh.connect`.

The `type` and `description` params, if present on a `mesh.register`
call, are ignored — the hub does not write to `agents` from this
codepath. Use `POST /api/v1/agents` (§ 10.1) to set or update those
fields.

### 8.2. `mesh.send`

Routes a message envelope (in flat-content form) to another identity.

```
params: {
  to:        string           // recipient identity
  content:   string           // message body (often a formatted
                              // ChannelEnvelope string; see § 7.1)
  reply_to?: string | null    // peer message id this replies to
  from?:     string           // optional sender override; defaults
                              // to the socket's registered identity
                              // (used by proxy senders such as the
                              // HTTP server forwarding on a user's behalf)
}
result: {
  id:     string              // hub-assigned message id ("msg_<16hex>")
  status: "delivered" | "pending"
}
```

`status` is `"delivered"` when the recipient socket was online and the
hub successfully pushed a `mesh.message` notification (§ 8.9) to it;
`"pending"` otherwise (the envelope is persisted to `messages` and
will be delivered on the recipient's next connect via
`mesh.fetch_messages`/auto-deliver).

Errors:

- `-32602` INVALID_PARAMS — `params.to` missing/non-string or
  `params.content` missing.
- `-32600` INVALID_REQUEST — sender socket is not connected
  (`mesh.connect` / `mesh.register` was never called on this WS).

### 8.3. `mesh.list_agents`

Returns the full agent registry.

```
params: {}                    // no params at v0.1; status filter is
                              // not implemented — results always
                              // include all rows
result: {
  agents: Array<{
    id:          string       // identity (kebab-case)
    type:        string | null
    description: string | null
    online:      boolean
    last_seen:   string | null  // ISO-8601 when present
  }>
}
```

Note: the per-agent key is `id` (carrying the identity string), not
`identity`. Clients MUST read `agents[].id`.

### 8.4. `mesh.fetch_messages`

Returns recent persisted messages between the caller's identity and
the named peer.

```
params: {
  agent_id: string            // peer identity
  limit?:   number            // default 20, max 200
}
result: {
  messages: Array<{
    id:       string          // hub-assigned message id
    from:     string          // sender identity
    to:       string          // recipient identity
    content:  string          // flat content string (see § 8.2)
    reply_to: string | null
    status:   "delivered" | "pending"
    ts:       string          // ISO-8601
  }>
}
```

The message shape matches the inbound flat form pushed by `mesh.send`,
not a `ChannelEnvelope` object. Older drafts of this spec listed a
`before: <message_id_cursor>` param for backwards pagination; it is
**not implemented at v0.1** and MUST NOT be sent by callers.

Errors:

- `-32602` INVALID_PARAMS — `params.agent_id` missing or non-string.
- `-32600` INVALID_REQUEST — caller socket is not connected.

### 8.5. `mesh.schedule_reminder`

Schedules a single reminder row in the `self-reminder` daemon's database.
This is the hub-level wire method invoked by the `schedule_self_reminder`
helper / MCP tool described in § 3.3.

```
params: {
  id:              string         // reminder id (caller-generated, e.g. "rem_<16hex>")
  type:            "once" | "cron" | "interval"
  schedule_spec:   string         // type-specific schedule expression
  payload:         string         // message body the daemon will mesh.send back
  next_fire_at:    string         // ISO-8601 of the first fire time (UTC)
  context?:        string         // opaque caller context, echoed at fire time
  idempotency_key?: string        // dedup key; UNIQUE among caller's `active` rows
}
result: {
  ok:               true
  id:               string        // echoed reminder id
  type:             string        // echoed type
  next_fire_at:     string        // echoed next fire time
}
```

If a row with the same `idempotency_key` already exists in status
`active` for the caller, the hub returns `{ ok: false, error: "dedup",
idempotency_key }` rather than inserting a duplicate. Callers SHOULD
treat that as success (the prior schedule is still pending).

Errors:

- `-32602` INVALID_PARAMS — required field missing
  (`id` / `type` / `schedule_spec` / `payload` / `next_fire_at`).
- `-32600` INVALID_REQUEST — caller socket is not connected.
- `-32000` server error — propagated SQLite error (the `data` field
  carries the underlying message).

The reminder row is owned by `agent_id = <caller identity>`. Other
identities cannot read, cancel, or list it.

### 8.6. `mesh.cancel_reminder`

Cancels a single reminder owned by the calling identity. This is the
hub-level wire method invoked by the `cancel_reminder` helper / MCP
tool described in § 3.3.

```
params: {
  id: string                      // reminder id to cancel
}
result: {
  changes: number                 // number of rows transitioned to "cancelled"
                                  // (0 if the id was not owned, already in a
                                  // terminal state, or did not exist)
}
```

The hub transitions rows from `active` or `paused` to `cancelled`. Rows
already in `fired`, `cancelled`, `exhausted`, or `dead` are left
unchanged and the call returns `changes: 0`. Cancellation is
**owner-scoped**: a caller MUST NOT cancel reminders owned by another
identity, enforced by `WHERE agent_id = <caller identity>` in the
update statement.

Errors:

- `-32602` INVALID_PARAMS — `params.id` missing.
- `-32600` INVALID_REQUEST — caller socket is not connected.

### 8.7. `mesh.list_reminders`

Lists reminders owned by the calling identity. This is the hub-level
wire method invoked by the `list_my_reminders` helper / MCP tool
described in § 3.3.

```
params: {
  status?: "active" | "paused" | "fired" | "cancelled"
                                  // | "exhausted" | "dead" | "all"
                                  // default: "active"
  limit?:  number                 // 1..200, default 50
}
result: {
  rows: Array<{
    id:              string
    type:            "once" | "cron" | "interval"
    status:          string
    schedule_spec:   string
    payload:         string
    context:         string | null
    next_fire_at:    string | null
    fire_count:      number
    last_fired_at:   string | null
    idempotency_key: string | null
    created_at:      string
  }>
}
```

When `status = "all"`, rows in any status owned by the caller are
returned (most-recent first). Listing is **owner-scoped**: a caller's
identity is bound to the result set by `WHERE agent_id = <caller
identity>` in the underlying SELECT.

Errors:

- `-32600` INVALID_REQUEST — caller socket is not connected.

### 8.9. Server-pushed notifications

In addition to client-initiated requests above, the hub emits two
JSON-RPC 2.0 notifications (no `id` field; clients MUST NOT respond
with a JSON-RPC response).

#### 8.9.1. `mesh.message`

Pushed to a recipient socket when the hub routes an inbound
`mesh.send` to it, **and** when a previously-pending message is
delivered on reconnect.

```
method: "mesh.message"
params: {
  id:       string            // hub-assigned message id
  from:     string            // sender identity
  to:       string            // recipient identity (this socket's identity
                              // or one of its proxy_for entries)
  content:  string            // flat content string (see § 8.2)
  reply_to: string | null
  ts:       string            // ISO-8601
}
```

The hub MUST emit `mesh.message` once per successful delivery. Clients
SHOULD handle this method; unknown-method behaviour at the JSON-RPC
layer (the spec does not require a response since it is a
notification) MUST NOT close the connection.

#### 8.9.2. `mesh.delivered`

Pushed to a sender socket when the hub routes a `mesh.send` from that
sender to an online recipient — i.e. whenever the same `mesh.send`
call's result returns `status: "delivered"` (§ 8.2). Intended as a
v0.1 typing/delivery indicator; clients MAY ignore it.

```
method: "mesh.delivered"
params: {
  id:   string                // hub-assigned message id
  from: string                // sender identity
  to:   string                // recipient identity
  ts:   string                // ISO-8601
}
```

The hub MUST NOT emit `mesh.delivered` when the recipient is offline
(in that case `mesh.send.result.status` is `"pending"` and no
notification is sent until the recipient reconnects).

---

## 9. HTTP REST contract

The HTTP REST surface is split across **two distinct listeners** on the
core VM. Routes documented in this section are served by
`agent-mesh-http` unless otherwise noted; the hub control-plane routes
in § 9.4 are served by `agent-mesh-hub` on a different port.

Base prefix for `agent-mesh-http`: `/api/v1` (plus a small number of
unversioned legacy routes like `/auth/*`). Auth column meanings:

- *None* — public route (no JWT required).
- *JWT* — requires the OAuth-issued session cookie (HS256 JWT).
- *JWT\** — JWT plus the `admin` role claim.
- *Token* — service-to-service token in `Authorization: Bearer …`.

### 9.1. `agent-mesh-http` user-facing routes (`AGENT_MESH_HTTP_PORT`, default `3000`)

| Method | Path                              | Auth   | Success | Notes |
|--------|-----------------------------------|--------|---------|-------|
| GET    | `/api/v1/health`                  | None   | `200`   | Liveness ping. |
| GET    | `/api/v1/agents`                  | JWT    | `200`   | Projection of hub agent registry. |
| POST   | `/api/v1/messages`                | JWT    | `201`   | Send a message via hub. |
| GET    | `/api/v1/messages/:agent`         | JWT    | `200`   | Conversation history with one peer. |
| GET    | `/api/v1/messages/search`         | JWT    | `200`   | Full-text search across messages. |
| GET    | `/api/v1/events/:agentId` (SSE)   | JWT    | `200`   | Server-sent events for a single inbox. |
| POST   | `/api/v1/upload`                  | JWT    | `200`   | Upload attachment; returns § 15.2 metadata object. |
| GET    | `/api/v1/files`                   | JWT    | `200`   | List uploaded files. |
| GET    | `/api/v1/attachments/:id`         | None ‡ | `200`   | Download attachment bytes (§ 15.3). |
| GET    | `/api/v1/admin/pending`           | JWT\*  | `200`   | List users pending approval. |
| POST   | `/api/v1/admin/approve`           | JWT\*  | `200`   | Approve a pending user. |
| POST   | `/api/v1/admin/deny`              | JWT\*  | `200`   | Deny a pending user. |
| GET    | `/api/v1/admin/chat-audits`       | JWT\*  | `200`   | Cursor-paginated message audit log. |
| GET    | `/api/v1/admin/chat-audits/stream`| JWT\*  | `200`   | SSE stream of new audited messages. |
| GET    | `/api/v1/admin/chat-audits/agents`| JWT\*  | `200`   | Distinct agent identities in audit log. |
| POST   | `/api/v1/ingest/ai-usage`         | Token  | `200`   | AI-usage snapshot ingest (`AI_USAGE_INGEST_TOKEN`). |
| GET    | `/api/v1/admin/ai-usage`          | JWT\*  | `200`   | Latest AI-usage snapshot. |
| GET    | `/api/v1/admin/ai-usage/stream`   | JWT\*  | `200`   | SSE stream of AI-usage updates. |
| GET    | `/api/v1/push/vapid-key`          | None   | `200`   | VAPID public key (PWA registration). |
| POST   | `/api/v1/push/subscribe`          | JWT    | `200`   | Register a Web Push subscription. |
| POST   | `/api/v1/push/unsubscribe`        | JWT    | `200`   | Drop a Web Push subscription. |
| GET    | `/auth/github`                    | None   | `302`   | Begin GitHub OAuth flow. |
| GET    | `/auth/github/callback`           | None   | `302`   | OAuth callback; sets `mesh_token` cookie. |
| POST   | `/auth/local`                     | None   | `302`   | Local username/password login; sets cookie. |
| GET    | `/auth/me`                        | JWT    | `200`   | Current user info. |

‡ `/api/v1/attachments/:id` is unauthenticated at internal-mesh v0.1
(SPEC § 15.3 — assumes trust-bounded network). Future profiles MAY
require a bearer token; clients SHOULD tolerate `401`.

Unauthenticated access to any non-public route MUST return `401`.
Unauthorized access (valid JWT but missing scope, e.g. JWT without the
`admin` role for a `JWT*` route) MUST return `403`.

### 9.2. Control-plane routes on `agent-mesh-hub` (`AGENT_MESH_HUB_PORT`, default `3100`)

The hub listener serves both WebSocket upgrades (the JSON-RPC surface
of § 8) **and** a small REST control plane for identity provisioning
and teardown. These routes live on the hub port, NOT on
`agent-mesh-http`.

| Method | Path                              | Auth   | Success | Notes |
|--------|-----------------------------------|--------|---------|-------|
| GET    | `/health`                         | None   | `200`   | Hub liveness + `online_agents` count. |
| POST   | `/api/agents`                     | None † | `200`   | Legacy provisioning alias; response shape MAY differ from `/api/v1/agents` — see § 10.1. |
| POST   | `/api/v1/agents`                  | None † | `200`\|`201` | Canonical identity provisioning (§ 10.1). |
| DELETE | `/api/agents/{identity}`          | None † | `200`   | Teardown identity + its messages atomically — see § 9.3. |

† At v0.1, hub REST routes are unauthenticated on the assumption the
hub binds to a trust-bounded interface (Tailscale or LXC-internal
bridge). Public-internet deployments MUST gate these routes behind a
bearer token or equivalent before exposing them (§ 10.1).

### 9.3. `DELETE /api/agents/{identity}` response shape

The hub MUST treat `DELETE /api/agents/{identity}` as the destructive
counterpart of `POST /api/v1/agents`. Together they let the hub own the
full identity lifecycle (create ↔ delete) without callers needing direct
SQL access to `hub.db`.

**Identity validation.** `{identity}` MUST match
`^[a-z][a-z0-9-]*$`. Anything else MUST return `400` with body
`{ "ok": false, "error": "invalid identity format …" }`.

**Behavior.** The hub MUST, in a single SQL transaction, delete:

1. The row in `agents` whose `identity` matches the path parameter.
2. Every row in `messages` whose `from` or `to` equals that identity.

If either step fails, the transaction MUST `ROLLBACK` and the hub MUST
return `500` with `{ "ok": false, "error": "db error: <reason>" }`.

**Response body** (`200 OK`):

```
{
  "ok":               true,
  "identity":         "<echoed identity>",
  "action":           "deleted" | "not-found",
  "agents_removed":   <integer, 0 or 1>,
  "messages_removed": <integer ≥ 0>
}
```

`"action": "not-found"` (with `agents_removed: 0`) is the response for
a DELETE against an identity that does not exist in `hub.db:agents`.
Callers (e.g. `destroy-shadow-agent.sh`, the `agent-manage` skill)
SHOULD treat `200 + not-found` as idempotent success rather than as
an error.

### 9.4. Host split summary

When wiring an out-of-tree client (lane VM, admin tooling, ops
scripts), callers MUST direct each request to the correct listener.
The table below is the SSOT.

| Route family                              | Listener         | Default port |
|-------------------------------------------|------------------|--------------|
| `GET /api/v1/health`, `/api/v1/*` user-facing | `agent-mesh-http` | `3000` |
| `/api/v1/attachments/:id`                 | `agent-mesh-http` | `3000` |
| `/auth/*`                                 | `agent-mesh-http` | `3000` |
| `GET /health` (hub liveness)              | `agent-mesh-hub`  | `3100` |
| `POST /api/agents`                        | `agent-mesh-hub`  | `3100` |
| `POST /api/v1/agents`                     | `agent-mesh-hub`  | `3100` |
| `DELETE /api/agents/{identity}`           | `agent-mesh-hub`  | `3100` |
| WebSocket upgrades (JSON-RPC of § 8)      | `agent-mesh-hub`  | `3100` |

A client that issues `POST /api/v1/agents` against
`agent-mesh-http:3000` will receive `404 Not Found` and vice versa for
attachment downloads against the hub port.

---

## 10. Bootstrap contract

`ops/bin/bootstrap-hub-service-identities.sh` is invoked by the hub unit
as `ExecStartPost`. It MUST:

1. Open `hub.db` (creating it if missing) and ensure schema is current.
2. UPSERT the six built-in service identities (e.g. `self-reminder`,
   `http`, `admin`, `bootstrap`, plus reserved slots) with appropriate
   `type` and `description`.
3. Be **idempotent** — repeated invocations MUST NOT duplicate rows or
   alter user-modified fields beyond the seeded baseline.
4. Exit `0` on success; non-zero exit MUST fail the hub unit start so
   the operator notices.

The script MUST NOT delete identities, MUST NOT touch the `messages`
table, and MUST NOT depend on any lane being present.

In a cross-VM deployment (§ 14), lane VMs MUST NOT bypass this script
and MUST NOT write to `hub.db` over the network; identity provisioning
for remote lanes goes through `POST /api/v1/agents` on the core hub.

### 10.1. Identity provisioning API (`POST /api/v1/agents`)

The core hub MUST expose `POST /api/v1/agents` on the same HTTP listener
that serves WebSocket upgrades (`AGENT_MESH_HUB_PORT`, default `3100`).
This endpoint is the single normative entry point for inserting or
updating rows in `hub.db:agents` from any caller — local bootstrap, the
PM gateway, or remote lane VMs.

**Request** (`Content-Type: application/json`):

```
{
  "identity":    "<kebab-case string>",   // required, ^[a-z][a-z0-9-]*$
  "type":        "ai-claude" | "ai-codex" | "service",  // required
  "description": "<string, ≤ 256 chars>"  // optional, may be null
}
```

**Behavior** — the hub MUST:

1. Validate `identity` against `^[a-z][a-z0-9-]*$`; reject with `400` otherwise.
2. Validate `type` against the enum above; reject with `400` otherwise.
3. UPSERT the row: `INSERT … ON CONFLICT(identity) DO UPDATE SET type, description`.
4. Return `201 Created` when the row did not previously exist, `200 OK`
   when the row already existed and was updated.
5. Return `500` only on a genuine DB error; transient errors MAY be retried
   by callers using exponential or fixed backoff.

**Response body** (both `200` and `201`):

```
{
  "ok":          true,
  "identity":    "<canonical identity>",
  "type":        "<canonical type>",
  "description": "<canonical description or null>",
  "created_at":  "<ISO-8601 timestamp>",   // strict YYYY-MM-DDTHH:MM:SSZ (UTC)
  "action":      "inserted" | "updated"
}
```

The `created_at` field reflects `agents.created_at` — the timestamp at
which the identity row was first INSERTed into `hub.db:agents`. The
field is **immutable post-insert**: an `"updated"` response returns the
*original* creation time, not the touch time of the current UPSERT.

Format MUST be strict ISO-8601 with a `T` date/time separator and a
trailing `Z`, i.e. `YYYY-MM-DDTHH:MM:SSZ`, always in UTC. The hub
produces this via SQLite
`strftime('%Y-%m-%dT%H:%M:%SZ', created_at)`.

**v0.1 compatibility.** Hub builds before this clause stored no dedicated
creation column and returned `agents.last_seen` in the `created_at`
field. Operators upgrading from v0.1:

- The hub binary contains an idempotent in-process migration that ADDs
  the column at boot and backfills it from `last_seen` (falling back to
  `now()` when `last_seen` is `NULL`).
- The equivalent SQL is shipped as
  `ops/migrations/0001_agents_add_created_at.sql` for operators who
  prefer to migrate ahead of a binary upgrade.
- Both paths yield approximate (`last_seen`-derived) `created_at` for
  pre-existing rows. Rows inserted by post-migration hub builds carry
  the true creation timestamp.

Callers that need durable creation provenance for the v0.1 fallback
window SHOULD continue to record it externally (e.g. provisioning log);
the migrated values are best-effort, not authoritative.

**Authentication.** v0.1 deployments MAY leave this endpoint
unauthenticated when the hub binds to a trust-bounded interface (Tailscale
or LXC-internal bridge). Public-internet deployments MUST gate the route
behind a bearer token or equivalent before exposing it. Callers MUST NOT
write directly to `hub.db` (whether by `sqlite3` shell, SQL over an SSH
tunnel, or any other mechanism); the API is the only sanctioned path.

**Backwards compatibility.** The hub MAY also expose the unversioned
alias `POST /api/agents` for legacy callers (PM gateway scripts predating
this spec section). The alias MUST validate identically; its response
shape MAY differ. New callers MUST prefer the versioned path.

The current legacy response shape on the reference hub is:

```
{
  "ok":       true,
  "identity": "<canonical identity>",
  "type":     "<canonical type>",
  "action":   "inserted" | "updated"
}
```

Compared to the canonical `/api/v1/agents` response, the legacy alias
omits `description` and `created_at` and always returns HTTP `200`
(never `201`). Callers that need the description or creation timestamp
MUST use `POST /api/v1/agents`.

**Identity teardown.** The destructive counterpart to this endpoint is
`DELETE /api/agents/{identity}` on the same hub listener — see § 9.3
for the response shape (`agents_removed`, `messages_removed` counts).
The hub does not expose a versioned `DELETE /api/v1/agents/{identity}`
at v0.1; the unversioned form is the only normative shape.

---

## 11. Token & identity separation

The deployment uses several distinct secrets. They MUST NOT be merged
or reused across boundaries.

| Token                          | Where lives             | Purpose                         |
|--------------------------------|-------------------------|---------------------------------|
| `GITHUB_CLIENT_SECRET`         | `secrets/shared.env`    | OAuth login                     |
| `JWT_SECRET`                   | `secrets/shared.env`    | HTTP session JWT signing        |
| `VAPID_PRIVATE_KEY`            | `secrets/shared.env`    | Web Push                        |
| `DISCORD_BOT_TOKEN`            | `secrets/<lane>.env`    | Discord channel auth            |
| `CODEX_ADAPTER_HTTP_TOKEN`     | `secrets/<lane>.env`    | driver → adapter HTTP           |
| `CHANNEL_DISCORD_HTTP_TOKEN`   | `secrets/<lane>.env`    | adapter → driver HTTP           |

Identity strings (e.g. `prod-codex1`) are **public** and appear in logs
and envelopes; they MUST NOT carry secret material.

---

## 12. Port offset rule (extending to N lanes)

To add an N-th lane:

1. Choose a fresh integer index `i = N`.
2. Allocate ports per § 4.3 (`4500+i`, `4600+i`, `4610+i`).
3. Reserve future channel-driver ports as `4620+i`, `4630+i`, ... in
   blocks of 10. Each new channel-driver type SHOULD claim its own
   block.
4. Persist `(lane → i)` mapping in the deployment's manifest.
5. Verify no port collision before `systemctl enable --now`.

A driver or adapter implementation MUST read its bound port from env,
never hard-code it.

---

## 13. Versioning

This specification follows semantic versioning at document level.

- `0.x` — breaking changes are allowed between minor versions.
- `1.0` — wire formats (envelope shape, JSON-RPC method names, REST
  paths) become stable.
- `2.0` — reserved for the next breaking redesign.

Implementations SHOULD declare the SPEC version they target in their
`package.json` under a `agentMeshSpec` field.

---

## 14. Cross-VM deployment (internal-mesh v0.1)

This section normalizes the **internal-mesh v0.1** deployment profile,
in which the baseline runs on one *core VM* and each lane runs on its
own *lane VM*. It is a production-style alternative to the default
single-host topology and does not replace it; a conformant deployment
MAY use either.

### 14.1. Topology

A `internal-mesh v0.1` deployment MUST consist of:

1. Exactly one **core VM** running the full baseline:
   `agent-mesh-hub`, `agent-mesh-http`, `agent-mesh-self-reminder`,
   plus any other shared services (uploads store, admin PWA, etc.).
2. Zero or more **lane VMs**, each running exactly one
   runtime-adapter and its associated channel-driver(s) for a single
   lane identity.

A lane VM MUST NOT host a second hub, a second http server, or another
lane's processes. The core VM MUST NOT host lane processes for lanes
that are deployed remotely (mixing a co-located lane with remote lanes
is permitted only via the single-host rules of § 4).

### 14.2. Transport and auth

- The hub WebSocket endpoint MUST be reachable from each lane VM at
  `ws://<core-vm-host>:<HUB_PORT>/ws` over the internal network.
- Plain `ws://` is sufficient at this version. TLS / `wss://`
  termination MAY be added by an operator but is NOT REQUIRED.
- Hub auth at v0.1 is **identity-only**: the lane VM authenticates by
  calling `mesh.register` with its provisioned identity string. There
  is no separate per-lane hub bearer token at v0.1. Operators SHOULD
  restrict hub port exposure to the internal network only.

### 14.3. Bootstrap and identity provisioning (normative)

- Each lane identity used by a lane VM MUST be pre-provisioned on the
  core hub before the lane VM connects.
- Lane VMs MUST NOT open `hub.db` directly (local or remote) and MUST
  NOT issue `INSERT` or `UPSERT` against the `agents` table by any
  means other than the documented HTTP API.
- Provisioning MUST be performed by calling
  `POST /api/v1/agents` on the **core hub** (the same listener that
  serves WebSocket upgrades, bound to `AGENT_MESH_HUB_PORT`, default
  `3100`) with the agreed identity, type, and description payload.
  This is the single gateway for adding new identities in a cross-VM
  deployment. See § 10.1 for the request/response contract.
- After provisioning, the lane VM MAY connect to the hub and call
  `mesh.register` with the same identity string. The hub MUST treat
  this as a re-registration and MUST NOT create a duplicate row.

See § 10 "Bootstrap contract" for the on-core invariants.

### 14.4. Deployment unit

- Each lane VM MUST run its lane processes under systemd. The
  RECOMMENDED form is a template unit such as
  `agent-mesh-lane@<lane-id>.service`, instantiated once per lane
  identity hosted on that VM.
- A lane VM SHOULD remain a single-lane host. A lane VM MAY host
  additional lanes only if their port ranges do not collide.
- Container runtimes (Docker, Podman, etc.) are NOT REQUIRED.
- A lane VM MUST have `bun` installed and a synced copy of the
  agent-mesh source tree (via `git clone`, `rsync`, or equivalent)
  before its units are started.

### 14.5. Port and env conventions

When a lane has a dedicated VM, the per-lane `i`-offset rule from § 12
becomes optional because there is no co-tenant. A lane VM MAY use the
following fixed base ports for its single hosted lane:

| Component                 | Base port |
|---------------------------|-----------|
| `codex-app-server`        | `4500`    |
| `runtime-adapter`         | `4600`    |
| `channel-driver` (first)  | `4610`    |

If a lane VM does host multiple lanes, the § 12 offset rule applies
unchanged.

The lane VM's systemd unit MUST provide at least the following env:

| Variable           | Required | Meaning                                       |
|--------------------|----------|-----------------------------------------------|
| `HUB_URL`          | MUST     | `ws://<core-vm>:<HUB_PORT>/ws`                |
| `LANE_IDENTITY`    | MUST     | Identity string registered with the hub       |
| `RUNTIME_ENDPOINT` | SHOULD   | Local URL of the runtime (e.g. `http://localhost:4500`) |

Lane secrets (`DISCORD_BOT_TOKEN`, intra-lane HTTP tokens, etc.)
remain as defined in § 4.4 and § 11, but live on the lane VM filesystem.

### 14.6. Discovery and traffic

- A lane VM MUST learn the location of other agents only via
  `mesh.list_agents` on the hub. It MUST NOT hard-code peer endpoints.
- All inter-agent envelopes MUST traverse the hub. Direct lane-VM ↔
  lane-VM (P2P) traffic is prohibited at v0.1.

### 14.7. Attachments (pull-on-demand)

This subsection states the cross-VM-specific summary of the attachment
contract. The **normative attachments chapter is § 15** (metadata
schema, download endpoint, lane cache, eviction, offline behaviour).
Anything in § 14.7 that conflicts with § 15 MUST be read as in error;
§ 15 is the SSOT.

- The **core VM** is the **primary attachment store**.
  `/api/v1/upload` writes attachments to the core VM's local
  filesystem (the canonical `state/shared/uploads/` location).
- Lane VMs MUST fetch attachments **on demand** when they actually need
  the bytes (e.g. to deliver to a runtime or channel). Eager
  pre-replication of the attachment store is prohibited.
- Lane VMs MAY cache fetched attachments locally. Caches MUST be bounded
  by a TTL or LRU policy and MUST NOT be treated as authoritative.
- If a lane VM cannot reach the core attachment URL, it MUST surface a
  retrievable error in the envelope flow rather than silently dropping
  the attachment reference.

See § 6.1 (channel-driver attachment handling) for the in-lane shape.
See § 15 for the full attachments chapter (metadata schema § 15.2,
download endpoint § 15.3, lane cache § 15.4, offline behaviour § 15.5).

### 14.8. Lane systemd contract

This subsection normalizes the systemd shape a lane VM MUST expose to
operators. The reference implementation lives under
`ops/systemd/agent-mesh-{lane@,lane-codex-app-server@,runtime-adapter@,channel-driver-discord@}.{service,target}`
and is documented operationally in `docs/lane-deployment.md`.

- A lane VM MUST expose a per-lane aggregator unit
  `agent-mesh-lane@<lane-id>.target`. Enabling that target MUST bring
  the lane's runtime-adapter and channel-driver(s) up; stopping it
  MUST stop them. Individual component units MUST declare
  `PartOf=agent-mesh-lane@<lane-id>.target`.
- Component units MUST be systemd **template** units keyed by
  `<lane-id>` (`@%i`). A lane VM MUST NOT hard-code a lane-id into a
  non-template unit.
- Each lane MUST read its environment from
  `/etc/agent-mesh/lane/<lane-id>.env`. Secrets (bot tokens,
  intra-lane HTTP tokens) MUST live in a sibling
  `/etc/agent-mesh/lane/<lane-id>.secret` file with mode `0600` and
  MUST be loaded via a second `EnvironmentFile=` directive. Secrets
  MUST NOT be embedded in the `.env` file or in unit files committed
  to the source tree.
- The following env keys are part of the lane systemd contract:

  | Key | Required | Meaning |
  |-----|----------|---------|
  | `HUB_URL` | MUST | `ws://<core-vm>:<HUB_PORT>/ws` |
  | `LANE_IDENTITY` | MUST | Identity registered via `POST /api/v1/agents` |
  | `RUNTIME_KIND` | MUST | `codex` \| `claude` — selects adapter binary |
  | `RUNTIME_ENDPOINT` | SHOULD | Local runtime URL (e.g. `http://localhost:4500`) |
  | `CHANNEL_KIND` | MUST | Channel driver flavour (e.g. `discord`) |

  Lane-flavour-specific keys (`CODEX_*`, `DISCORD_*`, etc.) remain as
  defined elsewhere in this spec and in the example templates under
  `ops/env/lane/`.
- Per-lane mutable state (handoffs, attachment caches, adapter state
  files) SHOULD live under `/var/lib/agent-mesh/lane/<lane-id>/`,
  owned by the service user. Lane VMs MUST NOT write state into the
  source tree under `/srv/agent-mesh-platform/`.
- Provisioning of unit files onto a lane VM is OPTIONAL but the
  reference path is `ops/bin/install-lane.sh`, which MUST be idempotent
  and MUST NOT `enable` or `start` any unit on its own.
- **Codex runtime prereq.** Codex lane VMs MUST install the codex CLI
  globally (`sudo npm install -g @openai/codex`, version selected to be
  compatible with the core VM's hub) and have it on `PATH` for the
  service user before enabling `codex-app-server@<lane-id>.service` (or
  the lane-portable equivalent). Without the binary present the unit
  enters a restart loop and the lane never reaches `online:true`.
- **Claude lane credential mirror.** When relocating an authenticated
  Claude CLI session onto a Claude-runtime lane VM, operators MUST
  mirror both `~/.claude/` (directory, including
  `~/.claude/.credentials.json`) **and** `~/.claude.json` (file in
  `$HOME`) from the source environment to the lane VM, at identical
  paths with owner `ubuntu:ubuntu` and mode `0600`. Mirroring only
  `~/.claude/` leaves the CLI in onboarding mode and prevents the lane
  from coming online.
- **Lab-monolithic unit transplant caveat.** The lab-monolithic units
  shipped under `ops/systemd/` for the `agent-mesh-lab` reference
  deployment (`agent-mesh-codex-adapter@`, `codex-app-server@`,
  `channel-discord@`) reference `Requires=agent-mesh-hub-lab.service`
  (and `agent-mesh-self-reminder-lab.service`). When these units are
  transplanted onto a lane VM, the hub-lab dependency MUST be removed,
  since hub and self-reminder services do not run on lane VMs.
  Operators SHOULD instead use the lane-portable templates under
  `ops/systemd/agent-mesh-lane-*` and `ops/systemd/agent-mesh-{runtime-adapter,channel-driver-discord}@`
  introduced in commit `004f21d`, which carry no hub-lab coupling.

### 14.9. Compatibility

A deployment conformant to `internal-mesh v0.1` MUST also satisfy all
applicable baseline (§ 3), add-on (§ 4), and wire (§ 8, § 9) rules.
Where a § 4 rule references co-located paths (e.g. shared `env/` or
`attachments/`), the cross-VM deployment interprets them as **per-VM
local paths**, with the core VM owning shared/uploads as described in
§ 14.7.

---

## 15. Attachments pull-on-demand contract

This section normalizes how message attachments are stored, advertised,
and retrieved across the baseline and (especially) the `internal-mesh
v0.1` cross-VM deployment of § 14. The contract applies uniformly to
single-host and multi-VM topologies; differences are explicitly
called out.

### 15.1. Storage authority

- The **core VM's `agent-mesh-http` service MUST be the sole primary
  storage authority** for attachment bytes. All attachments uploaded
  via `POST /api/v1/upload` (§ 9) are written to and retained on the
  core VM only.
- Lane VMs MUST NOT be treated as primary storage. A lane VM MUST
  NOT replicate attachment bytes from the core VM in advance of use
  (no eager replication).
- The on-disk layout under the core VM is an implementation detail
  but SHOULD live under `<STATE_DIR>/uploads/`.

### 15.2. Message attachment metadata schema

When a message carries one or more attachments, the message body
sent over the hub (§ 8) MUST embed an `attachments` array. Each
element is a JSON object with the following fields:

| Field          | Type    | Required | Notes |
|----------------|---------|----------|-------|
| `id`           | string  | MUST     | Opaque attachment id; stable for the lifetime of the file. **v0.1 (current)**: lowercase sha256 hex digest of the file bytes, optionally suffixed with the original extension (`<sha256>` or `<sha256>.<ext>`). The id is purely opaque to receivers — they MUST treat it as a string token. **Legacy** (pre-hash uploads): the `<ts>-<safe-name>` form produced by older `POST /api/v1/upload` revisions; the download endpoint continues to accept this form for backward compatibility. New uploads MUST produce the sha256 form. |
| `name`         | string  | MUST     | Original client-supplied filename, for display only. |
| `mime`         | string  | SHOULD   | Best-effort MIME type. Receivers MUST tolerate absence and fall back to `application/octet-stream`. |
| `size`         | integer | SHOULD   | Byte length. Receivers MUST tolerate absence. |
| `sha256`       | string  | SHOULD   | Lowercase hex digest of the file bytes. When present, fetchers SHOULD verify (§ 15.4). |
| `download_url` | string  | MUST     | Absolute URL on the core VM's http server resolving to `GET /api/v1/attachments/<id>`. |

Receivers MUST ignore unknown fields. The legacy single-host `file_path`
field, and the deprecated `filename` alias of `name`, MAY also be
present for backwards compatibility but MUST NOT be treated as
authoritative in cross-VM deployments. New producers MUST emit `name`;
new consumers MUST read `name` and MAY fall back to `filename` only
when `name` is missing.

**Upload response shape.** `POST /api/v1/upload` (§ 9) MUST return a JSON
body that *is itself a valid attachment metadata object* per the table
above (so clients can attach the response directly to a hub message).
Specifically the response MUST contain `id`, `name`, `mime`, `size`,
`sha256`, `download_url`, and `uploaded_at` (ISO-8601 UTC). The
deprecated `file_path` and `filename` fields MAY accompany the response
for legacy single-host clients; new clients MUST consume `id` /
`download_url` / `name` only.

### 15.3. Download endpoint contract

The core VM's `agent-mesh-http` service MUST expose:

- `GET /api/v1/attachments/:id`
  - Path parameter `id` matches the `id` field of § 15.2.
  - Response on hit: `200 OK` streaming the file bytes with
    `Content-Type` set to the stored MIME type (falling back to
    `application/octet-stream`), `Content-Length` set, and
    `Content-Disposition: inline; filename="<filename>"`.
  - Response on miss: `404 Not Found` with a JSON error body.
  - The endpoint MUST reject ids containing path separators or
    `..` segments (`400 Bad Request`).
- Authentication: v0.1 internal-mesh assumes the endpoint is
  reachable only across the trusted internal network. The endpoint
  MAY be unauthenticated in this profile. Future profiles MAY
  require a mesh bearer token; clients SHOULD therefore tolerate a
  `401 Unauthorized` response and surface it as a non-retryable
  fetch failure.

### 15.4. Lane cache contract

A lane VM that needs to materialize an attachment (e.g. to inject it
into a runtime's context, render it in a channel driver, or persist
it to a handoff bundle) MUST resolve it via pull-on-demand:

1. Inspect the message `attachments[]` metadata.
2. Check the local cache under
   `/var/lib/agent-mesh/lane/<lane-id>/attachments-cache/`. The
   cache file name SHOULD be the attachment `id`.
3. On cache miss, issue `GET <download_url>` against the core VM,
   stream the response to a tempfile in the cache directory, then
   atomically rename into place.
4. If the metadata contains `sha256`, the lane SHOULD verify the
   downloaded bytes and discard the cache entry on mismatch.
5. Return the local cache path to the caller.

Cache eviction:

- Operators MUST run an out-of-process eviction job (cron or
  systemd timer) over each lane's cache directory.
- The default policy is **TTL of 7 days** (based on file mtime).
  Operators MAY additionally cap total cache size at **1 GiB**
  and evict least-recently-modified entries first when the cap is
  exceeded.
- Both knobs MAY be overridden per lane via environment variables
  on the eviction unit.
- Eviction MUST be idempotent and safe to run concurrently with
  lane processes (no in-flight downloads invalidated by mtime
  alone).

Eviction logic MUST NOT be embedded inside the runtime-adapter or
channel-driver process. The reference implementation lives under
`ops/bin/lane-attachments-evict.sh` with a systemd template at
`ops/systemd/agent-mesh-lane-attachments-evict@.service` and
matching `.timer`.

**Fetcher helper (normative reference).** A reference fetcher helper
implementing steps 1–5 above lives under
`packages/shared/attachments/` (`@agent-mesh/shared-attachments`) and
is exposed to lane packages as `fetchAttachment(meta, cacheDir, opts)`.
Runtime adapters and channel drivers SHOULD reuse this helper rather
than re-implementing the atomic-rename + sha256-verify pattern. The
helper streams the response body to a tempfile (`.<id>.<rand>.tmp`)
and renames into `<cacheDir>/<id>` only after sha256 verification
succeeds.

### 15.5. Offline and failure behaviour

- A lane VM that cannot reach the core VM (network partition, core
  service down, `404`/`401`/`5xx`) MUST NOT block delivery of the
  message body text. The message MUST be delivered to the
  runtime/channel with attachment payloads omitted; a structured
  warning SHOULD be surfaced in the lane's logs and, where
  applicable, channel-side error observability (per the project's
  observability rules).
- Lanes MUST NOT re-upload an attachment on the lane VM side to
  "rehydrate" the core VM. The core VM remains the sole authority
  for the original bytes.

---

## 16. Out of scope

The following are explicitly **not** part of this specification and may
exist or be removed independently of compliance:

- The legacy host plugin under `~/ai/plugins/agent-mesh/`. It predates
  the package split and is retained only for migration purposes.
- The `md-viewer` viewer/editor.
- Any operator-specific tooling under operator home directories
  (e.g. `~/ai/bin/*.sh` launchers, tmux session conventions).
- Conversation policy, persona files, and prompt content of any agent.
- The choice and configuration of underlying AI models served by a
  runtime.

These domains are governed by deployment-local conventions and are
beyond the SSOT contract defined here.
