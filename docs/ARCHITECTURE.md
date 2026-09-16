# Architecture

This document shows every component of the store provisioning platform and exactly how the components talk to each other: who calls whom, over which protocol and port, with which credentials, and what restricts the connection.

GitHub renders the Mermaid diagrams. An ASCII version of the main diagram is at the end for viewers without Mermaid.

---

## 1. Component diagram

```mermaid
flowchart TB
  operator([Operator browser<br/>dashboard user])
  shopper([Shopper browser])
  prom([Prometheus<br/>optional])
  dns[(Public DNS<br/>nip.io / your domain)]
  wporg[(downloads.wordpress.org)]
  acme[(Let's Encrypt<br/>prod only)]

  subgraph host[Host: laptop with Kind, or VPS with k3s]
    subgraph cluster[Kubernetes cluster]
      kapi[[kube-apiserver]]

      subgraph ingressns[namespace: ingress-nginx]
        ingress[Ingress NGINX controller<br/>:80 / :443]
      end

      subgraph certns[namespace: cert-manager, prod only]
        certmgr[cert-manager]
      end

      subgraph platform[namespace: store-platform]
        dashsvc[Service dashboard :80]
        dash1[Dashboard pod 1<br/>nginx :8080]
        dash2[Dashboard pod 2<br/>nginx :8080]
        apisvc[Service api :80]
        api1[API pod 1<br/>Fastify :8080<br/>+ helm binary]
        api2[API pod 2<br/>Fastify :8080<br/>+ helm binary]
        pgsvc[Service postgres :5432]
        pg[(Postgres StatefulSet<br/>audit log + lock)]
        pgpvc[(PVC 1Gi)]
        lease{{Lease<br/>store-platform-reconciler}}
        authsec[/Secret store-platform-auth<br/>users + tokens/]
      end

      subgraph store[namespace: store-&lt;id&gt; one per store]
        storeing[Ingress store-&lt;id&gt;]
        wpsvc[Service wordpress :80]
        wp[WordPress pod<br/>Apache :80]
        wppvc[(PVC wordpress files)]
        dbsvc[Service mariadb :3306]
        db[(MariaDB StatefulSet)]
        dbpvc[(PVC mariadb data)]
        seed[Seeder Job<br/>WP-CLI]
        cm[/ConfigMap seeder scripts<br/>+ catalog.json/]
        creds[/Secret credentials/]
        guard[ResourceQuota<br/>LimitRange<br/>3 NetworkPolicies]
        rb[RoleBinding<br/>tenant-manager]
        helmrel[/Helm release Secrets/]
      end
    end
  end

  operator -- "1 HTTP(S) Host: platform.*" --> ingress
  shopper -- "2 HTTP(S) Host: store-id.* / custom domain" --> ingress
  operator -. "resolves names" .-> dns
  shopper -. "resolves names" .-> dns

  ingress -- "3 path / " --> dashsvc --> dash1 & dash2
  ingress -- "4 path /api, /healthz" --> apisvc --> api1 & api2
  ingress -- "5 Host rule" --> storeing --> wpsvc --> wp

  api1 & api2 -- "6 HTTPS :443 ServiceAccount token" --> kapi
  api1 & api2 -- "7 TCP :5432 password auth" --> pgsvc --> pg --- pgpvc
  api1 & api2 -- "8 get/create/update" --> lease
  authsec -. "9 mounted read-only" .-> api1 & api2
  api1 & api2 -- "10 helm child process" --> kapi

  kapi -- "11 creates objects" --> store
  wp -- "12 TCP :3306" --> dbsvc --> db --- dbpvc
  wp --- wppvc
  seed -- "13 TCP :3306" --> dbsvc
  seed --- wppvc
  cm -. "mounted /scripts" .-> seed
  creds -. "env vars" .-> wp & db & seed
  seed -- "14 HTTPS :443" --> wporg

  prom -. "15 HTTP :8080 /metrics, in-cluster only" .-> api1 & api2
  certmgr -- "16 ACME HTTP-01" --> acme
  certmgr -. "writes TLS Secrets" .-> storeing
```

