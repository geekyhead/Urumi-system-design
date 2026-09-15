#!/usr/bin/env bash
# End-to-end Definition of Done check:
#   create store -> wait Ready -> place a WooCommerce COD order through the
#   Store API -> delete store -> assert namespace is gone.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="${ROOT_DIR}/.bin:${PATH}"

PLATFORM_HOST="${PLATFORM_HOST:-platform.127.0.0.1.nip.io}"
API="${API_URL:-http://${PLATFORM_HOST}/api}"
STORE_NAME="${STORE_NAME:-test-e2e-store}"
READY_TIMEOUT="${READY_TIMEOUT:-180}"
DELETE_TIMEOUT="${DELETE_TIMEOUT:-180}"
KEEP_STORE="${KEEP_STORE:-false}"

WORK_DIR="$(mktemp -d)"
COOKIES="${WORK_DIR}/cookies.txt"
STORE_ID=""
COMPLETED=false
LAST_CODE=""
BODY=""

log()  { printf '\033[1;34m[e2e]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[SUCCESS]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[FAIL]\033[0m %s\n' "$*" >&2; exit 1; }

cleanup() {
  local code=$?
  # Any exit before the final line is a failure, even if bash reports 0
  # (e.g. `set -u` aborts inside older bash versions).
  [[ "${COMPLETED}" == "true" ]] || { [[ ${code} -ne 0 ]] || code=1; }
  if [[ ${code} -ne 0 && -n "${STORE_ID}" && "${KEEP_STORE}" != "true" ]]; then
    log "Test failed; deleting store ${STORE_ID} so it does not leak"
    curl -fsS -X DELETE "${API}/stores/${STORE_ID}" >/dev/null 2>&1 || true
  fi
  rm -rf "${WORK_DIR}"
  exit "${code}"
}
trap cleanup EXIT

for bin in curl jq kubectl; do
  command -v "${bin}" >/dev/null 2>&1 || fail "${bin} is required"
done

# ---------------------------------------------------------------------------
log "Checking platform health at ${API%/api}/healthz"
curl -fsS "${API%/api}/healthz" >/dev/null || fail "Platform API not reachable. Run 'make deploy' first."

# ---------------------------------------------------------------------------
IDEMPOTENCY_KEY="e2e-$(date +%s)-${RANDOM}"
log "Creating store '${STORE_NAME}' (idempotency key ${IDEMPOTENCY_KEY})"
create_body="$(jq -n --arg name "${STORE_NAME}" --arg key "${IDEMPOTENCY_KEY}" \
  '{name: $name, engine: "woocommerce", idempotencyKey: $key}')"
create_resp="$(curl -sS -w '\n%{http_code}' -X POST "${API}/stores" \
  -H 'Content-Type: application/json' -d "${create_body}")"
create_code="$(tail -n1 <<<"${create_resp}")"
create_json="$(sed '$d' <<<"${create_resp}")"
[[ "${create_code}" == "202" || "${create_code}" == "200" ]] || fail "POST /api/stores returned ${create_code}: ${create_json}"
STORE_ID="$(jq -r '.id' <<<"${create_json}")"
[[ -n "${STORE_ID}" && "${STORE_ID}" != "null" ]] || fail "No store id in response: ${create_json}"
log "Store id: ${STORE_ID}"

log "Replaying the same request to prove idempotency"
replay_json="$(curl -fsS -X POST "${API}/stores" -H 'Content-Type: application/json' -d "${create_body}")"
[[ "$(jq -r '.id' <<<"${replay_json}")" == "${STORE_ID}" ]] || fail "Idempotent replay returned a different store: ${replay_json}"

