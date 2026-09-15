import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { MetricsSummary, StoreRecord } from '../types.js';
import type { AuditLog } from './audit.js';

export interface MetricsSources {
  /** Stores seen by the last reconcile pass, or null before the first pass. */
  stores: () => StoreRecord[] | null;
  audit: AuditLog;
  maxStores: number;
  instance: string;
  isLeader: () => boolean;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? null;
}

/**
 * Prometheus metrics for the platform. Lifetime counters are derived from the
 * persistent audit log and store gauges from the reconciler, so the numbers
 * survive API restarts and agree across replicas sharing one audit database.
 */
export class PlatformMetrics {
  readonly registry = new Registry();
  private readonly helmDuration: Histogram<'operation' | 'result'>;
  private readonly provisioningDuration: Histogram<'engine' | 'outcome'>;

  constructor(private readonly sources: MetricsSources) {
    collectDefaultMetrics({ register: this.registry, prefix: 'store_platform_process_' });
    this.registry.setDefaultLabels({ instance_pod: sources.instance });

    new Gauge({
      name: 'store_platform_stores',
      help: 'Stores currently known to the platform, by status and engine.',
      labelNames: ['status', 'engine'] as const,
      registers: [this.registry],
      collect() {
        this.reset();
        for (const store of sources.stores() ?? []) {
          this.inc({ status: store.status, engine: store.engine });
        }
      },
    });

    new Gauge({
      name: 'store_platform_stores_max',
      help: 'Maximum number of active stores allowed.',
      registers: [this.registry],
      collect() {
        this.set(sources.maxStores);
      },
    });

    new Gauge({
      name: 'store_platform_orchestrator_leader',
      help: '1 when this API replica holds the reconciler lease.',
      registers: [this.registry],
      collect() {
        this.set(sources.isLeader() ? 1 : 0);
      },
    });

    new Counter({
      name: 'store_platform_lifecycle_events_total',
      help: 'Store lifecycle events recorded in the audit log, by action.',
      labelNames: ['action'] as const,
      registers: [this.registry],
      async collect() {
        this.reset();
        for (const [action, count] of Object.entries(await sources.audit.countByAction())) {
          this.inc({ action }, count);
        }
      },
    });

    new Gauge({
      name: 'store_platform_store_outcomes',
      help: 'Lifetime number of distinct stores per outcome (each store counted once).',
      labelNames: ['outcome'] as const,
      registers: [this.registry],
      async collect() {
        this.reset();
        const outcomes = await sources.audit.storeOutcomes();
        for (const outcome of ['created', 'ready', 'failed', 'deleted'] as const) {
          this.set({ outcome }, outcomes[outcome]);
        }
      },
    });

    this.helmDuration = new Histogram({
      name: 'store_platform_helm_operation_duration_seconds',
      help: 'Duration of helm commands run by the orchestrator.',
      labelNames: ['operation', 'result'] as const,
      buckets: [0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300],
      registers: [this.registry],
    });

    this.provisioningDuration = new Histogram({
      name: 'store_platform_provisioning_duration_seconds',
      help: 'Time from store creation to Ready or Failed, observed by the leader replica.',
      labelNames: ['engine', 'outcome'] as const,
      buckets: [30, 60, 90, 120, 150, 180, 240, 300, 600],
      registers: [this.registry],
    });
  }

  observeHelm(operation: string, result: 'success' | 'error', seconds: number): void {
    this.helmDuration.observe({ operation, result }, seconds);
  }

  observeProvisioning(engine: string, outcome: 'ready' | 'failed', seconds: number): void {
    this.provisioningDuration.observe({ engine, outcome }, seconds);
  }

  async render(): Promise<{ contentType: string; body: string }> {
    return { contentType: this.registry.contentType, body: await this.registry.metrics() };
  }

  async summary(): Promise<MetricsSummary> {
    const stores = this.sources.stores() ?? [];
    const byStatus: Record<string, number> = { Provisioning: 0, Ready: 0, Failed: 0, Deleting: 0 };
    for (const store of stores) byStatus[store.status] = (byStatus[store.status] ?? 0) + 1;

    const [lifetime, durations] = await Promise.all([
      this.sources.audit.storeOutcomes(),
      this.sources.audit.recentProvisioningDurations(200),
    ]);
    const sorted = [...durations].sort((a, b) => a - b);
    const average = durations.length ? Math.round(durations.reduce((sum, d) => sum + d, 0) / durations.length) : null;

    return {
      stores: { total: stores.length, byStatus, max: this.sources.maxStores },
      lifetime,
      provisioning: {
        samples: durations.length,
        averageSeconds: average,
        p50Seconds: percentile(sorted, 50),
        p95Seconds: percentile(sorted, 95),
        lastSeconds: durations[0] ?? null,
      },
    };
  }
}
