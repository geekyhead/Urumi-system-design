import { CheckCircle2, CirclePlus, Globe, Loader2, RefreshCw, Repeat, ShieldAlert, Trash2, X, XCircle } from 'lucide-react';
import { useCallback, useEffect, useState, type ComponentType } from 'react';
import { api } from '../api';
import { localTime, relativeTime } from '../format';
import type { AuditEntry } from '../types';

interface Props {
  open: boolean;
  now: number;
  onClose: () => void;
}

const ACTION_STYLE: Record<string, { icon: ComponentType<{ className?: string }>; className: string; label: string }> = {
  STORE_CREATE_REQUESTED: { icon: CirclePlus, className: 'text-indigo-300 bg-indigo-500/10', label: 'Create requested' },
  STORE_CREATE_REPLAYED: { icon: Repeat, className: 'text-slate-300 bg-slate-500/10', label: 'Idempotent replay' },
  STORE_CREATE_REJECTED: { icon: ShieldAlert, className: 'text-amber-300 bg-amber-400/10', label: 'Create rejected' },
  STORE_PROVISIONING_STARTED: { icon: Loader2, className: 'text-amber-300 bg-amber-400/10', label: 'Provisioning' },
  STORE_PROVISIONING_RESUMED: { icon: RefreshCw, className: 'text-amber-300 bg-amber-400/10', label: 'Provisioning resumed' },
  STORE_READY: { icon: CheckCircle2, className: 'text-emerald-300 bg-emerald-400/10', label: 'Ready' },
  STORE_RECOVERED: { icon: CheckCircle2, className: 'text-emerald-300 bg-emerald-400/10', label: 'Recovered' },
  STORE_FAILED: { icon: XCircle, className: 'text-rose-300 bg-rose-500/10', label: 'Failed' },
  STORE_DELETE_REQUESTED: { icon: Trash2, className: 'text-slate-300 bg-slate-500/10', label: 'Delete requested' },
  STORE_DELETED: { icon: Trash2, className: 'text-slate-300 bg-slate-500/10', label: 'Deleted' },
  STORE_DELETE_FAILED: { icon: XCircle, className: 'text-rose-300 bg-rose-500/10', label: 'Delete failed' },
  STORE_DOMAINS_UPDATED: { icon: Globe, className: 'text-indigo-300 bg-indigo-500/10', label: 'Domains updated' },
};

const FALLBACK_STYLE = { icon: CirclePlus, className: 'text-slate-300 bg-slate-500/10', label: 'Event' };

export function AuditLogView({ open, now, onClose }: Props) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setEntries(await api.listAudit(200));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load audit log');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void load();
    const interval = setInterval(() => void load(), 5000);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      clearInterval(interval);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, load, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-slate-950/50 animate-fade-in" onMouseDown={onClose}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="audit-title"
        className="flex h-full w-full max-w-md animate-slide-in flex-col border-l border-slate-800 bg-slate-900 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
          <div>
            <h2 id="audit-title" className="text-base font-semibold">
              Activity
            </h2>
            <p className="text-xs text-slate-500">Audit trail of store lifecycle events</p>
          </div>
          <div className="flex items-center gap-1">
            <button type="button" className="rounded p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200" onClick={() => void load()} aria-label="Refresh">
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button type="button" className="rounded p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200" onClick={onClose} aria-label="Close">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {error && <p className="mb-3 rounded-md bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{error}</p>}
          {entries.length === 0 && !error && (
            <p className="py-10 text-center text-sm text-slate-500">{loading ? 'Loading…' : 'No activity recorded yet.'}</p>
          )}
          <ol className="relative space-y-4 border-l border-slate-800 pl-5">
            {entries.map((entry) => {
              const style = ACTION_STYLE[entry.action] ?? FALLBACK_STYLE;
              const Icon = style.icon;
              return (
                <li key={entry.id} className="relative">
                  <span className={`absolute -left-[31px] flex h-5 w-5 items-center justify-center rounded-full ring-4 ring-slate-900 ${style.className}`}>
                    <Icon className="h-3 w-3" />
                  </span>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className={`text-xs font-semibold uppercase tracking-wide ${style.className.split(' ')[0]}`}>{style.label}</span>
                    <time className="shrink-0 text-xs text-slate-500" dateTime={entry.timestamp} title={localTime(entry.timestamp)}>
                      {relativeTime(entry.timestamp, now)}
                    </time>
                  </div>
                  <p className="mt-0.5 text-sm text-slate-200">{entry.message}</p>
                  <p className="mt-0.5 font-mono text-[11px] text-slate-500">
                    {entry.storeId ? `store ${entry.storeId} · ` : ''}
                    {entry.actor} · {localTime(entry.timestamp)}
                  </p>
                </li>
              );
            })}
          </ol>
        </div>
      </aside>
    </div>
  );
}
