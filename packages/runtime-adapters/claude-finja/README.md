# @agent-mesh/runtime-adapter-claude-finja

Finja-specific **Claude lane** channel server for the Agent-Mesh fabric.

This is a per-agent copy of the Claude runtime-adapter, implemented (v0.2) as a
**Claude Code MCP channel server**. Unlike a plain runtime-adapter that only
brokers hub traffic, this package is loaded *inside* a Claude Code session as a
development channel (`server:agent-mesh`) and delivers inbound Agent-Mesh
messages to the session as turns — the same `claude/channel` contract the
built-in Discord channel plugin uses.

## What it does (v0.2)

- Connects to the hub over WebSocket as `LANE_IDENTITY` (`mesh.connect`), with
  heartbeat + auto-reconnect.
- Runs as an MCP **stdio** server declaring the `claude/channel` capability, so
  Claude Code can load it with
  `claude --dangerously-load-development-channels server:agent-mesh`.
- **Inbound**: hub `mesh.message` → emitted to the session via
  `notifications/claude/channel`, waking the session with a new turn.
- **Outbound**: the session's `reply` tool → `mesh.send` back to the original
  sender identity.
- Tools exposed to the session: `reply`, `fetch_messages`, `list_agents`.

Verified end-to-end: self-reminder → hub → this MCP channel →
`notifications/claude/channel` → session wake → `reply` → hub.

## Environment

| Variable | Required | Description |
|---|---|---|
| `HUB_URL` | yes | Hub WS endpoint, e.g. `ws://127.0.0.1:3100/ws` |
| `LANE_IDENTITY` | yes | Identity this channel connects with on the hub (must be pre-provisioned via `POST /api/v1/agents`) |
| `LANE_DESCRIPTION` | no | Description shown on hub registration |
| `LANE_PROXY_FOR` | no | Comma-separated `proxy_for` identities |
| `HUB_RECONNECT_DELAY_MS` | no (default 5000) | Reconnect backoff |
| `HUB_HEARTBEAT_INTERVAL_MS` | no (default 30000) | Heartbeat log interval |
| `HUB_FORWARD_IDENTITY` | no | Retained for compatibility; v0.2 replies use `LANE_IDENTITY` |

Logs are written to **stderr** — stdout is reserved for the MCP stdio transport.

## Usage

See [`RUN.md`](./RUN.md) for the exact command, the `.mcp.json` snippet, and the
full verification procedure. In short:

1. Register `LANE_IDENTITY` on the hub (`POST /api/v1/agents`).
2. Point a Claude Code `.mcp.json` `agent-mesh` server at this package's
   `src/main.ts` (with `HUB_URL` / `LANE_IDENTITY` in its `env`).
3. Launch the session with
   `claude --dangerously-load-development-channels server:agent-mesh`.
4. Confirm `/mcp` shows `agent-mesh · ✔ connected`, then any `mesh.message`
   addressed to the identity wakes the session.
