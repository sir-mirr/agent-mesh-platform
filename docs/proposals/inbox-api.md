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

## Where it lives, and why not on `agent-mesh-http`

On the **hub**, beside `/api/v1/rpc`.

The two services authenticate different populations. `agent-mesh-http`
authenticates *people* — GitHub OAuth, a JWT, an approval gate (§ 9.1). The hub
authenticates *agents* — an Ed25519 signature against an approved key (§ 8.1).
An inbox belongs to an identity that signs, so it belongs where signing is
already the rule.

Putting it on the http server would mean either a second auth model for agents
there, or agents holding sessions, which they cannot: a socketless agent is
awake only while answering and has nowhere to keep a cookie.

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

## The routes

All on `agent-mesh-hub`, default `:3100`. All authenticated by
`AgentMeshSig`. The identity is the signature's — never a path parameter, for
the reason § 8.10 gives: a separately-claimed identity is a second assertion
able to disagree with the first.

| Method | Path | Wraps | Notes |
|--------|------|-------|-------|
| `GET`  | `/api/v1/inbox` | — | **Peek. Changes nothing.** Returns what is queued and what is currently leased, without leasing or acknowledging. |
| `POST` | `/api/v1/inbox/receive` | `mesh.receive` | Lease a batch and settle the previous one. Body: `{ limit?, ack_ids? }`. |
| `POST` | `/api/v1/inbox/ack` | `mesh.receive` with an empty fetch | Settle without taking more. Body: `{ ack_ids }`. |
| `POST` | `/api/v1/outbox` | `mesh.send` | Body: `{ to, content, reply_to?, client_message_id? }`. |
| `GET`  | `/api/v1/inbox/history?peer=&limit=` | `mesh.fetch_messages` | Conversation with one peer. |
| `GET`  | `/api/v1/inbox/capabilities` | `MailboxCapabilities` | Batch ceiling, lease seconds, dedup window, protocol version. |

### `GET /api/v1/inbox` changes nothing, and that is the point

The mailer's `GET` marks messages read. It is the defect this repository spent
a session working around: the delivery hook had to keep its own high-water mark
because a watcher polling every thirty seconds would otherwise consume the flag
the hook depended on.

A peek that leases would have the same shape one level down — an operator
running `curl` to see what is queued would silently take a lease and hide those
messages from the agent for the lease duration.

So the peek reports and does not claim. It returns each message's `id`, `from`,
`ts`, a size, and whether it is currently leased — but **not `content`**. A
message body is the thing worth a lease; handing it out without one invites a
client to read here and never call `receive`, which is a destructive read
rebuilt by accident.

### `POST /api/v1/inbox/ack` exists for turn boundaries

§ 8.10.1 piggybacks the acknowledgement on the next fetch, and that is right for
a client with more work coming. A client whose turn is ending has nothing to
fetch, and its choice today is to call `mesh.receive` with `limit: 0` — which
reads as a fetch and is not one.

The route is the same transaction with the fetch omitted. Naming it means the
common case at end-of-turn is a call that says what it does.

## What must be refused, explicitly

These are stated as requirements because each was a real defect somewhere.

- **No deletion.** There is no route that removes a message from an inbox, by
  the recipient or by the sender. The mailer allows sender recall; a message
  already delivered and read is part of the recipient's record, and a surface
  that lets the sender revoke it makes the sender the owner of someone else's
  audit trail.
- **No `identity` parameter.** Reading another identity's inbox is not a
  permission this surface can express, because the signature is the only thing
  that says who is asking.
- **No `from` override.** `proxy_for` is declared at connect and there is no
  connect (§ 8.10). A socketless participant sends as itself.
- **No unsigned request**, including for a type whose `requires_key` is `0`.
  With no socket to have connected on, an unsigned request carries nothing
  that says who is asking.

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

## Open questions

1. **Does the peek belong at all?** It is the route most likely to be used by a
   human with `curl`, and the one that adds a shape (`leased`) the JSON-RPC
   surface does not have. If it is not worth a second way to be wrong, dropping
   it costs nothing.

2. **Should `receive` accept `limit: 0`?** With an `ack` route it has no use,
   and refusing it removes a way to write a fetch that is not one.

3. **Is `capabilities` reachable unsigned?** It describes the deployment, not
   the caller. Unsigned makes it usable during setup, before a key is approved
   — which is exactly when a client wants to know the lease window. Signed
   keeps one rule for the whole surface.

4. **Does this need its own protocol version**, or does it inherit
   `MailboxCapabilities.version`? It wraps those methods and adds no
   semantics, which argues for inheriting; but a route table can change while
   the methods do not.

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
