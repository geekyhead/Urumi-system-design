import type { Config } from '../config.js';
import type { NamespaceSnapshot } from '../services/k8s.js';
import type { StoreUrls } from '../types.js';
import {
  EngineUnavailableError,
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

  static readonly components = ['medusa-backend', 'medusa-worker', 'postgres', 'redis', 'storefront'] as const;

  constructor(private readonly config: Config) {}

  releaseName(store: EngineStoreRef): string {
    return `store-${store.id}`;
  }

  urls(store: EngineStoreRef): StoreUrls {
    const scheme = this.config.tls ? 'https' : 'http';
    const storefront = `${scheme}://store-${store.id}.${this.config.baseDomain}`;
    return { storefront, admin: `${storefront}/app`, alternateStorefront: null, alternateAdmin: null };
  }

  async provision(_store: EngineStoreRef, _ctx: EngineContext): Promise<void> {
    throw new EngineUnavailableError(this.type, 'The MedusaJS engine is not available on this platform yet.');
  }

  async deprovision(store: EngineStoreRef, ctx: EngineContext): Promise<void> {
    // Nothing is ever installed for Medusa, but uninstall is safe and keeps
    // teardown uniform if a release was created manually.
    await ctx.helm.uninstall(this.releaseName(store), store.namespace, ctx.config.helmTimeout);
  }

  evaluate(store: EngineStoreRef, snapshot: NamespaceSnapshot): EngineEvaluation {
    const release = this.releaseName(store);
    const pods = snapshot.pods.filter((p) => p.metadata?.labels?.['app.kubernetes.io/instance'] === release);
    const health = {
      helmRelease: snapshot.helmReleasePresent,
      pods: pods.map((p) => ({
        name: p.metadata?.name ?? 'unknown',
        component: p.metadata?.labels?.['app.kubernetes.io/component'] ?? 'unknown',
        phase: p.status?.phase ?? 'Unknown',
        ready: p.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True') ?? false,
        restarts: (p.status?.containerStatuses ?? []).reduce((n, s) => n + s.restartCount, 0),
        waitingReason: null,
        message: null,
      })),
      seederJob: 'Missing' as const,
      seederMessage: null,
    };
    return { phase: 'Failed', health, reason: 'MedusaJS engine is not available on this platform.' };
  }
}