---

## 2. Every connection, explained

| # | From | To | Protocol / port | Credentials | Purpose | Restricted by |
|---|------|----|-----------------|-------------|---------|---------------|
| 1 | Operator browser | Ingress NGINX | HTTP :80 locally, HTTPS :443 in prod | none at this hop | Load the dashboard and call the API | Host rule `platform.<domain>` (+ `platform.localhost` locally) |
| 2 | Shopper browser | Ingress NGINX | HTTP / HTTPS | none | Visit a storefront, cart, checkout, wp-admin | Host rules `store-<id>.<domain>`, `store-<id>.localhost`, attached custom domains |
| 3 | Ingress NGINX | Dashboard Service :80 → pods :8080 | HTTP | none | Serve the React build (static files) | Path `/` on the platform host |
| 4 | Ingress NGINX | API Service :80 → pods :8080 | HTTP | `Authorization: Bearer <token>` from the browser, checked by the API | Every dashboard action | Paths `/api` and `/healthz` only; `/metrics` and `/readyz` are not routed |
| 5 | Ingress NGINX | Store Ingress → WordPress Service :80 → pod :80 | HTTP (TLS ends at the Ingress in prod) | WordPress login for wp-admin | Storefront traffic | NetworkPolicy allows only the `ingress-nginx` namespace to WordPress port 80 |
| 6 | API pods | kube-apiserver | HTTPS :443 | Mounted ServiceAccount token `store-platform-api` | Namespaces, RoleBindings, pods and jobs, namespace annotations (store status) | RBAC ClusterRole + per-store RoleBinding + ValidatingAdmissionPolicy (`store-` names only) |
| 7 | API pods | Postgres Service :5432 | PostgreSQL wire protocol | `PGPASSWORD` from Secret `store-platform-postgres` | Write and read the audit log; `pg_advisory_lock` around store creation | NetworkPolicy: only API pods may connect |
| 8 | API pods | Lease object (through kube-apiserver) | HTTPS :443 | Same ServiceAccount | Leader election: one replica runs the reconciler, installs and teardowns | Role `leader-election` (Leases in `store-platform` only) |
| 9 | Secret `store-platform-auth` | API pods | Volume mount `/etc/platform-auth` | Kubernetes | Users, roles, store quotas, tokens | API hashes tokens with SHA-256 in memory |
| 10 | API pods (`helm` child process) | kube-apiserver | HTTPS :443 | Same ServiceAccount token | `helm upgrade --install` and `helm uninstall` of the store chart bundled in the image | Tenant role granted only inside `store-<id>` through the RoleBinding |
| 11 | kube-apiserver | Store namespace | internal | — | Creates Secret, quota, limits, network policies, MariaDB, WordPress, Services, Ingress, ConfigMap, seeder Job, Helm release Secrets | ResourceQuota, LimitRange, Pod Security `baseline` label |
| 12 | WordPress pod | MariaDB Service :3306 | MySQL protocol | `WORDPRESS_DB_PASSWORD` from the store Secret | Store data: products, orders, customers | NetworkPolicy: same namespace only |
| 13 | Seeder Job | MariaDB Service :3306 | MySQL protocol (through WP-CLI / PHP) | Same store Secret | Install WordPress, configure WooCommerce and COD, create products | Same namespace only |
| 14 | Seeder Job | downloads.wordpress.org | HTTPS :443 (egress) | none | Download WooCommerce 8.9.3 and Storefront 4.6.2 | Versions pinned in chart values; egress is not restricted |
| 15 | Prometheus (optional) | API pods :8080 `/metrics` | HTTP | none | Scrape platform metrics | Only reachable inside the cluster; Service carries `prometheus.io/scrape` annotations |
| 16 | cert-manager (prod) | Let's Encrypt | HTTPS (ACME), HTTP-01 challenge through Ingress | ACME account key in Secret `letsencrypt-prod` | Issue certificates for platform, store and custom domain hosts | Only Ingresses with the `cert-manager.io/cluster-issuer` annotation |

