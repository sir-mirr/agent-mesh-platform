# Architecture

How this repository is built, and why.

`SPEC.md` is the other half of this: it states what the protocol *is*, in terms
any implementation must satisfy. This document is about *this* implementation —
the process model, what owns what, and the decisions that are not visible from
the wire.

Current as of SPEC 0.2. Where 0.2 changes something that is not built yet, it
says so.

---

## 1. What runs

Three processes, on one core VM.

```
                       browser
                          │  JWT cookie
                          ▼
  ┌──────────────────────────────────────────────┐
  │  agent-mesh-http          :3000              │
  │  REST · SSE · OAuth · admin · PWA · uploads  │
  └───────────────────┬──────────────────────────┘
                      │ WebSocket, as identity `http-server`
                      ▼
  ┌──────────────────────────────────────────────┐
  │  agent-mesh-hub           :3100              │
  │  JSON-RPC broker · identity provisioning     │
  └───────────────────▲──────────────────────────┘
                      │
        ┌─────────────┼─────────────┐
   runtime-adapter  …          self-reminder
   (agent-mesh-client)
```

**http is a client of the hub, not its peer.** A browser talks to http; http
talks to the hub on the user's behalf, connecting as its own identity and
declaring the web users it proxies for. Everything that crosses between agents
goes through the hub.

The split exists because SPEC § 3 requires the baseline to run with zero
registered agents and zero humans. The hub is machine plumbing that knows
nothing about runtimes, channels or people; http is the entire human surface.
Neither half needs the other's concerns.

### Why the hub is a single process

Presence — who is connected, which socket owns which identity, who proxies for
whom — lives in memory (`hub/src/presence.ts`). It describes live sockets, and
a socket does not survive a restart, so there is nothing to persist. The
durable half is the `agents` table.

The cost is that the hub does not scale horizontally: a second instance would
have a different idea of who is online. That is a known limit, recorded in
`docs/open-questions.md` rather than worked around.

---

## 2. Where data lives

Everything is SQLite under `AGENT_MESH_STATE_DIR` on the core VM.

| File | Contents | hub | http | self-reminder |
|------|----------|-----|------|---------------|
| `agents.db` | `agents`, `agent_types`, `agent_keys`, `agent_key_events`, `upload_nonces` | rw | rw | — |
| `hub.db` | `messages` | rw | ro | — |
| `audit.db` | `audit_events`, `audit_event_blobs` | rw | ro | — |
| `agent-mesh.db` | users, policies, approvals, push subs, `agent_registry` | — | rw | — |
| `self-reminder.db` | `reminders`, `audit_log` | rw | — | rw |
| `uploads/` | attachment bytes | ro | rw | — |

http holds `agents.db` read-write for two things it owns and the hub cannot: an
operator's key approval (§ 10.2), which the hub could not authenticate, and the
blob upload check, which reads the grant and the approved key. The hub still
owns the DDL.

**More than one process opens some of these.** That is safe because every
handle sets `journal_mode = WAL` and `busy_timeout`, and because they are all on
one machine — SPEC § 14.1 pins hub and http to the same core VM. Writes
serialise; readers never block.

**The hub owns the DDL** (SPEC § 3.1). It is the only process that calls
`migrate`. Others open a store expecting its tables to be there.

**Both processes checkpoint on the way out** — `checkpointForShutdown`, on every
read-write handle, before it is closed. `close()` alone does not do this: bun's
close is a *safe* close, and while any statement is still prepared against the
handle it marks the database closed to JavaScript and leaves the file open with
nothing folded. Both shutdown paths relied on it for as long as they existed
and folded nothing, which showed up as a `hub.db` of 4096 bytes — one page, no
checkpoint ever completed — beside 1.5 MB of log.

Whether a bare close folds a given store turns out to depend on whether a
statement happens to be alive at exit, so the two are not distinguishable by
reading the code: on one run `agent-mesh.db` folded and `audit.db` kept 156 KB,
same process, same shutdown. The checkpoint removes the question. Its failure
mode is that nothing happens — a log another process is pinning returns `busy`
and is left for the next open to recover, which is what has always happened.

**Both halves of that say so now** (T-022). A checkpoint that could not run
writes `wal_checkpoint_failed`, and the next open of a store carrying a log
writes `wal_recovered` with how much was waiting. Nothing is lost either way,
which is why it went unsaid for so long — but a process killed mid-write and
one shut down cleanly produced the same quiet boot, and *every shutdown was
clean* is what a reader takes from silence.

