# agent-mesh — Normative Specification

This document is the contract that any agent-mesh deployment, alternative
shared implementation, or external lane (runtime-adapter / channel-driver)
must satisfy.

Status: Draft, version 0.2. Subject to change before 1.0.

The keywords MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are used as
defined in RFC 2119 / RFC 8174.

### What 0.2 changes, and what does not exist yet

0.2 carries the decisions taken while reviewing the audit ingestion proposal.
They are settled contracts, but **most are not implemented** — the shipped
build implements 0.1. This section is the list, so nothing here is mistaken
for a description of running code.

| § | Change | Built |
|---|--------|-------|
| 3.1 | Hub storage splits into `agents.db`, `hub.db`, `audit.db` | **partly** — `agents.db` split; `audit.db` not yet |
| 4.1 | A Claude lane includes a runtime-adapter | no |
| 6.1 | Hub-direct forwarding is removed; adapter mode is the only mode | no |
| 8.1 | `mesh.connect` carries a signature and returns capabilities | no |
| 8.2 | `from` is constrained by validated entitlement | no |
| 8.2 | The transmitting socket is recorded alongside `from` (`sent_by`) | **yes** |
| 8.9 | `mesh.audit.*` methods | no |
| 9.1 | Audit blob upload and audit query routes | no |
| 9.3 | Identity teardown is a soft delete | **yes** |
| 10.1 | `POST /api/v1/agents` accepts `public_key`; approval procedure | **yes** |
| 10.1 | Identity format loosened; kebab-case advisory, case-sensitive | **yes** |
| 10.3 | Agent types come from a registry table, not a hardcoded enum | **yes** |
| 10.3 | `human` is a seeded type, and a person holds a mesh identity | **yes** |
| 15.2 | Blob keys retain the file extension | **yes** (0.1 behaviour, now normative) |

Upgrading from 0.1 does **not** migrate existing data. Each store is treated
as starting empty.

Rationale for these decisions lives in
`docs/decisions/identity-and-authentication.md` and
`docs/proposals/audit-ingestion-response.md`. Those documents explain *why*;
this one states *what*.

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

### 3.1. `agent-mesh-hub` (`packages/hub`)

| Property        | Requirement                                                 |
|-----------------|-------------------------------------------------------------|
| Transport       | WebSocket, JSON-RPC 2.0                                     |
| Default port    | `3100` (configurable via `AGENT_MESH_HUB_PORT`)             |
| Storage         | Three SQLite databases under `${AGENT_MESH_STATE_DIR}` — see below |
| Identity model  | One agent ↔ one identity string, compared case-sensitively  |
| Bootstrap hook  | `ExecStartPost` MUST run `ops/bin/bootstrap-hub-service-identities.sh` |

**Storage (0.2).** Identity, routing and audit data MUST live in separate
database files. `agents.db` and `hub.db` are split; `audit.db` arrives with
§ 8.9:

| File | Contents | hub | http |
|------|----------|-----|------|
| `agents.db` | `agents`, `agent_keys`, `agent_key_events` | read-write | read-write |
| `hub.db` | `messages` | read-write | read-only |
| `audit.db` | `audit_events`, `audit_event_blobs` | read-write | read-only |

Audit MUST NOT share a file with `messages`. A single file means audit growth
exhausting the disk also stops message routing — a recording feature taking
down the communication feature. Separate files also allow separate volumes,
retention and `VACUUM` policies, which these stores need because their
lifetimes differ: identity is small and permanent, `messages` is operational,
audit is long-lived.

`audit_events` and `audit_event_blobs` MUST share a file, because an event and
its attachment references MUST commit in one transaction (§ 8.9.3).

Both `agent-mesh-hub` and `agent-mesh-http` open `agents.db` read-write. This
is sound because both set `journal_mode = WAL` and `busy_timeout`, and § 14.1
places them on the same core VM. **The hub owns the DDL** for `agents.db`,
`hub.db` and `audit.db`; `agent-mesh-http` MUST NOT create or alter their
schemas.

0.1 used a single `hub.db` holding both `agents` and `messages`. Upgrades do
not migrate it: a 0.2 hub creates an empty `agents.db` and leaves whatever
`agents` table an old `hub.db` still carries untouched and unread.

The hub MUST:

- Maintain an `agents` table keyed by `identity` with at least
  `(identity, type, description, created_at, last_seen)`.
- Persist all envelopes routed between agents in a `messages` table for
  later retrieval via `mesh.fetch_messages`.
- Treat unknown identities on `mesh.send` as a recoverable error
  (envelope is queued for later delivery).
- Emit notifications to subscribed clients when their inbox receives a
  new envelope (`mesh.message` / `mesh.delivered`, see § 8.8).
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

### 3.2. `agent-mesh-http` (`packages/http`)

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

### 3.3. `agent-mesh-self-reminder` (`packages/self-reminder`)

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
short name (e.g. `prod-codex1`, `test-claude1`) which is also its hub identity.
Kebab-case is recommended for a lane, which is named by whoever deploys it.

### 4.1. Composition

| Lane type   | Components                                                       |
|-------------|------------------------------------------------------------------|
| Codex lane  | `codex-app-server@<lane>` + `codex-adapter@<lane>` + `channel-discord@<lane>` |
| Claude lane | `claude-adapter@<lane>` + `channel-discord@<lane>`               |

**Every lane MUST include a runtime-adapter.** A channel-driver MUST NOT be
the only component of a lane.

This is a change from 0.1, where a Claude lane was the channel-driver alone
and the driver reached the hub directly (the hub-direct mode removed in
§ 6.1). That arrangement put the hub in the channel real-time path and left
channel traffic with no adapter to record it — see § 8.9.

The Claude adapter that existed in this tree was a stdio MCP server and hub
client with no HTTP ingress, so it did not satisfy § 5.1(6). A conformant
Claude lane needs that ingress built, in the lane repository.

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
                 CHANNEL_DISCORD_TOKEN
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
the two MUST authenticate every HTTP request with a shared secret using
the `Authorization: Bearer <token>` header per RFC 6750.

Each direction uses **two env names** referencing the same secret value
— a *sender env* on the originating side (used to set the `Bearer`
value) and a *verifier env* on the receiving side (used to compare the
incoming header). Both env entries on a single lane MUST hold the
identical secret value; deploy tooling MUST keep them in sync.

| Direction         | Header                            | Sender env (originator side) | Verifier env (receiver side)   |
|-------------------|-----------------------------------|------------------------------|--------------------------------|
| driver → adapter  | `Authorization: Bearer <token>`   | `CHANNEL_INGRESS_TOKEN`      | `CODEX_ADAPTER_HTTP_TOKEN`     |
| adapter → driver  | `Authorization: Bearer <token>`   | `CHANNEL_DISCORD_TOKEN`      | `DISCORD_DRIVER_HTTP_TOKEN`    |

