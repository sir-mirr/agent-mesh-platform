# agent-mesh — Normative Specification

This document is the contract that any agent-mesh deployment, alternative
shared implementation, or external lane (runtime-adapter / channel-driver)
must satisfy.

Status: Draft, version 0.2. Subject to change before 1.0.

**This file is the normative contract.** A `§ N.N` reference anywhere in
either repository — code comment, commit message, or agent correspondence
— means a section of *this* document. Other repositories may carry notes
under the same filename; those are implementation notes and bind nobody.

The distinction is not pedantry. Two documents named `SPEC.md`, both cited
by bare section number, let each side build against its own and pass its
own tests while disagreeing about the contract — which is the failure
this document exists to prevent, arriving through the document itself.

The keywords MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are used as
defined in RFC 2119 / RFC 8174.

### What 0.2 changes, and what does not exist yet

0.2 carries the decisions taken while reviewing the audit ingestion proposal.
They are settled contracts, but **most are not implemented** — the shipped
build implements 0.1. This section is the list, so nothing here is mistaken
for a description of running code.

| § | Change | Built |
|---|--------|-------|
| 3.1 | Hub storage splits into `agents.db`, `hub.db`, `audit.db` | **yes** |
| 4.1 | A Claude lane includes a runtime-adapter | no |
| 6.1 | Hub-direct forwarding is removed; adapter mode is the only mode | no |
| 8.1 | `mesh.connect` carries a signature and returns capabilities | **yes** |
| 8.2 | `from` is constrained by validated entitlement | **yes** |
| 8.2 | The transmitting socket is recorded alongside `from` (`sent_by`) | **yes** |
| 8.9 | `mesh.audit.*` methods | **yes** |
| 8.10 | Socketless transport: signed JSON-RPC over HTTP, `mesh.receive` | **yes** |
| 9.1 | Audit blob upload and audit query routes | **yes** |
| 9.3 | Identity teardown is a soft delete | **yes** |
| 10.1 | `POST /api/v1/agents` accepts `public_key`; approval procedure | **yes** |
| 10.1 | Identity format loosened; kebab-case advisory, case-sensitive | **yes** |
| 10.3 | Agent types come from a registry table, not a hardcoded enum | **yes** |
| 10.3 | `human` is a seeded type, and a person holds a mesh identity | **yes** |
| 15.2 | Blob keys retain the file extension | **yes** (0.1 behaviour, now normative) |

**Both remaining `no` rows are lane components.** § 4.1's runtime-adapter and
§ 6.1's channel-driver are built in the lane repository, not in this one —
§ 6 says so of the drivers, and the same is true of the adapters. A reader
checking this tree for them will not find them, and their absence here is not
a gap in it: the half § 6.1 assigns to the hub, dropping *hub-direct*
forwarding, is done, and neither `HUB_FORWARD_IDENTITY` nor
`HUB_FORWARD_TARGET_AGENT` is read anywhere in this repository.

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
- Emit notifications to subscribed clients when their mailbox receives a
  new envelope (`mesh.message` / `mesh.delivered`, see § 8.8).
- Send a WebSocket-level `ping` frame to every connected agent every
  **30 seconds**. Agents MUST respond with a `pong` frame (the
  WebSocket runtime handles this transparently in most clients).

  A connection that has been pinged and has sent **no frame of any
  kind** — `pong`, request, or notification — by the following sweep
  MUST be treated as unreachable: `agents.last_seen` is touched, the
  socket is removed from the online map *and from any proxy routes it
  holds* (§ 8.2), and it is then closed with code `1001`.

  Absence of an answer is the signal, not failure of the `ping` send.
  A half-open socket accepts writes indefinitely — the peer is gone,
  no close frame arrived, and the send therefore succeeds; a hub that
  waited for the send to fail would never drop anything. Two sweeps
  are required before a connection can be judged, so an agent that
  connects between sweeps gets a full interval of grace.

  Any inbound frame counts as proof of life. Counting only `pong`
  would make a busy connection whose `pong` is queued behind a large
  request look unreachable, and dropping a connection that is actively
  working is a worse failure than holding a dead one one interval
  longer.

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

| `type`     | Schedule form      | `schedule_spec`                               |
|------------|--------------------|-----------------------------------------------|
| `once`     | Relative           | `{ "in": "30s" \| "5m" \| "2h" \| "1d" }`      |
| `once`     | Absolute           | `{ "at": "2026-04-18T09:00:00Z" }`             |
| `interval` | Repeating, fixed gap | `{ "every": "15m" }`                        |
| `cron`     | Repeating, calendar | `{ "cron": "0 9 * * *", "tz": "Asia/Seoul" }` |

A duration is `<positive integer><s|m|h|d>`. Months and years are not
admitted: their length depends on when you ask, so a reminder would
drift by days depending on the month it was scheduled in. `cron`
covers calendar-aligned repetition.

An omitted `tz` means `UTC`, not the daemon's local zone.

**Advancing a repeating reminder.** After a fire, the daemon computes
the next slot from the slot the reminder was **due for**, not from the
moment it actually fired. A fire that ran late must not move the
schedule off its grid — advancing by `every` from a late fire moves it
permanently, and every subsequent outage moves it again. The computed
slot is always strictly in the future; a slot equal to the fire time is
a row that is due the instant it is written.

An outage therefore produces **one** catch-up fire and then resumes on
grid — not one fire per missed slot.

A `schedule_spec` the daemon cannot parse for its declared `type`
marks the row `dead`. Retrying would fail identically on every scan.
`mesh.schedule_reminder` refuses such a spec up front (§ 8.5), so this
covers rows written before validation existed.

**Overdue handling is per type.** A `once` reminder that is more than
the deployment's overdue threshold past its slot is **held** and fires
only on a recorded operator decision: the moment it was for has passed,
there is no later slot to move it to, and delivering it late can be
worse than not delivering it — which is a judgement a person makes.

A repeating reminder is **never held**. Its next slot is computable, so
there is nothing to decide, and the grid-aligned advance skips missed
slots rather than replaying them — the backlog the hold exists to
prevent cannot form. Holding them would strand them: the row stays
`active`, fires nothing, and falls further behind on every scan.

Delivery semantics: **at-least-once**. A fire whose `mesh.send` response
is lost is retried on the next scan, so the daemon MUST send each fire
with a `client_message_id` (§ 8.2) identifying the **fire** — derived
from `(reminder id, scheduled slot)`, not from the reminder id alone. A
repeating reminder delivers many times under one id, so a key covering
only the id would make § 8.2 return the first envelope for every later
slot and the reminder would appear to fire once.

The key MUST be derived rather than generated, so that it survives a
daemon restart: a key regenerated on restart delivers a pending fire a
second time under a key the hub has never seen.

The delivered envelope's header carries `fire=<reminder id>@<slot>` for
consumers deduplicating at their own layer. Consumers MUST be
idempotent or deduplicate on that.

**A fired reminder is sent from `self-reminder`**, not from the identity that
scheduled it. The daemon is the sender at fire time; the owner scheduled it
earlier, which the payload and `context` record. The daemon MUST NOT set
`params.from` to the owner: § 8.2 reads that as a proxied send and refuses it,
because an identity holding its own key signs for itself. Doing so refuses every
reminder owned by a key-holding runtime.

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

**Error code allocation.** JSON-RPC 2.0 leaves `-32099 … -32000` for
implementation-defined server errors. Agent Mesh reserves the **lower
half — `-32049 … -32000`** — for the codes in this document, including
retired ones (§ 13). The upper half, **`-32099 … -32050`**, is not
allocated here and is available to protocols layered beside the mesh:
a lane's driver-to-adapter control plane (§ 4.5), a deployment's own
tooling, anything that is not this contract.

The split exists because both halves of a lane speak JSON-RPC and the
two vocabularies meet inside one process. Nothing rejects a code from
the wrong side — an error object is an error object — so a collision
does not fail, it *reclassifies*. `-32043` is `AUDIT_BUSY` here and
therefore transient (§ 8.9.3); a neighbouring protocol that assigned
`-32043` to a permanently malformed payload would have that payload
retried without limit the first time the two paths were joined.

Adding a code inside the reserved half is a minor version (§ 13).
Codes in the upper half are never added by this document, so an
implementation that stays there cannot be collided with by a mesh
release.

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

**A nonce is spent on receipt, not on success.** The hub records it before
verifying the signature, so a request whose signature fails has still
consumed its nonce and a client retrying MUST use a fresh one. Recording
only on success would leave a captured envelope replayable without limit
— every attempt failing verification and every attempt leaving the nonce
spendable again.

Freshness is nevertheless checked *before* the nonce is recorded, so a
request already outside the window never enters it. Otherwise anyone could
fill the window with nonces that were never going to be accepted.

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
skipping the authentication the audit trail depends on. There was no deployed 0.1 population holding unsigned
identities to grandfather, so the compatibility it bought was hypothetical
while the door it left open was not. § 10.1 now also refuses to provision a
`requires_key` type without a key.

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

**`can_proxy` MUST NOT be settable on `POST /api/v1/agents`.** That route is
unauthenticated (§ 9.2 †), so a grant made there is one the checked party
writes for itself, and an entitlement read from a value its subject set is not
a check. A hub MUST refuse the field with `403
CAN_PROXY_NOT_SELF_GRANTED` rather than ignore it — a caller that sends it and
receives `200` believes it worked, and discovers otherwise at its first proxied
send.

It is granted two ways, both operator decisions:

- `POST /api/v1/admin/agents/{identity}/can-proxy`, behind
  `agent.provision` scoped to that identity (§ 11);
- `AGENT_MESH_PROXY_IDENTITIES` on the hub, for the infrastructure proxies a
  deployment cannot grant any other way — `agent-mesh-http` needs the flag
  before anybody can authenticate to grant it.

