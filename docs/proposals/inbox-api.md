# Proposal — a named inbox surface over the socketless transport

Status: **built** (`13a3409`). SPEC § 9.2.1 is the contract; this is why it
has the shape it does.

Two things changed on the way in, both recorded below rather than edited away:
the peek route was cut before it was written, and the operator half moved to
`agent-mesh-http`. The second is what resolved the `GET`/`POST` argument, so
the reasoning is worth keeping even though the route table now lives in SPEC.

## The problem

An agent that cannot hold a socket already reaches the mesh: `POST /api/v1/rpc`
on the hub carries the same signed JSON-RPC as § 8.10, and `mesh.send` /
`mesh.receive` are the inbox. It works — `scripts/mesh-mail.ts` is a working
client and the two agents building this system have been using the idea for
weeks.

What it does not have is a **surface you can read**. A JSON-RPC endpoint that
accepts six method names tells a newcomer nothing about what an inbox can do.
There is no route list, no capability document reachable at runtime, and the
lease-and-acknowledge contract — the part most likely to be got wrong — is
visible only to someone who reads § 8.10.1.

The standalone mailer on `:3300` has the opposite problem. It is legible
(`GET /api/mail`, `POST /api/mail`) and its semantics are wrong for a mesh: a
`GET` marks messages read as a side effect, and a sender can delete a message
out of a recipient's inbox after it was read. Both were found by using it. The
legibility is worth keeping; the semantics are not.

**This proposes a REST wrapper over the existing transport.** Not a second mail
service — the same queue, the same identities, the same signing.

## What it is not

- **Not a new store.** Every route below is a rename of an existing method
  against the existing `messages` rows. A participant switching between a
  socket, `/api/v1/rpc` and this surface is one identity with one inbox
  (§ 8.10).
- **Not a replacement for `/api/v1/rpc`.** That stays. A client that already
  speaks JSON-RPC has no reason to move, and the audit methods are not
  wrapped — a blob upload is not an inbox operation.
- **Not the standalone mailer.** The mailer keeps its own semantics until the
  mesh replaces it; the migration note at the end says what has to be true
  first.

## Where the agent half lives

On the **hub**, beside `/api/v1/rpc`.

The two services authenticate different populations. `agent-mesh-http`
authenticates *people* — GitHub OAuth, a JWT, an approval gate (§ 9.1). The hub
authenticates *agents* — an Ed25519 signature against an approved key (§ 8.1).
An inbox belongs to an identity that signs, so the agent half belongs where
signing is already the rule.

Putting it on the http server would mean either a second auth model for agents
there, or agents holding sessions, which they cannot: a socketless agent is
awake only while answering and has nowhere to keep a cookie.

The operator half goes the other way, for the mirror-image reason. Both are
below.

## Authentication: the header form already exists

`/api/v1/rpc` puts the signature in the request body as a `sig` sibling. A REST
route cannot — `GET` has no body worth signing, and a `DELETE` may have none.

The construction to reuse is the one blob upload already uses (§ 9.1):

```
Authorization: AgentMeshSig kid="sha256:…", nonce="…", sig="…"
```

It needs a preimage of its own with its own domain separator, for the reason
§ 8.1 gives about the RPC and upload preimages: **two signatures that could be
replayed into each other's position are one signature.** The preimage covers
the method, the path with its query string, the `iat`, the nonce, and a digest
of the body when there is one.

Freshness (±120 s) and the replay window apply unchanged, including the rule
found today: **the nonce is spent on receipt, not on success** (§ 8.1), so a
retry after any failure needs a fresh one.

## Two surfaces, because there are two populations

The design settles by asking who is calling.

| | Agents | Operators |
|---|---|---|
| Service | `agent-mesh-hub` `:3100` | `agent-mesh-http` `:3000` |
| Auth | `AgentMeshSig` header | admin JWT (§ 9.1) |
| `hub.db` handle | read-write | **read-only** |
| Verbs | `POST`, `DELETE` — every call is an act | `GET` — every call is a read |

This is the split § 10.2 already draws for key approval and § 9.3 now draws for
teardown: **the hub cannot authenticate a person.** It holds no sessions, so an
operator-facing route there would be reachable by anything that can reach the
port.

It also settles the `GET`/`POST` question that the single-surface version could
not. Taking delivery leases a batch, settles the previous one, and writes an
audit event — it is not a read, and a `GET` invites every HTTP layer that
believes `GET` is safe to retry it and quietly consume a lease. On the operator
side there is nothing to consume, so `GET` is honest there.

The separation is enforced by the file handle rather than by discipline. The
http server opens `hub.db` with `readonly: true`, so an operator route
**cannot** lease or acknowledge even if someone later writes one that tries.

## Agent surface — `agent-mesh-hub`, signed

The identity is the signature's, never a path parameter: a separately-claimed
identity is a second assertion able to disagree with the first (§ 8.10).

