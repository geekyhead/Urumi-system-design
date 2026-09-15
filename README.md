# Store Orchestrator

A Kubernetes-native, multi-tenant **store provisioning platform**. Click "Create New Store" (or call the API) and within about two minutes you get a fully working WooCommerce shop at `http://store-<id>.127.0.0.1.nip.io`. The shop runs in its own namespace with its own database, quota, limits and network policy, and it already has Cash on Delivery enabled and a demo product seeded, so you can place an order right away.

The same Helm charts run on a laptop (Kind) and on a production VPS (k3s). Only the values file changes.

```
Dashboard (React) ──► Orchestrator API (Fastify) ──► helm upgrade --install charts/store
                                 │                          │
                                 └── reconciler ◄── pods / jobs in store-<id>
```

See [SYSTEM_DESIGN.md](SYSTEM_DESIGN.md) for architecture, isolation, reliability and security details.

---

## Fast start

Prerequisites: Docker (running, at least 4 CPUs and 6 GB RAM allocated), `curl`, `jq`, `make`. `kind`, `kubectl` and `helm` are downloaded into `./.bin` if they are missing. Host ports **80** and **443** must be free.

```bash
make setup    # Kind cluster "store-platform" + Ingress NGINX
make deploy   # build API + dashboard images, load into Kind, helm install platform
make test     # create store -> wait Ready -> place COD order via Store API -> delete store
make clean    # delete the cluster and local images
```

After `make deploy`:

| What | URL |
|------|-----|
| Dashboard | http://platform.127.0.0.1.nip.io |
| API | http://platform.127.0.0.1.nip.io/api/stores |
| A store | http://store-&lt;id&gt;.127.0.0.1.nip.io |
| Store admin | http://store-&lt;id&gt;.127.0.0.1.nip.io/wp-admin |

`nip.io` is public wildcard DNS: `anything.127.0.0.1.nip.io` resolves to `127.0.0.1`, so no `/etc/hosts` edits are needed. If your network blocks DNS rebinding answers for 127.0.0.1, add the hostnames to `/etc/hosts` manually.

Other targets: `make lint` (helm lint, TypeScript, bash syntax), `make build` (compile both apps without a cluster), `make status`, `make logs`.

---

## Local testing guide

### 1. Create a store from the dashboard

1. Open http://platform.127.0.0.1.nip.io.
2. Click **Create New Store**, enter a name, keep **WooCommerce** selected, pick a **Store type** (or keep "Auto-detect from store name") and click **Create Store**.
3. The row shows a yellow **Provisioning** badge. The dashboard polls every 5 seconds.
4. After about 1–3 minutes the badge turns green (**Ready**) and the **Open Store** and **Admin** buttons become active.
5. Click **Activity** to see the audit trail: create requested, provisioning started, ready.

### What a store contains

Every store runs WooCommerce's official **Storefront** theme and is seeded by the WP-CLI Job (`charts/store/files/`):

| Part | Content |
|------|---------|
| Home page | Hero with the store name, benefits row, categories, featured products and all products |
| Catalog | Products with generated images, prices, stock and categories that match what the store sells (see below). |
| Branding | Accent color derived from the store id (header, buttons, hero), store tagline, demo store notice |
| Navigation | Home, Shop, Cart, Checkout, My account (desktop menu and mobile footer bar) |
| Commerce | USD, guest checkout, AJAX add to cart, no shipping zones, **Cash on Delivery** enabled, classic cart and checkout pages |

The orchestrator builds each catalog in `platform/backend/src/catalogs.ts`, in this order:

1. **Your own products**: tick "Use my own product list" and enter `name, price, category` lines (up to 24).
2. **Store type** chosen in the dialog (19 types: RC & Hobby, Watches & Jewelry, Pet Supplies, Beauty, Bakery, Books, Electronics, Coffee & Tea, and more).
3. **Auto-detect** from the store name and "What will this store sell?" ("Josh RC Cars" gets RC buggies, crawlers, drones and LiPo batteries).
4. **Your items**: if no type matches, products are named after the items you typed ("surfboards, wetsuits" gets Essential and Premium surfboards and wetsuits).
5. **General store** when there is nothing to go on.

The dialog shows a live preview of the products before you create the store.

#### Opening stores when nip.io is blocked

