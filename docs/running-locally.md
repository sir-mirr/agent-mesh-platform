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
baseline service and does not appear in the README at all. Both threes are
correct; neither is the other. § 8 covers the front end.

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
# Where the front end looks for the backend. Derived from HTTP_PORT rather than
# repeated, and exported here rather than per-command, because a front end
# pointed at the wrong backend passes every check below — see § 8.
export API_PROXY_TARGET="http://127.0.0.1:$HTTP_PORT"
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

**It is called `platform-admin`** (T-026). The account administers the
installation — every tenant, and the list of tenants itself — and `admin` read
as *the admin of whatever you are looking at*, which on a screen scoped to one
tenant is the wrong account. A deployment that predates the change is renamed
on its next start, with every live reference to the name carried across; the
log line is `seed_admin_renamed`.

```
username: platform-admin
password: $AGENT_MESH_ADMIN_PASSWORD, or `admin` when that is unset
```

**Set it before the first boot on any host somebody else can reach.** The seed
runs once, when `local_users` is empty, so a password supplied later does not
replace one already stored — the row is there and the variable is not consulted
again.

**The same is true of the first-login requirement.** The seed is what marks the
account as having to choose a password, so an account that already exists keeps
whatever password it has and is never asked — which is right for an upgrade, and
is a hole if a host is brought up by **copying a state directory** from
somewhere else. Measured: the standing lab stack signs `admin` straight into the
dashboard, because that row predates the column and never went through the seed.
A host that starts on an empty state directory does not have this.

**So on a fresh host, the first thing after signing in is choosing a password**,
and until that happens every other route answers:

```
{"error":"This account must change its password before anything else","must_change_password":true}
```

```bash
curl -s -X POST "http://127.0.0.1:$HTTP_PORT/auth/local/password" \
  -H 'content-type: application/json' -b "$COOKIE" \
  -d '{"current":"admin","next":"a-longer-password"}'
```

```
{"ok":true,"must_change_password":false}
```

`next` is at least eight characters and must differ from `current`. The old
password stops working immediately — that is what makes the change a change.

Written down because it was not: `agent-mesh-local-pm` followed this guide on a
fresh clone, reached the first admin call, and got the refusal above with no
next line to follow. The route existed and the field names did not appear in any
document, so finishing the walkthrough required reading the server's source. A
procedure that cannot be completed from the page is not a procedure. On this laptop leaving it unset is the documented path and is what every
test in this repository signs in with.

```bash
curl -s -X POST "http://127.0.0.1:$HTTP_PORT/auth/local" \
  -H 'accept: application/json' -H 'content-type: application/json' \
  -d '{"username":"platform-admin","password":"admin"}' -i | grep -i set-cookie
```

```
set-cookie: mesh_token=eyJhbGciOiJIUzI1N...
```

And in the http server's own log, one of these — **which one tells you whether
this deployment stated a password**:

```
2026-08-22T05:00:00.000Z info [http] seeded the platform-admin local user with AGENT_MESH_ADMIN_PASSWORD {"ts":...,"event":"db_admin_seeded","actor":"platform-admin","reason":"from_environment"}
2026-08-22T05:00:00.000Z warn [http] seeded the platform-admin local user with the default password `admin`. Set AGENT_MESH_ADMIN_PASSWORD before first boot on any host others can reach. {"ts":...,"event":"db_admin_seeded","actor":"platform-admin","reason":"default_password"}
```

Keep it, if you are going to call an admin route:

