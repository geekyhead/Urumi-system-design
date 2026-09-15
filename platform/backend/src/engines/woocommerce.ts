import type { V1Job } from '@kubernetes/client-node';
import type { Config } from '../config.js';
import type { NamespaceSnapshot } from '../services/k8s.js';
import type { SeederJobState, StoreHealth, StoreUrls } from '../types.js';
import {
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
    return releaseNameFor(store);
  }

  urls(store: EngineStoreRef): StoreUrls {
    return storeUrls(this.config, store, '/wp-admin', true);
  }

  async provision(store: EngineStoreRef, ctx: EngineContext): Promise<void> {
    await ctx.helm.upgradeInstall({
      release: releaseNameFor(store),
      namespace: store.namespace,
      chart: ctx.config.storeChartPath,
      valuesFiles: [ctx.config.storeValuesFile],
      values: {
        store: { id: store.id, name: store.name, accentColor: store.accentColor, catalogData: store.catalog },
        global: {
          baseDomain: ctx.config.baseDomain,
          tls: ctx.config.tls,
          aliasDomains: ctx.config.storeAliasDomains,
          customDomains: store.customDomains,
        },
      },
      timeout: ctx.config.helmTimeout,
    });
  }

  deprovision(store: EngineStoreRef, ctx: EngineContext): Promise<void> {
    return uninstallRelease(store, ctx);
  }

  evaluate(store: EngineStoreRef, snapshot: NamespaceSnapshot): EngineEvaluation {
    const release = releaseNameFor(store);
    const podHealth = podsForRelease(snapshot, release).map(toPodHealth);
    // Seeder Jobs are named per Helm revision; the newest one reflects the current release.
    const seederJob = snapshot.jobs
      .filter(
        (j) =>
          j.metadata?.labels?.['app.kubernetes.io/component'] === 'seeder' &&
          j.metadata?.labels?.['app.kubernetes.io/instance'] === release,
      )
      .sort((a, b) => String(b.metadata?.creationTimestamp ?? '').localeCompare(String(a.metadata?.creationTimestamp ?? '')))[0];
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
        return { phase: 'Failed', health, reason: `${pod.component} pod in CrashLoopBackOff after ${pod.restarts} restarts` };
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