Some browsers, ad blockers and embedded previews block `*.nip.io`. The page then loads without CSS or JavaScript and looks like plain HTML. Every local store also answers on `http://store-<id>.localhost` (and the dashboard on `http://platform.localhost`). Chrome and Firefox resolve `*.localhost` without DNS, and the dashboard shows this second link under each ready store.

### 2. Place an order manually

1. Click **Open Store**. You see the home page with the store's catalog.
2. Add a product to the cart and check out with **Cash on Delivery** (any address).
3. Log in to **Admin** with user `admin`. Get the password with:

   ```bash
   kubectl get secret -n store-<id> store-<id>-credentials -o jsonpath='{.data.admin-password}' | base64 -d; echo
   ```

4. Open **WooCommerce → Orders**. The order is listed with status **Processing**.

### 3. Place an order automatically

```bash
make test
```

`scripts/verify-e2e.sh` does the whole Definition of Done without a browser:

1. `POST /api/stores` with an idempotency key, then replays the same request and asserts the same store id comes back.
2. Polls `GET /api/stores/:id` until `Ready` (180 s timeout).
3. `GET /wp-json/wc/store/v1/products` to find the seeded product.
4. `GET /wp-json/wc/store/v1/cart` to obtain the `Nonce` and `Cart-Token`, then `POST .../cart/add-item`.
5. `POST .../checkout` with `payment_method: "cod"` and asserts a numeric `order_id` and status `processing` or `completed`.
6. `DELETE /api/stores/:id`, waits until namespace `store-<id>` is gone, and asserts no PersistentVolume is still bound to it.

Set `KEEP_STORE=true make test` to leave the store running for inspection.

### 4. Delete a store

Click **Delete Store** and confirm. The badge becomes **Deleting**. The orchestrator runs `helm uninstall`, deletes the namespace (with its PVCs), and removes the row when the namespace is gone.

### 5. Try the guardrails

```bash
# Quota: an 11th store is rejected with 429 STORE_QUOTA_EXCEEDED
# Engine stub: MedusaJS is rejected with 501 ENGINE_NOT_AVAILABLE
curl -s -XPOST http://platform.127.0.0.1.nip.io/api/stores \
  -H 'Content-Type: application/json' -d '{"name":"medusa-demo","engine":"medusa"}' | jq

# Per-store isolation
kubectl describe resourcequota -n store-<id>
kubectl get networkpolicy,limitrange -n store-<id>
```

### API reference

| Method | Path | Description |
|--------|------|-------------|
| GET | `/healthz` | Liveness. Returns `kubernetesReachable` from the last reconcile. |
| GET | `/readyz` | Readiness. 503 when the Kubernetes API is unreachable. |
| GET | `/api/platform` | Quota usage, engines, health, base domain. |
| GET | `/api/stores` | All stores with status, URLs, engine and timestamps. |
| POST | `/api/stores` | Body `{ name, engine: "woocommerce" \| "medusa", catalog?: "auto" \| "apparel" \| "books" \| "electronics" \| "coffee", idempotencyKey? }`. 202 created, 200 idempotent replay, 409/422 key conflict, 429 quota, 501 engine unavailable. The key can also be sent as an `Idempotency-Key` header. |
| GET | `/api/stores/:id` | Store plus live pod health, Helm release presence and seeder Job state. |
| DELETE | `/api/stores/:id` | 202. Uninstalls the release and deletes the namespace asynchronously. |
| GET | `/api/audit?limit=&storeId=` | Recent audit events, newest first. |

### Developing without rebuilding images

```bash
# API against the Kind cluster using your kubeconfig and local helm
cd platform/backend && npm install && npm run build
CHARTS_DIR=../../charts SERVICE_ACCOUNT_NAME=store-platform-api POD_NAMESPACE=store-platform npm start

# Dashboard with hot reload, proxied to the API above
cd platform/frontend && npm install && npm run dev   # http://localhost:5173
```

When you run the API outside the cluster it uses your own kubeconfig identity, so the admission policy (which only matches the in-cluster ServiceAccount) does not apply.

### Troubleshooting

