#!/usr/bin/env bash
# Creates a Kind cluster with host ports 80/443 mapped to the control-plane
# node and installs the Ingress NGINX controller for Kind.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${ROOT_DIR}/.bin"
CLUSTER_NAME="${CLUSTER_NAME:-store-platform}"
KIND_VERSION="${KIND_VERSION:-v0.30.0}"
HELM_VERSION="${HELM_VERSION:-v3.18.6}"
KUBECTL_VERSION="${KUBECTL_VERSION:-v1.33.4}"
INGRESS_NGINX_MANIFEST="${INGRESS_NGINX_MANIFEST:-https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml}"

mkdir -p "${BIN_DIR}"
export PATH="${BIN_DIR}:${PATH}"

log() { printf '\033[1;34m[setup]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "${ARCH}" in
  x86_64|amd64) ARCH=amd64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) die "Unsupported architecture: ${ARCH}" ;;
esac

download() {
  local url="$1" dest="$2"
  log "Downloading ${url}"
  curl -fsSL --retry 3 -o "${dest}" "${url}"
}

ensure_docker() {
  command -v docker >/dev/null 2>&1 || die "docker is required. Install Docker Desktop / Docker Engine first."
  docker info >/dev/null 2>&1 || die "docker daemon is not running."
  log "docker $(docker version --format '{{.Server.Version}}')"
}

ensure_kind() {
  if ! command -v kind >/dev/null 2>&1; then
    download "https://kind.sigs.k8s.io/dl/${KIND_VERSION}/kind-${OS}-${ARCH}" "${BIN_DIR}/kind"
    chmod +x "${BIN_DIR}/kind"
  fi
  log "$(kind version)"
}

ensure_kubectl() {
  if ! command -v kubectl >/dev/null 2>&1; then
    download "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/${OS}/${ARCH}/kubectl" "${BIN_DIR}/kubectl"
    chmod +x "${BIN_DIR}/kubectl"
  fi
  log "kubectl $(kubectl version --client -o json | grep -m1 gitVersion | tr -d ' ",' | cut -d: -f2)"
}

ensure_helm() {
  if ! command -v helm >/dev/null 2>&1; then
    local tmp
    tmp="$(mktemp -d)"
    download "https://get.helm.sh/helm-${HELM_VERSION}-${OS}-${ARCH}.tar.gz" "${tmp}/helm.tgz"
    tar -xzf "${tmp}/helm.tgz" -C "${tmp}"
    mv "${tmp}/${OS}-${ARCH}/helm" "${BIN_DIR}/helm"
    chmod +x "${BIN_DIR}/helm"
    rm -rf "${tmp}"
  fi
  log "helm $(helm version --short)"
}

port_in_use() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  else
    (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1
  fi
}

create_cluster() {
  if kind get clusters 2>/dev/null | grep -qx "${CLUSTER_NAME}"; then
    log "Kind cluster '${CLUSTER_NAME}' already exists, reusing it"
    kubectl config use-context "kind-${CLUSTER_NAME}" >/dev/null
    return
  fi

  for port in 80 443; do
    port_in_use "${port}" && die "Host port ${port} is already in use; free it before creating the cluster."
  done

  local config
  config="$(mktemp)"
  cat >"${config}" <<EOF
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
name: ${CLUSTER_NAME}
nodes:
  - role: control-plane
    kubeadmConfigPatches:
      - |
        kind: InitConfiguration
        nodeRegistration:
          kubeletExtraArgs:
            node-labels: "ingress-ready=true"
    extraPortMappings:
      - containerPort: 80
        hostPort: 80
        protocol: TCP
      - containerPort: 443
        hostPort: 443
        protocol: TCP
EOF
  log "Creating Kind cluster '${CLUSTER_NAME}'"
  kind create cluster --config "${config}" --wait 120s
  rm -f "${config}"
}

install_ingress() {
  log "Installing Ingress NGINX controller"
  kubectl apply -f "${INGRESS_NGINX_MANIFEST}"
  # The controller pod is created by a Deployment; give the API a moment to create it.
  for _ in $(seq 1 30); do
    if kubectl get pods -n ingress-nginx -l app.kubernetes.io/component=controller -o name 2>/dev/null | grep -q pod/; then
      break
    fi
    sleep 2
  done
  kubectl wait --namespace ingress-nginx \
    --for=condition=ready pod \
    --selector=app.kubernetes.io/component=controller \
    --timeout=180s
  # Admission webhook must be reachable before Ingress objects can be created.
  kubectl wait --namespace ingress-nginx --for=condition=complete job --all --timeout=120s >/dev/null 2>&1 || true
}

ensure_docker
ensure_kind
ensure_kubectl
ensure_helm
create_cluster
install_ingress

log "Cluster ready. Context: kind-${CLUSTER_NAME}"
kubectl get nodes -o wide
