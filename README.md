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
                 │  OAuth, PWA        SQLite hub.db         │
                 │                                          │
                 │            agent-mesh-self-reminder      │
                 │            cron / once / in              │
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
| `agent-mesh-hub`            | 3100 | JSON-RPC 2.0 over WebSocket broker; SQLite `hub.db`        |
| `agent-mesh-http`           | 3000 | Hono REST API + SSE + GitHub OAuth + admin + Web Push/PWA  |
| `agent-mesh-self-reminder`  | —    | Scheduler (cron / once / in), at-least-once delivery       |

The hub's `ExecStartPost` runs `ops/bin/bootstrap-hub-service-identities.sh`,
which idempotently UPSERTs the service identities it discovers from the env
layout (4 sources: `shared/http.env`, `shared/self-reminder.env`,
`*/adapter.env`, `*/discord.env`) so the mesh has a known initial agent set
on first boot. The set is dynamic — see `SPEC.md` § 10 for the normative
discovery contract.

### Add-on — a *lane* (runtime-adapter + channel-driver)

A lane is a systemd-templated instance (`@<lane>`) that joins one external
runtime to one external channel. Each lane gets its own env, secrets, state,
and attachments directory. N lanes are supported via systemd template
instantiation; ports follow a fixed offset rule.

| Lane element      | Role                                  |
|-------------------|---------------------------------------|
| runtime-adapter   | Wraps an external runtime; owns the lane's hub connection |
| channel-driver    | Wraps an external channel; forwards to the adapter        |

**Both are built in a separate repository.** This one holds the baseline they
attach to, the contracts they implement (`SPEC.md` §§ 4–6), and the two
contract they consume, `@agent-mesh/contracts`.

Every lane includes a runtime-adapter. A channel-driver forwards to it and
does not connect to the hub itself (`SPEC.md` §§ 4.1, 6.1).

---

## Quick start (Baseline only)

Prerequisites:

- Linux host with systemd
- [Bun](https://bun.sh) runtime
- SQLite 3
- A GitHub OAuth app (for the HTTP admin login)

```bash
# 1. Clone
git clone https://github.com/sir-mirr/agent-mesh-platform.git
cd agent-mesh-platform

# 2. Install
bun install

# 3. Provision env files (see SPEC.md "env layout")
# Required: env/shared/{common,hub,http,self-reminder}.env
#           secrets/shared.env  (GITHUB_CLIENT_SECRET, JWT_SECRET, VAPID_*)

# 4. Install the three baseline systemd units (templates in ops/systemd/)
sudo cp ops/systemd/agent-mesh-{hub,http,self-reminder}.service \
        /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now \
    agent-mesh-hub agent-mesh-http agent-mesh-self-reminder

# 5. Verify
curl -fsS http://localhost:3000/api/v1/health
```

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
        │ hub.db, uploads/ (attachments)       │
        └────────────┬─────────────────────────┘
                     │ ws://<core-vm>:3100/ws
                     │ identity-only auth
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
- **Auth** — identity-only. The lane's `mesh.connect` identity string
  is the credential; there is no separate per-lane bearer token for hub
  access.
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
from a separate repository. This one provides the baseline they attach to, the
contract they implement (`SPEC.md` §§ 4–6), and the two packages they consume:
`@agent-mesh/contracts`.

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
  per-agent event streams, `/auth/github` (GitHub OAuth → JWT HS256), an
  admin panel for pending-pair approval, Web Push (VAPID), and a PWA
  bundle.
- **Self-reminder** (`packages/self-reminder`) — Independent scheduler
  daemon. Connects to the hub as `identity=self-reminder`, accepts schedule
  requests over the mesh, persists them, and re-injects payloads at fire
  time with at-least-once semantics.
- **Contracts** ([`agent-mesh-contracts`](https://github.com/sir-mirr/agent-mesh-contracts))
  — the types and fixtures both sides are checked against: `envelope`,
  `signature`, `blob-key`, `audit`, `errors`, `attachment`, `ownership`,
  `capabilities`, `tool-contract`. Not in this repository.
- **Lanes** — One runtime-adapter plus zero or more channel-drivers, joined by
  an intra-lane HTTP control plane. The adapter holds the lane's single hub
  connection. Built and deployed from a separate repository.

---

## Tech stack

- **Runtime**: Bun
- **Web framework**: Hono
- **Storage**: SQLite via `bun:sqlite`
- **Inter-agent transport**: JSON-RPC 2.0 over WebSocket
- **Streaming**: Server-Sent Events (SSE)
- **Auth**: GitHub OAuth + JWT (HS256)
- **Notifications**: Web Push (VAPID)
- **Process supervision**: systemd (templated units)

---

## API at a glance

### Hub JSON-RPC (`ws://<host>:3100`)

| Method                 | Purpose                                              |
|------------------------|------------------------------------------------------|
| `mesh.connect`         | Connect identity (optionally `proxy_for[]`) — SSOT   |
| `mesh.register`        | Deprecated alias of `mesh.connect` (see SPEC §8.1a)  |
| `mesh.send`            | Send an envelope to another identity                 |
| `mesh.list_agents`     | Enumerate registered agents and online status        |
| `mesh.fetch_messages`  | Pull stored history for a peer                       |

### HTTP REST (`http://<host>:3000`)

| Path                                | Description                          |
|-------------------------------------|--------------------------------------|
| `GET  /api/v1/health`               | Liveness / version                   |
| `GET  /api/v1/agents`               | List agents                          |
| `POST /api/v1/messages`             | Send an envelope                     |
| `GET  /api/v1/messages/:agent`      | Per-peer history                     |
| `GET  /api/v1/messages/search`      | Full-text search                     |
| `GET  /api/v1/events/:agentId`      | SSE event stream                     |
| `POST /api/v1/upload`               | Upload an attachment                 |
| `GET  /api/v1/files`                | Serve a single file by `?path=` query |
| `*    /api/v1/admin/*`              | `pending` / `approve` / `deny`       |
| `POST /api/v1/push/subscribe`       | Web Push subscription                |
| `GET  /auth/github`, `/auth/me`     | GitHub OAuth + JWT session           |

Full request/response shapes and auth requirements are in `SPEC.md`.

---

## Repository layout

```
.
├── README.md                      # this file
├── SPEC.md                        # normative contracts
├── MIGRATION.md                   # legacy → normalized migration notes
├── docs/
│   ├── decisions/                 # settled design, with the reasoning
│   ├── proposals/                 # cross-team interface work
│   └── open-questions.md
├── ops/
│   ├── bin/bootstrap-hub-service-identities.sh
│   ├── env/shared/                # baseline env examples
│   ├── migrations/                # forward-only SQL
│   └── systemd/                   # the three baseline units
├── packages/
│   ├── store/                     # schema and access for the shared databases
│   ├── hub/                       # JSON-RPC 2.0 broker (port 3100)
│   ├── http/                      # REST + SSE + OAuth + PWA (port 3000)
│   │   └── src/ui/                #   server-rendered pages
│   └── self-reminder/             # scheduler daemon
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

## Contributing

PRs are welcome at any time — this is a young PoC and we'd love help shaping
it. Bug fixes, doc clarifications, or just questions are all fair game. See [`CONTRIBUTING.md`](CONTRIBUTING.md)
for a quick orientation (clone, `bun install`, `bun run typecheck`) and a few
light conventions. No CLA, no strict gatekeeping — just keep PRs focused and
have fun.

## License

Licensed under the [MIT License](LICENSE). © 2026 Sir-Mirr.