The declaration is **additive and applied on provisioning as well as at boot**.
Additive because clearing on restart would silently undo an operator's runtime
grant; applied on provisioning because the http server registers itself after
the hub is running, so a grant made only at boot never finds its row.
**`replyTo` is a hint and is not validated.** An id naming no message the hub
holds does not make the send fail: the envelope is delivered with `reply_to`
carried through as given. Validating it would mean resolving an id against
another mailbox's history on every send, which is a read this contract does not
give the sender and a cost it does not ask the hub to pay. A client that needs
the guarantee resolves the id itself before sending.

This is stated because its absence read as an oversight. `agent-mesh-client`
measured the behaviour while writing conformance scenarios, found no clause, and
correctly declined to write a scenario against it — a scenario whose expectation
is copied from the implementation asserts that the implementation has not
changed, not that the contract holds.

The neighbouring case does have a clause and is easy to mistake for this one:
an unknown *recipient* on `mesh.send` is a recoverable error and the envelope is
queued (§ 3, the hub's MUST list). Unknown recipient waits; unknown `replyTo`
rides along.

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
    sent_by:  string | null   // identity that transmitted it (0.2, § 8.2);
                              // equals `from` unless a proxy overrode it
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

`type` and `schedule_spec` MUST agree with § 3.3, and the hub MUST
refuse a pair it cannot read rather than storing it. A stored row with
an unreadable spec looks scheduled and never fires, and the caller
learns of it by the reminder not arriving — the one signal it cannot
tell apart from the reminder having arrived and been missed.

Errors:

- `-32602` INVALID_PARAMS — required field missing
  (`id` / `type` / `schedule_spec` / `payload` / `next_fire_at`), or
  `type` is not one of `once` / `interval` / `cron`, or
  `schedule_spec` is not a JSON object carrying the member that type
  requires (§ 3.3). The message names the field, never the supplied
  value.
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
      url:        string        // ABSOLUTE § 9.1 blob route, carrying blob_key
      nonce:      string
      expires_at: string        // ISO-8601
    }
  }>
}
```

`name` is required because the storage key retains the file extension
(§ 15.2); `sha256` alone does not determine it.

**`url` MUST be absolute.** This method answers on the hub and the blob route is
served by `agent-mesh-http` on a different port (§ 9.4). A relative URL is
resolved by the client against the origin it is already talking to — the hub —
where that route does not exist, so the upload fails with `404` against a
correct client. The hub cannot derive the address, since http connects to it and
never the reverse; a deployment supplies it.

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
| `-32000` | `AUDIT_APPEND_FAILED` — the store refused the write for a reason the hub could not classify | **permanent** |

This table covers the audit path. **Every** code § 8 defines carries a
class, and `@agent-mesh/contracts` holds the complete mapping:

| Code | Name | Class |
|------|------|-------|
| `-32010` | `DUPLICATE_IDENTITY` | transient-operator |
| `-32011` | `IDENTITY_NOT_REGISTERED` | transient-operator |
| `-32012` | `SIGNATURE_INVALID` | **permanent** |
| `-32013` | `NOT_ENTITLED` | **permanent** |
| `-32014` | `KEY_NOT_APPROVED` | wait-approval |
| `-32015` | `SEND_CONFLICT` | **permanent** |

`transient-operator` means retry, but far more slowly, and say plainly
that someone has to intervene. Both identity errors clear — one when
the incumbent disconnects (§ 8.1), one when the identity is provisioned
(§ 10.1) — but neither clears because the client tried harder, and
reporting them as ordinary `transient` produces a hot loop against a
condition no amount of retrying resolves.

**A code with no class is a version skew, and how to treat it depends
on the path.** A client MUST make that choice explicit rather than let
it fall out of an expression.

On a path with an outbox behind it — audit ingestion — an unrecognised
code SHOULD be treated as `transient`. A wrong retry is bounded by the
client's backoff ceiling and visible as a rising attempt count; a wrong
quarantine has neither bound nor automatic recovery, and would hold
every event that arrived during the skew.

On a path with nothing to drain later — connect, send — it SHOULD be
treated as `permanent`. There is no queue that will resolve it, and
retrying a refusal the client cannot act on is a loop.

What is not acceptable is a silent default. `-32000` reached a
deployed client through `ERROR_CLASS[code] ?? "transient"` written once
and never reconsidered, which is why `errorClass()` in
`@agent-mesh/contracts` requires the fallback as an argument.

Clients MUST distinguish the two classes. Transient errors are retried with
backoff and jitter and no maximum attempt count. **Permanent errors MUST NOT
be retried** — the event is dropped and the failure recorded locally, as § 13
already requires for oversized attachments. Without this split an event that
can never be accepted is retried forever.

An unclassified store failure is **permanent**, not `AUDIT_BUSY`. A
constraint violation, a schema mismatch or a defect in the handler fails
identically on every attempt, so reporting it as transient produces
exactly the unbounded retry this split exists to prevent — and leaves
the event in an outbox nobody is watching instead of in a local failure
record a person can read. `AUDIT_BUSY` is for contention the hub has
positively identified as contention.

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

### 8.11. Observed source

The hub records the address each authenticated request arrived from. It is
**an observation, never a claim.** A holder of a stolen key signs whatever it
likes about its hostname or hardware; it cannot make packets arrive from an
address it does not control, and that difference is the only reason this is
worth recording.

A hub MUST record it for **every authenticated request**, on every transport,
after the signature verifies and never before — an unverified request has only
named an identity, and recording it would let anyone write history for a name
they do not hold.

Recording is not the same as refusing. Refusal policy is deployment-defined and
is not specified here; the record exists so that an operator asking later gets
a history rather than a gap.

**Storage is one row per `(identity, address)`** with a first-seen, a last-seen
and a counter. The question is which addresses a key has been used from, and a
row per request answers it while growing without bound.

**Addresses MUST be normalised before storage or comparison.** IPv4-mapped IPv6
(`::ffff:127.0.0.1`) and its plain form are one host, and a deployment that
stores one spelling while observing the other refuses every agent it has.
Ports are stripped: they change per connection.

#### 8.11.2. Refusing a dormant send from an unseen place

A hub MAY refuse `mesh.send` with `-32017 SOURCE_CHANGED` when **all** of:

1. `sent_by == from` — the sender signed for itself;
2. it has not sent for longer than `capabilities.mailbox.dormancy_seconds`;
3. the observed source reduces to a group this identity has not been seen at.

**What it catches, stated narrowly:** a key that went quiet and came back from
a different network. Not a thief on the same network, not one who kept the key
busy, and nothing about what the sender *claims* — the address is the hub's
observation, which is the only reason it is worth checking at all.

Dormancy is the trigger because it is when exfiltration goes unnoticed. An
identity sending every few minutes has an owner who would see a second sender.

**Condition 1 is not an optimisation.** A proxied send is observed at the
*proxy's* address, which is identical for every send it carries — comparing it
would refuse on the proxy's history and never on the sender's. It becomes
meaningful again when `sent_by` names a specific gateway.

**Comparison is by group, not by address.** Granularity is a false-positive
budget: `exact` catches the most and fires on every DHCP renewal and every
cloud instance restart, and *a control that cries wolf gets switched off*, so
the strictest setting is routinely the weakest in practice. IPv4 SHOULD group
to `/24` and IPv6 to `/48`. An address that parses as neither MUST be compared
whole — reducing an unrecognised string would make two different unknowns
compare equal, and **"we could not tell" must never become "the same"**.

A hub MUST NOT refuse when it has no observation, when the identity has never
sent, or when it has no recorded source: none of those is evidence of a move,
and refusing would make this a barrier to onboarding rather than to theft.

`-32017` is **permanent**. A retry from the same network fails identically;
classing it transient makes a lane loop against a refusal only an operator can
lift.

**Receiving is never gated.** A lane that cannot receive cannot be told why it
is blocked.

`dormancy_seconds` is a deployment setting with **no derivation**, and the
contract does not claim one. `0` disables the refusal; § 8.11's recording
continues regardless, so a deployment that turns this off still has the
history.

#### 8.11.1. Behind a proxy

`GET /api/v1/capabilities` MUST report `surface.observed_source`:

| | |
|---|---|
| `socket` | the kernel's view of the peer |
| `forwarded` | taken from `X-Forwarded-For`, from a configured trusted proxy |

It is reported because **a control that is configured off is
indistinguishable from one that is on** until something asks.

With no trusted proxy configured the hub MUST use the socket address and
**ignore the header entirely**. Treating it as a fallback means an
unconfigured deployment believes a string any client can write.

Where trusted proxies are configured:

- The immediate peer MUST be one of them, or the header is disregarded and the
  socket address used — something reached the hub directly and may have
  written the whole chain.
- The address MUST be taken **from the right**: entries are skipped only while
  contributed by a trusted hop, and the first that was not is the answer.
  `X-Forwarded-For` accumulates oldest-first, so **the leftmost entry is
  whatever the original client sent.** It is conventionally "the client" and is
  exactly the forgeable one — and taking it fails *open*, with the feature
  still reporting itself enabled while comparing an attacker's string.
- A chain of nothing but trusted proxies yields **no observation**, not a
  guess.

Two properties the hub cannot verify and a deployment MUST provide:

1. **The hub is unreachable except through the proxy.** Otherwise an attacker
   connects directly and writes the header themselves.
2. **The proxy replaces rather than appends** any inbound header, or the rule
   above is what saves it.

---

#### 8.9.5. Hub-produced identity events

Some things happen to an **identity** rather than to a message, and § 8.9.4's
shape cannot carry them: its payload is a message, so every field would be
null or false.

```
mesh.identity.type_changed
mesh.identity.audit_read
```

`correlation_id` and `identity` are both the identity — it is what an operator
pages by when asking what has happened to one participant. The payload carries
`change`, whose shape is per event type; for `type_changed` it is
`{from, to}`.

**`from` is the reason the event exists.** § 10.1 mandates the upsert that
replaces `type`, and `agents.type` is read at display time — so the change
re-labels every past event for that identity as having come from a different
runtime. The row no longer holds the old value, and an event carrying only
`to` would say a change happened without saying what it undid.

**`attestation` MUST be null**, and `actor` MAY be. § 8.9.4 keeps the sender's
`mesh.send` signature because a sender asked for that; nobody signs these.
`POST /api/v1/agents` is unauthenticated (§ 9.2 †), so the hub can record that
a type changed and cannot record who is answerable for it. Recording an
attestation here would attest to nothing, and the absence is itself
information about the route that caused it.

A hub MUST NOT emit the event when the type is unchanged — a lane
re-registering on every boot would otherwise fill the trail — nor on first
registration, where there is no prior value.

---


### 8.10. The socketless transport (0.2)

Everything above assumes a participant that can hold a WebSocket. Some cannot.
An agent driven by an application rather than a daemon is awake only while it is
answering: it has no process between turns, so it can neither keep a connection
open nor be pushed to.

Such a participant reaches the mesh over one request at a time.

```
POST /api/v1/rpc        (agent-mesh-hub)
Content-Type: application/json

