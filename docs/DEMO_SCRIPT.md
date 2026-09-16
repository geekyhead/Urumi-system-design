# Demo Video Script and Concept Guide

This file has three parts:

1. **Preparation**: what to set up before you press record.
2. **Script**: what to show and what to say, section by section, with timings (about 18 minutes; cuts are marked).
3. **Concept guide**: each topic the demo must cover, explained in depth, with the likely follow-up questions and answers.

Everything here matches what is actually built and tested in this repository. If you are asked about something that is not built, the honest answers are in part 3.

---

## Part 1: Preparation (15 minutes before recording)

### 1.1 Make sure the platform is healthy

```bash
cd /Users/ciao/Interviehire/store-orchestrator
export PATH=$PWD/.bin:$PATH
kubectl get pods -n store-platform
curl -s http://platform.127.0.0.1.nip.io/healthz
make tokens
```

You should see 2 `store-platform-api` pods, 2 `store-platform-dashboard` pods and `store-platform-postgres-0`, all `Running`.

If Docker Desktop was restarted and the dashboard does not load, run `make deploy`.

### 1.2 Tidy the store list

- Delete stores you do not want on camera (for example the ones without an owner from before sign-in existed). Sign in as `admin` to see them.
- Keep **one Ready store** that you will use for the order walkthrough, so you never wait on camera. "Speedy RC Garage" (`eeyytv4e`) works. It also has the custom domain `shop.speedyrc.test` and a Helm history with upgrades and rollbacks, which you will show later.
- You will create **one new store live** as the `demo` user. It takes about 70 to 95 seconds, which you fill by explaining isolation.

### 1.3 Windows to have open

| Window | Content |
|--------|---------|
| Browser tab 1 | `http://platform.localhost` (dashboard). Signed out, so you can show sign-in. |
| Browser tab 2 | Empty, for the storefront. |
| Browser tab 3 | GitHub repo, README open. |
| Terminal 1 | In the repo, `export PATH=$PWD/.bin:$PATH`, and the two tokens exported (see below). |
| Terminal 2 | For `kubectl get ... -w` watches. |
| Editor | `charts/store/templates/`, `charts/store/values-local.yaml`, `values-prod.yaml`, `SYSTEM_DESIGN.md`. |

Export tokens in Terminal 1 without printing them:

```bash
export ADMIN=$(kubectl get secret -n store-platform store-platform-auth -o jsonpath='{.data.users\.json}' | base64 -d | jq -r '.[] | select(.name=="admin") | .token')
export DEMO=$(kubectl get secret -n store-platform store-platform-auth -o jsonpath='{.data.users\.json}' | base64 -d | jq -r '.[] | select(.name=="demo") | .token')
export API=http://platform.127.0.0.1.nip.io/api
```

### 1.4 Optional: custom domain on your machine

```bash
echo "127.0.0.1 shop.speedyrc.test" | sudo tee -a /etc/hosts
```

### 1.5 Tokens on screen

Your tokens will be visible when you paste them. Either blur that moment in editing, or regenerate the tokens after recording:

```bash
kubectl delete secret -n store-platform store-platform-auth && make deploy && make tokens
```

### 1.6 Increase terminal font size

Viewers must read `kubectl` output. Use at least 16 pt.

---

## Part 2: Script

Timings are targets. **[SHOW]** is what is on screen. **[SAY]** is what you say; use your own words, the points matter more than the exact sentences.

### 0:00 Introduction (30 s)

**[SHOW]** Dashboard sign-in screen.

**[SAY]**
"This is a store provisioning platform that runs on Kubernetes. A user clicks Create New Store and gets a working WooCommerce shop in its own namespace, with its own database, quotas and network policy, in about a minute and a half. The same Helm charts run on my laptop with Kind and on a VPS with k3s; only the values files change. I will show the architecture, create a store, place an order, then cover isolation, reliability, security, scaling, abuse prevention and the path to production."

### 0:30 System design and components (2 min)

**[SHOW]** `SYSTEM_DESIGN.md` architecture diagram (GitHub renders the Mermaid diagram). Then Terminal 1:

```bash
kubectl get pods -n store-platform -o wide
kubectl get ns -l platform.io/managed=true
```

**[SAY]**
"There are five parts.

- The **dashboard** is a React app served by an unprivileged nginx, two replicas.
- The **orchestrator API** is Node.js with Fastify, also two replicas. It validates requests, checks quotas, creates the store namespace, and runs Helm to install the store.
- The **store Helm chart** is installed once per store. It contains MariaDB, WordPress, the services, the ingress, the guardrails, and a seeder Job that uses WP-CLI to install WooCommerce, enable Cash on Delivery and load the catalog.
- **Postgres** holds the audit log that both API replicas share.
- **Ingress NGINX** routes traffic by hostname: `platform` goes to the dashboard and API, and `store-<id>` goes to that store's WordPress.

An important choice: Kubernetes itself is the database for store state. Each store is a namespace, and its status lives in namespace annotations. That is why the API can crash or scale out without losing anything."

### 2:30 Create a store live (2 min)

