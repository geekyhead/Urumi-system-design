import { Loader2, PackageSearch, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ApiError, api, newIdempotencyKey } from '../api';
import type { CatalogPreview, CustomProduct, EngineType, PlatformInfo, Store } from '../types';

interface Props {
  open: boolean;
  platform: PlatformInfo | null;
  onClose: () => void;
  onCreated: (store: Store) => void;
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.&'-]*$/;
const MAX_CUSTOM_PRODUCTS = 24;

const ENGINE_OPTIONS: Array<{ type: EngineType; label: string; tag: string; description: string }> = [
  {
    type: 'woocommerce',
    label: 'WooCommerce',
    tag: 'Available',
    description: 'WordPress + WooCommerce + MariaDB with a seeded catalog and Cash on Delivery.',
  },
  {
    type: 'medusa',
    label: 'MedusaJS',
    tag: 'Stubbed Demo',
    description: 'Backend + Postgres + Redis + storefront. Engine interface only; not provisionable yet.',
  },
];

const inputClass =
  'mt-1.5 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400';

/** Parses "Name, price[, category]" lines. */
function parseProducts(text: string): { products: CustomProduct[]; errors: string[] } {
  const products: CustomProduct[] = [];
  const errors: string[] = [];
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line, index) => {
      const [name = '', rawPrice = '', category] = line.split(',').map((part) => part.trim());
      const price = Number(rawPrice.replace(/[$€£₹\s]/g, ''));
      if (name.length < 2 || !Number.isFinite(price) || price <= 0) {
        errors.push(`Line ${index + 1}: use "Product name, price[, category]"`);
        return;
      }
      products.push({ name: name.slice(0, 80), price: Math.round(price * 100) / 100, ...(category ? { category: category.slice(0, 40) } : {}) });
    });
  if (products.length > MAX_CUSTOM_PRODUCTS) errors.push(`At most ${MAX_CUSTOM_PRODUCTS} products`);
  return { products, errors };
}

