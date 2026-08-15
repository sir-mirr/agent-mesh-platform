# Response — Agent Mesh Hub audit ingestion interface

Platform-side reply to the mesh client team's audit ingestion proposal.

Status: **platform decisions settled; contract changes requested.** Nothing is
implemented yet.

The design is sound. Separating the data path from the audit path, addressing
blobs by content, keeping events immutable, and deriving the producing identity
from the connection rather than the payload are all the right calls, and the
last one in particular is the property the whole feature rests on.

The rest of this document is: what the platform will provide, what has to
change in the proposal, what has been added to its scope, and what it will not
do.

Everything here assumes **no migration of existing data**. Changes are written
as if each store starts empty.

---

## 1. Prerequisite: identities must be authenticable

The proposal derives `lane_id` from the connected identity (§ 8.3). That is
correct, but `mesh.connect` currently accepts an identity string and no
credential, so anything that can reach the hub port can record audit events as
any identity that happens to be offline. An audit log whose authorship can be
forged is not an audit log.

So the deferred authentication work is now part of this feature. The design is
in [`../decisions/identity-and-authentication.md`](../decisions/identity-and-authentication.md).
What it means for the client side:

- **Each adapter generates an Ed25519 key pair** and keeps the private half in
  its lane secret file. The public half is submitted at registration.
- **A key is not usable until an operator approves it.** Registration creates a
  pending key; approval happens on the http admin surface. Adapters must handle
  "registered but not yet approved" as a normal startup state.
- **The adapter logs its own key fingerprint at startup.** The operator
  compares it against the approval screen. Without that comparison the approval
  step is meaningless.
- **Every request is signed**, not just the connection. The signature is a
  sibling member of the JSON-RPC request object (`sig`), not a member of
  `params`.
- **Key rotation and revocation exist.** A leaked secret is revoked
  immediately, before any replacement is approved; the identity cannot connect
  or sign until a new key is approved.

---

## 2. Platform answers

### 2.1 Blob bytes stay with the http server

`PUT` goes to `agent-mesh-http` (`:3000`), which already owns `uploads/` and
serves `GET /api/v1/attachments/{id}`. The hub confirms a blob exists by
`stat`ing the file — both services run on the same core VM and already share
`AGENT_MESH_STATE_DIR`, so this needs no inter-service call, no shared secret,
and gives the hub no outbound dependency it does not have today.

### 2.2 The storage key keeps the file extension

```
<sha256>[.<ext>]
```

This is what `POST /api/v1/upload` already produces and already dedups on, and
the extension feeds the MIME inference the download route performs. Reusing it
keeps one namespace and needs no migration.

Two consequences:

- **`prepare_blobs` must carry enough to derive the key** — the filename, or
  the full key. `{sha256, size}` alone is not sufficient any more. The
  extension normalisation rule (lowercase, sanitise) has to be part of the
  contract so both sides compute the same key.
- **Dedup granularity is (hash, extension)**, not hash alone. The same bytes
  under two extensions are stored twice. § 16's "one blob per identical
  attachment" needs relaxing to match. This is existing platform behaviour, not
  a regression.

### 2.3 Upload authorisation is a signed nonce

The upload lands on http, but the identity is known only to the hub — a
different server over a different connection, and http's own authentication is
a browser session an adapter does not have.

```
① adapter ──WS──▶  hub    mesh.audit.prepare_blobs
② hub                     issues a nonce bound to (identity, sha256, size)
③ adapter ──HTTP─▶ http   PUT, Authorization: sign(nonce ‖ sha256 ‖ size)
④ http                    reads nonce and approved key from agents.db,
                          verifies, streams, hashes, stores
```

A hub-signed upload URL would only prove the URL came from the hub. A signature
proves the holder of the key made the request.

Binding the signature to `sha256` and `size` rather than to the nonce alone
means a leaked signature can only be replayed to upload the exact same bytes,
which dedups to a no-op. Replay protection is therefore free and the nonce
carries an expiry rather than one-time-use bookkeeping.

### 2.4 Audit gets its own database file

```
agents.db   identity, keys, key history
hub.db      messages
audit.db    audit_events + audit_event_blobs
uploads/    attachment bytes
```

Audit and message routing must not share a file. If they do, audit growth
filling the disk takes message routing down with it — a recording feature
killing the communication feature. Separate files can be mounted on separate
volumes.

The two audit tables stay together, because an event and its attachment
references must commit in one transaction. They do not need to sit with
`messages` to do that.

---

## 3. Requested contract changes

### 3.1 Remove `sequence`, and everything that hangs off it