**[SHOW]** Paste the `demo` token and sign in. Point at "Your stores 0/2" and the footer "served by … · leader … · audit postgres". Click **Create New Store**. Type name `Glow Studio`, in "What will this store sell?" type `serums, moisturizers and lipstick`. Point at the live preview (Beauty & Skincare). Click **Create Store**.

**[SAY]**
"I am signed in as the demo user, who has a quota of two stores. The dialog previews the catalog: the orchestrator detected a beauty store from the name and what it sells. When I click Create, the request goes to whichever API replica the ingress picks."

**[SHOW]** Terminal 2 (replace `<id>` with the id shown in the dashboard):

```bash
kubectl get pods,jobs,pvc -n store-<id> -w
```

**[SAY]**
"Here is the end-to-end flow while it runs:

1. The API checks my token, the rate limit and the request body.
2. Inside a Postgres advisory lock it counts stores against the platform limit and my personal limit, then creates the namespace `store-<id>` with status Provisioning in an annotation.
3. It creates a RoleBinding so the orchestrator can manage only this namespace.
4. The leader replica runs `helm upgrade --install` with the store chart.
5. Kubernetes creates the MariaDB StatefulSet with its volume, the WordPress Deployment with its volume, the seeder Job, and the ingress.
6. The seeder waits for the database, installs WordPress, WooCommerce and the Storefront theme, turns on Cash on Delivery and creates the products.
7. Every five seconds the reconciler checks: is MariaDB ready, is WordPress ready, did the seeder Job complete. When all three are true, it marks the store Ready."

### 4:30 Isolation, resources and guardrails (3 min, while the store provisions)

**[SHOW]**

```bash
kubectl get resourcequota,limitrange,networkpolicy,secret -n store-<id>
kubectl describe resourcequota -n store-<id>
```

**[SAY]**
"Each store is isolated in four ways.

- **Namespace**: every Kubernetes object of the store lives in `store-<id>`. Deleting the namespace deletes the store.
- **ResourceQuota** caps the whole store: here 500 millicores and 512 MiB of requests, 2 CPUs and 2 GiB of limits, two volumes, eight pods, and zero LoadBalancer or NodePort services. Production uses stricter limits: 1.5 CPUs and 1.5 GiB.
- **LimitRange** gives every container default requests and limits, and caps a single container and a single volume, so nothing can run without limits.
- **NetworkPolicy** denies all incoming traffic by default, then allows only pods in the same namespace and the ingress controller to WordPress on port 80."

**[SHOW]** Prove the network policy (takes about 10 s):

```bash
kubectl run netpol-probe -n default --image=busybox:1.36 --restart=Never --rm -i --command -- \
  sh -c "nc -z -w 5 store-<id>-mariadb.store-<id>.svc.cluster.local 3306 && echo REACHABLE || echo BLOCKED"
```

**[SAY]**
"A pod in another namespace cannot reach this store's database: it is blocked.

- **Secrets**: the database passwords, the WordPress admin password and the WordPress salts are generated by Helm for this store only. On upgrade Helm looks up the existing Secret and reuses the values, so the database password never changes under a running database.
- **Volumes**: the store has its own two volumes, one for MariaDB and one for WordPress files."

**[SHOW]** Back in the dashboard: the store turns **Ready**. Point at the metrics cards and the Activity drawer (create requested, provisioning started, ready after N seconds).

### 7:30 Place an order (2.5 min)

Use the pre-created Ready store so the order has a clean admin view. Replace `eeyytv4e` if you use another store.

**[SHOW]** Click the `store-eeyytv4e.localhost` link. Show the home page with its catalog. Click **Add to cart** on a product; the header cart updates. Open **Cart**, then **Checkout**. Fill the billing fields, keep **Cash on Delivery** selected, click **Place order**. Show "Order received" and the order number.

**[SAY]**
"This is the Definition of Done: open the storefront, add to cart, check out with Cash on Delivery, and confirm the order."

**[SHOW]** Terminal:

```bash
kubectl get secret -n store-eeyytv4e store-eeyytv4e-credentials -o jsonpath='{.data.admin-password}' | base64 -d; echo
```

Open `http://store-eeyytv4e.localhost/wp-admin`, sign in as `admin` with that password, go to **WooCommerce → Orders**. Show the order with status Processing.

**[SAY]**
"The admin password only exists in this store's Secret. The order is in WooCommerce admin with status Processing. The same flow is automated in `make test`, which creates a store, places an order through the WooCommerce Store API, deletes the store, and checks that no volume is left behind."

> Cut option: skip wp-admin and show `make test` output from a previous run instead.

### 10:00 Idempotency and failure handling (2.5 min)

**[SHOW]** Terminal:

```bash
BODY='{"name":"Replay Test","engine":"woocommerce","idempotencyKey":"demo-video-key-001"}'
curl -s -X POST $API/stores -H "Authorization: Bearer $DEMO" -H 'Content-Type: application/json' -d "$BODY" -w '  HTTP %{http_code}\n' | jq -c '{id,status}'
curl -s -X POST $API/stores -H "Authorization: Bearer $DEMO" -H 'Content-Type: application/json' -d "$BODY" -w '  HTTP %{http_code}\n'
```

The first call returns 202 (or 429 if demo already has 2 stores; in that case use `$ADMIN`). The second call returns 200 with the same id.

