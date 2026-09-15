#!/usr/bin/env bash
# Rolls a store back to an earlier Helm revision and, optionally, restores the
# database and wp-content from a backup taken by store-backup.sh.
#   scripts/store-rollback.sh <store-id> [revision] [backup-dir]
# Without a revision, rolls back to the previous one. Pass a backup dir when
# the failed upgrade changed the database (plugin or core migrations).
set -euo pipefail

LOG_PREFIX=rollback
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

STORE_ID="${1:?usage: store-rollback.sh <store-id> [revision] [backup-dir]}"
REVISION="${2:-}"
BACKUP="${3:-}"
NAMESPACE="$(store_namespace "${STORE_ID}")"
TIMEOUT="${TIMEOUT:-600}"

kubectl get namespace "${NAMESPACE}" >/dev/null 2>&1 || die "namespace ${NAMESPACE} not found"

if [[ -n "${BACKUP}" ]]; then
  [[ -f "${BACKUP}/wordpress.sql.gz" && -f "${BACKUP}/wp-content.tar.gz" ]] || die "no backup files in ${BACKUP}"
fi

log "Release history before rollback"
helm history "${NAMESPACE}" -n "${NAMESPACE}" --max 10

log "Rolling back ${NAMESPACE} to revision ${REVISION:-previous}"
# shellcheck disable=SC2086
helm rollback "${NAMESPACE}" ${REVISION} -n "${NAMESPACE}" --wait --timeout 5m

if [[ -n "${BACKUP}" ]]; then
  log "Restoring database from ${BACKUP}"
  gunzip -c "${BACKUP}/wordpress.sql.gz" | kubectl exec -i -n "${NAMESPACE}" "${NAMESPACE}-mariadb-0" -- sh -c \
    'mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" wordpress'
  log "Restoring wp-content"
  kubectl exec -i -n "${NAMESPACE}" "deploy/${NAMESPACE}-wordpress" -- sh -c \
    'rm -rf /var/www/html/wp-content && tar xzf - -C /var/www/html && chown -R www-data:www-data /var/www/html/wp-content' \
    < "${BACKUP}/wp-content.tar.gz"
fi

wait_for_store "${NAMESPACE}" "${TIMEOUT}" ||
  die "store did not become healthy; check: kubectl logs -n ${NAMESPACE} job/$(current_seeder_job "${NAMESPACE}")"
log "Store ${STORE_ID} is on revision $(helm status "${NAMESPACE}" -n "${NAMESPACE}" -o json | jq -r .version)"
