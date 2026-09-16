# Why This Tech, and How It All Talks: Explained Simply

This document has three parts:

1. **The story version**: the whole platform explained as a shopping mall, so a school student can follow it.
2. **How the parts talk to each other**, step by step, in plain language.
3. **Why we chose each technology and not its alternatives**: an honest list of every major decision, what else we could have used, and what our choice costs us.

A glossary and a five-minute presentation outline are at the end.

---

## Part 1: The story version

### The big idea in one sentence

We built a machine that creates a brand-new online shop, ready to take orders, every time someone clicks a button.

### Think of it as a shopping mall

Imagine a huge shopping mall that can build a new shop in about a minute and a half.

| In the mall | In our project | Real name |
|-------------|----------------|-----------|
| The mall building, its electricity, lifts and security | The system that runs all our programs | **Kubernetes** |
| An empty shop unit with its own walls and door | A private space for one store | **Namespace** |
| The mall's main entrance with a signboard that tells visitors which shop is where | Sends each visitor to the right place based on the address they typed | **Ingress NGINX** |
| The mall's front desk screen where a shop owner asks for a new shop | The website where you click "Create New Store" | **Dashboard** (React) |
| The mall office that handles requests, checks rules and gives orders to builders | The program that actually creates and deletes stores | **Orchestrator API** (Node.js + Fastify) |
| A standard shop-fitting kit: shelves, counter, cash register, all from one blueprint | A package describing everything a store needs | **Helm chart** |
| The shop counter where customers browse and pay | The shop website | **WordPress + WooCommerce** |
| The shop's stock and sales book, kept in a locked back room | The shop's database | **MariaDB** |
| The setup crew that arrives, stocks the shelves and puts up price tags | A one-time job that installs the shop software and adds products | **Seeder Job** (WP-CLI) |
| The mall office's logbook of everything that happened | A record of every action | **Audit log** in **Postgres** |
| A "Manager on duty" badge; only the person wearing it can give building orders | Only one copy of the office program is allowed to build or demolish | **Lease** (leader election) |
| A supervisor who walks around every 5 seconds checking each new shop | A loop that checks whether each store is ready | **Reconciler** |
| Keys that open only certain doors | Permissions for programs | **RBAC** |
| Locked doors between shops | Rules that block traffic between stores | **NetworkPolicy** |
| A limit on how much electricity and floor space each shop gets | Limits on computer power per store | **ResourceQuota** and **LimitRange** |
| A safe that holds each shop's passwords | Hidden storage for passwords | **Secret** |
| Staff ID cards for people using the front desk | Login tokens for dashboard users | **Bearer tokens** |
| A shop's street address | The store's web address | e.g. `store-abc123.127.0.0.1.nip.io` |
| A padlock sign that proves the shop is real | HTTPS certificate | **cert-manager + Let's Encrypt** |

### What happens when you click "Create New Store"

1. **You fill in a form** at the front desk: the shop's name and what it will sell, for example "Speedy RC Garage, RC cars and drones".
2. **The front desk passes your request to the mall office.** First the office checks your ID card (token). Then it checks the rules: is the mall full? Have you already opened too many shops?
3. **The office reserves an empty shop unit** with walls and a locked door (namespace), and writes "being built" on the door.
4. **The manager on duty sends the builders** with the shop-fitting kit (Helm chart). They install the counter (WordPress), the locked stockroom (MariaDB), the safe with passwords (Secret), the electricity limits (quota) and the locked doors (network policies).
5. **The setup crew arrives** (seeder). They install the shop software (WooCommerce), turn on "pay when it arrives" (Cash on Delivery), and stock the shelves with products that match what you sell: RC buggies, drones and batteries.
6. **The supervisor keeps walking past** every 5 seconds. When the counter is open, the stockroom is working and the setup crew has finished, the supervisor changes the sign on the door to "open" (Ready).
7. **The front desk screen updates** and shows the shop's address. You click it and see your shop.

### What happens when a customer buys something

The customer types the shop's address. The mall entrance reads the address and sends them to the right shop. They put a product in the cart, fill in their name and address, choose "Cash on Delivery", and click "Place order". The shop writes the order in its own stock and sales book.

**The mall office is not involved in shopping at all.** Even if the office closed for lunch, every shop would keep selling.

### What happens when you delete a store