### Why there is a `store` package

http reads `hub.db` to serve the admin audit views. It used to do that with SQL
and a row type written into its own source — a second declaration of a schema
it does not own. The hub could change that table and nothing would notice until
a query returned the wrong thing at runtime.

`packages/store` holds one declaration of each shared schema, and the row types
that go with it. It is not an ORM and not a repository layer; it is the place a
shared shape is stated once.

`agent-mesh.db` is deliberately **not** in it. Nothing but http opens that file,
so it is not shared, and putting it there would suggest otherwise.

`self-reminder.db` was, for a while, the counter-example that proved the rule.
Its DDL sat inline in the daemon's `main.ts` while the hub wrote rows to it —
§ 8.5 lets a reminder be scheduled with the daemon down, so the hub must be able
to create the table it writes. It could not, so every reminder RPC failed on any
state directory the daemon had not touched first. The schema is in `store` now
and both processes migrate it.

### Two agent lists, on purpose

`agents.db:agents` is the mesh registry: identities that may participate, with
their type and last-seen. `agent-mesh.db:agent_registry` is what the web UI
lists, including web users with an approval flag. They overlap and are not the
same question — SPEC § 9.1 says so explicitly.

A person now appears in both, and the difference is what each answers. The
registry here says who the web surface shows and whether their access was
approved; the mesh registry says the identity exists and what type it is. A
person is provisioned into it as `human` when an operator approves them, over
the hub's own `POST /api/v1/agents` rather than by writing the file — the hub
owns those rules and is where they are stated once.

Before that they had no mesh identity at all. The hub routed their messages and
stored their name in `messages.from_agent` with no record that the name belonged
to anyone, and `proxy_for` was the only place their existence appeared.

The related distinction: an **identity** is permanent and unique on the mesh; a
**name** is display text, may repeat, and may change. Only identity carries the
uniqueness rules.

A person's identity is their GitHub login verbatim, which is also the
`github_login` this server authorises them by and sends as `from`. Nothing is
normalised between them, and SPEC § 10.1 was changed so that nothing has to be:
identities are compared case-sensitively and kebab-case is a recommendation
rather than a rule.

That rule was written when every identity was a service an operator named. It
stopped being right the moment a person could hold one — GitHub permits
uppercase, and lowercasing to fit would have split the identity from the `from`
sent on the same person's behalf. It was excluding real participants to preserve
a naming convention. A login the loosened rule still rejects is approved as a web
user and logged as not registrable, which is visible rather than silently
half-working.

### Why three files rather than one

Retention. Identity is small and
permanent; messages are operational and short-lived; audit is kept
indefinitely. One file means one backup policy, one `VACUUM`, and — the part
that matters — audit growth filling the disk takes message routing down with
it. Separate files can go on separate volumes.

The schemas were already separate modules in `store`, which is why splitting
the files was a second handle at the call site rather than an untangling.

---

## 2b. Two ways in

The hub speaks the same methods over two transports, and a participant uses
whichever it can.

**A WebSocket**, for anything with a process of its own. It connects, is marked
online, and is pushed to.

**One HTTP request at a time** (`POST /api/v1/rpc`, SPEC § 8.10), for anything
without one. An agent driven by an application is awake only while it is
answering: no process between turns, so no connection to hold and nowhere to be
pushed to. It sends when awake and drains its inbox when it next is.

The second is not a second service. Same methods, same signing construction,
same errors, same queue — the pending rows an adapter is handed on connect are
the rows `mesh.receive` returns. What differs is only what the transport can
support:

| | socket | HTTP |
|---|---|---|
| identity from | `mesh.connect` | `sig.kid` |
| may be unsigned | if the type permits | never — nothing else says who is asking |
| appears online | yes | **no** |
| `proxy_for` | yes | no — it is declared at connect |
| delivery | pushed | pulled, at-least-once under a lease |

"Never online" is the consequence worth stating: a sender addressing a
socketless participant is told `pending`, not `delivered`, because there is
nowhere to push and saying otherwise would be false.

Delivery to a puller is at-least-once. A batch is leased and comes back unless
acknowledged, which a caller does on its next fetch rather than in a separate
call — one round trip, no window, and nothing lost when a turn ends before the
messages are written down. Duplicates are the cost, against a stable id.

