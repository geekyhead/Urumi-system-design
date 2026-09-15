#!/usr/bin/env bash
# Destroys the Kind cluster (and with it every store namespace, PVC and
# release) and removes locally built images.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="${ROOT_DIR}/.bin:${PATH}"
CLUSTER_NAME="${CLUSTER_NAME:-store-platform}"

log() { printf '\033[1;34m[teardown]\033[0m %s\n' "$*"; }

if command -v kind >/dev/null 2>&1 && kind get clusters 2>/dev/null | grep -qx "${CLUSTER_NAME}"; then
  log "Deleting Kind cluster '${CLUSTER_NAME}'"
  kind delete cluster --name "${CLUSTER_NAME}"
else
  log "Kind cluster '${CLUSTER_NAME}' not present"
fi

if command -v docker >/dev/null 2>&1; then
  images="$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^store-platform/(api|dashboard):' || true)"
  if [[ -n "${images}" ]]; then
    log "Removing local images"
    # shellcheck disable=SC2086
    docker rmi -f ${images} >/dev/null
  fi
fi

rm -rf "${ROOT_DIR}/platform/backend/dist" "${ROOT_DIR}/platform/frontend/dist"
log "Done"
