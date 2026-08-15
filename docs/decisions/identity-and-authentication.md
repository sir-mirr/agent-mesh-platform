# Identity and authentication — settled design

Status: **decided, not implemented.** This is the design the implementation
should follow. Items still open are in [`../open-questions.md`](../open-questions.md).

This design was settled while reviewing the mesh client team's audit ingestion
proposal. That review forced the identity question: an audit log whose
authorship cannot be verified is not an audit log, so the deferred
authentication work stopped being deferrable.

---

## 0. Migrating existing data is out of scope

Nothing here carries old data forward. The changes are written as if the store
starts empty: new columns, new files, new tables, no backfill and no
compatibility shims for rows written by earlier builds. An operator upgrading
an existing deployment starts fresh.

(The one migration this repository does perform — `registry.json` into
`agent_registry` — predates this decision and is already implemented.)

## 1. Storage layout

Identity and audit data each move out of `hub.db` into their own files.

```
${AGENT_MESH_STATE_DIR}/
├── agents.db          identity, keys,        hub: rw   http: rw
│                      key history
├── hub.db             messages               hub: rw   http: ro
├── audit.db           audit events and       hub: rw   http: ro
│                      their attachment refs
├── agent-mesh.db      users, policies,       http only
│                      agent_registry, push
└── uploads/           attachment bytes       http: w   hub: r (stat only)
```

Four reasons for the split:

- **Audit growth must not stop message routing.** Sharing one file means a
  filling disk takes `messages` down with the audit tables — a recording
  feature killing the communication feature. Separate files can be mounted on
  separate volumes.
- Retention differs per store. Identity is small and permanent; messages are
  operational and short-lived; audit events are long-lived. Separate files let
  each have its own backup, retention and `VACUUM` policy.
- Neither service ends up writing into a database the other "owns". Both are
  equal participants in `agents.db`.
- Nothing joins `agents` to `messages`. The only query spanning both was the
  identity teardown, and § 3 removes that.

`audit_events` and `audit_event_blobs` stay together in `audit.db` because the
audit contract requires an event and its attachment references to commit in one
transaction. They do not need to sit with `messages` to do that.

Both processes open `agents.db` read-write. SQLite handles this: both already
set `journal_mode = WAL` and `busy_timeout = 5000`, writes serialise, and
SPEC § 14.1 pins hub and http to the same core VM so the file is always local.
**The hub owns the DDL** — it creates the tables at boot, and http assumes they
exist. Hub starting first is the normal order anyway, since http is a
WebSocket client of the hub.

### Identity is not a name

`agents.identity` is the unique, permanent key. It carries no display name —
the table is `(identity, description, type, created_at, last_seen)`.

Human-readable names live in `agent_registry` (`agent-mesh.db`), which is
http's presentation concern and stays there. Names may repeat and change
freely. **Only `identity` is subject to the uniqueness and no-reuse rules
below.**

---

## 2. Key lifecycle

```sql
CREATE TABLE agent_keys (
  fingerprint TEXT PRIMARY KEY,   -- sha256(public_key), shown to the operator
  identity    TEXT NOT NULL,
  public_key  TEXT NOT NULL,      -- Ed25519 raw 32B, base64url (43 chars)
  status      TEXT NOT NULL,      -- pending | approved | denied | revoked
  proposed_at DATETIME,
  decided_at  DATETIME,
  decided_by  TEXT
);
CREATE UNIQUE INDEX ux_agent_keys_pending
  ON agent_keys(identity) WHERE status = 'pending';
CREATE UNIQUE INDEX ux_agent_keys_approved
  ON agent_keys(identity) WHERE status = 'approved';
```

```
none ──propose (anyone)──▶ pending ──approve (operator)──▶ approved
                              └─────deny (operator)─────▶ denied
approved ──rotation proposal──▶ pending ──approve──▶ old key revoked
```

**A proposal must never modify an approved key.** The partial unique indexes
enforce at most one pending and one approved key per identity. Re-proposing a
key that already exists returns its current status and changes nothing — an
adapter restarting must not knock its own approved key back to pending. A
different key while one is already pending replaces the pending row, so a
restart loop cannot flood the queue.

Ed25519 is the algorithm. It is available in Bun through `node:crypto` with no
dependency, keys are 43 characters as base64url, signatures are 64 bytes, and
verification measured ~32 µs for a small message and ~39 µs for a 6 KB audit
event — around 26–31k verifications per second on one core, which is orders of
magnitude above the hub's traffic. Cost is not a consideration.

