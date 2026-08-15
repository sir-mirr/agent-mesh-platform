# Implementation plan — SPEC 0.2

SPEC 0.2 is a settled contract. This is the order to build it in, what each
step depends on, and how each one is known to work.

**Increment 1 (steps 1 and 5) is done.** `agents.db` carries identity, the type
registry and the key tables; teardown is a soft delete. Steps 2 onward remain —
that is six of the eight, and all of the security half.

**Three things landed that this plan did not contain.** They came out of
building step 6 and are recorded here so the plan is not read as the whole of
what changed:

- `messages.sent_by` — the hub records the socket that transmitted an envelope,
  not only the `from` it claimed. Independent of step 6: entitlement decides
  whether an override is allowed, this decides whether the answer is auditable.
- `human` in `agent_types`, and a person provisioned as a mesh identity when an
  operator approves them. Step 6 needs to ask what type a `from` names, and
  before this the hub had no row for a person to have a type in.
- The identity format loosened to `^[A-Za-z0-9][A-Za-z0-9-]*$`, compared
  case-sensitively. The old rule excluded the logins people actually have.

**Step 6 is no longer blocked.** The client team confirmed lanes never proxy, so
the only proxied participants are people, and the rule is a type check rather
than the storage model this plan left open. It still needs Lyong's confirmation
before it is built.

Two things shape the whole plan.

**Nothing migrates.** Every store is treated as starting empty, which removes
the usual reason a schema change has to be done carefully and in pieces.

**Half of this is a security boundary.** Signature verification, key approval
and entitlement checks are the parts where a step that "mostly works" is worse
than one that is absent — a check that can be bypassed reads as protection and
is not. Those steps are sequenced so that nothing depends on a partial one.

---

## Dependency shape

```
   1  agents.db + agent_types + agent_keys
      │
      ├──▶ 2  key registration and approval
      │       │
      │       ├──▶ 3  request signatures         ─┐
      │       │                                   │
      │       └──▶ 4  upload authorisation  ──────┤
      │                                           │
      ├──▶ 5  soft delete                         │
      │                                           │
      └──▶ 6  entitlement (proxy_for, from)  ◀────┘
                                                  │
   7  audit.db + mesh.audit.*  ◀──────────────────┘
      │
      └──▶ 8  audit query API
```

Steps 5 and 7 read from the left column but do not depend on 3 or 4. Everything
in the right column depends on there being a verified identity, which is why
signatures come before audit rather than beside it.

---

## 1 — `agents.db`, `agent_types`, `agent_keys` ✅

**SPEC** § 3.1, § 10.3
**Depends on** nothing
**Status** done

Split identity out of `hub.db` into its own file and add the tables the rest of
0.2 needs.

- `store/src/open.ts` already names `agents.db`; give it a handle.
- Move `agents` there. Add `deleted_at` now (step 5 uses it) so the column
  exists before anything reads it.
- New: `agent_types` (`type`, `description`, `requires_key`), seeded
  idempotently with `ai-claude`, `ai-codex`, `ai-gemini` at `requires_key = 1`
  and `service` at `0`.
- New: `agent_keys` and `agent_key_events`, with the partial unique indexes —
  at most one `pending` and one `approved` key per identity. **The index is the
  enforcement**; application code that also checks is a second chance to get it
  wrong.
- `POST /api/v1/agents` validates `type` against the table rather than the
  hardcoded set.
- http opens `agents.db` read-write.

**Done when** the hub creates all four tables on a fresh state directory, a
type outside the seeded set is rejected, adding a row to `agent_types` makes it
accepted with no code change, and two `approved` rows for one identity are
refused by the database.

**Watch for** the seed running on every boot without duplicating, and http
opening the file without racing the hub's DDL — the hub starts first, but a
test should not assume it.

---

## 2 — Key registration and approval ✅

**SPEC** § 10.1, § 10.2
**Depends on** 1
**Status** done

- `POST /api/v1/agents` accepts `public_key` and records it as `pending`.
- Reject a `requires_key` type registered without a key.
- Re-proposing an identical key returns its current status and changes nothing.
  An adapter restarting must not knock its own approved key back to pending.
- A different key while one is pending replaces the pending row. A restart loop
  with a changing key must not flood the queue.
- **A proposal never touches an `approved` key.**
- Approval and denial on http, behind the existing admin JWT gate. Every
  transition appends to `agent_key_events`.