<the same signed JSON-RPC request object as § 8.1>
→ the same JSON-RPC response object
```

**Not a separate mail service.** The methods, the signing construction, the
error codes and the queue are the ones already specified. A participant that
switches between a socket and this transport is the same identity with the same
mailbox — the pending rows an adapter is handed on connect are the rows
`mesh.receive` returns.

**A successful `mesh.connect` MUST deliver what is waiting**, as `mesh.message`
notifications, before the participant asks for anything. A lane that only
listens has no other way to learn what arrived while it was away, and a mesh
that quietly required a drain call would strand every such participant with a
full mailbox and no symptom to go on.

Stated because it was previously only implied by the sentence above it, and the
implication carries too much: whether the hub pushes or the client drains decides
whether a listening participant needs lease and acknowledgement semantics at all.
`E2E-CONNECT-001` holds it — a message sent to an identity holding no socket, and
a connect with no `mesh.receive` anywhere in the scenario.

**The identity comes from `sig.kid`.** At most one key per identity is approved
(§ 10.2), so a fingerprint names exactly one participant. A caller therefore
does not state which identity it is; the signature already settles it, and a
separately-claimed identity would be a second assertion able to disagree with
the first.

A signature is REQUIRED here, including for a type whose `requires_key` is `0`.
That is not an additional rule but the absence of one: with no socket to have
connected on, an unsigned request carries nothing that says who is asking. The
freshness window and the nonce rule of § 8.1 apply unchanged.

**A key that is not approved MUST be answered with `-32014` carrying
`data.key_status`**, as over a socket. The identity is deliberately not
named: `sig.kid` resolves a caller only while the key is approved, and
reporting the holder here would build the key-to-identity lookup this
contract otherwise lacks — probeable by anyone who can reach the port.

The status is what the caller needs and the identity is not. This is
also the population that needs it most: an agent reaching the mesh this
way has no `mesh.connect` to have learned its state from, so this
response is the only thing that distinguishes *waiting for an operator*
from *shut off*. A generic invalid-request leaves a bootstrapping client
retrying forever or string-matching prose.

`mesh.connect` and `mesh.register` are NOT available over this transport. They
mark a socket online and there is no socket. **A socketless participant is never
online**: it has nowhere to be pushed to, so a sender addressing it is told
`pending` rather than `delivered`, which is the truth rather than a limitation.

Available: `mesh.send`, `mesh.receive`, `mesh.list_agents`,
`mesh.fetch_messages`, `mesh.audit.prepare_blobs`, `mesh.audit.append`. Anything
else MUST return `-32601`.

Entitlement (§ 8.2) applies unchanged, and `proxy_for` is unavailable — it is
declared at connect, and there is no connect. A socketless participant sends as
itself.

### 7.1. A running instance says which checkout it is

`GET /api/v1/capabilities` carries `platform`:

```
platform: { commit, branch, dirty }
```

`commit: "unknown"` when there is no repository to ask — a deployment from a
tarball is legitimate and says so rather than guessing.

**Why it is in the contract rather than in an operator tool.** Two separate
investigations, days apart, began with "this route returns 404" and ended at the
same cause: a long-running instance serving a branch ninety-three commits
behind. Neither could be diagnosed from outside without reasoning backwards from
missing routes, and the first diagnosis was wrong both times — once "an old
build", once "the redirect is a defect".

A conformance report that cannot name what answered it is a report about an
unnamed thing. The harness has always put this in its ready file; a hub somebody
started by hand had nothing, and that is exactly the hub left running for a week.

The harness now **asks** rather than computing its own: two copies of one fact is
how they come to disagree, and the copy that matters is the one the serving
process holds.

### 11.4. What each tenant received

An identity belongs to a tenant. `agents.tenant` carries it, defaulting to
`default`, and an identity nobody assigned counts there.

**A column rather than a derivation from group membership.** The derivation
needs a rule for an identity in no group and another for one in several, and
neither rule can be right: somebody who put an identity in two groups was not
thereby saying which tenant its traffic counts towards. A derivation rule reads
an intention nobody expressed.

Every accepted message is recorded once, **attributed to the recipient's
tenant**. That rule is total rather than chosen: every message has exactly one
recipient, so every message lands in exactly one tenant, cross-tenant traffic
included. A sender rule would leave traffic that *arrived* in a tenant absent
from that tenant's view, which is the reading an operator is actually misled by.

It follows that externally-originated traffic needs no special case. Whatever
reaches the mesh from outside is delivered to a mesh identity, and that identity
has a tenant.

The record carries `message_id`, `tenant`, `to_agent`, `from_agent`, `via`
(§ 8.2a) and a timestamp. It MUST NOT carry content, or any measure of content
such as a length — § 11.0 draws the platform operator's line at metadata, and a
statistics table is where content arrives under the name "just a length".

It MUST NOT carry delivery status. That changes after the row is written, and a
statistics table which must be updated is one that can disagree with what it
counts. What is recorded is that a message was *accepted for* a recipient.

Written in the same transaction as the message: a count that commits when the
message did not is a count of something that did not happen. A retry collapsed
by § 8.2 counts once, because the idempotent path returns the original id and
never reaches the insert.

`GET /api/v1/admin/tenants` reads it, gated on `tenant.read.stats` — its own
capability rather than `audit.read.metadata`. The trail answers who did what;
this answers how much arrived, and one capability answering both is the shape
§ 11 exists to undo.

### 8.2a. Which channel carries a reply

A message records the transport it was accepted through — `mesh` for a socket or
`POST /api/v1/rpc`, `mailbox` for `POST /api/v1/mailbox/out`. A row written
before this existed reads as `mesh`, which is what those deployments had.

**A reply goes back the way the thing it answers arrived.** The channel is a
property of the conversation rather than of the moment: a correspondent who
reads mail once an hour must not receive half a thread on a socket they were
briefly holding and have to find the rest elsewhere.

**Unless both ends are live**, in which case the mesh carries it. Both is the
whole of the condition. One end present is exactly the case the mailbox exists
for, and it is the recipient's presence alone that would otherwise tempt a hub
into pushing.

A send that answers nothing is not a reply and has no conversation to respect.
It takes the mesh whenever the recipient is reachable, which is the rule that
predates this one and which the socketless transport was built to have.

**Evaluated at send time, never recorded on the conversation.** A channel
written down once goes stale the moment either side reconnects or drops, and the
thread then routes by a fact about a socket that closed an hour ago.

The decision belongs to the hub, because only the hub can see presence. The rule
belongs to the mailbox, and takes presence as an answer rather than asking for
it — anything the mailbox can ask, it depends on.

#### 8.10.1. `mesh.receive`

Returns messages queued for the caller and marks them delivered.

```
params: {
  limit?:   number            // default 50, max per capabilities
  ack_ids?: string[]          // ids from the previous batch
}
result: {
  messages: Array<{           // oldest first, as § 8.8.1 shapes them
    id, from, to, sent_by, content, reply_to, ts
  }>
  remaining:     number       // still available beyond this batch
  lease_seconds: number       // how long this batch stays claimed
}
```

Also available over a socket, where it serves a client that would rather pull
than rely on the replay at connect.

**Delivery is at-least-once, acknowledged on the next call.** A batch is handed
out under a lease and stays invisible until it is acknowledged or the lease
lapses. `ack_ids` settles the previous batch as part of fetching the next, so
one call does both.

Three designs were available and two of them lose:

- A **destructive read** discards whatever the caller did not survive to
  persist. A turn can end between the response arriving and anything being
  written down.
- A **separate acknowledgement** costs a round trip and opens a window: a
  message arriving between read and ack is cleared by an ack that predates it.
  That window only opens under load, which makes it the kind found in
  production rather than in testing.
- **Piggybacking the acknowledgement** has neither. One call, one transaction,
  and anything unacknowledged comes back.

The cost is duplicates. Clients MUST deduplicate on `id`, which is stable across
redeliveries. This is the right way round: a duplicate is visible and cheap to
handle, a loss is neither.

Ids in `ack_ids` that the caller does not hold MUST be ignored rather than
refused. A caller retrying an ambiguous receive re-sends the same
acknowledgements, and failing that retry would strand the batch it is settling.

`remaining` counts what is available *after* this batch is leased, so a caller
draining a backlog knows to come straight back rather than waiting for its next
scheduled check.

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
| GET    | `/api/v1/health`                  | None   | `200`   | Liveness ping. Body in § 9.1a. |
| GET    | `/api/v1/agents`                  | JWT    | `200`   | List entries from the http-server's own `agent_registry` table in `${AGENT_MESH_STATE_DIR}/agent-mesh.db`. **Which rows exist is that table's answer** — an identity provisioned on the hub and never added here is not listed (see § 10). Each row additionally carries what the mesh measured about that identity, keyed on the same string: `last_seen_at` from `agents.last_seen`, `fingerprint` of the approved key, and the registry's own `created_at`. `last_seen_at: null` means the mesh holds no presence record for it, **not** that it is offline, and there is deliberately no `status` field — whether silence means `inactive` is an operating policy and not something this route decides. **`POST /api/v1/agents` is not served here** and answers `404`: provisioning is the hub's route (§ 10.1), on `AGENT_MESH_HUB_PORT`. It is worth saying because finding the `GET` here reasonably suggests the `POST` — `agent-mesh-local-pm` read a `404` on this server as meaning identities cannot be created over HTTP at all, and planned a fixture harness around that, while the same path on the hub answers `201` for a `service` type with no key material. Superseded the `registry.json` file store; a pre-existing `registry.json` is imported once, on first boot after the upgrade, while the table is still empty. |
| POST   | `/api/v1/messages`                | JWT    | `201`   | Send a message via hub. **`404` when the recipient is absent from *this server's* `agent_registry`** — `Agent "<id>" not found in registry` — which is a different table from the hub's `agents`, on the same namespace. Provisioning on the hub (§ 10.1) does not populate it, and today nothing does for an agent: the writers are the one-time `registry.json` import and the web-user approval path. An identity can therefore exist on the mesh, connect, hold an approved key, and still not be addressable here. `agent-mesh-local-pm` met this `404` three times while seeding (mail #1147). See `docs/deferred.md`, *Nothing puts an agent in the http registry*. |
| GET    | `/api/v1/messages/:agent`         | JWT    | `200`   | Conversation history with one peer. |
| GET    | `/api/v1/messages/search`         | JWT    | `200`   | Full-text search across messages. |
| GET    | `/api/v1/events/:agentId` (SSE)   | JWT †  | `200`   | Server-sent events for a single mailbox. |
| POST   | `/api/v1/upload`                  | JWT    | `200`   | Upload attachment; returns § 15.2 metadata object. |
| GET    | `/api/v1/files`                   | JWT    | `200`   | Serve a single file by `?path=<filepath>` query (10 MB cap, path-allowlist enforced). |
| GET    | `/api/v1/attachments/:id`         | JWT ‡ | `200`   | Download attachment bytes (§ 15.3). Session **or** an `AgentMeshSig` signature; the caller must be party to a message carrying it. |
| PUT    | `/api/v1/audit/blobs/{key}`       | Sig §  | `200`\|`201` | Machine blob upload (0.2). `key` is `<sha256>[.<ext>]` per § 15.2. |
| GET    | `/api/v1/audit/events/{event_id}` | JWT\*  | `200`   | Single audit event (0.2). |
| GET    | `/api/v1/audit/events`            | JWT\*  | `200`   | Cursor-paginated audit query (0.2). Filters: `identity`, `provider`, `correlation_id`, `from`, `to`. Default order `(stored_at, event_id)` ascending. |
| GET    | `/api/v1/admin/pending`           | JWT\*  | `200`   | List users pending approval. |
| POST   | `/api/v1/admin/users`             | JWT\*  | `201`   | Admit a local account. Answers a generated password **once** — it is in this response and in no listing, read or log, and only its hash is stored. The account is created with `must_change_password`, so its first login lands on the change screen and can do nothing else until it passes. Gated on `user.admit`. |
| GET    | `/api/v1/admin/users`             | JWT\*  | `200`   | Local accounts, with no password material of any kind. Gated on `user.admit`. |
| DELETE | `/api/v1/admin/agents/{identity}` | JWT\*  | `200`   | Identity teardown — a soft delete (§ 9.3). |
| GET    | `/api/v1/admin/agent-types`       | JWT\*  | `200`   | The type registry (§ 10.3). |
| POST   | `/api/v1/admin/agent-types`       | JWT\*  | `201`   | Add a type (§ 10.3). Create-only; `409` if it exists. |
| DELETE | `/api/v1/admin/agent-types/{type}`| JWT\*  | `200`   | Remove a type (§ 10.3). `409` while any identity carries it. |
| GET    | `/api/v1/admin/mailbox`           | JWT\*  | `200`   | Mailbox depth per identity (§ 9.2.1). No message bodies. |
| GET    | `/api/v1/admin/agent-sources`     | JWT\*  | `200`   | Where identities have been observed connecting from (§ 8.11). Carries `observed_source` for the deployment — it is not a per-row property — and the qualifier that makes `forwarded` values evidence. |
| POST   | `/api/v1/admin/pairing-codes`     | JWT\*  | `201`   | Issue a pairing code binding an identity to the caller (§ 11.3). Returned once; no route reads it back. |
| POST   | `/api/v1/pairing-codes/redeem`    | None   | `200`   | Redeem one from the agent's host (§ 11.3). **Unauthenticated by design** — the code is the credential, and the caller has no human session. |
| GET    | `/api/v1/admin/agents/{identity}/owners` | JWT\* | `200` | Who is answerable for an identity, and how the claim was made (§ 11.3). |
| GET    | `/api/v1/admin/agents/owned`      | JWT\*  | `200`   | What the **caller** owns (§ 11.3). A tenant-wide grant does not widen it — "everything here" is not an answer to "what is mine". |
| POST   | `/api/v1/admin/agents/{identity}/can-proxy` | JWT\* | `200` | Grant or withdraw `can_proxy` (§ 8.2). Not settable on the unauthenticated provisioning route — a grant the checked party writes is not a check. |
| GET    | `/api/v1/admin/groups`            | JWT\*  | `200`   | Groups, their members and every egress rule (§ 12). |
| POST   | `/api/v1/admin/groups`            | JWT\*  | `201`   | Create one. It can send nowhere until a rule says so (§ 12). |
| POST   | `/api/v1/admin/groups/{group_id}/members` | JWT\* | `200` | Move an identity in. Membership is singular (§ 12). |
| POST   | `/api/v1/admin/groups/{group_id}/egress` | JWT\* | `201` | Allow `{group_id} -> to_group`. Directional (§ 12). |
| DELETE | `/api/v1/admin/groups/{group_id}/egress/{to_group}` | JWT\* | `200` | Withdraw that one direction (§ 12). |
| GET    | `/api/v1/admin/mailbox/{identity}` | JWT\*  | `200`   | What is waiting for one identity, and what is leased. No bodies. |
| GET    | `/api/v1/admin/tenants`           | JWT\*  | `200`   | What each tenant received (§ 11.4). Gated on `tenant.read.stats`. |
| GET    | `/api/v1/admin/telemetry`         | JWT\*  | `200`   | What an operator acts on: keys awaiting a decision, lanes not draining, messages accepted, and whether a limit has fired (§ 14). Gated on `audit.read.metadata`. |
| GET    | `/api/v1/admin/grants`            | JWT\*  | `200`   | Who holds which capability (§ 11). Gated on `role.grant`. |
| POST   | `/api/v1/admin/grants`            | JWT\*  | `201`   | Grant a capability to a subject (§ 11). |
| DELETE | `/api/v1/admin/grants`            | JWT\*  | `200`   | Revoke one. Absent is not an error (§ 11). |
| GET    | `/api/v1/admin/keys/pending`      | JWT\*  | `200`   | Keys awaiting an approval decision (§ 10.2.1). |
| GET    | `/api/v1/admin/keys/stream`       | JWT\*  | `200`   | Key proposals as they arrive, SSE (§ 10.2.1). **A second source for the same fact as `/api/v1/admin/keys/pending`**, and a client is expected to hold both: the list on load, the stream after. A pending key therefore reaches the screen from whichever arrives first, so blocking one of them does not stop the count from filling and is not a measurement of the feature. `agent-mesh-local-pm` found this as a race — two runs of one tool against one commit disagreed on five pairs, all of them this route — and it is written here because the alternative is each reader rediscovering it from a flake. |
| GET    | `/api/v1/admin/keys/{identity}`   | JWT\*  | `200`   | One identity's key history (§ 10.2.1). |
| POST   | `/api/v1/admin/keys/approve`      | JWT\*  | `200`   | Approve a proposed key, by fingerprint (§ 10.2.1). |
| POST   | `/api/v1/admin/keys/deny`         | JWT\*  | `200`   | Deny a proposed key, by fingerprint (§ 10.2.1). |
| POST   | `/api/v1/admin/keys/revoke`       | JWT\*  | `200`   | Revoke a key, by fingerprint (§ 10.2.1). |
| POST   | `/api/v1/admin/approve`           | JWT\*  | `200`   | Approve a pending user. |
| POST   | `/api/v1/admin/deny`              | JWT\*  | `200`   | Deny a pending user. |
| GET    | `/api/v1/admin/chat-audits`       | JWT\*  | `200`   | Cursor-paginated message audit log. |
| GET    | `/api/v1/admin/chat-audits/stream`| JWT\*  | `200`   | SSE stream of new audited messages. |
| GET    | `/api/v1/admin/chat-audits/agents`| JWT\*  | `200`   | Distinct agent identities in audit log. |
| POST   | `/api/v1/ingest/ai-usage`         | Token  | `200`   | AI-usage snapshot ingest (`AI_USAGE_INGEST_TOKEN`). |
| GET    | `/api/v1/admin/ai-usage`          | JWT\*  | `200`   | Latest AI-usage snapshot. |
| GET    | `/api/v1/admin/ai-usage/stream`   | JWT\*  | `200`   | SSE stream of AI-usage updates. |
| GET    | `/api/v1/admin/telemetry/behaviour` | JWT\*  | `200`   | The six behavioural metrics (§ D-1): pending keys, oldest pending message, signature refusals, rate-limited, egress refusals, accepted. Each is a number **or** an absence naming what could not be read — never a substituted `0`, because four of the six read `0` when all is well. Carries `counting_since`, since the hub's refusal counts are per-process and a count without its window cannot be read. |
| GET    | `/api/v1/push/vapid-key`          | None   | `200`   | VAPID public key (PWA registration). |
| POST   | `/api/v1/push/subscribe`          | JWT    | `200`   | Register a Web Push subscription. |
| POST   | `/api/v1/push/unsubscribe`        | JWT    | `200`   | Drop a Web Push subscription. |
| GET    | `/auth/github`                    | None   | `302`   | Begin GitHub OAuth flow. |
| GET    | `/auth/github/callback`           | None   | `302`   | OAuth callback; sets `mesh_token` cookie. |
| POST   | `/auth/local`                     | None   | `302`   | Local username/password login; sets cookie. |
| GET    | `/auth/me`                        | JWT ¶  | `200`   | Current user info, including `approved` and `capabilities` — the § 11 grants this subject holds. Carries `tenant`, the session's own `local_users.tenant`, or `null` for a login with no local row — `null` means *no local account*, not *the default tenant*, and is not defaulted on the way out. Reporting which tenant a session is in is not the scoping question (`I-093`/`I-094`) and does not wait on it. |

¶ `/auth/me` is the one `JWT` route that does **not** refuse an
unapproved user: it answers `200` with `approved: false`. It is how a
client discovers it is pending, so refusing it would make the pending
state undiscoverable and leave the client with a `403` it cannot
explain. It returns `404` for a session whose user row does not exist.

† The SSE route authenticates from the **session cookie**, like every other
route here. `EventSource` cannot set headers, which is true and does not
matter: a cookie is not a header the caller sets, it is one the browser sends,
and it sends it for a same-origin request unasked. Cross-origin consumers pass
`withCredentials: true`.

It **MUST NOT** accept a credential in the query string. A bearer token in a
URL lands in access logs, proxy request lines, `Referer` on whatever the page
loads next, and browser history — the one place logging tools are designed to
keep.

The cost is that the token appears in access logs and in any proxy's
request line. It is accepted here because the alternative is no event
stream at all in a browser; deployments that log request lines SHOULD
redact the parameter.

‡ `/api/v1/attachments/:id` authenticates the **parties to the message that
carries the attachment** — sender or recipient, agent or person. A person
arrives with the session cookie; an agent signs the request per § 9.2.1.

It was open at internal-mesh v0.1, on the reasoning that a content-addressed
id is unguessable and therefore a capability. That holds until the id appears
in a log line, an audit event, or a `download_url` forwarded to somebody else —
**a capability that travels inside the thing it protects cannot be withdrawn.**

Participation is read from `messages`, not from the audit trail. The audit copy
is permanent (§ 15.6), so authorising from it would keep granting access long
after the conversation rotated away; access should expire with the operational
record rather than with the evidence one. `sent_by` does not count — carrying a
message is not being party to it.

A caller who is not party gets `404`, the same answer as a missing attachment.
Distinguishing them would make the route a probe for which digests the mesh
holds.

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

**Three states, not two.** A `JWT` route distinguishes *no session*
(`401`), *a session for a user no operator has approved* (`403`), and
*an approved user* (the route's own answer). Approval is a separate
question from role: an admin is approved implicitly, and every other
login waits in `GET /api/v1/admin/pending` until approved. A client
that reads `403` as "wrong credentials" and re-authenticates will loop
forever — the correct handling is to tell the user their access is
pending.
Unauthorized access (valid JWT but missing scope, e.g. JWT without the
`admin` role for a `JWT*` route) MUST return `403`.


#### 9.1a. What `/api/v1/health` answers

```json
{ "status": "ok", "version": "20260818041757", "agent_count": 14, "uptime": 51407 }
```

| field | meaning |
|---|---|
| `status` | `"ok"`. The route answering at all is the liveness signal; this is not a health roll-up of anything else. |
| `version` | The build stamp of the running process, so two deployments can be told apart. |
| `agent_count` | Mesh identities in the registry. **Not** people, not online sockets — an operator asking *how many agents exist* is asking this. |
| `uptime` | Seconds since this process started. |

**Unauthenticated, deliberately.** It is the one answer available before a
session exists, and a liveness check that needs a credential is one nobody can
use from a load balancer.

**This body was unspecified until now, and both halves of that cost something.**
`agent_count` counted the http server's messaging directory rather than the
registry, so it reported the number of *people* — one, where the mesh held
fourteen — and no test disagreed because none asserted what the number was of.
Separately, nobody had decided whether an unauthenticated caller should see a
count at all; that is settled here as yes, and written down so the next person
does not re-open it by guessing.

`agent-mesh-hub` answers its own `/health` on its own port with a different
body — `service`, `version`, `agent_mesh_spec`, `online_agents`. **`online_agents`
and `agent_count` are different questions**: who is connected now, and how many
identities exist.

### 9.2. Control-plane routes on `agent-mesh-hub` (`AGENT_MESH_HUB_PORT`, default `3100`)

The hub listener serves both WebSocket upgrades (the JSON-RPC surface
of § 8) **and** a small REST control plane for identity provisioning
and teardown. These routes live on the hub port, NOT on
`agent-mesh-http`.

| Method | Path                              | Auth   | Success | Notes |
|--------|-----------------------------------|--------|---------|-------|
| GET    | `/health`                         | None   | `200`   | Hub liveness, `online_agents` count, and `agent_mesh_spec` (§ 13). |
| POST   | `/api/agents`                     | None † | `200`   | Legacy provisioning alias; response shape MAY differ from `/api/v1/agents` — see § 10.1. |
| POST   | `/api/v1/agents`                  | None † | `200`\|`201` | Canonical identity provisioning (§ 10.1). |
| GET    | `/api/v1/agents/{identity}/keys`  | None † | `200`   | What the hub holds for one identity: registered `type`, `deleted`, `key_status`, `keys[]` and `events[]` (§ 10.2). Read-only: the hub never decides a key, because it cannot authenticate who is asking — approval is on `agent-mesh-http` (§ 10.2.1). |
| DELETE | `/api/agents/{identity}`          | —      | `403`   | **Refused here.** Teardown needs an authenticated caller and the hub has none — see § 9.3. |

† At v0.1, hub REST routes are unauthenticated on the assumption the
hub binds to a trust-bounded interface (Tailscale or LXC-internal
bridge). Public-internet deployments MUST gate these routes behind a
bearer token or equivalent before exposing them (§ 10.1).

`GET /api/v1/agents/{identity}/keys` reports the registered `type`
because a host **reclaiming** an identity needs it and may hold no key
the hub will yet accept.

`mesh.list_agents` (§ 8.3) also carries it, and § 8.10 serves that method
without a socket — so the gap is not the absence of a connection. The
condition there is **being able to sign**: § 8.10 has no unsigned path,
because without a socket to have connected on there is nothing else that
says who is asking, so an unsigned request is `-32600` and a request
signed by a key that is pending, denied or revoked is `-32014`.

That second case is the gap. It is precisely the state a host occupies
while waiting for an operator to decide, and after a revocation. This
route is unauthenticated (†), so it answers throughout.

Where both work, this one is narrower. `mesh.list_agents` enumerates
every agent's type; this answers for a single name the caller already
knew. **Name to attribute, never attribute to name** — the same direction
§ 10.2 fixes for fingerprints.

#### 9.2.1. The signed mailbox surface (0.2)

`POST /api/v1/rpc` (§ 8.10) carries a mailbox and does not describe one.
These routes are the same methods against the same queue, named so the
surface can be read. **Nothing here is a second store**, and a
participant switching between a socket, `/api/v1/rpc` and these routes
is one identity with one mailbox.

| Method | Path | Wraps | Success |
|--------|------|-------|---------|
| POST   | `/api/v1/mailbox/in` | `mesh.receive` | `200` |
| POST   | `/api/v1/mailbox/out` | `mesh.send` | `200` |
| GET    | `/api/v1/mailbox/out` | — | `200` |
| DELETE | `/api/v1/mailbox/out/{message_id}` | — | `200` |
| GET    | `/api/v1/mailbox/history` | `mesh.fetch_messages` | `200` |
| GET    | `/api/v1/capabilities` | — | `200` |

**Authentication.** Every route except `/api/v1/capabilities` MUST carry

```
Authorization: AgentMeshSig kid="…", nonce="…", iat="…", sig="…"
```

over `restSignaturePreimage` — its own domain separator, because one key
also signs § 8.1 and § 9.1 and two signatures replayable into each
other's position are one signature. The preimage covers the method, the
path **including its query string**, the `kid`, the nonce, the `iat`,
and a SHA-256 of the body (empty string when there is none). Freshness
and the replay rule of § 8.1 apply unchanged, including that a nonce is
spent on receipt.

The identity is the signature's. No route takes it as a parameter: a
separately-claimed identity is a second assertion able to disagree with
the first (§ 8.10).

**`POST /api/v1/inbox` is a POST because it acts.** It leases a batch,
settles the previous one and writes an audit event. A `GET` would invite
every layer that treats `GET` as safe to retry it and silently consume a
lease.

```
body:   { limit?: number, ack_ids?: string[] }
result: { messages: [...], remaining: number, lease_seconds: number }
```

`{ ack_ids, limit: 0 }` settles without taking more, which is the
end-of-turn case.

**Recall is bounded by hand-over, not by acknowledgement.** A sender MAY
withdraw a message the recipient has never been given, and MUST NOT
withdraw one already handed out — that message is part of the
recipient's record, and a surface letting the sender revoke it makes the
sender the owner of someone else's audit trail.

```
status = 'pending', leased_until IS NULL    never handed out   recallable
status = 'pending', leased_until in future  handed out         NOT recallable
status = 'delivered'                        acknowledged       NOT recallable
```

Acknowledgement is the wrong line: a leased message was returned in a
response, so the recipient holds it whether or not it survived to say
so.

`GET /api/v1/outbox` returns exactly the recallable set, so a client
never interprets `leased_until` and the hub never exposes it.

**The listing is a hint; the DELETE is the judgement.** A recipient may
call `POST /api/v1/inbox` between the two, so the recall MUST re-decide
in one statement rather than trust the listing — `changes` is the
answer. A recall that lost the race is `409` with
`code: "ALREADY_DELIVERED"`.

**A recall MUST emit `mesh.message.recalled`** (§ 8.9.4), carrying the
`mesh.message.sent` event as `causation_event_id`, `recorded_by.kind =
"hub"`, and the sender's `AgentMeshSig` as the attestation. Without it
the trail holds a `sent` event and nothing recording the withdrawal,
which is the same defect one level down: the sender shaping the record.
The body is not repeated — the `sent` event already carries it.

The `messages` row is deleted rather than tombstoned. That table is
operational and rotates (§ 15.6); the audit copy is the permanent record
and is where the withdrawal belongs.

**`GET /api/v1/capabilities` is unsigned**, and reports what this
deployment enforces:

```
{ mailbox: MailboxCapabilities,
  audit:   AuditCapabilities,
  surface: { version } }