**[SAY]**
"Creating a store is safe to retry. The store id is a hash of the user and the idempotency key, so a retry, even one that lands on the other API replica, tries to create the same namespace name. Kubernetes allows only one, and the API returns the existing store. The dashboard generates one key per dialog, so a double click never creates two stores."

**[SAY]** (failure handling; show a Failed badge if you have one, otherwise show the Activity drawer or explain)
"Failures are detected by the reconciler and shown with a reason:

- the seeder Job reached its retry limit,
- a pod is stuck pulling its image,
- a pod crash-loops more than three times,
- or the store is still not ready after 300 seconds; the reason then lists what it was still waiting for.

If a Failed store later becomes healthy, it moves to Ready automatically. Every step is idempotent, so a crashed orchestrator can resume."

**[SHOW]** Leader failover:

```bash
kubectl get lease -n store-platform store-platform-reconciler -o jsonpath='{.spec.holderIdentity}{"\n"}'
kubectl delete pod -n store-platform $(kubectl get lease -n store-platform store-platform-reconciler -o jsonpath='{.spec.holderIdentity}')
sleep 5; kubectl get lease -n store-platform store-platform-reconciler -o jsonpath='{.spec.holderIdentity}{"\n"}'
```

**[SAY]**
"Only one API replica, the holder of this Lease, installs and deletes stores. I just deleted the leader pod; within a few seconds the other replica took the Lease and continues any unfinished work. In testing, the handover took two seconds."

### 12:30 Cleanup guarantees (1 min)

**[SHOW]** Delete the `Glow Studio` store in the dashboard. Terminal:

```bash
kubectl get ns store-<id> -w
```

Then `kubectl get pv | grep store-<id>` shows nothing.

**[SAY]**
"Deleting marks the store Deleting, runs `helm uninstall`, then deletes the namespace. Namespace deletion removes everything left inside it, including the database volume. The store chart has no cluster-wide objects, so nothing can leak outside the namespace, and the volumes use the Delete reclaim policy. The automated test checks that no persistent volume still points at the deleted namespace."

### 13:30 Security posture (2 min)

**[SHOW]**

```bash
kubectl auth can-i get secrets -n kube-system --as=system:serviceaccount:store-platform:store-platform-api
kubectl create namespace not-a-store --as=system:serviceaccount:store-platform:store-platform-api --dry-run=server
```

First command: `no`. Second: denied by `ValidatingAdmissionPolicy 'store-platform-store-namespaces-only'`.

**[SAY]**
"The orchestrator has least privilege.

- At cluster level it can only manage namespaces and create RoleBindings to one specific role.
- The powerful role, which allows Secrets, Deployments, Jobs and Ingresses, is only granted inside each store namespace through a RoleBinding. So it cannot read Secrets in kube-system.
- Kubernetes RBAC cannot restrict by name prefix, so an admission policy adds that: the orchestrator can only create or delete namespaces starting with `store-`. You can see it reject a different name.

**Public versus internal:**

- Public: the dashboard, the API, which needs a per-user token, and the storefronts.
- Internal only: the metrics endpoint, the store databases, and the Postgres audit database. A network policy allows only the API pods to reach Postgres.

**Secrets:** store credentials and user tokens are generated inside the cluster by Helm and never appear in the code, the API responses or the logs. The API stores only a SHA-256 hash of each token in memory.

**Containers** run as non-root with all Linux capabilities dropped and the default seccomp profile, and the API has a read-only root filesystem. The one exception is the official WordPress image: it starts as root to bind port 80 and populate its volume, then Apache drops to www-data. It keeps only the few capabilities that needs."

### 15:30 Horizontal scaling and abuse prevention (2 min)

**[SHOW]** Per-user quota (demo already has one or two stores):

```bash
for n in "Quota One" "Quota Two" "Quota Three"; do
  curl -s -X POST $API/stores -H "Authorization: Bearer $DEMO" -H 'Content-Type: application/json' \
    -d "{\"name\":\"$n\",\"engine\":\"woocommerce\"}" -w '  HTTP %{http_code}\n' | tail -c 120; echo
done
```

At least one call returns `429 USER_QUOTA_EXCEEDED`. Delete the extra stores afterwards.

Rate limit (harmless: deleting a store that does not exist):

```bash
for i in $(seq 1 70); do curl -s -o /dev/null -w '%{http_code} ' -X DELETE $API/stores/zzzzzzzz -H "Authorization: Bearer $DEMO"; done; echo
```

The output changes from `404` to `429`.

**[SAY]**
"Abuse prevention works in layers.

- **Per user:** a store quota (demo 2, admin 10) and a rate limit of 30 changes per minute. The limit is counted per replica, so with two replicas you see 429 after about 30 to 60 requests.
- **Platform-wide:** 10 active stores.
- **Per store:** the ResourceQuota and LimitRange caps.
- **Time limits:** a 300-second provisioning timeout, a 15-minute seeder deadline with 4 retries, and a 5-minute Helm timeout.
- **Custom domains:** at most 3 per store, never under the platform's own domains, and a domain can belong to only one store.
- **Audit trail:** every action is recorded with the user and IP, and shown in the Activity drawer."

**[SHOW]** `charts/platform/templates/scaling.yaml` and `values-prod.yaml` autoscaling block.