1. You click Delete. The office writes "being demolished" on the door.
2. The manager on duty tells the builders to remove the shop fittings (`helm uninstall`).
3. Then the whole unit is knocked down (the namespace is deleted). Anything left inside, including the stock book, goes with it.
4. The office writes "shop removed" in its logbook.

Nothing is left behind, because everything a shop owns lives inside its own walls.

### What if something goes wrong?

- **The setup crew fails**: the supervisor sees it and writes the reason on the door ("Seeder job failed"), so you know why.
- **A shop is still not open after 5 minutes**: it is marked Failed with a note of what it was still waiting for.
- **The manager on duty goes home suddenly** (the program crashes): another copy of the office program picks up the badge within seconds and continues the unfinished work.
- **Someone clicks Create twice by accident**: the office recognizes the same request and does not build two shops. This is called **idempotency**. It works like pressing a lift button twice: the lift still comes only once.

### How the mall stays safe

- Every shop has **locked doors**: one shop cannot peek into another shop's stockroom.
- Every shop has its **own safe** with its own passwords.
- The office program has **keys only to shop units**, not to the mall's control room. A special rule even stops it from touching any room whose name does not start with "store-".
- Front desk users need an **ID card**, and each person can only see and manage their own shops.
- Each person may open only **a limited number of shops**, and may only make a limited number of requests per minute, so nobody can flood the mall.

### How the mall grows

- There are **two copies of the front desk** and **two copies of the office**, so one can break and the mall still works.
- Only **one office copy wears the manager badge** at a time, so two copies never build the same shop twice.
- On a real server, the office can **add more copies automatically** when it gets busy (autoscaling).

### From a laptop to a real server

On a laptop we use a **small practice mall** (Kind) and a **free trick address** (`nip.io`) that always points back to your own computer. On a real internet server we use a **lightweight real mall** (k3s), **real web addresses** and **padlock certificates** (HTTPS). The shop blueprints stay the same; we only change a settings file (Helm values).

---

## Part 2: How the parts talk to each other, in plain language

Each line below is one conversation: who talks, to whom, how, and what they say.

### When you open the dashboard

1. **Your browser to the entrance (Ingress NGINX):** "Please give me `platform.localhost`."
2. **Entrance to the dashboard:** "Here is someone asking for the main page." The dashboard sends back the web page.
3. **Your browser to the entrance again:** "Please pass this to the API: list my stores. Here is my ID card (token)."
4. **Entrance to the API:** forwards the message to one of the two API copies.
5. **API to its user list:** "Is this ID card real, and whose is it?"
6. **API to Kubernetes:** "Which store namespaces exist?" Kubernetes answers with the list and each store's status.
7. **API to your browser:** "Here are your stores." The page repeats this every 5 seconds, so statuses update by themselves.

### When a store is created

1. **Browser to API:** "Create a store called Glow Studio that sells serums."
2. **API to Postgres:** "Lock the create door for a moment, so no other copy of me creates a store at the same time."
3. **API to Kubernetes:** "How many stores exist, and how many belong to this user?" If the limits are fine: "Create a namespace called `store-abc123` and write 'Provisioning' on it."
4. **API to Kubernetes:** "Let me manage things inside `store-abc123` only" (RoleBinding).
5. **API to Postgres:** "Unlock. Write in the logbook: demo user asked for Glow Studio."
6. **API to browser:** "Accepted, I'm building it."
7. **Leader API to Helm, and Helm to Kubernetes:** "Install the store kit into `store-abc123`."
8. **Kubernetes to the computer (node):** "Start the MariaDB, WordPress and setup crew containers."
9. **Setup crew to MariaDB:** "Are you awake yet?" Once MariaDB answers: "Create the shop tables."
10. **Setup crew to the WordPress website on the internet:** "Send me WooCommerce and the Storefront theme."
11. **Setup crew to the shared WordPress folder:** installs the files, adds products and pictures.
12. **Leader API to Kubernetes, every 5 seconds:** "Are the MariaDB and WordPress pods ready? Has the setup crew finished?"
13. **Leader API to Kubernetes:** "Write 'Ready' on the namespace." **Leader API to Postgres:** "Log: Glow Studio is ready after 80 seconds."

### When a customer shops

1. **Customer's browser to the entrance:** "Give me `store-abc123.localhost`."
2. **Entrance to the store's WordPress:** "A customer for you."
3. **WordPress to MariaDB:** "Which products do we have?" Then later: "Save this cart", and finally "Save this order: Cash on Delivery, $28."
4. **WordPress to the customer:** "Thank you, your order has been received."

