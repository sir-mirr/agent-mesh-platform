# agent-mesh

A multi-agent communication mesh: a self-contained backbone for routing
JSON-RPC messages, REST/SSE traffic, scheduled reminders, and external
runtime/channel adapters between heterogeneous AI agents.

> Status: Proof of Concept. APIs and on-disk layout may change before 1.0.

agent-mesh decouples *what runs the agent* (a runtime such as the Codex CLI,
Anthropic's Claude Code, GPT, Gemini, etc.) from *how the agent reaches users*
(a channel such as Discord, Telegram, Slack, or a Web UI). Both sides plug
into a single shared backbone via well-defined contracts.

---

## At a glance

```
                 ┌──────────────────────────────────────────┐
                 │              Baseline (shared)           │
                 │                                          │
   external ───► │  agent-mesh-http   agent-mesh-hub        │
   clients       │  :3000  REST/SSE   :3100  JSON-RPC WS    │
                 │  sign-in, PWA      + POST /api/v1/rpc    │
                 │                                          │
                 │            agent-mesh-self-reminder      │
                 │            once / interval / cron        │
                 │                                          │
                 │  agents.db  hub.db  audit.db  uploads/   │
                 └──────────────────────────────────────────┘
                                  ▲
                                  │  hub WS  /  HTTP REST
                  ┌───────────────┼───────────────┐
                  │               │               │
            ┌─────┴────┐   ┌──────┴─────┐   ┌─────┴─────┐
            │ lane A   │   │ lane B     │   │ lane C    │
            │ codex    │   │ claude     │   │ ...       │
            │ +discord │   │ +discord   │   │           │
            └──────────┘   └────────────┘   └───────────┘
                  Add-ons  =  runtime-adapter + channel-driver
```

Run the **Baseline** alone and you have a working mesh that accepts
registrations, routes messages, schedules reminders, and exposes a REST/SSE
API — even with zero agents connected. **Add-ons** (lanes) plug external
runtimes and channels onto that backbone.

---

## Baseline vs Add-on (core principle)

agent-mesh enforces a strict separation between two kinds of components.

### Baseline — the shared runtime (3 services)

The backbone. Always-on, runtime-agnostic, channel-agnostic. Agent count
can be zero and these three still run cleanly.

| Service                     | Port | Role                                                       |
|-----------------------------|------|------------------------------------------------------------|
| `agent-mesh-hub`            | 3100 | JSON-RPC 2.0 broker over WebSocket, and over HTTP for callers that cannot hold a socket |
| `agent-mesh-http`           | 3000 | Hono REST API + SSE + sign-in (local password or GitHub OAuth) + admin + Web Push/PWA |
| `agent-mesh-self-reminder`  | —    | Scheduler (once / interval / cron), at-least-once delivery |

Storage is four SQLite files, not one (`SPEC.md` § 3.1). `agents.db` holds
identity and keys, `hub.db` message routing, `audit.db` events and their
attachment references, `self-reminder.db` scheduler state. Audit does not share
a file with `messages`: audit growth must not be able to take routing down with
it, and the two rotate on completely different policies (§ 15.6).

The hub's `ExecStartPost` runs `ops/bin/bootstrap-hub-service-identities.sh`,
which idempotently provisions the **baseline** service identities it discovers
from the env layout — `shared/http.env` and `shared/self-reminder.env` — so the
mesh has a known initial agent set on first boot. It provisions them through
`POST /api/v1/agents` and never opens `hub.db`.

It does **not** walk the env tree for lane identities. 0.2 removed hub-direct
forwarding, so a channel-driver holds no hub identity, and lane components are
not deployed from this repository; a lane provisions its own identity through
the same endpoint. See `SPEC.md` § 10 for the normative discovery contract.

### Add-on — a *lane* (runtime-adapter + channel-driver)

A lane is a systemd-templated instance (`@<lane>`) that joins one external
runtime to one external channel. Each lane gets its own env, secrets, state,
and attachments directory. N lanes are supported via systemd template
instantiation; ports follow a fixed offset rule.

| Lane element      | Role                                  |
|-------------------|---------------------------------------|
| runtime-adapter   | Wraps an external runtime; owns the lane's hub connection |
| channel-driver    | Wraps an external channel; forwards to the adapter        |

**Both are built in
[`sir-mirr/agent-mesh-client`](https://github.com/sir-mirr/agent-mesh-client)**,
which is the lane side of this mesh: an installable local daemon that runs an
agent runtime, attaches channel drivers to it, and connects to this hub. This
repository holds the baseline it attaches to and the contract it implements
(`SPEC.md` §§ 4–6); the wire types both sides consume come from
`@agent-mesh/contracts`, pinned to the same tag on both.

Every lane includes a runtime-adapter. A channel-driver forwards to it and
does not connect to the hub itself (`SPEC.md` §§ 4.1, 6.1).

---

## Quick start (Baseline only)

> **On a laptop, this is the wrong section.** It needs a Linux host with
> systemd and root, and every prerequisite below is a real one — an agent
> following it as a first reader could not get past them on macOS. For three
> processes on one machine with none of that, read
> [`docs/running-locally.md`](docs/running-locally.md), which was executed
> before it was written and prints what it printed.

Prerequisites:

- Linux host with systemd
- [Bun](https://bun.sh) runtime — SQLite is embedded via `bun:sqlite`, so no
  separate install is needed to *run* the mesh
- The `sqlite3` CLI, if you intend to apply `ops/migrations/` by hand
- A GitHub OAuth app — **optional.** Sign-in works without one: the first boot
  seeds a `platform-admin` local account and forces a password change. Set
  `AGENT_MESH_ADMIN_PASSWORD` before that boot on any host others can reach,
  or the seeded password is `admin` and the server says so in its log.

```bash
# 1. Clone
git clone https://github.com/sir-mirr/agent-mesh-platform.git
cd agent-mesh-platform

# 2. Install
bun install

# 3. Provision env files (see SPEC.md "env layout")
# Copy from ops/env/shared/{common,hub,http,self-reminder}.env.example
#           secrets/shared.env  (JWT_SECRET, VAPID_*, GITHUB_CLIENT_SECRET
#                                if you want the OAuth button to work)

# 4. Install the baseline systemd units (ops/systemd/)
sudo cp ops/systemd/agent-mesh-*.service ops/systemd/agent-mesh-*.timer \
        /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now \
    agent-mesh-hub-lab agent-mesh-http-lab agent-mesh-self-reminder-lab

# 5. Enable orphan blob collection (SPEC § 15.6 requires it out of process).
#    The timer, not the service — the service is what the timer triggers.
sudo systemctl enable --now agent-mesh-collect-orphans-lab.timer

# 6. Verify
curl -fsS http://localhost:3000/api/v1/health
curl -fsS http://localhost:3100/health     # reports agent_mesh_spec (§ 13)
```

Steps 1 to 3 run anywhere. Steps 4 to 6 install and start systemd units, so
they need the host — on a machine without systemd and root they do nothing, and
the `curl` checks in step 6 then have nothing to answer them. To reach the same
two answers on a laptop, start the processes directly:
[`docs/running-locally.md`](docs/running-locally.md).

At this point the mesh is live with zero agents. The HTTP server serves the
admin/PWA at `:3000`; the hub accepts JSON-RPC 2.0 WebSocket connections at
`ws://localhost:3100`.

---

## Deployment topology — internal-mesh v0.1

A single-host deployment (everything on one VM) is the default and easiest
path. For production-style isolation, agent-mesh also supports a
**cross-VM topology** called `internal-mesh v0.1`, in which the baseline
is centralized on one *core VM* and each lane runs on its own *lane VM*.
The two halves talk only over the internal network.

```
        ┌────────────── core VM ───────────────┐
        │ agent-mesh-hub      :3100  (WS)      │
        │ agent-mesh-http     :3000  (REST/SSE)│
        │ agent-mesh-self-reminder             │
        │ agents.db hub.db audit.db  uploads/  │
        └────────────┬─────────────────────────┘
                     │ ws://<core-vm>:3100/ws
                     │ Ed25519-signed requests
       ┌─────────────┼─────────────┐
       │             │             │
   ┌───┴───┐     ┌───┴───┐     ┌───┴───┐
   │ lane  │     │ lane  │     │ lane  │   (one VM per lane)
   │  VM A │     │  VM B │     │  VM C │
   │codex- │     │codex- │     │ ...   │
   │app/   │     │app/   │     │       │
   │adapter│     │adapter│     │       │
   │/disc. │     │/disc. │     │       │
   └───────┘     └───────┘     └───────┘
```

### Properties

- **Topology** — 1 core VM (hub + http + self-reminder + shared services)
  plus N lane VMs. Each lane VM hosts one runtime-adapter and its
  channel-driver(s).
- **Transport** — plain `ws://` on the internal network. TLS / `wss://`
  is not required at v0.1.
- **Auth** — **signed requests**, not identity-only. From 0.2 every
  JSON-RPC request carries an Ed25519 signature over its own bytes, and
  the hub verifies it against a key an operator approved (§ 8.1, § 10.2).
  The identity string names who is speaking; the signature is what makes
  the claim worth anything. There is still no per-lane bearer token — the
  key replaces it.
- **Bootstrap (MUST)** — lane VMs MUST NOT write to `hub.db` directly
  (no remote `sqlite3 INSERT`). Identity provisioning goes through the
  core hub's `POST /api/v1/agents` endpoint, after which the lane VM may
  connect and `mesh.connect` with the provisioned identity.
- **Deploy** — systemd template units like
  `agent-mesh-lane@<lane-id>.target` on each lane VM. Docker is not
  required. The lane VM only needs `bun` and a synced copy of the repo
  (e.g. `git clone` or `rsync`).
- **Ports** — once lanes live on separate VMs, the `i`-offset rule
  (§ 12 of `SPEC.md`) becomes optional: a lane VM may use the fixed
  base ports `4500` (codex-app-server), `4600` (adapter), `4610`
  (channel-driver) since there is no co-tenant. Only the hub URL is
  externalized via `HUB_URL`.
- **Lane env (systemd unit)** — at minimum:
  `HUB_URL=ws://<core-vm>:3100/ws`,
  `LANE_IDENTITY=<agent-name>`,
  `RUNTIME_ENDPOINT=http://localhost:4500` (and the usual lane secrets).
- **Discovery** — a lane VM only needs to know the hub URL. Peer
  locations are obtained from `mesh.list_agents`. All inter-agent
  traffic still flows through the hub (no P2P).
- **Attachments** — the core VM is the **sole primary store**. The
  HTTP server's `POST /api/v1/upload` writes bytes to the core VM's
  local disk; messages carry only attachment metadata (id, mime,
  size, sha256, download_url). Lane VMs **pull attachments on demand**
  from the core VM's `GET /api/v1/attachments/:id` when they are
  actually needed, and cache them locally under
  `/var/lib/agent-mesh/lane/<lane-id>/attachments-cache/`. Eviction is
  done by an out-of-process job (default: TTL 7d, optional 1 GiB size
  cap). Eager replication is prohibited. Lane disk footprint stays
  small and proportional to recent use.

For the normative rules, see `SPEC.md` § 14 "Cross-VM deployment
(internal-mesh v0.1)" and § 15 "Attachments pull-on-demand contract".
Bootstrap provisioning cross-references § 10 "Bootstrap contract".

---

## Add a lane

Lane components — runtime-adapters and channel-drivers — are built and deployed
from [`sir-mirr/agent-mesh-client`](https://github.com/sir-mirr/agent-mesh-client).
This one provides the baseline they attach to, the contract they implement
(`SPEC.md` §§ 4–6), and the package they consume, `@agent-mesh/contracts`.

What a lane needs from here:

1. **An identity, provisioned on the hub.** `POST /api/v1/agents` on the hub
   listener (`:3100`) is the only sanctioned path — see `SPEC.md` § 10.1.
   Cross-VM deployments already worked this way.
2. **A public key, approved by an operator.** From 0.2 a lane signs every
   request; the key is submitted with the identity and is unusable until
   approved. `SPEC.md` § 10.2, and `docs/decisions/identity-and-authentication.md`
   for why.
3. **The hub URL.** `ws://<core-vm>:3100/ws`. Peers are discovered through
   `mesh.list_agents`; nothing else is hard-coded.

```bash
curl -X POST "http://<core-vm>:3100/api/v1/agents" \
     -H 'content-type: application/json' \
     -d '{ "identity": "my-lane-1", "type": "ai-codex",
           "description": "Production lane 1",
           "public_key": "<base64url, 43 chars>" }'
```

Note that 0.2 removed hub-direct forwarding: a channel-driver no longer holds
a hub identity of its own, and every lane includes a runtime-adapter
(`SPEC.md` §§ 4.1, 6.1).

## Architecture overview

- **Hub** (`packages/hub`) — JSON-RPC 2.0 broker on a single WebSocket
  endpoint. Maintains the agent registry in SQLite. All inter-agent traffic
  is an envelope (see `envelope.ts` in `@agent-mesh/contracts`) routed by identity.
- **HTTP** (`packages/http`) — Hono server. Provides REST, SSE for
  per-agent event streams, sign-in for people (`/auth/local` with a seeded
  `platform-admin` account, or `/auth/github` — both mint the same HS256 JWT),
  an admin surface for key and user approval, Web Push (VAPID), and a PWA
  bundle with server-rendered pages under `src/ui/`.
- **Admin console** (`packages/platform-web`) — the React console an operator
  actually looks at: React 19, Vite, React Router. It is a client of
  `packages/http` and talks to nothing else. See *The admin console* below.
- **Mailbox** (`packages/mailbox`) — store-and-forward at the edge of the mesh,
  forbidden from importing the hub, and running in the hub's process today (see
  the note under *API at a glance*).
- **Log** (`packages/log`) — one log-line shape for every service, and the
  counters that shadow it, so an operator greps one format rather than four.
- **Store** (`packages/store`) — schema and access for the databases the
  baseline services share, including the WAL policy each one opens under.
- **Self-reminder** (`packages/self-reminder`) — Independent scheduler
  daemon. Connects to the hub as `identity=self-reminder`, accepts schedule
  requests over the mesh, persists them, and re-injects payloads at fire
  time with at-least-once semantics. A fired reminder is sent **from
  `self-reminder`**, not from the identity that scheduled it — the daemon is
  the sender at fire time, and claiming otherwise reads as a proxied send that
  § 8.2 refuses.
- **Contracts** ([`agent-mesh-contracts`](https://github.com/sir-mirr/agent-mesh-contracts))
  — the types and fixtures both sides are checked against: `envelope`,
  `signature`, `key`, `blob-key`, `audit`, `errors`, `attachment`, `ownership`,
  `capabilities`, `history`, `hub`, `mailbox`, `registry`, `schedule`,
  `action-proxy`, `tool-contract`. Delivered as an immutable Git tag, not in
  this repository.

  The fixtures are the point: they let the two implementations be **shown** to
  agree on bytes rather than assumed to. Every defect that a fully green local
  suite has missed here was a cross-implementation disagreement, because a test
  written against one side can only assert that side agrees with itself.
- **Lanes** — One runtime-adapter plus zero or more channel-drivers, joined by
  an intra-lane control plane. The adapter holds the lane's single hub
  connection. Built and deployed from
  [`sir-mirr/agent-mesh-client`](https://github.com/sir-mirr/agent-mesh-client).

---

## Tech stack

- **Runtime**: Bun
- **Web framework**: Hono
- **Storage**: SQLite via `bun:sqlite`
- **Inter-agent transport**: JSON-RPC 2.0 over WebSocket
- **Streaming**: Server-Sent Events (SSE)
- **Auth**: Ed25519-signed JSON-RPC requests between agents; for people, a
  local password (seeded `platform-admin`, change forced on first use) or
  GitHub OAuth — both end in the same JWT (HS256) session cookie
- **Admin console**: React 19 + Vite + React Router (`packages/platform-web`)
- **Notifications**: Web Push (VAPID)
- **Process supervision**: systemd (templated units)

---

## API at a glance

### Hub JSON-RPC (`ws://<host>:3100`)

Every request carries an Ed25519 signature over its own bytes (`SPEC.md` § 8.1).

| Method                      | Purpose                                              |
|-----------------------------|------------------------------------------------------|
| `mesh.connect`              | Connect identity (optionally `proxy_for[]`) — SSOT   |
| `mesh.register`             | Deprecated alias of `mesh.connect` (§ 8.1a)          |
| `mesh.send`                 | Send an envelope; `client_message_id` makes it idempotent |
| `mesh.receive`              | Drain the mailbox with a piggybacked ACK (§ 8.10.1)    |
| `mesh.list_agents`          | Enumerate registered agents and online status        |
| `mesh.fetch_messages`       | Pull stored history for a peer                       |
| `mesh.schedule_reminder`    | Schedule once / interval / cron (§ 8.5)              |
| `mesh.cancel_reminder`      | Cancel one, owner-scoped                             |
| `mesh.list_reminders`       | List your own                                        |
| `mesh.audit.prepare_blobs`  | Ask which attachment bytes the store already holds   |
| `mesh.audit.append`         | Commit one audit event (§ 8.9.3)                     |

Server-pushed notifications: `mesh.message`, `mesh.delivered` (§ 8.8).

### The mailbox stops when the hub stops

Worth knowing before relying on it. `packages/mailbox` holds store-and-forward
and is forbidden from importing the hub, but it **runs in the hub's process**, so
a hub that is down is a mailbox that is down. Mail is not accepted while the hub
is restarting.

The whole argument for separating them was that store-and-forward exists for
exactly the window in which the other end is absent, and that argument is not yet
delivered. Running the mailbox as its own service would deliver it and is a
deliberate non-goal today — recorded, with what it costs, in
[`docs/decisions/mailbox-and-hub.md`](docs/decisions/mailbox-and-hub.md).

Said here rather than only in that document because somebody deciding whether
mail survives a restart reads this file, and a limitation only the design notes
mention is a limitation nobody meets until it bites.

### Which port serves what

Two ports, and the split is not cosmetic. **The browser never talks to the hub.**

| | |
|---|---|
| **http, `3000`** | everything a person or an operator screen touches — `/auth/*`, `/api/v1/admin/*`, `/api/v1/audit/*`, `/api/v1/messages*`, SSE, uploads |
| **hub, `3100`** | everything an *agent* touches — provisioning, `/api/v1/rpc`, the signed mailbox routes, `/api/v1/capabilities` |

The http server is itself a client of the hub and speaks for the people signed
into it (§ 8.2, `proxy_for`). That is why a browser needs no hub socket, and why
the hub carries no CORS headers: nothing in a browser should reach it.

`/api/v1/agents` exists on **both**, split by method — `GET` on http lists the
registry for a screen, `POST` on the hub provisions an identity, and the hub's
`/api/v1/agents/{identity}/keys` reads a key back. A path-prefix proxy cannot separate
them, and does not need to: a browser wants the `GET` and nothing else.

### The admin console

`packages/platform-web` is the React console — React 19, Vite, React Router —
and it is a client of `:3000` like any other. There is a second, older surface:
`packages/http/src/ui/` server-renders `/admin` and `/chat` from the HTTP
process itself, which is what a deployment with no build step gets.

```bash
bun run start:web     # vite dev server, asks for :3005
bun run build:web     # type-checks, then builds to packages/platform-web/dist
```

The dev server proxies `/api` and `/auth` to `http://localhost:3000`, so the
browser sees one origin and no CORS is involved. Point it elsewhere with
`API_PROXY_TARGET`. **Read the port off vite's own output**: it asks for 3005
and moves when something already holds it, which is a laptop's normal state.

Cross-origin in production needs `AGENT_MESH_ALLOWED_ORIGINS`. It is empty by
default and empty means none, which is the right default for a server that
authenticates with a cookie — `cors()` with no argument would let any page make
an authenticated request on a visitor's behalf and read the answer.

### Signed mailbox surface (`http://<host>:3100`)

The same queue and the same identities as `/api/v1/rpc`, named so the surface
can be read. Signed with `Authorization: AgentMeshSig` (§ 9.2.1).

| Path | Description |
|------|-------------|
| `POST   /api/v1/mailbox/in` | Take delivery and settle the previous batch. A `POST` because it leases, settles and audits — a `GET` invites a proxy or a retry to consume a lease. |
| `POST   /api/v1/mailbox/out` | Send. |
| `GET    /api/v1/mailbox/out` | Sent messages nobody has been handed — the recall candidates, without bodies. |
| `DELETE /api/v1/mailbox/out/{id}` | Withdraw one. `409 ALREADY_DELIVERED` once the recipient has it. |
| `GET    /api/v1/mailbox/history?peer=` | Conversation with one peer. |
| `GET    /api/v1/capabilities` | **Unsigned.** What this deployment enforces. |

**Recall ends at hand-over, not at acknowledgement.** A leased message was
returned in a response, so the recipient holds it whether or not it survived to
say so. Withdrawing one they already have would make the sender the owner of
someone else's record — and every recall emits `mesh.message.recalled`, so the
trail cannot hold a `sent` with nothing saying it was taken back.

### Hub over HTTP (`POST http://<host>:3100/api/v1/rpc`)

The same methods for a participant that cannot hold a socket — an agent driven
by an application rather than a daemon, awake only while it is answering
(§ 8.10). Identity comes from the signature. `mesh.connect` and `mesh.register`
are absent: they mark a socket online and there is no socket, so a socketless
participant is never online and a sender addressing it is told `pending` rather
than `delivered`.

### Errors

Two things travel with a failure and they answer different questions.

`error.code` is the JSON-RPC number, and what it decides is **retry
policy** — via `ERROR_CLASS` in `@agent-mesh/contracts`:

| Class | What a client does |
|-------|--------------------|
| `transient` | Retry with backoff and jitter, no attempt ceiling. |
| `transient-operator` | Retry far more slowly, and say plainly that someone has to intervene. |
| `wait-approval` | A human must approve or restore a key. Never hot-loop. |
| `permanent` | Stop. Quarantine the payload and its blobs locally, and alert — **not** silent deletion. |

`error.data.code` is a string naming **which condition it was**. Several
conditions share one number: `-32000` is returned by the dispatcher's
last-resort guard, by a `mesh.send` that could not persist, by a reminder
store failure, and by an unclassified audit failure. Branching on the number
alone cannot tell them apart.

```ts
import { ERROR_CLASS, ERROR_DATA_CODE, errorClass, errorDataCode } from "@agent-mesh/contracts"

if (errorClass(err.code, "transient") === "permanent") deadLetter(event)
if (errorDataCode(err) === ERROR_DATA_CODE.AUDIT_APPEND_FAILED) …
```

**`errorClass` requires you to say what an unknown code means, and that is
deliberate.** A code this build has never seen is a version skew, and the right
answer differs by path: on the audit outbox `transient` is the safer miss,
because a wrong retry is bounded by your backoff ceiling while a wrong
quarantine has no ceiling and no automatic recovery. On connect or send there
is no queue to drain later, so `permanent` is safer.

What is not acceptable is a silent default. `ERROR_CLASS[code] ?? "transient"`
is the natural thing to write, and it is how a code the contract did not yet
name reached a deployed client as an unbounded retry against a path that was
already broken. A required argument cannot be silent, and it greps.

`SPEC.md` § 8.9.3 carries the full table.

### HTTP REST (`http://<host>:3000`)

| Path                                | Description                          |
|-------------------------------------|--------------------------------------|
| `GET  /api/v1/health`               | Liveness                             |
| `GET  /api/v1/agents`               | List agents                          |
| `POST /api/v1/messages`             | Send an envelope                     |
| `GET  /api/v1/messages/:agent`      | Per-peer history                     |
| `GET  /api/v1/messages/search`      | Full-text search                     |
| `GET  /api/v1/events/:agentId`      | SSE event stream — JWT as `?token=`, not a cookie |
| `POST /api/v1/upload`               | Upload an attachment                 |
| `GET  /api/v1/attachments/:id`      | Download attachment bytes (§ 15.3)   |
| `PUT  /api/v1/audit/blobs/{key}`    | Streamed blob upload, signature-authorised (§ 9.1) |
| `GET  /api/v1/audit/events`         | Cursor-paginated audit query         |
| `GET  /api/v1/files`                | Serve a single file by `?path=` query |
| `DELETE /api/v1/admin/agents/{identity}` | Identity teardown, soft delete (§ 9.3) |
| `*    /api/v1/admin/agent-types`    | The agent type registry: list / add / remove (§ 10.3) |
| `GET  /api/v1/admin/mailbox`        | Mailbox depth per identity (§ 9.2.1) — no message bodies |
| `GET  /api/v1/admin/mailbox/{identity}` | What is waiting for one identity, and what is leased |
| `*    /api/v1/admin/keys/*`         | Key approval: `pending` / `approve` / `deny` / `revoke` (§ 10.2.1) |
| `*    /api/v1/admin/*`              | User approval: `pending` / `approve` / `deny`, audits, AI usage |
| `*    /api/v1/admin/groups*`        | Groups and their egress rules — deny by default (SPEC § 12) |
| `*    /api/v1/admin/tenants*`       | Tenants, and the directory a console lists |
| `GET  /api/v1/admin/grants`         | The capability grant table, read per request (§ 11) |
| `GET  /api/v1/admin/agent-sources`  | Where each identity has been observed connecting from (§ 8.11) |
| `GET  /api/v1/admin/telemetry`, `/telemetry/behaviour` | What the mesh measured about itself |
| `GET  /api/v1/admin/chat-audits*`   | Recorded conversations, and a stream of new ones |
| `GET  /api/v1/admin/ai-usage`, `/ai-usage/stream` | Model spend, polled or streamed |
| `POST /api/v1/admin/pairing-codes`, `POST /api/v1/pairing-codes/redeem` | Ownership pairing (§ 11.3) |
| `*    /api/v1/push/*`               | Web Push: `subscribe` / `unsubscribe` / `vapid-key` |
| `POST /auth/local`, `/auth/local/password` | Password sign-in, and the forced change a seeded account walks out of |
| `GET  /auth/github`, `POST /auth/logout`, `GET /auth/me` | OAuth sign-in, sign-out, and who the session says you are |

**Auth has three states, not two** (`SPEC.md` § 9.1). No session is `401`; a
valid session for a user no operator has approved is `403`; an approved user
gets the route's own answer. A client that reads `403` as "wrong credentials"
and re-authenticates loops forever — `/auth/me` answers `200` with
`approved: false` and is how you tell the difference.

Full request/response shapes and auth requirements are in `SPEC.md`.

### Control plane (`http://<host>:3100`)

| Path                                    | Description                    |
|-----------------------------------------|--------------------------------|
| `GET    /health`                        | Liveness, online count, `agent_mesh_spec` (§ 13) |
| `POST   /api/v1/agents`                 | Provision an identity (§ 10.1); `create_only` refuses to take over an existing one |
| `GET    /api/v1/agents/{identity}/keys` | Key record and status (§ 10.2) |
| `GET    /api/v1/capabilities`           | **Unsigned.** What this deployment enforces, and in which mode |
| `GET    /api/v1/limits`                 | The sizes and rates this deployment will accept |
| `DELETE /api/agents/{identity}`         | **Refused** — teardown needs an admin session (§ 9.3) |

---

## Repository layout

```
.
├── README.md                      # this file
├── SPEC.md                        # normative contracts
├── DEPLOYMENT.md                  # deployment and operations guide
├── CONTRIBUTING.md                # clone, install, typecheck, conventions
├── CLAUDE.md                      # how the agents working here coordinate
├── MIGRATION.md                   # legacy → normalized migration notes
├── docs/
│   ├── architecture.md            # how this repository is built, and why
│   ├── running-locally.md         # three processes on a laptop, executed before written
│   ├── implementation-plan-0.2.md # what to build next, in order
│   ├── decisions/                 # settled design, with the reasoning
│   ├── proposals/                 # cross-team interface work
│   ├── open-questions.md
│   ├── deferred.md                # found, not fixed, and why
│   ├── operator-functional-spec.md, information-architecture.md, design-system.md
│   └── e2e-platform.md            # this side's half of the E2E scenarios
├── test/                          # integration — real processes, real ports
├── preview/                       # static screen previews, linted by scripts/lint-preview.ts
├── scripts/
│   ├── e2e-harness.ts             # stand up a mesh for the client's E2E run
│   ├── mesh-mail.ts               # reference client for the socketless transport
│   ├── coverage.ts                # the measurement, and the floor CI enforces
│   ├── mutation-check.ts          # the manifest: plant a defect, expect a suite to catch it
│   ├── lint-preview.ts            # preview/ against the capability vocabulary
│   └── collect-orphan-blobs.ts    # § 15.6 sweep, run by the timer below
├── ops/
│   ├── bin/bootstrap-hub-service-identities.sh
│   ├── env/shared/                # baseline env examples
│   ├── migrations/                # forward-only SQL
│   └── systemd/                   # baseline units + orphan-collection timer
├── packages/
│   ├── store/                     # schema and access for the shared databases
│   ├── hub/                       # JSON-RPC 2.0 broker (port 3100)
│   ├── mailbox/                   # store-and-forward; runs in the hub's process
│   ├── http/                      # REST + SSE + sign-in + PWA (port 3000)
│   │   └── src/ui/                #   server-rendered /admin and /chat
│   ├── platform-web/              # React admin console (vite dev :3005)
│   ├── log/                       # one log-line shape for every service
│   └── self-reminder/             # scheduler daemon
├── .github/workflows/ci.yml       # check · coverage floor · nightly mutation
├── package.json
├── bun.lock
└── tsconfig.base.json
```

What remains is exactly the baseline of `SPEC.md` § 3. Lane components live in
the lane repository, and the shared types in
[`agent-mesh-contracts`](https://github.com/sir-mirr/agent-mesh-contracts),
delivered as an immutable Git tag.

Instance data — env files, secrets, state, attachments, handoffs, channels —
lives **outside** the code repository and is not versioned here. See
`SPEC.md` § "Instance data layout".

---

## Working on it

```bash
bun run typecheck
bun run build:web      # the console; the browser scenarios need it built
bun test packages/     # unit
bun test test/         # integration — starts real hub and http processes
```

A failure in `test/` usually means wiring rather than logic: those tests spawn
the real entrypoints on real ports, and some of them drive a real browser
against the built console, because the bugs worth catching there are the ones
where each half works and the two disagree.

### What CI does

One workflow, `.github/workflows/ci.yml`, with three jobs.

| Job | When | What it does |
|---|---|---|
| `check` | every push and PR | typecheck, build the console, unit tests, integration tests, then the mutation manifest's *anchors* and its self-check |
| `coverage-floor` | pushes to `main`, after `check` | `bun scripts/coverage.ts --floor 99` — exits non-zero below the number and names which metric fell |
| `mutation` | nightly at 17:00 UTC, or on demand | plants every defect in the manifest across 8 shards, and files a `nightly-mutation` issue if a shard is red |

**Anchors are not the whole manifest.** An anchor check reads every entry
against the tree in about a second: an entry whose `from` string no longer
appears plants nothing, the suite passes, and the run reads as *the guard did
not catch it* — a false all-clear rather than a missing one. Planting all of
them is one suite per entry and hours of wall clock, which is why it is
nightly. Before starting work, read what the nightly said:

```bash
gh issue list --label nightly-mutation
bun run mutation-check -- --anchors      # every entry still points at one place
bun run coverage                          # the number, and what is left uncovered
```

### Coverage, and what the number means here

The floor is **99** and CI enforces it; the goal is **100**, and
`bun run coverage` prints where the tree actually is rather than leaving a
number in this file to go stale. Only `packages/http/src/ui/` is excluded from
the reported denominator, and the report prints the excluded files beside the
number rather than hiding them — an exclusion nobody can see is an exclusion
nobody re-argues.

The floor stays below the goal on purpose: a floor equal to the ceiling turns
every ordinary in-progress commit red and leaves no room to aim at.
[`docs/decisions/what-the-coverage-number-leaves-out.md`](docs/decisions/what-the-coverage-number-leaves-out.md)
records what a percentage cannot tell you, including the two kinds of function
no line-based report can point at.

`docs/architecture.md` explains how this repository is built and why;
`SPEC.md` is the contract any implementation satisfies. **When they disagree,
SPEC wins and the architecture document is wrong.**

---

## Contributing

PRs are welcome at any time — this is a young PoC and we'd love help shaping
it. Bug fixes, doc clarifications, or just questions are all fair game. See [`CONTRIBUTING.md`](CONTRIBUTING.md)
for a quick orientation (clone, `bun install`, `bun run typecheck`) and a few
light conventions. No CLA, no strict gatekeeping — just keep PRs focused and
have fun.

## License

Licensed under the [MIT License](LICENSE). © 2026 Sir-Mirr.