| Method | Path | Wraps | Notes |
|--------|------|-------|-------|
| `POST` | `/api/v1/inbox` | `mesh.receive` | Take delivery and settle the previous batch. Body `{ limit?, ack_ids? }`. End-of-turn settle is `{ ack_ids, limit: 0 }`. |
| `POST` | `/api/v1/outbox` | `mesh.send` | Body `{ to, content, reply_to?, client_message_id? }`. Returns `{ id, status }`. |
| `GET`  | `/api/v1/outbox` | — | Sent messages **not yet handed to the recipient**. The recall candidates, and nothing else. |
| `DELETE` | `/api/v1/outbox/{id}` | — | Recall one. Refused once the recipient has been handed it. Emits `mesh.message.recalled`. |
| `GET`  | `/api/v1/inbox/history?peer=&limit=` | `mesh.fetch_messages` | Conversation with one peer. |
| `GET`  | `/api/v1/capabilities` | `MailboxCapabilities`, `AuditCapabilities` | **Unsigned.** What this deployment actually enforces. |

### Recall is bounded by hand-over, not by acknowledgement

A sender may withdraw a message the recipient has never been given. Once it has
been handed out it is part of the recipient's record, and a surface that lets
the sender revoke it makes the sender the owner of someone else's audit trail —
which is the standalone mailer's defect.

The boundary is **hand-over, not acknowledgement**. `messages` already
distinguishes three states, and only the first is recallable:

```
status='pending', leased_until IS NULL     never handed out    recallable
status='pending', leased_until in future   handed out, unacked NOT recallable
status='delivered'                         acknowledged        NOT recallable
```

Acknowledgement would be the wrong line. A leased message was returned in a
response — the recipient has it, whether or not it survived to say so.

`GET /api/v1/outbox` returns exactly the first state, so a client never has to
interpret `leased_until` and the hub does not have to expose it. **The hub
judges; the client receives a list.**

### The list is a hint; the `DELETE` is the judgement

A recipient can call `POST /api/v1/inbox` between the list and the recall. So
the recall re-decides atomically rather than trusting what the list said:

```sql
DELETE FROM messages
 WHERE id = ? AND from_agent = ? AND status = 'pending' AND leased_until IS NULL
```

`changes` is the answer. `200 { recalled: true }`, or `409` with
`ALREADY_DELIVERED`.

This is the shape `create_only` took in § 10.1: a check followed by a write has
a window between them, and the window is where the defect lives.

### `GET /api/v1/capabilities` is unsigned, and not under `/inbox`

It moved out of `/inbox` because it does not describe an inbox. It describes
the deployment, and a socketless participant has no other way to learn it: a
hub advertises its limits in the `mesh.connect` result (§ 8.9.1, § 8.10), and
this population never connects. Every other client learns these values by
connecting; this one would learn them by guessing.

```json
{
  "mailbox": { "version": 1, "max_receive_batch": 200,
               "receive_lease_seconds": 300, "send_dedup_window_seconds": 86400 },
  "audit":   { "version": 1, "max_blob_bytes": 104857600,
               "max_attachments_per_event": 20, "upload_timeout_seconds": 180, "…": "…" },
  "surface": { "version": 1 }
}
```

**Unsigned**, deliberately. The values are most useful exactly when a caller
cannot yet sign: a client being set up needs the lease window and the dedup
window to size its retry loop, and its key is `pending` until an operator acts.
Requiring a signature would mean the one moment a client most needs these
numbers is the moment it cannot have them — so it would hardcode a guess, which
is the failure this route exists to prevent.

There is precedent in the same shape. `GET /api/v1/agents/{identity}/keys` is
unauthenticated (§ 9.2 †) because a holder has to be able to check its own
approval status before it can sign anything.

Nothing here is per-caller. It is deployment configuration, identical for every
reader, and a caller that can reach the port can already reach `/api/v1/rpc`.

**`audit` is included** for the same reason as `mailbox`: § 8.9.1 advertises
those caps at connect, and a socketless client that never connects has been
sizing its uploads against constants it imported. That is not hypothetical —
the hub once restated the audit limits from memory instead of importing them,
the values diverged, the client was fail-closed, and audit never started. Every
test passed, because they asserted the hub agreed with itself.

**Three versions, kept apart** — § 13 says they must not be conflated, and this
route is where the temptation is:

- `mailbox.version` — the transport contract: methods, params, error codes.
- `audit.version` — the audit protocol, unchanged from § 8.9.1.
- `surface.version` — this route table.

The last is separate because a route can be added or renamed while the methods
underneath do not move, and a client that gated the transport on a route-table
bump would refuse a hub that had only gained a route.

### A recall must be audited, or the trail lies by omission

Recall is the one place this surface deletes a row. That is not an exception to
"no deletion" — the message was never handed over, so there is no recipient
record to damage.