- Revocation is a status change, never a delete — past signatures stay
  verifiable, and the history is what lets a verifier judge them by date.

**Done when** the state machine holds under the sequences that break naive
implementations: propose → approve → propose the same key again (no change);
propose → approve → propose a different key (approved untouched until the new
one is approved, then the old one is `revoked`); revoke without a replacement
(identity has no approved key and cannot get one until someone approves).

**Watch for** approval landing anywhere on the hub. The hub has no
authentication; an approval endpoint there lets a caller approve its own key,
which makes the entire procedure theatre.

---

## 3 — Request signatures

**SPEC** § 8.1
**Depends on** 2

This is the step the rest of the security work rests on, and the one where
partial is worse than absent.

- Take the dependency on `@agent-mesh/contracts` and use
  `requestSignaturePreimage`. Do not reimplement it — the fixtures exist
  precisely because two implementations of one encoding disagree.
- Verify against the identity's current `approved` key, **read per request**.
  No connection-lifetime cache: it would make revocation ineffective against
  connections already open, and the measurement says it saves nothing —
  ~1.7 µs to read the key row against ~32 µs for the verification it feeds.
- `iat` within ±120 s; a seen-nonce set per identity for the width of the
  window.
- `requires_key = 1` means no unsigned path at all. Not "verify if a key
  happens to exist" — that was the 0.1 draft, and it let a caller register
  without a key and then connect unsigned.
- New errors: `-32012` SIGNATURE_INVALID, `-32014` KEY_NOT_APPROVED with
  `key_status`.

**Done when** the contract fixtures pass byte-for-byte; a signature is rejected
after altering the method, the nonce, the `iat` or one byte of `params`; a
replayed nonce inside the window is rejected; a request outside ±120 s is
rejected; and a revoked key stops verifying **on the next request over an
already-open socket**.

That last one is the point of the whole step. It is an integration test, not a
unit test.

**Watch for** the digest and the signature drifting into one computation. They
share the raw `params` bytes and nothing else — the digest identifies an event,
the signature authenticates a request.

---

## 4 — Upload authorisation

**SPEC** § 8.9.2, § 9.1
**Depends on** 2 (not 3 — this path has its own preimage)

- `upload_nonces` in `agents.db`: bound to `(identity, blob_key, size)`, TTL
  900 s.
- `PUT /api/v1/audit/blobs/{key}` on http, authorised by
  `Authorization: AgentMeshSig …` over `uploadSignaturePreimage`.
- Streaming: hash while receiving, write to a tempfile, rename into place only
  after the digest matches. **The existing `POST /api/v1/upload` buffers the
  whole body in memory** — at 100 MiB a handful of concurrent uploads would
  take the process down, so this route cannot reuse it.
- `Content-Length` required and matched; over `max_blob_bytes` → 413; past
  `upload_timeout_seconds` → 408; digest mismatch → 422 and the tempfile
  removed.
- No chunk or resumable state. A failed upload is retried whole.

**Done when** a 100 MiB upload completes without the process's memory tracking
the file size; an interrupted upload leaves no partial file in `uploads/`; a
signature for one `blob_key` is refused for another; an expired nonce is
refused; and re-uploading an existing key returns deduplicated success.

---

## 5 — Soft delete ✅

**SPEC** § 9.3
**Depends on** 1
**Status** done

- `DELETE /api/agents/{identity}` sets `deleted_at`, revokes the identity's
  keys, and **does not touch `messages`**.
- Re-registration of a soft-deleted identity is refused.
- Response shape changes: `soft-deleted` | `already-deleted` | `not-found`,
  and `messages_removed` is gone.

**Done when** every read of `agents` filters `deleted_at IS NULL` — the
pre-registration check, `mesh.list_agents`, and the recipient check on
`mesh.send`. Missing one is the whole failure mode of this step: a deleted
identity that can still connect, or still receive.

**Watch for** it being tempting to do this before step 3. It is safe to, but
the reason it exists is that deleting a key makes past signatures unverifiable
— which only bites once signatures exist.

---

## 6 — Entitlement ✅

**SPEC** § 8.2
**Depends on** 3 (built ahead of it — see below)
**Status** done

- `proxy_for` validated at connect: a socket may only claim identities it is
  entitled to proxy.