**[SAY]**
"For scaling: the dashboard is stateless and runs two replicas. Every API replica serves requests, and a Lease elects one leader for cluster changes. A Postgres advisory lock keeps quotas correct across replicas, and PodDisruptionBudgets keep one pod of each up during node maintenance. In production an HPA scales the API from two to five replicas on CPU.

Provisioning throughput is capped at three Helm installs at a time on the leader. To go beyond one leader, I would shard stores across several Leases, or move to an operator with a work queue.

The stateful parts are the constraint. Postgres is a single pod; production would use a managed database. Each store's volumes use local-path storage, which pins a store to one node; a multi-node cluster needs network storage such as Longhorn or a cloud disk driver."

### 17:30 Local to VPS, upgrades and rollback (2 min)

**[SHOW]**

```bash
diff charts/store/values-local.yaml charts/store/values-prod.yaml
diff charts/platform/values.yaml charts/platform/values-prod.yaml
```

**[SAY]**
"Local and production use the same charts; only values change:

- **Domain:** `127.0.0.1.nip.io` locally, which needs no DNS setup, versus a real wildcard domain.
- **TLS:** off locally; in production, on, with cert-manager and a Let's Encrypt ClusterIssuer.
- **Storage:** the `standard` storage class locally, `local-path` on k3s.
- **Limits:** relaxed locally, strict in production.
- **Images:** built locally, versus images from GitHub Container Registry that CI builds on every push.
- **Autoscaling** is on in production.

Ingress differs too: locally Kind maps ports 80 and 443 to the node; on k3s I disable Traefik and install Ingress NGINX behind k3s's built-in load balancer. Secrets are generated by Helm in both environments. `scripts/install-vps.sh` does the whole VPS setup in one command."

**[SHOW]**

```bash
helm history store-eeyytv4e -n store-eeyytv4e
cat scripts/upgrade-stores.sh | sed -n '1,12p'
```

**[SAY]**
"Every store is a Helm release, so it has revisions. The upgrade script goes one store at a time:

1. Back up the database and the WordPress files.
2. Run `helm upgrade`, keeping each store's own values.
3. Wait for the seeder Job, which moves plugins to the pinned versions and runs database migrations.
4. Smoke-test the storefront API.
5. On failure, `helm rollback` and restore the backup automatically, then stop.

A bad release reaches at most one store. The history here shows real upgrades and rollbacks I ran. The seeder Job name includes the revision number, because Kubernetes does not allow changing a Job, and product content is seeded only once, so an upgrade never overwrites a merchant's edits."

### 19:30 Close (30 s)

**[SAY]**
"To summarize: one click gives an isolated, working store; orders work end to end; isolation uses namespaces, quotas, limits, network policies and per-store secrets; creation is idempotent and the system recovers from crashes and leader loss; the orchestrator runs with least privilege behind per-user tokens; the API scales horizontally with leader election; and the same Helm charts go to production with values changes. WooCommerce is fully implemented, and MedusaJS plugs into the same engine interface. Thank you."

### Where to cut if you need 10 to 12 minutes

- Skip wp-admin (show the thank-you page only).
- Skip the rate limit loop (keep the quota 429).
- Show the diff of only the store values files.
- Explain failover instead of running it.

---

## Part 3: Concept guide

Each section explains the idea, how this project implements it, and what you might be asked.

### 3.1 System design and implementation

**Kubernetes-native provisioning.** Everything a store needs is a normal Kubernetes object: Deployment, StatefulSet, Service, Ingress, PersistentVolumeClaim, Secret, Job, ResourceQuota, LimitRange, NetworkPolicy. Nothing runs outside the cluster, so the same thing works anywhere Kubernetes runs.

**Why Helm per store.** A Helm release is a named, versioned install. Each store is release `store-<id>` in namespace `store-<id>`. That gives you, for free:

- repeatable installs from one template,
- revision history,
- `helm upgrade` and `helm rollback`,
- clean `helm uninstall`.

The trade-off is that the API runs the `helm` binary per store instead of being a native operator. At hundreds of stores an operator would be better; it is in the tradeoffs table.

**The orchestrator API** (`platform/backend/src`):

| File | Responsibility |
|------|----------------|
| `routes/stores.ts` | HTTP endpoints and request validation |
| `services/storeManager.ts` | Store lifecycle: create, delete, reconcile, domains |
| `services/helm.ts` | Runs `helm upgrade --install` and `helm uninstall`, measures duration |
| `services/k8s.ts` | Kubernetes calls: namespaces, RoleBindings, pods and jobs |
| `services/leader.ts` | Lease-based leader election |
| `services/audit.ts` | Audit log on Postgres (or SQLite for one replica) |
| `services/auth.ts` | Token checking, users, quotas |
| `services/metrics.ts` | Prometheus metrics and dashboard summary |
| `engines/woocommerce.ts` | Engine plugin: Helm values, URLs, health rules |
| `engines/medusa.ts` | Engine interface stub |
| `catalogs.ts` | Chooses products for a store from its name and what it sells |

**State machine.** `Provisioning → Ready`, `Provisioning → Failed`, `Failed → Ready` (recovery), `any → Deleting → gone`. The current state is stored as the `platform.io/status` annotation on the namespace.

