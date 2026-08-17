# Running the mesh on a laptop

**This procedure was executed on macOS from a clean shell before it was written
down, and the outputs below are what it printed.** That is the only reason to
trust it. The `README.md` quick start has been there for months, requires a
Linux host with systemd and a GitHub OAuth app, and nobody on this project has
ever run it — `client-claude` tried to follow it as a first reader and could not
get past the prerequisites (mail #426).

For a real deployment, `README.md` and `ops/systemd/` are still the answer. This
is the other thing: three processes on one machine, no root, no OAuth app.

---

## What you are starting

Three services, and it matters which is which.

| | port | who talks to it |
|---|---|---|
| `agent-mesh-hub` | 3100 | **agents**, over WebSocket and signed HTTP |
| `agent-mesh-http` | 3000 | **people** — browsers, operator screens, the admin API |
| `agent-mesh-self-reminder` | none | nothing; it connects out to the hub |

**There are two different threes, and confusing them cost time today.** The
README's *Baseline* is the three above — hub, http, self-reminder — which is a
statement about what a deployment runs. The three somebody sets up to *look at
the admin screens* is hub, http and `platform-web`, and `platform-web` is not a
baseline service, does not appear in the README at all, and is not on `main`.
Both threes are correct; neither is the other. § 8 covers the front end.

**The browser never talks to the hub.** `agent-mesh-http` is itself a hub client
and speaks for the people signed into it (SPEC § 8.2). A front end pointed at
3100 will fail in ways that look like the hub is broken; it is not, it is being
asked a question by the wrong audience. The reverse mistake — API on 3100, WS on
3000 — reached this project once through a relayed configuration and was caught
by a grep rather than by anything failing.

## Prerequisites

- [Bun](https://bun.sh). SQLite is embedded through `bun:sqlite`, so there is
  nothing else to install.
- That is all. No systemd, no root, no GitHub OAuth app, no `sqlite3` CLI.

```bash
bun --version   # 1.3.13 when this was executed
```

**On ports.** 3100 and 3000 below are the defaults, and any free pair works —
the services take whatever `AGENT_MESH_HUB_PORT` and `AGENT_MESH_HTTP_PORT` say.
The verification run recorded here used **3110 and 3010**, because 3100 and 3000
were already held by long-running instances on the machine it ran on. That is
the ordinary case, not an exception: check before you assume.

```bash
for port in 3100 3000; do
  held=$(lsof -ti tcp:"$port" | tr '\n' ' ')
  printf ':%s -> %s\n' "$port" "${held:-free}"
done
```

One `lsof` per port, deliberately. `lsof -ti :3100 -ti :3000` looks like it asks
about both and does not report per port — on the machine this was written on it
printed 3100's three pids and said nothing about 3000, which was also taken.
A check that cannot say *which* port is busy is a check you act on wrongly.

## 0. Pick your two ports

Everything below uses these, so set them once and the blocks are copy-pasteable
whichever pair you ended up with.

```bash
export HUB_PORT=3100
export HTTP_PORT=3000
```

If the check above showed either as taken, choose another pair — `3110` and
`3010` is what the verification run used, for exactly that reason.

## 1. Install

```bash
git clone https://github.com/sir-mirr/agent-mesh-platform.git
cd agent-mesh-platform
bun install
```

## 2. Choose a state directory

Every service reads and writes SQLite files under one directory, and **they must
all be given the same one**. Nothing derives it, nothing defaults to a shared
place, and two services pointed at different directories come up healthy and
then disagree about every row.

```bash
export AGENT_MESH_STATE_DIR="$HOME/.agent-mesh/local"
mkdir -p "$AGENT_MESH_STATE_DIR"
```

**Create it.** The services do not. A missing directory produces
`SQLITE_CANTOPEN` about fifteen seconds before a health-check timeout that names
the port, so the error you finally read is about the wrong thing.

## 3. Start the hub

```bash
AGENT_MESH_STATE_DIR="$AGENT_MESH_STATE_DIR" \
AGENT_MESH_HUB_PORT="$HUB_PORT" \
AGENT_MESH_PROXY_IDENTITIES=http-server,http-server-dev \
AGENT_MESH_BLOB_BASE_URL="http://127.0.0.1:$HTTP_PORT" \
bun packages/hub/src/main.ts
```

`AGENT_MESH_PROXY_IDENTITIES` is § 8.2: the http server sends on behalf of the
people signed into it, and a deployment *declares* which identities may do that
rather than a process asserting it about itself.

`AGENT_MESH_BLOB_BASE_URL` is the address of the **http** server, given to the
hub. The hub answers `prepare_blobs` with an absolute upload URL, and the route
it names is served by the other process — it cannot work the address out,
because http connects to the hub and never the reverse.

Wait for it before starting anything else:

```bash
until curl -sf "http://127.0.0.1:$HUB_PORT/health" >/dev/null; do sleep 0.2; done
```

## 4. Start the http server

In a second shell. **`AGENT_MESH_STATE_DIR`, `HUB_PORT` and `HTTP_PORT` do not
travel between shells** — export them again here, with the same values:

```bash
export AGENT_MESH_STATE_DIR="$HOME/.agent-mesh/local"
export HUB_PORT=3100
export HTTP_PORT=3000

AGENT_MESH_STATE_DIR="$AGENT_MESH_STATE_DIR" \
AGENT_MESH_HTTP_PORT="$HTTP_PORT" \
AGENT_MESH_HUB_URL="ws://127.0.0.1:$HUB_PORT/ws" \
JWT_SECRET=local-development-only \
bun packages/http/src/main.ts
```

A second shell with a different state directory is the failure this repository
has already had: both services come up healthy and then disagree about every
row, because neither has any way to notice.

`JWT_SECRET` signs session cookies. Any string works locally; it is the one
value here that must not be shared with anything real.

`AGENT_MESH_ALLOWED_ORIGINS` is **empty by default, and that is not "allow
everything"** — it is the list of browser origins permitted to call this server
cross-origin. Same-origin requests need no entry, so a front end served through
the Vite proxy needs nothing here. A front end served from its own origin does:

```bash
AGENT_MESH_ALLOWED_ORIGINS=http://localhost:3005
```

## 5. Sign in

The first start seeds one local account. There is no OAuth app involved and no
approval step for this one.

```
username: admin
password: admin
```

```bash
curl -s -X POST "http://127.0.0.1:$HTTP_PORT/auth/local" \
  -H 'accept: application/json' -H 'content-type: application/json' \
  -d '{"username":"admin","password":"admin"}' -i | grep -i set-cookie
```

```
set-cookie: mesh_token=eyJhbGciOiJIUzI1N...
[db] seeded default admin local user      <- in the http server's own log
```

The session is in the cookie. It is deliberately **not** in the response body —
a caller holding the cookie does not need it, and a caller that stores it
somewhere else has made it a thing to steal.

## 6. Verify — by asking what is running, not by assuming

```bash
curl -s "http://127.0.0.1:$HTTP_PORT/api/v1/health"
curl -s "http://127.0.0.1:$HUB_PORT/api/v1/capabilities" | jq .platform
```

What that run actually printed:

```
http /api/v1/health : {"status":"ok","version":"20260817124845","agent_count":1,"uptime":6}
hub  provenance     : {'commit': '313715e9c69eff...', 'branch': 'main', 'dirty': True}
```

`dirty: True` there is not a defect in the procedure — it is the procedure
working. That run was started from a tree holding this very file, uncommitted,
so the hub correctly reported that it was serving something no commit contains.

**Read `dirty`.** `true` means the process is serving a tree that matches no
commit, so anything you measure is about bytes on a disk rather than about a
version. Two multi-message investigations here came from not having this field,
and once it existed it caught a bad instance within a minute.

## 7. Self-reminder (optional)

Not needed for the admin screens or for agent traffic. It connects out to the
hub as its own identity, so it needs no port.

```bash
AGENT_MESH_HUB_URL="ws://127.0.0.1:$HUB_PORT/ws" \
SELF_REMINDER_IDENTITY=self-reminder \
bun packages/self-reminder/src/main.ts
```

Provision and approve that identity first (§ 10.2), the same as any other
participant — nothing is exempt from key approval, including this.

## 8. The admin front end

`packages/platform-web` is not on `main`; it lives on the
`fe-admin-requirements` branch and its merge is undecided.

```bash
cd packages/platform-web
API_PROXY_TARGET="http://127.0.0.1:$HTTP_PORT" bun run dev   # serves on 3005
```

The proxy target is the **http** server. Setting it to 3100 is the mistake at
the top of this document.

---

## When you just want a mesh, not a deployment

For running tests, reproducing something, or handing a working mesh to another
agent, do not follow any of the above:

```bash
bun run e2e:harness -- --ready-file /tmp/mesh.json --keep-state
```

It picks two free ports, starts hub and http in the right order, waits for both,
and writes a file saying what it started — including the provenance from § 6 and
a ready-made admin login handle. It is what every test and every cross-agent
conformance run in this project actually uses.

Ephemeral ports on purpose. A fixed port is a fixed port somebody else already
has, and this repository has lost time to both halves of that: a stale process
answering on 3000 for a week, and an unrelated application holding a port a
health check then blamed the hub for.

**Nothing here refuses to start while `mutation-check` is running.** The harness
does (`scripts/tree-lock.ts`) — it builds from the tree and a mutated guard would
produce failures that look like defects in whatever called it. These three
commands do not check, so do not start them mid-mutation either.
