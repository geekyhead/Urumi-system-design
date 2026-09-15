#!/usr/bin/env bash
# Rolls a store back to an earlier Helm revision and, optionally, restores the
# database and wp-content from a backup taken by store-backup.sh.
#   scripts/store-rollback.sh <store-id> [revision] [backup-dir]
# Without a revision, rolls back to the previous one. Pass a backup dir when
# the failed upgrade changed the database (plugin or core migrations).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="${ROOT_DIR}/.bin:${PATH}"

STORE_ID="${1:?usage: store-rollback.sh <store-id> [revision] [backup-dir]}"
REVISION="${2:-}"
BACKUP="${3:-}"
NAMESPACE="store-${STORE_ID}"
RELEASE="store-${STORE_ID}"
TIMEOUT="${TIMEOUT:-600}"

log() { printf '\033[1;34m[rollback]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

kubectl get namespace "${NAMESPACE}" >/dev/null 2>&1 || die "namespace ${NAMESPACE} not found"

if [[ -n "${BACKUP}" ]]; then
  [[ -f "${BACKUP}/wordpress.sql.gz" && -f "${BACKUP}/wp-content.tar.gz" ]] || die "no backup files in ${BACKUP}"
fi

log "Release history before rollback"
helm history "${RELEASE}" -n "${NAMESPACE}" --max 10

log "Rolling back ${RELEASE} to revision ${REVISION:-previous}"
# shellcheck disable=SC2086
helm rollback "${RELEASE}" ${REVISION} -n "${NAMESPACE}" --wait --timeout 5m

if [[ -n "${BACKUP}" ]]; then
  log "Restoring database from ${BACKUP}"
  gunzip -c "${BACKUP}/wordpress.sql.gz" | kubectl exec -i -n "${NAMESPACE}" "${RELEASE}-mariadb-0" -- sh -c \
    'mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" wordpress'
  log "Restoring wp-content"
  kubectl exec -i -n "${NAMESPACE}" "deploy/${RELEASE}-wordpress" -- sh -c \
    'rm -rf /var/www/html/wp-content && tar xzf - -C /var/www/html && chown -R www-data:www-data /var/www/html/wp-content' \
    < "${BACKUP}/wp-content.tar.gz"
fi

REV="$(helm status "${RELEASE}" -n "${NAMESPACE}" -o json | jq -r .version)"
# A rollback re-applies the old revision's manifest, so the Job keeps that
# revision's name (e.g. -seeder-r1). Wait for the newest seeder Job instead.
JOB="$(kubectl get jobs -n "${NAMESPACE}" \
  -l "app.kubernetes.io/component=seeder,app.kubernetes.io/instance=${RELEASE}" \
  --sort-by=.metadata.creationTimestamp -o jsonpath='{.items[-1:].metadata.name}')"
[[ -n "${JOB}" ]] || die "no seeder Job found in ${NAMESPACE}"
log "Waiting for seeder Job ${JOB}"
kubectl wait -n "${NAMESPACE}" --for=condition=complete "job/${JOB}" --timeout="${TIMEOUT}s" \
  || die "seeder ${JOB} did not complete; check: kubectl logs -n ${NAMESPACE} job/${JOB}"
kubectl rollout status -n "${NAMESPACE}" "deploy/${RELEASE}-wordpress" --timeout=180s
log "Store ${STORE_ID} is on revision ${REV}"
