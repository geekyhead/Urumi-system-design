import { createHash, randomBytes } from 'node:crypto';
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
  type EngineType,
  type PlatformInfo,
  type StoreDetail,
  type StoreRecord,
  type StoreStatus,
} from '../types.js';
import type { AuditLog } from './audit.js';
import { HelmError, type HelmClient } from './helm.js';
import {
  ANNOTATION_ACCENT_COLOR,
  ANNOTATION_CATALOG,
  ANNOTATION_CATALOG_SPEC,
  ANNOTATION_CREATED_AT,
  ANNOTATION_IDEMPOTENCY,
  ANNOTATION_NAME,
  ANNOTATION_READY_AT,
  ANNOTATION_REASON,
  ANNOTATION_STATUS,
  LABEL_ENGINE,
  LABEL_MANAGED,
  LABEL_STORE_ID,
  STORE_NAMESPACE_PREFIX,
  isApiError,
  namespaceFor,
  type KubernetesClient,
} from './k8s.js';

export interface CreateStoreInput {
  name: string;
  engine: EngineType;
  catalog?: string;
  sells?: string;
  products?: CustomProductInput[];
  idempotencyKey?: string;
  actor: string;
}

const STORE_ID_LENGTH = 8;

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
  // Queries

  async list(): Promise<StoreRecord[]> {
    const namespaces = await this.k8s.listStoreNamespaces();
    return namespaces
      .map((ns) => this.toStore(ns))
      .filter((s): s is { record: StoreRecord; ref: EngineStoreRef } => s !== null)
      .map((s) => s.record)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async get(id: string): Promise<StoreDetail> {
    assertValidId(id);
    const ns = await this.k8s.getNamespace(namespaceFor(id));
    const store = ns ? this.toStore(ns) : null;
    if (!store) throw new HttpError(404, 'STORE_NOT_FOUND', `Store ${id} not found`);
    const engine = this.engines.get(store.record.engine);
    const snapshot = await this.k8s.snapshot(store.record.namespace, engine.releaseName(store.ref));
    return {
      ...store.record,
      products: store.ref.catalog.products.map((p) => ({ name: p.name, category: p.category, price: p.price })),
      health: engine.evaluate(store.ref, snapshot).health,
    };
  }

  async platformInfo(): Promise<PlatformInfo> {
    const stores = await this.list().catch(() => null);
    const reachable = stores !== null;
    return {
      status: reachable ? 'ok' : 'degraded',
      kubernetesReachable: reachable,
      lastReconcileAt: this.lastReconcileAt,
      quota: { used: stores ? stores.filter((s) => s.status !== 'Deleting').length : 0, max: this.config.maxStores },
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

  get isKubernetesReachable(): boolean {
    return this.kubernetesReachable;
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

    const keyHash = input.idempotencyKey ? sha256(input.idempotencyKey) : null;
    // Deterministic id per idempotency key: concurrent retries, even across
    // replicas, race on the same namespace name and Kubernetes lets only one win.
    const id = keyHash ? keyHash.slice(0, STORE_ID_LENGTH) : randomId();
    const namespace = namespaceFor(id);

    return this.createLock.run(async () => {
      const existing = await this.k8s.getNamespace(namespace);
      if (existing) return this.replay(existing, input, keyHash);

      const stores = await this.list();
      const active = stores.filter((s) => s.status !== 'Deleting').length;
      if (active >= this.config.maxStores) {
        this.audit.record('STORE_CREATE_REJECTED', {
          actor: input.actor,
          message: `Rejected "${input.name}": store quota reached (${active}/${this.config.maxStores})`,
          details: { active, max: this.config.maxStores },
        });
        throw new HttpError(429, 'STORE_QUOTA_EXCEEDED', `Store limit reached (${this.config.maxStores})`);
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
      this.audit.record('STORE_CREATE_REQUESTED', {
        storeId: id,
        actor: input.actor,
        message: `Store "${input.name}" requested (${engine.displayName}, ${catalog.label}, ${catalog.products.length} products)`,
        details: { engine: input.engine, catalog: catalog.type, sells: input.sells ?? null, namespace, idempotent: Boolean(keyHash) },
      });
      this.startProvision(store.record, 'STORE_PROVISIONING_STARTED');
      return { store: store.record, created: true };
    });
  }

  async delete(id: string, actor: string): Promise<StoreRecord> {
    assertValidId(id);
    const ns = await this.k8s.getNamespace(namespaceFor(id));
    const store = ns ? this.toStore(ns) : null;
    if (!store) throw new HttpError(404, 'STORE_NOT_FOUND', `Store ${id} not found`);
    const record = store.record;

    if (record.status !== 'Deleting') {
      await this.k8s.patchNamespaceAnnotations(record.namespace, {
        [ANNOTATION_STATUS]: 'Deleting',
        [ANNOTATION_REASON]: null,
      });
      this.audit.record('STORE_DELETE_REQUESTED', {
        storeId: id,
        actor,
        message: `Deletion of "${record.name}" requested`,
        details: { previousStatus: record.status },
      });
    }
    const deleting = { ...record, status: 'Deleting' as const, reason: null };
    this.startTeardown(deleting, store.ref);
    return deleting;
  }

  // ---------------------------------------------------------------------------
  // Background work

  private refFor(store: StoreRecord, ns: V1Namespace | null): EngineStoreRef {
    return ns ? (this.toStore(ns)?.ref ?? this.fallbackRef(store)) : this.fallbackRef(store);
  }

  private fallbackRef(store: StoreRecord): EngineStoreRef {
    return {
      id: store.id,
      name: store.name,
      namespace: store.namespace,
      accentColor: store.accentColor,
      catalog: resolveCatalog({ type: store.catalog }, store.name, store.id),
    };
  }

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
        const ref = this.refFor(store, ns);
        await this.k8s.ensureTenantRoleBinding(
          store.namespace,
          this.config.tenantClusterRole,
          this.config.platformNamespace,
          this.config.serviceAccountName,
        );
        await engine.provision(ref, { helm: this.helm, config: this.config });
        this.audit.record(action, {
          storeId: store.id,
          message: `Helm release ${engine.releaseName(ref)} applied; waiting for workloads`,
          details: { namespace: store.namespace },
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

  /** One pass of the control loop over every managed namespace. */
  async reconcile(): Promise<void> {
    const namespaces = await this.k8s.listStoreNamespaces();
    await Promise.all(
      namespaces.map(async (ns) => {
        const store = this.toStore(ns);
        if (!store) return;
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
      // Resume teardown after a crash, or finish a delete issued out of band.
      this.startTeardown({ ...store, status: 'Deleting' }, ref);
      return;
    }
    if (store.status === 'Ready' || this.inflightProvisions.has(store.id)) return;

    const engine = this.engines.get(store.engine);
    const snapshot = await this.k8s.snapshot(store.namespace, engine.releaseName(ref));

    if (store.status === 'Provisioning' && !snapshot.helmReleasePresent) {
      // Orchestrator died between namespace creation and helm install.
      if (this.ageSeconds(store) > this.config.provisionTimeoutSeconds) {
        await this.transition(store, 'Failed', 'Provisioning timed out before the Helm release was created');
      } else {
        this.startProvision(store, 'STORE_PROVISIONING_RESUMED');
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

    if (status === 'Ready') {
      const recovered = current.status === 'Failed';
      this.audit.record(recovered ? 'STORE_RECOVERED' : 'STORE_READY', {
        storeId: store.id,
        message: recovered
          ? `Store "${store.name}" recovered and is Ready`
          : `Store "${store.name}" is Ready after ${this.ageSeconds(store)}s`,
        details: { urls: store.urls },
      });
    } else if (status === 'Failed') {
      this.audit.record('STORE_FAILED', { storeId: store.id, message: `Store "${store.name}" failed: ${reason}` });
    }
    this.log.info({ storeId: store.id, from: current.status, to: status, reason }, 'store status transition');
  }

  // ---------------------------------------------------------------------------
  // Mapping

  private replay(ns: V1Namespace, input: CreateStoreInput, keyHash: string | null): { store: StoreRecord; created: boolean } {
    const store = this.toStore(ns)?.record;
    const existingHash = ns.metadata?.annotations?.[ANNOTATION_IDEMPOTENCY];
    if (!store || !keyHash || existingHash !== keyHash) {
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
    };
    const record: StoreRecord = {
      id,
      name: storeName,
      engine: engineType,
      catalog: catalog.type,
      catalogLabel: catalog.label,
      productCount: catalog.products.length,
      accentColor: ref.accentColor,
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
