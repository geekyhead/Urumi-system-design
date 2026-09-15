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

LOG_PREFIX=upgrade
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

PROFILE="${STORE_VALUES_PROFILE:-local}"
VALUES_FILE="${ROOT_DIR}/charts/store/values-${PROFILE}.yaml"
TIMEOUT="${TIMEOUT:-600}"
EXTRA_ARGS="${EXTRA_ARGS:-}"
SKIP_BACKUP="${SKIP_BACKUP:-false}"

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

helm_revision() { helm status "$1" -n "$1" -o json | jq -r .version; }

for STORE_ID in "${STORES[@]}"; do
  NAMESPACE="$(store_namespace "${STORE_ID}")"
  log "=== ${NAMESPACE} ==="

  PREVIOUS="$(helm_revision "${NAMESPACE}")"
  BACKUP=""
  if [[ "${SKIP_BACKUP}" != "true" ]]; then
    BACKUP="$("${ROOT_DIR}/scripts/store-backup.sh" "${STORE_ID}" | tail -n1)"
  fi

  rollback_and_die() {
    log "$1; rolling back to revision ${PREVIOUS}"
    "${ROOT_DIR}/scripts/store-rollback.sh" "${STORE_ID}" "${PREVIOUS}" "${BACKUP}"
    die "upgrade of ${STORE_ID} failed and was rolled back"
  }

  # --reset-then-reuse-values: take new chart defaults and the profile file,
  # but keep per-store values (store id, name, catalog, accent color).
  # shellcheck disable=SC2086
  helm upgrade "${NAMESPACE}" "${ROOT_DIR}/charts/store" -n "${NAMESPACE}" \
    --reset-then-reuse-values -f "${VALUES_FILE}" ${EXTRA_ARGS} \
    --history-max 5 --timeout 5m || rollback_and_die "helm upgrade failed"

  REV="$(helm_revision "${NAMESPACE}")"
  if ! wait_for_store "${NAMESPACE}" "${TIMEOUT}"; then
    kubectl logs -n "${NAMESPACE}" "job/$(current_seeder_job "${NAMESPACE}")" --tail=20 || true
    rollback_and_die "revision ${REV} unhealthy"
  fi

  HOST="$(kubectl get ingress -n "${NAMESPACE}" "${NAMESPACE}" -o jsonpath='{.spec.rules[0].host}')"
  CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://${HOST}/wp-json/wc/store/v1/products" || true)"
  [[ "${CODE}" == "200" ]] || rollback_and_die "smoke test returned HTTP ${CODE}"
  ok "${NAMESPACE}: revision ${PREVIOUS} -> ${REV}, storefront API healthy"
done