Other connections not drawn:

| From | To | Protocol | Purpose |
|------|----|----------|---------|
| kubelet | API pods `/healthz` (liveness), `/readyz` (readiness) | HTTP :8080 | Restart or remove unhealthy pods |
| API `/readyz` | kube-apiserver | HTTPS | Ready only when Kubernetes is reachable |
| kubelet | WordPress `/wp-login.php`, MariaDB `mysqladmin ping`, Postgres `pg_isready` | HTTP / exec | Store and database probes |
| API | DNS resolver | DNS | "Check DNS" for custom domains |
| API replica | API replica | — | **No direct communication.** They coordinate only through the Lease, the Postgres advisory lock and namespace annotations. |
| Dashboard pods | API | — | **No server-side call.** The browser calls the API; the dashboard pods only serve static files. |

---

## 3. What talks to what, by layer

```mermaid
flowchart LR
  subgraph edge[Edge]
    B[Browsers]
    I[Ingress NGINX]
  end
  subgraph control[Control plane of the platform]
    D[Dashboard]
    A[Orchestrator API x2]
    L{{Lease}}
    P[(Postgres)]
    K[[kube-apiserver]]
    H[helm]
  end
  subgraph data[Data plane: one per store]
    W[WordPress]
    M[(MariaDB)]
    S[Seeder Job]
  end

  B --> I
  I --> D
  I --> A
  I --> W
  A --> K
  A --> P
  A --> L
  A --> H --> K
  K -. creates .-> W & M & S
  W --> M
  S --> M
```

- **Control plane:** the dashboard, the API, Postgres and the Lease decide what should exist. They never sit in the path of shopper traffic.
- **Data plane:** WordPress, MariaDB and the seeder run the stores. A store keeps serving shoppers even if every platform pod is down.
- **The Kubernetes API is the only bridge** between the two planes. The orchestrator never connects to a store's database or WordPress directly; it only creates, inspects and deletes Kubernetes objects.

---

## 4. Request flows

### 4.1 Create a store

```mermaid
sequenceDiagram
  autonumber
  actor U as User (browser)
  participant I as Ingress NGINX
  participant R as API replica (any)
  participant PG as Postgres
  participant K as kube-apiserver
  participant LD as API leader
  participant H as helm
  participant NS as store-ID namespace

  U->>I: POST /api/stores (name, engine, sells, idempotencyKey) + Bearer token
  I->>R: forward to one API pod
  R->>R: check token, rate limit (per user), JSON schema
  R->>PG: pg_advisory_lock (global create lock)
  R->>K: list namespaces (platform quota, user quota)
  R->>K: create namespace store-ID (labels owner and engine, annotation status=Provisioning, catalog spec)
  R->>K: create RoleBinding tenant-manager in store-ID
  R->>PG: pg_advisory_unlock, INSERT audit STORE_CREATE_REQUESTED
  R-->>U: 202 Accepted (id, status Provisioning)

  loop every 5 s (leader only)
    LD->>K: list store namespaces
  end
  LD->>H: helm upgrade --install store-ID charts/store -f values-local.yaml -f values.json
  H->>K: create Secret, ResourceQuota, LimitRange, NetworkPolicies, Services, MariaDB, WordPress, Ingress, ConfigMap, seeder Job
  K->>NS: schedule pods
  NS->>NS: MariaDB starts, WordPress starts, seeder installs WooCommerce and products
  loop every 5 s
    LD->>K: list pods and jobs in store-ID
  end
  LD->>K: patch annotation status=Ready
  LD->>PG: INSERT audit STORE_READY (durationSeconds)
  U->>I: GET /api/stores (dashboard polling every 5 s)
  I->>R: forward
  R->>K: list namespaces
  R-->>U: status Ready + store URLs
```