**Why store state in namespace annotations and not a database?**
The namespace exists exactly as long as the store exists. Putting the status on it means there is no second source of truth that can disagree. For example, a database row could say "Ready" for a namespace that was deleted by hand. It also makes the API stateless: any replica, or a restarted pod, reads the truth from Kubernetes.

**The reconciler.** It is a control loop that runs every 5 seconds on the leader. It looks at what exists (pods, jobs, Helm release) and moves each store's status towards reality. This is the same pattern Kubernetes controllers use: desired state is written first, then a loop makes it true.

**Health rule for WooCommerce** (`engines/woocommerce.ts`): Ready when the MariaDB pod is ready, a WordPress pod is ready, and the newest seeder Job has completed.

**The seeder Job** (`charts/store/files/seed.sh`, `seed-store.php`) installs WordPress, WooCommerce 8.9.3 and Storefront 4.6.2, and sets USD, guest checkout, no shipping zones and Cash on Delivery. It then creates products with generated images, the home page, the menu and the brand colors.

**Why WooCommerce 8.9.3?** The required image is WordPress 6.4, and newer WooCommerce versions need a newer WordPress.

**Why no shipping zones?** A physical product with no shipping method blocks checkout.

**Likely questions**

- *Why a Job and not an init container?* The seeding runs once per install or upgrade, can take a minute, and needs retries with a deadline. A Job has `backoffLimit`, `activeDeadlineSeconds` and a visible completion status that the reconciler can read. An init container would re-run on every WordPress pod restart.
- *How does the seeder reach WordPress files?* It mounts the same WordPress volume and runs as user 33 (`www-data`), the same user Apache uses, so file ownership is correct.
- *How would Medusa fit?* Add a `charts/store-medusa` chart (backend, worker, Postgres, Redis, Next.js storefront, a migration and seed Job) and implement `provision`, `evaluate` and `urls` in `MedusaEngineProvider`. The namespace, quotas, RBAC, idempotency, reconciler and teardown do not change. It currently returns `501 ENGINE_NOT_AVAILABLE` before creating anything.

### 3.2 Isolation, resources and reliability

**Namespace per store.** A namespace is a boundary for names, RBAC, quotas and network policies, and a unit of deletion. It is "soft" multi-tenancy: stores share the node's kernel and the cluster control plane. Hard isolation would need separate nodes, virtual clusters or VMs, which is not needed here and is in the tradeoffs.

**Requests versus limits.**

- A **request** is what the scheduler reserves for a container; the node must have that much free.
- A **limit** is the maximum the container may use. CPU above the limit is throttled; memory above the limit gets the container killed (OOMKilled).

**ResourceQuota** caps the total for the whole namespace. Values in this project:

| | Local | Production |
|--|-------|-----------|
| requests.cpu / memory | 500m / 512Mi | 500m / 512Mi |
| limits.cpu / memory | 2 / 2Gi | 1500m / 1536Mi |
| PVCs | 2 | 2 |
| pods | 8 | 6 |
| services | 4 | 4 |
| LoadBalancer / NodePort services | 0 | 0 |

The requests are sized exactly: MariaDB 150m/192Mi + WordPress 150m/192Mi + seeder 100m/128Mi = 400m/512Mi. When a quota exists, every pod must declare requests and limits, or it is rejected; the LimitRange fills in defaults.

WordPress uses the `Recreate` update strategy. A rolling update would briefly run two WordPress pods, which would exceed the quota and could not share the single-writer volume.

**LimitRange** sets per-container defaults (request 50m/64Mi, limit 250m/256Mi locally), a per-container maximum (1 CPU and 1Gi locally, 500m and 512Mi in production), and a maximum volume size (5Gi). Without it, one container could claim the whole quota.

**NetworkPolicy.** Three policies per store:

1. **Default deny ingress** for all pods in the namespace.
2. **Allow from the same namespace**, so WordPress and the seeder can reach MariaDB.
3. **Allow the `ingress-nginx` namespace** to WordPress on port 80 only.

Egress (outgoing) is not restricted, because the seeder downloads WooCommerce from wordpress.org. The Kind default network plugin (kindnet) enforces network policies, and we tested it: a pod in `default` could not reach a store's MariaDB or WordPress.

**Secrets.** `charts/store/templates/secret.yaml` generates random values with `randAlphaNum` and uses Helm `lookup` to reuse values that already exist. Without `lookup`, every `helm upgrade` would generate a new database password, while MariaDB keeps the old one on disk, and WordPress would stop connecting.

**Persistent storage.**

- MariaDB is a StatefulSet with a `volumeClaimTemplate` of 1Gi (2Gi in production) and `persistentVolumeClaimRetentionPolicy: whenDeleted: Delete`.
- WordPress files are on a separate PVC.
- Both use the cluster's default dynamic storage (the `standard` class on Kind, `local-path` on k3s).

**Idempotency** means that doing the same operation twice has the same effect as doing it once.

