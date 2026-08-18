# Running the mesh on a laptop

**Every step here was executed on macOS from a clean shell, and the outputs
below are what it printed.** That is the only reason to trust it.

§ 8 was not, at first. Sections 1 to 6 were run three times — once here and
twice by `client-claude` as a first reader — while the front-end step sat
unexecuted under a heading that claimed otherwise, and it carried a wrong port
the whole time. `agent-mesh-local-pm` found it by counting output markers per
section and noticing one had none (mail #478). Both have been run now, and every
section carries what it printed. The `README.md` quick start has been there for months, requires a
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

**Into a file, and every shell sources it.** Two shells are involved and the
values must match in both; the moment they are typed twice they are two copies
of one fact, and the shorter-lived copy wins in whichever shell was pasted into
last.

That is not hypothetical here. An earlier draft restated the defaults in step 4,
and a reader who chose another pair in step 0 got a second shell pointed at
`ws://127.0.0.1:3100/ws` — where a *different* long-running hub was already
answering. Both processes come up healthy and the new http server is a client of
somebody else's mesh. `client-claude` reproduced exactly that (mail #444).

```bash
cat > .mesh-local.env <<'ENV'
export AGENT_MESH_STATE_DIR="$HOME/.agent-mesh/local"
export HUB_PORT=3100
export HTTP_PORT=3000
ENV
source .mesh-local.env
mkdir -p "$AGENT_MESH_STATE_DIR"
```

Change the pair here if the check above showed either port taken — `3110`/`3010`
and `3120`/`3020` are what the two verification runs used, for exactly that
reason. Nothing below repeats a port number, so nothing below needs editing.

## 1. Install

```bash
git clone https://github.com/sir-mirr/agent-mesh-platform.git
cd agent-mesh-platform
bun install
```

## 2. About that state directory

It is in the file above because every service reads and writes SQLite under one
directory and **they must all be given the same one**. Nothing derives it,
nothing defaults to a shared place, and two services pointed at different
directories come up healthy and then disagree about every row.

**`mkdir -p` matters.** The services do not create it. A missing directory produces
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

In a second shell. Nothing travels between shells, so source the same file —
which is the whole reason it is a file:

```bash
source .mesh-local.env

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

Keep it, if you are going to call an admin route:

```bash
COOKIE=$(curl -s -i -X POST "http://127.0.0.1:$HTTP_PORT/auth/local" \
  -H 'accept: application/json' -H 'content-type: application/json' \
  -d '{"username":"admin","password":"admin"}' \
  | grep -i '^set-cookie' | grep -o 'mesh_token=[^;]*')
```

The session is in the cookie. It is deliberately **not** in the response body —
a caller holding the cookie does not need it, and a caller that stores it
somewhere else has made it a thing to steal.

## 6. Verify — by asking what is running, not by assuming

```bash
curl -s "http://127.0.0.1:$HTTP_PORT/api/v1/health"
curl -s "http://127.0.0.1:$HUB_PORT/api/v1/capabilities" | jq '.platform, .audit.blob_base_url'
```

**Check `blob_base_url` against `$HTTP_PORT`.** The hub cannot derive that
address — http connects to it, never the reverse — so a deployment states it,
and forgetting to leaves the default `http://127.0.0.1:3000` pointing at
whatever else is listening there. Every step of this procedure passes with that
value wrong; the first thing that disagrees is an attachment upload, later, from
somebody else.

`client-claude` found that gap by asking what following this document does *not*
prove (mail #451). The value was unobservable at the time, which is why it now
appears here.

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

**Provision it first.** One command, no key, no approval — and the previous
version of this section had three, which all succeeded and proved nothing about
whether they were needed:

```bash
curl -s -X POST "http://127.0.0.1:$HUB_PORT/api/v1/agents" \
  -H 'content-type: application/json' \
  -d '{"identity":"self-reminder","type":"service"}'
```

```
HTTP 201  {"ok":true,"identity":"self-reminder","type":"service",...,"action":"inserted"}

[self-reminder] scheduler_started {"poll_ms":1000,"identity":"self-reminder",...}
[self-reminder] hub_registered    {"generation":1}
```

No key in the response, none in the database (`SELECT ... FROM agent_keys` is
empty), and it registers anyway.

**Confirm it from outside, because a log is the process talking about itself.**
Every other step here ends with something a reader can query; this one ended
with a line printed by the thing being checked. The hub counts who is actually
connected:

```bash
curl -s "http://127.0.0.1:$HUB_PORT/health" | jq .online_agents
```

```
0     before anything connects
0     after provisioning — a registered identity is not a connected one
1     after self-reminder starts
```

**The middle line is the one that matters.** Provisioning answers `201` and
moves nothing, so a reader who stopped there would have confirmed the identity
exists, not that anything is running as it.

**`online_agents`, not `agent_count`.** The http server's health uses the second
name for a different thing, and asking the hub for it comes back empty — which
reads as *the hub does not report this* rather than *you asked for the wrong
field*. That is how the gap was found: `agent-mesh-local-pm` walked this
document as a first reader, could not confirm § 7 from outside, and said so
(mail #573) — having looked for `agent_count`.

**`service` does not require one.** § 10.2 gates keys, and which types carry a
key is a property of the type:

```
ai-claude · ai-codex · ai-antigravity   requires_key = 1
service · human                         requires_key = 0
```

`self-reminder` connects unsigned — its source contains no key generation and no
signing at all — so there is nothing to approve. An earlier draft of this
section said *nothing is exempt from key approval, including this*, which is
true as a principle and false about this participant: it has no key, so the
approval step has no subject. The rule is that **an identity that carries a key
is approved without exception**, not that every identity carries one.

Started before provisioning, the refusal is honest and names its cause rather
than timing out:

```
hub_registration_rejected {"error_category":"identity_not_registered"}
hub_reconnect_scheduled   {"delay_ms":2000,"attempt":2}   -> 4000 -> 8000 -> 16000
```

**How this got here is worth a line.** The three-command version was executed,
and it worked — 201 for the provision, 200 for the approval, `hub_registered`
after. Running it proved the commands succeed; it could not show that the same
result arrives from a third of them. `client-claude` got there by removing
`public_key` and seeing nothing change (mail #486). A green run hides an excess
as readily as it hides a gap.

## 8. The admin front end

`packages/platform-web` is not on `main`; it lives on the
`fe-admin-requirements` branch and its merge is undecided.

**Take it from `origin`, not from a branch you already have checked out.** A
local `fe-admin-requirements` can be behind the remote and not contain the
package at all, which is what a reader on this machine hit: `cd
packages/platform-web` answered `No such file or directory` while the same
branch on `origin` had 85 files in it.

```bash
git fetch origin
git worktree add /tmp/fe origin/fe-admin-requirements
cd /tmp/fe && bun install --frozen-lockfile
```

**This install reaches `github.com`, and the other seven sections do not.**
`platform-web` depends on the § 11 capability vocabulary rather than restating
it:

```json
"@agent-mesh/contracts": "github:sir-mirr/agent-mesh-contracts#v0.25.0"
```

It resolves today because that repository is public — checked, not assumed:

```bash
gh repo view sir-mirr/agent-mesh-contracts --json isPrivate    # false
curl -so /dev/null -w '%{http_code}\n' \
  https://codeload.github.com/sir-mirr/agent-mesh-contracts/tar.gz/refs/tags/v0.25.0   # 200
```

Which is worth writing down precisely because nothing here would say so if it
changed. A private repository, or a machine offline, stops this section at
`bun install` with a resolution error, and every symptom after that point —
no dev server, no admin screens — has the same one cause. Confirm the
dependency is actually there rather than inferring it from the app loading:

```bash
bun pm ls | grep contracts
```

```bash
cd packages/platform-web
API_PROXY_TARGET="http://127.0.0.1:$HTTP_PORT" bun run dev
```

**Read the port off vite's own output, not off this page.** `package.json` asks
for 3005, and vite moves when that is taken rather than failing:

```
$ vite --port 3005
Port 3005 is in use, trying another one...

  VITE v6.4.3  ready in 117 ms

  ➜  Local:   http://localhost:3006/
```

Both runs recorded here landed somewhere else — 3006 once and 3007 once, in the
same hour, because a WebKit process holds 3005 on this machine. An earlier
version of this section said `# serves on 3005`, which contradicted the rest of
the document: every other step warns that a fixed port is one somebody else
already has, and then this one assumed a free one. A reader opening 3005 sees
somebody else's server or nothing at all.

**Use `localhost` for the front end, not `127.0.0.1`.** Every other step here
uses `127.0.0.1`, and following that habit at this one fails:

```
http://localhost:3006/     200
http://[::1]:3006/         200
http://127.0.0.1:3006/     000   <- connection refused

$ lsof -nP -iTCP:3006 -sTCP:LISTEN
node ... TCP [::1]:3006 (LISTEN)
```

Vite binds the IPv6 loopback only. It prints `Local: http://localhost:3006/`
and says nothing about the address family, so the failure reads as "the front
end did not start" when it started fine and is listening somewhere the reader
did not look. The port is in the log; the bind address is not.

### The built front end, and what it still lacks

`dev` above is the development server. There is also a build, and it serves:

```bash
bun run build:web                       # packages/platform-web/dist
bunx --cwd packages/platform-web vite preview --port 3041
```

```
http://localhost:3041/                 200   the built page
http://localhost:3041/api/v1/health    200   {"status":"ok",...}
```

**The second line is the surprising one.** `vite.config.ts` sets `server.proxy`
and nothing under `preview`, yet the API is reachable through the preview
server — it inherits the proxy. So the built front end talks to the backend
with no extra configuration, which is easy to assume is missing and is not.
`agent-mesh-local-pm` reported it absent from a `grep` for `serveStatic`,
then went back and measured; both halves above were re-measured here.

The same `localhost` caveat applies: preview binds the IPv6 loopback too.

**What is genuinely missing is the deployment wiring, not the serving.** There
is no systemd unit for the front end — `ops/systemd/` has the hub, the http
server, the self-reminder and the orphan collector, and nothing else — and
Vite does not intend `preview` as a production server. So the choice is
between running `preview` under a unit of its own and putting `dist` behind a
static host; the pieces for either are present, and neither is written down as
the decision yet.

The proxy target is the **http** server. Setting it to 3100 is the mistake at
the top of this document.

Check the proxy rather than assuming it, because a screen that cannot reach the
backend renders perfectly:

```bash
curl -s "http://localhost:<the port vite printed>/api/v1/health"
curl -s "http://127.0.0.1:$HTTP_PORT/api/v1/health"
```

```
{"status":"ok","version":"20260817133905","agent_count":1,"uptime":23}
{"status":"ok","version":"20260817133905","agent_count":1,"uptime":23}
```

The same answer through both means the proxy is wired. A different one, or an
empty reply, means the screen is talking to something else — which is the whole
failure this document is about, one layer up.

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