```

Unsigned because the values matter most while a caller cannot yet sign:
a client being set up needs the lease and dedup windows to size its
retry loop, and its key is `pending` until an operator acts. Gating it
would withhold them exactly when they are needed, so the client would
hardcode a guess — the drift this route exists to prevent.
`GET /api/v1/agents/{identity}/keys` is unauthenticated for the same
shape of reason (§ 9.2 †). Nothing here is per-caller.

`audit` is included because § 8.9.1 advertises those caps in the
`mesh.connect` result and this population never connects.

The three versions are reported separately, as § 13 requires: the
transport contract, the audit protocol, and this route table.

**`surface.version`:**

| Version | Route table |
|---------|-------------|
| `1` | § 9.2 and § 9.2.1 as first built |
| `2` | `GET /api/v1/agents/{identity}/keys` reports the registered `type` |
| `3` | `POST /api/v1/agents` refuses a `public_key` held by another identity (§ 10.1) |

A client MUST gate on this rather than on the field's presence. **Absence
is ambiguous**: a hub too old to report `type` omits it, and a hub that
reports it answers `null` for an identity registered through
`mesh.register`, which never wrote one (§ 9.2). Probing cannot separate
those, and the case a client guesses wrong is the one where it silently
stops checking.

`agentMeshSpec` (§ 13) cannot serve here. It versions this whole
document at minor granularity, so it does not move for a field — and a
deployment reports it from a running process while the field it would be
standing in for arrived in a build that process may not be. This route
is served by that same process, which is the property that makes it
answerable.

### 9.2a. Request bodies, and what a deletion of nothing answers

Written because their absence was doing the work of a clause. `agent-mesh-client`
declined to write conformance scenarios for these routes rather than read the
field names out of this implementation — correctly: a scenario whose expectation
is copied from the code asserts that the code has not changed, not that the
contract holds. Two of their scenarios were pinning behaviour no clause required,
which `agent-mesh-local-pm` named as the difference between *the source of a
reason* and *the rule* (mail #1316).

**Deleting something absent is not an error.** A `DELETE` whose target does not
exist answers `200`, and the body says which of the two happened:

```
{ ok: true, action: "deleted"   }   it was there
{ ok: true, action: "not-found" }   it was not
```

The operator asked for it to be gone and it is gone; a `404` would make a caller
retry or alert over a state it already has. New deletion routes inherit this
rather than choosing again — that is the point of stating it here instead of
letting two routes that happen to agree stand as the rule.

**Creation answers `201`**, and the body carries what was made. The four admin
`POST`s above all do, which is evidence and not a rule until it is written here —
the same distinction that made the deletion sentence necessary. A fifth creation
route answering `200` would otherwise break nothing.

**`GET /api/v1/files` refuses by prefix.** `path` must resolve inside
`AGENT_MESH_STATE_DIR`, or inside a prefix the deployment adds; anything else is
`403`, and a path containing `..` that changes under resolution is refused before
the prefix check. A scenario asserting the passing half needs a path the
deployment allows, which is why the refusing half is the portable one.

**Request bodies.** Optional fields are marked `?`; anything else is required and
its absence is `400` with a message naming the field.

| Route | Body |
|-------|------|
| `POST /api/v1/admin/grants` | `{ subject, capability, scope }` |
| `POST /api/v1/admin/users` | `{ username, display_name?, role?, tenant? }` |
| `POST /api/v1/admin/agent-types` | `{ type, description, requires_key }` |
| `POST /api/v1/admin/pairing-codes` | `{ identity, ttl_seconds? }` |
| `POST /api/v1/admin/keys/{approve,deny,revoke}` | `{ fingerprint, reason? }` |
| `GET /api/v1/files` | `?path=` — required, `400` without it |

**The key decisions are addressed by fingerprint, never by identity**, and that is
worth stating rather than leaving in the shape of the field. An operator approves
*a key*, not a name: an identity may have proposed more than one, and approving
by name would approve whichever the server picked. `reason` is required by § 10.2
for a revoke and optional for the other two.

### 9.2b. Telling *no key yet* from *key withdrawn*

`KEY_NOT_APPROVED` (`-32014`) MUST carry `key_status` in its error data:

```
"missing"   no approved key exists for that identity — none proposed, or one
            proposed and not yet decided