- **Create:** store id = first 8 hex characters of `sha256(user + ":" + idempotencyKey)`, and namespace names are unique. Same key and same body gives `200` with the existing store. Same key with a different body gives `422`. A store being deleted gives `409`.
- **Install:** `helm upgrade --install` converges whether the release is missing, half installed or complete.
- **Seeder:** every step checks first (`core is-installed`, `plugin is-installed`, product by SKU, content marker), so a retried Job continues instead of failing on "already exists".

**Failure handling** (`storeManager.ts` `reconcileStore`):

| Situation | Result |
|-----------|--------|
| Seeder Job failed (backoff limit reached) | Failed, with the Job's message |
| ImagePullBackOff, ErrImagePull, CreateContainerConfigError | Failed, with pod and reason |
| CrashLoopBackOff with 3 or more restarts | Failed |
| Not Ready after 300 s | Failed: "Provisioning timed out after 300s (waiting for …)" |
| Provisioning, but no Helm release (API crashed before installing) | Install is started again |
| Failed store becomes healthy | Ready (audit `STORE_RECOVERED`) |
| Helm says another operation is in progress | Not a failure; retried next loop |
| Delete failed midway | `STORE_DELETE_FAILED` in the audit; retried every loop while status is Deleting |
| Leader pod dies | Another replica takes the Lease and resumes Provisioning and Deleting stores |
| A store has no RoleBinding (for example from before a fix) | The leader recreates it before checking or deleting |

**Cleanup guarantees.**

- Delete order: mark Deleting, `helm uninstall --wait`, delete the namespace with `propagationPolicy: Foreground`, then wait until it is gone.
- The store chart contains only namespaced objects, so the namespace deletion covers everything.
- The dynamic volumes use the `Delete` reclaim policy.
- The e2e test asserts no PersistentVolume still has a `claimRef` to the namespace.

**Likely questions**

- *What if the namespace deletion hangs?* The teardown times out after 300 s, records `STORE_DELETE_FAILED`, and the leader retries on the next loop. A stuck finalizer would be visible in `kubectl get ns store-<id> -o yaml`.
- *Can one store starve the others?* It cannot exceed its ResourceQuota, and the scheduler only places pods where their requests fit. Node-level overcommit of limits is possible; production limits are stricter for that reason.
- *Why not restrict egress?* The seeder needs the internet to download WooCommerce. A production option is an egress policy that allows DNS, the database and a proxy or mirror only.

### 3.3 Security posture

**RBAC basics.** A Role or ClusterRole lists allowed verbs on resources. A RoleBinding grants a role inside one namespace; a ClusterRoleBinding grants it everywhere. A ServiceAccount is the identity of a pod.

**The orchestrator's permissions** (`charts/platform/templates/rbac.yaml`):

1. **ClusterRole `store-platform-orchestrator`**, bound cluster-wide. It allows:
   - namespaces: get, list, watch, create, patch, delete,
   - rolebindings: create,
   - `bind` on exactly one ClusterRole: `store-platform-tenant-manager`.
2. **ClusterRole `store-platform-tenant-manager`**, never bound cluster-wide. It allows Secrets, ConfigMaps, Services, PVCs, Deployments, StatefulSets, Jobs, Ingresses, NetworkPolicies, quotas and limit ranges. The API binds it inside each `store-<id>` namespace with a RoleBinding.
3. **Role for leader election**: get, create and update Leases in `store-platform` only.

Kubernetes prevents privilege escalation: you can only create a RoleBinding to a role if you already hold its permissions or have `bind` on that role. Because `bind` is restricted by name, the API cannot bind `cluster-admin`.

**ValidatingAdmissionPolicy.** RBAC cannot say "only namespaces whose name starts with store-". The admission policy is a CEL rule evaluated by the API server for requests from the orchestrator's ServiceAccount only. It rejects:

- namespace create, update or delete when the name does not start with `store-`,
- RoleBinding changes outside `store-*` namespaces.

So even a compromised API pod cannot delete `kube-system`.

**Secret handling summary.**

- **Store credentials:** generated in-cluster per store, reused on upgrade, never returned by the API.
- **User tokens:** 40 random characters generated by Helm into `store-platform-auth` and kept on upgrade. The API keeps only SHA-256 hashes and compares with `timingSafeEqual` against every user, so response time does not reveal which user matched.
- **Values passed to Helm** are written to a temp file with mode 0600 and deleted afterwards.
- **No secrets in git.** A scan of the source found none.

**Authorization model.** Each store has a `platform.io/owner` label. Users see and change only their own stores; admins see all. Another user's store returns 404 rather than 403, so ids cannot be discovered by probing.

**What is public and what is internal:**

| Public (through Ingress) | Internal only |
|--------------------------|---------------|
| Dashboard | `/metrics`, `/readyz` |
| API (token required) | Store MariaDB (NetworkPolicy) |
| Storefronts and wp-admin (WordPress login) | Platform Postgres (NetworkPolicy: API pods only) |
| `/healthz` | Kubernetes API (only the orchestrator ServiceAccount has a token mounted) |

**Container hardening:**

| Pod | User | Notes |
|-----|------|-------|
| API | 1000 | read-only root filesystem, all capabilities dropped |
| Dashboard | 101 | nginx-unprivileged on port 8080, read-only root filesystem |
| MariaDB | 999 | all capabilities dropped |
| Seeder | 33 | all capabilities dropped |
| Postgres | 70 | all capabilities dropped |
| WordPress | root at start, Apache workers as www-data | keeps only CHOWN, DAC_OVERRIDE, FOWNER, SETGID, SETUID, NET_BIND_SERVICE, KILL |