Gap detection is not worth its cost. Requiring contiguity deadlocks a producer
permanently the first time an input is rejected locally — an oversized
attachment, for instance, consumes a number no later event can step over — and
it serialises delivery, so one slow attachment upload blocks everything behind
it.

With gap detection gone, `sequence` stops earning its place: `event_id` already
provides uniqueness (§ 8.3), causality is already explicit in
`causation_event_id`, and ordering comes free from a time-ordered `event_id` —
which the proposal's own example (`aud_0195f6…`) already looks like.

Please drop:

| | Reason |
|---|---|
| `sequence` | superseded by `event_id` |
| `AUDIT_SEQUENCE_CONFLICT` | nothing left to conflict |
| `mesh.audit.checkpoint` | the outbox already knows what is unacked; § 9's "resend the same `event_id`" recovery is sufficient on its own |
| `audit_producers` table | existed to hold `last_committed_sequence` |
| `blobs` table | the filesystem is that table — see 3.2 |

`producer_id` survives as a diagnostic label with no correctness role. Its
format is unconstrained; the hub treats it as opaque and caps it at 64
characters.

**Specify the `event_id` format.** `crypto.randomUUID()` is v4 and does not
sort. ULID, UUIDv7, or `<ms-hex>_<random-hex>` all work — pick one and put it
in the contract.

### 3.2 Remove the `blobs` table

Every column it holds is already in the filesystem: the hash is the filename,
`size` and `created_at` are `stat`, and the path is determined by the key rule.
The existing `POST /api/v1/upload` writes no database row at all.

`audit_event_blobs` stays, and is the one that cannot be derived — name and
MIME differ per event even for identical bytes, which the proposal's own § 14
already notes.

Orphan collection walks `uploads/`, keeps anything still referenced from
`audit_event_blobs`, and deletes the rest past a grace period. The grace period
matters because a blob uploaded but not yet committed is a normal state, not an
orphan.

### 3.3 Define both version fields, and give them the same type

They are different things with different lifetimes, so keep both:

| | Meaning | Lifetime |
|---|---|---|
| `capabilities.audit.version` | protocol — methods, params, error codes | the connection |
| `schema_version` | the shape of the event object | **stored on the row forever** |

Reading a two-year-old event requires knowing its shape; a connect-time
negotiated value cannot tell you that. Collapsing them loses the ability to
interpret stored data.

Rules:

- A client that does not recognise the advertised protocol version does not use
  audit. It does not guess.
- The hub validates `schema_version` ≤ its own maximum, and **rejects anything
  higher.** No data is lost: the outbox retries and drains once the hub is
  upgraded. Accepting an unvalidatable event would put "validated" in the audit
  record as a lie. The correct upgrade order is hub first.

Both are numbers. The proposal has `"1"` in one place and `1` in the other.

Note this is distinct from the SPEC document version, which SPEC § 13 declares
through `agentMeshSpec`. Three version concepts; do not conflate them.

### 3.4 Advertise limits, and reserve a busy signal

`capabilities.audit` is already the negotiation channel, so the limits belong
there:

```json
"capabilities": { "audit": {
  "version": 1,
  "max_blob_bytes": 104857600,
  "upload_timeout_seconds": 180,
  "content_addressing": "sha256",
  "max_attachments_per_event": 32,
  "max_attachments_bytes_per_event": 268435456,
  "max_inflight_appends": 4,
  "max_inflight_uploads": 2
}}
```

Backoff and jitter only spread out *reconnection*. Once connected, draining is
an unpaced loop, and after a long outage every lane drains at once — hitting
the hub exactly when it has just come back. The in-flight caps bound that per
connection.

Please also reserve, and handle from day one:

```json
{ "code": -32043, "message": "AUDIT_BUSY",
  "data": { "retry_after_ms": 5000 } }
```

The hub may never emit it initially. What matters is that adapters handle the
path from the first release — adding it later means every deployed adapter
mishandles it, on a path carrying audit data.

`max_attachments_per_event` also settles § 17's open "maximum attachments per
message". Without a cap, one `prepare_blobs` call is an unbounded number of
nonce writes.

### 3.5 Classify errors as permanent or transient

§ 13 sets no maximum retry count, so an event that will never be accepted
retries forever. The classification has to be in the contract, not left to each
implementation:

**Permanent — drop, record locally, never retry**
```
attachment count over cap
blob over max_blob_bytes
malformed params
AUDIT_EVENT_CONFLICT        same event_id, different payload — a bug
```