```bash
COOKIE=$(curl -s -i -X POST "http://127.0.0.1:$HTTP_PORT/auth/local" \
  -H 'accept: application/json' -H 'content-type: application/json' \
  -d '{"username":"platform-admin","password":"admin"}' \
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

2026-08-22T05:00:00.000Z info [self-reminder] scheduler started {"ts":...,"event":"scheduler_started","actor":"self-reminder","poll_ms":1000,...}
2026-08-22T05:00:00.100Z info [self-reminder] registered with the hub {"ts":...,"event":"hub_registered","actor":"self-reminder","outcome":"registered","generation":1}
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

`packages/platform-web` is **on `main`**, with the rest of the repository:

```bash
git fetch origin
bun install --frozen-lockfile
```

**This section used to send readers to `fe-admin-requirements`, and that cost
somebody a morning.** The branch was merged and `main` has gone 51 commits past
it, so a reader following the old instruction built a front end without the last
three weeks in it — and everything succeeded. agent-mesh-local-pm lost a piece
of work that way: they built a screen the inventory listed as missing, got as
far as a clean typecheck, and found on the first adversarial check that `main`
already had it, better tested.

**A command that dies stops a reader. A wrong location sends them somewhere and
lets them finish.** That is why this correction is worth more than the two above
it, and why the check on it is `git merge-base --is-ancestor <ref> origin/main`
rather than "does the branch exist" — the question is not whether a ref is real,
it is whether it is still the one.

**Take it from `origin` rather than from a branch already checked out**, which
is the surviving half of the old warning: a stale local ref can be behind the
remote and not contain the package at all, and `cd packages/platform-web`
answering `No such file or directory` is what that looks like.

**This install reaches `github.com`, and the other seven sections do not.**
`platform-web` depends on the § 11 capability vocabulary rather than restating
it:

```json
"@agent-mesh/contracts": "github:sir-mirr/agent-mesh-contracts#v0.36.0"
```

It resolves today because that repository is public — checked, not assumed:

```bash
gh repo view sir-mirr/agent-mesh-contracts --json isPrivate    # false
curl -so /dev/null -w '%{http_code}\n' \
  https://codeload.github.com/sir-mirr/agent-mesh-contracts/tar.gz/refs/tags/v0.36.0   # 200
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
bun run dev                              # API_PROXY_TARGET comes from § 0
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
cd packages/platform-web && bunx vite preview --port 3041
```

`cd` rather than `bunx --cwd`: on bun 1.3.13 — the version this was executed on
— `bunx` reads `--cwd` as the *package to fetch*, and the command fails with
`GET https://api.github.com/repos/packages/platform-web/tarball/ - 404`. A reader
meeting that stops there and does not reach the three correct lines below it.

```
http://localhost:3041/                 200   the built page
http://localhost:3041/api/v1/health    200   {"status":"ok",...}
```

**Both lines pass against the wrong backend**, which is why `API_PROXY_TARGET`
is set in § 0 and not here. `vite.config.ts` falls back to
`http://localhost:3000`, so a preview started without it attaches to whatever is
on that port — on a machine already running a mesh, somebody else's. Measured:
without the variable the health route answered `uptime 68724` from a stack that
had been up for nineteen hours; with it, `uptime 99` from the one this procedure
started. **Both were `200`.**

That is the third time this document meets the same shape — § 0 has it for the
state directory and § 6 for `AGENT_MESH_BLOB_BASE_URL`, and this section is
where the lesson was not applied. agent-mesh-local-pm found it by reading
`uptime` rather than the status code.

**The second line is the surprising one.** `vite.config.ts` sets `server.proxy`
and nothing under `preview`, yet the API is reachable through the preview
server — it inherits the proxy. So the built front end talks to the backend
with no extra configuration, which is easy to assume is missing and is not.
`agent-mesh-local-pm` reported it absent from a `grep` for `serveStatic`,
then went back and measured; both halves above were re-measured here.

The same `localhost` caveat applies, and **`too` was the wrong word here**:
preview binds the IPv6 loopback *only*. `127.0.0.1` has no listener at all —
not a refused connection to something fussy, nothing listening:

```
http://localhost:3041/    200
http://[::1]:3041/        200
http://127.0.0.1:3041/    connection refused

$ lsof -nP -iTCP:3041 -sTCP:LISTEN
node ... TCP [::1]:3041 (LISTEN)      <- and nothing on 127.0.0.1
```

`agent-mesh-local-pm` caught the wording. Read as "IPv6 works as well", a
reader who gets `Connection refused` goes looking at the port or the build; read
as "IPv4 is not served", they change one word in the URL. Same sentence, two
different afternoons.

### Deploying it somewhere else

The owner's decision is a **separate server with an administrator on it**, not
this laptop. That takes `vite preview` off the table as the answer, and it
takes the proxy with it:

```
preview reached the API because it inherits `server.proxy` from vite.config.ts
a static host has no such thing
```

So `dist` copied onto a web server gives a page that loads and an API that
404s from that server's own root — **the screen works and cannot reach the
backend**, which looks like the backend is down. The front end calls relative
paths (`/api/v1/...`), so the two ways out are:

| | |
|---|---|
| **the host proxies `/api` to `agent-mesh-http`** | one nginx or Caddy block; the front end is unchanged |
| the front end calls an absolute URL | inject an API base at build time, and then it is cross-origin |