Tokens MUST be unique per lane, and each lane's two intra-lane secrets
(driver→adapter and adapter→driver) MUST be distinct from each other.

---

## 5. `runtime-adapter` interface

A runtime-adapter wraps an external runtime (Codex CLI, Claude Code,
etc.) and exposes it to the mesh as a single hub identity.

Reference implementations live in the lane repository. They were removed from
this tree when lane components moved out; what stays here is the contract they
satisfy.

### 5.1. Required behaviors

A runtime-adapter implementation MUST:

1. **Hub registration** — connect to the hub as a JSON-RPC 2.0 WS client
   and call `mesh.connect` with `identity = <lane>` (the legacy
   `mesh.register` alias of § 8.1a is accepted but DEPRECATED — new
   adapters MUST emit `mesh.connect`). It MAY pass `proxy_for[]` to
   claim ownership of derivative identities.
2. **Envelope ingest** — accept incoming envelopes from the hub and
   translate them into runtime-native turns/messages.
3. **Envelope emit** — translate runtime output into envelopes and
   forward via `mesh.send`. Envelopes MUST conform to
   `envelope.ts` in `@agent-mesh/contracts`.
4. **Action proxying** — when the runtime emits a tool/action call,
   route it through the action-proxy contract
   (`action-proxy.ts` in `@agent-mesh/contracts`).
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

Reference implementations live in the lane repository. They were removed from
this tree when lane components moved out; what stays here is the contract they
satisfy.

### 6.1. Required behaviors

A channel-driver implementation MUST:

1. **Channel ingest** — receive native channel events (messages,
   reactions, attachments) and normalize them into envelopes.
2. **Access control** — enforce per-channel access lists
   (`access.ts` model). Unknown senders MUST be rejected and never
   silently approved by the driver itself.
3. **Forwarding** — POST envelopes to the lane's runtime-adapter over the
   mutually authenticated HTTP control plane of § 4.5. A channel-driver
   MUST NOT open its own hub connection.

   0.1 also defined a *hub-direct* mode, in which the driver connected to
   the hub as `HUB_FORWARD_IDENTITY=<lane>` and called `mesh.send` itself.
   **That mode is removed at 0.2.** It placed the hub in the channel
   real-time path, and with no adapter in the path there was no outbox, so
   channel traffic could not be audited (§ 8.9). `HUB_FORWARD_IDENTITY` and
   `HUB_FORWARD_TARGET_AGENT` are no longer part of this specification.
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

## 7. Core types

The mesh types live in `@agent-mesh/contracts`
(<https://github.com/sir-mirr/agent-mesh-contracts>), delivered as an immutable
Git tag. They were previously `packages/agent-mesh-core/` in this repository;
they are contract, not baseline, and after the lane components moved out
nothing here consumed them.

The package is pure types and policy helpers — no I/O — and carries the
byte-level fixtures an implementation is checked against.

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
rows into `agents.db:agents`) is **not** done over JSON-RPC; it is done
out of band via `POST /api/v1/agents` (see § 10.1). The JSON-RPC
methods below operate on *already-registered* identities.

### 8.1. `mesh.connect`

Marks a pre-registered identity as online on this WebSocket. This is
the SSOT runtime-connect signal — `mesh.register` (§ 8.1a) is a
deprecated alias retained for backward compatibility with older agent
clients.

```
params: {
  identity:    string         // MUST be pre-registered; case-sensitive
  proxy_for?:  string[]       // additional identities this socket handles
}
result: {
  ok:           true
  identity:     string        // canonical identity
  capabilities?: {            // 0.2; absent on 0.1 hubs
    audit?: { … }             // see § 8.9.1
  }
}
```

**Request signing (0.2).** Every request a client sends over the hub
WebSocket — `mesh.connect` included — MUST carry a signature as a sibling
member of the JSON-RPC request object. It is not a member of `params`, since
JSON-RPC has no header slot and `params` belongs to each method's own schema.

```
{ "jsonrpc": "2.0", "id": 1, "method": "mesh.send", "params": { … },
  "sig": {
    "alg":   "ed25519",
    "kid":   string,          // fingerprint of the signing key
    "nonce": string,
    "iat":   number,          // unix seconds
    "value": string           // base64url
  } }
```

**Signing preimage.** The signature covers a domain-separated, length-prefixed
encoding — **not** the `params` bytes alone. Signing only `params` would leave
`method`, `nonce` and `iat` unauthenticated, so a captured signature could be
replayed with a fresh nonce, or reused against a different method that accepts
the same parameter shape.

```
LP(x)    = uint32be(byteLength(x)) ‖ x

preimage = "agent-mesh/sig/v1" ‖ 0x00
         ‖ LP(method)                    // UTF-8
         ‖ LP(kid)                       // UTF-8
         ‖ LP(nonce)                     // UTF-8
         ‖ LP(decimal(iat))              // UTF-8, no leading zeros
         ‖ LP(raw params bytes)          // exactly as received
```

Length prefixes make the field boundaries unambiguous, so no concatenation of
one field's content can imitate another. The version string is domain
separation: a signature minted for this protocol cannot be replayed into
another that signs the same material.

`params` enters the preimage as the **received bytes, verbatim** — no
canonicalisation scheme. JSON has no canonical byte form, so a signature
computed over a re-serialised object can differ from one computed over the
bytes on the wire even when the content is identical. Clients MUST therefore
retain the serialised form they sent and re-send those bytes byte-for-byte on
retry. `id` is excluded because it changes between retries; `sig` is excluded
because it carries the result.

`payload_digest` (§ 8.9.3) is a **separate computation** over the raw `params`
bytes alone. The two share that input and nothing else: the digest identifies
an event for idempotency, the signature authenticates a request. Neither is
derived from the other.

**Freshness and replay.** The hub MUST reject `iat` outside ±120 seconds of its
own clock, and MUST reject a `nonce` already seen from that identity within the
window. A nonce record may be discarded once its `iat` falls outside the
window.

**Key state is read per request, not cached.** The hub MUST verify against the
identity's currently `approved` key each time. Caching a key for the life of a
connection would make revocation (§ 10.2) not take effect until the connection
happened to close, which is precisely the case revocation exists for.

The cost does not justify a cache: reading the key row from `agents.db` was
measured at ~1.7 µs, against ~32 µs for the Ed25519 verification it feeds — and
cheaper than the `PRAGMA data_version` check a cache-invalidation scheme would
need on the same path. WAL readers do not block, and key writes are rare.

**Whether an identity may go unsigned is a property of its type, not of
whether it happens to have a key.** The `agent_types` registry (§ 10.3) carries
a `requires_key` flag; every AI runtime type is seeded with it set.

- `requires_key = 1` — every request MUST carry a signature verifiable against
  an `approved` key. An identity with no key at all, or whose key is `pending`,
  `denied` or `revoked`, is rejected with `-32014`. There is no unsigned path.
