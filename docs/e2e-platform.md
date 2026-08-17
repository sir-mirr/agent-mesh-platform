# End-to-end testing — the platform's half

The scenarios themselves are in `@agent-mesh/contracts` (`E2E_SCENARIOS`), and
SPEC § 17 says why they live there rather than on either side. This document is
the platform half: how to bring a real mesh up, what it guarantees under test,
and which failures are worth asserting against rather than around.

```bash
bun test test/scenarios.test.ts
```

`test/scenarios.test.ts` is an interpreter for the verb set and holds no
expectations of its own. Adding one here would make this repository's green
mean something the client's green does not, which is the failure the shared list
exists to prevent — so a new expectation goes in the contracts package, gets a
tag, and both sides pick it up.

Four mutations were run against the first passing version, each caught by the
scenario meant to catch it: egress default-deny disabled (`E2E-EGRESS-001`), an
ack that reports success without settling (`E2E-RECEIVE-002`), the key-approval
gate removed (`E2E-KEY-001`), and a content read that leaves no trace
(`E2E-AUDIT-001`). Worth repeating after adding a scenario — a green run says
nothing about whether the scenario checks anything.

The first run failed six of eleven, and **five were defects in the scenarios
rather than in the mesh**: `mesh.connect` refused over HTTP (correct — § 8.10
has no session to establish), a leased batch expected back immediately (correct
— that is the destructive read § 8.10.1 rejects), a key collision expressed as a
keyless registration, and two trace assertions naming tables that were never the
design. That ratio is the argument for writing scenarios against the contract
and then running them, rather than writing them from memory of what was built.

---

## Bringing a mesh up

```bash
bun run e2e:harness -- --ready-file /tmp/mesh.json
```

Starts the **real** hub and http processes — not fakes — on OS-assigned
ephemeral ports, so a run never collides with a dev mesh or with another run.
`--state-dir <path>` pins the state directory; without it a temporary one is
made and removed on exit. `--keep-state` leaves it behind after a failure.

The ready file is written **once, atomically, after both services answer**. Watch
for the file rather than polling a port: a port that accepts a connection is not
the same as a mesh that will answer, and a reader can never see a half-written
file.

```json
{
  "base_url": "http://127.0.0.1:59662",
  "rpc_ws":   "ws://127.0.0.1:59661/ws",
  "api_http": "http://127.0.0.1:59661",
  "admin_test_handle": { "...": "see below" },
  "state_dir": "/tmp/agent-mesh-e2e-XXXX",
  "pid": 97647
}
```

`SIGTERM` stops both services, removes the ready file, and clears the state
directory. If either service dies on its own the harness exits non-zero rather
than leaving a runner waiting on a port nobody is listening on.

**Two ports, not one.** `api_http` is the hub's REST surface — provisioning,
teardown, key status. `base_url` is the http server — the human surface, key
approval, and the audit blob upload. They are different services and the split
is load-bearing (see below).

This bites exactly once, on attachments: `mesh.audit.prepare_blobs` answers on
the hub and returns an upload URL served by the http server. **Follow the `url`
it gives you** rather than assembling one — it is absolute for this reason, and
a client that resolved it against the hub would get a `404` from a service that
does not serve the route.

---

## Approving a key, which a runner cannot do for itself

Any scenario that needs a signing identity has to get a key approved, and
approval is behind the admin gate on purpose: SPEC § 10.2 puts it there so that
a caller cannot approve its own key. **There is no test-only bypass**, and the
harness does not add one — a harness that skipped the gate would be testing a
mesh nobody deploys.

`admin_test_handle` is an ordinary login against the seeded local account. It is
in the ready file because this script is the thing that knows the ephemeral port.

```
POST {login_url}  content-type: application/x-www-form-urlencoded
                  username=admin&password=admin
```

**It answers `302` and the session cookie is on that response.** A client that
follows redirects automatically consumes it and ends up with nothing. Send the
request with redirects disabled and read `Set-Cookie` from the `302`.

Then, with that cookie:

| | |
|---|---|
| `GET {pending_url}` | everything awaiting a decision, with fingerprints |
| `POST {approve_url}` | `{"fingerprint": "sha256:…"}` |
| `POST {deny_url}` | `{"fingerprint": …, "reason": …}` |
| `POST {revoke_url}` | `{"fingerprint": …, "reason": …}` — reason required |

Decisions are addressed **by fingerprint, never by identity**. Approving
"whatever is pending for X" approves whatever arrived last, including a proposal
that landed between reading the queue and deciding.

---

## The shortest path to a signed connection

```
1. POST {api_http}/api/v1/agents
   {"identity": "...", "type": "ai-codex", "public_key": "<43-char base64url>"}
   → 201, key: { fingerprint, status: "pending" }

2. POST {login_url}          → cookie (302, redirects off)
3. POST {approve_url}        {"fingerprint": ...}     → status: "approved"

4. connect {rpc_ws}, sign every request
```

Between 1 and 3 the identity exists and cannot connect. That is not a race to
work around — it is the procedure.

---

## What this repository guarantees under test

**Provisioning is idempotent.** Re-registering with the same key returns its
current status and changes nothing. A scenario may register on every run.

**Signature verification is real.** `requires_key` types (`ai-*`) have no
unsigned path. The preimage covers the `params` bytes *as sent*, so a client
must sign the exact serialisation it transmits — see § 8.1.