### When the two API copies need to agree

The two API copies **never talk to each other directly**. They agree through three shared noticeboards:

- **The Lease**, a small note in Kubernetes that says who the manager is. The manager renews it every 5 seconds. If the manager stops renewing for 15 seconds, the other copy writes its own name.
- **The Postgres lock**, which only one copy can hold at a time while creating a store.
- **The labels on each namespace**, which say each store's status. Any copy can read them.

### What never talks to what

- **The dashboard pods never talk to the API.** Your browser does, on your behalf.
- **The API never talks to a store's database or WordPress directly.** It only asks Kubernetes to create, check or delete things.
- **One store never talks to another store.** The network rules block it.
- **Nothing outside the mall can reach a store's database.** Only pods inside that store's own namespace can.

---

## Part 3: Why we chose each technology

For each choice: what we picked, the main alternatives, why we picked ours, and what it costs us. Being honest about the cost matters in a review; every choice gives something up.

### Platform and infrastructure

#### Kubernetes

- **Chosen:** Kubernetes.
- **Alternatives:** Docker Compose; plain virtual machines with scripts; HashiCorp Nomad.
- **Why:** The task requires it. Beyond that, Kubernetes gives us:
  - namespaces for isolation,
  - quotas and network policies,
  - self-healing (crashed containers restart),
  - Jobs for one-time tasks,
  - one API to create and delete everything.

  Docker Compose has none of these per-tenant controls and runs on one machine only.
- **Cost:** Kubernetes is complex to learn and uses more memory than Compose.

#### Kind for local development

- **Chosen:** Kind (Kubernetes in Docker).
- **Alternatives:** k3d (k3s in Docker); Minikube.
- **Why:**
  - Kind runs a real upstream Kubernetes in Docker containers.
  - It supports mapping host ports 80 and 443 directly.
  - The Ingress NGINX project publishes a ready-made manifest for it.
  - It is the standard tool for testing Kubernetes in CI.
  - Minikube usually needs a VM or extra tunnel command to expose port 80.
- **Cost:** Production uses k3s, so the local cluster is not identical to production. k3d would have matched production more closely (same k3s distribution, same local-path storage). We handle the differences through Helm values.

#### k3s for the VPS

- **Chosen:** k3s.
- **Alternatives:**
  - full Kubernetes installed with kubeadm,
  - managed Kubernetes (EKS, GKE, AKS),
  - MicroK8s.
- **Why:**
  - k3s is a single small binary that runs well on one 4–8 GB server.
  - It includes a load balancer (ServiceLB), local-path storage and metrics-server.
  - It is certified Kubernetes, so our Helm charts run unchanged.
  - Managed Kubernetes costs money and does not fit "a VPS box".
- **Cost:** A single-server k3s has no control-plane redundancy. If the server dies, the platform is down.

#### Helm

- **Chosen:** Helm charts, one for the platform and one per store.
- **Alternatives:** Kustomize; raw YAML with scripts; a custom Kubernetes operator.
- **Why:**
  - Helm is mandatory for the task.
  - It also fits the problem well: each store is a named, versioned release with `helm upgrade`, `helm history` and `helm rollback` built in.
  - Templates let one chart produce any store from a few values.
  - Kustomize has no release history or rollback.
- **Cost:** The API runs the `helm` program for each store instead of calling Kubernetes natively. At hundreds of stores, an operator would be faster and more scalable.

#### Namespace per store

- **Chosen:** One namespace per store.
- **Alternatives:** All stores in one shared namespace; one virtual cluster (vCluster) or one physical cluster per store.
- **Why:** A namespace is the unit that quotas, network policies and RBAC attach to. Deleting it removes everything inside, which makes cleanup reliable. A cluster per store would be far too heavy.
- **Cost:** This is "soft" isolation: stores share the same machine's kernel and Kubernetes control plane. A cluster per store would give stronger isolation.

#### Ingress NGINX

