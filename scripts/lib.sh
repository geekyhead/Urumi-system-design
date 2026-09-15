#!/usr/bin/env bash
# Shared helpers for scripts/*.sh. Set LOG_PREFIX, then source this file:
#   LOG_PREFIX=deploy
#   . "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="${ROOT_DIR}/.bin:${PATH}"

LOG_PREFIX="${LOG_PREFIX:-script}"
PLATFORM_NAMESPACE="${PLATFORM_NAMESPACE:-store-platform}"
PLATFORM_RELEASE="${PLATFORM_RELEASE:-store-platform}"

log() { printf '\033[1;34m[%s]\033[0m %s\n' "${LOG_PREFIX}" "$*"; }
ok()  { printf '\033[1;32m[ok]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

# --- Platform users -----------------------------------------------------------

platform_users_json() {
  kubectl get secret -n "${PLATFORM_NAMESPACE}" "${PLATFORM_RELEASE}-auth" -o jsonpath='{.data.users\.json}' | base64 -d
}

# One line per user: name, role, quota, token (token last, so `awk '{print $NF}'` works).
print_tokens() {
  platform_users_json | jq -r '.[] | "\(.name)\t\(.role)\tmax \(.maxStores) stores\t\(.token)"'
}

admin_token() {
  platform_users_json 2>/dev/null | jq -r '[.[] | select(.role == "admin")][0].token // empty' 2>/dev/null || true
}

# --- Stores --------------------------------------------------------------------

# A store's namespace and its Helm release share one name: store-<id>.
store_namespace() { printf 'store-%s' "$1"; }

# Newest seeder Job of a store. Job names include the Helm revision, and a
# rollback re-applies an older revision's name, so select by label and age.
current_seeder_job() {
  kubectl get jobs -n "$1" -l "app.kubernetes.io/component=seeder,app.kubernetes.io/instance=$1" \
    --sort-by=.metadata.creationTimestamp -o jsonpath='{.items[-1:].metadata.name}'
}

# Waits for the current seeder Job to complete and WordPress to roll out.
#   wait_for_store <namespace> <timeout-seconds>
wait_for_store() {
  local namespace="$1" timeout="$2" job
  job="$(current_seeder_job "${namespace}")"
  [[ -n "${job}" ]] || { log "no seeder Job found in ${namespace}"; return 1; }
  log "Waiting for seeder Job ${job}"
  kubectl wait -n "${namespace}" --for=condition=complete "job/${job}" --timeout="${timeout}s" &&
    kubectl rollout status -n "${namespace}" "deploy/${namespace}-wordpress" --timeout=180s
}
