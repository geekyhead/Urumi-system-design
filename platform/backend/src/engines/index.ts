import type { Config } from '../config.js';
import type { HelmClient } from '../services/helm.js';
import type { NamespaceSnapshot } from '../services/k8s.js';
import type { ResolvedCatalog } from '../catalogs.js';
import type { EngineType, StoreHealth, StoreUrls } from '../types.js';
import { MedusaEngineProvider } from './medusa.js';
import { WooCommerceEngineProvider } from './woocommerce.js';

export interface EngineStoreRef {
  id: string;
  name: string;
  namespace: string;
  catalog: ResolvedCatalog;
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
  constructor(
    public readonly engine: EngineType,
    message: string,
  ) {
    super(message);
    this.name = 'EngineUnavailableError';
  }
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
