#!/usr/bin/env bash
# Backs up one store before an upgrade: MariaDB dump, wp-content (uploads,
# plugins, themes) and the Helm release values/revision.
#   scripts/store-backup.sh <store-id>
# Output: backups/<store-id>/<timestamp>/
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="${ROOT_DIR}/.bin:${PATH}"

STORE_ID="${1:?usage: store-backup.sh <store-id>}"
NAMESPACE="store-${STORE_ID}"
RELEASE="store-${STORE_ID}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="${BACKUP_DIR:-${ROOT_DIR}/backups}/${STORE_ID}/${STAMP}"

log() { printf '\033[1;34m[backup]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

kubectl get namespace "${NAMESPACE}" >/dev/null 2>&1 || die "namespace ${NAMESPACE} not found"
mkdir -p "${DEST}"

log "Recording Helm release state"
helm status "${RELEASE}" -n "${NAMESPACE}" -o json | jq '{revision: .version, chart: .chart.metadata.version, status: .info.status}' > "${DEST}/release.json"
helm get values "${RELEASE}" -n "${NAMESPACE}" -o yaml > "${DEST}/values.yaml"

log "Dumping MariaDB"
kubectl exec -n "${NAMESPACE}" "${RELEASE}-mariadb-0" -- sh -c \
  'mariadb-dump -uroot -p"$MARIADB_ROOT_PASSWORD" --single-transaction --routines --triggers wordpress' \
  | gzip > "${DEST}/wordpress.sql.gz"

log "Archiving wp-content"
kubectl exec -n "${NAMESPACE}" "deploy/${RELEASE}-wordpress" -- tar czf - -C /var/www/html wp-content > "${DEST}/wp-content.tar.gz"

[[ -s "${DEST}/wordpress.sql.gz" && -s "${DEST}/wp-content.tar.gz" ]] || die "backup files are empty"
log "Backup written to ${DEST} (revision $(jq -r .revision "${DEST}/release.json"))"
echo "${DEST}"
