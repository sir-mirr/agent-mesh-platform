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

### The web surface reads its own stores, not the hub

`GET /api/v1/agents` and the message history come from `agent-mesh.db`, not from
`mesh.list_agents` and `mesh.fetch_messages`. So the registry a browser sees and
the one the hub routes by can disagree, and the UI shows history the hub has no
record of.

**Why deferred.** Reconciling them means deciding which service owns message
history, which is the item below.

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

### A held `once` reminder has no way to be released in production

§ 3.3 holds a one-shot reminder that is badly overdue until an operator decides
whether to fire it. `ReminderScheduler.recordOverdueDecision` is that decision,
and **nothing calls it** — there is no route, no CLI, and no admin surface. A
`once` reminder that falls past the threshold is therefore held forever: still
`active`, firing nothing, and reported only as a single `overdue_hold` event.

Repeating reminders were freed from this in 0.2 — their next slot is computable,
so there is nothing to decide. `once` genuinely needs the judgement, so the fix
is a surface for making it, not removing the hold.

**Why deferred.** It needs an admin route and a UI, and the hold is the safe
direction meanwhile: a one-shot that never fires is better than one that fires
at 3am for a moment that passed on Friday.

### Only GitHub OAuth can produce an approved non-admin account

`isUserApproved` passes an admin implicitly and everyone else only via a
`pending_approvals` row — which is written **only** by the GitHub OAuth
callback. `seedLocalUsers` seeds one admin. So a deployment with no GitHub
integration has exactly one usable account, and no way to add a second without
writing to the database directly.

**Why deferred.** The intended login is GitHub; local login exists for
bootstrap. Adding local user management is a product decision, not a gap in what
0.2 set out to build.

## Known weaknesses

Recorded honestly. Several are stated positions rather than oversights — SPEC
§ 14.2 sets out the v0.1 trust posture — but a stated position is still a
weakness, and the list is more useful than the distinction.

### ~~`can_proxy` is self-asserted~~

**Closed.** The unauthenticated provisioning route refuses the field, and it is
granted either by an operator holding `agent.provision` over that identity or
by `AGENT_MESH_PROXY_IDENTITIES` on the hub.

The original entry said closing it meant authenticating provisioning. It did
not: the route stays open, because a lane must be able to register a key
without holding a human's credential. What moved is the one field on it that
was a grant.

**One self-assertion remains and is not hidden.** `agent-mesh-http` is named in
the deployment's own configuration, so it still ends up with the flag it needs
without anyone approving it at runtime — there is nobody to approve it before
the process that authenticates operators is running. What changed is that it is
no longer *reachable*: an attacker who can open a socket to the hub can no
longer grant themselves the same thing.

#### Original entry — `can_proxy` is self-asserted

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

**Why deferred.** It is a deployment concern rather than a code one: TLS
terminates at the proxy § 8.11.1 already assumes, and the hub binding to
loopback behind it is the configuration that makes `ws://` safe. Nothing here
changes when someone does that, which is why nothing here is waiting.

### A `requires_key = 0` type connects unsigned

By design, not by omission — but the guarantee is per type. `service` is seeded
at 0 because the baseline predates keys, so `http-server` and `self-reminder`
connect unsigned today. A deployment that wants them authenticated raises the
flag and provisions keys; nothing in the code needs to change.

**Why deferred.** Because that last clause is the whole answer — the mechanism
exists and a deployment chooses. Seeding `service` at `1` instead would break
every baseline participant on upgrade to fix something a flag already fixes.

### The audit store is never pruned

Retention is indefinite by decision. On exhaustion the hub keeps routing and
refuses audit writes with `-32044` rather than deleting to make room, so the
failure mode is "audit stops" rather than "history quietly rewrites itself".
Someone still has to notice.

**Why deferred.** Retention is the decision, not the gap. What is missing is an
operator noticing before exhaustion, which is monitoring rather than code — and
pruning is the one remedy that would make the trail lie.

