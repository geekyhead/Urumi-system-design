#!/usr/bin/env bash
# Production install on a fresh Ubuntu/Debian VPS: k3s (without Traefik),
# Ingress NGINX, cert-manager with a Let's Encrypt ClusterIssuer, then the
# platform chart with charts/platform/values-prod.yaml and images from GHCR.
#
#   sudo ./scripts/install-vps.sh --domain example.com --email ops@example.com \
#        [--ip 203.0.113.10] [--registry ghcr.io/geekyhead/urumi-system-design] [--tag latest]
#
# Before running: point DNS at the VPS
#   A  platform.<domain>    -> <ip>
#   A  *.stores.<domain>    -> <ip>
# Re-running the script is safe; every step is `helm upgrade --install` or idempotent.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOMAIN=""
EMAIL=""
PUBLIC_IP=""
REGISTRY="ghcr.io/geekyhead/urumi-system-design"
TAG="latest"
INGRESS_NGINX_VERSION="${INGRESS_NGINX_VERSION:-4.11.3}"
CERT_MANAGER_VERSION="${CERT_MANAGER_VERSION:-v1.16.2}"

log() { printf '\033[1;34m[vps]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --ip) PUBLIC_IP="$2"; shift 2 ;;
    --registry) REGISTRY="$2"; shift 2 ;;
    --tag) TAG="$2"; shift 2 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ -n "${DOMAIN}" && -n "${EMAIL}" ]] || die "--domain and --email are required"
[[ "${EUID}" -eq 0 ]] || die "run as root (sudo)"

if ! command -v jq >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
  log "Installing curl and jq"
  apt-get update -qq && apt-get install -y -qq curl jq
fi

[[ -n "${PUBLIC_IP}" ]] || PUBLIC_IP="$(curl -fsS https://api.ipify.org)"
log "Domain ${DOMAIN}, public IP ${PUBLIC_IP}"

if ! command -v k3s >/dev/null 2>&1; then
  log "Installing k3s (Traefik disabled; ingress-nginx is used instead)"
  curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="--disable traefik" sh -
fi
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
until kubectl get nodes 2>/dev/null | grep -q ' Ready'; do sleep 3; done
log "k3s node ready"

if ! command -v helm >/dev/null 2>&1; then
  log "Installing helm"
  curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
fi

helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx >/dev/null
helm repo add jetstack https://charts.jetstack.io >/dev/null
helm repo update >/dev/null

log "Installing Ingress NGINX ${INGRESS_NGINX_VERSION}"
helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx --version "${INGRESS_NGINX_VERSION}" \
  --namespace ingress-nginx --create-namespace \
  --set controller.service.type=LoadBalancer \
  --set controller.config.use-forwarded-headers="true" \
  --wait --timeout 5m

log "Installing cert-manager ${CERT_MANAGER_VERSION}"
helm upgrade --install cert-manager jetstack/cert-manager --version "${CERT_MANAGER_VERSION}" \
  --namespace cert-manager --create-namespace --set crds.enabled=true --wait --timeout 5m

log "Creating ClusterIssuer letsencrypt-prod"
kubectl apply -f - <<EOF
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: ${EMAIL}
    privateKeySecretRef:
      name: letsencrypt-prod
    solvers:
      - http01:
          ingress:
            ingressClassName: nginx
EOF

log "Installing the store platform"
helm upgrade --install store-platform "${ROOT_DIR}/charts/platform" \
  --namespace store-platform --create-namespace \
  -f "${ROOT_DIR}/charts/platform/values-prod.yaml" \
  --set ingress.host="platform.${DOMAIN}" \
  --set orchestrator.storeBaseDomain="stores.${DOMAIN}" \
  --set orchestrator.publicIngressAddress="${PUBLIC_IP}" \
  --set api.image.repository="${REGISTRY}/api" --set api.image.tag="${TAG}" \
  --set dashboard.image.repository="${REGISTRY}/dashboard" --set dashboard.image.tag="${TAG}" \
  --wait --timeout 10m

log "Waiting for https://platform.${DOMAIN}/healthz (certificate issuance can take a minute)"
for _ in $(seq 1 60); do
  curl -fsS "https://platform.${DOMAIN}/healthz" >/dev/null 2>&1 && break
  sleep 5
done

cat <<EOF

Platform installed.
  Dashboard: https://platform.${DOMAIN}
  Stores:    https://store-<id>.stores.${DOMAIN}

DNS records required (create them if you have not):
  A  platform.${DOMAIN}   ${PUBLIC_IP}
  A  *.stores.${DOMAIN}   ${PUBLIC_IP}

Sign-in tokens:
EOF
kubectl get secret -n store-platform store-platform-auth -o jsonpath='{.data.users\.json}' | base64 -d \
  | jq -r '.[] | "  \(.name) (\(.role), max \(.maxStores) stores): \(.token)"'