- `requires_key = 0` — an identity with no key connects unsigned. If it *has*
  an approved key, its requests are still verified; a key is not optional once
  approved.

An earlier draft enforced signatures only where an approved key already
existed, which read as backward compatibility but was an open door: a caller
could register an identity without `public_key` and then connect unsigned,
skipping the authentication the audit trail depends on. Since upgrades do not
migrate data (§ 0), there was no 0.1 state to be compatible with. § 10.1 now
also refuses to provision a `requires_key` type without a key.

`-32014` carries `key_status` — `missing`, `pending`, `denied` or `revoked` —
so a client can tell waiting for approval from having been shut off. The hub
MUST close any connection it holds for such an identity as soon as the state is
observed, which, because state is read per request, is at its next request.

Errors:

- `-32012` SIGNATURE_INVALID — signature absent, malformed, outside the
  freshness window, a replayed nonce, or not verifiable against the
  identity's approved key.
- `-32014` KEY_NOT_APPROVED — the identity requires a key (§ 10.3) and has no
  `approved` one. `data` carries `{ code: "KEY_NOT_APPROVED", identity,
  key_status }` where `key_status` is one of `missing` | `pending` | `denied` |
  `revoked`.

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
- `-32010` DUPLICATE_IDENTITY — an established owner still holds this
  identity. The incumbent is never evicted by a contender. `data` carries
  `{ code: "DUPLICATE_IDENTITY", ownership: "incumbent_retained",
  incumbent_connection_generation, contender_connection_generation,
  source_metadata: "server_connection_sequence" }`. The hub closes the
  contender's WebSocket with code `1008` shortly after.
- `-32011` IDENTITY_NOT_REGISTERED — the identity has no live row in
  `agents.db:agents`, or its row is soft-deleted (§ 9.3). `data` carries
  `{ code: "IDENTITY_NOT_REGISTERED", identity }`. The hub closes the
  WebSocket with code `1008` shortly after returning this error.

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
hub successfully pushed a `mesh.message` notification (§ 8.8) to it;
`"pending"` otherwise (the envelope is persisted to `messages` and
will be delivered on the recipient's next connect via
`mesh.fetch_messages`/auto-deliver).

**Transmitter recording (0.2).** The hub MUST record, alongside `from`, the
identity of the socket that actually sent the envelope. It is taken from the
authenticated connection and MUST NOT be read from `params` — a field the
caller can set is a field the caller can lie in, which is the same rule
§ 8.9.3 applies to `identity` and `recorded_by`.

The two are equal unless a proxy overrode `from`. Recording only `from` erased
the distinction: a proxied envelope was stored as though the claimed sender
wrote it, and nothing anywhere recorded which socket produced it, so an
incorrect override was not merely permitted but invisible.

This is independent of the entitlement rule below. Entitlement decides whether
an override is *allowed*; the transmitter record is what makes the answer
auditable either way, and it does not depend on entitlement being implemented.

**Sender validation (0.2).** `from` MUST be either the socket's own connected
identity or one of the `proxy_for` entries that identity is entitled to. The
hub MUST reject anything else. At 0.1 `from` was accepted unchecked, which let
any connected socket originate an envelope as any identity.

`proxy_for` entitlement is likewise validated at `mesh.connect`: a socket may
only claim identities it is entitled to proxy. The entitlement model is
`ownership.ts` in `@agent-mesh/contracts`.

Routing a message MUST also record an audit event (§ 8.9.4).

Errors:

- `-32602` INVALID_PARAMS — `params.to` missing/non-string or
  `params.content` missing.
- `-32600` INVALID_REQUEST — sender socket is not connected
  (`mesh.connect` / `mesh.register` was never called on this WS).
- `-32013` NOT_ENTITLED — `params.from` is neither the connected identity
  nor an entitled `proxy_for` entry.

### 8.3. `mesh.list_agents`

Returns the full agent registry.

```
params: {}                    // no params at v0.1; status filter is
                              // not implemented — results always
                              // include all rows
result: {
  agents: Array<{
    id:          string       // identity
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

### 8.8. Server-pushed notifications

In addition to client-initiated requests above, the hub emits two
JSON-RPC 2.0 notifications (no `id` field; clients MUST NOT respond
with a JSON-RPC response).

#### 8.8.1. `mesh.message`

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
  sent_by:  string | null     // identity of the socket that transmitted it
                              // (0.2). Equals `from` unless a proxy overrode
                              // it; null only for a message stored before the
                              // hub recorded this.
  content:  string            // flat content string (see § 8.2)
  reply_to: string | null
  ts:       string            // ISO-8601
}
```

`sent_by` is hub-derived (§ 8.2) and lets a recipient tell an envelope its
claimed sender wrote from one a proxy forwarded on their behalf. A client that
treats `from` as the authenticated origin is wrong whenever the two differ.

The hub MUST emit `mesh.message` once per successful delivery. Clients
SHOULD handle this method; unknown-method behaviour at the JSON-RPC
layer (the spec does not require a response since it is a
notification) MUST NOT close the connection.

#### 8.8.2. `mesh.delivered`

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

### 8.9. Audit ingestion (0.2)

Channel traffic does not pass through the hub — a channel-driver forwards it
to its runtime-adapter directly (§ 6.1), which keeps the hub out of the
real-time path. The adapter therefore records that traffic asynchronously,
from a durable local outbox, through the methods below.

Mesh traffic is different: the hub is its real data path, so **the hub records
mesh events itself** (§ 8.9.4). Adapters MUST NOT report mesh messages — both
ends would report the same message, and the hub already sees all of it.

The audit trail is a record of **what was collected**, not a guarantee of
completeness. An adapter that loses its outbox does not report what it lost,
and the hub cannot detect the gap. Deployments MUST NOT describe it as
complete or tamper-proof.

#### 8.9.1. Capability advertisement

An audit-capable hub returns an `audit` object in the `mesh.connect` result:

```
capabilities.audit: {
  version:                          number   // protocol version
  content_addressing:               "sha256"
  max_blob_bytes:                   number
  max_attachments_per_event:        number
  max_attachments_bytes_per_event:  number
  upload_timeout_seconds:           number
  max_inflight_appends:             number
  max_inflight_uploads:             number
}
```

A client that does not recognise `version` MUST NOT use the audit methods. It
MUST NOT guess.

Clients MUST respect the in-flight caps. Backoff and jitter only spread out
reconnection; once connected, an unpaced outbox drain from every lane at once
lands on the hub exactly as it recovers.

#### 8.9.2. `mesh.audit.prepare_blobs`

Reports which attachment blobs the store already holds, and issues an upload
grant for those it does not.