The first leaves the code alone. The second needs
`AGENT_MESH_ALLOWED_ORIGINS` set to the front end's origin — that variable is
**empty by default and empty does not mean "allow everything"**, as § 4 says.
Either way the origin has to be named somewhere; the difference is whether it
is named in a proxy config or in a build argument and a CORS list.

**What is genuinely missing is the deployment wiring, not the serving.** There
is no systemd unit for the front end — `ops/systemd/` has the hub, the http
server, the self-reminder and the orphan collector, and nothing else — and
Vite does not intend `preview` as a production server.

**The decision is the static host, and it is the first row above.** `dist`
behind nginx or Caddy, with that host proxying `/api` to `agent-mesh-http`.
Running `preview` under a unit of its own is not used: it puts a development
server in production, which is a choice the administrator has to defend later
and Vite's own documentation argues against.

The rest follows from it rather than being separate decisions:

```
front-end code changes      none — the front end already calls relative paths
AGENT_MESH_ALLOWED_ORIGINS  stays empty. Same origin, so CORS never arises
what the administrator runs a web server they already operate, plus one block
```

`AGENT_MESH_ALLOWED_ORIGINS` is worth stating explicitly because the earlier
advice paired this branch's recommendation with the *other* branch's
requirement, and an administrator following it would fill in a list nothing
reads — and, worse, would believe a cross-origin request is happening here.
§ 4's rule is the one that applies: same-origin requests need no entry.

A block to copy. Ports are this document's local ones; on that server they are
whatever the units bind:

```nginx
server {
  listen 80;
  server_name mesh.example.internal;

  root /srv/agent-mesh-web;          # where `dist` was copied
  index index.html;

  # The SPA owns its routes: anything that is not a file is index.html, or a
  # reload on /tenant/rbac is a 404 from nginx rather than a screen.
  location / {
    try_files $uri $uri/ /index.html;
  }

  # **Signing in does not go through `/api/`.** The front end posts to
  # `/auth/local` and reads `/auth/me`, and a block that proxies only `/api/`
  # hands those to `try_files` above: nginx answers the login POST itself with
  # `405 Not Allowed`, having found no file to serve. Every other check in this
  # document still passes — the page renders, the assets load, `/api/v1/health`
  # answers through the proxy — and nobody can log in. Measured, on this block
  # as it was first written.
  location /auth/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  # **The http server, not the hub.** Pointing this at 3100 is the mistake at
  # the top of this document, and it fails as a page that renders and cannot
  # log in.
  location /api/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  # **No per-stream exemption, and that is measured rather than assumed.** This
  # block used to carry `proxy_buffering off` for `/api/v1/audit/stream` — a
  # path that exists nowhere else in this repository, so the one stanza written
  # to protect a live view protected nothing. The three routes that do stream
  # (`/api/v1/admin/keys/stream`, `/api/v1/admin/chat-audits/stream`,
  # `/api/v1/admin/ai-usage/stream`) each answer with `X-Accel-Buffering: no`,
  # which nginx acts on itself. Timed through this block: a `key-proposed`
  # event arrived 0.58s after the provisioning call, against 0.55s with the
  # proxy out of the path.
  #
  # A proxy that ignores that header needs the exemption back, on those three
  # names. Caddy does not — it streams `text/event-stream` without being told.
}
```

Caddy, the same thing:

```caddyfile
mesh.example.internal {
  root * /srv/agent-mesh-web
  handle /auth/* {
    reverse_proxy 127.0.0.1:3000
  }
  handle /api/* {
    reverse_proxy 127.0.0.1:3000
  }
  handle {
    try_files {path} /index.html
    file_server
  }
}
```

**Neither block is deployed by anything in this repository, and until now
neither had been run.** The nginx one has been, once, on a laptop: nginx 1.31.3
in front of a real `dist` with the two services on their documented ports.
Everything below passed and **signing in did not**, because the first version of
these blocks proxied `/api/` only. That is the paragraph above this one.

They are otherwise written from what the front end asks for and what § 8.9
needs, and the check below is what says whether the one you installed works —
including, now, the part that found this.

Two properties of the build to know before choosing a URL for it:

**It has to be served from the root of its host.** `vite.config.ts` sets no
`base`, so `dist/index.html` asks for `/assets/…` absolutely. Under
`https://host/mesh/` the page returns 200 and every asset 404s — a white screen
with a clean access log, which is this document's failure again one level down.
Serving it at a subpath means setting `base` and rebuilding, not configuring the
web server.