### 4.2 Place an order

```mermaid
sequenceDiagram
  autonumber
  actor S as Shopper
  participant I as Ingress NGINX
  participant W as WordPress + WooCommerce
  participant M as MariaDB

  S->>I: GET http://store-ID.your-domain/
  I->>W: Host rule for the store
  W->>M: read products
  W-->>S: home page with catalog
  S->>I: POST /?wc-ajax=add_to_cart
  I->>W: forward
  W->>M: create cart session
  W-->>S: cart fragment (header shows 1 item)
  S->>I: GET /checkout/ then POST /?wc-ajax=checkout (payment_method=cod)
  I->>W: forward
  W->>M: INSERT order (status wc-processing)
  W-->>S: redirect to /checkout/order-received/ORDER-ID
```

The platform API is not involved at all: orders are pure data plane traffic.

### 4.3 Delete a store

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant R as API replica (any)
  participant K as kube-apiserver
  participant LD as API leader
  participant H as helm
  participant PG as Postgres

  U->>R: DELETE /api/stores/ID + Bearer token
  R->>K: read namespace, check owner
  R->>K: patch annotation status=Deleting
  R->>PG: INSERT audit STORE_DELETE_REQUESTED
  R-->>U: 202 Accepted
  LD->>K: sees status Deleting on next pass
  LD->>K: ensure RoleBinding (self-heal)
  LD->>H: helm uninstall store-ID --wait
  H->>K: delete release objects
  LD->>K: delete namespace store-ID (Foreground)
  K->>K: garbage-collect remaining objects, PVCs, PVs (reclaim Delete)
  loop every 2 s until gone
    LD->>K: get namespace
  end
  LD->>PG: INSERT audit STORE_DELETED
```

### 4.4 Leader election and failover

```mermaid
sequenceDiagram
  autonumber
  participant A1 as API pod 1
  participant A2 as API pod 2
  participant K as kube-apiserver (Lease)

  A1->>K: create Lease holder=pod1 (every 5 s: renew)
  A2->>K: read Lease: holder=pod1, renewed recently
  Note over A2: stays follower: serves HTTP, skips reconcile
  Note over A1: pod 1 is deleted
  A1->>K: on SIGTERM: clear holderIdentity
  A2->>K: read Lease: no holder, replace with holder=pod2 (resourceVersion check)
  Note over A2: becomes leader: resumes Provisioning and Deleting stores
```

If pod 1 dies without releasing the Lease, pod 2 takes over once the renew time is older than 15 seconds. Two pods cannot both take over: the update carries the Lease `resourceVersion`, so Kubernetes accepts only one and returns 409 to the other.

---

## 5. Deployment topology: local versus VPS

```mermaid
flowchart TB
  subgraph local[Local: Kind on Docker Desktop]
    lb1[Host ports 80/443<br/>extraPortMappings] --> lin[Ingress NGINX<br/>Kind manifest]
    lin --> lplat[store-platform<br/>images built locally<br/>and loaded with kind load]
    lin --> lstores[store-* namespaces<br/>storage class standard<br/>HTTP, *.127.0.0.1.nip.io + *.localhost]
  end

  subgraph prod[Production: k3s on a VPS]
    gh[GitHub Actions] -- push images --> ghcr[(GHCR)]
    lb2[k3s ServiceLB<br/>VPS public IP :80/:443] --> pin[Ingress NGINX<br/>Helm chart]
    pin --> pplat[store-platform<br/>images pulled from GHCR<br/>API HPA 2-5]
    pin --> pstores[store-* namespaces<br/>storage class local-path<br/>HTTPS via cert-manager]
    ghcr -. pull .-> pplat
    cm2[cert-manager + letsencrypt-prod] -. TLS Secrets .-> pstores
  end