```
params: {
  event_id: string
  blobs:    Array<{
    sha256: string              // lowercase hex
    size:   number
    name:   string              // required — the storage key derives from it
  }>
}
result: {
  blobs: Array<{
    sha256:   string
    blob_key: string            // authoritative storage key, derived by the hub
    status:   "present" | "missing"
    upload?: {                  // present only when status = "missing"
      method:     "PUT"
      url:        string        // § 9.1 blob route, already carrying blob_key
      nonce:      string
      expires_at: string        // ISO-8601
    }
  }>
}
```

`name` is required because the storage key retains the file extension
(§ 15.2); `sha256` alone does not determine it.

**The hub derives `blob_key` and returns it; clients MUST use the returned
value rather than computing their own.** Two implementations of the same
normalisation rule are two chances to disagree, and a disagreement here splits
one blob into two. The rule the hub applies is § 15.2.

`blobs` MUST NOT exceed `max_attachments_per_event`, and the declared sizes
MUST NOT total more than `max_attachments_bytes_per_event`.

The nonce is bound to `(identity, blob_key, size)` and expires after 15
minutes. It is not single-use — see § 9.1 for the upload authorisation
construction and why replay is harmless here.

#### 8.9.3. `mesh.audit.append`

Commits an audit event and its attachment references.

```
params: {
  schema_version:      number
  event_id:            string   // globally unique, time-ordered
  event_type:          string   // namespace string, not a closed enum
  occurred_at:         string   // ISO-8601
  correlation_id?:     string
  causation_event_id?: string | null
  producer_id?:        string   // diagnostic label only; ≤ 64 chars
  …event-type-specific members
}
result: {
  ok:                   true
  committed:            true
  duplicate:            boolean
  event_id:             string
  identity:             string   // as derived by the hub
  attachments_verified: number
  stored_at:            string
}
```

**`identity`, `recorded_by`, `attestation` and `payload_digest` are not request
members.** They are the record's trust metadata, and a field the client
supplies cannot attest to the client. The hub constructs each of them: the
identity from the authenticated connection, `recorded_by` from which component
is writing, the attestation from the verified request signature, and the digest
from the received bytes. A client that sends them anyway MUST have them
ignored, not honoured.

The hub MUST:

- Derive `identity` from the connected identity, never from the payload.
- Reject `schema_version` greater than its own maximum. No data is lost: the
  outbox retries and drains after the hub is upgraded. Storing an event it
  cannot validate would record "validated" as a falsehood. **Hubs are upgraded
  before clients.**
- Treat `event_id` as globally unique. A repeat carrying an identical payload
  digest is success with `duplicate: true`; a repeat carrying a different one
  is `-32041`.
- Compute the payload digest over the **received bytes of `params`, verbatim**,
  by the same rule as § 8.1 signatures.
- Verify every referenced blob exists and matches its declared size.
- Commit the event and its attachment references in **one transaction**, and
  ACK only after that transaction commits.

There is no sequence number. Uniqueness comes from `event_id`, causality from
`causation_event_id`, and ordering from `event_id` being time-ordered. Clients
MUST specify which time-ordered format they emit (ULID, UUIDv7 or equivalent).

A blob committed before its event, whose event never arrives, is an orphan.
Orphans are a storage concern (§ 15.6), not a consistency defect — blobs are
immutable and content-addressed.

**Errors, and how clients must treat them:**

| Code | Name | Class |
|------|------|-------|
| `-32040` | `AUDIT_MISSING_BLOBS` — `data.missing_sha256[]` | transient |
| `-32041` | `AUDIT_EVENT_CONFLICT` — same `event_id`, different payload | **permanent** |
| `-32043` | `AUDIT_BUSY` — `data.retry_after_ms` | transient |
| `-32044` | `AUDIT_STORAGE_EXHAUSTED` — no capacity; needs an operator (§ 15.6) | transient |
| `-32602` | malformed params, caps exceeded | **permanent** |

Clients MUST distinguish the two classes. Transient errors are retried with
backoff and jitter and no maximum attempt count. **Permanent errors MUST NOT
be retried** — the event is dropped and the failure recorded locally, as § 13
already requires for oversized attachments. Without this split an event that
can never be accepted is retried forever.

A hub MAY always succeed rather than ever emitting `AUDIT_BUSY`. Clients MUST
handle it regardless, from their first release: adding it later leaves every
deployed adapter mishandling it on a path that carries audit data.

#### 8.9.4. Hub-produced mesh events

When the hub routes a `mesh.send` it MUST record an audit event itself, with
`recorded_by.kind = "hub"` and `identity` set to the sending identity.

```
mesh.message.sent
mesh.message.delivered
mesh.message.pending
```

The event carries the message body — it does not reference `messages` — so
that audit retention and operational retention are independent. Attachment
**bytes** are not duplicated; content addressing keeps one file however many
events reference it.

The hub MUST retain the sender's original `mesh.send` signature as the event's
`attestation`, with `covers: "mesh.send.params"` and the original `params`
bytes kept verbatim so the signature stays verifiable.

This makes mesh audit stronger evidence than channel audit. A channel event is
an adapter's report of its own activity; a mesh event is the hub's observation
carrying the sender's own signature. `recorded_by` exists so that difference
is a field rather than something inferred by prefix-matching `event_type`.

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
| GET    | `/api/v1/agents`                  | JWT    | `200`   | List entries from the http-server's own `agent_registry` table in `${AGENT_MESH_STATE_DIR}/agent-mesh.db` — *not* the hub `agents` table in `hub.db` (see § 10). Superseded the `registry.json` file store; a pre-existing `registry.json` is imported once, on first boot after the upgrade, while the table is still empty. |
| POST   | `/api/v1/messages`                | JWT    | `201`   | Send a message via hub. |
| GET    | `/api/v1/messages/:agent`         | JWT    | `200`   | Conversation history with one peer. |
| GET    | `/api/v1/messages/search`         | JWT    | `200`   | Full-text search across messages. |
| GET    | `/api/v1/events/:agentId` (SSE)   | JWT    | `200`   | Server-sent events for a single inbox. |
| POST   | `/api/v1/upload`                  | JWT    | `200`   | Upload attachment; returns § 15.2 metadata object. |
| GET    | `/api/v1/files`                   | JWT    | `200`   | Serve a single file by `?path=<filepath>` query (10 MB cap, path-allowlist enforced). |
| GET    | `/api/v1/attachments/:id`         | None ‡ | `200`   | Download attachment bytes (§ 15.3). |
| PUT    | `/api/v1/audit/blobs/{key}`       | Sig §  | `200`\|`201` | Machine blob upload (0.2). `key` is `<sha256>[.<ext>]` per § 15.2. |
| GET    | `/api/v1/audit/events/{event_id}` | JWT\*  | `200`   | Single audit event (0.2). |
| GET    | `/api/v1/audit/events`            | JWT\*  | `200`   | Cursor-paginated audit query (0.2). Filters: `identity`, `provider`, `correlation_id`, `from`, `to`. Default order `(stored_at, event_id)` ascending. |
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

