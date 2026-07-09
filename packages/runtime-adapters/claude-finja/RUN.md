# Claude Finja Agent-Mesh MCP Channel

This package is a Finja-specific Claude Code channel server for Agent-Mesh.
It connects to the hub as `LANE_IDENTITY`, receives `mesh.message`
notifications, and forwards them to Claude Code with
`notifications/claude/channel`. Claude replies with the `reply` tool, which
sends `mesh.send` back to the original sender identity.

## Command

Run from the repository root:

```bash
HUB_URL=ws://127.0.0.1:3100/ws \
LANE_IDENTITY=claude-finja \
LANE_DESCRIPTION="Claude Finja MCP channel" \
/home/zkrypto/.bun/bin/bun packages/runtime-adapters/claude-finja/src/main.ts
```

Optional env:

- `LANE_PROXY_FOR`: comma-separated proxied mesh identities.
- `HUB_RECONNECT_DELAY_MS`: reconnect delay, default `5000`.
- `HUB_HEARTBEAT_INTERVAL_MS`: retained from v0.1 config, default `30000`.
- `HUB_FORWARD_IDENTITY`: retained for compatibility; v0.2 replies use
  `LANE_IDENTITY`.

The hub identity must already be provisioned through the hub registration SSOT
(`POST /api/v1/agents`) before this MCP server connects.

## .mcp.json Snippet

Use a development channel named `agent-mesh`:

```json
{
  "mcpServers": {
    "agent-mesh": {
      "command": "/home/zkrypto/.bun/bin/bun",
      "args": [
        "/home/zkrypto/ai/kodaeng/workspace/agent-mesh-platform/packages/runtime-adapters/claude-finja/src/main.ts"
      ],
      "env": {
        "HUB_URL": "ws://127.0.0.1:3100/ws",
        "LANE_IDENTITY": "claude-finja",
        "LANE_DESCRIPTION": "Claude Finja MCP channel"
      }
    }
  }
}
```

## Finja Verification Procedure

1. Start or confirm the Agent-Mesh core hub is running on `HUB_URL`.
2. Ensure `claude-finja` is registered in the hub agent registry.
3. Put the `.mcp.json` snippet where the target Claude Code session loads it.
4. In the tmux Claude session, run:

```bash
claude --dangerously-load-development-channels server:agent-mesh
```

5. Confirm Claude Code reports `server:agent-mesh` as connected.
6. Schedule or send a self-reminder/message addressed to `claude-finja`.
7. Expected result: the MCP server receives hub `mesh.message`, emits
   `notifications/claude/channel`, and the Claude session wakes with a new turn.
8. Reply from Claude using the channel `reply` tool. Expected result:
   `mesh.send` sends the reply to the inbound `chat_id` identity.

## Local Verification

```bash
/home/zkrypto/.bun/bin/bun --bun tsc -p packages/runtime-adapters/claude-finja/tsconfig.json --pretty false
```

This verifies the package compiles. The actual Claude Code channel load and
wake behavior must be verified by Finja in the tmux Claude session.