| Symptom | Check |
|---------|-------|
| `make setup` says port 80 in use | Stop the local web server or other Kind cluster that holds 80/443. |
| Store stuck in Provisioning | `kubectl get pods,jobs -n store-<id>` and `kubectl logs -n store-<id> job/store-<id>-seeder`. The seeder downloads WooCommerce from wordpress.org, so the cluster needs internet access. |
| Store Failed with timeout | Slow first image pull. `make deploy` pre-pulls the store images; raise `orchestrator.provisionTimeoutSeconds` if your network is slow. A store that finishes later moves from Failed to Ready automatically. |
| Dashboard shows "Platform degraded" | `make logs`; the API cannot reach the Kubernetes API or helm failed. |

---

## Upgrades and rollback

Stores and the platform are Helm releases, so upgrades and rollbacks use Helm revisions. Data (MariaDB and `wp-content`) lives on PVCs that Helm never deletes on upgrade or rollback.

### How a store upgrade works

- Change the store chart or its values: an image tag (`wordpress.image`, `mariadb.image`), `seeder.woocommerceVersion`, `seeder.storefrontVersion` or `seeder.wordpressCoreVersion`.
- `helm upgrade` renders a new seeder Job named `store-<id>-seeder-r<revision>`. A Job's pod template is immutable, so a fixed name would make every upgrade fail; the revision suffix replaces the old Job instead.
- The seeder re-runs idempotently: it moves WooCommerce, Storefront and (optionally) WordPress core to the pinned versions, runs `wp core update-db` and `wp wc update`, and re-applies store settings.
- Products, pages and menus are seeded only once (`platform_content_seeded_at` option), so an upgrade never overwrites prices or pages a merchant edited. Set `seeder.reseedContent=true` to re-apply the catalog on purpose.

### Runbook

```bash
# 1. Back up one store (DB dump, wp-content, Helm values and revision) into backups/<id>/<timestamp>/
make backup STORE=<id>

# 2. Canary: upgrade one store to the current chart
make upgrade-stores STORES="<id>"

#    Pin a different plugin version for the canary only
EXTRA_ARGS="--set seeder.woocommerceVersion=8.9.3" ./scripts/upgrade-stores.sh <id>

# 3. Roll out to every WooCommerce store, one at a time
make upgrade-stores

# 4. Inspect history and roll back manually if needed
helm history store-<id> -n store-<id>
make rollback STORE=<id> REVISION=<n>
make rollback STORE=<id> REVISION=<n> BACKUP=backups/<id>/<timestamp>   # also restore DB + wp-content
```

`scripts/upgrade-stores.sh` does this for each store in turn:

1. Backs up the store (skip with `SKIP_BACKUP=true`).
2. Runs `helm upgrade --reset-then-reuse-values`: new chart defaults and `values-<profile>.yaml`, while keeping per-store values such as id, name, catalog and colors.
3. Waits for the new seeder Job and the WordPress rollout.
4. Smoke-tests `GET /wp-json/wc/store/v1/products` through the Ingress.
5. On any failure, rolls that store back to its previous revision, restores the backup, and stops. A bad release never reaches more than one store.

When to restore the backup during a rollback: `helm rollback` restores Kubernetes objects and versions, not data. If the failed upgrade ran database migrations (a newer WooCommerce or WordPress core), pass `BACKUP=` so the database matches the older code.

### Platform upgrades

```bash
make deploy                                                  # builds new image tags and runs helm upgrade --install
helm history store-platform -n store-platform
helm rollback store-platform <revision> -n store-platform --wait
```

The API keeps no state that a rollback could break. Store state lives in namespace annotations and the audit log on its PVC.

---

## Metrics

| Endpoint | Exposure | Content |
|----------|----------|---------|
| `GET /metrics` on the API pod (port 8080) | Cluster-internal only; the Ingress does not route it. The Service has `prometheus.io/scrape` annotations. | Prometheus text format |
| `GET /api/metrics/summary` | Through the Ingress, shown on the dashboard | JSON totals for the dashboard cards |

| Metric | Type | Labels |
|--------|------|--------|
| `store_platform_stores` | gauge | `status`, `engine` |
| `store_platform_stores_max` | gauge | |
| `store_platform_lifecycle_events_total` | counter | `action` (`STORE_CREATE_REQUESTED`, `STORE_READY`, `STORE_FAILED`, `STORE_DELETED`, `STORE_CREATE_REJECTED`, …) |
| `store_platform_provisioning_duration_seconds` | histogram | `engine`, `outcome` (`ready`, `failed`) |
| `store_platform_helm_operation_duration_seconds` | histogram | `operation` (`upgrade`, `uninstall`), `result` |
| `store_platform_process_*` | Node.js process metrics | |

