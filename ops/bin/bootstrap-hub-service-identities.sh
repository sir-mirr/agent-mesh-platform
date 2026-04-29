#!/usr/bin/env bash
set -euo pipefail

log() {
  echo "[bootstrap-hub-identities] $*" >&2
}

is_truthy() {
  local value="${1-}"
  case "${value,,}" in
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
  printf '%s/api/agents' "$raw_url"
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

declare -A DESCRIPTION_BY_IDENTITY=()
declare -a IDENTITY_ORDER=()

queue_identity() {
  local identity="${1:?identity required}"
  local description="${2-}"
  [[ -n "${DESCRIPTION_BY_IDENTITY[$identity]+x}" ]] || IDENTITY_ORDER+=("$identity")
  DESCRIPTION_BY_IDENTITY["$identity"]="$description"
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

discover_codex_adapter_identities() {
  shopt -s nullglob
  local env_file identity target lane
  for env_file in "${ENV_ROOT}"/*/adapter.env; do
    identity="$(read_env_var "$env_file" CODEX_ADAPTER_IDENTITY)"
    [[ -n "$identity" ]] || continue
    target="$(read_env_var "$env_file" CODEX_TARGET_AGENT)"
    lane="${target:-$(basename "$(dirname "$env_file")")}"
    queue_identity "$identity" "Codex runtime adapter for ${lane}"
  done
  shopt -u nullglob
}

discover_discord_hub_forward_identities() {
  shopt -s nullglob
  local env_file identity target
  for env_file in "${ENV_ROOT}"/*/discord.env; do
    identity="$(read_env_var "$env_file" HUB_FORWARD_IDENTITY)"
    target="$(read_env_var "$env_file" HUB_FORWARD_TARGET_AGENT)"
    [[ -n "$identity" && -n "$target" ]] || continue
    queue_identity "$identity" "Discord hub-forward for ${target}"
  done
  shopt -u nullglob
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
  discover_codex_adapter_identities
  discover_discord_hub_forward_identities

  if ((${#IDENTITY_ORDER[@]} == 0)); then
    log "no service identities discovered under ${ENV_ROOT}"
    exit 0
  fi

  log "discovered ${#IDENTITY_ORDER[@]} service identities from ${ENV_ROOT}"
  local identity
  for identity in "${IDENTITY_ORDER[@]}"; do
    post_identity "$identity" "${DESCRIPTION_BY_IDENTITY[$identity]}"
  done
}

ENV_ROOT="${AGENT_MESH_ENV_ROOT:-${AGENT_MESH_LAB_HOME:-/srv/agent-mesh-lab}/env}"
HUB_WS_URL="${AGENT_MESH_HUB_URL:-${HUB_URL:-ws://127.0.0.1:3100/ws}}"
HUB_API_URL="${AGENT_MESH_HUB_API_URL:-$(derive_hub_api_url "$HUB_WS_URL")}"
MAX_RETRIES="${HUB_BOOTSTRAP_MAX_RETRIES:-30}"
RETRY_SLEEP_SEC="${HUB_BOOTSTRAP_RETRY_SLEEP_SEC:-1}"
DRY_RUN="${HUB_BOOTSTRAP_DRY_RUN:-false}"

main "$@"