### A socketless caller can be handed the same message twice

Delivery over § 8.10 is at-least-once: a batch not acknowledged comes back after
its lease lapses. Clients deduplicate on the stable `id`. This is a deliberate
trade rather than a defect — a duplicate is visible and cheap, a loss is
neither — but it does mean the mesh does not promise exactly-once to a caller
that cannot hold a socket, and no amount of tuning the lease changes that.

**Why deferred.** There is nothing to build. Exactly-once over a transport the
caller cannot hold open is not available at any price, and the contract says so
rather than implying otherwise.

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

**Why deferred.** It becomes real the day a second hub does, and that day
arrives with presence — which is the constraint that has to move first. Fixing
this alone would be solving the smaller half of a problem nobody has yet.

### ~~Attachment download is unauthenticated~~

**Closed.** Ruled in [`open-questions.md`](open-questions.md) and built as
SPEC § 15.3: the parties to the message carrying it, sender or recipient, agent
or person.

### A refused upload leaves its connection unusable

`POST /api/v1/upload` decides from `Content-Length` before reading the body, so
an oversized upload is never materialised. The client is still sending when the
refusal goes out, and what it has already written is read as the start of the
next request on that connection — which then fails to parse, giving the caller
a `400` on a request that was fine.

**A caller that has been refused must open a new connection.** Three fixes were
tried and none works in this stack:

| | |
|---|---|
| `body.cancel()` | disposes of this side; does not stop the sender |
| `Connection: close` | the correct HTTP answer, and it is ignored here |
| draining the body | leaves the server waiting on a sender that may never finish — worse than the problem |

**It does not crash the process**, though it read that way for an afternoon:
the symptom lands on whatever request happens to follow, so it moves around and
looks like instability. Written down mostly so the next person recognises it in
under two hours.

**Why deferred.** The alternative is reading every oversized body in full,
which is the cost the check exists to avoid, and the affected path is one a
caller only reaches by being refused.

### ~~`POST /api/v1/upload` buffers whole files in memory~~

**Closed** for the case that mattered. The size is now checked against
`Content-Length` **before** the body is read, instead of after `formData()` had
parsed the whole thing into memory and `arrayBuffer()` had copied it again — an
oversized upload used to cost twice its size before being refused.

Refusing early has its own trap, and it bit immediately: replying before the
body is consumed leaves an unread stream, the socket resets, and the server
died on the first oversized upload. `refuseUpload` cancels the body first.
Reading it to be polite would reintroduce the exact cost the check exists to
avoid.

The original entry follows.

#### Original entry — `POST /api/v1/upload` buffers whole files in memory

At the 100 MiB limit, a handful of concurrent uploads takes the process down.
The audit blob route (step 4) streams and does not share this path; the old
route was left alone.

### ~~No rate limiting anywhere~~

**Closed** by SPEC § 14. Token buckets on the unauthenticated provisioning
routes, keyed on the observed source, and on the signed surface keyed on the
verified identity.

Two things worth keeping from building it.

The first numbers — 20 burst, one per second — broke fifty-eight tests. A suite
bringing up lanes as fast as it can is exactly the shape of a host onboarding a
fleet, and the comment predicting that failure was **already in the file** when
those numbers were chosen. A stated principle does not check itself.

And the buckets are per process. The hub does not scale horizontally today, so
this is the whole deployment; behind two hubs it silently becomes `2n`.

The original entry follows.

#### Original entry — No rate limiting anywhere

Neither the hub's routes nor http's. A restart loop proposing keys is bounded
by the supersession rule rather than by any limit.

### ~~The SSE stream carries its JWT in the query string~~

**Closed.** It authenticates from the session cookie now, like every other
route, and a query token is refused.