"revoked"   there was one and it was withdrawn
```

A client branches on this: the first is its own to fix by proposing a key, the
second is an operator decision it can only wait on. Without the field it can only
retry blindly, which is what `agent-mesh-client` reported while writing
conformance scenarios.

**Both states deliberately share one code, and the reason is written here so the
next reader does not split them in the name of consistency.** A caller holding no
key gets `-32014` for every identity it names, whether that identity is
registered or not; separate codes would let an unauthenticated caller enumerate
which identities exist. The distinction a legitimate client needs is in the data,
where it costs nothing; the distinction an attacker would use is in the code,
where it costs the registry's privacy. `-32011 IDENTITY_NOT_REGISTERED` is
declared and, in this dispatch order, unreachable over the wire for the same
reason: signature verification runs before the handler and requires an approved
key for the name being claimed, so an unregistered name is refused on the key
first. The guard behind it stays as defence in depth, and if that order ever
changes it is the code that answers.

### 9.3. Identity teardown

Teardown is the destructive counterpart of `POST /api/v1/agents`, so
that the two together own the identity lifecycle without any caller
needing direct SQL access.

**It is served by `agent-mesh-http` at
`DELETE /api/v1/admin/agents/{identity}`, behind the admin JWT.** The
hub MUST refuse `DELETE /api/agents/{identity}` with `403` and name the
route that replaced it.

The reason is the one § 10.2 gives for key approval: **the hub cannot
authenticate a caller.** It holds no sessions and no tokens, so every
route it serves is reachable by anything that can reach the port. That
is acceptable for provisioning, which `create_only` makes safe to offer
openly — a caller can create a name nobody holds and can take nothing.
It is not acceptable here. One unauthenticated request revoked every key
an identity had, and re-registration is blocked afterwards, so recovery
meant editing the database by hand; the names to aim at could be listed
from `mesh.list_agents` first.

The admin's login is recorded as the `actor` on every resulting
`agent_key_events` row. § 10.2 requires each key transition to name who
caused it, and an unauthenticated teardown could only ever write the
service's own name — recording that a revocation happened without
recording who is answerable for it.

**Identity validation.** `{identity}` MUST match `^[A-Za-z0-9][A-Za-z0-9-]*$`
(§ 10.1). Anything else MUST return `400` with body
`{ "ok": false, "error": "invalid identity format …" }`.

**Behavior (0.2).** Teardown is a **soft delete**, performed in a single
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
  "public_key":  "<base64url, 43 chars>", // Ed25519 raw 32B; REQUIRED when the
                                          // type has requires_key (§ 10.3)
  "create_only": true | false             // optional, default false
}
```

