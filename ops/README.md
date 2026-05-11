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
  - Use `bin/launch-claude-session.sh` for the tmux session
  - Fresh launches should keep `CLAUDE_OPTS_EXTRA=` empty; use `CLAUDE_OPTS_EXTRA=--continue` only for an intentional resume
  - The Discord driver uses hub-forward mode to send inbound Discord envelopes to the Claude lane identity

## Shared services

Shared lab services now start from the monorepo:

- `packages/shared/hub/src/main.ts`
- `packages/shared/http/src/main.ts`
- `packages/shared/self-reminder/src/main.ts`

`agent-mesh-hub-lab.service` now bootstraps baseline service identities through
the canonical `POST /api/v1/agents` endpoint (SPEC §10.1) after the hub listens.
This keeps task #72 registration SSOT intact and avoids direct `hub.db` SQL
drift. The unversioned `POST /api/agents` route remains as a legacy alias for
pre-v0.1 callers (see SPEC §10.1 backwards-compat clause).

Bootstrap discovery rules:

- `http-server` (or `http-server-dev` when `NODE_ENV=development`)
- `SELF_REMINDER_IDENTITY` from `env/shared/self-reminder.env`
- every `CODEX_ADAPTER_IDENTITY` found under `env/*/adapter.env`
- every `HUB_FORWARD_IDENTITY` paired with `HUB_FORWARD_TARGET_AGENT` in `env/*/discord.env`

The old `/srv/agent-mesh-lab/legacy/agent-mesh` copy can remain as rollback stock, but the active units should no longer point at it.

## First-start order

1. Copy `env/**/*.example` to live env files without the `.example` suffix.
2. Install `systemd/*.service` into `/etc/systemd/system/`.
3. Run `systemctl daemon-reload`.
4. Start shared services first.
   The hub will idempotently pre-register baseline service identities during startup.
5. Start `channel-discord@test-codex1`, `channel-discord@test-codex2`.
6. Start `codex-app-server@test-codex1`, `codex-app-server@test-codex2`.
7. Start `agent-mesh-codex-adapter@test-codex1`, `agent-mesh-codex-adapter@test-codex2`.
8. Start `channel-discord@test-claude1`, `channel-discord@test-claude2`.
9. Launch `test-claude1`, `test-claude2` with `bin/launch-claude-session.sh`.

Before the first `enable --now`, take the `pre-first-start` snapshot.

## Claude lane caveat

The current 6A path keeps Claude on legacy `server:agent-mesh`.

- inbound Discord reaches Claude through hub-forwarded messages
- outbound Claude replies go back to the driver identity over agent-mesh reply
- richer channel tools (`react`, `fetch_messages`, attachment tools) remain a follow-up
