import type { Config } from '../config.js';
import type { NamespaceSnapshot } from '../services/k8s.js';
import type { StoreUrls } from '../types.js';
import {
  EngineUnavailableError,
  podsForRelease,
  releaseNameFor,
  storeUrls,
  toPodHealth,
  uninstallRelease,
  type EngineContext,
  type EngineEvaluation,
  type EngineProvider,
  type EngineStoreRef,
} from './index.js';

/**
 * MedusaJS engine interface.
 *
 * Shows how a second, structurally different engine fits the same contract.
 * A Medusa store would be a `charts/store-medusa` release in the same
 * store-<id> namespace (inheriting quota, LimitRange and NetworkPolicy) with:
 *
 *   - medusa-backend  Deployment  (medusajs server, :9000, /health probe)
 *   - medusa-worker   Deployment  (MEDUSA_WORKER_MODE=worker)
 *   - postgres        StatefulSet (1Gi PVC)
 *   - redis           Deployment  (event bus + cache)
 *   - storefront      Deployment  (Next.js starter, :8000)
 *   - seeder          Job         (`medusa db:migrate` + `medusa exec seed.js` + publishable API key)
 *   - Ingress         store-<id>.<domain> -> storefront, store-<id>.<domain>/app -> backend admin
 *
 * Readiness mirrors WooCommerce: backend + storefront Ready and seeder Complete.
 * The engine is registered but reports `available = false`, so the API
 * rejects create requests with 501 before any cluster resource is created.
 */
export class MedusaEngineProvider implements EngineProvider {
  readonly type = 'medusa' as const;
  readonly displayName = 'MedusaJS';
  readonly description = 'Medusa backend + Postgres + Redis + Next.js storefront (interface only, not provisionable yet).';
  readonly available = false;

  constructor(private readonly config: Config) {}

  releaseName(store: EngineStoreRef): string {
    return releaseNameFor(store);
  }

  urls(store: EngineStoreRef): StoreUrls {
    return storeUrls(this.config, store, '/app', false);
  }

  async provision(_store: EngineStoreRef, _ctx: EngineContext): Promise<void> {
    throw new EngineUnavailableError('The MedusaJS engine is not available on this platform yet.');
  }

  /** Nothing is ever installed for Medusa, but uninstall keeps teardown uniform. */
  deprovision(store: EngineStoreRef, ctx: EngineContext): Promise<void> {
    return uninstallRelease(store, ctx);
  }

  evaluate(store: EngineStoreRef, snapshot: NamespaceSnapshot): EngineEvaluation {
    const health = {
      helmRelease: snapshot.helmReleasePresent,
      pods: podsForRelease(snapshot, releaseNameFor(store)).map(toPodHealth),
      seederJob: 'Missing' as const,
      seederMessage: null,
    };
    return { phase: 'Failed', health, reason: 'MedusaJS engine is not available on this platform.' };
  }
}