**It fetches its fonts from Google.** `index.html` links `fonts.googleapis.com`
and `fonts.gstatic.com`. On a network without egress the screen falls back and
stays usable, so this is a decision rather than a defect — but every page load
announces the deployment to a third party, and a mesh addressed at something
like `api.mesh.enterprise.internal` may not want that. Vendoring the two
families into `dist` is the fix if it is not wanted; nothing here depends on
them being remote.

Both were found by agent-mesh-local-pm building `dist` and reading it, which
until then nobody had done. **Running the documented commands and reading what
they produce are different checks**, and only the first had ever been made.

The proxy target is the **http** server. Setting it to 3100 is the mistake at
the top of this document.

Check the proxy rather than assuming it, because a screen that cannot reach the
backend renders perfectly:

On this laptop, where both are the same machine:

```bash
curl -s "http://localhost:<the port vite printed>/api/v1/health"
curl -s "http://127.0.0.1:$HTTP_PORT/api/v1/health"
```

On the separate server, where they are not:

```bash
# the origin the screen is served from — through the proxy
curl -s "https://mesh.example.internal/api/v1/health"
# where agent-mesh-http actually runs — not through it
curl -s "http://127.0.0.1:3000/api/v1/health"
```

```
{"status":"ok","version":"20260817133905","agent_count":14,"uptime":23}
{"status":"ok","version":"20260817133905","agent_count":14,"uptime":23}
```

The same answer through both means the proxy is wired. A different one, or an
empty reply, means the screen is talking to something else — which is the whole
failure this document is about, one layer up.

**`/api/v1/health` alone is not enough**, because signing in is not under
`/api/`. Ask for a session through the same origin the screen is served from:

```bash
curl -si -X POST "https://mesh.example.internal/auth/local" \
  -H 'content-type: application/json' \
  -d '{"username":"platform-admin","password":"admin"}' | grep -i '^set-cookie'
```

```
set-cookie: mesh_token=eyJhbGciOiJIUzI1N...
```

A `405` here is the web server answering instead of the http server, and it is
what a block that forwards only `/api/` produces. The page still renders, so
this is the one command that distinguishes *deployed* from *reachable*.

**Two commands pointed at the same host prove nothing.** They agree without a
proxy in the path, the answer looks like success, and nothing was ever routed.
The warning used to be here in prose while the block above it still said
`localhost` twice — and a reader copies the block. So the second form is
written out rather than described: a rule stated in prose beside an example
that contradicts it loses to the example, every time.

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

---

## 8. Give the screens something to judge

Two operator screens cannot be measured on an empty mesh, and that is not a
defect in either of them: `/creator/register` lists keys awaiting a decision and
`/creator/lease-queue` lists messages nobody has taken. With neither present they
draw the same thing whether the backend is reachable or not, and an audit against
that stack correctly reports "cannot judge" — twice, and then for every check
downstream of them.

`agent-mesh-local-pm` measured the cost of not knowing this: their sweep judged
13 pairs against an empty stack and **32 against a seeded one**, same code, same
tool. Screens fully judged went from 0 of 14 to 11.

```bash
bun run e2e:harness -- --ready-file /tmp/agent-mesh-fe-fixture.json --keep-state
bun run fixtures:screens -- --emit /tmp/agent-mesh-fe-expect.json
```

The first brings up a real hub and http on ephemeral ports and writes the ready
file. **It seeds nothing** — the second reads that file and does the seeding:
pending keys that are deliberately never approved, and messages queued for a
recipient that never collects them.

The counts **change every run**, on purpose. Seeding one of each would leave the
cheapest lie undetected — a screen rendering `1` from a constant passes, and
every front-end defect found here on 2026-08-18 was of exactly that shape
(`139` sessions, `1024` MB, `99.99%`, a bell reading "2 awaiting" forever). None
of them failed a typecheck, because a constant is perfectly well-typed.

`--emit` writes what the screens must show, as JSON, so a check compares against
a file rather than a number somebody copied out of a terminal an hour ago. Read
the whole expectation, not one field: any single count can repeat.

To seed a plain identity without any of this — one that just needs to exist —
use the provisioning call from § 7. It is the hub's route, not the http server's;
`POST /api/v1/agents` on the http port answers `404`.