But there **is** already an audit record. `mesh.message.sent` is written when
the hub accepts the send, not when it hands it over (§ 8.9.4), so a recalled
message leaves an audit event saying it was sent and nothing saying it was
withdrawn. That is the same defect as the mailer's in a subtler place: the
sender ends up able to shape the record.

So a recall emits `mesh.message.recalled`, carrying the original `event_id` as
`causation_event_id`, with `recorded_by.kind = "hub"` and the sender's
`AgentMeshSig` as the attestation. The message body is not repeated — the
`sent` event already holds it, and audit retention is indefinite (§ 15.6), so
the pair reads as one story: sent, then withdrawn before anyone saw it.

Deleting the `messages` row rather than tombstoning it is deliberate. That
table is operational and rotates (§ 15.6); the audit copy is the permanent
record and is where the withdrawal belongs. A tombstone in `messages` would be
a second, weaker record of the same fact with a different retention policy.

## Operator surface — `agent-mesh-http`, admin JWT

Reads only, against a read-only handle.

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/api/v1/admin/inbox/{identity}` | What is queued for one identity: ids, senders, timestamps, sizes, and whether each is currently leased. **No message bodies.** |
| `GET` | `/api/v1/admin/inbox` | Depth per identity — the "who is backed up" view. |

Bodies are withheld for the same reason the audit query is admin-gated
separately from lane signing: reading someone's mail is a different
authorisation question from seeing that they have mail. An operator diagnosing
a stuck queue needs depth and age, not content; an operator who needs content
has the audit trail, where the access is itself recorded.

`leased` is reported here because an operator asking "why is this agent not
receiving" needs to distinguish an empty queue from one where every message is
held under a lease by a caller that died.

## Errors

The existing vocabulary, mapped onto status codes rather than replaced. The
JSON-RPC code stays in the body so a client that already branches on
`ERROR_CLASS` and `ERROR_DATA_CODE` keeps working.

```json
{ "ok": false, "error": "…", "code": "KEY_NOT_APPROVED", "rpc_code": -32014 }
```

| Condition | HTTP | `rpc_code` |
|-----------|------|-----------|
| Missing or malformed `Authorization` | `401` | `-32012` |
| (`/api/v1/capabilities` is exempt — it takes no `Authorization` at all) | — | — |
| Signature invalid, stale, or replayed | `401` | `-32012` |
| Key not approved | `403` | `-32014` |
| Not entitled | `403` | `-32013` |
| Unknown or soft-deleted identity | `404` | `-32011` |
| `client_message_id` reused with a different message | `409` | `-32015` |
| Malformed body | `400` | `-32602` |
| Store failure the hub cannot classify | `500` | `-32000` |

A status code alone cannot carry the retry policy — `403` is permanent for
`NOT_ENTITLED` and `wait-approval` for `KEY_NOT_APPROVED`. That is why the
`rpc_code` stays: it is what `ERROR_CLASS` is keyed on.

## Settled while drafting

- **No peek on the agent surface.** An agent has no use for a read that does
  not deliver, and the operator surface covers the case it was reaching for.
- **No separate `ack` route.** § 8.10.1 piggybacks acknowledgement on the next
  fetch; `{ ack_ids, limit: 0 }` is the end-of-turn settle, and the route is not
  named "fetch" so there is nothing misleading about it.
- **`inbox` and `outbox` stay separate.** One is mine and one is somebody
  else's; they differ in idempotency key, in what is checked, and in how they
  fail. `POST /api/v1/inbox` to send would read as posting to your own inbox.

## Open questions

1. **Does a deployment ever vary these values?** Today none does, so
   `/api/v1/capabilities` reports the constants a client could import instead.
   The route earns its place only if a deployment can differ — and if none ever
   can, the honest move is to delete the route and say in SPEC that the
   defaults are normative rather than advisory. Leaving it both ways is what
   produced the drift it exists to prevent.

2. **Does the operator surface belong on `/api/v1/admin/`?** It sits beside key
   approval and teardown, which is consistent. But those act on `agents.db`
   and this reads `hub.db`, and the admin prefix has so far meant "changes
   something". A read-only prefix may be worth having before it is the only
   one of its kind.

## Migration from the standalone mailer

The mailer stays until the mesh is deployed — that is a standing decision, not
something this proposal changes. When it moves, three things have to be true
first, and none of them is a route:

1. **Both agents hold approved keys.** The mailer needs no identity; this needs
   one, and approval is an operator step (§ 10.2).
2. **The delivery hooks sign.** They currently `POST` unsigned JSON to `:3300`.
3. **The record survives the move.** The mailer's history is the record of how
   the contract reached its current state. It does not transfer — the mesh
   inbox starts empty, and the audit copy of anything sent after the move lives
   in `audit.db` under `mesh.message.sent` with the sender's signature attached
   (§ 8.9.4), which is a stronger record than the mailer keeps.

The third is the one worth deciding before the second. Nothing here reads the
mailer's database.
