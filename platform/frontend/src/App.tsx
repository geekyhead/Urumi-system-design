import { Activity, AlertTriangle, History, Loader2, Plus, ServerCog } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from './api';
import { AuditLogView } from './components/AuditLogView';
import { CreateStoreModal } from './components/CreateStoreModal';
import { MetricsBar } from './components/MetricsBar';
import { StoreList } from './components/StoreList';
import type { MetricsSummary, PlatformInfo, Store } from './types';

const POLL_INTERVAL_MS = 5000;

export default function App() {
  const [stores, setStores] = useState<Store[]>([]);
  const [platform, setPlatform] = useState<PlatformInfo | null>(null);
  const [metrics, setMetrics] = useState<MetricsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Store | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const refresh = useCallback(async () => {
    try {
      const [storeList, info] = await Promise.all([api.listStores(), api.platform()]);
      setStores(storeList);
      setPlatform(info);
      setLoadError(null);
      api.metricsSummary().then(setMetrics, () => undefined);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load stores');
      setPlatform((prev) => (prev ? { ...prev, status: 'degraded' } : prev));
    } finally {
      setLoading(false);
      setNow(Date.now());
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  const closeCreate = useCallback(() => setCreateOpen(false), []);
  const closeAudit = useCallback(() => setAuditOpen(false), []);

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const updated = await api.deleteStore(pendingDelete.id);
      setStores((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      setPendingDelete(null);
      void refresh();
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : 'Failed to delete store');
    } finally {
      setDeleting(false);
    }
  }

  const activeCount = stores.filter((s) => s.status !== 'Deleting').length;
  const readyCount = stores.filter((s) => s.status === 'Ready').length;
  const provisioningCount = stores.filter((s) => s.status === 'Provisioning').length;
  const healthy = platform?.status === 'ok' && !loadError;

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-800 bg-slate-900/60 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-500/15 text-indigo-300">
              <ServerCog className="h-5 w-5" aria-hidden />
            </div>
            <div>
              <h1 className="text-lg font-semibold leading-tight">Store Orchestrator</h1>
              <p className="text-xs text-slate-400">Kubernetes-native store provisioning</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 rounded-md border border-slate-800 px-3 py-1.5 text-sm">
              <span className="text-slate-400">Active stores</span>
              <span className="font-semibold tabular-nums">
                {activeCount}
                <span className="text-slate-500">/{platform?.quota.max ?? '–'}</span>
              </span>
            </div>
            <div
              className="flex items-center gap-2 rounded-md border border-slate-800 px-3 py-1.5 text-sm"
              title={platform?.lastReconcileAt ? `Last reconcile ${platform.lastReconcileAt}` : undefined}
            >
              <span className="relative flex h-2.5 w-2.5">
                {healthy && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />}
                <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${loading ? 'bg-slate-500' : healthy ? 'bg-emerald-400' : 'bg-rose-500'}`} />
              </span>
              <span className="text-slate-300">{loading ? 'Connecting' : healthy ? 'Platform healthy' : 'Platform degraded'}</span>
            </div>
            <button type="button" className="btn-secondary" onClick={() => setAuditOpen(true)}>
              <History className="h-4 w-4" aria-hidden />
              Activity
            </button>
            <button type="button" className="btn-primary" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              Create New Store
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">
        <MetricsBar metrics={metrics} />
        <div className="mb-4 flex flex-wrap items-center gap-4 text-sm text-slate-400">
          <span className="flex items-center gap-1.5">
            <Activity className="h-4 w-4 text-emerald-400" aria-hidden /> {readyCount} ready
          </span>
          <span className="flex items-center gap-1.5">
            <Loader2 className={`h-4 w-4 text-amber-300 ${provisioningCount ? 'animate-spin' : ''}`} aria-hidden /> {provisioningCount} provisioning
          </span>
          <span className="text-slate-600">Auto-refresh every {POLL_INTERVAL_MS / 1000}s</span>
        </div>

        {loadError && (
          <div role="alert" className="mb-4 flex items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
            {loadError}
          </div>
        )}

        <StoreList
          stores={stores}
          loading={loading}
          now={now}
          onCreate={() => setCreateOpen(true)}
          onDelete={(store) => {
            setDeleteError(null);
            setPendingDelete(store);
          }}
        />
      </main>

      <CreateStoreModal
        open={createOpen}
        platform={platform}
        onClose={closeCreate}
        onCreated={(store) => {
          setCreateOpen(false);
          setStores((prev) => [store, ...prev.filter((s) => s.id !== store.id)]);
          void refresh();
        }}
      />

      <AuditLogView open={auditOpen} now={now} onClose={closeAudit} />

      {pendingDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm animate-fade-in" onMouseDown={() => !deleting && setPendingDelete(null)}>
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-title"
            aria-describedby="delete-description"
            className="w-full max-w-md rounded-xl border border-slate-800 bg-slate-900 p-5 shadow-2xl"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h2 id="delete-title" className="text-base font-semibold">
              Delete “{pendingDelete.name}”?
            </h2>
            <p id="delete-description" className="mt-2 text-sm text-slate-400">
              This uninstalls the Helm release and deletes namespace{' '}
              <code className="rounded bg-slate-800 px-1 font-mono text-xs text-slate-200">{pendingDelete.namespace}</code>{' '}
              including its database volume, orders and products. This cannot be undone.
            </p>
            {deleteError && <p className="mt-3 rounded-md bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{deleteError}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className="btn-secondary" onClick={() => setPendingDelete(null)} disabled={deleting} autoFocus>
                Cancel
              </button>
              <button type="button" className="btn-danger" onClick={() => void confirmDelete()} disabled={deleting}>
                {deleting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                Delete Store
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
