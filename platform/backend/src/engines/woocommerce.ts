import type { V1Job, V1Pod } from '@kubernetes/client-node';
import type { Config } from '../config.js';
import type { NamespaceSnapshot } from '../services/k8s.js';
import type { PodHealth, SeederJobState, StoreHealth, StoreUrls } from '../types.js';
import type { EngineContext, EngineEvaluation, EngineProvider, EngineStoreRef } from './index.js';

/** Waiting reasons that will not resolve on their own. */
const FATAL_WAITING_REASONS = new Set([
  'ImagePullBackOff',
  'ErrImagePull',
  'InvalidImageName',
  'CreateContainerConfigError',
  'CreateContainerError',
]);
const CRASHLOOP_RESTART_THRESHOLD = 3;

export class WooCommerceEngineProvider implements EngineProvider {
  readonly type = 'woocommerce' as const;
  readonly displayName = 'WooCommerce';
  readonly description = 'WordPress 6.4 + WooCommerce + MariaDB, seeded with Cash on Delivery and a demo product.';
  readonly available = true;

  constructor(private readonly config: Config) {}

  releaseName(store: EngineStoreRef): string {
    return `store-${store.id}`;
  }

  urls(store: EngineStoreRef): StoreUrls {
    const scheme = this.config.tls ? 'https' : 'http';
    const storefront = `${scheme}://store-${store.id}.${this.config.baseDomain}`;
    const alias = this.config.storeAliasDomains[0];
    const alternateStorefront = alias ? `${scheme}://store-${store.id}.${alias}` : null;
    return {
      storefront,
      admin: `${storefront}/wp-admin`,
      alternateStorefront,
      alternateAdmin: alternateStorefront ? `${alternateStorefront}/wp-admin` : null,
    };
  }

  async provision(store: EngineStoreRef, ctx: EngineContext): Promise<void> {
    await ctx.helm.upgradeInstall({
      release: this.releaseName(store),
      namespace: store.namespace,
      chart: ctx.config.storeChartPath,
      valuesFiles: [ctx.config.storeValuesFile],
      values: {
        store: { id: store.id, name: store.name, accentColor: store.accentColor, catalogData: store.catalog },
        global: { baseDomain: ctx.config.baseDomain, tls: ctx.config.tls, aliasDomains: ctx.config.storeAliasDomains },
      },
      timeout: ctx.config.helmTimeout,
      // Readiness is tracked by the reconciler, not by blocking on helm.
      wait: false,
    });
  }

  async deprovision(store: EngineStoreRef, ctx: EngineContext): Promise<void> {
    await ctx.helm.uninstall(this.releaseName(store), store.namespace, ctx.config.helmTimeout);
  }

  evaluate(store: EngineStoreRef, snapshot: NamespaceSnapshot): EngineEvaluation {
    const release = this.releaseName(store);
    const pods = snapshot.pods.filter((p) => p.metadata?.labels?.['app.kubernetes.io/instance'] === release);
    const podHealth = pods.map(toPodHealth);
    const seederJob = snapshot.jobs.find((j) => j.metadata?.name === `${release}-seeder`);
    const seeder = jobState(seederJob);
    const health: StoreHealth = {
      helmRelease: snapshot.helmReleasePresent,
      pods: podHealth,
      seederJob: seeder.state,
      seederMessage: seeder.message,
    };

    if (seeder.state === 'Failed') {
      return { phase: 'Failed', health, reason: `Seeder job failed: ${seeder.message ?? 'unknown error'}` };
    }

    for (const pod of podHealth) {
      if (pod.waitingReason && FATAL_WAITING_REASONS.has(pod.waitingReason)) {
        return { phase: 'Failed', health, reason: `${pod.component} pod ${pod.waitingReason}: ${pod.message ?? ''}`.trim() };
      }
      if (pod.waitingReason === 'CrashLoopBackOff' && pod.restarts >= CRASHLOOP_RESTART_THRESHOLD) {
        return {
          phase: 'Failed',
          health,
          reason: `${pod.component} pod in CrashLoopBackOff after ${pod.restarts} restarts`,
        };
      }
    }

    const wordpressReady = podHealth.some((p) => p.component === 'wordpress' && p.ready);
    const mariadbReady = podHealth.some((p) => p.component === 'mariadb' && p.ready);
    if (wordpressReady && mariadbReady && seeder.state === 'Succeeded') {
      return { phase: 'Ready', health };
    }

    const waiting: string[] = [];
    if (!snapshot.helmReleasePresent) waiting.push('helm release');
    if (!mariadbReady) waiting.push('mariadb');
    if (!wordpressReady) waiting.push('wordpress');
    if (seeder.state !== 'Succeeded') waiting.push(`seeder (${seeder.state.toLowerCase()})`);
    return { phase: 'Progressing', health, detail: `waiting for ${waiting.join(', ')}` };
  }
}

function toPodHealth(pod: V1Pod): PodHealth {
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

function jobState(job: V1Job | undefined): { state: SeederJobState; message: string | null } {
  if (!job) return { state: 'Missing', message: null };
  const conditions = job.status?.conditions ?? [];
  const failed = conditions.find((c) => (c.type === 'Failed' || c.type === 'FailureTarget') && c.status === 'True');
  if (failed) return { state: 'Failed', message: failed.message ?? failed.reason ?? null };
  const complete = conditions.find((c) => (c.type === 'Complete' || c.type === 'SuccessCriteriaMet') && c.status === 'True');
  if (complete || (job.status?.succeeded ?? 0) > 0) return { state: 'Succeeded', message: null };
  if ((job.status?.active ?? 0) > 0) return { state: 'Running', message: null };
  return { state: 'Pending', message: null };
}
