import { AlertTriangle, CheckCircle2, Loader2, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { StoreStatus } from '../types';

interface Props {
  status: StoreStatus;
  reason?: string | null;
}

const STYLES: Record<StoreStatus, string> = {
  Provisioning: 'bg-amber-400/10 text-amber-300 ring-amber-400/30',
  Ready: 'bg-emerald-400/10 text-emerald-300 ring-emerald-400/30',
  Failed: 'bg-rose-500/10 text-rose-300 ring-rose-500/30',
  Deleting: 'bg-slate-400/10 text-slate-300 ring-slate-400/30',
};

export function StatusBadge({ status, reason }: Props) {
  const [open, setOpen] = useState(false);
  const badge = (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${STYLES[status]}`}
    >
      {status === 'Provisioning' && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
      {status === 'Ready' && <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />}
      {status === 'Failed' && <AlertTriangle className="h-3.5 w-3.5" aria-hidden />}
      {status === 'Deleting' && <Trash2 className="h-3.5 w-3.5 animate-pulse" aria-hidden />}
      {status}
    </span>
  );

  if (status !== 'Failed' || !reason) return badge;

  return (
    <span
      className="relative inline-block"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <button type="button" className="cursor-help rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400" aria-describedby="failure-reason" onClick={() => setOpen((v) => !v)}>
        {badge}
      </button>
      {open && (
        <span
          id="failure-reason"
          role="tooltip"
          className="absolute left-0 top-full z-20 mt-2 w-80 animate-fade-in rounded-md border border-rose-500/30 bg-slate-900 p-3 text-xs leading-relaxed text-rose-100 shadow-xl"
        >
          <span className="mb-1 block font-semibold text-rose-300">Failure reason</span>
          <span className="block break-words font-mono">{reason}</span>
        </span>
      )}
    </span>
  );
}