Lifetime counters come from the persistent audit log, so they survive API restarts. Provisioning-time percentiles on the dashboard use the durations recorded on `STORE_READY` events.

```bash
kubectl port-forward -n store-platform deploy/store-platform-api 8080:8080
curl -s localhost:8080/metrics | grep '^store_platform_'
```

---

## Production VPS deployment (k3s)

Target: a single VPS (4 vCPU / 8 GB is enough for about 8–10 stores) with a public IP and a domain you control.

### 1. DNS

Create two records pointing at the VPS IP:

```
A   platform.example.com      203.0.113.10
A   *.stores.example.com      203.0.113.10
```

### 2. Install k3s without Traefik

The charts use the `nginx` ingress class, so disable the bundled Traefik:

```bash
curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="--disable traefik" sh -
mkdir -p ~/.kube && sudo cp /etc/rancher/k3s/k3s.yaml ~/.kube/config && sudo chown "$USER" ~/.kube/config
```

k3s ships the `local-path` StorageClass that `values-prod.yaml` uses, and it enforces NetworkPolicies out of the box.

### 3. Ingress NGINX and cert-manager

```bash
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo add jetstack https://charts.jetstack.io
helm repo update

helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx --create-namespace \
  --set controller.service.type=LoadBalancer \
  --set controller.config.use-forwarded-headers="true"

helm upgrade --install cert-manager jetstack/cert-manager \
  --namespace cert-manager --create-namespace --set crds.enabled=true
```

Create the `letsencrypt-prod` ClusterIssuer referenced by `values-prod.yaml`:

```bash
kubectl apply -f - <<'EOF'
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: ops@example.com
    privateKeySecretRef:
      name: letsencrypt-prod
    solvers:
      - http01:
          ingress:
            ingressClassName: nginx
EOF
```

HTTP-01 issues one certificate per store host. Let's Encrypt limits this to 50 certificates per registered domain per week. For many stores, switch to a DNS-01 solver and a wildcard certificate for `*.stores.example.com`.

### 4. Build and push images

```bash
REGISTRY=ghcr.io/your-org
docker build -t $REGISTRY/store-api:1.0.0 -f platform/backend/Dockerfile .
docker build -t $REGISTRY/store-dashboard:1.0.0 platform/frontend
docker push $REGISTRY/store-api:1.0.0
docker push $REGISTRY/store-dashboard:1.0.0
```

### 5. Configure the store profile

Edit `charts/store/values-prod.yaml` and set `global.baseDomain` to `stores.example.com`. This file is baked into the API image, so rebuild the API image after changing it.

### 6. Deploy the platform

```bash
helm upgrade --install store-platform charts/platform \
  --namespace store-platform --create-namespace \
  --set api.image.repository=$REGISTRY/store-api --set api.image.tag=1.0.0 \
  --set dashboard.image.repository=$REGISTRY/store-dashboard --set dashboard.image.tag=1.0.0 \
  --set orchestrator.storeProfile=prod \
  --set orchestrator.storeBaseDomain=stores.example.com \
  --set orchestrator.storeTls=true \
  --set 'orchestrator.storeAliasDomains={}' \
  --set ingress.host=platform.example.com \
  --set 'ingress.aliasHosts={}' \
  --set ingress.tls=true --set ingress.clusterIssuer=letsencrypt-prod \
  --wait
```

Stores created from `https://platform.example.com` are served at `https://store-<id>.stores.example.com` with automatic certificates.

### 7. Protect the dashboard

The platform ships without end-user authentication. Before exposing it publicly, put it behind your SSO, for example with ingress-nginx external auth:

```bash
--set-string 'ingress.annotations.nginx\.ingress\.kubernetes\.io/auth-url=https://auth.example.com/oauth2/auth'
```

or restrict it to an office or VPN range with `nginx.ingress.kubernetes.io/whitelist-source-range`.

### 8. Back up

Back up `/var/lib/rancher/k3s/storage` (all store PVCs and the audit database) and the `store-*` namespaces' Secrets. Velero with the local-path volume plugin works well for this.
