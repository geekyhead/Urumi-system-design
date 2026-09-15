import { CheckCircle2, Clock, Globe, Loader2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, errorText } from '../api';
import { useEscape } from '../hooks';
import type { DomainCheck, PlatformInfo, Store } from '../types';

interface Props {
  store: Store | null;
  platform: PlatformInfo | null;
  onClose: () => void;
  onSaved: (store: Store) => void;
}

const MAX_DOMAINS = 3;

export function DomainsModal({ store, platform, onClose, onSaved }: Props) {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checks, setChecks] = useState<DomainCheck[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!store) return;
    setText(store.customDomains.join('\n'));
    setChecks(null);
    setError(null);
  }, [store]);
  useEscape(Boolean(store), onClose);

  if (!store) return null;

  const domains = [...new Set(text.split(/[\s,]+/).map((d) => d.trim().toLowerCase()).filter(Boolean))];
  const address = platform?.ingress.address ?? '127.0.0.1';
  const hostname = platform?.ingress.hostname;
  const unchanged = domains.join(',') === store.customDomains.join(',');
  const local = address === '127.0.0.1';

  async function save() {
    if (!store) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await api.setDomains(store.id, domains);
      onSaved(updated);
      setChecks(null);
    } catch (err) {
      setError(errorText(err, 'Failed to update domains'));
    } finally {
      setSaving(false);
    }
  }

  async function check() {
    if (!store) return;
    setChecking(true);
    setError(null);
    try {
      setChecks(await api.checkDomains(store.id));
    } catch (err) {
      setError(errorText(err, 'DNS check failed'));
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm animate-fade-in" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="domains-title"
        className="w-full max-w-xl rounded-xl border border-slate-800 bg-slate-900 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
          <h2 id="domains-title" className="flex items-center gap-2 text-base font-semibold">
            <Globe className="h-4 w-4 text-indigo-300" aria-hidden />
            Custom domains · {store.name}
          </h2>
          <button type="button" className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200" onClick={onClose} aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-5 text-sm">
          <div>
            <label htmlFor="domains" className="block font-medium text-slate-300">
              Domains (one per line, up to {MAX_DOMAINS})
            </label>
            <textarea
              id="domains"
              rows={3}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={'shop.example.com\nwww.example.com'}
              className="mt-1.5 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-100 placeholder:text-slate-600 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
            />
            {domains.length > MAX_DOMAINS && <p className="mt-1 text-xs text-rose-300">At most {MAX_DOMAINS} domains.</p>}
          </div>

          <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400">DNS records to create</p>
            <ul className="mt-2 space-y-1 font-mono text-xs text-slate-200">
              {(domains.length ? domains : ['shop.example.com']).map((domain) => (
                <li key={domain}>
                  {hostname ? `CNAME  ${domain}  →  ${hostname}` : `A      ${domain}  →  ${address}`}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-slate-500">
              Saving updates the store Ingress (and requests a certificate when TLS is enabled). The store keeps its platform URL.
            </p>
            {local && (
              <p className="mt-2 text-xs text-amber-200/90">
                Local cluster: add <code className="rounded bg-slate-800 px-1">127.0.0.1 {domains[0] ?? 'shop.example.test'}</code> to{' '}
                <code className="rounded bg-slate-800 px-1">/etc/hosts</code>, then open the domain over http.
              </p>
            )}
          </div>

          {checks && (
            <ul className="space-y-1.5">
              {checks.map((c) => (
                <li key={c.domain} className="flex items-start gap-2 text-xs">
                  {c.ok ? (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" aria-hidden />
                  ) : (
                    <Clock className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden />
                  )}
                  <span>
                    <span className="font-mono text-slate-200">{c.domain}</span>{' '}
                    <span className="text-slate-400">
                      {c.ok
                        ? 'points to the platform'
                        : `not pointing here yet (expected ${c.expected}${c.resolvesTo.length ? `, found ${c.resolvesTo.join(', ')}` : c.error ? `, ${c.error}` : ''})`}
                    </span>
                  </span>
                </li>
              ))}
              {checks.length === 0 && <li className="text-xs text-slate-500">No saved domains to check.</li>}
            </ul>
          )}

          {error && (
            <p role="alert" className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
              {error}
            </p>
          )}
        </div>

        <div className="flex justify-between gap-2 border-t border-slate-800 px-5 py-4">
          <button type="button" className="btn-secondary" onClick={() => void check()} disabled={checking || store.customDomains.length === 0}>
            {checking && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            Check DNS
          </button>
          <div className="flex gap-2">
            <button type="button" className="btn-secondary" onClick={onClose}>
              Close
            </button>
            <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving || unchanged || domains.length > MAX_DOMAINS}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              Save domains
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