**Revocation is immediate.** It takes effect on the next request over an
already-open socket, without a reconnect.

**Entitlement is checked per request**, not cached from what the socket declared
at connect.

**Audit appends are idempotent by `event_id`.** A repeat carrying identical
bytes returns `duplicate: true` and creates one row; a repeat carrying different
bytes is `-32041` and permanent. A scenario may replay an append.

**Blob uploads deduplicate.** Re-uploading a key already held returns `200` with
`deduplicated: true`.

**Socketless delivery is at-least-once.** A batch is leased and comes back
unless acknowledged with `ack_ids` on the next `mesh.receive`. Set
`AGENT_MESH_RECEIVE_LEASE_SECONDS` low so a scenario does not wait five minutes
to watch a redelivery.

**Sends are idempotent** when `client_message_id` is supplied. Replaying one
returns the original id with `duplicate: true`; reusing it for different content
is `-32015` and permanent.

---

## The signed REST surface (§ 9.2.1)

A runner that would rather speak REST than JSON-RPC has the same queue under
different names. `Authorization: AgentMeshSig` over `restSignaturePreimage`,
which is a **third** construction — not the RPC one and not the upload one.
Signing with the wrong preimage fails as a bad signature, which reads like a
key problem and is not.

```
POST   /api/v1/inbox                take delivery, settle the previous batch
POST   /api/v1/outbox               send
GET    /api/v1/outbox               what is still recallable
DELETE /api/v1/outbox/{id}          withdraw one
GET    /api/v1/inbox/history?peer=  conversation
GET    /api/v1/capabilities         unsigned
```

Three things bite in scenarios:

**The preimage covers the query string.** A signature built over
`/api/v1/inbox/history` will not verify a request to
`/api/v1/inbox/history?peer=b`.

**`POST /api/v1/inbox` is not idempotent.** It leases. A scenario that retries
it after a timeout gets an empty second batch, not the same one — the first
call's messages are held until acknowledged or the lease lapses.

**Recall ends at hand-over.** A scenario that sends, receives, then recalls gets
`409 ALREADY_DELIVERED`. That is the contract, not a race: acknowledgement is
not the boundary, hand-over is.

`GET /api/v1/capabilities` is worth calling first in any scenario that sizes a
batch or a retry — it is unsigned, so it works before a key is approved, and it
reports what the deployment actually enforces rather than what the client
imported.

## Every assertion cites the section it rests on

A scenario asserts the contract, not the current behaviour. The difference is
invisible while they agree, which is when it matters.

The `-32014` gap below was found by a walk that expected `-32014` because the
*socket* path returns it — written from memory, not from § 8.10. It happened to
be right, because § 8.10 says the error codes carry over unchanged. Had it been
wrong, the run would have reported a defect the contract never required, and
the fix would have been to the wrong side.

So a scenario names its clause. `expect(err.code).toBe(-32014)` with a comment
saying § 8.10 carries § 8.1's error codes is checkable by a reader; the same
line without it is a preference.

## Failures worth asserting

These are the ones where a wrong implementation still looks like it works:

| Assert | Because |
|---|---|
| A pending key gives `-32014` with `key_status: "pending"`, not `-32012` | A client must tell "wait for an operator" from "stop and ask a human", or it retries through a shutoff |
| Re-registering an approved key leaves it approved | An adapter re-sending its key on boot must not take itself offline |
| Proposing a *different* key while one is pending supersedes the first | A client regenerating each boot supersedes its own proposal forever and never gets approved — this looks like "approval is broken" |
| A revoked key fails on the **open socket**, before any reconnect | Caching the key for the connection's lifetime is the obvious implementation and defeats revocation |
| `mesh.message` carries `sent_by` | `from` is a claim; `sent_by` is what the hub recorded |
| An unentitled `from` gives `-32013` | Attribution is not access control |
| `-32041` is never retried | It is permanent; a client treating it as transient retries an event that can never be accepted, forever |
| A blob of the wrong size reads as missing | That is what an interrupted upload leaves, and accepting it puts truncated bytes behind a verified event |
| A hub-recorded `mesh.*` event carries the *sender's* signature | It is what makes a mesh event evidence rather than a report |
| An unacknowledged `mesh.receive` batch is redelivered | A destructive read loses whatever a dying turn did not persist |
| A socketless recipient is `pending`, never `delivered` | There is nowhere to push; saying delivered would be false |
| The upload URL from `prepare_blobs` is followed verbatim | It is served by a different process than the one that returned it |

---

## Deliberately absent

Not gaps, so do not assert around them:

- **Nothing migrates.** Every store starts empty; there is no upgrade path.
- **`ws://` only.** No transport security (SPEC § 14.2).
- **The hub is unauthenticated** for provisioning and teardown. Approval is not,
  which is why it lives on the other service.
- **No rate limiting** anywhere.

`docs/deferred.md` carries the full list with the reasoning.

---

## Capability status

`SPEC.md`'s table at the top is authoritative — trust it over this document.

All eight steps of 0.2 are built: provisioning, key approval, signed RPC,
entitlement, blob upload, audit ingestion and the audit query API. No scenario
needs to report pending on capability grounds.

The socketless transport (§ 8.10) is built too: `POST /api/v1/rpc` on the hub
takes the same signed frame, and `mesh.receive` pulls what a push would have
delivered. `scripts/mesh-mail.ts` is a worked example.

What remains of 0.2 is § 4.1 and § 6.1, which are lane repository work.