### Key changes are themselves audited

A leaked secret has to be revocable, and a revocation has to be a matter of
record.

```sql
CREATE TABLE agent_key_events (
  id          TEXT PRIMARY KEY,   -- time-ordered id
  identity    TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  action      TEXT NOT NULL,      -- proposed | approved | denied | revoked
  reason      TEXT,               -- compromise | rotation | teardown | ...
  actor       TEXT,               -- approving admin login, 'hub', 'system'
  occurred_at DATETIME NOT NULL
);
```

Append-only, and deliberately **not** part of `audit_events`: it lives beside
`agent_keys` in `agents.db` so a key change and its record commit together,
its retention is permanent where message audit rotates, and the writer is http,
which already holds the handle.

**Revocation is a status change, never a delete.** Key rows survive so past
signatures stay verifiable — the whole reason § 3 makes teardown a soft delete.
What the history adds is the timeline needed to judge them:

```
2026-08-01  approved  fingerprint=abc…
2026-08-15  revoked   reason=compromise
```

A verifier can then treat signatures before the revocation as sound and ones
after it as suspect. That is what `reason` is for — a routine `rotation` says
nothing about earlier signatures, while `compromise` casts doubt on the window
around it.

Revocation must not wait for a replacement to be approved. After it the
identity can neither connect nor sign until a new key is approved, which is the
correct fail-closed behaviour for a leak. Two paths: the operator revokes from
the http admin surface, or the holder submits a self-revocation signed by the
key being revoked — the fastest route when you still hold a key you know has
leaked.

### Why a public key rather than a token

A leaked `hub.db` cannot be used to impersonate anyone, because the hub never
holds a secret capable of it. In a cross-VM deployment the private half never
leaves the lane VM — only the public half travels, which removes the token
distribution problem SPEC § 14.2 cited as a reason for having no per-lane
credential at all.

### Fingerprint verification is part of the procedure

The operator approving a key must be able to tell whether it really belongs to
that identity. The lane logs its own fingerprint at startup and the operator
compares it against the approval screen. Without this step approval is
rubber-stamping — the same problem as blindly accepting an SSH host key.

### Approval happens on http

The hub has no authentication of any kind. An approval endpoint there would let
anyone approve their own pending key, which makes the procedure theatre. The
only place a human already authenticates is http:3000 — GitHub OAuth, JWT, and
a working `payload.role !== 'admin'` gate on `/api/v1/admin/*`. Approval reuses
it. That is why http holds a read-write handle on `agents.db`.

Key proposals arrive at the hub, since `POST /api/v1/agents` is the SSOT for
identity provisioning (SPEC § 10.1) and the adapter should register in one
call. The hub writes the pending row directly.

---

## 3. Identity teardown is a soft delete

```sql
ALTER TABLE agents ADD COLUMN deleted_at DATETIME;   -- NULL = live
```

`DELETE /api/agents/{identity}` sets `deleted_at`, marks the identity's keys
`revoked`, and **does not touch `messages`**.

Hard deletion is incompatible with two decisions made here:

- **Signatures need their keys.** Messages are signed (§ 4). Deleting an
  identity and its key makes every historical signature permanently
  unverifiable — the audit trail loses the property the signing was for.
- **Identity reuse is silent corruption.** Freeing the string lets a later
  registration inherit the previous holder's message and audit history.

Reuse is therefore **blocked**: a soft-deleted identity cannot be
re-registered. Identity strings are not scarce, and an operator who genuinely
needs one back can purge it with an offline tool. Physical purging lives
outside the request path and belongs to the retention policy, which is still
open.

This also removes the cross-database transaction the earlier layout would have
needed. Teardown now touches `agents.db` only, so it is a single-file
transaction. (Verified: SQLite does execute a transaction across `ATTACH`ed
databases, but does not guarantee atomic commit across them in WAL mode.)

### Contract change

`messages_removed` no longer describes anything. SPEC § 9.3 needs the new
shape:

```json
{ "ok": true, "identity": "agent-a",
  "action": "soft-deleted" | "not-found" | "already-deleted",
  "deleted_at": "2026-08-15T05:00:00Z" }
```

### Every read of `agents` needs the filter

`WHERE deleted_at IS NULL` must be added to each of these, or a deleted
identity keeps working:

