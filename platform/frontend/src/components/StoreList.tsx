import { ExternalLink, Globe, Settings2, Store as StoreIcon, Trash2 } from 'lucide-react';
import { localTime, relativeTime } from '../format';
import type { EngineType, Store } from '../types';
import { StatusBadge } from './StatusBadge';

interface Props {
  stores: Store[];
  loading: boolean;
  now: number;
  onDelete: (store: Store) => void;
  onCreate: () => void;
  onDomains: (store: Store) => void;
  showOwner: boolean;
}

const ENGINE_BADGE: Record<EngineType, { label: string; className: string }> = {
  woocommerce: { label: 'WooCommerce', className: 'bg-violet-500/10 text-violet-300 ring-violet-500/30' },
  medusa: { label: 'MedusaJS', className: 'bg-sky-500/10 text-sky-300 ring-sky-500/30' },
};

export function StoreList({ stores, loading, now, onDelete, onCreate, onDomains, showOwner }: Props) {
  if (loading && stores.length === 0) {
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-12 text-center text-sm text-slate-400">
        Loading stores…
      </div>
    );
  }

  if (stores.length === 0) {
    return (
      <div className="flex flex-col items-center rounded-xl border border-dashed border-slate-700 bg-slate-900/40 px-6 py-16 text-center">
        <StoreIcon className="mb-3 h-10 w-10 text-slate-600" aria-hidden />
        <h2 className="text-base font-semibold text-slate-200">No stores yet</h2>
        <p className="mt-1 max-w-sm text-sm text-slate-400">
          Each store gets its own namespace, database, quota and network policy. Provisioning takes about two minutes.
        </p>
        <button type="button" className="btn-primary mt-5" onClick={onCreate}>
          Create your first store
        </button>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/40">
      <table className="min-w-full divide-y divide-slate-800 text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
            <th scope="col" className="px-4 py-3 font-medium">Store</th>
            <th scope="col" className="px-4 py-3 font-medium">Engine</th>
            <th scope="col" className="px-4 py-3 font-medium">Status</th>
            <th scope="col" className="px-4 py-3 font-medium">Created</th>
            <th scope="col" className="px-4 py-3 text-right font-medium">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/70">
          {stores.map((store) => {
            const engine = ENGINE_BADGE[store.engine];
            const ready = store.status === 'Ready';
            const deleting = store.status === 'Deleting';
            return (
              <tr key={store.id} className="align-middle hover:bg-slate-800/30">
                <td className="px-4 py-3">
                  <div className="font-medium text-slate-100">{store.name}</div>
                  <div className="mt-0.5 font-mono text-xs text-slate-500">
                    {store.id} · {store.namespace}
                  </div>
                  {showOwner && (
                    <div className="mt-0.5 text-xs text-slate-500">owner: {store.owner ?? 'unassigned (created before sign-in)'}</div>
                  )}
                  {ready && (
                    <a
                      href={store.urls.storefront}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-0.5 block truncate font-mono text-xs text-indigo-300 hover:underline"
                    >
                      {store.urls.storefront.replace(/^https?:\/\//, '')}
                    </a>
                  )}
                  {ready && store.urls.alternateStorefront && (
                    <a
                      href={store.urls.alternateStorefront}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-0.5 block truncate font-mono text-xs text-slate-400 hover:text-indigo-300 hover:underline"
                      title="Same store on localhost, for browsers that block nip.io"
                    >
                      {store.urls.alternateStorefront.replace(/^https?:\/\//, '')}
                    </a>
                  )}
                  {store.urls.custom.map((url) => (
                    <a
                      key={url}
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-0.5 flex items-center gap-1 truncate font-mono text-xs text-emerald-300 hover:underline"
                    >
                      <Globe className="h-3 w-3 shrink-0" aria-hidden />
                      {url.replace(/^https?:\/\//, '')}
                    </a>
                  ))}
                </td>
                <td className="px-4 py-3">
                  <span className={`rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${engine.className}`}>
                    {engine.label}
                  </span>
                  <div className="mt-1.5 flex items-center gap-1.5 text-xs capitalize text-slate-400">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: store.accentColor }} aria-hidden />
                    <span className="normal-case">
                      {store.catalogLabel} · {store.productCount} products
                    </span>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={store.status} reason={store.reason} />
                </td>
                <td className="whitespace-nowrap px-4 py-3">
                  <div className="text-slate-200" title={store.createdAt}>
                    {relativeTime(store.createdAt, now)}
                  </div>
                  <div className="text-xs text-slate-500">{localTime(store.createdAt)}</div>
                </td>
                <td className="px-4 py-3">
                  <div className="flex justify-end gap-2">
                    <a
                      className={`btn-secondary ${ready ? '' : 'pointer-events-none opacity-40'}`}
                      href={store.urls.storefront}
                      target="_blank"
                      rel="noreferrer"
                      aria-disabled={!ready}
                      tabIndex={ready ? 0 : -1}
                    >
                      <ExternalLink className="h-4 w-4" aria-hidden />
                      Open Store
                    </a>
                    <a
                      className={`btn-secondary ${ready ? '' : 'pointer-events-none opacity-40'}`}
                      href={store.urls.admin}
                      target="_blank"
                      rel="noreferrer"
                      aria-disabled={!ready}
                      tabIndex={ready ? 0 : -1}
                    >
                      <Settings2 className="h-4 w-4" aria-hidden />
                      Admin
                    </a>
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => onDomains(store)}
                      disabled={!ready}
                      aria-label={`Custom domains for ${store.name}`}
                    >
                      <Globe className="h-4 w-4" aria-hidden />
                      Domains
                    </button>
                    <button
                      type="button"
                      className="btn-ghost-danger"
                      onClick={() => onDelete(store)}
                      disabled={deleting}
                      aria-label={`Delete store ${store.name}`}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                      Delete Store
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
