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
than it sounds.

**Why deferred.** Nobody needs it while people are proxied.

---

## Known weaknesses

Recorded honestly. Several are stated positions rather than oversights — SPEC
§ 14.2 sets out the v0.1 trust posture — but a stated position is still a
weakness, and the list is more useful than the distinction.

### The hub is unauthenticated

`POST /api/v1/agents` and `DELETE /api/agents/{identity}` take no credential.
Anything that reaches the hub's port can provision an identity or take one
offline permanently.

Key *approval* is deliberately not here — it is on http behind the admin gate,
because an approval endpoint on an unauthenticated service would let a caller
approve its own key. So provisioning being open is survivable: a proposal grants
nothing until approved. Teardown being open is not mitigated by anything.

**Mitigation today:** SPEC § 14.1 pins the hub to a trust-bounded interface.
That is a deployment assumption, not an enforcement.

### `mesh.connect` takes no credential until step 3

Anything that reaches the port can connect as any provisioned identity that is
currently offline. Step 3 closes it for types with `requires_key`; types without
it stay open by design.

### Traffic is plaintext `ws://`

No transport security between the hub and its clients. § 14.2 states this.

### An unentitled `from` is recorded but not refused

`messages.sent_by` now records the transmitting socket, so an incorrect
override is visible after the fact. It is not yet *prevented* — that is step 6.
Attribution is not access control.

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
