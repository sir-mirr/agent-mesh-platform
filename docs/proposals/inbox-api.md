# Proposal — a named inbox surface over the socketless transport

Status: proposal. Nothing below is built.

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
| `GET`  | `/api/v1/inbox/capabilities` | `MailboxCapabilities` | Batch ceiling, lease seconds, dedup window, version. |

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

1. **Is `capabilities` worth a route today?** Nothing currently overrides
   `MAILBOX_CAPABILITY_DEFAULTS`, so it would report the constant a client can
   already import. The argument for it is narrower than "someday": the audit
   surface advertises its capabilities at `mesh.connect` (§ 8.9.1) and a
   socketless participant has no connect, so it is the one population with no
   way to learn a deployment's real values. The argument against is that a
   route nobody varies is a route that will be assumed constant anyway.

   This matters because getting it wrong already happened here — the hub's
   audit limits were restated from memory instead of imported, the client was
   fail-closed, and audit never started. Every test passed, because they
   asserted the hub agreed with itself.

2. **Does this need its own protocol version**, or does it inherit
   `MailboxCapabilities.version`? It wraps those methods and adds no semantics,
   which argues for inheriting; but a route table can change while the methods
   do not.

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
