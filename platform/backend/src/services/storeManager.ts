import { createHash, randomBytes } from 'node:crypto';
import dns from 'node:dns/promises';
import type { V1Namespace } from '@kubernetes/client-node';
import type { FastifyBaseLogger } from 'fastify';
import {
  accentColorFor,
  listCatalogTypes,
  resolveCatalog,
  type CatalogSpec,
  type CustomProductInput,
  type ResolvedCatalog,
} from '../catalogs.js';
import type { Config } from '../config.js';
import { EngineUnavailableError, type EngineRegistry, type EngineStoreRef } from '../engines/index.js';
import {
  HttpError,
  type DomainCheck,
  type EngineType,
  type PlatformInfo,
  type StoreDetail,
  type StoreRecord,
  type StoreStatus,
} from '../types.js';
import type { AuditLog } from './audit.js';
import type { AuthUser } from './auth.js';
import { HelmError, type HelmClient } from './helm.js';
import {
  ANNOTATION_ACCENT_COLOR,
  ANNOTATION_CATALOG,
  ANNOTATION_CATALOG_SPEC,
  ANNOTATION_CREATED_AT,
  ANNOTATION_CUSTOM_DOMAINS,
  ANNOTATION_IDEMPOTENCY,
  ANNOTATION_NAME,
  ANNOTATION_READY_AT,
  ANNOTATION_REASON,
  ANNOTATION_STATUS,
  LABEL_ENGINE,
  LABEL_MANAGED,
  LABEL_OWNER,
  LABEL_STORE_ID,
  STORE_NAMESPACE_PREFIX,
  isApiError,
  namespaceFor,
  type KubernetesClient,
} from './k8s.js';
import type { LeaderElector } from './leader.js';
import type { PlatformMetrics } from './metrics.js';

export interface CreateStoreInput {
  name: string;
  engine: EngineType;
  catalog?: string;
  sells?: string;
  products?: CustomProductInput[];
  idempotencyKey?: string;
  owner: AuthUser;
  actor: string;
}

const STORE_ID_LENGTH = 8;
const DOMAIN_PATTERN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Serialises async critical sections within this process. */
class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/** Bounds how many helm installs run at once so a burst cannot starve the node. */
class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly size: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.size) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

/**
 * Store lifecycle state machine. Kubernetes is the source of truth: every
 * store is a labelled namespace and its status lives in namespace
 * annotations, so the orchestrator is stateless and can crash or restart at
 * any point and resume from the reconciler.
 *
 * Any replica accepts API requests and writes intent (namespace, annotations).
 * Only the lease-holding replica provisions, tears down and reconciles.
 *
 *   (create) -> Provisioning -> Ready
 *                    |  ^
 *                    v  | (recovers)
 *                  Failed
 *   any state -> Deleting -> (namespace gone)
 */
export class StoreManager {
  private readonly createLock = new Mutex();
  private readonly provisionSlots: Semaphore;
  private readonly inflightProvisions = new Map<string, Promise<void>>();
  private readonly inflightDeletions = new Map<string, Promise<void>>();
  private reconcileTimer: NodeJS.Timeout | null = null;
  private reconciling = false;
  private lastReconcileAt: string | null = null;
  private kubernetesReachable = false;
  private cachedStores: StoreRecord[] | null = null;
  private metrics: PlatformMetrics | null = null;
  private leader: LeaderElector | null = null;

  constructor(
    private readonly config: Config,
    private readonly k8s: KubernetesClient,
    private readonly helm: HelmClient,
    private readonly engines: EngineRegistry,
    private readonly audit: AuditLog,
    private readonly log: FastifyBaseLogger,
  ) {
    this.provisionSlots = new Semaphore(config.maxConcurrentProvisions);
  }

  // ---------------------------------------------------------------------------
  // Wiring

  setMetrics(metrics: PlatformMetrics): void {
    this.metrics = metrics;
  }

  setLeader(leader: LeaderElector): void {
    this.leader = leader;
  }

  get isLeader(): boolean {
    return this.leader ? this.leader.isLeader : true;
  }

  get isKubernetesReachable(): boolean {
    return this.kubernetesReachable;
  }

  /** Stores seen by the last reconcile pass (cheap, no API call); null before the first pass. */
  get lastKnownStores(): StoreRecord[] | null {
    return this.cachedStores;
  }

  // ---------------------------------------------------------------------------
  // Queries