```

| Aspect | Local | VPS |
|--------|-------|-----|
| Entry point | Docker maps host 80/443 to the Kind node | k3s ServiceLB binds the VPS IP |
| Names | `*.127.0.0.1.nip.io`, `*.localhost` | `platform.<domain>`, `*.stores.<domain>`, custom domains |
| TLS | none | cert-manager, Let's Encrypt HTTP-01 |
| Images | built by `make deploy`, `kind load` | built by CI, pulled from GHCR |
| Storage | `standard` (local path in the Kind node) | `local-path` on the VPS disk |
| Install | `make setup && make deploy` | `scripts/install-vps.sh` |

---

## 6. ASCII version of the main diagram

```
                     Operator browser                     Shopper browser
                            │  HTTP(S) Host: platform.*          │  HTTP(S) Host: store-<id>.* / custom domain
                            ▼                                    ▼
  ┌──────────────────────────────── Ingress NGINX (namespace ingress-nginx) ───────────────────────────────┐
  │   /  ──────────────┐        /api, /healthz ───────────┐            Host store-<id> ──────────┐           │
  └────────────────────┼──────────────────────────────────┼─────────────────────────────────────┼───────────┘
                       ▼                                  ▼                                     ▼
  ┌──────────────── namespace store-platform ──────────────────────────────┐   ┌──── namespace store-<id> (one per store) ────┐
  │  Dashboard x2 (nginx :8080)          API x2 (Fastify :8080 + helm)      │   │  Ingress ─► WordPress :80 ──► MariaDB :3306   │
  │   static files only                   │      │        │        │         │   │               │ PVC            │ PVC          │
  │                                       │      │        │        │         │   │  Seeder Job ──┴────────────────┘              │
  │     Secret auth (tokens) ─ mounted ──►│      │        │        │         │   │     │ ConfigMap scripts + catalog.json        │
  │                                       │      │        │        ▼         │   │     └─► HTTPS downloads.wordpress.org         │
  │                         TCP :5432 ◄───┘      │        │   Lease          │   │  Secret credentials (DB, admin, salts)        │
  │                  Postgres (audit, lock)      │        │  (leader)        │   │  ResourceQuota · LimitRange · NetworkPolicy×3 │
  │                         │ PVC                │        │                  │   │  RoleBinding tenant-manager · Helm secrets    │
  └──────────────────────────────────────────────┼────────┼──────────────────┘   └───────────────────────▲───────────────────────┘
                                                 │ HTTPS  │ helm (child process)                         │
                                                 ▼ :443   ▼                                              │ creates / inspects /
                                        ┌──────────────── kube-apiserver ─────────────────┐──────────────┘ deletes objects
                                        │ RBAC · ValidatingAdmissionPolicy (store-* only) │
                                        └─────────────────────────────────────────────────┘
```

---

## 7. Where each piece is defined

| Component | Source |
|-----------|--------|
| Dashboard | `platform/frontend/`, deployed by `charts/platform/templates/dashboard-deployment.yaml` |
| Orchestrator API | `platform/backend/src/`, deployed by `charts/platform/templates/api-deployment.yaml` |
| Postgres | `charts/platform/templates/postgres.yaml` |
| Users and tokens | `charts/platform/templates/auth-secret.yaml` |
| RBAC, Lease role, admission policy | `charts/platform/templates/rbac.yaml` |
| PDBs and HPA | `charts/platform/templates/scaling.yaml` |
| Platform Ingress | `charts/platform/templates/ingress.yaml` |
| Store resources | `charts/store/templates/` |
| Seeder logic | `charts/store/files/seed.sh`, `charts/store/files/seed-store.php` |
| Local vs prod values | `charts/store/values-local.yaml`, `values-prod.yaml`, `charts/platform/values.yaml`, `values-prod.yaml` |
| Cluster setup | `scripts/setup-cluster.sh` (local), `scripts/install-vps.sh` (VPS) |
| CI and images | `.github/workflows/ci.yml` |