**Transient — retry**
```
AUDIT_MISSING_BLOBS         upload, then retry
AUDIT_BUSY                  wait retry_after_ms
schema_version too high     resolves when the hub is upgraded
connection failure, 503
```

§ 13 already does this for oversized attachments ("reject the input and record
an auditable local error"); it just needs extending to every permanent case.

### 3.6 `payload_digest` is over the received bytes

The proposal requires a digest but never says how to compute one. JSON has no
canonical byte form — key order, number formatting, unicode escaping and
whitespace all vary — so producer and hub can disagree even when the content is
identical, and a legitimate retry gets rejected as a conflict. That breaks
at-least-once delivery directly.

**The digest is over the received bytes of `params`, verbatim.** No
canonicalisation scheme, no RFC 8785 dependency on either side. The adapter's
outbox **stores the serialised string, not the object**, and a retry re-sends
that same string. Adapter and hub are connected directly over a WebSocket, so
nothing between them re-serialises anything.

The scope is `params`, not the whole request: the JSON-RPC `id` changes on
every retry, so digesting the envelope would make each retry look like a
different event.

The same bytes are what a signature covers, so one rule serves both.

Files are never digested or signed directly. Their hashes are in the event, and
the event's signature covers them transitively — so a signature stays 64 bytes
regardless of attachment size, and a changed file breaks it.

### 3.7 `lane_id` → `identity`

`lane` and `identity` are not synonyms here. An identity is the agent on the
mesh; a lane is a deployment unit — a systemd instance with its own env and
paths. Audit events describe the former.

The proposal's own § 8.3 already says the hub derives the value from the
connected identity, so the field name was lagging its meaning.

Deployment artifacts keep `lane`: unit names and paths exist on deployed hosts,
and renaming them breaks live systems.

---

## 4. Added scope

### 4.1 Mesh messages are audited too, and the hub produces those events

The proposal covers channel traffic only, on the assumption that mesh traffic is
already recorded because it flows through the hub. It is — in `hub.db:messages`
— but that is an operational store for delivery and history, not an audit
record.

Mesh messages must appear in the audit stream as well. **The hub produces these
events itself**, at routing time. An adapter producing them would mean both
sender and receiver reporting the same message, and the hub sees all of it
anyway.

New event types under a `mesh.*` namespace:

```
mesh.message.sent
mesh.message.delivered
mesh.message.pending
```

§ 10's decision to keep `event_type` an open namespace rather than a closed
enum is what makes this cost nothing in protocol version.

Message bodies are duplicated into `audit_events` rather than referenced from
`messages`, so that audit retention and operational retention are independent
clocks. Attachment **bytes** are not duplicated — content addressing means one
file in `uploads/` however many events reference it.

### 4.2 Records carry their subject and their recorder separately

These are different, and the difference is evidentiary:

```json
"identity":    "agent-a",
"recorded_by": { "kind": "hub" | "adapter", "identity": "hub" }
```

For a channel event the two are the same — an adapter reporting its own
activity, which is self-attestation. For a mesh event the subject is the
sending agent and the recorder is the hub, which is third-party observation.

Today `channel.*` implies an adapter and `mesh.*` implies the hub, but that
correspondence is a coincidence, not a rule. **Trust level must be a field, not
something derived by prefix-matching a string.**

Attestation follows the recorder:

```json
"attestation": {
  "signed_by": "agent-a",
  "kid":       "<fingerprint>",
  "alg":       "ed25519",
  "value":     "<base64url>",
  "covers":    "audit.params" | "mesh.send.params"
}
```

| Event | `signed_by` | `covers` |
|---|---|---|
| channel, adapter-produced | the adapter's identity | `audit.params` |
| mesh, hub-produced | **the sending agent** | `mesh.send.params` |

`covers` is required because a later verifier has to know which bytes to hash.
A mesh event's signature covers the original `mesh.send` request, not the audit
event body — so those original bytes are retained verbatim in the event.

The result is that mesh audit carries **more** evidentiary weight than channel
audit: channel events are an adapter's word for it, while mesh events carry the
sender's own signature.

---

## 5. Limits to state plainly

These are properties of the design, not defects, but they must not be
misrepresented downstream.

- **Loss is undetectable.** With `sequence` gone there is no gap detection. An
  adapter whose outbox is lost never reports what it lost, and the hub cannot
  tell. The audit trail is a record of **what was collected**, not a guarantee
  of completeness, and must not be described as complete or tamper-proof.
- **Dedup is per (hash, extension).** Identical bytes under different
  extensions are stored twice.
- **Audit retention is undecided.** Everything else in § 17 now has an answer;
  how long audit events are kept does not, and it is a policy question rather
  than a technical one. Until it is set, storage growth is unbounded, and on a
  single-VM deployment a full disk stops message routing, not just audit.

---

## 6. hub-direct forwarding is removed, not demoted

§ 15.1 proposes keeping hub-direct forwarding as a migration compatibility
mode. It is being removed outright instead, and SPEC § 6.1 drops to a single
forwarding mode.

In hub-direct mode the channel driver opens its own hub connection and
`mesh.send`s inbound channel traffic, and the runtime picks it up from the hub.
The adapter is not in the path at all:

```
Discord driver ──WS──▶ hub ──WS──▶ claude adapter ──stdio MCP──▶ Claude Code
                        ▲
              the hub is the channel↔runtime transport
```

That contradicts the proposal's own premise twice over. § 1 puts the hub out of
the channel real-time path for latency, and this mode puts it back in. And with
no adapter in the path there is no outbox, so channel traffic has nowhere to be
recorded.

Removing it means **channel audit applies everywhere** rather than being a
property of one of two modes — the coverage gap this document would otherwise
have had to declare disappears.

The cost is that Claude lanes, which run this way today, need an adapter before
they work again. That is acceptable here: migrating existing deployments is
already out of scope, and the work lands in the lane repository regardless.

**Building the Claude adapter is client-side work.** The in-tree Claude adapter
is a stdio MCP server and hub client with no HTTP ingress, so the target
architecture needs one built. The runtime adapters are leaving this repository;
the platform's part is the SPEC change, and it is neither blocking nor
scheduling the rest.

---

## 7. SPEC sections affected

| Section | Change |
|---|---|
| § 3.1 | hub storage is no longer a single `hub.db` file |
| § 4.1 | a Claude lane gains a runtime-adapter; it is no longer driver-only |
| § 6.1 | hub-direct forwarding removed — adapter mode is the only mode |
| § 8 | new `mesh.audit.*` methods; `mesh.connect` capabilities and signature |
| § 9.1 | blob `PUT`, audit query API |
| § 9.4 | host split table gains the new routes |
| § 10.1 | `POST /api/v1/agents` accepts `public_key`; approval procedure |
| § 13 | whether a § 8 addition is a minor version |
| § 15.1 | storage authority wording |
| § 15.2 | blob key retains the extension |

---

## 8. Round two — answers to the client revision's § 16

The client revision raised three items as blocking. **All three were real, and
all three were defects in the documents above rather than disagreements.** They
are fixed; SPEC 0.2 carries the corrected contract.

### 8.1 Signature preimage — accepted, and the fix is theirs

The objection: § 3.6 above signs the raw `params` bytes and nothing else, while
claiming `sig.nonce` and `sig.iat` bound replay. Those fields sit outside the
signature, so a captured signature can be replayed with a fresh nonce, or
reused against a different method that accepts the same parameter shape.

Correct, and the cause is identifiable: § 3.6 argued that one rule could serve
both the idempotency digest and the signature. That reasoning holds for the
digest — which only ever needs to identify an event — and fails for the
signature, which has to authenticate a request. Sharing an input is not the
same as sharing a computation.

SPEC § 8.1 now specifies:

```
LP(x)    = uint32be(byteLength(x)) ‖ x

preimage = "agent-mesh/sig/v1" ‖ 0x00
         ‖ LP(method) ‖ LP(kid) ‖ LP(nonce) ‖ LP(decimal(iat))
         ‖ LP(raw params bytes)
```

Length prefixes over CBOR: the boundaries are just as unambiguous, and it is
implementable in any language without a dependency. `id` stays out because it
changes between retries; `sig` stays out because it carries the result.

`payload_digest` remains `SHA-256(raw params bytes)`, exactly as the revision
describes. The two computations share that input and nothing else.

Freshness is **±120 seconds**, with a seen-nonce set retained for the width of
the window. Both belong in the fixtures.

### 8.2 The `sequence` inconsistency — accepted

`identity-and-authentication.md` was written before the decision to drop
`sequence` and still carried it in two places: a replay clause referring to
`(producer_id, sequence)`, and a whole section defining uniqueness semantics
for it. § 3.1 above was the newer decision and the revision was right to follow
it.

Both are corrected. SPEC never adopted `sequence`, so it needed no change.

### 8.3 Revoked-key cache invalidation — accepted, and the cache is gone

The objection: keys are cached for the life of a connection, so a revoked key
keeps working on any connection already open, which makes "immediate
revocation" untrue.

Correct. Rather than add an invalidation mechanism, **the cache is removed.**
The hub reads the identity's current key state on every request.

Measured on this tree:

| | |
|---|---|
| read the key row from `agents.db` | ~1.7 µs |
| `PRAGMA data_version` probe (what invalidation would cost) | ~2.2 µs |
| Ed25519 verification of one request | ~32 µs |

The cache was protecting against something cheaper than the check that would
have kept it correct, and an order of magnitude below the verification it sits
next to. WAL readers do not block and key writes are rare, so there is no
contention argument for it either.

Revocation is therefore effective at an identity's **next request**, with no
notification path between the services and no invalidation bookkeeping. A
request from an identity whose key is `pending`, `denied` or `revoked` is
rejected with the new `-32014` KEY_NOT_APPROVED, which carries `key_status` so
a client can tell waiting-for-approval from revoked. The hub closes any
connection it holds for that identity on observing the state.

Rotation follows the same rule: once the replacement is approved, the previous
key stops verifying at the next request. Clients reconnect with the new key and
MUST NOT fall back to the old one.

### 8.4 Also fixed, unprompted

The revision's § 9.1 states that `identity`, `recorded_by`, `attestation` and
`payload_digest` are hub-constructed rather than client-supplied. That is
right, and SPEC § 8.9.3 contradicted it — those fields appeared in the request
schema while the surrounding prose said the hub derives them. The request
schema no longer carries them, and the section says plainly that a client
sending them has them ignored.

### 8.5 Accepted from the revision without change

- **`prepare_blobs` returns `blob_key`.** Better than deriving it on both
  sides — two implementations of one normalisation rule are two chances to
  disagree, and a disagreement splits one blob into two. The hub is
  authoritative; clients use what it returns. The upload nonce binds to
  `(identity, blob_key, size)` accordingly.
- **`audit_event_blobs` keyed by `(event_id, ordinal)`.** Cleaner than
  including the digest, and it preserves referencing the same blob twice in one
  event.
- **Permanent errors go to a local dead-letter, not to `/dev/null`.** "Drop"
  in § 3.5 above meant "stop retrying", and the revision's reading is the
  better one: quarantine the payload and its blobs, alert, and let a local
  retention policy decide the rest. Discarding audit material to handle an
  audit error is the wrong instinct.
- **UUIDv7 with an `aud_` prefix**, monotonic within a millisecond where the
  generator allows. Ordering is a query convenience and not a completeness or
  causality claim — `causation_event_id` carries causality.
- **Per-lane jitter on drain**, on top of the negotiated in-flight caps.
- **Unadvertised capabilities mean incompatible**, never assumed defaults.

### 8.6 Retention: indefinite

Audit events are **never expired**, and neither are the blobs they reference.
That is now a decision rather than an unset value, and it closes § 16.5's first
two items.

Three things follow.

**`hub.db:messages` should rotate, and now safely can.** The audit copy is the
permanent record, so the operational store only has to outlive delivery and
`mesh.fetch_messages`. Keeping both indefinitely stores every message body
twice for nothing. The period is still a deployment choice, but it is a small
one now.

**Orphan collection shrinks to almost nothing.** With events kept forever,
references are never released, so the only collectable blob is one no event
ever referenced — bytes uploaded whose `append` never arrived. Everything else
in the sweep was there to reclaim space behind expiring events, and there are
none.

**Capacity becomes an operational contract rather than a retention one.** The
disk fills eventually; the question is what happens then. SPEC § 15.6 now
requires that routing survive it: on exhaustion the hub keeps routing and
rejects audit writes with the new `-32044` AUDIT_STORAGE_EXHAUSTED, a
**transient** error, so adapters hold events in their outboxes and lanes fail
closed on their own local limits if it persists. Audit availability degrades
before message delivery does, never the reverse.

`-32044` is deliberately separate from `-32043` AUDIT_BUSY. Both say back off;
one clears itself and the other needs an operator, and a client that cannot
tell them apart will report the wrong thing.

The revision's point about volumes is adopted: separating `audit.db` from
`hub.db` removes schema and lock coupling but not shared free space. `audit.db`
and `uploads/` belong on their own volume, with soft and hard thresholds
alerting well before exhaustion — recovery here means adding capacity, not
deleting.

Client-local retention after ACK stays a client decision. With the hub keeping
everything, a completed outbox entry has no reason to persist locally.

### 8.7 Still open

**The contract package (§ 16.4) has no home yet.** The npm scope and package
name are undecided, and nothing is published. The fixtures listed there are the
right list; they need somewhere to live before either side can test against
them.