The original entry proposed a short-lived stream ticket, which was the right
shape for the wrong premise. The premise — "`EventSource` cannot set headers" —
is true and irrelevant: a cookie is not a header the caller sets, it is one the
browser sends, and it sends it for a same-origin stream unasked. Cross-origin
consumers pass `withCredentials: true`.

**Nothing needed building.** The mitigation was already available and the
footnote explaining why it was not had been read as a constraint for long
enough to look like one.

The original entry follows.

#### Original entry — The SSE stream carries its JWT in the query string

`GET /api/v1/events/:agentId` authenticates by `?token=` because `EventSource`
cannot set request headers (§ 9.1 †). The token therefore appears in access
logs, in proxy request lines, and in anything that records URLs — a bearer
credential in the one place logging tools are designed to keep.

Mitigating properly means a short-lived stream ticket exchanged for the session
cookie, or moving to WebSocket for the browser stream.

**Why deferred.** The alternative today is no event stream in a browser at all.
The SPEC records the cost and asks deployments to redact the parameter.

### ~~An identity's `type` can change with nothing recording that it did~~

**Closed.** `mesh.identity.type_changed` (SPEC § 8.9.5) carries `{from, to}`,
and § 8.9.5 defines the identity-event shape the two items below were also
waiting on. `actor` is null because the route cannot authenticate its caller —
that part is unchanged and is now stated in the contract rather than absent
from it.

The original entry follows, because the reasoning is why the shape looks the
way it does.

#### Original entry — An identity's `type` can change with nothing recording that it did

§ 10.1 step 5 mandates the upsert: `ON CONFLICT(identity) DO UPDATE SET type,
description`. So a second `POST /api/v1/agents` for a name that already exists
replaces its type, and that is the contract working as written.

What is missing is the record. Key transitions each write an
`agent_key_events` row carrying the actor; `agents.type` has no equivalent. It
is read at display time, so changing it rewrites how **every past audit event
for that identity reads** — an identity that acted as one runtime is presented
as having always been another, and nothing anywhere says otherwise.

Found while answering `client-claude`'s mail #122, which reported the opposite
symptom: they use `create_only`, which refuses instead of updating, so their
reclaim left the hub's type and their local config disagreeing with no error.
Both halves are the same gap seen from either side — the type moves, or fails
to, and neither outcome is written down.

**Why deferred.** The read side is now closed: `GET /api/v1/agents/{identity}/keys`
reports the registered type (§ 9.2), so a caller can compare before it acts,
which is what the reporting case actually needed. Recording the transition
means a new event shape — `recordMeshEvent` is message-shaped and does not
fit — and a SPEC section defining it. Worth doing, not worth doing between a
question and its answer.

### ~~Reading the audit trail is not itself audited~~

**Closed.** SPEC § 11.0.1: a content read writes `mesh.identity.audit_read`
before returning, and fails closed if it cannot. Metadata reads are ungated —
they carry no content, and refusing them would take the mesh's diagnostics down
with its audit store.

Two things it did **not** close, both narrower than the original entry:

- The writer is a second **module** with its own read-write handle, not a
  second process. `audit-query.ts` stays `readonly: true`, so the code that
  serves a query has no write capability — but a bug elsewhere in
  `agent-mesh-http` still reaches the store.
- A content read under a stuck audit store costs `busy_timeout` (5 s) before it
  is refused. That is the price of failing closed and is worth knowing before
  someone reports it as a hang.

The original entry follows, because it is why the shape is what it is.

#### Original entry — Reading the audit trail is not itself audited

`GET /api/v1/audit/events` and `/api/v1/audit/events/{event_id}` resolve an
admin actor and then discard it. Nothing records that someone read the trail,
or what they read.

This matters because it is load-bearing elsewhere. `GET /api/v1/admin/inbox`
withholds message bodies on the reasoning that an operator who needs content
should go to the audit trail, *where the access is itself recorded* — that is
written into the route's own docstring, and it is not true. The weaker
half stands (bodies are not in the inbox route); the justification does not.

