# @agent-mesh/runtime-adapter-claude

Skeleton runtime adapter for the **Claude lane** of the Agent-Mesh channel
fabric.

Unlike the Codex lane — which embeds the LLM client in-process as a three-unit
chain (`codex-app-server` + `runtime-adapter` + `channel-driver`) — the Claude
lane is a **single adapter unit** that brokers between the hub and an
**external Claude Code MCP server**. The actual LLM session lives in Claude
Code itself; this adapter just owns the lane identity on the hub side and
proxies envelopes.

## Responsibilities (v0.1 skeleton)

- Maintain a hub WebSocket connection as `LANE_IDENTITY`
- `mesh.connect` with optional `proxy_for` (the legacy `mesh.register` alias of SPEC § 8.1a is accepted but DEPRECATED — see SPEC § 5.1)
- Heartbeat / auto-reconnect
- Receive `mesh.message` envelopes and log them
- (v0.2 TODO) Forward envelopes to the external Claude Code MCP, which then
  replies back to the hub itself using `HUB_FORWARD_IDENTITY`

## Environment

| Variable | Required | Description |
|---|---|---|
| `HUB_URL` | yes | Hub WS endpoint, e.g. `ws://arumhub:3100/ws` |
| `LANE_IDENTITY` | yes | Identity this adapter registers with on the hub |
| `HUB_FORWARD_IDENTITY` | no (default = `LANE_IDENTITY`) | Identity that the external Claude Code MCP uses when forwarding messages back to the hub. Lets multi-lane / shadow Claude setups distinguish adapter-origin vs Claude-origin traffic. |
| `CLAUDE_MCP_ENDPOINT` | no (v0.1) | External Claude Code MCP location (`ws://...` or stdio socket path). Logged for visibility; not yet dialled. |
| `LANE_DESCRIPTION` | no | Optional description shown on hub registration |
| `LANE_PROXY_FOR` | no | Comma-separated `proxy_for` identities |
| `HUB_RECONNECT_DELAY_MS` | no (default 5000) | Reconnect backoff |
| `HUB_HEARTBEAT_INTERVAL_MS` | no (default 30000) | Heartbeat log interval |

## Activation

The lane is selected by the generic systemd template:

```
systemctl start agent-mesh-runtime-adapter@<lane>.service
```

With `RUNTIME_KIND=claude` in the lane's `EnvironmentFile`, the template
invokes:

```
bun packages/runtime-adapters/claude/src/main.ts
```

## TODO (v0.2 — full activation)

- Dial `CLAUDE_MCP_ENDPOINT` (WebSocket or stdio) and maintain a session
- Translate inbound `MeshMessage` → Claude Code MCP request envelope
- Reply path: external Claude Code MCP forwards via hub directly using
  `HUB_FORWARD_IDENTITY` — adapter does **not** intermediate the reply
- Adapter-origin system messages (transport errors, MCP offline notices) via
  `hub.send()` using `LANE_IDENTITY` as `from`
- Optional HTTP control surface (mirror of codex `http-server.ts`) once the
  channel-driver attach pattern is finalised for Claude
