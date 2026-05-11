# Lane VM deployment guide (internal-mesh v0.1)

This document covers the operational procedure for bringing up a new
**lane VM** in an `internal-mesh v0.1` deployment. It is the operator
counterpart to **SPEC § 14**, which defines the normative contract.

A lane VM hosts exactly one (or, exceptionally, more than one)
**lane** — that is, a `runtime-adapter` plus its associated
`channel-driver`(s) for a single agent identity. The hub, HTTP server,
self-reminder server, and attachment store live on the **core VM** and
are out of scope for this guide.

---

## 1. Prerequisites

| Item | Requirement |
|------|-------------|
| OS | Ubuntu 22.04 / 24.04 (or Debian 12+) |
| Runtime | `bun` ≥ 1.1 on PATH for the `ubuntu` user |
| For codex lanes | `codex` CLI installed and on PATH for `ubuntu` |
| Network | TCP reachability to the core VM's hub port (default `3100`) and HTTP port |
| User | A non-root `ubuntu` account that owns `/srv/agent-mesh-platform` |
| Privileges | `sudo` for the operator running `install-lane.sh` |

Containers (Docker / Podman) are **not** used — units run directly
under systemd.

---

## 2. Sync the source tree

The lane VM MUST have a copy of the agent-mesh-platform source tree at
`/srv/agent-mesh-platform`. Git clone is the recommended form:

```bash
sudo install -d -o ubuntu -g ubuntu /srv/agent-mesh-platform
sudo -u ubuntu git clone <repo-url> /srv/agent-mesh-platform
cd /srv/agent-mesh-platform
sudo -u ubuntu bun install
```

Re-syncing (`git pull && bun install`) is safe at any time; restart the
affected lane target afterward.

---

## 3. Provision the lane identity on the core VM

> Run this step **on the core VM**, not on the lane VM. Lane VMs MUST
> NOT write to `hub.db` directly (SPEC § 14.3).

```bash
curl -X POST "http://<core-vm>:<HTTP_PORT>/api/v1/agents" \
     -H 'content-type: application/json' \
     -d '{
           "identity": "my-lane-1",
           "type":     "ai-codex",
           "description": "Production lane 1 — codex runtime over Discord"
         }'
```

A successful response is the contract that the lane VM may now connect
with that identity. Re-running the call for an existing identity is a
no-op and MUST NOT create a duplicate row.

---

## 4. Install systemd units on the lane VM

```bash
cd /srv/agent-mesh-platform
sudo ops/bin/install-lane.sh --lane-id my-lane-1
```

This script:

- creates `/etc/agent-mesh/lane/` and `/var/lib/agent-mesh/lane/`,
- symlinks the four lane unit files into `/etc/systemd/system/`,
- seeds `/etc/agent-mesh/lane/my-lane-1.env` and
  `/etc/agent-mesh/lane/my-lane-1.secret` from the example templates
  (only when they don't already exist — never clobbers),
- runs `systemctl daemon-reload`.

It does **not** enable or start anything.

---

## 5. Fill in the ENV files

Edit `/etc/agent-mesh/lane/my-lane-1.env`:

| Key | Required | Notes |
|-----|----------|-------|
| `HUB_URL` | MUST | `ws://<core-vm>:3100/ws` |
| `LANE_IDENTITY` | MUST | Same string used in step 3 |
| `RUNTIME_KIND` | MUST | `codex` or `claude` |
| `RUNTIME_ENDPOINT` | SHOULD | e.g. `http://localhost:4500` |
| `CHANNEL_KIND` | MUST | currently `discord` |
| codex-specific keys | as applicable | see `lane.env.example` |
| channel-driver keys | as applicable | ports, ingress URL, paths |

Then edit `/etc/agent-mesh/lane/my-lane-1.secret` (mode `0600` — the
installer enforces this):

- `DISCORD_BOT_TOKEN` — Discord bot token for this lane's identity.
- `CODEX_ADAPTER_HTTP_TOKEN` / `CHANNEL_DISCORD_TOKEN` /
  `CHANNEL_INGRESS_TOKEN` / `DISCORD_DRIVER_HTTP_TOKEN` — the
  intra-lane HTTP shared secrets. Generate per lane (`openssl rand -hex
  24`) and keep adapter/driver consistent.

> Never commit the populated `.env` / `.secret` files to git.

---

## 6. Enable and start the lane

```bash
sudo systemctl enable --now agent-mesh-lane@my-lane-1.target
```

The target pulls in (depending on `RUNTIME_KIND` / `CHANNEL_KIND`):

- `agent-mesh-lane-codex-app-server@my-lane-1.service` (codex only)
- `agent-mesh-runtime-adapter@my-lane-1.service`
- `agent-mesh-channel-driver-discord@my-lane-1.service`

`PartOf=` wiring means stopping the target stops the whole stack.

---

## 7. Verify

```bash
# Are the lane units up?
systemctl status agent-mesh-lane@my-lane-1.target

# Adapter log (most diagnostic):
journalctl -u agent-mesh-runtime-adapter@my-lane-1 -f

# Channel-driver log:
journalctl -u agent-mesh-channel-driver-discord@my-lane-1 -f

# (codex) app-server log:
journalctl -u agent-mesh-lane-codex-app-server@my-lane-1 -f
```

On the core VM, the new identity should appear in
`mesh.list_agents` as `online:true` within a few seconds of the
adapter starting.

---

## 8. Troubleshooting

| Symptom | Likely cause | Action |
|---------|--------------|--------|
| Adapter loops with `WebSocket connection failed` | Bad `HUB_URL` or core hub unreachable | `ss -tn state established '( dport = :3100 )'` from the lane VM; check core-vm firewall |
| Adapter logs `unknown identity` / register denied | Step 3 not run, or identity typo mismatch with `LANE_IDENTITY` | Re-run `POST /api/v1/agents`; double-check `.env` |
| `RUNTIME_KIND must be set` ExecStart failure | `/etc/agent-mesh/lane/<id>.env` missing or unset | Confirm file exists and `RUNTIME_KIND=codex` (or `claude`) |
| codex app-server immediately exits | `codex` binary missing on PATH | `sudo -u ubuntu bash -lc 'command -v codex'` |
| Channel-driver 401 from adapter | `*_TOKEN` mismatch between `.env` and `.secret` | Regenerate, ensure adapter+driver share the same token values |
| Two lane VMs claim the same identity | Misprovisioning | Stop one; only one process MAY hold an identity online at a time |
| Permission denied reading `.secret` | File not `0600` or wrong owner | `chmod 0600` + `chown root:root` |

---

## 9. Decommissioning a lane

```bash
sudo systemctl disable --now agent-mesh-lane@my-lane-1.target
sudo rm /etc/agent-mesh/lane/my-lane-1.env /etc/agent-mesh/lane/my-lane-1.secret
sudo rm -rf /var/lib/agent-mesh/lane/my-lane-1
```

Identity row deletion on the core VM is a separate, deliberate
operation (see SPEC § 14.3 — DELETE is out of scope for the
provisioning API at v0.1).