| Site | Effect if missed |
|---|---|
| `stmtAgentExists` (`mesh.connect` pre-registration check) | deleted identity can connect |
| `stmtListAgents` (`mesh.list_agents`) | deleted identity still listed |
| `stmtSelectAgent` | stale reads |
| `stmtUpsertAgent` / `stmtUpsertAgentTyped` | deleted identity silently revived |
| `mesh.send` recipient check | messages queued for a dead identity |

---

## 4. Signing is per message, not per connection

The client signs every request it sends; the server verifies. Connection-time
authentication alone would leave every message after the handshake unattributed.

This settles three previously separate problems at once: `proxy_for`
entitlement and the `mesh.send` `from` override both gain something to bind a
check to, and audit events become non-repudiable at the point of production
rather than merely recorded at the point of ingest.

The signature travels as a sibling member of the JSON-RPC request object.
JSON-RPC has no header slot, and putting it in `params` would pollute every
method's schema:

```json
{ "jsonrpc": "2.0", "id": 1, "method": "mesh.send", "params": { },
  "sig": { "alg": "ed25519", "kid": "<fingerprint>",
           "nonce": "...", "iat": 1755230000, "value": "<base64url>" } }
```

**Key state is read per request, not cached.** An earlier draft cached the
approved key for the life of the connection. That made revocation ineffective
against connections already open — the one case revocation exists for. The
measurements say the cache was never worth it anyway: reading the key row costs
~1.7 µs against ~32 µs for the Ed25519 verification it feeds, and is cheaper
than the `PRAGMA data_version` probe a cache-invalidation scheme would need on
the same path. WAL readers do not block, and key writes are rare.

Replay is prevented by `nonce` plus an `iat` freshness window (±120 s), with a
seen-nonce set kept for the width of that window.

### What exactly is signed

**The signature covers a domain-separated, length-prefixed encoding of
`(protocol version, method, kid, nonce, iat, raw params bytes)`** — not the
`params` bytes alone.

An earlier draft signed only `params`, on the reasoning that one rule could
serve both the signature and the idempotency digest. It cannot: signing only
`params` leaves `method`, `nonce` and `iat` unauthenticated, so a captured
signature can be replayed with a fresh nonce, or reused against a different
method that accepts the same parameter shape. The client team caught this
before implementation.

The two computations share the raw `params` bytes and nothing else. The digest
identifies an event for idempotency; the signature authenticates a request.
SPEC § 8.1 carries the exact encoding.

`params` still enters as the **received bytes, verbatim**. No canonicalisation
scheme.

JSON has no canonical byte form — key order, number formatting, unicode
escaping and whitespace all vary — so a digest computed from a re-serialised
object can differ between producer and hub even when the content is identical.
That would reject legitimate retries as conflicts and break at-least-once
delivery.

Signing the received bytes avoids the problem entirely. The adapter's outbox
**stores the serialised string, not the object**, and a retry re-sends that
same string. Adapter and hub are connected directly over a WebSocket, so
nothing between them re-serialises anything. This removes an RFC 8785 (JCS)
dependency from both sides.

The scope is `params`, not the whole request: the JSON-RPC `id` changes on
every retry, so digesting the envelope would make each retry look like a
different event.

The audit proposal's `payload_digest` uses this same rule, so one definition
serves both.

### Files are covered by reference, never signed directly

```
file bytes ──sha256──▶ hash ──▶ event's attachments[].sha256 ──▶ covered by the event signature
```

Signatures stay 64 bytes regardless of file size, and a changed file changes
its hash and breaks the signature transitively. File integrity itself is
already handled by content addressing: the hash is in the upload URL and the
server recomputes it while streaming.

---

## 5. Attachment upload

**http owns the bytes.** `POST /api/v1/upload` (existing, browser multipart)
and the new machine `PUT` both write to `uploads/`, and downloads keep using
`GET /api/v1/attachments/{id}`. The hub confirms a blob exists by `stat`ing the
file — both processes are on the same core VM and already share `STATE_DIR`,
so this needs no IPC, no shared secret, and gives the hub no outbound
dependency.

### Storage key keeps the extension

```
<sha256>[.<ext>]        matching the existing SHA256_ID_RE
```

This is what `POST /api/v1/upload` already produces, and it already dedups on
that key. Reusing it keeps one namespace and needs no migration. The extension
also feeds the existing `getMimeType()` used by the download route.

Consequence: dedup granularity is (hash, extension), not hash alone — the same
bytes arriving under two different extensions are stored twice. This matches
existing platform behaviour rather than regressing it, but the client
proposal's "one blob per identical attachment" wording has to be relaxed to
match.