---

## 3. Package layout

```
packages/
├── store/            schema, handles, and the rules both services apply
├── log/              one log line shape, and the counter that shadows it
├── mailbox/          store and forward, knowing nothing about the hub
├── hub/              the broker                    :3100
├── http/             the human surface             :3000
├── platform-web/     the admin console             :3005
└── self-reminder/    the scheduler
```

`store` grew past schema at 0.2, and deliberately. The key lifecycle, the
entitlement rule, signature verification and upload grants are all run by *both*
services — the hub accepts key proposals while http approves them, the hub
verifies request signatures while http verifies upload ones. Two
implementations of one state machine are two sets of edge cases, and the edge
cases are the whole of it.

Seven packages rather than one because they deploy as separate units and have
genuinely different dependencies — http pulls `hono` and `web-push`,
self-reminder pulls `cron-parser` and `ws`, platform-web pulls React and Vite,
and the hub, `store`, `mailbox` and `log` pull nothing.

Three of them are libraries the services share rather than things that run, and
each is here because two implementations of one thing are two sets of edge
cases: `store` for the schemas, `mailbox` for store-and-forward, `log` for the
line every service writes.

There is no `apps/` versus `libs/` split. Seven packages do not need it.

**This list was four for a while after it was seven.** `mailbox`,
`platform-web` and `log` arrived without it moving, which is the kind of thing
a reader has no way to notice — a document naming four packages reads exactly
like a repository with four. `test/import-graph.test.ts` reads the directory
and fails when a package is not named here.

### hub

```
main.ts        config, Bun.serve, heartbeat, shutdown
db.ts          handles and prepared statements
jsonrpc.ts     framing and error codes
presence.ts    online, proxy and ownership maps
signature.ts   per-request verification, freshness, nonce window
raw-params.ts  locating the params bytes as they arrived
blobs.ts       where attachment bytes live
audit-limits.ts what the hub advertises, taken from the contract
rpc/           connect · send · receive · agents · messages · reminders · audit · dispatch
rest/          identity provisioning, teardown, key status
```

`audit-limits.ts` is separate from `rpc/audit.ts` for the reason its comment
gives: the hub once advertised capabilities of its own invention, and the check
that they match the contract has to run without opening a database or it runs
too late to catch that.

`raw-params.ts` is separate from `signature.ts` for a reason worth stating: the
scan is a pure function over text, and `signature.ts` opens the database at
module load. Splitting them is what makes the scan testable without a state
directory — and it is the piece most able to disagree with a client silently,
since a wrong span does not throw, it just fails to verify.

Statements are prepared once at module load: they are on every hot path, and
re-preparing per call would dominate each one.

The handlers reach module-level singletons rather than taking a context
argument. Passing state in would test better; that is a redesign, and the split
that produced these files was a move.

### http

```
main.ts        routes, SSE fan-out, the audit poller, wiring
db.ts          agent-mesh.db, and the registry.json import that predates it
auth.ts        GitHub OAuth and JWT
provision.ts   registering an approved person as a mesh identity
keys-admin.ts  an operator's key decisions
audit-blobs.ts the streaming blob upload
audit-query.ts the audit read API
ui/            theme · landing · chat · admin
```

Three of those exist here rather than on the hub because each needs something
the hub does not have. Key approval needs to know who is asking, and the hub
authenticates nobody — an approval route there would let a caller approve its
own key, which is the one thing the procedure exists to prevent. The audit query
needs the admin session. The blob upload needs neither, but § 9.1 puts the blob
routes alongside the other attachment storage, which is here.

**The pages are template literals that return strings, not static assets.**
That is what lets this service run with no build step, and it is a deliberate
trade: the markup is harder to edit, and there is nothing to compile, bundle,
version or serve. What was wrong before was that they lived *in the route
file*, not that they are inline.

### scripts

```
e2e-harness.ts           brings a real mesh up for the client's E2E runner
mesh-mail.ts             the reference client for the socketless transport
collect-orphan-blobs.ts  § 15.6 orphan collection, for a timer
```

Both are documented surfaces rather than conveniences. The harness is the
platform's half of a contract with another repository (`docs/e2e-platform.md`).
`mesh-mail.ts` is the client its own authors use — a transport nobody calls by
hand is one whose ergonomics nobody has checked.

### log

One log line shape for every service, and the counter that shadows it.

