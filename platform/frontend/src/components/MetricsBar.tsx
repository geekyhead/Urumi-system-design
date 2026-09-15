import { AlertTriangle, CheckCircle2, Clock, PackagePlus, Trash2 } from 'lucide-react';
import type { ComponentType } from 'react';
import type { MetricsSummary } from '../types';

interface Props {
  metrics: MetricsSummary | null;
}

function formatSeconds(value: number | null): string {
  if (value === null) return '—';
  const minutes = Math.floor(value / 60);
  const seconds = value % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function Stat({
  icon: Icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: string;
  hint: string;
  tone: string;
}) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 px-4 py-3">
      <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-slate-400">
        <Icon className={`h-4 w-4 ${tone}`} />
        {label}
      </div>
      <div className="mt-1 text-xl font-semibold tabular-nums text-slate-100">{value}</div>
      <div className="text-xs text-slate-500">{hint}</div>
    </div>
  );
}

/** Lifetime platform numbers from /api/metrics/summary (backed by the audit log). */
export function MetricsBar({ metrics }: Props) {
  const lifetime = metrics?.lifetime;
  const provisioning = metrics?.provisioning;
  const finished = (lifetime?.ready ?? 0) + (lifetime?.failed ?? 0);
  const successRate = finished > 0 ? Math.round(((lifetime?.ready ?? 0) / finished) * 100) : null;

  return (
    <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      <Stat
        icon={PackagePlus}
        label="Stores created"
        value={String(lifetime?.created ?? '—')}
        hint={`${lifetime?.rejected ?? 0} ${lifetime?.rejected === 1 ? 'request' : 'requests'} rejected`}
        tone="text-indigo-300"
      />
      <Stat
        icon={CheckCircle2}
        label="Success rate"
        value={successRate === null ? '—' : `${successRate}%`}
        hint={`${lifetime?.ready ?? 0} of ${finished} finished stores ready`}
        tone="text-emerald-400"
      />
      <Stat
        icon={AlertTriangle}
        label="Failures"
        value={String(lifetime?.failed ?? '—')}
        hint="stores that never became ready"
        tone="text-rose-400"
      />
      <Stat
        icon={Clock}
        label="Provisioning time"
        value={formatSeconds(provisioning?.averageSeconds ?? null)}
        hint={`p95 ${formatSeconds(provisioning?.p95Seconds ?? null)} · ${provisioning?.samples ?? 0} samples`}
        tone="text-amber-300"
      />
      <Stat
        icon={Trash2}
        label="Deleted"
        value={String(lifetime?.deleted ?? '—')}
        hint="namespaces removed"
        tone="text-slate-400"
      />
    </div>
  );
}