# ---------------------------------------------------------------------------
log "Waiting up to ${READY_TIMEOUT}s for status Ready"
deadline=$(( $(date +%s) + READY_TIMEOUT ))
status=""
while :; do
  detail="$(curl -fsS "${API}/stores/${STORE_ID}")" || fail "GET /api/stores/${STORE_ID} failed"
  status="$(jq -r '.status' <<<"${detail}")"
  case "${status}" in
    Ready) break ;;
    Failed) fail "Store provisioning failed: $(jq -r '.reason' <<<"${detail}")" ;;
  esac
  if (( $(date +%s) >= deadline )); then
    jq . <<<"${detail}" >&2
    fail "Store not Ready after ${READY_TIMEOUT}s (status=${status})"
  fi
  printf '  status=%s seeder=%s\n' "${status}" "$(jq -r '.health.seederJob // "n/a"' <<<"${detail}")"
  sleep 5
done
ok "Store ${STORE_ID} is Ready"

STORE_URL="http://store-${STORE_ID}.127.0.0.1.nip.io"
reported_url="$(jq -r '.urls.storefront' <<<"${detail}")"
[[ "${reported_url}" == "${STORE_URL}" ]] || fail "API reported storefront ${reported_url}, expected ${STORE_URL}"
log "Storefront: ${STORE_URL}"

# ---------------------------------------------------------------------------
# WooCommerce Store API checkout. The Store API requires a Nonce and a
# Cart-Token that are issued on the first cart request and rotated on writes.
NONCE=""
CART_TOKEN=""

store_api() {
  # usage: store_api METHOD PATH [JSON_BODY]
  # Sets BODY and LAST_CODE in the current shell; never call it inside $(...).
  local method="$1" path="$2" body="${3:-}" headers_file="${WORK_DIR}/headers" out_file="${WORK_DIR}/body"
  local args=(-sS -X "${method}" -b "${COOKIES}" -c "${COOKIES}" -D "${headers_file}" -o "${out_file}" -w '%{http_code}'
    -H 'Accept: application/json')
  [[ -n "${NONCE}" ]] && args+=(-H "Nonce: ${NONCE}")
  [[ -n "${CART_TOKEN}" ]] && args+=(-H "Cart-Token: ${CART_TOKEN}")
  [[ -n "${body}" ]] && args+=(-H 'Content-Type: application/json' --data "${body}")
  LAST_CODE="$(curl "${args[@]}" "${STORE_URL}${path}")"
  local new_nonce new_token
  new_nonce="$(grep -i '^nonce:' "${headers_file}" | tail -n1 | cut -d' ' -f2- | tr -d '\r' || true)"
  new_token="$(grep -i '^cart-token:' "${headers_file}" | tail -n1 | cut -d' ' -f2- | tr -d '\r' || true)"
  [[ -n "${new_nonce}" ]] && NONCE="${new_nonce}"
  [[ -n "${new_token}" ]] && CART_TOKEN="${new_token}"
  BODY="$(cat "${out_file}")"
  return 0
}

log "Fetching products from /wp-json/wc/store/v1/products"
for _ in $(seq 1 12); do
  store_api GET /wp-json/wc/store/v1/products
  if [[ "${LAST_CODE}" == "200" ]] && jq -e 'length > 0' <<<"${BODY}" >/dev/null 2>&1; then
    break
  fi
  sleep 5
done
products="${BODY}"
[[ "${LAST_CODE}" == "200" ]] || fail "Products endpoint returned ${LAST_CODE}: ${products}"
PRODUCT_ID="$(jq -r '[.[] | select(.name == "Classic Hoodie")][0].id // .[0].id' <<<"${products}")"
[[ "${PRODUCT_ID}" =~ ^[0-9]+$ ]] || fail "No seeded product found: ${products}"
log "Seeded product id: ${PRODUCT_ID}"

log "Initialising cart session"
store_api GET /wp-json/wc/store/v1/cart
[[ "${LAST_CODE}" == "200" ]] || fail "GET cart returned ${LAST_CODE}: ${BODY}"
[[ -n "${NONCE}" ]] || fail "Store API did not issue a Nonce header"