Structural, not an omission in the handler: `agent-mesh-http` opens `audit.db`
with `readonly: true` (`audit-query.ts`), so it could not write the event even
if one were defined. Closing this means either giving that process write access
to a store it is currently prevented from touching, or routing the record
through the hub — and both are architecture decisions rather than a patch.

Two smaller questions come with it. A paginating operator would emit one event
per page, so the trail fills with reads; and a read of the trail becomes an
entry in the trail, which the next read returns.

**Why deferred.** It shares its blocker with the type-change item above: both
need a non-message event shape, which `recordMeshEvent` is not, plus a SPEC
section defining it. Recorded here rather than fixed quietly because the claim
was already stated to `platform-fe-antigravity` (mail #139) and written into
their operator specification as a guarantee — retracted in #145.

### A public key can still be tested against the mesh

`POST /api/v1/agents` now refuses a key held by another identity, which closes
the worse problem — but the refusal itself answers a question. Submit any public
key with a throwaway name and a `409 KEY_HELD_BY_ANOTHER_IDENTITY` says the mesh
knows that key. No credential is needed to ask.

What it does **not** say is whose it is, or what an operator ruled on it, and
both of those were leaking before the fix.

The direction is what makes it worth recording. `mesh.list_agents` carries no
key material at all — `{id, description, online, last_seen, type}` — and
`GET /api/v1/agents/{identity}/keys` answers only for a name the caller already
knew. Fingerprint-to-anything was closed until this refusal, so this is a small
opening rather than a restatement of an existing one. `client-claude` read it as
the latter (mail #150), and the correction is in #151.

**Why deferred.** The route has to answer something, and the alternative is what
was just fixed: accepting silently and leaving a `requires_key` identity with no
key. The premise for an attacker is holding a public key already, which § 10.2
expects lanes to log at startup, so the value of the answer is low.

**The general question is the one to keep.** `key_matches` was proposed and
withdrawn earlier the same day because it would build a fingerprint-to-identity
lookup — and while that was being refused, provisioning was already answering a
weaker form of it. Refusing a new surface does not audit the existing ones.
Before opening any unauthenticated route, ask what already answers that question
rather than only whether this one should.

### ~~`scheduler.tick` writes and its name does not say so~~

**Closed.** Renamed to `advanceDue`, which is in the vocabulary and says what
the method does to the reminders it touches. The exemption list in
`test/naming.test.ts` is now empty, which is the state it should be in — an
exemption is a concession with a sentence attached, not a place to put things.

The original entry follows.

#### Original entry — `scheduler.tick` writes and its name does not say so

`packages/self-reminder/src/scheduler.ts` updates `reminders` inside `tick`.
The § 11-era naming rule in `test/naming.test.ts` requires a function that
performs a durable write to announce it, and `tick` does not — it is the idiom
for one pass of a loop, which says when it runs and nothing about what it does.

It is exempted there **by name, with a reason**, rather than by widening the
list of accepted write verbs. Widening would silently accept every future
`tickSomething` and nobody reading the list would know one entry was a
concession.

**It was invisible until the checker was repaired.** `bodyOf` brace-counted
from the declaration line, so a function whose parameters carry an inline
object type had its body end at the parameter — `tick` predates every rule in
that file and had never once been reported.

**Why deferred.** The honest fix is a rename, and `tick` is the daemon's entry
point: `main.ts` calls it and six tests name it. That is worth doing and is not
worth doing between two unrelated changes.

### ~~The group-manager path to teardown is not implemented~~

**Closed** by SPEC § 12. It now asks the question the earlier draft could not:
`group.manage` **scoped to the group the agent is in**, and explicitly not the
tenant-wide grant every administrator holds.

The original entry follows, because it is why the check has that shape.

#### Original entry — The group-manager path to teardown is not implemented

§ 11.3 admits two routes to teardown: a scoped capability, and the capability
plus ownership. A third was intended — a group manager may tear down agents in
groups they manage — and it is **absent on purpose** until groups exist.

The only thing there was to test in the meantime was `group.manage` at tenant
scope, which every seeded admin holds and which satisfies any identity. That is
not "manages the group this agent is in". It is a second, wider grant of
teardown wearing a different name, and the first draft of it returned `200` for
an agent the caller neither owned nor held a teardown grant over — caught by the
test written from the SPEC sentence, not by reading.

**Why deferred.** It needs groups. Implementing a check against a concept that
does not exist yet produced exactly what such a check produces: a permissive
no-op that reads as a control.

### ~~The integration suite occasionally loses two tests to a mesh that never starts~~

**Reopened, found, and closed.** The withdrawal below was right to reject the
mechanism it named and wrong to conclude there was none. The real one, caught
with the port still held:

```
service at http://127.0.0.1:57566/health never became healthy: status 403
$ lsof -nP -iTCP:57566
Electron  30993  ...  TCP 127.0.0.1:57566 (LISTEN)
```

**The `403` is what identified it.** Nothing in the hub sends one on `/health`,
so the answer was not coming from the hub. `freePort` used
`Bun.serve({ port: 0 })`, which binds every interface and therefore reports a
port free on `0.0.0.0` — saying nothing about `127.0.0.1`, which is where the
health check goes and where an unrelated process was already listening.

Fixed by probing on the address the caller will use. `scripts/e2e-harness.ts`
has always done that, which is why this never appeared there.

Worth keeping as a record of the sequence: a guess was written down as a
mechanism, measured, found false, and withdrawn — and the withdrawal said the
cause was unknown rather than absent. That left the door open, and the next
occurrence carried an error code specific enough to walk through it.


Withdrawn. The mechanism this entry asserted was measured and is not there.

**What was seen**, once: a run printed

```
service at http://127.0.0.1:PORT/health never became healthy:
The socket connection was closed unexpectedly
```

and the summary line captured from it read `407 pass` where adjacent runs read
`409`.

**What this entry then claimed** was the ephemeral-port dance — `freePort` binds,
reads the port and closes, and another concurrently starting mesh takes it in
the gap. That was written as the cause. It was a guess, and it reads as a
finding.

**Measured.** 400 allocations through the same bind-read-close path, 21
concurrent to match one per test file, then each port claimed by a real
`Bun.serve` exactly as a service does: **zero duplicates, zero rebind
failures.** Eight consecutive full runs of `test/` since: `412 pass, 0 fail`
every time. No test in `test/` kills a service on purpose, so the health failure
had no deliberate source either.

The single observation stands and the cause is unknown. It is not a port race.

**Why this is withdrawn rather than left open with a question mark.** An entry
naming a mechanism sends the next reader to `freePort`, and they will find
nothing wrong with it, because there is nothing wrong with it. A wrong lead
costs more than an absent one.

What survives is the reporting point, which was true independently of the cause:
**a suite that runs fewer tests than it did yesterday reports the same green.**
Read `Ran N tests`, not the colour. If the symptom returns, capture the service
stdout — the harness pipes it — rather than reasoning about it from the summary.

### ~~`scripts/` and `.claude/hooks/` were outside the typecheck~~

Closed. `tsconfig.base.json` now references a project for each, and
`test/typecheck-scope.test.ts` fails if a TypeScript file in this repository
falls outside every project.

Two defects surfaced the moment the files were compiled for the first time:
`--state-dir` with nothing after it assigned `undefined`, which the harness read
as "no state directory" and answered by making a temporary one it removed on
exit — so a runner that asked to keep state got a mesh whose files were gone.
And `mailbox-watch.ts` was not a module, making every top-level `await` in it a
syntax error nobody had run `tsc` over.

Recorded rather than quietly fixed because of what it says about the reports.
Every "typecheck 0" in this session, while the harness was being changed, was
true of the repository *except the file being changed*.

### ~~The sweep for tests that pass for a reason unrelated to their name~~

Closed. Every hole it found is fixed and in `scripts/mutation-check.ts`; what
remains below is the record of what turned out *not* to be a hole, kept because
deleting it would lose the finding. Nothing here is waiting on anything.

A fan-out over 321 negative tests in 107 files, asking one question of each: *if
I deleted only the guard this test is named after, would it still pass?* It
raised 16 candidates, and an adversarial stage refuted none of them — sixteen
raised, sixteen survived. **A gate that passes everything is not a gate**, so
every candidate was applied to the source and run rather than believed.

Eleven were uncaught by the full suite. Then a second sorting was needed, and it
is the one worth recording:

| | |
|---|---|
| **a hole** | deleting the guard changes behaviour and nothing notices |
| **equivalent** | deleting the guard changes nothing observable |

The verify script called anything green a hole, which does not separate these —
the same defect it was written to expose, one level up. Three holes were real
and are closed (`capability-not-role`, `retry-after-floor`, `orphan-readonly`,
plus `tsx-enumeration` found separately). The rest are recorded here, because an
equivalent mutation is not a defect and deleting the entry loses the finding.

**The attachment id gate** (`test/http.test.ts`). Two guards in sequence: the
separator check, then `SHA256_ID_RE` / `LEGACY_ID_RE`. Deleting the first leaves
the second answering `400` to the same inputs. Deliberate defence in depth. The
test was separately too loose — it accepted `[400, 404]`, and `404` is what a
genuine miss returns, so it was accepting the answer of a route that never looked
at the id. Now pinned to `400`, with the bare `..` case split out because the
router normalises it before any handler runs.

**`Math.max(1, …)` on `retryAfter`.** Unreachable under `ceil`: the refusal
branch runs only when the deficit is positive, and a positive number never
ceils to zero. It becomes load-bearing the moment the rounding changes, which is
what the manifest entry now mutates.

**`wasOwner` in `ConnectionOwnership.release`.** `claim` refuses a contender
while an incumbent holds the identity, and `release` removes the socket from
`identities`, so no reachable sequence reaches `wasOwner === false`. Probing
around it did surface a latent hazard — `claim(A, s)` then `claim(B, s)` leaves
`owners[A]` pointing at a socket after it is released — but there is exactly one
`claim` call site (`rpc/connect.ts:92`) and it claims once per socket. Left
alone: guarding an unreachable case is the shape this repository has spent the
week removing, and a second call site would be the thing to review.

**`IDENTITY_RE` in `provisionHuman`.** Deleting it forwards the identity to the
hub's `POST /api/v1/agents`, which refuses it by the same rule. The outcome an
observer sees is unchanged; what changes is *which* process decided, and the
local check exists so the answer does not depend on a network call.

**One candidate was not a mutation at all.** It proposed adding an unused import
with a comment explaining that the guard is an *absence*, so neutering it would
be an insertion. Correct, and unusable — an absence cannot be deleted, and a
manifest entry for it would check nothing.

What this cost, and what it bought: the sweep's headline number was eleven and
the real one is four. **The finder and the verifier were both wrong in the same
direction, and only running the mutations separated them.** The four are worth
the sweep on their own — one of them, `capability-not-role`, turned out not to be
a test defect at all but eight admin routes that were never migrated to § 11,
two of which served whole message bodies behind a role check with no record kept.

### Group-to-group gateways — waiting on the first deployment (owner's decision)

**Why deferred:** the owner's call on 2026-08-17 — look at it again after 0.1
ships. Not blocked on anything technical and not waiting on a discovery; a
scheduling decision, recorded so nobody re-derives it.

Nothing is built and nothing claims otherwise — `SPEC.md` does not mention
gateways, `docs/decisions/` has no entry, and the only writing is
`docs/proposals/tenancy-and-groups.md`. Unlike the § 11 capability table this
week, there is no second copy here to drift; the risk is the opposite one.

**What can go wrong while this waits.** The proposal's central point is about
timing rather than design:

> Deciding this before gateways exist is a schema change; deciding it after is a
> migration of the audit trail, which is the one store that must not be
> rewritten.

`sent_by` is a single field and holds one carrier. Two gateways in a path make
the true answer a list, and squashing it either way loses a hop that touched the
message. So **anyone changing the audit schema before gateways arrive should
know that a carrier path is the shape it will eventually need** — not to build
it now, but to avoid closing the door.

A hop limit belongs with it. Gateways relaying to gateways cycle the first time
somebody misconfigures one, and a bound is cheaper to add now than during an
incident.

**The other half is already built and is not waiting on any of this.** § 12
refuses a send with no egress rule (`group_egress`, `groups.maySend`,
`-32018 EGRESS_DENIED`), so group isolation holds today. What is deferred is the
participant that may cross a boundary, not the boundary.

And the proposal notes gateways and process-per-tenant want the same
architecture — `onlineAgents` is one in-memory map in one hub process, which is
why the hub does not scale horizontally, and per-tenant processes would make a
gateway the only thing speaking across them. Worth deciding together rather than
twice.

### An identity has a grammar and no length

SPEC § 9.1 states the grammar `^[A-Za-z0-9][A-Za-z0-9-]*$` and stops there, and
`IDENTITY_RE` in `packages/http/src/provision.ts` matches it exactly. Neither
bounds the length, so neither is wrong — the code implements what the contract
says. What is recorded here is that the contract does not say anything.

Measured rather than reasoned about, because a guess here was wrong once: a
first probe reported every length failing with `-32014`, which looked like a
length limit and was an unapproved key. With the keys approved the answer is
flat:

```
identity length   provision   addressed by a sender   received by the holder
64                201         sent                    1 msg
255               201         sent                    1 msg
1000              201         sent                    1 msg
10000             201         sent                    1 msg
```

A ten-thousand-character identity is not a half-working curiosity. It is
created, it is addressable, and mail reaches it — the whole path works, which
is why nothing anywhere reports a problem.

**Why deferred.** Nothing is broken to fix. The identity is a primary key, and
it is copied into every message row, every audit row and every queue entry that
names it, so the cost of an absurd one is storage and index size rather than a
failure anybody would see. On a local deployment where the operator provisions
every identity, that cost has no path to being paid by accident.

Choosing a bound is the part that is not free. `255` is the obvious number and
obvious for no reason connected to this system; the honest bound comes from
what an identity is for — a name a person types and reads in an audit trail —
and that is a decision with a migration attached, because a bound added later
refuses identities that already exist.

What should happen when it is decided: **SPEC first, then both ends.** The
grammar is normative and lives in § 9.1, `IDENTITY_RE` is one copy of it, and a
bound added to the code alone would be a contract the SPEC does not state — the
same drift `test/capability-vocabulary.test.ts` exists to prevent for § 11.

### ~~The hub does not close its audit store~~

Closed, and moved to
[`docs/decisions/folding-the-write-ahead-logs.md`](decisions/folding-the-write-ahead-logs.md)
— it turned out to be a decision rather than a delay.

The entry deferred an unclosed store on the grounds that its cost was an
unfolded write-ahead log. Measurement showed `close()` folded nothing for any of
the four stores, so the three closed ones were in exactly the state of the
leaked one. Every log is now folded explicitly at shutdown, in both processes,
and closing the audit store buys nothing that is left to buy.

**Its evidence was retracted, which is the part worth keeping here.** The entry
reported 24, 44 and 55 failures against 0, called controlled because the tree
was held constant between runs. The machine was not: another agent was running
the full suite on the same host, and a re-run put the *reverted* arm at 58
failures. A comparison that controls the code and not the load measures the
load.
