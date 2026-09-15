#!/usr/bin/env bash
# Builds the orchestrator API and dashboard images, loads them into Kind and
# installs the platform Helm chart.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="${ROOT_DIR}/.bin:${PATH}"

CLUSTER_NAME="${CLUSTER_NAME:-store-platform}"
NAMESPACE="${PLATFORM_NAMESPACE:-store-platform}"
RELEASE="${PLATFORM_RELEASE:-store-platform}"
IMAGE_TAG="${IMAGE_TAG:-local-$(date +%Y%m%d%H%M%S)}"
API_IMAGE="store-platform/api:${IMAGE_TAG}"
DASHBOARD_IMAGE="store-platform/dashboard:${IMAGE_TAG}"
PLATFORM_HOST="${PLATFORM_HOST:-platform.127.0.0.1.nip.io}"

log() { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

for bin in docker kind kubectl helm curl; do
  command -v "${bin}" >/dev/null 2>&1 || die "${bin} not found. Run 'make setup' first."
done
kind get clusters 2>/dev/null | grep -qx "${CLUSTER_NAME}" || die "Kind cluster '${CLUSTER_NAME}' not found. Run 'make setup' first."
kubectl config use-context "kind-${CLUSTER_NAME}" >/dev/null

log "Building ${API_IMAGE}"
docker build -t "${API_IMAGE}" -f "${ROOT_DIR}/platform/backend/Dockerfile" "${ROOT_DIR}"

log "Building ${DASHBOARD_IMAGE}"
docker build -t "${DASHBOARD_IMAGE}" -f "${ROOT_DIR}/platform/frontend/Dockerfile" "${ROOT_DIR}/platform/frontend"

load_image() {
  local image="$1"
  if kind load docker-image "${image}" --name "${CLUSTER_NAME}" >/dev/null 2>&1; then
    return
  fi
  # Docker's containerd image store can produce multi-manifest images that
  # `kind load docker-image` rejects; an archive import works in both modes.
  log "kind load docker-image failed for ${image}, retrying via image archive"
  local archive
  archive="$(mktemp -t kind-image.XXXXXX).tar"
  docker save "${image}" -o "${archive}"
  kind load image-archive "${archive}" --name "${CLUSTER_NAME}"
  rm -f "${archive}"
}

log "Loading images into Kind"
load_image "${API_IMAGE}"
load_image "${DASHBOARD_IMAGE}"

# Pre-pull the per-store images on every node so the first store is not
# charged several minutes of image download against its provisioning timeout.
STORE_IMAGES=(mariadb:10.11 wordpress:6.4-php8.2-apache wordpress:cli-2.9-php8.2)
log "Pre-pulling store images on Kind nodes: ${STORE_IMAGES[*]}"
pids=()
for node in $(kind get nodes --name "${CLUSTER_NAME}"); do
  for image in "${STORE_IMAGES[@]}"; do
    docker exec "${node}" crictl pull "docker.io/library/${image}" >/dev/null &
    pids+=($!)
  done
done
for pid in "${pids[@]}"; do
  wait "${pid}" || die "Failed to pre-pull a store image (check network access to Docker Hub)"
done

log "Installing platform chart"
helm upgrade --install "${RELEASE}" "${ROOT_DIR}/charts/platform" \
  --namespace "${NAMESPACE}" --create-namespace \
  --set api.image.repository=store-platform/api \
  --set api.image.tag="${IMAGE_TAG}" \
  --set dashboard.image.repository=store-platform/dashboard \
  --set dashboard.image.tag="${IMAGE_TAG}" \
  --set ingress.host="${PLATFORM_HOST}" \
  --wait --timeout 5m

log "Waiting for API to answer through the ingress"
for _ in $(seq 1 60); do
  if curl -fsS "http://${PLATFORM_HOST}/healthz" >/dev/null 2>&1; then
    log "Platform is up"
    log "Dashboard: http://${PLATFORM_HOST}"
    log "API:       http://${PLATFORM_HOST}/api/stores"
    exit 0
  fi
  sleep 2
done
kubectl get pods -n "${NAMESPACE}"
die "Platform did not become reachable at http://${PLATFORM_HOST}/healthz"