export function CreateStoreModal({ open, platform, onClose, onCreated }: Props) {
  const [name, setName] = useState('');
  const [engine, setEngine] = useState<EngineType>('woocommerce');
  const [catalog, setCatalog] = useState('auto');
  const [sells, setSells] = useState('');
  const [customText, setCustomText] = useState('');
  const [showCustom, setShowCustom] = useState(false);
  const [preview, setPreview] = useState<CatalogPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per modal session: retries and double submits map to one store.
  const idempotencyKey = useRef(newIdempotencyKey());
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setEngine('woocommerce');
    setCatalog('auto');
    setSells('');
    setCustomText('');
    setShowCustom(false);
    setPreview(null);
    setError(null);
    setSubmitting(false);
    idempotencyKey.current = newIdempotencyKey();
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  const custom = useMemo(() => parseProducts(showCustom ? customText : ''), [customText, showCustom]);
  const trimmed = name.trim();

  // Live preview of the catalog the store will be seeded with.
  useEffect(() => {
    if (!open || engine !== 'woocommerce' || custom.errors.length > 0) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setPreviewLoading(true);
      try {
        setPreview(
          await api.previewCatalog(
            { name: trimmed, catalog, sells: sells.trim() || undefined, products: custom.products.length ? custom.products : undefined },
            controller.signal,
          ),
        );
      } catch {
        if (!controller.signal.aborted) setPreview(null);
      } finally {
        if (!controller.signal.aborted) setPreviewLoading(false);
      }
    }, 350);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [open, engine, trimmed, catalog, sells, custom]);

  if (!open) return null;

  const nameError =
    trimmed.length === 0
      ? null
      : trimmed.length < 3
        ? 'At least 3 characters'
        : !NAME_PATTERN.test(trimmed)
          ? 'Letters, numbers, spaces and . _ - & \' only'
          : null;
  const engineAvailable = platform?.engines.find((e) => e.type === engine)?.available ?? engine === 'woocommerce';
  const quotaFull = platform ? platform.quota.used >= platform.quota.max : false;
  const canSubmit =
    trimmed.length >= 3 && !nameError && engineAvailable && !quotaFull && !submitting && custom.errors.length === 0;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const store = await api.createStore({
        name: trimmed,
        engine,
        catalog,
        sells: sells.trim() || undefined,
        products: custom.products.length ? custom.products : undefined,
        idempotencyKey: idempotencyKey.current,
      });
      onCreated(store);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unexpected error creating store');
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm animate-fade-in" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-store-title"
        className="flex max-h-[92vh] w-full max-w-2xl flex-col rounded-xl border border-slate-800 bg-slate-900 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
            <h2 id="create-store-title" className="text-base font-semibold">
              Create New Store
            </h2>
            <button type="button" className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200" onClick={onClose} aria-label="Close">
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
            <div>
              <label htmlFor="store-name" className="block text-sm font-medium text-slate-300">
                Store Name
              </label>
              <input
                id="store-name"
                ref={inputRef}
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={40}
                placeholder="e.g. Josh RC Cars"
                className={inputClass}
                aria-invalid={Boolean(nameError)}
                aria-describedby="store-name-hint"
              />
              <p id="store-name-hint" className={`mt-1 text-xs ${nameError ? 'text-rose-300' : 'text-slate-500'}`}>
                {nameError ?? '3–40 characters.'}
              </p>
            </div>

            <fieldset>
              <legend className="text-sm font-medium text-slate-300">Engine</legend>
              <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
                {ENGINE_OPTIONS.map((option) => {
                  const available = platform?.engines.find((e) => e.type === option.type)?.available ?? option.type === 'woocommerce';
                  const selected = engine === option.type;
                  return (
                    <label
                      key={option.type}
                      className={`flex cursor-pointer gap-3 rounded-lg border p-3 transition ${
                        selected ? 'border-indigo-400 bg-indigo-500/10' : 'border-slate-700 hover:border-slate-600'
                      } ${available ? '' : 'opacity-70'}`}
                    >
                      <input
                        type="radio"
                        name="engine"
                        value={option.type}
                        checked={selected}
                        onChange={() => setEngine(option.type)}
                        className="mt-1 accent-indigo-400"
                      />
                      <span className="flex-1">
                        <span className="flex items-center gap-2 text-sm font-medium text-slate-100">
                          {option.label}
                          <span
                            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                              available ? 'bg-emerald-400/10 text-emerald-300' : 'bg-slate-700 text-slate-300'
                            }`}
                          >
                            {option.tag}
                          </span>
                        </span>
                        <span className="mt-0.5 block text-xs text-slate-400">{option.description}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
              {!engineAvailable && (
                <p className="mt-2 text-xs text-amber-300">
                  MedusaJS is wired into the orchestrator as an engine interface but cannot be provisioned yet.
                </p>
              )}
            </fieldset>

            {engine === 'woocommerce' && (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label htmlFor="store-sells" className="block text-sm font-medium text-slate-300">
                      What will this store sell?
                    </label>
                    <input
                      id="store-sells"
                      value={sells}
                      onChange={(e) => setSells(e.target.value)}
                      maxLength={200}
                      placeholder="e.g. RC cars, drones and batteries"
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label htmlFor="store-catalog" className="block text-sm font-medium text-slate-300">
                      Store type
                    </label>
                    <select id="store-catalog" value={catalog} onChange={(e) => setCatalog(e.target.value)} className={inputClass}>
                      <option value="auto">Auto-detect from name and products</option>
                      {(platform?.catalogs ?? []).map((option) => (
                        <option key={option.type} value={option.type}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="flex items-center gap-2 text-sm text-slate-300">
                    <input type="checkbox" checked={showCustom} onChange={(e) => setShowCustom(e.target.checked)} className="accent-indigo-400" />
                    Use my own product list
                  </label>
                  {showCustom && (
                    <div className="mt-2">
                      <textarea
                        value={customText}
                        onChange={(e) => setCustomText(e.target.value)}
                        rows={5}
                        placeholder={'Storm Racer 1:10 RC Buggy, 189, RC Cars\nFPV Racing Drone, 249, Drones\n5200mAh LiPo Battery, 39, Batteries'}
                        className={`${inputClass} font-mono text-xs`}
                      />
                      <p className={`mt-1 text-xs ${custom.errors.length ? 'text-rose-300' : 'text-slate-500'}`}>
                        {custom.errors[0] ?? `One product per line: name, price, category (optional). ${custom.products.length} parsed.`}
                      </p>
                    </div>
                  )}
                </div>

                <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
                  <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-slate-400">
                    <PackageSearch className="h-4 w-4" aria-hidden />
                    Store will be seeded with
                    {previewLoading && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
                  </div>
                  {preview ? (
                    <>
                      <p className="mt-1.5 text-sm text-slate-200">
                        <span className="font-semibold">{preview.label}</span>
                        <span className="text-slate-500"> — {preview.tagline}</span>
                      </p>
                      <ul className="mt-2 grid gap-x-4 gap-y-1 text-xs text-slate-300 sm:grid-cols-2">
                        {preview.products.slice(0, 8).map((product) => (
                          <li key={product.name} className="flex justify-between gap-2">
                            <span className="truncate">{product.name}</span>
                            <span className="shrink-0 tabular-nums text-slate-500">${product.price}</span>
                          </li>
                        ))}
                      </ul>
                      {preview.products.length > 8 && <p className="mt-1 text-xs text-slate-500">+{preview.products.length - 8} more</p>}
                    </>
                  ) : (
                    <p className="mt-1.5 text-xs text-slate-500">Type a store name or what it sells to see the catalog.</p>
                  )}
                </div>
              </>
            )}

            {quotaFull && (
              <p className="rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
                Store limit reached ({platform?.quota.max}). Delete a store before creating another.
              </p>
            )}
            {error && (
              <p role="alert" className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
                {error}
              </p>
            )}
          </div>

          <div className="flex justify-end gap-2 border-t border-slate-800 px-5 py-4">
            <button type="button" className="btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={!canSubmit}>
              {submitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              {submitting ? 'Creating…' : 'Create Store'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
