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
   (lane repository)
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
| `agents.db` | `agents`, `agent_types`, `agent_keys`, `agent_key_events` | rw | — (rw at step 2) | — |
| `hub.db` | `messages` | rw | ro | — |
| `agent-mesh.db` | users, policies, approvals, push subs, `agent_registry` | — | rw | — |
| `self-reminder.db` | reminders, scheduler state | rw | — | rw |
| `uploads/` | attachment bytes | — | w | — |

**More than one process opens some of these.** That is safe because every
handle sets `journal_mode = WAL` and `busy_timeout`, and because they are all on
one machine — SPEC § 14.1 pins hub and http to the same core VM. Writes
serialise; readers never block.

**The hub owns the DDL** (SPEC § 3.1). It is the only process that calls
`migrate`. Others open a store expecting its tables to be there.

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

### What 0.2 still changes

`agents.db` is split out. `upload_nonces` joins it at step 4, and http gains
read-write access at step 2 so an operator can approve a key. `audit.db`
appears alongside at step 7, written by the hub and read by http.

The reason for three files rather than one is retention. Identity is small and
permanent; messages are operational and short-lived; audit is kept
indefinitely. One file means one backup policy, one `VACUUM`, and — the part
that matters — audit growth filling the disk takes message routing down with
it. Separate files can go on separate volumes.

The schemas were already separate modules in `store`, which is why splitting
the files was a second handle at the call site rather than an untangling.

---

## 3. Package layout

```
packages/
├── store/            schema and handles for the shared databases
├── hub/              the broker                    :3100
├── http/             the human surface             :3000
└── self-reminder/    the scheduler
```

Four packages rather than one because they deploy as separate units and have
genuinely different dependencies — http pulls `hono` and `web-push`,
self-reminder pulls `cron-parser` and `ws`, the hub pulls nothing.

There is no `apps/` versus `libs/` split. Four packages do not need it.

### hub

```
main.ts        config, Bun.serve, heartbeat, shutdown
db.ts          handles and prepared statements
jsonrpc.ts     framing and error codes
presence.ts    online, proxy and ownership maps
rpc/           connect · send · agents · messages · reminders · dispatch
rest/          identity provisioning and teardown
```

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
ui/            theme · landing · chat · admin
```

**The pages are template literals that return strings, not static assets.**
That is what lets this service run with no build step, and it is a deliberate
trade: the markup is harder to edit, and there is nothing to compile, bundle,
version or serve. What was wrong before was that they lived *in the route
file*, not that they are inline.

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
audit design, and it lives in the lane repository.

---

## 5. Identity and trust, today

Honestly: there is none to speak of.

- `mesh.connect` takes an identity string and no credential. Anything that can
  reach `:3100` can connect as any provisioned identity that is currently
  offline.
- `POST /api/v1/agents` and `DELETE /api/agents/{identity}` are
  unauthenticated. The second is now a soft delete, so it no longer destroys
  message history, but an unauthenticated caller can still take any identity
  offline permanently.
- `proxy_for` is unchecked; a socket may claim to proxy anyone.
- `mesh.send`'s `from` is unchecked.

All of it is consistent with SPEC § 14.2, which states the v0.1 position
plainly: identity-only auth over plain `ws://` on a trust-bounded network. It
is a stated position, not an oversight — but it is also why 0.2 exists, and why
audit ingestion could not be built on top of it as proposed.

0.2 answers all four together with registered Ed25519 keys, an operator
approval procedure, and a signature on every request. The design is in
`docs/decisions/identity-and-authentication.md`; the reasoning is there because
the decisions do not compose if taken separately.

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

This repository does not depend on it yet. The baseline does not consume those
types today; it will when the 0.2 signature and audit work lands, and a
dependency ahead of its consumer is noise.

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

---

## 9. Where to read next

| | |
|---|---|
| `SPEC.md` | the normative contract, and the 0.2 status table |
| `docs/decisions/identity-and-authentication.md` | why 0.2's auth design is shaped the way it is |
| `docs/proposals/audit-ingestion-response.md` | the audit interface, as negotiated with the client team |
| `docs/open-questions.md` | what is undecided, and what depends on it |
| `ops/README.md` | deployment |
