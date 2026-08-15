# Deferred

Things found while building 0.2 that are **not fixed**, recorded so they are
known rather than discovered. Nothing here blocks the build; everything here is
a decision someone has to make later.

Two kinds, kept apart because they are read by different people at different
times: contradictions in the design, and weaknesses in what is shipped.

---

## Contradictions

### `mesh.fetch_messages` has no cursor, and history outgrows `limit`

SPEC § 8.4 dropped the `before` parameter as unimplemented. A conversation
longer than `limit` (max 200) cannot be read past its newest page. The audit
query API (§ 9.1, step 8) is cursor-paginated and does not have this problem, so
the mesh has two history surfaces with different capabilities.

**Why deferred.** Adding a cursor is a wire change to a method clients already
use, and the audit API covers the case anyone has actually asked for.

### Message content is stored twice

`hub.db:messages` for routing, `agent-mesh.db:messages` for the web UI. They can
disagree, and nothing reconciles them. Predates this layout.

**Why deferred.** Collapsing them means deciding which service owns message
history, which is a bigger question than 0.2.

### A person's identity cannot be changed

It is their GitHub login, which is also what authorises them and what is sent as
`from`. A person who renames on GitHub becomes a different identity, and their
message history stays under the old one.

**Why deferred.** Fixing it means separating the mesh identity from the login,
which means minting and storing a mapping — the design the whole `human` type
was introduced to avoid needing.

### One approved key per identity

`ux_agent_keys_approved` permits one. That fits an installed agent on one
machine. It does not fit a person with two devices, which is the stated reason
people are proxied rather than signing for themselves (SPEC § 10.3).

If people are ever to sign, this index has to go and verification has to select
by `sig.kid` — which the wire format already carries, so the change is smaller
than it sounds. Note that verification currently checks `kid` against the single
approved key rather than selecting by it, deliberately: selecting would let a
revoked key keep working as long as the caller kept naming it. A multi-key
version has to keep that property some other way.

**Why deferred.** Nobody needs it while people are proxied.

### Audit payloads are stored verbatim, secrets and all

The payload has to be byte-identical for its digest to stay checkable, and the
digest is what the attestation signs over. So redaction happens on read, not on
write, and the store holds whatever a client put there. A reader with direct
file access sees it unredacted.

**Why deferred.** The alternative breaks the attestation, which is the thing
audit exists for. Fixing it properly means encrypting at rest or splitting the
signed payload from the served one, and both are larger than 0.2.

---

## Known weaknesses

Recorded honestly. Several are stated positions rather than oversights — SPEC
§ 14.2 sets out the v0.1 trust posture — but a stated position is still a
weakness, and the list is more useful than the distinction.

### Teardown is unauthenticated, and nothing mitigates it

`DELETE /api/agents/{identity}` takes no credential. Anything that reaches the
hub's port can take any identity offline permanently, and a soft-deleted
identity cannot be re-registered.

`POST /api/v1/agents` is open too, and that one *is* survivable: a proposal
grants nothing until an operator approves it, which is exactly why approval
lives on http instead. Teardown has no equivalent second step.

**Mitigation today:** SPEC § 14.1 pins the hub to a trust-bounded interface.
That is a deployment assumption, not an enforcement.

### `can_proxy` is self-asserted

http sets the grant on its own row when it registers itself, because
provisioning is unauthenticated and nothing else was going to. So the entitlement
check reads a value the checked party wrote. It is not circular in practice —
the subject half of the rule is a type lookup nobody self-asserts — but it means
`can_proxy` is only as trustworthy as reaching the hub's port is hard.

Closing it means authenticating provisioning, which is the item above.

### Traffic is plaintext `ws://`

No transport security between the hub and its clients. § 14.2 states this. Every
signature above is therefore integrity without confidentiality: an observer
cannot forge a request but can read every one.

### A `requires_key = 0` type connects unsigned

By design, not by omission — but the guarantee is per type. `service` is seeded
at 0 because the baseline predates keys, so `http-server` and `self-reminder`
connect unsigned today. A deployment that wants them authenticated raises the
flag and provisions keys; nothing in the code needs to change.

### The audit store is never pruned

Retention is indefinite by decision. On exhaustion the hub keeps routing and
refuses audit writes with `-32044` rather than deleting to make room, so the
failure mode is "audit stops" rather than "history quietly rewrites itself".
Someone still has to notice.

### A socketless caller can be handed the same message twice

Delivery over § 8.10 is at-least-once: a batch not acknowledged comes back after
its lease lapses. Clients deduplicate on the stable `id`. This is a deliberate
trade rather than a defect — a duplicate is visible and cheap, a loss is
neither — but it does mean the mesh does not promise exactly-once to a caller
that cannot hold a socket, and no amount of tuning the lease changes that.

### The send dedup table is never pruned

`send_idempotency` grows with every `client_message_id` a caller uses. The
contract advertises a window after which a key may be forgotten, and nothing
enforces it yet.

**Why deferred.** Pruning is a scheduled job and the table is small; getting the
window wrong in the other direction — forgetting a key a client is still
retrying — turns a retry into a duplicate send.

### Nonce windows are per process

Both of them. The request-nonce window (§ 8.1) is in memory, which is correct
for a single hub and would not be for two: a replay could be split across
instances. The hub does not scale horizontally for the presence reason already
recorded, so this is a consequence rather than a second limit.

### Attachment download is unauthenticated

Ids are sha256 digests, so this is capability-style access: knowing the id is
the authorisation. Whether that is sufficient is open (SPEC § 15.3).

### `POST /api/v1/upload` buffers whole files in memory

At the 100 MiB limit, a handful of concurrent uploads takes the process down.
The audit blob route (step 4) streams and does not share this path; the old
route was left alone.

### No rate limiting anywhere

Neither the hub's routes nor http's. A restart loop proposing keys is bounded
by the supersession rule rather than by any limit.