- `from` must be the connected identity or an entitled `proxy_for` entry.
- `-32013` NOT_ENTITLED.
- Use `ownership.ts` from `@agent-mesh/contracts`. It has modelled this since
  0.1 and was never wired to anything.

**How the open question closed.** It was "where is entitlement stored", and the
answer was that it mostly is not. Agents hold keys and sign for themselves, so
`from` is already settled for them; the client team confirmed lanes never proxy.
That leaves participants who by design hold no key, which `requires_key = 0`
already names — so the subject half is a type lookup, not a grant table. Only
the "who may proxy at all" half needed storing, and that is one column.

Built before step 3 rather than after. The dependency was on there being a
verified identity to attach entitlement to, but `sent_by` (recorded ahead of
this plan) already gives the hub the connected identity, and every check here is
against stored rows. Signatures make that identity *trustworthy*; they do not
change what the rule reads.

---

## 7 — Audit ingestion

**SPEC** § 8.9
**Depends on** 3, and 4 for attachments

- `audit.db` with `audit_events` and `audit_event_blobs`. **One file**, because
  an event and its attachment references must commit in one transaction.
- `mesh.audit.prepare_blobs`: report present/missing, derive and return
  `blob_key`, issue nonces for the missing.
- `mesh.audit.append`: validate `schema_version`, verify every blob exists by
  `stat` with a matching size, check the payload digest against any existing
  row with that `event_id`, commit both tables together, ACK only after.
- **`identity`, `recorded_by`, `attestation` and `payload_digest` are not
  request fields.** The hub builds each from the authenticated connection, the
  verified signature and the received bytes. A client that sends them has them
  ignored.
- Hub-produced `mesh.*` events at routing time, retaining the sender's original
  `mesh.send` signature and its exact `params` bytes.
- `capabilities.audit` on the `mesh.connect` result.
- `-32040`, `-32041`, `-32043`, `-32044`.

**Done when** the same `event_id` with identical bytes returns
`duplicate: true` and creates one row; with different bytes returns `-32041`;
an event referencing a missing blob returns `-32040` and commits nothing; a
crash between blob upload and append leaves a collectable orphan and no partial
event; and a `mesh.send` produces a hub-recorded event carrying the sender's
signature.

**Watch for** `-32042`. It was `AUDIT_SEQUENCE_CONFLICT` and is retired. Do not
reuse it: an old client meeting a new hub must never read one meaning as the
other.

---

## 8 — Audit query API

**SPEC** § 9.1
**Depends on** 7

- `GET /api/v1/audit/events/{event_id}` and the cursor-paginated list, filtered
  by identity, provider, correlation id and time range.
- Ordered by `(stored_at, event_id)` ascending.
- Admin JWT, separate from lane authentication.
- Never return provider tokens, private keys, `Authorization` headers, or
  runtime reasoning streams.

**Done when** pagination is stable under concurrent writes — a cursor must not
skip or repeat a row because something was appended mid-page.

---

## Cross-cutting

**Capacity.** Audit retention is indefinite, so the disk fills eventually and
the answer to "then what" must not be "routing stops". On exhaustion the hub
keeps routing and rejects audit writes with `-32044`. Worth an integration test
with a deliberately tiny volume; it is the failure everything else assumes
cannot happen.

**The contract dependency.** Steps 3, 4 and 7 all need
`@agent-mesh/contracts`. Take it once, at step 3, pinned to a tag.

**Fixtures.** The contract package ships byte-level fixtures for the signature
preimages, blob keys and event ids. Run them in this repository's CI, not only
in the contract repository's. Two implementations agreeing is the thing being
tested, and it is only tested where both are present.

**What is not here.** SPEC § 4.1 and § 6.1 — a Claude lane gaining a
runtime-adapter, and hub-direct forwarding going away — are lane repository
work. This repository's part was the SPEC change, and it is done.

---

## Suggested increments

Each of these leaves the tree working and testable.

| | Steps | Ships |
|---|---|---|
| 1 | 1, 5 | Storage split, type registry, soft delete. No new auth. |
| 2 | 2 | Keys can be registered and approved. Nothing verifies yet. |
| 3 | 3, 6 | Signatures enforced end to end. |
| 4 | 4, 7, 8 | Audit ingestion. |

Increment 2 is deliberately inert: keys exist and are approved but nothing
checks them. That makes increment 3 a switch being thrown on a mechanism
already in place, rather than a mechanism and its enforcement arriving
together.