All pods use the `RuntimeDefault` seccomp profile and `allowPrivilegeEscalation: false`. Store namespaces enforce the `baseline` Pod Security Standard. Store pods do not mount a ServiceAccount token.

**Likely questions**

- *Why does WordPress run as root?* The official image binds port 80 and copies WordPress into the volume on first start, both of which need root, then Apache drops to www-data. The fix would be a custom image listening on 8080.
- *How do you rotate a token?* Remove the user's entry from the Secret (or delete the Secret) and run `helm upgrade`; a new token is generated.
- *Is the rate limit safe with two replicas?* It is per replica, so the effective limit is up to 2×. A Redis store for the rate limiter would make it global; this is documented.
- *Why not OIDC?* Static tokens need no external identity provider for the assignment. OIDC is the production next step.

### 3.4 Horizontal scaling plan

**What scales horizontally, and how:**

| Component | Replicas | Why it can scale |
|-----------|----------|------------------|
| Dashboard | 2 | Static files, no state |
| API | 2 (HPA 2–5 in production) | Store state is in Kubernetes; the audit log is in shared Postgres |
| Reconciler and provisioning | 1 active (leader) | Avoids two replicas changing the same store |

**Leader election with a Lease.** A Lease is a small Kubernetes object with a holder name and a renew time.

- Each replica tries every 5 seconds to create or renew the Lease `store-platform-reconciler`.
- The holder renews it; others take over only if the renew time is older than 15 seconds.
- Updates carry the object's `resourceVersion`, so if two replicas try at once, Kubernetes accepts one and rejects the other with 409.
- On shutdown the leader releases the Lease, which is why the handover was 2 seconds instead of 15.

**How a request on a non-leader works.** The replica writes the namespace with status Provisioning (or Deleting) and returns. The leader's next reconcile pass, within 5 seconds, starts the install or teardown.

**Concurrency control.**

- A Postgres advisory lock wraps "count stores, check quotas, create namespace", so two replicas cannot both admit the 11th store.
- Idempotent ids make duplicate creates collide on the namespace name.
- On the leader, a semaphore allows at most 3 Helm installs at once.

**Scaling provisioning throughput.**

1. **Raise `maxConcurrentProvisions`** and add nodes; the limit exists to protect the node and the API server.
2. **Shard across Leases:** for example, replica A leads for store ids whose hash is even and replica B for odd, so two leaders install in parallel.
3. **Operator with a work queue:** a `Store` custom resource and controller-runtime, watch-driven instead of polling, with rate-limited retries.
4. **Pre-baked images** with WooCommerce and the theme already inside, to cut the roughly 20 seconds of downloads per store.

**Stateful constraints.**

- **Postgres** is a single pod. Production options: a managed database, or an operator such as CloudNativePG with replicas. If Postgres is down, creates fail fast because the lock cannot be taken; existing stores keep serving.
- **Store volumes** are ReadWriteOnce `local-path`, which ties a store to one node. For multiple nodes use network storage (Longhorn, cloud block storage). WordPress cannot run more than one replica per store without shared (ReadWriteMany) storage for uploads.
- **MariaDB** per store is a single instance. For high availability: Galera or a managed database per store, at higher cost.

### 3.5 Abuse prevention

| Layer | Control | Value |
|-------|---------|-------|
| Identity | Bearer token per user | 401 without a valid token |
| Per user | Store quota | admin 10, demo 2: `429 USER_QUOTA_EXCEEDED` |
| Per user | Rate limit on POST, PUT, DELETE | 30 per minute per replica: `429 RATE_LIMITED` |
| Platform | Active store limit | 10: `429 STORE_QUOTA_EXCEEDED` |
| Per store | ResourceQuota and LimitRange | See 3.2 |
| Time | Provisioning timeout | 300 s |
| Time | Seeder Job | `activeDeadlineSeconds` 900, `backoffLimit` 4 |
| Time | Helm operations | 5 minutes |
| Input | JSON schema validation | Body limit 16 KiB; names and ids restricted to safe characters |
| Domains | Custom domain rules | Max 3 per store, reserved platform domains, one store per domain |
| Blast radius | Concurrent installs | 3 on the leader |
| Blast radius | Upgrades | One store at a time, auto-rollback, stops on first failure |
| Visibility | Audit log | Every create, replay, rejection, ready, failure, delete and domain change, with user and IP |
| Visibility | Metrics | `store_platform_lifecycle_events_total`, `store_platform_store_outcomes`, provisioning and Helm duration histograms |

**Why names are restricted.** Store names and ids go into Kubernetes names, Helm values and a command line. Restricting characters, and passing arguments to `helm` as an array instead of a shell string, prevents injection.

**Why "blast radius" matters.** It means how much damage one bad actor or one bad release can do. Quotas limit resources, timeouts limit how long something can hang, and one-at-a-time upgrades limit how many stores a broken chart can reach.

### 3.6 Local to VPS production story

**What changes through Helm values only:**

