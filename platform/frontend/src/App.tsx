import { Activity, AlertTriangle, History, Loader2, LogOut, Plus, ServerCog, UserRound } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { AUTH_REQUIRED_EVENT, ApiError, api, errorText, tokenStore } from './api';
import { AuditLogView } from './components/AuditLogView';
import { CreateStoreModal } from './components/CreateStoreModal';
import { DomainsModal } from './components/DomainsModal';
import { LoginScreen } from './components/LoginScreen';
import { MetricsBar } from './components/MetricsBar';
import { StoreList } from './components/StoreList';
import { usePolling } from './hooks';
import type { Me, MetricsSummary, PlatformInfo, Store } from './types';

const POLL_INTERVAL_MS = 5000;

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [stores, setStores] = useState<Store[]>([]);
  const [platform, setPlatform] = useState<PlatformInfo | null>(null);
  const [metrics, setMetrics] = useState<MetricsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [domainsStore, setDomainsStore] = useState<Store | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Store | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  // Session: validate the stored token once, and drop back to sign-in on any 401.
  useEffect(() => {
    api
      .me()
      .then(setMe, () => setMe(null))
      .finally(() => setAuthChecked(true));
    const onAuthRequired = () => setMe(null);
    window.addEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [storeList, info] = await Promise.all([api.listStores(), api.platform()]);
      setStores(storeList);
      setPlatform(info);
      setLoadError(null);
      api.metricsSummary().then(setMetrics, () => undefined);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      setLoadError(errorText(err, 'Failed to load stores'));
      setPlatform((prev) => (prev ? { ...prev, status: 'degraded' } : prev));
    } finally {
      setLoading(false);
      setNow(Date.now());
    }
  }, []);

  usePolling(refresh, POLL_INTERVAL_MS, Boolean(me));

  const closeCreate = useCallback(() => setCreateOpen(false), []);
  const closeAudit = useCallback(() => setAuditOpen(false), []);
  const closeDomains = useCallback(() => setDomainsStore(null), []);

  function signOut() {
    tokenStore.clear();
    setMe(null);
    setStores([]);
    setPlatform(null);
    setMetrics(null);
  }

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
      setDeleteError(errorText(err, 'Failed to delete store'));
    } finally {
      setDeleting(false);
    }
  }

  if (!authChecked) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-slate-400">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> Connecting…
      </div>
    );
  }

  if (!me) {
    return (
      <LoginScreen
        onSignedIn={(signedIn) => {
          setLoading(true);
          setMe(signedIn);
        }}
      />
    );
  }

  const isAdmin = me.user.role === 'admin';
  const activeCount = stores.filter((s) => s.status !== 'Deleting').length;
  const readyCount = stores.filter((s) => s.status === 'Ready').length;
  const provisioningCount = stores.filter((s) => s.status === 'Provisioning').length;
  const healthy = platform?.status === 'ok' && !loadError;
  const quota = isAdmin ? platform?.quota : platform?.userQuota;

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
              <span className="text-slate-400">{isAdmin ? 'Active stores' : 'Your stores'}</span>
              <span className="font-semibold tabular-nums">
                {isAdmin ? activeCount : (quota?.used ?? 0)}
                <span className="text-slate-500">/{quota?.max ?? '–'}</span>
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
            <div className="flex items-center gap-2 rounded-md border border-slate-800 py-1 pl-3 pr-1 text-sm">
              <UserRound className="h-4 w-4 text-slate-400" aria-hidden />
              <span className="text-slate-200">{me.user.name}</span>
              <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">{me.user.role}</span>
              {platform?.authEnabled !== false && (
                <button type="button" className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200" onClick={signOut} aria-label="Sign out" title="Sign out">
                  <LogOut className="h-4 w-4" />
                </button>
              )}
            </div>
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
          {platform && (
            <span className="ml-auto font-mono text-xs text-slate-600" title="API replica that served this page, and the replica holding the reconciler lease">
              served by {platform.orchestrator.instance} · leader {platform.orchestrator.leader ?? 'electing…'} · audit {platform.orchestrator.auditBackend}
            </span>
          )}
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
          showOwner={isAdmin}
          onCreate={() => setCreateOpen(true)}
          onDomains={(store) => setDomainsStore(store)}
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

      <DomainsModal
        store={domainsStore}
        platform={platform}
        onClose={closeDomains}
        onSaved={(updated) => {
          setDomainsStore(updated);
          setStores((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
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