The three services had written three shapes — `[hub] <ISO> <sentence>`,
`[self-reminder <ISO>] <event> {json}`, and fifty-six bare `console.*` calls in
http with a bracketed subsystem each caller invented. An operator reading one
incident across two of them had to know all three, and nothing
machine-readable came out of any.

A call writes a sentence for a person and fields for a program at once, and
increments a counter keyed `(component, event, reason)` — one call, so a line
cannot happen uncounted and a counter cannot describe an event nobody logged.
That is what makes a quiet service readable: a counter at zero since boot says
the path is alive and silent, where no counter says only that nobody looked.

`docs/LOGGING-OPS.md` is how to read the result; `test/logging-ops.test.ts`
holds that document to these sources.

### platform-web

The admin console: React and Vite, served on `:3005` in development and built
into a bundle http serves in production. It talks to http over the same routes
an operator's `curl` would.

### self-reminder

Connects to the hub as `identity=self-reminder`, polls its own database for due
rows, and re-injects payloads at fire time with at-least-once semantics.
Consumers deduplicate; the scheduler does not promise exactly-once.

---

## 4. How a message moves

**Agent to agent.** `mesh.send` → the hub persists to `messages` → if the
recipient's socket is in `onlineAgents` (or `proxyMap`), push `mesh.message`
and mark delivered; otherwise leave it pending. On the recipient's next
`mesh.connect`, `deliverPending` replays everything queued for it.

The sender also gets `mesh.delivered`, but only when delivery actually
happened — SPEC § 8.8.2 is explicit that it is not emitted for a pending
message.

**Browser to agent.** The browser POSTs to http, which sends over its own hub
socket with `from` set to the web user it proxies for. This is why `mesh.send`
accepts a `from` override at all.

At 0.2 that override becomes constrained: `from` must be the connected identity
or an entitled `proxy_for` entry. Today it is accepted unchecked, which is
listed among the open questions rather than defended.

A message to an identity that does not exist is queued — it may be provisioned
later (SPEC § 3.1). A message to one that has been **torn down** is refused,
because it never will be.

