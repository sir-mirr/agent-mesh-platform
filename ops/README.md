# Agent-Mesh Lab Ops

This directory holds the 4th-round bring-up artifacts for the LXC lab.

## Layout

- `systemd/`
  - shared lab services
  - per-lane service templates
- `env/`
  - `shared/` for hub/http/self-reminder
  - `test-codex1/`, `test-codex2/`, `test-claude1/`, `test-claude2/`
- `bin/`
  - session-managed launcher examples for Claude lanes

## Lane model

- Codex lanes use three processes:
  - `codex-app-server@<identity>.service`
  - `agent-mesh-codex-adapter@<identity>.service`
  - `channel-discord@<identity>.service`
- Claude lanes remain session-managed for now.
  - Keep `channel-discord@<identity>.service`
  - Use `bin/launch-claude-session.sh.example` as the launcher starting point

## Shared services

Shared lab services still point to a legacy `agent-mesh` runtime copy at:

`/srv/agent-mesh-lab/legacy/agent-mesh`

This keeps 4th round focused on lane wiring. Shared core import can happen later.

## First-start order

1. Copy `env/**/*.example` to live env files without the `.example` suffix.
2. Install `systemd/*.service` into `/etc/systemd/system/`.
3. Run `systemctl daemon-reload`.
4. Start shared services first.
5. Start `channel-discord@test-codex1`, `channel-discord@test-codex2`.
6. Start `codex-app-server@test-codex1`, `codex-app-server@test-codex2`.
7. Start `agent-mesh-codex-adapter@test-codex1`, `agent-mesh-codex-adapter@test-codex2`.

Before the first `enable --now`, take the `pre-first-start` snapshot.