| Concern | Local (`values-local.yaml`, `values.yaml`) | VPS (`values-prod.yaml`) |
|---------|--------------------------------------------|--------------------------|
| Store domain | `127.0.0.1.nip.io` | `stores.<your domain>` |
| Store TLS | off | on, `cert-manager.io/cluster-issuer: letsencrypt-prod` |
| Storage class | `standard` | `local-path` |
| Store limits | relaxed (2 CPU, 2Gi) | strict (1.5 CPU, 1.5Gi) |
| `*.localhost` aliases | on | off |
| Platform ingress | `platform.127.0.0.1.nip.io`, HTTP | `platform.<domain>`, HTTPS |
| Images | local tag, loaded into Kind | GHCR `latest`, `pullPolicy: Always` |
| API autoscaling | off (Kind has no metrics-server) | HPA 2–5 |
| Custom domain target | 127.0.0.1 | VPS public IP |

**Ingress.**

- **Local:** Kind's control-plane container maps host ports 80 and 443. The Kind-specific Ingress NGINX manifest runs the controller on that node.
- **VPS:** k3s installs with `--disable traefik`, because the charts use the `nginx` ingress class. Ingress NGINX runs as a LoadBalancer service, and k3s's built-in ServiceLB binds it to the VPS IP.

**Domains.**

- **nip.io** is public DNS that answers any `*.127.0.0.1.nip.io` with 127.0.0.1, so no `/etc/hosts` editing is needed.
- **On a VPS** you create `A platform.<domain>` and `A *.stores.<domain>` pointing at the server.
- **`*.localhost`** is a fallback for browsers that block nip.io.

**TLS.** cert-manager watches Ingresses with the cluster-issuer annotation and uses the Let's Encrypt HTTP-01 challenge to get one certificate per host. Let's Encrypt limits a domain to 50 certificates a week; with many stores, switch to a DNS-01 wildcard certificate for `*.stores.<domain>`.

**Storage.** k3s's `local-path` stores volumes on the VPS disk. Back up `/var/lib/rancher/k3s/storage` or use the backup script per store. Multi-node needs network storage.

**Secrets strategy.** The same in both environments: generated by Helm inside the cluster and reused with `lookup`. A production improvement would be Sealed Secrets or External Secrets with a vault, so secrets can be recreated from git or a secret manager after a total cluster loss. This is not implemented; say so if asked.

**Deploy path to a VPS.**

1. Push to `main`. CI lints, typechecks and pushes images to GHCR.
2. Make the GHCR packages public.
3. Point DNS at the server.
4. Run `sudo ./scripts/install-vps.sh --domain <domain> --email <you>`.

**Upgrade and rollback with Helm.**

- **Helm revisions:** every `helm upgrade` creates a new revision; `helm history` lists them; `helm rollback <release> <revision>` re-applies an older revision's manifests.
- **Store upgrades:** change image tags or `seeder.woocommerceVersion` in values, then run `make upgrade-stores`. The script backs up, upgrades with `--reset-then-reuse-values` (new chart defaults, but each store keeps its own values), waits for the seeder, smoke-tests, and rolls back with a data restore on failure.
- **Why the seeder Job name includes the revision:** a Job's pod template cannot be changed after creation, so a fixed name would make every upgrade fail.
- **Important limit:** `helm rollback` restores Kubernetes objects, not data. If an upgrade migrated the database (a newer WooCommerce), you must restore the backup, which `store-rollback.sh` does when you pass the backup folder.
- **Platform upgrades:** `make deploy` (new image tag, `helm upgrade`); roll back with `helm rollback store-platform <rev> -n store-platform`. The API rolls with `maxUnavailable: 0`, so one replica always serves.

---

## Part 4: Quick answers to hard questions

**"What happens if I click Create twice quickly?"**
The dialog sends the same idempotency key, so both requests map to the same store id. Kubernetes creates the namespace once; the second request gets the existing store with HTTP 200.

**"What happens if the orchestrator crashes in the middle of provisioning?"**
The status is already on the namespace. On restart, or on the other replica taking the Lease, the reconciler sees a Provisioning store. If there is no Helm release yet, it starts the install; `helm upgrade --install` and the idempotent seeder make it safe to repeat. After 300 seconds without success it marks the store Failed with a reason.

**"How do you know a store is really usable, not just that pods are running?"**
Ready requires the seeder Job to complete. That Job only finishes after WooCommerce is active, Cash on Delivery is on and products exist. The e2e test goes further and places a real order through the WooCommerce Store API.

**"Why WooCommerce and not Medusa?"**
The task allows fully implementing one engine. WooCommerce passes the full order flow. Medusa is behind the same `EngineProvider` interface, and adding it touches only a new chart and one engine file.

**"What would you do next?"**

- A real VPS deployment with TLS.
- OIDC sign-in.
- A Redis-backed global rate limit.
- A managed or replicated Postgres.
- Network storage for multi-node clusters.
- The Medusa engine.
- An operator with a `Store` CRD for large fleets.
- Pre-baked store images to cut provisioning time.

**"What is not production-ready yet?"**

- Single Postgres pod.
- Rate limit per replica.
- Static tokens.
- WordPress starting as root.
- `local-path` storage ties stores to one node.
- The VPS script has not been run on a real server yet.
