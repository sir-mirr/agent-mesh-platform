#!/usr/bin/env bash
set -euo pipefail

log() {
  echo "[bootstrap-hub-identities] $*" >&2
}

is_truthy() {
  local value="${1-}"
  # `tr` rather than `${value,,}`: that form is bash 4, and this script is
  # `ExecStartPost` on the hub unit — on a host whose /bin/bash is 3.2 it would
  # abort under `set -e` with `declare: -A: invalid option`, failing the hub
  # start with a message about nothing an operator can act on.
  case "$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

json_escape() {
  local value="${1-}"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  printf '%s' "$value"
}

derive_hub_api_url() {
  local raw_url="${1:?hub url required}"
  case "$raw_url" in
    ws://*)
      raw_url="http://${raw_url#ws://}"
      ;;
    wss://*)
      raw_url="https://${raw_url#wss://}"
      ;;
    http://*|https://*)
      ;;
    *)
      log "unsupported hub url: ${raw_url}"
      return 1
      ;;
  esac
  raw_url="${raw_url%/ws}"
  raw_url="${raw_url%/}"
  # SPEC §10 — identity provisioning MUST use the versioned endpoint
  # POST /api/v1/agents. The unversioned /api/agents is a legacy alias.
  printf '%s/api/v1/agents' "$raw_url"
}

read_env_var() {
  local env_file="${1:?env file required}"
  local var_name="${2:?var name required}"
  [[ -f "$env_file" ]] || return 0
  (
    set -a
    # shellcheck disable=SC1090
    source "$env_file"
    printf '%s' "${!var_name:-}"
  )
}

# Two parallel indexed arrays rather than one associative array, for the same
# bash-3.2 reason as above. The set is two entries long; the index scan costs
# nothing and the script runs everywhere.
IDENTITY_ORDER=()
DESCRIPTIONS=()

queue_identity() {
  local identity="${1:?identity required}"
  local description="${2-}"
  local i
  for (( i = 0; i < ${#IDENTITY_ORDER[@]}; i += 1 )); do
    if [[ "${IDENTITY_ORDER[$i]}" == "$identity" ]]; then
      DESCRIPTIONS[$i]="$description"
      return 0
    fi
  done
  IDENTITY_ORDER+=("$identity")
  DESCRIPTIONS+=("$description")
}

discover_http_identity() {
  local http_env="${ENV_ROOT}/shared/http.env"
  local node_env
  node_env="$(read_env_var "$http_env" NODE_ENV)"
  local identity="http-server"
  if [[ "$node_env" == "development" ]]; then
    identity="${identity}-dev"
  fi
  queue_identity "$identity" "Agent Mesh Web UI"
}

discover_self_reminder_identity() {
  local self_reminder_env="${ENV_ROOT}/shared/self-reminder.env"
  local identity
  identity="$(read_env_var "$self_reminder_env" SELF_REMINDER_IDENTITY)"
  queue_identity "${identity:-self-reminder}" "SelfReminder service (PoC1)"
}

post_identity() {
  local identity="${1:?identity required}"
  local description="${2-}"
  local payload response attempt
  if is_truthy "$DRY_RUN"; then
    log "dry-run register ${identity} (type=service description=${description})"
    return 0
  fi
  payload="$(printf '{"identity":"%s","type":"service","description":"%s"}' \
    "$(json_escape "$identity")" \
    "$(json_escape "$description")")"

  for (( attempt = 1; attempt <= MAX_RETRIES; attempt += 1 )); do
    if response="$(
      curl --silent --show-error --fail \
        --header 'Content-Type: application/json' \
        --data "$payload" \
        "$HUB_API_URL" 2>&1
    )"; then
      log "registered ${identity}: ${response}"
      return 0
    fi
    if (( attempt == MAX_RETRIES )); then
      log "failed to register ${identity} after ${MAX_RETRIES} attempts: ${response}"
      return 1
    fi
    sleep "$RETRY_SLEEP_SEC"
  done
}

main() {
  command -v curl >/dev/null 2>&1 || {
    log "curl is required"
    exit 1
  }

  discover_http_identity
  discover_self_reminder_identity

  if ((${#IDENTITY_ORDER[@]} == 0)); then
    log "no service identities discovered under ${ENV_ROOT}"
    exit 0
  fi

  log "discovered ${#IDENTITY_ORDER[@]} service identities from ${ENV_ROOT}"
  local i
  for (( i = 0; i < ${#IDENTITY_ORDER[@]}; i += 1 )); do
    post_identity "${IDENTITY_ORDER[$i]}" "${DESCRIPTIONS[$i]}"
  done
}

ENV_ROOT="${AGENT_MESH_ENV_ROOT:-${AGENT_MESH_LAB_HOME:-/srv/agent-mesh-lab}/env}"
HUB_WS_URL="${AGENT_MESH_HUB_URL:-${HUB_URL:-ws://127.0.0.1:3100/ws}}"
HUB_API_URL="${AGENT_MESH_HUB_API_URL:-$(derive_hub_api_url "$HUB_WS_URL")}"
MAX_RETRIES="${HUB_BOOTSTRAP_MAX_RETRIES:-30}"
RETRY_SLEEP_SEC="${HUB_BOOTSTRAP_RETRY_SLEEP_SEC:-1}"
DRY_RUN="${HUB_BOOTSTRAP_DRY_RUN:-false}"

main "$@"
