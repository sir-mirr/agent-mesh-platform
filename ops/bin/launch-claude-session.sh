#!/usr/bin/env bash
set -euo pipefail

IDENTITY="${1:?usage: launch-claude-session.sh <identity> [env-dir] [workspace]}"
ENV_DIR="${2:-/srv/agent-mesh-lab/env/${IDENTITY}}"
WORKSPACE_ARG="${3:-}"

if [[ ! -f "${ENV_DIR}/adapter.env" ]]; then
  echo "[claude-session] missing ${ENV_DIR}/adapter.env" >&2
  exit 1
fi

set -a
source "${ENV_DIR}/adapter.env"
set +a

SESSION_NAME="${CLAUDE_SESSION_NAME:-${IDENTITY}}"
WORKSPACE="${WORKSPACE_ARG:-${CLAUDE_WORKSPACE:-/srv/agent-mesh-lab/workspaces/${IDENTITY}}}"
LEGACY_HOME="${AGENT_MESH_LEGACY_HOME:-/srv/agent-mesh-lab/legacy/agent-mesh}"
HUB_URL="${AGENT_MESH_HUB_URL:-ws://127.0.0.1:3100/ws}"
STATE_DIR="${AGENT_MESH_STATE_DIR:-/srv/agent-mesh-lab/state/shared}"

mkdir -p "${WORKSPACE}"

cat > "${WORKSPACE}/.mcp.json" <<EOF
{
  "mcpServers": {
    "agent-mesh": {
      "command": "/home/ubuntu/.bun/bin/bun",
      "args": ["run", "${LEGACY_HOME}/server.ts"],
      "env": {
        "AGENT_MESH_IDENTITY": "${AGENT_MESH_IDENTITY:-$IDENTITY}",
        "AGENT_MESH_HUB_URL": "${HUB_URL}",
        "AGENT_MESH_STATE_DIR": "${STATE_DIR}"
      }
    }
  }
}
EOF

if [[ ! -f "${WORKSPACE}/CLAUDE.md" ]]; then
  cat > "${WORKSPACE}/CLAUDE.md" <<EOF
# ${IDENTITY}

- This lane uses \`server:agent-mesh\` only.
- Discord reaches this session through the channel-discord hub-forward path.
- Inbound Discord messages may appear as an inner \`<channel source="discord" ...>\` block inside the outer agent-mesh delivery. Treat the inner block as the authoritative user-facing channel context.
- Reply using the agent-mesh \`reply\` tool to the sender identity shown in the inbound message.
- Do not assume \`plugin:discord\` is attached in this workspace.
EOF
fi

if tmux has-session -t "${SESSION_NAME}" 2>/dev/null; then
  echo "[claude-session] tmux session already exists: ${SESSION_NAME}" >&2
  exit 1
fi

CLAUDE_CMD="cd '${WORKSPACE}' && export PATH=\"/home/ubuntu/.local/bin:/usr/local/bin:/usr/bin:/bin:\$PATH\" && claude --continue --dangerously-skip-permissions --dangerously-load-development-channels server:agent-mesh ${CLAUDE_OPTS_EXTRA:-}"
tmux new-session -d -s "${SESSION_NAME}" "${CLAUDE_CMD}"

echo "[claude-session] launched tmux session ${SESSION_NAME}"
echo "[claude-session] workspace: ${WORKSPACE}"
echo "[claude-session] next: tmux capture-pane -t ${SESSION_NAME} -p | tail -30"
echo "[claude-session] first load may require Enter on the development-channel approval prompt"