**`create_only` (0.2).** When true the hub MUST refuse rather than update if the
identity already exists, and MUST make the existence check and the insert one
atomic operation — a caller that reads first and registers after loses the race
it is trying to avoid.

Onboarding a new participant MUST use it. Without it the route upserts, so a
second lane registering an existing name takes that identity over: its
description is replaced, its pending key superseded, and the taker is answered
`200`. The holder finds out when their approval fails against a fingerprint
nobody recognises.

A refusal changes nothing — not the row, not the description, and above all not
the key. Refusing while still superseding would be worse than the upsert, since
the caller is told no and the damage is done regardless.

Rotation and re-registration keep update semantics, which is why the default is
`false`.

Refusals carry a machine-readable `code`, because a caller must tell them apart
without matching prose and they call for different responses:

| `code` | Status | Meaning |
|--------|--------|---------|
| `IDENTITY_EXISTS` | `409` | The name is taken. Choose another. |
| `IDENTITY_DELETED` | `409` | The name was torn down (§ 9.3) and is never usable again. |

Neither is retryable.

**Behavior** — the hub MUST:

1. Validate `identity` against `^[A-Za-z0-9][A-Za-z0-9-]*$`; reject with `400`
   otherwise. The comparison is case-sensitive throughout — see below.
2. Validate `type` against the `agent_types` registry (§ 10.3); reject with
   `400` otherwise, listing the registered types.