log "Adding product to cart"
store_api POST /wp-json/wc/store/v1/cart/add-item "$(jq -n --argjson id "${PRODUCT_ID}" '{id: $id, quantity: 1}')"
cart="${BODY}"
[[ "${LAST_CODE}" == "201" || "${LAST_CODE}" == "200" ]] || fail "add-item returned ${LAST_CODE}: ${cart}"
[[ "$(jq -r '.items_count' <<<"${cart}")" -ge 1 ]] || fail "Cart is empty after add-item: ${cart}"

log "Submitting checkout with Cash on Delivery"
address='{"first_name":"E2E","last_name":"Tester","company":"","address_1":"123 Test St","address_2":"","city":"Austin","state":"TX","postcode":"78701","country":"US","email":"e2e@example.com","phone":"5555555555"}'
checkout_body="$(jq -n --argjson addr "${address}" '{
  billing_address: $addr,
  shipping_address: ($addr | del(.email)),
  payment_method: "cod",
  customer_note: "Automated end-to-end verification order"
}')"
store_api POST /wp-json/wc/store/v1/checkout "${checkout_body}"
order="${BODY}"
[[ "${LAST_CODE}" == "200" || "${LAST_CODE}" == "201" ]] || fail "Checkout returned ${LAST_CODE}: ${order}"

ORDER_ID="$(jq -r '.order_id' <<<"${order}")"
ORDER_STATUS="$(jq -r '.status' <<<"${order}")"
[[ "${ORDER_ID}" =~ ^[0-9]+$ && "${ORDER_ID}" -gt 0 ]] || fail "Checkout response has no valid order_id: ${order}"
[[ "${ORDER_STATUS}" == "processing" || "${ORDER_STATUS}" == "completed" ]] || fail "Unexpected order status '${ORDER_STATUS}': ${order}"
ok "End-to-end order placed successfully! Order ID: #${ORDER_ID} (status: ${ORDER_STATUS})"

if [[ "${KEEP_STORE}" == "true" ]]; then
  log "KEEP_STORE=true, leaving store ${STORE_ID} running at ${STORE_URL}"
  STORE_ID=""
  COMPLETED=true
  exit 0
fi

# ---------------------------------------------------------------------------
log "Deleting store ${STORE_ID}"
del_code="$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE "${API}/stores/${STORE_ID}")"
[[ "${del_code}" == "202" || "${del_code}" == "200" ]] || fail "DELETE returned ${del_code}"
NAMESPACE="store-${STORE_ID}"
STORE_ID_FOR_CHECK="${STORE_ID}"
STORE_ID=""

log "Waiting up to ${DELETE_TIMEOUT}s for namespace ${NAMESPACE} to disappear"
deadline=$(( $(date +%s) + DELETE_TIMEOUT ))
while kubectl get namespace "${NAMESPACE}" >/dev/null 2>&1; do
  (( $(date +%s) < deadline )) || fail "Namespace ${NAMESPACE} still exists after ${DELETE_TIMEOUT}s"
  sleep 3
done

leaked_pv="$(kubectl get pv -o json | jq -r --arg ns "${NAMESPACE}" '[.items[] | select(.spec.claimRef.namespace == $ns)] | length')"
[[ "${leaked_pv}" == "0" ]] || fail "${leaked_pv} PersistentVolume(s) still bound to ${NAMESPACE}"

gone_code="$(curl -sS -o /dev/null -w '%{http_code}' "${API}/stores/${STORE_ID_FOR_CHECK}")"
[[ "${gone_code}" == "404" ]] || fail "API still returns ${gone_code} for deleted store"

audit_count="$(curl -fsS "${API}/audit?storeId=${STORE_ID_FOR_CHECK}" | jq 'length')"
log "Audit entries recorded for store: ${audit_count}"

ok "Namespace ${NAMESPACE} removed, no PersistentVolumes leaked. All checks passed."
COMPLETED=true