Since the key is no longer the bare hash, `mesh.audit.prepare_blobs` must carry
enough to derive it (the filename, or the full key). The extension
normalisation rule — lowercase, sanitise — has to be part of the contract so
both sides compute the same key.

### Upload authorisation: a nonce signed by the uploader

The upload goes to http, but the identity is only known to the hub — different
server, different connection, and http's own authentication is a browser
session an adapter does not have.

```
① adapter ──WS──▶  hub    mesh.audit.prepare_blobs
② hub                     issues a nonce, records it in agents.db
③ adapter ──HTTP─▶ http   PUT, Authorization: sign(nonce ‖ sha256 ‖ size)
④ http                    reads the nonce and the approved key from agents.db,
                          verifies, streams, hashes, stores
```

A hub-signed upload URL would only prove the URL came from the hub. A
signature proves the holder of the key made the request, which is strictly
stronger — and since http can read `agents.db` directly, it needs no shared
secret with the hub.

Binding the signature to `sha256` and `size` rather than the nonce alone means
a leaked signature can only be replayed to upload the exact same bytes, which
dedups to a no-op. Replay protection is therefore free, and the nonce needs
only an expiry rather than one-time-use bookkeeping.

---

## 6. Audit events have no sequence number

An intermediate draft of this document kept a per-producer `sequence`, first
requiring contiguity and then relaxing to uniqueness. Both are superseded:
**`sequence` is gone entirely**, along with `AUDIT_SEQUENCE_CONFLICT`,
`mesh.audit.checkpoint` and the `audit_producers` table.

Contiguity was rejected first. An input rejected locally — an attachment over
the size cap, say — leaves a permanent gap that no later event can step over,
stalling that producer's audit forever, and it serialises delivery so one slow
attachment blocks everything behind it.

Once gap detection was gone, nothing was left for the number to do. `event_id`
already carries uniqueness, `causation_event_id` already carries causality, and
ordering comes free from `event_id` being time-ordered. Recovery after a lost
ACK is re-sending the same `event_id`, which the outbox can already do without
asking the hub where it got to.

`producer_id` survives as a diagnostic label with no role in correctness.

The accepted cost: an adapter whose outbox is lost never reports the events it
lost, and the hub cannot tell. **The audit trail is a record of what was
collected, not a guarantee of completeness**, and must not be described as
tamper-proof or complete.

---

## 7. Terminology

`lane` and `identity` are not synonyms and the split is deliberate.

| Meaning | Word | Examples |
|---|---|---|
| The agent on the mesh | **identity** | audit event fields, `mesh.connect`, `agents.identity` |
| The deployment unit | **lane** | `agent-mesh-lane@<id>.target`, `/etc/agent-mesh/lane/`, `LANE_*` |

The audit proposal's `lane_id` becomes `identity` — its own § 8.3 already says
the hub derives it from the connected identity, so the field name was simply
lagging its meaning.

Deployment artifacts keep `lane`: unit names and paths exist on deployed hosts
and renaming them breaks live systems, and "lane" is the accurate word for a
systemd instance. `LANE_IDENTITY` — the lane's identity — is already the
correct pairing of the two.

Most remaining `lane` usage in code sits in the runtime-adapter and
channel-driver packages, which are leaving this repository. Their vocabulary is
the lane repository's decision.

---

## 8. Staging

```
now     agents.db, agent_keys and agent_key_events with the approval
        procedure, soft delete, upload nonce verification
next    signature verification on mesh.connect, then per-message
        → proxy_for entitlement and the `from` override gain enforcement
```

Nothing in the first stage is discarded by the second.

The audit interface decisions that came out of the same review are in
[`../proposals/audit-ingestion-response.md`](../proposals/audit-ingestion-response.md).

---

## 9. SPEC sections this changes

| Section | Change |
|---|---|
| § 3.1 | hub storage is no longer a single `hub.db` file |
| § 8.1 | `mesh.connect` gains a signature parameter and a capabilities response |
| § 8.2 | `from` becomes constrained by validated entitlement |
| § 9.3 | teardown response shape — soft delete |
| § 9.4 | host split table gains the blob `PUT` |
| § 10.1 | `POST /api/v1/agents` accepts `public_key`; approval procedure |
| § 15.1 | storage authority wording — core VM service, not specifically http |
| § 15.2 | blob key retains the extension |