3. Reject with `400` when the type has `requires_key` and no `public_key` was
   supplied, and the identity has no approved key already.
4. Reject with `409` when the identity exists and is soft-deleted (§ 9.3).
5. Reject with `409 KEY_HELD_BY_ANOTHER_IDENTITY` when `public_key` is already
   on record under a different identity — **before writing the row**, and
   without naming the holder (see below).
6. UPSERT the row: `INSERT … ON CONFLICT(identity) DO UPDATE SET type, description`.
7. When `public_key` is present, record it per § 10.2.
8. Return `201 Created` when the row did not previously exist, `200 OK`
   when the row already existed and was updated.
9. Return `500` only on a genuine DB error; transient errors MAY be retried
   by callers using exponential or fixed backoff.

**Step 5 must precede step 6.** `agent_keys` is keyed on the fingerprint
alone, so a second identity proposing a key already on record inserts
nothing. Recording it afterwards therefore reports the *other* holder's
status — a caller supplying a key it does not own is told `approved`
while holding none — and leaves behind exactly what step 3 exists to
prevent: an identity of a `requires_key` type that can never connect.
Step 3 asks whether a `public_key` was *supplied*, which is not the same
question as whether one landed.

**The refusal MUST NOT name the holder.** This route needs no
credential, so an answer identifying the owner of a submitted key makes
it a fingerprint-to-identity lookup for anything that can reach the port
— the direction § 10.2 keeps closed. Saying the key is taken is
unavoidable; saying whose is not.

A caller MUST NOT treat a `key` object in a `2xx` response as proof that
its own key was recorded. `GET /api/v1/agents/{identity}/keys` lists the
keys that identity actually holds, and is the check.

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

#### 10.2.1. Approval routes

Served by `agent-mesh-http` behind the admin JWT gate (§ 9.1), for the
reason above. Every route is `JWT*`.

| Method | Path                             | Body / params | Result |
|--------|----------------------------------|---------------|--------|
| GET    | `/api/v1/admin/keys/pending`     | —             | `{ keys: [{ identity, fingerprint, status, proposed_at }] }` |
| GET    | `/api/v1/admin/keys/{identity}`  | path identity | `{ keys: [...], events: [...] }` — the full history, including revoked keys |
| POST   | `/api/v1/admin/keys/approve`     | `{ fingerprint, reason? }` | `{ ok: true, fingerprint, status }` |
| POST   | `/api/v1/admin/keys/deny`        | `{ fingerprint, reason? }` | `{ ok: true, fingerprint, status }` |
| POST   | `/api/v1/admin/keys/revoke`      | `{ fingerprint, reason? }` | `{ ok: true, fingerprint, status }` |

**A decision names a fingerprint, never an identity.** An operator who
approves "whatever is pending for `prod-codex1`" approves whatever
arrived last — including a proposal that landed between reading the
screen and clicking. The fingerprint is also the string the operator is
required to have compared against the one the holder logged, so naming
it *is* the check. A request without one is `400`.

`reason` is optional and is recorded on the `agent_key_events` row. It
matters on revocation: a routine `rotation` says nothing about earlier
signatures, while `compromise` casts doubt on the window preceding it.

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
| `ai-antigravity` | 1 |
| `service` | 0 |
| `human` | 0 |

**Adding a type is an operator action, not a caller action.** `POST
/api/v1/agents` is unauthenticated (§ 10.1), so a registration endpoint that
also created types would make the check meaningless — any caller could invent a
type and register under it. New types are added through
`POST /api/v1/admin/agent-types` on `agent-mesh-http`, behind the same gate as
key approval (§ 10.2.1).

Adding is **create-only**. The field worth updating is `requires_key`, and
lowering it retroactively lets every identity of that type connect without a
key (§ 8.1) — silently disarming the signing requirement for identities
provisioned long before the change. A deployment that means that does it
deliberately and out of band.

Removal is refused while **any** identity carries the type, soft-deleted ones
included. A torn-down identity keeps its row so its past signatures stay
interpretable (§ 9.3), and that row names a type; dropping the type would leave
the classification dangling on a record the audit trail still points at.

A client MUST NOT invent a missing type or fall back to a neighbouring one. A
runtime registered under the wrong type makes the audit record state something
that was never observed — which vendor a lane was actually running.

Because seeding is idempotent and runs on every start, removing a type
through the API alone is not durable: the next restart puts it back. A
deployment that means to drop a seeded type removes it from the seed as
well.

A type names **the runtime that attaches**, not the model behind it.
`ai-antigravity` is the `agy` CLI; which model it calls is not something
the deployment observes, and a type that claimed otherwise would make the
audit record state a fact nobody checked.

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

## 11. Authorization

A person's authority is a set of **capabilities**, each over a **scope**,
inside a **tenant**. It is not a role name compared in a route.

```
platform operator
  └── tenant admin           a company admin — inside the tenant
        ├── group manager
        └── agent manager
        └── …
```

That `…` is the reason for the shape. A role is a bundle somebody chose; a
capability is what a route needs. The set is expected to grow, and a design
that compares role strings inline extends to a second role by editing every
site and to a fifth by being wrong at one of them.

| Capability | |
|---|---|
| `key.approve` | decide a proposed key (§ 10.2) |
| `agent.provision` | create an identity and claim the name |
| `agent.teardown` | destroy one (§ 9.3) |
| `group.manage` | create groups; move agents between them |
| `role.grant` | grant and revoke inside this tenant |
| `audit.read.metadata` | the trail **without** message content |
| `audit.read.content` | message bodies in the trail |
| `mailbox.read.depth` | queue depth per identity, never bodies |
| `tenant.read.stats` | how much traffic a tenant received (§ 11.4) |
| `source.read` | where each identity has been observed connecting from (§ 8.11) |
| `user.admit` | admit a **person** to the platform, or refuse them |
| `usage.read` | AI usage figures |

**The last three carry the privacy boundary.** A platform operator holds
`audit.read.metadata` and not `audit.read.content` — who sent to whom, when,
how much and what failed is how a mesh is operated; the bodies are not. It is
the same line `GET /api/v1/admin/inbox` already draws by reporting depth and
withholding content: *seeing that someone has mail is a different
authorisation question from reading it.*

**Scope** is `*` for the whole tenant, a group id, or a single identity. A
tenant-wide grant satisfies any narrower ask. **A narrow grant MUST NOT widen**
— holding `key.approve` on one identity must not answer yes for another, which
is the entire point of scoping it, and the failure is silent: every screen
works and every action succeeds.

### 11.0. What the content boundary is, and is not

A hub MUST withhold message bodies from `GET /api/v1/audit/events` and
`/api/v1/audit/events/{event_id}` for a caller without
`audit.read.content`, and MUST keep the surrounding metadata — `from`, `to`,
`id`, timestamps, sizes — which is what operating a mesh requires.

**This is redaction on the way out.** The process reads the stored bytes and
chooses what to return. It prevents an unentitled *caller* from seeing content;
it does not prevent whoever administers the host from opening the file. Both
routes MUST be gated, not one — a boundary applied to a listing and forgotten
on the by-id route is the shape this failure takes.

The stronger version moves bodies to their own table so the metadata query
never touches them, which also makes per-tenant encryption cheap because
bodies are the one column nobody filters on. That is not what this section
requires and MUST NOT be described as though it were: a control documented as
stronger than it is ends up load-bearing.

`content_sha256`, where present, is **not** content and stays. An operator
comparing a body obtained elsewhere against the record needs it. A length MAY
be reported for the same reason.

### 11.0.1. Reading the trail is recorded, and fails closed

A read of `audit.read.content` **MUST** be recorded as
`mesh.identity.audit_read` (§ 8.9.5) before the content is returned.

"The company admin can read your agent's messages" is defensible; "someone
can read them and nobody knows" is not, and the difference is only whether the
access leaves a trace. Without the record, the tenant admin sitting *inside*
the tenant (§ 11) is not a boundary — it is an absence of one.

**If the record cannot be written, the read does not happen.** § 15.6 answers
the analogous routing question the other way — delivery keeps working when
audit writes fail — and reusing that answer here would be wrong for a reason
that looks like consistency:

| | |
|---|---|
| delivery fails open | loses nothing that was going to be recorded anyway |
| an access log fails open | loses the only record that the access happened |

Failing open also makes an outage indistinguishable from an outage somebody
arranged. So a caller gets `503` and no content, and an operator who needs the
trail during an audit-store failure has a visible problem rather than an
invisible one.

Metadata reads are not gated on the writer: they carry no content, so nothing
is lost by serving them, and refusing them would take the mesh's diagnostics
down with its audit store.

### 11.1. Resolved per request, never carried in the token

An implementation MUST read grants at the point of use. It MUST NOT put the
decision in the session token.

The reason is revocation. A token that carries `role` fixes the answer for its
lifetime, so **revoking access does not revoke it** — the holder keeps working
until expiry, and the one moment revocation matters is an incident, which is
exactly when nobody can wait out a TTL.

The token carries **who**; the store answers **what**.

A refusal MUST name the missing capability. An operator told which grant they
lack can ask for that one; an operator told "forbidden" asks for everything.
Unauthenticated is `401` and unauthorised is `403` — one says sign in, the
other says ask for a grant, and collapsing them sends people to the wrong
place.

### 11.3. Ownership, and how a claim is proved

An identity has **owners** — plural. The tenant owns its identities; an owner
is the person answerable for one day to day. One owner means a departure
strands the agent and the recovery is a hand-edited table, which is the thing
this exists to remove. A tenant admin may assign and unassign, because someone
has to when an owner leaves.