- **Chosen:** Ingress NGINX.
- **Alternatives:** Traefik (k3s's default); the newer Gateway API; HAProxy Ingress.
- **Why:**
  - Kind has an official Ingress NGINX manifest.
  - It is the most widely documented ingress controller, with simple annotations for body size, timeouts and TLS redirects.
  - It works the same on Kind and k3s, so we disable Traefik on k3s to keep one ingress everywhere.
- **Cost:** The Kubernetes community is moving to the Gateway API, and the Ingress NGINX project has announced its retirement. A future version should migrate to Gateway API.

#### nip.io and `*.localhost` for local addresses

- **Chosen:** `store-<id>.127.0.0.1.nip.io`, plus `store-<id>.localhost` as a second name.
- **Alternatives:** Editing `/etc/hosts` for every store; running a local DNS server (dnsmasq); buying a real domain.
- **Why:**
  - nip.io is a free public DNS service that answers any `*.127.0.0.1.nip.io` name with 127.0.0.1, so new stores work with zero setup.
  - Some browsers and networks block nip.io; Chrome and Firefox treat any `*.localhost` name as your own computer. That is why both names exist.
- **Cost:** nip.io needs internet DNS, and Safari may not open `*.localhost` names.

#### cert-manager and Let's Encrypt (production)

- **Chosen:** cert-manager with a Let's Encrypt ClusterIssuer (HTTP-01).
- **Alternatives:** Buying certificates and renewing them by hand; Cloudflare in front; a wildcard certificate with DNS-01.
- **Why:** cert-manager issues and renews free certificates automatically for every Ingress that asks. Adding a store or a custom domain needs no manual certificate work.
- **Cost:** Let's Encrypt limits a domain to 50 certificates per week. With many stores, switch to one wildcard certificate using DNS-01.

#### Storage: `standard` locally, `local-path` on k3s

- **Chosen:** The cluster's default dynamic storage.
- **Alternatives:** Longhorn; cloud block disks (EBS, Persistent Disk); NFS.
- **Why:** Both come built in and need no setup. They give each store its own persistent volume.
- **Cost:** A store's data lives on one machine's disk, so the store cannot move to another machine. A multi-machine cluster needs network storage such as Longhorn.

### Backend (the orchestrator API)

#### Node.js with TypeScript

- **Chosen:** Node.js 22 with TypeScript.
- **Alternatives:** Go (the language Kubernetes itself is written in); Python.
- **Why:**
  - The task asks for a Node dashboard, so the backend uses the same language as the frontend.
  - The official Kubernetes JavaScript client covers everything we need.
  - TypeScript catches mistakes before running.
  - Node 22 includes a built-in SQLite driver for the single-replica mode.
- **Cost:** Go has a more mature ecosystem for Kubernetes controllers (client-go, controller-runtime). If this became an operator, Go would be the better fit.

#### Fastify

- **Chosen:** Fastify.
- **Alternatives:** Express; NestJS; Koa.
- **Why:**
  - Fastify validates every request body against a JSON schema out of the box, which we use to reject bad names, ids and product lists.
  - It is faster than Express and has official plugins for rate limiting and CORS.
  - NestJS adds a large framework we did not need.
- **Cost:** Fewer tutorials and middleware than Express.

#### Running the Helm command from the API

- **Chosen:** The API starts the `helm` program with an argument list.
- **Alternatives:** The Helm Go library; Argo CD or Flux applying charts; writing Kubernetes objects directly without Helm.
- **Why:**
  - The Helm library only exists in Go.
  - Argo CD and Flux are designed for Git-driven changes, not "one click creates a release".
  - Running the command keeps full Helm behavior (hooks, history, rollback) with little code.
  - Arguments are passed as an array, never through a shell, so user input cannot inject commands.
- **Cost:** Each store operation starts a process, which is slower and harder to scale than native API calls.

#### Store status stored on the namespace (annotations)

- **Chosen:** Status, name, catalog and owner live as labels and annotations on the store's namespace.
- **Alternatives:** A database table of stores; a custom resource (CRD).
- **Why:**
  - The namespace exists exactly as long as the store does, so there is one source of truth that cannot disagree with reality.
  - The API holds no store state, so any copy can answer any request, and a crash loses nothing.
- **Cost:** Annotations have size limits and cannot be queried like a database. A CRD would be the cleaner long-term model.

#### Reconciler that polls every 5 seconds

- **Chosen:** A loop that lists stores every 5 seconds.
- **Alternatives:** Kubernetes watches and informers, which push changes instantly.
- **Why:** Polling is simple, easy to reason about, and recovers automatically after a restart because it re-reads everything.
- **Cost:** Status can lag by up to 5 seconds, and each pass makes API calls. Watches would be more efficient at large scale.

#### Leader election with a Kubernetes Lease

- **Chosen:** A Lease object; only its holder runs the reconciler, installs and deletes.
- **Alternatives:** Every copy reconciles and relies on Helm's lock; a Redis or etcd lock; running only one API copy.
- **Why:**
  - A Lease is built into Kubernetes, so no extra system is needed.
  - It prevents two copies from installing the same store at the same time, while still letting both copies serve requests.
- **Cost:** All installs go through one leader, so installation speed does not grow with more API copies. It would need sharding to scale further.

#### Postgres for the audit log (SQLite still supported)

- **Chosen:** A Postgres StatefulSet shared by the API copies.
- **Alternatives:** SQLite on a volume (our first version); Kubernetes Events; a managed database; Elasticsearch.
- **Why:**
  - Two API copies need one shared logbook and one shared lock.
  - SQLite is a file on a single-writer volume and cannot be shared.
  - Postgres also provides `pg_advisory_lock`, which keeps the store limits correct across copies.
  - Kubernetes Events expire after about an hour.
- **Cost:** One more stateful component to run and back up. A single Postgres pod is not highly available.

#### Postgres advisory lock for quotas

- **Chosen:** `pg_advisory_lock` around "count stores, check limits, create namespace".
- **Alternatives:** A Redis lock; a Kubernetes admission webhook that counts namespaces; ResourceQuota.
- **Why:**
  - We already run Postgres, and the lock is released automatically if the connection drops.
  - ResourceQuota cannot count namespaces, because namespaces live at cluster level.
- **Cost:** If Postgres is down, new stores cannot be created. Existing stores keep working.

#### Bearer tokens from a Helm-generated Secret

- **Chosen:** One random token per user, generated by Helm into a Kubernetes Secret.
- **Alternatives:** OIDC single sign-on (Google, Keycloak, Auth0); usernames and passwords with sessions; no authentication.
- **Why:**
  - It needs no external identity provider, works identically on a laptop and a VPS, and never puts secrets in the code.
  - The API stores only a hash of each token and compares them in constant time, so response time does not reveal which user matched.
- **Cost:** No self-service sign-up, and tokens must be rotated by hand. OIDC is the production upgrade.

#### Prometheus metrics with prom-client

- **Chosen:** `prom-client` exposing `/metrics` inside the cluster, plus a JSON summary for the dashboard.
- **Alternatives:** OpenTelemetry; a hosted service such as Datadog; no metrics.
- **Why:**
  - The Prometheus format is the Kubernetes standard, and prom-client is small.
  - Our counters are calculated from the audit log, so they survive restarts.
- **Cost:** No tracing across requests. OpenTelemetry would add traces.

### Security building blocks

#### RBAC with a per-namespace RoleBinding

- **Chosen:** The API gets broad permissions only inside each store namespace, granted per store.
- **Alternatives:** Giving the API cluster-admin; one cluster-wide role with everything.
- **Why:** Least privilege. If the API were compromised, it still could not read secrets in `kube-system` or other system namespaces.
- **Cost:** More setup: the API must create a RoleBinding before it can install a store.

#### ValidatingAdmissionPolicy

- **Chosen:** A built-in admission policy (a CEL rule): the API may only create or delete namespaces starting with `store-`.
- **Alternatives:** OPA Gatekeeper; Kyverno; trusting the code.
- **Why:** Kubernetes RBAC cannot restrict by name prefix. ValidatingAdmissionPolicy is built into Kubernetes 1.30 and later, so no extra component or webhook is needed.
- **Cost:** It requires a recent Kubernetes version, and the rules are less flexible than a full policy engine.

#### NetworkPolicy

- **Chosen:** Default-deny incoming traffic, allow same-namespace pods and the ingress controller only.
- **Alternatives:** A service mesh (Istio, Linkerd) with encrypted pod-to-pod traffic; no network rules.
- **Why:** NetworkPolicy is built in and enforced by Kind's network plugin and by k3s. A service mesh would add many components for this size of project.
- **Cost:** Traffic inside a store is not encrypted, and outgoing traffic is not restricted (the seeder must download WooCommerce).

#### Non-root containers

- **Chosen:**
  - The API, dashboard, MariaDB, Postgres and seeder run as non-root users.
  - All Linux capabilities are dropped, and the default seccomp profile is used.
  - The API and dashboard have read-only root filesystems.
- **Alternatives:** Default container settings (often root).
- **Why:** If a container is broken into, the attacker has far fewer powers.
- **Cost:** The official WordPress image must start as root to use port 80 and prepare its files, so it keeps a small set of capabilities. A custom WordPress image on port 8080 would remove that exception.

### Store (e-commerce) choices

#### WooCommerce first, MedusaJS as an interface

- **Chosen:** WooCommerce fully implemented; MedusaJS defined as an engine interface that returns "not available".
- **Alternatives:** MedusaJS first; both engines half-finished.
- **Why:**
  - WooCommerce runs from official images (WordPress plus a plugin) and supports Cash on Delivery with no payment keys.
  - It can be set up completely by WP-CLI, so the full order flow works reliably.
  - Medusa needs a backend, a worker, Postgres, Redis and a separately built storefront.
  - The task allows fully implementing one engine.
- **Cost:** Only one engine is usable today. Adding Medusa needs a new chart and one engine file; the rest of the platform does not change.

#### WordPress 6.4 image with WooCommerce 8.9.3

- **Chosen:** Pinned versions.
- **Alternatives:** Always installing the latest WooCommerce.
- **Why:** The task specifies the `wordpress:6.4` image, and newer WooCommerce versions require a newer WordPress. Pinning also makes every store identical and repeatable.
- **Cost:** Security updates must be applied deliberately with the upgrade script.

#### MariaDB

- **Chosen:** MariaDB 10.11 (long-term support).
- **Alternatives:** MySQL 8; a shared managed database for all stores.
- **Why:** MariaDB is fully supported by WordPress, its official image is lightweight, and one database per store keeps data isolated and deletes cleanly with the store.
- **Cost:** Every store runs its own database, using about 150 millicores and 192 MiB even when idle.

#### A WP-CLI seeder Job

- **Chosen:** A Kubernetes Job using the official `wordpress:cli` image and our scripts.
- **Alternatives:**
  - a custom WordPress image with everything pre-installed,
  - an init container,
  - manual setup through the web installer.
- **Why:**
  - A Job runs once, retries on failure, has a time limit, and reports "complete", which the reconciler uses to decide Ready.
  - Every step checks before acting, so a retry continues where it stopped.
  - An init container would repeat the setup every time WordPress restarts.
- **Cost:** Each new store downloads WooCommerce and the theme, which adds about 20 seconds and needs internet access. A pre-built image would be faster.

#### Storefront theme and classic cart and checkout

- **Chosen:** WooCommerce's official Storefront theme, with shortcode-based cart and checkout pages.
- **Alternatives:** WordPress's default block theme (Twenty Twenty-Four) with the block-based checkout.
- **Why:**
  - Our first version used the default block theme: stores opened as a blog with "Hello world!" and a confusing menu.
  - Storefront is designed for WooCommerce, with a header cart, product search and a mobile menu.
  - The classic checkout renders on the server and works without the large block checkout script.
- **Cost:** A more traditional look than modern block themes.

#### Cash on Delivery

- **Chosen:** WooCommerce's built-in Cash on Delivery payment method.
- **Alternatives:** Stripe or PayPal in test mode.
- **Why:** It works with no external accounts, no API keys and no internet dependency at checkout. The task allows a test-friendly method.
- **Cost:** It does not demonstrate a real card payment flow.

#### Catalogs chosen from the store name, and generated images

- **Chosen:**
  - 19 built-in store types, detected from the name and "what will you sell".
  - Products named after your items when no type matches.
  - An optional custom product list.
  - Product images drawn by PHP's GD library.
- **Alternatives:** The same demo product in every store; downloading stock photos; AI-generated catalogs.
- **Why:**
  - Every store should look like a real shop that matches its purpose.
  - Generating images locally needs no external service, no API key and no copyrighted photos, and it always works.
- **Cost:** Images are simple colored cards with initials, not photos, and detection only knows the built-in types.

### Frontend (the dashboard)

#### React with Vite

- **Chosen:** React 18, built with Vite.
- **Alternatives:** Next.js; Angular; Vue; server-rendered HTML.
- **Why:**
  - The dashboard is a single page that polls an API, so it needs no server-side rendering.
  - Vite builds it in about a second, and React is the most widely known UI library.
  - Next.js would add a Node server we do not need.
- **Cost:** It is a client-side app, so search engines cannot index it (not needed for an admin dashboard).

#### Tailwind CSS and Lucide icons

- **Chosen:** Tailwind CSS utility classes and the Lucide icon set.
- **Alternatives:** A component library (Material UI, Chakra); plain CSS.
- **Why:** Fast to style consistently without a heavy component library. The final CSS contains only the classes we use (about 23 KB).
- **Cost:** Long class lists in the markup.

#### nginx-unprivileged to serve the dashboard

- **Chosen:** The `nginxinc/nginx-unprivileged` image.
- **Alternatives:** A Node static file server; the standard nginx image.
- **Why:** It serves static files very efficiently, runs as a non-root user on port 8080, and works with a read-only filesystem.
- **Cost:** None significant.

### Delivery and operations

#### GitHub Actions and GitHub Container Registry

- **Chosen:** A GitHub Actions workflow that lints, typechecks, builds and pushes images to GHCR.
- **Alternatives:** Docker Hub; Jenkins; GitLab CI.
- **Why:** The code is already on GitHub, so Actions and GHCR need no extra accounts or secrets (the built-in `GITHUB_TOKEN` can push images).
- **Cost:** New packages are private by default and must be made public before a VPS can pull them.

#### Upgrade scripts with Helm, not GitOps

- **Chosen:** `scripts/upgrade-stores.sh`: backup, `helm upgrade`, wait for the seeder, smoke test, automatic rollback.
- **Alternatives:** Argo CD or Flux (GitOps).
- **Why:** Stores are created on demand by the API, not listed in Git, so GitOps does not fit naturally. The script gives a safe canary rollout with automatic rollback.
- **Cost:** Upgrades are started by a person or a scheduled job, not continuously reconciled from Git.

#### Makefile

- **Chosen:** A Makefile with `setup`, `deploy`, `test`, `clean`, `tokens`, `backup`, `upgrade-stores`, `rollback`.
- **Alternatives:** npm scripts; Taskfile; plain shell scripts.
- **Why:** `make` is installed on almost every developer machine, and the task asks for `make setup`, `make deploy`, `make test` and `make clean`.
- **Cost:** Makefile syntax is old-fashioned.

---

## Glossary for students

| Word | Simple meaning |
|------|----------------|
| Server | A computer that runs programs for other computers |
| Container | A lunchbox that holds one program and everything it needs, so it runs the same anywhere |
| Pod | Kubernetes' smallest unit: one or a few containers that live together |
| Kubernetes | A manager that starts containers, restarts them if they crash, and connects them |
| Namespace | A named room inside Kubernetes that keeps one group of things separate |
| Helm chart | A recipe that says which containers and settings a thing needs |
| Helm release | One cooked dish from the recipe, with a version number |
| API | A menu of requests one program can make to another |
| Database | An organized notebook a program can search and update quickly |
| Ingress | The receptionist that reads the address and sends each visitor to the right room |
| DNS | The internet's phone book: turns names into addresses |
| HTTPS / TLS | A sealed envelope for web traffic, so nobody can read or change it on the way |
| Token | A secret password card that proves who you are |
| Secret | A locked box in Kubernetes for passwords |
| Quota | A limit on how much of something you may use |
| Network policy | A rule about who may knock on whose door |
| Job | A task that runs once until it finishes |
| Reconciler | A checker that keeps comparing "what should be" with "what is", and fixes the difference |
| Leader election | Choosing one team captain so two people don't give the same order |
| Idempotent | Doing it twice has the same result as doing it once |
| Replica | An identical copy of a program, for backup and more capacity |
| Rollback | Undo: go back to the previous working version |
| Audit log | A diary of who did what and when |

---

## Five-minute presentation outline for a school project

1. **The problem (30 s).** "Starting an online shop normally takes a technician hours: a server, a database, the shop software, security. We made it one click."
2. **The mall picture (1 min).** Show the table from Part 1. Explain Kubernetes as the mall, a namespace as a shop unit, the ingress as the entrance, and the API as the mall office.
3. **Live demo (1.5 min).** Create a store, wait for it to turn green, open it, add a product to the cart and place a Cash on Delivery order.
4. **How it stays safe (1 min).** Locked doors between shops, a separate safe per shop, ID cards for staff, limits so nobody takes all the space.
5. **What happens when things break (30 s).** The supervisor notices and writes the reason; a second office copy takes over if the first one crashes; clicking twice never builds two shops.
6. **What I learned and what's next (30 s).** Trade-offs: every technology choice gives something up. Next steps: real internet server with HTTPS, a second shop engine (MedusaJS), faster setup with pre-built images.
