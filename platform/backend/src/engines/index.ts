import type { V1Pod } from '@kubernetes/client-node';
import type { ResolvedCatalog } from '../catalogs.js';
import type { Config } from '../config.js';
import type { HelmClient } from '../services/helm.js';
import { namespaceFor, type NamespaceSnapshot } from '../services/k8s.js';
import type { EngineType, PodHealth, StoreHealth, StoreUrls } from '../types.js';
import { MedusaEngineProvider } from './medusa.js';
import { WooCommerceEngineProvider } from './woocommerce.js';

export interface EngineStoreRef {
  id: string;
  name: string;
  namespace: string;
  catalog: ResolvedCatalog;
  customDomains: string[];
  accentColor: string;
}

export interface EngineContext {
  helm: HelmClient;
  config: Config;
}

export type EngineEvaluation =
  | { phase: 'Ready'; health: StoreHealth }
  | { phase: 'Progressing'; health: StoreHealth; detail: string }
  | { phase: 'Failed'; health: StoreHealth; reason: string };

/**
 * Contract every store engine implements. The orchestrator owns namespaces,
 * RBAC, quotas, idempotency and the lifecycle state machine; an engine only
 * knows how to deploy, judge health of, and remove its own workloads.
 */
export interface EngineProvider {
  readonly type: EngineType;
  readonly displayName: string;
  readonly description: string;
  /** Whether the engine can actually be provisioned on this platform. */
  readonly available: boolean;

  releaseName(store: EngineStoreRef): string;
  urls(store: EngineStoreRef): StoreUrls;
  provision(store: EngineStoreRef, ctx: EngineContext): Promise<void>;
  deprovision(store: EngineStoreRef, ctx: EngineContext): Promise<void>;
  evaluate(store: EngineStoreRef, snapshot: NamespaceSnapshot): EngineEvaluation;
}

export class EngineUnavailableError extends Error {
  override readonly name = 'EngineUnavailableError';
}

// ---------------------------------------------------------------------------
// Mechanics shared by every Helm-based engine

/** Each store is one Helm release named like its namespace: store-<id>. */
export function releaseNameFor(store: EngineStoreRef): string {
  return namespaceFor(store.id);
}

/** Storefront, admin, optional *.localhost alias and custom domain URLs for a store. */
export function storeUrls(config: Config, store: EngineStoreRef, adminPath: string, withAlias: boolean): StoreUrls {
  const scheme = config.tls ? 'https' : 'http';
  const host = releaseNameFor(store);
  const storefront = `${scheme}://${host}.${config.baseDomain}`;
  const alias = withAlias ? config.storeAliasDomains[0] : undefined;
  const alternateStorefront = alias ? `${scheme}://${host}.${alias}` : null;
  return {
    storefront,
    admin: `${storefront}${adminPath}`,
    alternateStorefront,
    alternateAdmin: alternateStorefront ? `${alternateStorefront}${adminPath}` : null,
    custom: store.customDomains.map((domain) => `${scheme}://${domain}`),
  };
}

export async function uninstallRelease(store: EngineStoreRef, ctx: EngineContext): Promise<void> {
  await ctx.helm.uninstall(releaseNameFor(store), store.namespace, ctx.config.helmTimeout);
}

/** Pods and jobs that belong to this store's Helm release. */
export function podsForRelease(snapshot: NamespaceSnapshot, release: string): V1Pod[] {
  return snapshot.pods.filter((p) => p.metadata?.labels?.['app.kubernetes.io/instance'] === release);
}

export function toPodHealth(pod: V1Pod): PodHealth {
  const statuses = [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])];
  const waiting = statuses.find((s) => s.state?.waiting?.reason)?.state?.waiting;
  const readyCondition = pod.status?.conditions?.find((c) => c.type === 'Ready');
  return {
    name: pod.metadata?.name ?? 'unknown',
    component: pod.metadata?.labels?.['app.kubernetes.io/component'] ?? 'unknown',
    phase: pod.status?.phase ?? 'Unknown',
    ready: readyCondition?.status === 'True',
    restarts: statuses.reduce((sum, s) => sum + (s.restartCount ?? 0), 0),
    waitingReason: waiting?.reason ?? null,
    message: waiting?.message ?? null,
  };
}

export class EngineRegistry {
  private readonly engines: Map<EngineType, EngineProvider>;

  constructor(config: Config) {
    const providers: EngineProvider[] = [new WooCommerceEngineProvider(config), new MedusaEngineProvider(config)];
    this.engines = new Map(providers.map((p) => [p.type, p]));
  }

  get(type: EngineType): EngineProvider {
    const engine = this.engines.get(type);
    if (!engine) throw new Error(`Unknown engine: ${type}`);
    return engine;
  }

  list(): EngineProvider[] {
    return [...this.engines.values()];
  }
}