**Teardown reaches what you own and no further.** § 9.3 is irreversible — the
name is never usable again — so a teardown that reached one identity too far
could not be undone. An agent operator MAY tear down an identity when either:

- they hold `agent.teardown` **scoped to that identity** (or tenant-wide); or
- they hold it at any scope **and** own the identity; or
- they hold `group.manage` **scoped to the group that identity is in** (§ 12).

The third MUST NOT be satisfied by tenant-wide `group.manage`. That grant is
held by every administrator, so accepting it turns this into a second and wider
grant of teardown under a different name.

Ownership alone MUST NOT suffice. Being answerable for an agent is not the same
grant as being permitted to destroy it, and a deployment may give one without
the other.

**A scoped queue is empty, not forbidden.** An operator holding `key.approve`
who owns nothing sees no pending keys. Answering `403` would say they lack a
permission they hold, and send them to ask for a grant they already have. A
tenant-wide grant is not filtered — that is what being inside the tenant means.

#### Pairing codes

The person is in a browser session; the agent is a process on a host with a
CLI. The claim has to cross that gap. A hub MAY implement:

```
POST /api/v1/admin/pairing-codes    authenticated, agent.provision
     -> { code, identity, expires_at }
POST /api/v1/pairing-codes/redeem   unauthenticated — the code is the credential
     -> { ok, identity, owner }
```

This is the device authorization grant with the roles reversed. Redemption
**MUST** be single-use and **MUST** be decided in one statement: reading the
row and then updating it leaves a window in which two redemptions both see an
unspent code, and the loser would take an ownership the winner already has.

A refusal MUST distinguish `unknown`, `expired` and `already-redeemed`. "Ask
for another" and "somebody else already used this" call for different
reactions, and collapsing them into *invalid* hides a race from the person
losing it.

**Redemption SHOULD record the observed source (§ 8.11).** It is the one
transaction in which the agent's host and the person vouching for it are both
known, which makes it the strongest available moment to establish a baseline.

The code is returned once. No route reads it back — a caller that loses it
issues another rather than recovering that one.

Codes SHOULD avoid characters that are misread when spoken or retyped —
`I`/`1`, `O`/`0` — because a mistyped code and a stolen one fail identically.

### 11.2. Migration

A deployment that predates this section has a role string. It MUST be
converted to grants — the same set that role could already exercise — rather
than left as a comparison somewhere alongside the capability check. **A
fallback to the role is not a compatibility shim; it is a hole**, because it
reinstates exactly the property § 11.1 exists to remove.

---

## 12. Groups and send restrictions

Every identity is in exactly one group. A send is refused unless a rule allows
it, and `-32018 EGRESS_DENIED` says so.

**Deny by default.** A mesh that ships permissive is a mesh where every
deployment stays open until somebody configures it, and nobody configures what
already works.

**Which makes the default group the load-bearing part.** An identity nobody
has placed is in `default`, and `default` MUST be seeded with a rule to
itself. Without that, deny-by-default silences every existing mesh on upgrade —
the difference between a feature and an outage. A deployment that has never
heard of groups behaves exactly as it did before, and the first restriction
somebody writes is the first one that bites.

**Membership is singular.** "Which policy applies to this agent" must have one
answer; two memberships with conflicting egress would need a precedence order
nobody gets right under pressure.

**Egress is directional.** `A -> B` says nothing about `B -> A`. Agents allowed
to report into an aggregator are not agents it may command, and a symmetric
rule makes the narrower grant inexpressible.

**A group created is a group that can send nowhere**, including to itself,
until someone says otherwise. Seeding a self-rule would guess the one thing the
operator created it to state.

### 12.1. Refuse, do not drop

The refusal happens at `mesh.send`, before the message is written and before
§ 8.11.2's clock is stamped.

Accepting and silently dropping would avoid telling an unauthorised sender that
the target exists. That is a real cost and it is the smaller one: the
alternative is a mesh in which messages vanish with no error anywhere, and an
operator debugging it has nothing to look at.

`-32018` is **permanent**. A retry changes nothing; only an operator adding a
rule does.

### 12.2. Routes

| Method | Path | Capability |
|--------|------|-----------|
| GET    | `/api/v1/admin/groups` | `group.manage` |
| POST   | `/api/v1/admin/groups` | `group.manage` |
| POST   | `/api/v1/admin/groups/{group_id}/members` | `group.manage` |
| POST   | `/api/v1/admin/groups/{group_id}/egress` | `group.manage` |
| DELETE | `/api/v1/admin/groups/{group_id}/egress/{to_group}` | `group.manage` |

Moving an identity into a group that does not exist MUST be refused. It would
otherwise put the identity somewhere no rule can name, which is silence rather
than an error.

---

## 13. Versioning

This specification follows semantic versioning at document level.

- `0.x` — breaking changes are allowed between minor versions.
- `1.0` — wire formats (envelope shape, JSON-RPC method names, REST
  paths) become stable.
- `2.0` — reserved for the next breaking redesign.

Implementations SHOULD declare the SPEC version they target in their
`package.json` under a `agentMeshSpec` field, and a hub MUST report it
as `agent_mesh_spec` on `GET /health`.

The manifest field describes a source tree; `/health` describes the
process that is answering. Only the second is checkable against a
deployment, which is what matters when two hosts are running different
builds.

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

## 14. Rate limiting

A hub SHOULD bound how often a caller may reach its routes, and MUST answer
`429` with `Retry-After` in whole seconds and `code: "RATE_LIMITED"` when it
refuses.

The route that needs it is `POST /api/v1/agents`, which is **unauthenticated**
(§ 9.2 †) — anything that can reach the port may call it as fast as it likes,
and the supersession rule of § 10.2 bounds what a flood *achieves* rather than
what it costs.

**Key on what the caller cannot choose.** An unauthenticated route has no
identity, so the key is the observed source (§ 8.11). A key the caller supplies
is a suggestion. Where an identity is known — the signed surface of § 9.2.1 —
that is the better key, so one lane cannot exhaust the budget of everything
sharing its address.

**`Retry-After` MUST NOT be `0`.** Telling a caller to retry immediately
invites the loop being limited.

### 14.1. A limit that fires during onboarding is a limit somebody disables

Defaults MUST accommodate a host bringing up a fleet at once, which is
indistinguishable in shape from a flood and is the common case. The refusal
exists to stop a *sustained* loop; a burst is normal.

Refill SHOULD be computed from elapsed time rather than driven by a timer. A
timer that stops leaves every bucket permanently empty; arithmetic fails the
other way.

Buckets that have refilled completely MUST be discardable — they are
indistinguishable from absent, and keeping them is a slow leak whose rate an
unauthenticated caller chooses.

**In-memory buckets are per process.** The hub does not scale horizontally
(§ 3.1), so this is the whole deployment today; behind two hubs it silently
becomes a limit of `2n`.

---

## 14A. Cross-VM deployment (internal-mesh v0.1)

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

---

## 17. Conformance scenarios

An implementation conforms to this specification when it passes the scenarios
in `@agent-mesh/contracts` (`E2E_SCENARIOS`). They are normative: where a
scenario and prose here disagree, the scenario is wrong and this document
stands, but a scenario that passes on one implementation and fails on another
is a contract defect regardless of which side prose seems to favour.

### 17.1. Why they are not in either repository

Two implementations have to agree on what the mesh does. A scenario list living
on one side is that side's opinion about the other, and both sides had one —
the client's as prose assertions, this one's as its own integration tests.
Neither could be replayed by the other, so "we both pass" was never a claim
anybody could check.

They ship in the contracts package, pinned by tag like the error codes and for
the same reason: a shared statement that changes only with a version bump.

### 17.2. Shape

A scenario is an `id`, the `clause` it holds, a `why` saying what breaks if it
regresses, and a list of steps. Steps use a small verb set — `provision`,
`approve`, `revoke`, `connect`, `send`, `receive`, `http`, `sleep`,
`expectStored` — that each side implements against its own transport.

Every scenario MUST cite a clause. A scenario nobody can trace back to this
document asserts somebody's memory of it.

The verb set is deliberately small. A vocabulary that grows to fit each new
scenario becomes a second implementation of the protocol, and then the question
"do both sides agree" is replaced by "does the scenario runner agree with
itself".

### 17.3. Nothing is skipped

A runner MUST run every scenario and every step. It MUST NOT skip by id, and it
MUST fail on a verb it does not implement rather than ignoring the step. A step
silently dropped is a scenario that reports green without running.

**This clause used to permit a skip, and the permission was the defect.** Three
scenarios asserted a trace by reading the platform's stores directly — an
observed source (§ 8.11), a content read logged (§ 11.0.1), a type change kept
(§ 8.9.5). A participant with no access to those stores could not run them, so
the rule let it skip them by verb, visibly.

Visibly, and to no effect. Each of those clauses was then confirmed by exactly
one implementation while both reports read green, which is the state conformance
scenarios exist to make impossible. The skip is what stopped anyone noticing.

They assert through the operator's routes instead, which is the better question:
a trace written where the operator cannot query it is not serving the operator
it was written for.

**A verb only one side can run is a clause only one side holds.** If a scenario
cannot be expressed against the mesh's own surfaces, the gap is in those
surfaces, and the fix belongs there rather than in a runner reaching past
them.

### 17.4. A scenario may state the mesh it needs

Some behaviour a default deployment cannot show in test time — a receive lease
lapsing is the case that forced this. Such a scenario carries `mesh`, and the
runner starts one shaped that way.

The requirement belongs to the scenario because it is part of the claim: "with
a two-second lease, an unacknowledged batch comes back" is what is being
asserted. A runner that quietly used the default would report a pass for
something it never measured.