§ The blob `PUT` is authorised by a signature, not a session — an adapter has
no browser login, and the identity behind the upload is known to the hub rather
than to `agent-mesh-http`. The server reads the nonce row and the identity's
approved public key from `agents.db` and verifies. No shared secret between the
two services is required.

```
Authorization: AgentMeshSig kid="<fingerprint>", nonce="<opaque>", sig="<base64url>"
```

The scheme name is `AgentMeshSig`; parameters follow RFC 9110 auth-param
syntax, in any order, values quoted.

The signed bytes use the same construction as § 8.1 — same `LP`, same domain
separator shape, different version string so an upload signature cannot be
replayed as an RPC signature or the reverse:

```
preimage = "agent-mesh/upload/v1" ‖ 0x00
         ‖ LP(nonce)                  // UTF-8
         ‖ LP(blob_key)               // UTF-8
         ‖ LP(sha256)                 // UTF-8, lowercase hex
         ‖ LP(decimal(size))          // UTF-8, no leading zeros
```

The nonce travels in the `Authorization` header rather than the URL: query
strings turn up in access logs and proxy caches, and this one authorises a
write. `blob_key` is in the request path already and is included in the
preimage so a grant cannot be redirected to a different key.

The hub issues the nonce in `mesh.audit.prepare_blobs` (§ 8.9.2), records it
bound to `(identity, blob_key, size)`, and gives it a **TTL of 15 minutes** —
comfortably longer than the 180-second upload timeout, so a retry after a
timeout reuses the grant rather than making a round trip for a new one.

The nonce is not single-use. Because the upload is content-addressed and the
signature covers `blob_key`, `sha256` and `size`, a replayed grant can only
store the identical bytes under the identical key, which deduplicates to no
effect. An expired nonce is re-requested through `prepare_blobs`.

The server MUST require `Content-Length`, reject a declared size mismatch
(`422`), reject over `max_blob_bytes` (`413`), abort past
`upload_timeout_seconds` (`408`), hash the stream as it receives, discard on
digest mismatch (`422`), and rename into place atomically only after
verification. It MUST NOT create chunk or resumable state. A failed upload is
retried whole.

`201` on first store, `200` when the blob already existed
(`{ deduplicated: true }`).

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

**Identity validation.** `{identity}` MUST match `^[A-Za-z0-9][A-Za-z0-9-]*$`
(§ 10.1). Anything else MUST return `400` with body
`{ "ok": false, "error": "invalid identity format …" }`.

**Behavior (0.2).** Teardown is a **soft delete**. The hub MUST, in a single
transaction on `agents.db`:

1. Set `agents.deleted_at` on the matching row.
2. Set every key of that identity in `agent_keys` to `revoked`, and append the
   corresponding `agent_key_events` rows.

It MUST NOT touch `messages`, and MUST NOT delete the `agents` or `agent_keys`
rows.

Hard deletion is incompatible with two other rules. Signatures (§ 8.1) are
verified against the identity's key, so discarding the key makes every past
signature permanently unverifiable — the property the signing exists for. And
freeing the identity string lets a later registration inherit the previous
holder's message and audit history.

**Re-registration is blocked.** A soft-deleted identity MUST NOT be
re-registered through § 10.1. Identity strings are not scarce; an operator who
genuinely needs one back purges it with an out-of-band tool. Physical purging
is outside the request path and belongs to the retention policy.

Every read of `agents` MUST filter `deleted_at IS NULL` — the pre-registration
check of § 8.1, `mesh.list_agents`, and the recipient check of § 8.2 included.

**Response body** (`200 OK`):

```
{
  "ok":         true,
  "identity":   "<echoed identity>",
  "action":     "soft-deleted" | "already-deleted" | "not-found",
  "deleted_at": "<ISO-8601 UTC>"        // absent for "not-found"
}
```

`"not-found"` is the response for an identity that has no row at all;
`"already-deleted"` for one already carrying `deleted_at`. Callers SHOULD
treat all three as idempotent success.

0.1 deleted the `agents` row and every `messages` row referencing the identity,
and returned `agents_removed` / `messages_removed`. Those fields are gone.

### 9.4. Host split summary

When wiring an out-of-tree client (lane VM, admin tooling, ops
scripts), callers MUST direct each request to the correct listener.
The table below is the SSOT.

| Route family                              | Listener         | Default port |
|-------------------------------------------|------------------|--------------|
| `GET /api/v1/health`, `/api/v1/*` user-facing | `agent-mesh-http` | `3000` |
| `/api/v1/attachments/:id`                 | `agent-mesh-http` | `3000` |
| `PUT /api/v1/audit/blobs/{key}`           | `agent-mesh-http` | `3000` |
| `/api/v1/audit/events*`                   | `agent-mesh-http` | `3000` |
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
as `ExecStartPost`. By the time it runs, the hub process has already
opened `hub.db` and applied schema migrations (`CREATE TABLE IF NOT
EXISTS agents`, plus idempotent `ALTER TABLE` shims for legacy
databases) at startup — see `packages/hub/src/main.ts`. The
bootstrap script therefore MUST NOT open `hub.db` directly; it
provisions identities by calling the hub's `POST /api/v1/agents`
endpoint (§ 9.4, § 10.1) over loopback, and it MUST:

1. Discover service identities from the lab `env/` tree. The env root
   is resolved by the following fallback chain (highest precedence
   first), matching the reference implementation in
   `ops/bin/bootstrap-hub-service-identities.sh`:
   `${AGENT_MESH_ENV_ROOT}` →
   `${AGENT_MESH_LAB_HOME:-/srv/agent-mesh-lab}/env`. The
   `AGENT_MESH_LAB_HOME` secondary is operator-facing real
   (`ops/env/shared/common.env.example` ships it as
   `/srv/agent-mesh-lab`) and MUST NOT be removed without a parallel
   script update. Within the resolved env root the script reads:
   - `shared/http.env` → `http-server` (or `http-server-dev` when
     `NODE_ENV=development`), description "Agent Mesh Web UI".
   - `shared/self-reminder.env` → `${SELF_REMINDER_IDENTITY:-self-reminder}`,
     description "SelfReminder service (PoC1)".
   The set is dynamic — there is no fixed "built-in six" list, and
   identities such as `admin` or `bootstrap` are not provisioned by
   this script.

   **The script discovers baseline service identities only.** At 0.1 it also
   walked the env tree for lane identities, reading `CODEX_ADAPTER_IDENTITY`
   from every `*/adapter.env` and `HUB_FORWARD_IDENTITY` from every
   `*/discord.env`. Both are gone: hub-direct forwarding is removed (§ 6.1),
   so a channel-driver holds no hub identity of its own, and lane components
   are no longer deployed from this repository. A lane provisions its own
   identity through `POST /api/v1/agents` (§ 10.1), which cross-VM
   deployments already required (§ 14.3).
