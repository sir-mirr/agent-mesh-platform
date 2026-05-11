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
  `md-viewer` are explicitly **out of scope** (see § 14).

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
| Default port    | `3100` (configurable via `HUB_PORT`)                        |
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
  new envelope.

The hub MUST NOT:

- Modify envelope payloads.
- Approve, register, or destructively mutate identities outside the
  bootstrap script (registration is via `mesh.register` or
  `POST /api/v1/agents`).

### 3.2. `agent-mesh-http` (`packages/shared/http`)

| Property        | Requirement                                                 |
|-----------------|-------------------------------------------------------------|
| Framework       | Hono                                                        |
| Default port    | `3000` (configurable via `HTTP_PORT`)                       |
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

Required RPCs (delivered to identity `self-reminder` over the hub):

- `schedule_self_reminder(payload, schedule, idempotency_key?, context?, task_id?)`
- `cancel_reminder(reminder_id)` — owner-only
- `list_my_reminders(status?)`

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
   In a cross-VM deployment (§ 15), the **core VM** is the primary
   attachment store and lane VMs fetch on demand; see § 15.6.
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
| `envelope.ts`      | Canonical envelope shape: `{ id, from, to, kind, payload, meta, ts }` |
| `action-proxy.ts`  | Tool/action call routing across runtime ↔ mesh boundaries  |
| `capabilities.ts`  | Per-identity capability declarations                       |
| `history.ts`       | History query/segment helpers                              |
| `hub.ts`           | Base hub client (used by adapters/drivers)                 |
| `ownership.ts`     | `proxy_for` / owner-of-identity model                      |
| `registry.ts`      | In-memory registry projection of `agents` table            |
| `tool-contract.ts` | Channel/runtime tool descriptor schema                     |

These types are normative — adapters and drivers MUST consume them
verbatim rather than defining parallel shapes.

---

## 8. Hub JSON-RPC method signatures

All methods are over JSON-RPC 2.0 on a WebSocket. Errors follow the
JSON-RPC 2.0 error object form.

### 8.1. `mesh.register`

```
params: {
  identity:    string         // kebab-case
  type:        "ai-claude" | "ai-codex" | "service" | string
  description?: string
  proxy_for?:  string[]       // identities this connection also handles
}
result: {
  identity:   string
  registered: boolean
  created:    boolean         // true if newly inserted
}
```

### 8.2. `mesh.send`

```
params: {
  to:       string            // identity
  envelope: Envelope          // see envelope.ts
}
result: {
  message_id: string
  queued:     boolean         // true if recipient offline
}
```

### 8.3. `mesh.list_agents`

```
params: { status?: "online" | "offline" | "all" }
result: {
  agents: Array<{
    identity:    string
    type:        string
    description: string
    online:      boolean
    last_seen:   string       // ISO-8601
  }>
}
```

### 8.4. `mesh.fetch_messages`

```
params: {
  agent_id: string            // peer identity
  limit?:   number            // default 50
  before?:  string            // message_id cursor
}
result: {
  messages: Envelope[]
}
```

---

## 9. HTTP REST contract

Base prefix: `/api/v1`. Auth column meanings:

- *None* — public liveness only.
- *JWT* — requires the OAuth-issued session cookie (HS256 JWT).
- *Token* — service-to-service token in `Authorization: Bearer ...`.

| Method | Path                          | Auth   | Success |
|--------|-------------------------------|--------|---------|
| GET    | `/health`                     | None   | `200`   |
| GET    | `/agents`                     | JWT    | `200`   |
| POST   | `/messages`                   | JWT    | `201`   |
| GET    | `/messages/:agent`            | JWT    | `200`   |
| GET    | `/messages/search`            | JWT    | `200`   |
| GET    | `/events/:agentId` (SSE)      | JWT    | `200`   |
| POST   | `/upload`                     | JWT    | `201`   |
| GET    | `/files`                      | JWT    | `200`   |
| GET    | `/admin/pending`              | JWT*   | `200`   |
| POST   | `/admin/approve`              | JWT*   | `200`   |
| POST   | `/admin/deny`                 | JWT*   | `200`   |
| POST   | `/push/subscribe`             | JWT    | `201`   |
| GET    | `/auth/github`                | None   | `302`   |
| GET    | `/auth/me`                    | JWT    | `200`   |

`JWT*` = additionally requires the `admin` claim. Unauthenticated access
to any non-public route MUST return `401`. Unauthorized access (valid
JWT but missing scope) MUST return `403`.

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

In a cross-VM deployment (§ 15), lane VMs MUST NOT bypass this script
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
  "created_at":  "<ISO-8601 timestamp>",   // = agents.last_seen after UPSERT
  "action":      "inserted" | "updated"
}
```

The `created_at` field reflects `agents.last_seen` at the moment of the
UPSERT. Because the current `agents` schema has no dedicated creation
column, `created_at` on an `"updated"` response equals the touch time of
this call, not the original insertion. Callers that need durable creation
provenance SHOULD record it externally (e.g. provisioning log).

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

### 15.1. Topology

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

### 15.2. Transport and auth

- The hub WebSocket endpoint MUST be reachable from each lane VM at
  `ws://<core-vm-host>:<HUB_PORT>/ws` over the internal network.
- Plain `ws://` is sufficient at this version. TLS / `wss://`
  termination MAY be added by an operator but is NOT REQUIRED.
- Hub auth at v0.1 is **identity-only**: the lane VM authenticates by
  calling `mesh.register` with its provisioned identity string. There
  is no separate per-lane hub bearer token at v0.1. Operators SHOULD
  restrict hub port exposure to the internal network only.

### 15.3. Bootstrap and identity provisioning (normative)

- Each lane identity used by a lane VM MUST be pre-provisioned on the
  core hub before the lane VM connects.
- Lane VMs MUST NOT open `hub.db` directly (local or remote) and MUST
  NOT issue `INSERT` or `UPSERT` against the `agents` table by any
  means other than the documented HTTP API.
- Provisioning MUST be performed by calling
  `POST /api/v1/agents` on the core HTTP server with the agreed
  identity, type, and description payload. This is the single
  gateway for adding new identities in a cross-VM deployment.
- After provisioning, the lane VM MAY connect to the hub and call
  `mesh.register` with the same identity string. The hub MUST treat
  this as a re-registration and MUST NOT create a duplicate row.

See § 10 "Bootstrap contract" for the on-core invariants.

### 15.4. Deployment unit

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

### 15.5. Port and env conventions

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

### 15.6. Discovery and traffic

- A lane VM MUST learn the location of other agents only via
  `mesh.list_agents` on the hub. It MUST NOT hard-code peer endpoints.
- All inter-agent envelopes MUST traverse the hub. Direct lane-VM ↔
  lane-VM (P2P) traffic is prohibited at v0.1.

### 15.7. Attachments (pull-on-demand)

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

### 15.8. Compatibility

A deployment conformant to `internal-mesh v0.1` MUST also satisfy all
applicable baseline (§ 3), add-on (§ 4), and wire (§ 8, § 9) rules.
Where a § 4 rule references co-located paths (e.g. shared `env/` or
`attachments/`), the cross-VM deployment interprets them as **per-VM
local paths**, with the core VM owning shared/uploads as described in
§ 15.7.

---

## 15. Out of scope

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
