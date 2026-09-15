#!/usr/bin/env bash
# Upgrades stores to the current charts/store chart, one at a time:
# backup -> helm upgrade -> wait for the seeder Job -> smoke test -> next.
# A failed store is rolled back automatically and the run stops, so a bad
# release never reaches more than one store.
#
#   scripts/upgrade-stores.sh                 # every store
#   scripts/upgrade-stores.sh <id> [<id>...]  # selected stores (canary first)
#   EXTRA_ARGS="--set seeder.woocommerceVersion=8.9.3" scripts/upgrade-stores.sh <id>
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="${ROOT_DIR}/.bin:${PATH}"

PROFILE="${STORE_VALUES_PROFILE:-local}"
VALUES_FILE="${ROOT_DIR}/charts/store/values-${PROFILE}.yaml"
TIMEOUT="${TIMEOUT:-600}"
EXTRA_ARGS="${EXTRA_ARGS:-}"
SKIP_BACKUP="${SKIP_BACKUP:-false}"

log() { printf '\033[1;34m[upgrade]\033[0m %s\n' "$*"; }
ok()  { printf '\033[1;32m[ok]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

[[ -f "${VALUES_FILE}" ]] || die "values file ${VALUES_FILE} not found"

STORES=()
if [[ $# -gt 0 ]]; then
  STORES=("$@")
else
  # while-read instead of mapfile: macOS ships bash 3.2.
  while IFS= read -r id; do
    [[ -n "${id}" ]] && STORES+=("${id}")
  done < <(kubectl get ns -l platform.io/managed=true,platform.io/engine=woocommerce \
    -o jsonpath='{range .items[*]}{.metadata.labels.platform\.io/store-id}{"\n"}{end}')
fi
[[ ${#STORES[@]} -gt 0 ]] || die "no stores to upgrade"

for STORE_ID in "${STORES[@]}"; do
  NAMESPACE="store-${STORE_ID}"
  RELEASE="store-${STORE_ID}"
  log "=== ${RELEASE} ==="

  PREVIOUS="$(helm status "${RELEASE}" -n "${NAMESPACE}" -o json | jq -r .version)"
  BACKUP=""
  if [[ "${SKIP_BACKUP}" != "true" ]]; then
    BACKUP="$("${ROOT_DIR}/scripts/store-backup.sh" "${STORE_ID}" | tail -n1)"
  fi

  # --reset-then-reuse-values: take new chart defaults and the profile file,
  # but keep per-store values (store id, name, catalog, accent color).
  # shellcheck disable=SC2086
  if ! helm upgrade "${RELEASE}" "${ROOT_DIR}/charts/store" -n "${NAMESPACE}" \
      --reset-then-reuse-values -f "${VALUES_FILE}" ${EXTRA_ARGS} \
      --history-max 5 --timeout 5m; then
    log "helm upgrade failed; rolling back to revision ${PREVIOUS}"
    "${ROOT_DIR}/scripts/store-rollback.sh" "${STORE_ID}" "${PREVIOUS}" "${BACKUP}"
    die "upgrade of ${STORE_ID} failed and was rolled back"
  fi

  REV="$(helm status "${RELEASE}" -n "${NAMESPACE}" -o json | jq -r .version)"
  JOB="$(kubectl get jobs -n "${NAMESPACE}" \
    -l "app.kubernetes.io/component=seeder,app.kubernetes.io/instance=${RELEASE}" \
    --sort-by=.metadata.creationTimestamp -o jsonpath='{.items[-1:].metadata.name}')"
  log "Waiting for seeder Job ${JOB}"
  if ! kubectl wait -n "${NAMESPACE}" --for=condition=complete "job/${JOB}" --timeout="${TIMEOUT}s" \
      || ! kubectl rollout status -n "${NAMESPACE}" "deploy/${RELEASE}-wordpress" --timeout=180s; then
    kubectl logs -n "${NAMESPACE}" "job/${JOB}" --tail=20 || true
    log "revision ${REV} unhealthy; rolling back to revision ${PREVIOUS}"
    "${ROOT_DIR}/scripts/store-rollback.sh" "${STORE_ID}" "${PREVIOUS}" "${BACKUP}"
    die "upgrade of ${STORE_ID} failed and was rolled back"
  fi

  HOST="$(kubectl get ingress -n "${NAMESPACE}" "${RELEASE}" -o jsonpath='{.spec.rules[0].host}')"
  CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://${HOST}/wp-json/wc/store/v1/products" || true)"
  if [[ "${CODE}" != "200" ]]; then
    log "smoke test returned HTTP ${CODE}; rolling back to revision ${PREVIOUS}"
    "${ROOT_DIR}/scripts/store-rollback.sh" "${STORE_ID}" "${PREVIOUS}" "${BACKUP}"
    die "upgrade of ${STORE_ID} failed smoke test and was rolled back"
  fi
  ok "${RELEASE}: revision ${PREVIOUS} -> ${REV}, storefront API healthy"
done