2. For each discovered identity, `curl -fsS -X POST` to the hub API
   URL. The URL is resolved by the following fallback chain (highest
   precedence first):
   `${AGENT_MESH_HUB_API_URL}` →
   derived from `${AGENT_MESH_HUB_URL}` →
   derived from `${HUB_URL:-ws://127.0.0.1:3100/ws}`
   (last two re-shape the WS URL to `.../api/v1/agents`). The body is
   `{"identity":"…","type":"service","description":"…"}`, retrying up
   to `${HUB_BOOTSTRAP_MAX_RETRIES:-30}` times at
   `${HUB_BOOTSTRAP_RETRY_SLEEP_SEC:-1}` second intervals while the
   hub is still warming up.
3. Be **idempotent** — repeated invocations MUST NOT duplicate rows
   (the hub UPSERT at § 10.1 absorbs that) or alter user-modified
   fields beyond the seeded baseline.
4. Exit `0` on success; non-zero exit MUST fail the hub unit start so
   the operator notices. Setting `HUB_BOOTSTRAP_DRY_RUN=true` MUST log
   intended registrations without issuing any POST.

The script MUST NOT delete identities, MUST NOT touch the `messages`
table, and MUST NOT depend on any lane being present — the discovered
set MAY be empty (the script then logs and exits `0`).

In a cross-VM deployment (§ 14), lane VMs MUST NOT bypass this script
and MUST NOT write to `hub.db` over the network; identity provisioning
for remote lanes goes through `POST /api/v1/agents` on the core hub.

### 10.1. Identity provisioning API (`POST /api/v1/agents`)

The core hub MUST expose `POST /api/v1/agents` on the same HTTP listener
that serves WebSocket upgrades (`AGENT_MESH_HUB_PORT`, default `3100`).
This endpoint is the single normative entry point for inserting or
updating rows in `agents.db:agents` from any caller — local bootstrap,
operator provisioning tooling, or remote lane VMs.

**Request** (`Content-Type: application/json`):

```
{
  "identity":    "<string>",              // required, ^[A-Za-z0-9][A-Za-z0-9-]*$
                                          // case-sensitive; kebab-case RECOMMENDED
  "type":        "<string>",              // required; MUST exist in agent_types (§ 10.3)
  "description": "<string, ≤ 256 chars>", // optional, may be null
  "public_key":  "<base64url, 43 chars>"  // Ed25519 raw 32B; REQUIRED when the
                                          // type has requires_key (§ 10.3)
}
```

**Behavior** — the hub MUST:

1. Validate `identity` against `^[A-Za-z0-9][A-Za-z0-9-]*$`; reject with `400`
   otherwise. The comparison is case-sensitive throughout — see below.
2. Validate `type` against the `agent_types` registry (§ 10.3); reject with
   `400` otherwise, listing the registered types.
3. Reject with `400` when the type has `requires_key` and no `public_key` was
   supplied, and the identity has no approved key already.
4. Reject with `409` when the identity exists and is soft-deleted (§ 9.3).
5. UPSERT the row: `INSERT … ON CONFLICT(identity) DO UPDATE SET type, description`.
6. When `public_key` is present, record it per § 10.2.
7. Return `201 Created` when the row did not previously exist, `200 OK`
   when the row already existed and was updated.
8. Return `500` only on a genuine DB error; transient errors MAY be retried
   by callers using exponential or fixed backoff.

**Identity format (0.2).** An identity MUST match
`^[A-Za-z0-9][A-Za-z0-9-]*$`: it begins with a letter or digit, and continues
with letters, digits and hyphens. Kebab-case is **RECOMMENDED** and is what
every baseline identity uses, but it is a convention, not a constraint.

**Identities are compared case-sensitively.** `Codex` and `codex` are two
identities, exactly as they are two rows. Every store compares them under
SQLite's default binary collation, so this is what implementations already do;
stating it removes the reading under which they were the same identity written
two ways.

0.1 required `^[a-z][a-z0-9-]*$`. That rule was written when every identity was
a service an operator named, and it stopped being right once § 10.3 admitted
`human`: a person's identity is the login they already have, and the systems
people federate from — GitHub among them — permit uppercase. Lowercasing to fit
was not available either, because the identity is the same string the http
server sends as `from` (§ 8.2); normalising one half would split it from the
other. The rule excluded people from the mesh to preserve a naming convention.

The cost is that two identities can now differ only by case and be confusable
to a reader. That is accepted: an identity is matched by machines and is not a
display name (§ 9.1), and a rule that guarantees legibility at the price of
excluding real participants is the wrong trade.

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
which the identity row was first INSERTed into `agents.db:agents`. The
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
alias `POST /api/agents` for legacy callers (operator provisioning scripts
predating this spec section). The alias MUST validate identically; its response
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
`DELETE /api/agents/{identity}` on the same hub listener — see § 9.3 for the
soft-delete semantics and response shape. The hub does not expose a versioned
`DELETE /api/v1/agents/{identity}`; the unversioned form is the only normative
shape.

### 10.2. Public key registration and approval (0.2)

An identity's signing key is registered with its identity but is not usable
until an operator approves it. Registration alone therefore grants nothing,
which is what allows § 10.1 to stay unauthenticated.

```
none ──propose (any caller)──▶ pending ──approve (operator)──▶ approved
                                  └──────deny (operator)─────▶ denied
approved ──rotation proposal──▶ pending ──approve──▶ previous key revoked
```

The hub MUST:

- Store keys in `agents.db:agent_keys`, identified by `fingerprint` — the
  SHA-256 of the public key.
- Permit at most one `pending` and at most one `approved` key per identity.
- **Never let a proposal modify an `approved` key.** A proposal for an identity
  that already has one creates a separate `pending` row; the approved key is
  untouched until the replacement is approved, at which point the previous key
  becomes `revoked`.
- Treat a proposal of a key that already exists as a no-op returning its
  current status. An adapter restarting and re-sending its key MUST NOT knock
  its own approved key back to `pending`.
- Replace the existing `pending` row when a *different* key is proposed while
  one is pending, so a restarting client cannot flood the queue.
- Append an `agent_key_events` row for every state change, carrying the action,
  a reason, the actor and a timestamp.

**Approval is not served by the hub.** The hub has no authentication, so an
approval endpoint there would let any caller approve its own key. Approval is
performed on `agent-mesh-http`, behind the existing admin JWT gate, which is
why that service holds a read-write handle on `agents.db` (§ 3.1).

**Fingerprint comparison is part of the procedure.** A conformant lane MUST log
its own key fingerprint at startup, and the approval surface MUST display the
fingerprint being approved. Without the comparison, approval attests to
nothing.

**Revocation.** A key MAY be revoked at any time, without waiting for a
replacement to be approved; after revocation the identity can neither connect
nor sign until a new key is approved. Revocation MUST be a status change, never
a row deletion — past signatures stay verifiable, and `agent_key_events`
supplies the timeline needed to judge them. The `reason` matters: a routine
`rotation` says nothing about earlier signatures, while `compromise` casts
doubt on the window preceding it.

