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
which idempotently UPSERTs six built-in service identities so the mesh has a
known initial agent set on first boot.

### Add-on — a *lane* (runtime-adapter + channel-driver)

A lane is a systemd-templated instance (`@<lane>`) that joins one external
runtime to one external channel. Each lane gets its own env, secrets, state,
and attachments directory. N lanes are supported via systemd template
instantiation; ports follow a fixed offset rule.

| Lane element                       | Source                                |
|------------------------------------|---------------------------------------|
| `packages/runtime-adapters/<rt>`   | Adapter for an external runtime       |
| `packages/channel-drivers/<ch>`    | Driver for an external channel        |

Currently shipped: `runtime-adapters/codex` and `channel-drivers/discord`.
Future runtimes (claude, gpt, gemini, ...) and channels (telegram, slack, ...)
implement the same contracts (see `SPEC.md`).

---

## Quick start (Baseline only)

Prerequisites:

- Linux host with systemd
- [Bun](https://bun.sh) runtime
- SQLite 3
- A GitHub OAuth app (for the HTTP admin login)

```bash
# 1. Clone
git clone https://github.com/sir-mirr/ai-agent-mesh.git
cd ai-agent-mesh

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
- **Auth** — identity-only. The lane's `mesh.register` identity string
  is the credential; there is no separate per-lane bearer token for hub
  access.
- **Bootstrap (MUST)** — lane VMs MUST NOT write to `hub.db` directly
  (no remote `sqlite3 INSERT`). Identity provisioning goes through the
  core hub's `POST /api/v1/agents` endpoint, after which the lane VM may
  connect and `mesh.register` with the provisioned identity.
- **Deploy** — systemd template units like
  `agent-mesh-lane@<lane-id>.service` on each lane VM. Docker is not
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
- **Attachments** — the hub remains the **primary store**. The HTTP
  server's `/api/v1/upload` writes to the core VM's local disk. Lane
  VMs fetch attachments **pull-on-demand** when they are actually
  needed and cache locally under TTL or LRU. Eager replication is
  prohibited.

For the normative rules, see `SPEC.md` § 15 "Cross-VM deployment
(internal-mesh v0.1)". Bootstrap provisioning and attachment handling
cross-reference § 10 "Bootstrap contract" and § 6.1 (attachment
handling) respectively.

---

## Add a lane

A *lane name* is a short identifier (e.g. `prod-codex1`, `test-claude1`) used
as the systemd template instance and as the agent identity on the hub.

### Codex lane (3 units per lane)

Wires Anthropic-style tool use through the Codex CLI's app-server, an HTTP
adapter, and a Discord driver.

```
codex-app-server@<lane>     :4500+i   Codex CLI app-server (WS)
codex-adapter@<lane>        :4600+i   runtime-adapters/codex (HTTP, hub WS client)
channel-discord@<lane>      :4610+i   channel-drivers/discord (HTTP)
```

```bash
# Per-lane env + secrets
mkdir -p env/<lane> state/codex/<lane> attachments/<lane>
$EDITOR env/<lane>/{adapter,discord,app-server}.env
$EDITOR secrets/<lane>.env   # DISCORD_BOT_TOKEN,
                             # CODEX_ADAPTER_HTTP_TOKEN,
                             # CHANNEL_DISCORD_HTTP_TOKEN

# Enable the three template instances
sudo systemctl enable --now \
    codex-app-server@<lane> \
    codex-adapter@<lane> \
    channel-discord@<lane>
```

Driver ↔ adapter HTTP traffic is mutually authenticated using
`CHANNEL_DISCORD_HTTP_TOKEN` and `CODEX_ADAPTER_HTTP_TOKEN`. The adapter
registers with the hub using `identity = <lane>`.

### Claude lane (1 unit + external Claude Code)

For lanes powered by Anthropic's Claude Code CLI, the runtime is an external
process and joins the hub directly via an MCP plugin. Only the channel-driver
is hosted in-tree.

```
channel-discord@<lane>   :4610+i   channel-drivers/discord (HTTP)
                                   forwards directly to hub as <lane>
```

```bash
mkdir -p env/<lane>
$EDITOR env/<lane>/discord.env       # HUB_FORWARD_IDENTITY=<lane>
$EDITOR secrets/<lane>.env           # DISCORD_BOT_TOKEN

sudo systemctl enable --now channel-discord@<lane>
```

Then point an external Claude Code instance's agent-mesh MCP plugin at
`ws://<host>:3100` with `identity=<lane>`.

---

## Architecture overview

- **Hub** (`packages/shared/hub`) — JSON-RPC 2.0 broker on a single WebSocket
  endpoint. Maintains the agent registry in SQLite. All inter-agent traffic
  is an envelope (see `agent-mesh-core/envelope.ts`) routed by identity.
- **HTTP** (`packages/shared/http`) — Hono server. Provides REST, SSE for
  per-agent event streams, `/auth/github` (GitHub OAuth → JWT HS256), an
  admin panel for pending-pair approval, Web Push (VAPID), and a PWA
  bundle.
- **Self-reminder** (`packages/shared/self-reminder`) — Independent scheduler
  daemon. Connects to the hub as `identity=self-reminder`, accepts schedule
  requests over the mesh, persists them, and re-injects payloads at fire
  time with at-least-once semantics.
- **agent-mesh-core** (`packages/agent-mesh-core`) — Pure types and
  utilities: `envelope`, `action-proxy`, `capabilities`, `history`,
  `ownership`, `registry`, `tool-contract`, `hub` client base.
- **Lanes** — Each lane is one runtime-adapter instance plus zero or more
  channel-driver instances, joined by an HTTP control plane and a shared
  hub WS connection.

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
| `mesh.register`        | Register an identity (optionally `proxy_for[]`)      |
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
| `GET  /api/v1/files`                | List uploads                         |
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
├── instructions/                  # operator runbooks
├── ops/
│   └── bin/
│       └── bootstrap-hub-service-identities.sh
├── packages/
│   ├── agent-mesh-core/           # pure types, no I/O
│   │   └── src/
│   │       ├── envelope.ts
│   │       ├── action-proxy.ts
│   │       ├── capabilities.ts
│   │       ├── history.ts
│   │       ├── hub.ts
│   │       ├── ownership.ts
│   │       ├── registry.ts
│   │       └── tool-contract.ts
│   ├── shared/
│   │   ├── hub/                   # JSON-RPC 2.0 broker (port 3100)
│   │   ├── http/                  # REST + SSE + OAuth + PWA (port 3000)
│   │   └── self-reminder/         # scheduler daemon
│   ├── channel-drivers/
│   │   └── discord/src/
│   └── runtime-adapters/
│       └── codex/src/
├── package.json
├── bun.lock
└── tsconfig.base.json
```

Instance data — env files, secrets, state, attachments, handoffs, channels —
lives **outside** the code repository and is not versioned here. See
`SPEC.md` § "Instance data layout".

---

## Development

TBD. Contributions, issue templates, and CI will be added in a later phase.
For now, see `SPEC.md` for the contracts you must implement when authoring a
new runtime-adapter or channel-driver.

## Contributing

TBD.

## License

TBD (currently `Private`). To be set before public release.
