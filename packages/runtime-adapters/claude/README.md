# @agent-mesh/runtime-adapter-claude

Claude Code MCP channel server for the Agent-Mesh fabric.

This adapter is loaded inside a Claude Code session as a development channel
(`server:agent-mesh`). It connects to the Agent-Mesh hub as `LANE_IDENTITY`,
turns inbound hub `mesh.message` notifications into Claude Code channel turns,
and exposes tools that let the session reply back through the hub.

The channel contract mirrors the working Claude Code Discord channel pattern:
declare the `claude/channel` capability, then deliver inbound messages with
`notifications/claude/channel`.

## What it does (v0.2)

- Connects to the hub over WebSocket as `LANE_IDENTITY` with `mesh.connect`.
- Runs as an MCP **stdio** server declaring the `claude/channel` capability.
- **Inbound**: hub `mesh.message` -> `notifications/claude/channel`, waking the
  Claude Code session with a new turn.
- **Outbound**: the session's `reply` tool -> hub `mesh.send` to the destination
  mesh identity.
- Exposes `reply`, `fetch_messages`, and `list_agents` tools to the session.
- Writes logs to **stderr** so stdout remains reserved for MCP stdio.

## Environment

| Variable | Required | Description |
|---|---|---|
| `HUB_URL` | yes | Hub WS endpoint, e.g. `ws://127.0.0.1:3100/ws` |
| `LANE_IDENTITY` | yes | Identity this channel connects with on the hub; it must be pre-provisioned via `POST /api/v1/agents` |
| `LANE_DESCRIPTION` | no | Description shown on hub registration |
| `LANE_PROXY_FOR` | no | Comma-separated `proxy_for` identities |
| `HUB_RECONNECT_DELAY_MS` | no (default `5000`) | Reconnect backoff |
| `HUB_HEARTBEAT_INTERVAL_MS` | no (default `30000`) | Retained for compatibility with existing lane env files |
| `HUB_FORWARD_IDENTITY` | no | Retained for compatibility; v0.2 replies use `LANE_IDENTITY` |

## Run

Run from the repository root:

```bash
HUB_URL=ws://127.0.0.1:3100/ws \
LANE_IDENTITY=claude-agent \
LANE_DESCRIPTION="Claude Agent-Mesh channel" \
bun packages/runtime-adapters/claude/src/main.ts
```

## Claude Code `.mcp.json`

Use a development channel named `agent-mesh`:

```json
{
  "mcpServers": {
    "agent-mesh": {
      "command": "bun",
      "args": [
        "/path/to/agent-mesh-platform/packages/runtime-adapters/claude/src/main.ts"
      ],
      "env": {
        "HUB_URL": "ws://127.0.0.1:3100/ws",
        "LANE_IDENTITY": "claude-agent",
        "LANE_DESCRIPTION": "Claude Agent-Mesh channel"
      }
    }
  }
}
```

Launch Claude Code with:

```bash
claude --dangerously-load-development-channels server:agent-mesh
```

Expected verification path:

1. `/mcp` shows `agent-mesh` connected with 3 tools.
2. A hub `mesh.message` addressed to `LANE_IDENTITY` wakes the Claude Code
   session through `notifications/claude/channel`.
3. The session replies with the `reply` tool.
4. The adapter sends the reply via `mesh.send`.

## Typecheck

```bash
bun --bun tsc -p packages/runtime-adapters/claude/tsconfig.json --pretty false
```