  async list(viewer?: AuthUser): Promise<StoreRecord[]> {
    const namespaces = await this.k8s.listStoreNamespaces();
    return namespaces
      .map((ns) => this.toStore(ns)?.record)
      .filter((record): record is StoreRecord => Boolean(record))
      .filter((record) => !viewer || canAccess(record, viewer))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async get(id: string, viewer: AuthUser): Promise<StoreDetail> {
    const store = await this.findAccessible(id, viewer);
    const engine = this.engines.get(store.record.engine);
    // A brand-new namespace can briefly lack the tenant RoleBinding; report empty health instead of failing.
    const snapshot = await this.k8s
      .snapshot(store.record.namespace, engine.releaseName(store.ref))
      .catch((err: unknown) => {
        if (isApiError(err, 403)) return { pods: [], jobs: [], helmReleasePresent: false };
        throw err;
      });
    return {
      ...store.record,
      products: store.ref.catalog.products.map((p) => ({ name: p.name, category: p.category, price: p.price })),
      health: engine.evaluate(store.ref, snapshot).health,
    };
  }

  async platformInfo(viewer: AuthUser): Promise<PlatformInfo> {
    const stores = await this.list().catch(() => null);
    const reachable = stores !== null;
    const active = (stores ?? []).filter((s) => s.status !== 'Deleting');
    return {
      status: reachable ? 'ok' : 'degraded',
      kubernetesReachable: reachable,
      lastReconcileAt: this.lastReconcileAt,
      quota: { used: active.length, max: this.config.maxStores },
      userQuota: { used: active.filter((s) => s.owner === viewer.name).length, max: viewer.maxStores },
      user: viewer,
      authEnabled: this.config.authEnabled,
      orchestrator: {
        instance: this.config.podName,
        leader: this.leader ? this.leader.currentHolder : this.config.podName,
        leaderElection: Boolean(this.leader),
        auditBackend: this.audit.backend,
      },
      ingress: { address: this.config.publicIngressAddress, hostname: this.config.publicIngressHostname || null },
      engines: this.engines.list().map((e) => ({
        type: e.type,
        displayName: e.displayName,
        available: e.available,
        description: e.description,
      })),
      catalogs: listCatalogTypes(),
      baseDomain: this.config.baseDomain,
    };
  }

  /** What a create request with these inputs would seed, without creating anything. */
  previewCatalog(name: string, spec: CatalogSpec): ResolvedCatalog {
    return resolveCatalog(spec, name.trim() || 'My Store', `preview-${name}`);
  }

  async checkDomains(id: string, viewer: AuthUser): Promise<DomainCheck[]> {
    const store = await this.findAccessible(id, viewer);
    const expectedAddress = this.config.publicIngressAddress;
    const expectedHost = this.config.publicIngressHostname.toLowerCase();
    return Promise.all(
      store.record.customDomains.map(async (domain): Promise<DomainCheck> => {
        const resolvesTo: string[] = [];
        let error: string | null = null;
        try {
          resolvesTo.push(...(await dns.lookup(domain, { all: true })).map((r) => r.address));
        } catch (err) {
          error = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
        }
        let cname: string[] = [];
        if (expectedHost) cname = await dns.resolveCname(domain).catch(() => []);
        const ok =
          (Boolean(expectedAddress) && resolvesTo.includes(expectedAddress)) ||
          (Boolean(expectedHost) && cname.some((c) => c.toLowerCase().replace(/\.$/, '') === expectedHost));
        return {
          domain,
          ok,
          resolvesTo: [...resolvesTo, ...cname.map((c) => `CNAME ${c}`)],
          expected: expectedHost ? `A ${expectedAddress} or CNAME ${expectedHost}` : `A ${expectedAddress}`,
          error: ok ? null : error,
        };
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Commands

  async create(input: CreateStoreInput): Promise<{ store: StoreRecord; created: boolean }> {
    const engine = this.engines.get(input.engine);
    if (!engine.available) {
      this.audit.record('STORE_CREATE_REJECTED', {
        actor: input.actor,
        message: `Rejected "${input.name}": engine ${engine.displayName} is not available`,
        details: { engine: input.engine },
      });
      throw new HttpError(501, 'ENGINE_NOT_AVAILABLE', `${engine.displayName} engine is not available yet`);
    }

    const keyHash = input.idempotencyKey ? sha256(`${input.owner.name}:${input.idempotencyKey}`) : null;
    // Deterministic id per (user, idempotency key): concurrent retries, even across
    // replicas, race on the same namespace name and Kubernetes lets only one win.
    const id = keyHash ? keyHash.slice(0, STORE_ID_LENGTH) : randomId();
    const namespace = namespaceFor(id);

    // The global lock (Postgres advisory lock when shared) makes the quota check
    // and namespace creation atomic across every API replica.
    return this.audit.withGlobalLock(() =>
      this.createLock.run(async () => {
        const existing = await this.k8s.getNamespace(namespace);
        if (existing) return this.replay(existing, input, keyHash);

        const stores = await this.list();
        const active = stores.filter((s) => s.status !== 'Deleting');
        if (active.length >= this.config.maxStores) {
          this.reject(input, `store quota reached (${active.length}/${this.config.maxStores})`, { active: active.length });
          throw new HttpError(429, 'STORE_QUOTA_EXCEEDED', `Platform store limit reached (${this.config.maxStores})`);
        }
        const owned = active.filter((s) => s.owner === input.owner.name).length;
        if (owned >= input.owner.maxStores) {
          this.reject(input, `user ${input.owner.name} reached their store limit (${owned}/${input.owner.maxStores})`, {
            owned,
            max: input.owner.maxStores,
          });
          throw new HttpError(429, 'USER_QUOTA_EXCEEDED', `You have reached your store limit (${input.owner.maxStores})`);
        }

        const spec: CatalogSpec = {
          type: input.catalog ?? 'auto',
          ...(input.sells ? { sells: input.sells } : {}),
          ...(input.products?.length ? { products: input.products } : {}),
        };
        const catalog = resolveCatalog(spec, input.name, id);
        const createdAt = new Date().toISOString();
        let created: V1Namespace;
        try {
          created = await this.k8s.createNamespace({
            metadata: {
              name: namespace,
              labels: {
                [LABEL_MANAGED]: 'true',
                [LABEL_STORE_ID]: id,
                [LABEL_ENGINE]: input.engine,
                [LABEL_OWNER]: input.owner.name,
                'pod-security.kubernetes.io/enforce': 'baseline',
                'pod-security.kubernetes.io/warn': 'restricted',
              },
              annotations: {
                [ANNOTATION_NAME]: input.name,
                [ANNOTATION_STATUS]: 'Provisioning',
                [ANNOTATION_CREATED_AT]: createdAt,
                [ANNOTATION_CATALOG]: catalog.type,
                [ANNOTATION_CATALOG_SPEC]: JSON.stringify(spec),
                [ANNOTATION_ACCENT_COLOR]: accentColorFor(id),
                ...(keyHash ? { [ANNOTATION_IDEMPOTENCY]: keyHash } : {}),
              },
            },
          });
        } catch (err) {
          if (isApiError(err, 409)) {
            const winner = await this.k8s.getNamespace(namespace);
            if (winner) return this.replay(winner, input, keyHash);
          }
          throw err;
        }

        const store = this.toStore(created);
        if (!store) throw new Error(`Namespace ${namespace} created without store metadata`);
        // Grant the tenant role right away (on whichever replica took the request) so
        // status reads work before the leader starts the install.
        await this.k8s.ensureTenantRoleBinding(
          namespace,
          this.config.tenantClusterRole,
          this.config.platformNamespace,
          this.config.serviceAccountName,
        );
        this.audit.record('STORE_CREATE_REQUESTED', {
          storeId: id,
          actor: input.actor,
          message: `Store "${input.name}" requested by ${input.owner.name} (${engine.displayName}, ${catalog.label}, ${catalog.products.length} products)`,
          details: {
            engine: input.engine,
            owner: input.owner.name,
            catalog: catalog.type,
            sells: input.sells ?? null,
            namespace,
            idempotent: Boolean(keyHash),
          },
        });
        // Non-leaders only record intent; the leader's reconciler starts the install within one interval.
        if (this.isLeader) this.startProvision(store.record, 'STORE_PROVISIONING_STARTED');
        return { store: store.record, created: true };
      }),
    );
  }

  async delete(id: string, actor: string, viewer: AuthUser): Promise<StoreRecord> {
    const store = await this.findAccessible(id, viewer);
    const record = store.record;

    if (record.status !== 'Deleting') {
      await this.k8s.patchNamespaceAnnotations(record.namespace, {
        [ANNOTATION_STATUS]: 'Deleting',
        [ANNOTATION_REASON]: null,
      });
      this.audit.record('STORE_DELETE_REQUESTED', {
        storeId: id,
        actor,
        message: `Deletion of "${record.name}" requested by ${viewer.name}`,
        details: { previousStatus: record.status, owner: record.owner },
      });
    }
    const deleting = { ...record, status: 'Deleting' as const, reason: null };
    if (this.isLeader) this.startTeardown(deleting, store.ref);
    return deleting;
  }

  /** Attaches customer domains to a store: validates, updates the Ingress through Helm, audits. */
  async setDomains(id: string, requested: string[], actor: string, viewer: AuthUser): Promise<StoreRecord> {
    const store = await this.findAccessible(id, viewer);
    if (store.record.status !== 'Ready') {
      throw new HttpError(409, 'STORE_NOT_READY', 'Domains can only be changed on a Ready store');
    }
    const domains = [...new Set(requested.map((d) => d.trim().toLowerCase().replace(/\.$/, '')).filter(Boolean))];
    if (domains.length > this.config.maxCustomDomains) {
      throw new HttpError(400, 'TOO_MANY_DOMAINS', `At most ${this.config.maxCustomDomains} custom domains per store`);
    }
    const reserved = [this.config.baseDomain, ...this.config.storeAliasDomains, 'localhost'];
    for (const domain of domains) {
      if (!DOMAIN_PATTERN.test(domain)) {
        throw new HttpError(400, 'INVALID_DOMAIN', `"${domain}" is not a valid domain name`);
      }
      if (reserved.some((r) => domain === r || domain.endsWith(`.${r}`))) {
        throw new HttpError(400, 'RESERVED_DOMAIN', `"${domain}" is under a platform domain and cannot be attached`);
      }
    }

    return this.audit.withGlobalLock(async () => {
      const others = (await this.list()).filter((s) => s.id !== id);
      const taken = domains.find((d) => others.some((s) => s.customDomains.includes(d)));
      if (taken) throw new HttpError(409, 'DOMAIN_IN_USE', `"${taken}" is already attached to another store`);

      const previous = store.record.customDomains;
      const engine = this.engines.get(store.record.engine);
      await this.k8s.patchNamespaceAnnotations(store.record.namespace, {
        [ANNOTATION_CUSTOM_DOMAINS]: domains.length ? JSON.stringify(domains) : null,
      });
      try {
        await this.k8s.ensureTenantRoleBinding(
          store.record.namespace,
          this.config.tenantClusterRole,
          this.config.platformNamespace,
          this.config.serviceAccountName,
        );
        await engine.provision({ ...store.ref, customDomains: domains }, { helm: this.helm, config: this.config });
      } catch (err) {
        await this.k8s.patchNamespaceAnnotations(store.record.namespace, {
          [ANNOTATION_CUSTOM_DOMAINS]: previous.length ? JSON.stringify(previous) : null,
        });
        throw new HttpError(502, 'DOMAIN_UPDATE_FAILED', `Could not update the store ingress: ${errorMessage(err)}`);
      }

      this.audit.record('STORE_DOMAINS_UPDATED', {
        storeId: id,
        actor,
        message: domains.length
          ? `Domains for "${store.record.name}" set to ${domains.join(', ')}`
          : `Custom domains removed from "${store.record.name}"`,
        details: { previous, domains },
      });
      const ns = await this.k8s.getNamespace(store.record.namespace);
      const updated = ns ? this.toStore(ns)?.record : null;
      return updated ?? { ...store.record, customDomains: domains };
    });
  }

  // ---------------------------------------------------------------------------
  // Background work (leader only)

  private startProvision(store: StoreRecord, action: 'STORE_PROVISIONING_STARTED' | 'STORE_PROVISIONING_RESUMED'): void {
    if (this.inflightProvisions.has(store.id)) return;
    const work = this.provisionSlots
      .run(async () => {
        const engine = this.engines.get(store.engine);
        // The store might have been deleted while queued.
        const ns = await this.k8s.getNamespace(store.namespace);
        if (!ns || ns.metadata?.annotations?.[ANNOTATION_STATUS] === 'Deleting' || ns.status?.phase === 'Terminating') {
          return;
        }
        const ref = this.toStore(ns)?.ref;
        if (!ref) return;
        await this.k8s.ensureTenantRoleBinding(
          store.namespace,
          this.config.tenantClusterRole,
          this.config.platformNamespace,
          this.config.serviceAccountName,
        );
        await engine.provision(ref, { helm: this.helm, config: this.config });
        this.audit.record(action, {
          storeId: store.id,
          message: `Helm release ${engine.releaseName(ref)} applied by ${this.config.podName}; waiting for workloads`,
          details: { namespace: store.namespace, instance: this.config.podName },
        });
      })
      .catch(async (err: unknown) => {
        if (err instanceof HelmError && err.isLocked) {
          this.log.warn({ storeId: store.id }, 'helm release locked by another operation; reconciler will retry');
          return;
        }
        const reason = err instanceof EngineUnavailableError ? err.message : `Provisioning error: ${errorMessage(err)}`;
        this.log.error({ err, storeId: store.id }, 'provisioning failed');
        await this.transition(store, 'Failed', reason);
      })
      .finally(() => this.inflightProvisions.delete(store.id));
    this.inflightProvisions.set(store.id, work);
  }

  private startTeardown(store: StoreRecord, ref: EngineStoreRef): void {
    if (this.inflightDeletions.has(store.id)) return;
    const work = (async () => {
      const engine = this.engines.get(store.engine);
      await this.inflightProvisions.get(store.id)?.catch(() => undefined);
      try {
        const ns = await this.k8s.getNamespace(store.namespace);
        if (ns && ns.status?.phase !== 'Terminating') {
          // helm uninstall reads release Secrets, which needs the tenant RoleBinding.
          await this.ensureAccess(store.namespace);
          await engine.deprovision(ref, { helm: this.helm, config: this.config });
        }
        await this.k8s.deleteNamespace(store.namespace);
        const deadline = Date.now() + this.config.deleteTimeoutSeconds * 1000;
        while (await this.k8s.getNamespace(store.namespace)) {
          if (Date.now() > deadline) {
            throw new Error(`namespace ${store.namespace} still terminating after ${this.config.deleteTimeoutSeconds}s`);
          }
          await sleep(2000);
        }
        this.audit.record('STORE_DELETED', {
          storeId: store.id,
          message: `Store "${store.name}" deleted; namespace ${store.namespace} removed`,
          details: { namespace: store.namespace },
        });
      } catch (err) {
        this.log.error({ err, storeId: store.id }, 'teardown failed');
        this.audit.record('STORE_DELETE_FAILED', {
          storeId: store.id,
          message: `Deletion of "${store.name}" failed, will retry: ${errorMessage(err)}`,
        });
      }
    })().finally(() => this.inflightDeletions.delete(store.id));
    this.inflightDeletions.set(store.id, work);
  }

  start(): void {
    const tick = async () => {
      if (this.reconciling) return;
      this.reconciling = true;
      try {
        await this.reconcile();
        this.kubernetesReachable = true;
        this.lastReconcileAt = new Date().toISOString();
      } catch (err) {
        this.kubernetesReachable = false;
        this.log.error({ err }, 'reconcile loop error');
      } finally {
        this.reconciling = false;
      }
    };
    void tick();
    this.reconcileTimer = setInterval(() => void tick(), this.config.reconcileIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    await Promise.allSettled([...this.inflightProvisions.values(), ...this.inflightDeletions.values()]);
  }

  /** One pass of the control loop. Every replica refreshes its cache; only the leader acts. */
  async reconcile(): Promise<void> {
    const namespaces = await this.k8s.listStoreNamespaces();
    const stores = namespaces
      .map((ns) => ({ ns, store: this.toStore(ns) }))
      .filter((entry): entry is { ns: V1Namespace; store: { record: StoreRecord; ref: EngineStoreRef } } => Boolean(entry.store));
    this.cachedStores = stores.map((entry) => entry.store.record);
    if (!this.isLeader) return;

    await Promise.all(
      stores.map(async ({ ns, store }) => {
        try {
          await this.reconcileStore(store.record, store.ref, ns);
        } catch (err) {
          this.log.warn({ err, storeId: store.record.id }, 'reconcile store failed');
        }
      }),
    );
  }

  private async reconcileStore(store: StoreRecord, ref: EngineStoreRef, ns: V1Namespace): Promise<void> {
    if (store.status === 'Deleting' || ns.status?.phase === 'Terminating') {
      // Resume teardown after a crash or leader change, or finish a delete issued by another replica.
      this.startTeardown({ ...store, status: 'Deleting' }, ref);
      return;
    }
    if (store.status === 'Ready' || this.inflightProvisions.has(store.id)) return;

    // Self-heal: stores accepted before their RoleBinding existed (or whose binding
    // was removed) would otherwise fail every snapshot with 403 and never progress.
    await this.ensureAccess(store.namespace);
    const engine = this.engines.get(store.engine);
    const snapshot = await this.k8s.snapshot(store.namespace, engine.releaseName(ref));

    if (store.status === 'Provisioning' && !snapshot.helmReleasePresent) {
      if (this.ageSeconds(store) > this.config.provisionTimeoutSeconds) {
        await this.transition(store, 'Failed', 'Provisioning timed out before the Helm release was created');
      } else {
        // Fresh stores accepted by another replica, or installs interrupted by a crash.
        this.startProvision(store, this.ageSeconds(store) < 60 ? 'STORE_PROVISIONING_STARTED' : 'STORE_PROVISIONING_RESUMED');
      }
      return;
    }

    const evaluation = engine.evaluate(ref, snapshot);
    switch (evaluation.phase) {
      case 'Ready':
        await this.transition(store, 'Ready', null);
        return;
      case 'Failed':
        if (store.status !== 'Failed' || store.reason !== evaluation.reason) {
          await this.transition(store, 'Failed', evaluation.reason);
        }
        return;
      case 'Progressing':
        if (store.status === 'Provisioning' && this.ageSeconds(store) > this.config.provisionTimeoutSeconds) {
          await this.transition(
            store,
            'Failed',
            `Provisioning timed out after ${this.config.provisionTimeoutSeconds}s (${evaluation.detail})`,
          );
        }
        return;
    }
  }

  private async transition(store: StoreRecord, status: StoreStatus, reason: string | null): Promise<void> {
    const ns = await this.k8s.getNamespace(store.namespace);
    const current = ns ? this.toStore(ns)?.record : null;
    if (!current || current.status === 'Deleting') return;
    if (current.status === status && current.reason === reason) return;

    const annotations: Record<string, string | null> = {
      [ANNOTATION_STATUS]: status,
      [ANNOTATION_REASON]: reason,
    };
    if (status === 'Ready') annotations[ANNOTATION_READY_AT] = new Date().toISOString();
    await this.k8s.patchNamespaceAnnotations(store.namespace, annotations);

    const seconds = this.ageSeconds(store);
    if (status === 'Ready') {
      const recovered = current.status === 'Failed';
      if (!recovered) this.metrics?.observeProvisioning(store.engine, 'ready', seconds);
      this.audit.record(recovered ? 'STORE_RECOVERED' : 'STORE_READY', {
        storeId: store.id,
        message: recovered
          ? `Store "${store.name}" recovered and is Ready`
          : `Store "${store.name}" is Ready after ${seconds}s`,
        // durationSeconds feeds the provisioning-time metrics; recoveries would skew it.
        details: recovered ? { urls: store.urls } : { urls: store.urls, durationSeconds: seconds },
      });
    } else if (status === 'Failed') {
      if (current.status === 'Provisioning') this.metrics?.observeProvisioning(store.engine, 'failed', seconds);
      this.audit.record('STORE_FAILED', {
        storeId: store.id,
        message: `Store "${store.name}" failed: ${reason}`,
        details: { afterSeconds: seconds },
      });
    }
    this.log.info({ storeId: store.id, from: current.status, to: status, reason }, 'store status transition');
  }

  // ---------------------------------------------------------------------------
  // Mapping

  private async findAccessible(id: string, viewer: AuthUser): Promise<{ record: StoreRecord; ref: EngineStoreRef }> {
    assertValidId(id);
    const ns = await this.k8s.getNamespace(namespaceFor(id));
    const store = ns ? this.toStore(ns) : null;
    // Stores owned by someone else look exactly like missing stores.
    if (!store || !canAccess(store.record, viewer)) throw new HttpError(404, 'STORE_NOT_FOUND', `Store ${id} not found`);
    return store;
  }

  private ensureAccess(namespace: string): Promise<void> {
    return this.k8s.ensureTenantRoleBinding(
      namespace,
      this.config.tenantClusterRole,
      this.config.platformNamespace,
      this.config.serviceAccountName,
    );
  }

  private reject(input: CreateStoreInput, why: string, details: Record<string, unknown>): void {
    this.audit.record('STORE_CREATE_REJECTED', {
      actor: input.actor,
      message: `Rejected "${input.name}": ${why}`,
      details: { ...details, owner: input.owner.name },
    });
  }

  private replay(ns: V1Namespace, input: CreateStoreInput, keyHash: string | null): { store: StoreRecord; created: boolean } {
    const store = this.toStore(ns)?.record;
    const existingHash = ns.metadata?.annotations?.[ANNOTATION_IDEMPOTENCY];
    if (!store || !keyHash || existingHash !== keyHash || store.owner !== input.owner.name) {
      throw new HttpError(409, 'STORE_ID_CONFLICT', 'A store with this identifier already exists');
    }
    if (store.status === 'Deleting') {
      throw new HttpError(409, 'STORE_DELETING', `Store ${store.id} for this idempotency key is being deleted`);
    }
    if (store.engine !== input.engine || store.name !== input.name) {
      throw new HttpError(422, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was already used with a different request body');
    }
    this.audit.record('STORE_CREATE_REPLAYED', {
      storeId: store.id,
      actor: input.actor,
      message: `Idempotent replay for "${store.name}" returned existing store`,
    });
    return { store, created: false };
  }

  private toStore(ns: V1Namespace): { record: StoreRecord; ref: EngineStoreRef } | null {
    const name = ns.metadata?.name ?? '';
    const labels = ns.metadata?.labels ?? {};
    const annotations = ns.metadata?.annotations ?? {};
    const id = labels[LABEL_STORE_ID];
    const engineType = labels[LABEL_ENGINE] as EngineType | undefined;
    if (!name.startsWith(STORE_NAMESPACE_PREFIX) || !id || !engineType) return null;
    let engine;
    try {
      engine = this.engines.get(engineType);
    } catch {
      return null;
    }
    const storeName = annotations[ANNOTATION_NAME] ?? id;
    const catalog = resolveCatalog(parseSpec(annotations[ANNOTATION_CATALOG_SPEC], annotations[ANNOTATION_CATALOG]), storeName, id);
    const terminating = ns.status?.phase === 'Terminating';
    const status = (terminating ? 'Deleting' : (annotations[ANNOTATION_STATUS] ?? 'Provisioning')) as StoreStatus;
    const ref: EngineStoreRef = {
      id,
      name: storeName,
      namespace: name,
      catalog,
      accentColor: annotations[ANNOTATION_ACCENT_COLOR] ?? accentColorFor(id),
      customDomains: parseDomains(annotations[ANNOTATION_CUSTOM_DOMAINS]),
    };
    const record: StoreRecord = {
      id,
      name: storeName,
      engine: engineType,
      owner: labels[LABEL_OWNER] ?? null,
      catalog: catalog.type,
      catalogLabel: catalog.label,
      productCount: catalog.products.length,
      accentColor: ref.accentColor,
      customDomains: ref.customDomains,
      namespace: name,
      status,
      reason: annotations[ANNOTATION_REASON] ?? null,
      createdAt:
        annotations[ANNOTATION_CREATED_AT] ??
        (ns.metadata?.creationTimestamp ? new Date(ns.metadata.creationTimestamp).toISOString() : new Date(0).toISOString()),
      readyAt: annotations[ANNOTATION_READY_AT] ?? null,
      urls: engine.urls(ref),
    };
    return { record, ref };
  }

  private ageSeconds(store: StoreRecord): number {
    return Math.round((Date.now() - Date.parse(store.createdAt)) / 1000);
  }
}

/** Admins see every store; users see stores they own. Stores from before auth have no owner and are admin-only. */
function canAccess(record: StoreRecord, viewer: AuthUser): boolean {
  return viewer.role === 'admin' || record.owner === viewer.name;
}

function parseSpec(raw: string | undefined, legacyType: string | undefined): CatalogSpec {
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as CatalogSpec;
      if (parsed && typeof parsed.type === 'string') return parsed;
    } catch {
      // fall through to the legacy single-type annotation
    }
  }
  return { type: legacyType ?? 'auto' };
}

function parseDomains(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === 'string') : [];
  } catch {
    return [];
  }
}

function assertValidId(id: string): void {
  if (!/^[a-z0-9]{3,20}$/.test(id)) throw new HttpError(400, 'INVALID_STORE_ID', 'Invalid store id');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function randomId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(STORE_ID_LENGTH);
  let id = '';
  for (const b of bytes) id += alphabet[b % alphabet.length];
  return id;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 500);
  return String(err).slice(0, 500);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