**Channel traffic** does not pass through the hub. A channel-driver forwards to
its lane's runtime-adapter directly, which keeps the hub out of the real-time
path; the adapter records it asynchronously from a durable outbox. That is the
audit design, and it lives in
[`agent-mesh-client`](https://github.com/sir-mirr/agent-mesh-client), which
holds a lane per agent inside one per-host daemon.

---

## 5. Identity and trust, today

0.2 answered four of the five things that were wrong here. What follows is what
holds now, and what still does not.

### What a request has to prove

`mesh.connect` and every request after it carry a signature, verified against
the identity's **currently approved** key. Whether a signature is required is a
property of the identity's type (`agent_types.requires_key`), never of whether
a key happens to exist — the earlier draft verified only where one did, which
let a caller register without a key and then connect unsigned.

The key is read per request rather than cached for the connection. Caching would
make revocation take effect only when the socket happened to close, which is
precisely the case revocation exists for. Reading the row costs about a
twentieth of the verification it feeds, so there is nothing to trade.

`iat` must be within ±120 s and a nonce may not repeat inside that window. The
nonce set is in memory: it only has to be unrepeatable for the width of the
window, since outside it the freshness check rejects the request anyway.

### What a key has to go through

A key is proposed by anyone — that is what lets provisioning stay
unauthenticated, because a proposal grants nothing — and is inert until an
operator approves it. Approval runs on http behind the admin gate and **cannot**
run on the hub: the hub authenticates nobody, so an approval endpoint there
would let a caller approve its own key and turn the procedure into a formality.

Decisions are addressed by fingerprint, never by identity. Approving "whatever
is pending for X" approves whatever arrived last, including a proposal that
landed between reading the screen and clicking — and the fingerprint is the
string SPEC § 10.2 requires the operator to have compared against the one the
holder logged.

### Who may speak for whom

`from` must be the connected identity, or an identity the socket declared in
`proxy_for` and is entitled to proxy. Entitlement is two conditions: the
proxying identity carries `can_proxy`, and the subject's type has
`requires_key = 0`.

The second is the substantive one, and it is a type lookup rather than a grant
table because that makes it true rather than merely configured — an identity
that can hold a key signs for itself, so a proxy claim over it is either
redundant or a lie. The first exists because the second alone would let the
scheduler speak for a person; it is a `service` exactly as the web gateway is.

Both are read per request against stored rows. An operator who withdraws a grant
means it from that moment.

### What is still open

- **The hub is unauthenticated for provisioning and teardown.** Provisioning
  being open is survivable, since a proposal grants nothing. Teardown is not
  mitigated by anything: an unauthenticated caller can still take any identity
  offline permanently.
- **Traffic is plaintext `ws://`.** SPEC § 14.2 states this.
- **`can_proxy` is self-asserted.** http sets it on its own row when it
  registers, which follows from provisioning being unauthenticated.
- **A type with `requires_key = 0` connects unsigned.** That is the design, not
  a gap — but it means the guarantee is per type, and a deployment that wants
  its services authenticated has to raise the flag.

`docs/deferred.md` carries these with the rest.

---

## 6. Contracts

`@agent-mesh/contracts` (<https://github.com/sir-mirr/agent-mesh-contracts>) holds
the types, constants and byte-level fixtures both this repository and the lane
implementations are checked against. Delivered as an immutable Git tag rather
than a registry publish — no scope to claim, no token in CI, and the lockfile
pins the commit.

It ships TypeScript source with no build step, for the same reason the pages
are inline: both consumers run Bun with TypeScript 7, so there is nothing to
compile and nothing that can drift from its source.

This repository depends on it as of 0.2, pinned to `v0.34.0`. It supplies the
signature preimages, the key fingerprint, the identity pattern and the blob key
rule — every value both sides must derive identically — and, since, the § 11
capability vocabulary, the error codes, what a teardown answers (§ 9.3) and the
shapes of the REST routes the console reads (§ 9.1). The fixtures run in this
repository's CI as well as the contract repository's, which is the point of
them: two implementations agreeing is only tested where both are present.

---

## 7. Testing

**Unit tests** sit beside the code they cover. They test logic that can be
reached without a running process — schema migration, scheduler arithmetic,
connection ownership, the contract encoders.

**Integration tests** (`test/`) start the real services as child processes
against a throwaway state directory. They exist because the failures worth
catching there are wiring failures: a handler that is correct but unreachable,
two services that no longer find each other, a page that still compiles after
being moved and no longer renders.

They spawn rather than import, because each entrypoint calls `Bun.serve` at
module scope — importing one binds a port as a side effect.

CI runs typecheck, unit and integration on every push and pull request.

---

## 8. Deliberate limits

Things that look like gaps and are choices, so they are not "fixed" by
accident.

| | Why |
|---|---|
| No build step anywhere | Pages inline, contracts as source. The cost is markup in template literals; the gain is that what runs is what is in the repository. |
| Hub is single-process | Presence is in memory. Horizontal scale needs a shared presence store, which is a design, not a config change. |
| `mesh.fetch_messages` has no cursor | SPEC § 8.4 dropped the `before` parameter as unimplemented. Long histories are not reachable past `limit`. |
| Message content stored more than once | `hub.db` for routing, `agent-mesh.db` for the web UI. Predates this layout and has not been reconciled. |
| Attachment download is unauthenticated | Ids are sha256 digests, so this is capability-style access. SPEC § 15.3 states it; whether it is sufficient is open. |
| Audit rows are never pruned | Retention is indefinite by decision. On exhaustion the hub keeps routing and refuses audit writes with `-32044`; it does not delete to make room. Only blobs no event ever referenced are collectable, which is what `scripts/collect-orphan-blobs.ts` does. |
| One approved key per identity | Fits an installed agent on one machine. It is also why people are proxied rather than signing for themselves. |

---

## 9. Where to read next

| | |
|---|---|
| `SPEC.md` | the normative contract, and the 0.2 status table |
| `docs/decisions/identity-and-authentication.md` | why 0.2's auth design is shaped the way it is |
| `docs/decisions/unknown-error-codes.md` | what a pinned side does with a code its tag cannot name |
| `docs/decisions/checks-that-check-nothing.md` | why every checker here is mutation-tested before it is trusted |
| `docs/decisions/mailbox-and-hub.md` | why the mailbox does not know the hub exists |
| `docs/LOGGING-OPS.md` | the log line, the counters, and answering a complaint from them |
| `docs/proposals/audit-ingestion-response.md` | the audit interface, as negotiated with the client team |
| `docs/open-questions.md` | what is undecided, and what depends on it |
| `ops/README.md` | deployment |