A revocation MAY be requested by the operator, or submitted by the holder
signed with the key being revoked.

### 10.3. Agent type registry (0.2)

`agents.type` is a classification label. The hub stores it and echoes it back;
nothing in the hub branches on its value. 0.1 nevertheless validated it against
a hardcoded enum of `ai-claude | ai-codex | service`, which meant supporting a
new runtime required a specification revision to widen a list that no code
read.

The set is therefore **data, not a wire constant**:

```sql
CREATE TABLE agent_types (
  type         TEXT PRIMARY KEY,
  description  TEXT,
  requires_key INTEGER NOT NULL DEFAULT 1,   -- see § 8.1
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

The hub seeds it at boot, idempotently. The seeded set is **informative** —
a deployment may extend it, and adding a runtime needs no change to this
document:

| `type` | `requires_key` |
|--------|----------------|
| `ai-claude` | 1 |
| `ai-codex` | 1 |
| `ai-gemini` | 1 |
| `service` | 0 |
| `human` | 0 |

**Adding a type is an operator action, not a caller action.** `POST
/api/v1/agents` is unauthenticated (§ 10.1), so a registration endpoint that
also created types would make the check meaningless — any caller could invent a
type and register under it. New types are added through the http admin surface,
behind the same gate as key approval (§ 10.2), or out of band by an operator.

`requires_key` is what makes the type meaningful: it declares whether an
identity of that type may exist without an approved signing key. `service` is
seeded at `0` because the baseline services predate keys; every AI runtime type
is seeded at `1`. A deployment that wants its services authenticated too raises
the flag, and no code changes.

`human` is seeded at `0` for a reason that does not expire. A person is
authenticated at the web surface by session token and holds no key, so their
envelopes reach the hub through a proxy socket rather than one of their own.
Requiring a key would require a browser to hold one, against a key model of one
approved key per identity (§ 10.2) — which fits an installed agent on a machine
and not a person with a laptop and a phone.

Before `human` existed a person had no type in this registry at all: they were
recorded only in the http server's own store, so the hub had no vocabulary for
the participants it routes the most traffic for, and `proxy_for` (§ 8.1) was the
only place their existence appeared.

---

## 11. Token & identity separation

The deployment uses several distinct secrets. They MUST NOT be merged
or reused across boundaries.

| Token                          | Where lives             | Purpose                                                |
|--------------------------------|-------------------------|--------------------------------------------------------|
| `GITHUB_CLIENT_SECRET`         | `secrets/shared.env`    | OAuth login                                            |
| `JWT_SECRET`                   | `secrets/shared.env`    | HTTP session JWT signing                               |
| `VAPID_PRIVATE_KEY`            | `secrets/shared.env`    | Web Push                                               |
| `DISCORD_BOT_TOKEN`            | `secrets/<lane>.env`    | Discord channel auth                                   |
| `CHANNEL_INGRESS_TOKEN`        | `secrets/<lane>.env`    | driver → adapter HTTP — sender side (Bearer value)     |
| `CODEX_ADAPTER_HTTP_TOKEN`     | `secrets/<lane>.env`    | driver → adapter HTTP — verifier side (adapter)        |
| `CHANNEL_DISCORD_TOKEN`        | `secrets/<lane>.env`    | adapter → driver HTTP — sender side (Bearer value)     |
| `DISCORD_DRIVER_HTTP_TOKEN`    | `secrets/<lane>.env`    | adapter → driver HTTP — verifier side (driver)         |

The four lane-scoped HTTP tokens form **two paired secrets** for the
intra-lane control plane (§ 4.5): each direction has one sender env and
one verifier env that MUST hold the identical value on a given lane.

Identity strings (e.g. `prod-codex1`) are **public** and appear in logs
and envelopes; they MUST NOT carry secret material.

### 11.1. Deprecated env aliases (backwards compatibility)

The reference implementation accepts a small set of legacy environment
variable names as aliases for the canonical tokens above. They exist
purely so pre-v0.1 deployments keep starting; **new deployments MUST
NOT set these alias names** — use the canonical token only. The hub
and adapters resolve the canonical name first and fall back to the
alias only if the canonical is unset.

| Deprecated alias            | Canonical token              | Side | Status note |
|-----------------------------|------------------------------|------|-------------|
| `BRIDGE_INGRESS_TOKEN`      | `CHANNEL_INGRESS_TOKEN`      | channel-driver  | accepted for BC; do not use in new deployments |
| `GATEWAY_TOKEN`             | `DISCORD_DRIVER_HTTP_TOKEN`  | channel-driver  | accepted for BC; do not use in new deployments |
| `DISCORD_DRIVER_TOKEN`      | `CHANNEL_DISCORD_TOKEN`      | runtime-adapter | accepted for BC; do not use in new deployments |
| `BRIDGE_HTTP_TOKEN`         | `CODEX_ADAPTER_HTTP_TOKEN`   | runtime-adapter | accepted for BC; do not use in new deployments |

Future major releases MAY drop the alias fallback. Operators auditing a
deployment SHOULD `grep` for these aliases in `secrets/*.env` and
rename to the canonical name on the next deploy cycle.

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

**Three version numbers exist and MUST NOT be conflated:**

| Version | Scope | Where |
|---------|-------|-------|
| `agentMeshSpec` | this whole document | `package.json` |
| `capabilities.audit.version` | the audit protocol — methods, params, error codes | negotiated at `mesh.connect` |
| `schema_version` | the shape of one audit event | stored on the event row |

The first two are runtime facts about an implementation. The third is data
provenance: it is persisted with the event and is how a stored event is
interpreted years later, which a connect-time negotiated value cannot express.
All are numbers.

Adding a method to § 8 is a minor version. Changing or removing an existing
method's params, results or error codes is a breaking change, permitted
between `0.x` minors and not after `1.0`.

---

## 14. Cross-VM deployment (internal-mesh v0.1)

This section normalizes the **internal-mesh v0.1** deployment profile,
in which the baseline runs on one *core VM* and each lane runs on its
own *lane VM*. It is a production-style alternative to the default
single-host topology and does not replace it; a conformant deployment
MAY use either.

> **Notation.** Throughout this section, `${AGENT_MESH_HUB_PORT}` is
> the hub WebSocket / HTTP listen port (default `3100`, declared in
> § 3.1 and cross-referenced from the hub control-plane header at
> § 9.2) and `${AGENT_MESH_HTTP_PORT}` is the user-facing http-server
> port (default `3000`, declared in § 9.1). Earlier revisions used the
> shorthand `<HUB_PORT>` / `<HTTP_PORT>` placeholders; the canonical
> env names are kept here to remove ambiguity between the two services
> (an earlier lane installer's post-install note conflated the two).

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
  `ws://<core-vm-host>:${AGENT_MESH_HUB_PORT}/ws` over the internal network.
- Plain `ws://` is sufficient at this version. TLS / `wss://`
  termination MAY be added by an operator but is NOT REQUIRED.
- Hub auth at v0.1 is **identity-only**: the lane VM authenticates by
  calling `mesh.connect` with its provisioned identity string (the
  legacy `mesh.register` alias of § 8.1a is accepted but DEPRECATED).
  There is no separate per-lane hub bearer token at v0.1. Operators
  SHOULD restrict hub port exposure to the internal network only.

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
  `mesh.connect` with the same identity string (the legacy
  `mesh.register` alias of § 8.1a is accepted but DEPRECATED). The
  hub MUST treat this as a re-registration and MUST NOT create a
  duplicate row.

See § 10 "Bootstrap contract" for the on-core invariants.

### 14.4. Deployment unit

- Each lane VM MUST run its lane processes under systemd. The
  RECOMMENDED form is a per-lane aggregator template
  `agent-mesh-lane@<lane-id>.target` (see § 14.8 for the full
  systemd contract), instantiated once per lane identity hosted on
  that VM.
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

The lane VM's systemd unit MUST provide at least the lane systemd
env contract defined in § 14.8 (which is the SSOT for the lane env
table). The minimum keys are `HUB_URL` (MUST), `LANE_IDENTITY`
(MUST), `RUNTIME_KIND` (MUST), `RUNTIME_ENDPOINT` (SHOULD), and
`CHANNEL_KIND` (MUST); see § 14.8 for the full table including
meanings and example values. The reference `runtime-adapter@.service`
unit reads `${RUNTIME_KIND:?...}` and fails to start if it is unset,
so the MUST grade is enforced by the unit itself, not just by spec.

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
operators. The units and their installer live in the lane repository; they were
removed from this tree with the packages they start. What follows is the shape
they MUST satisfy.

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
  | `HUB_URL` | MUST | `ws://<core-vm>:${AGENT_MESH_HUB_PORT}/ws` |
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
- A lane installer is OPTIONAL, but one MUST be idempotent and MUST NOT
  `enable` or `start` any unit on its own.
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
- **Lane units MUST NOT depend on baseline units.** A lane VM runs no hub, no
  http server and no self-reminder, so a lane unit carrying `Requires=` or
  `After=` on one of them either refuses to start or orders itself against
  something that will never appear.

  This is called out because the lab units this repository once shipped got it
  wrong and unevenly: the codex adapter hard-bound to both hub and
  self-reminder via `Requires=`/`After=`, the Discord driver carried an
  `After=` on the hub alone, and the app-server carried nothing. Anyone porting
  from that generation should check each unit rather than assume.

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
  storage authority** for attachment bytes. Everything written through
  `POST /api/v1/upload` and `PUT /api/v1/audit/blobs/{key}` (§ 9.1) is
  written to and retained on the core VM only.
- Lane VMs MUST NOT be treated as primary storage. A lane VM MUST
  NOT replicate attachment bytes from the core VM in advance of use
  (no eager replication).
- The on-disk layout under the core VM is an implementation detail
  but SHOULD live under `<STATE_DIR>/uploads/`.
- Both upload routes share **one namespace and one directory**. Bytes exist
  exactly once however many messages or audit events reference them.
- `agent-mesh-hub` MAY read that directory to confirm a blob exists and check
  its size (§ 8.9.3). It MUST NOT write to it. Both services are on the same
  core VM (§ 14.1) and share `AGENT_MESH_STATE_DIR`, so this needs no
  inter-service call and no shared secret.

### 15.2. Message attachment metadata schema

**Storage key.** The key is `<sha256>[.<ext>]` — the lowercase hex digest,
carrying the original file extension when there was one, matched by
`^[0-9a-f]{64}(\.[a-zA-Z0-9]{1,16})?$`. The extension is retained because the
download route infers `Content-Type` from it.

Deduplication is therefore per **(digest, extension)**, not per digest: the
same bytes arriving under two different extensions are stored twice. Producers
that care MUST normalise the extension — lowercase it — before deriving the
key, and `mesh.audit.prepare_blobs` (§ 8.9.2) carries `name` for exactly this
reason.

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
channel-driver process. The eviction job and its timer live in the lane
repository alongside the components whose cache they trim.

**Fetcher helper (normative reference).** A reference fetcher helper
implementing steps 1–5 above lives under
the lane repository as `@agent-mesh/shared-attachments`, exposed to lane
packages as `fetchAttachment(meta, cacheDir, opts)`. The metadata shape it
consumes is `AttachmentMeta` in `@agent-mesh/contracts`.
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

### 15.6. Retention and orphan collection (0.2)

**Audit retention is indefinite.** Audit events are never expired, and neither
are the blobs they reference. This is a deliberate policy, not an unset value.

| Store | Retention |
|-------|-----------|
| `agents.db` | permanent — identity and key history are never rotated |
| `audit.db` | **indefinite** |
| `uploads/` | as long as any audit event references the blob — so, indefinite in practice |
| `hub.db:messages` | operational only; a deployment SHOULD expire it |

`messages` is the one store that should rotate, and indefinite audit retention
is what makes that safe: the audit copy is the permanent record, so `messages`
only has to outlive delivery and `mesh.fetch_messages`. Keeping both forever
stores every message body twice for no gain.

**Orphan collection.** With events kept forever, references are never released,
so the only collectable blob is one **no event ever referenced** — bytes
uploaded whose `mesh.audit.append` never arrived. That is the whole job.

A blob is collectable only when no row in `audit_event_blobs` references it
*and* its mtime is older than a grace period. The grace period exists because a
blob uploaded but not yet committed is a normal state, not an orphan — § 8.9
uploads bytes before the event that references them.

Collection MUST run out of process (cron or systemd timer), MUST be idempotent,
and MUST be safe to run while lane and core processes are live.

**Capacity is an operational contract, not a retention one.** Because nothing
expires, the disk fills eventually; the question is what happens then, and the
answer must not be "routing stops".

- `audit.db` and `uploads/` SHOULD sit on a volume separate from `hub.db` and
  `agents.db`. Splitting the files (§ 3.1) removes schema and lock coupling but
  not shared free space; files on one volume fill together.
- Deployments MUST set soft and hard thresholds with alerting well below
  exhaustion, since recovery means adding capacity rather than deleting.
- On exhaustion the hub MUST keep routing and MUST reject audit writes with
  `-32044` AUDIT_STORAGE_EXHAUSTED, a **transient** error. Adapters hold the
  events in their outboxes, and lanes fail closed on their own local limits if
  the condition persists. Audit availability degrades before message delivery
  does, never the reverse.

`-32044` is deliberately distinct from `-32043` AUDIT_BUSY. Both tell a client
to back off, but one clears on its own and the other needs an operator.

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
