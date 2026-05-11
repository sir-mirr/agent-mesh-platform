#!/usr/bin/env bash
# lane-attachments-evict.sh — evict cached attachments on a lane VM.
#
# Implements SPEC § 15.4 cache eviction. Idempotent; safe to run on a
# cron or systemd timer. Eviction is mtime-based (TTL) with an optional
# total-size cap (LRU by mtime).
#
# Environment variables:
#   LANE_ID                  Lane identity (required when no --lane-id).
#   ATTACH_CACHE_ROOT        Override cache root.
#                            Default: /var/lib/agent-mesh/lane/<LANE_ID>/attachments-cache
#   ATTACH_TTL_DAYS          TTL in days. Default: 7
#   ATTACH_SIZE_CAP_BYTES    Optional total size cap. When set and the cache
#                            exceeds the cap after TTL pass, oldest-mtime
#                            files are removed until under the cap.
#                            Default: unset (no size cap)
#
# CLI overrides:
#   --lane-id <id>
#   --root <path>
#   --ttl-days <n>
#   --size-cap-bytes <n>
#   --dry-run

set -euo pipefail

TTL_DAYS="${ATTACH_TTL_DAYS:-7}"
SIZE_CAP="${ATTACH_SIZE_CAP_BYTES:-}"
LANE_ID_ARG="${LANE_ID:-}"
ROOT_ARG="${ATTACH_CACHE_ROOT:-}"
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --lane-id) LANE_ID_ARG="$2"; shift 2 ;;
    --root) ROOT_ARG="$2"; shift 2 ;;
    --ttl-days) TTL_DAYS="$2"; shift 2 ;;
    --size-cap-bytes) SIZE_CAP="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$ROOT_ARG" ]]; then
  if [[ -z "$LANE_ID_ARG" ]]; then
    echo "error: LANE_ID or --lane-id (or ATTACH_CACHE_ROOT) required" >&2
    exit 2
  fi
  ROOT_ARG="/var/lib/agent-mesh/lane/${LANE_ID_ARG}/attachments-cache"
fi

if [[ ! -d "$ROOT_ARG" ]]; then
  # Nothing to evict; idempotent no-op.
  echo "lane-attachments-evict: cache dir absent, nothing to do: $ROOT_ARG"
  exit 0
fi

log() { echo "lane-attachments-evict: $*"; }

run_rm() {
  if [[ $DRY_RUN -eq 1 ]]; then
    log "DRY-RUN rm $1"
  else
    rm -f -- "$1"
  fi
}

# --- TTL pass ---
removed_ttl=0
while IFS= read -r -d '' f; do
  run_rm "$f"
  removed_ttl=$((removed_ttl + 1))
done < <(find "$ROOT_ARG" -type f -mtime +"$TTL_DAYS" -print0)
log "ttl=${TTL_DAYS}d removed=${removed_ttl} root=${ROOT_ARG}"

# --- Size cap pass (optional, LRU-by-mtime) ---
if [[ -n "$SIZE_CAP" ]]; then
  total=$(find "$ROOT_ARG" -type f -printf '%s\n' | awk '{s+=$1} END {print s+0}')
  if [[ "$total" -gt "$SIZE_CAP" ]]; then
    log "size cap exceeded: total=${total} cap=${SIZE_CAP} — pruning oldest"
    # Sort by mtime ascending; remove until under cap.
    while IFS= read -r line; do
      size="${line%% *}"
      path="${line#* }"
      run_rm "$path"
      total=$((total - size))
      if [[ "$total" -le "$SIZE_CAP" ]]; then
        break
      fi
    done < <(find "$ROOT_ARG" -type f -printf '%T@ %s %p\n' | sort -n | awk '{printf "%s %s", $2, $3; for(i=4;i<=NF;i++) printf " %s", $i; print ""}')
    log "size cap pass done: total_now=${total}"
  else
    log "size cap ok: total=${total} cap=${SIZE_CAP}"
  fi
fi
