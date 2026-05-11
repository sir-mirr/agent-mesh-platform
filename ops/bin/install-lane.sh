#!/usr/bin/env bash
# install-lane.sh — idempotent lane-VM provisioner for internal-mesh v0.1.
#
# Run on a fresh lane VM (Ubuntu/Debian) AFTER the agent-mesh source
# tree has been synced to /srv/agent-mesh-platform (git clone or rsync).
#
# What it does (idempotent):
#   1. Sanity checks (bun on PATH, source tree present, root or sudo).
#   2. Creates /etc/agent-mesh/lane/         (0755 root:root)
#              /var/lib/agent-mesh/lane/     (0750 ubuntu:ubuntu)
#   3. Symlinks ops/systemd/agent-mesh-{lane@,runtime-adapter@,
#      channel-driver-discord@,lane-codex-app-server@}.{service,target}
#      into /etc/systemd/system/.
#   4. If --lane-id <id> is given, copies the env/secret templates to
#      /etc/agent-mesh/lane/<id>.env  (0644)
#      /etc/agent-mesh/lane/<id>.secret (0600, root:root)
#      only when the destination does not already exist (never clobbers).
#   5. Runs `systemctl daemon-reload`.
#
# What it explicitly does NOT do:
#   - Does NOT `enable` or `start` any unit.
#   - Does NOT call the core hub's POST /api/v1/agents — identity
#     provisioning is done by an operator from the core VM before
#     enabling the lane (see docs/lane-deployment.md).
#   - Does NOT install bun or other system packages.
#
# Usage:
#   sudo ops/bin/install-lane.sh                       # units + dirs only
#   sudo ops/bin/install-lane.sh --lane-id my-lane-1   # also seed env/secret templates

set -euo pipefail

PLATFORM_HOME="${PLATFORM_HOME:-/srv/agent-mesh-platform}"
SYSTEMD_DIR="/etc/systemd/system"
LANE_ENV_DIR="/etc/agent-mesh/lane"
LANE_STATE_DIR="/var/lib/agent-mesh/lane"
LANE_USER="${LANE_USER:-ubuntu}"
LANE_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --lane-id) LANE_ID="$2"; shift 2 ;;
    --help|-h)
      sed -n '1,40p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ $EUID -ne 0 ]]; then
  echo "install-lane.sh: must be run as root (use sudo)" >&2
  exit 1
fi

# 1. sanity
if [[ ! -d "$PLATFORM_HOME/packages/runtime-adapters" ]]; then
  echo "install-lane.sh: $PLATFORM_HOME does not look like an agent-mesh-platform checkout" >&2
  exit 1
fi
if ! sudo -u "$LANE_USER" bash -lc 'command -v bun >/dev/null'; then
  echo "install-lane.sh: WARNING — bun not found on PATH for user $LANE_USER. Install it before starting lane units." >&2
fi

# 2. dirs
install -d -m 0755 -o root   -g root   "$LANE_ENV_DIR"
install -d -m 0750 -o "$LANE_USER" -g "$LANE_USER" "$LANE_STATE_DIR"

# 3. symlink units
UNITS=(
  agent-mesh-lane@.target
  agent-mesh-lane-codex-app-server@.service
  agent-mesh-runtime-adapter@.service
  agent-mesh-channel-driver-discord@.service
)
for u in "${UNITS[@]}"; do
  src="$PLATFORM_HOME/ops/systemd/$u"
  dst="$SYSTEMD_DIR/$u"
  if [[ ! -f "$src" ]]; then
    echo "install-lane.sh: missing $src" >&2; exit 1
  fi
  if [[ -L "$dst" || -e "$dst" ]]; then
    current="$(readlink -f "$dst" 2>/dev/null || true)"
    if [[ "$current" != "$(readlink -f "$src")" ]]; then
      echo "install-lane.sh: refreshing symlink $dst -> $src"
      ln -sfn "$src" "$dst"
    fi
  else
    ln -s "$src" "$dst"
    echo "install-lane.sh: linked $dst -> $src"
  fi
done

# 4. optional env/secret seeding
if [[ -n "$LANE_ID" ]]; then
  env_dst="$LANE_ENV_DIR/$LANE_ID.env"
  sec_dst="$LANE_ENV_DIR/$LANE_ID.secret"
  env_src="$PLATFORM_HOME/ops/env/lane/lane.env.example"
  sec_src="$PLATFORM_HOME/ops/env/lane/lane.secret.example"
  if [[ -e "$env_dst" ]]; then
    echo "install-lane.sh: $env_dst already exists — leaving untouched"
  else
    install -m 0644 -o root -g root "$env_src" "$env_dst"
    sed -i "s/example-lane-1/$LANE_ID/g" "$env_dst"
    echo "install-lane.sh: seeded $env_dst (edit before starting)"
  fi
  if [[ -e "$sec_dst" ]]; then
    echo "install-lane.sh: $sec_dst already exists — leaving untouched"
  else
    install -m 0600 -o root -g root "$sec_src" "$sec_dst"
    echo "install-lane.sh: seeded $sec_dst (edit before starting, mode 0600 enforced)"
  fi
fi

# 5. daemon-reload
systemctl daemon-reload
echo "install-lane.sh: systemctl daemon-reload OK"

cat <<EONOTE

Next steps (NOT performed by this script):
  1. On the core VM, provision the lane identity:
       curl -X POST http://<core-vm>:<HUB_PORT>/api/v1/agents \\
            -H 'content-type: application/json' \\
            -d '{"identity":"<lane-id>","type":"ai-codex","description":"..."}'
  2. Edit /etc/agent-mesh/lane/<lane-id>.env  and  <lane-id>.secret
  3. systemctl enable --now agent-mesh-lane@<lane-id>.target
  4. journalctl -u agent-mesh-runtime-adapter@<lane-id> -f

See docs/lane-deployment.md for the full procedure.
EONOTE
