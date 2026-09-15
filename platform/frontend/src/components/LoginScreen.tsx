import { KeyRound, Loader2, ServerCog } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { ApiError, api, tokenStore } from '../api';
import type { Me } from '../types';

interface Props {
  onSignedIn: (me: Me) => void;
}

export function LoginScreen({ onSignedIn }: Props) {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = token.trim();
    if (!value) return;
    setBusy(true);
    setError(null);
    tokenStore.set(value);
    try {
      onSignedIn(await api.me());
    } catch (err) {
      tokenStore.clear();
      setError(err instanceof ApiError && err.status === 401 ? 'That token is not valid.' : 'Cannot reach the orchestrator API.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-md rounded-xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-500/15 text-indigo-300">
            <ServerCog className="h-5 w-5" aria-hidden />
          </div>
          <div>
            <h1 className="text-lg font-semibold">Store Orchestrator</h1>
            <p className="text-xs text-slate-400">Sign in with your API token</p>
          </div>
        </div>

        <label htmlFor="token" className="block text-sm font-medium text-slate-300">
          API token
        </label>
        <div className="relative mt-1.5">
          <KeyRound className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-500" aria-hidden />
          <input
            id="token"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={token}
            onChange={(e) => setToken(e.target.value)}
            className="w-full rounded-md border border-slate-700 bg-slate-950 py-2 pl-9 pr-3 font-mono text-sm text-slate-100 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
            placeholder="Paste token"
          />
        </div>
        <p className="mt-1.5 text-xs text-slate-500">
          Get tokens with <code className="rounded bg-slate-800 px-1">make tokens</code>. Each user has their own store quota.
        </p>
        {error && (
          <p role="alert" className="mt-3 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
            {error}
          </p>
        )}
        <button type="submit" className="btn-primary mt-5 w-full" disabled={busy || !token.trim()}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          Sign in
        </button>
      </form>
    </div>
  );
}
