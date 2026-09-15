import type {
  AuditEntry,
  CatalogPreview,
  CreateStoreRequest,
  DomainCheck,
  Me,
  MetricsSummary,
  PlatformInfo,
  Store,
} from './types';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** User-facing message for a failed call: the API's message, or a fallback. */
export function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

const TOKEN_KEY = 'store-orchestrator-token';
export const AUTH_REQUIRED_EVENT = 'store-orchestrator:auth-required';

/** API token kept in localStorage; every access is guarded because storage can be unavailable. */
export const tokenStore = {
  get(): string | null {
    try {
      return window.localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set(token: string): void {
    try {
      window.localStorage.setItem(TOKEN_KEY, token);
    } catch {
      // Private mode: the token lives only for this page load.
    }
    memoryToken = token;
  },
  clear(): void {
    try {
      window.localStorage.removeItem(TOKEN_KEY);
    } catch {
      // ignore
    }
    memoryToken = null;
  },
};
let memoryToken: string | null = null;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = tokenStore.get() ?? memoryToken;
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the orchestrator API');
  }
  const text = await response.text();
  const body: unknown = text ? safeJson(text) : null;
  if (!response.ok) {
    const err = (body ?? {}) as { error?: string; message?: string };
    if (response.status === 401) window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
    throw new ApiError(response.status, err.error ?? `HTTP_${response.status}`, err.message ?? response.statusText);
  }
  return body as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

/**
 * Idempotency keys must work on plain-HTTP origins (nip.io), where
 * crypto.randomUUID is unavailable, so build one from getRandomValues.
 */
export function newIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `ui-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export const api = {
  me: () => request<Me>('/api/me'),
  platform: () => request<PlatformInfo>('/api/platform'),
  previewCatalog: (body: Omit<CreateStoreRequest, 'engine' | 'idempotencyKey'>, signal?: AbortSignal) =>
    request<CatalogPreview>('/api/catalogs/preview', { method: 'POST', body: JSON.stringify(body), signal }),
  listStores: () => request<Store[]>('/api/stores'),
  createStore: (body: CreateStoreRequest) =>
    request<Store>('/api/stores', { method: 'POST', body: JSON.stringify(body) }),
  deleteStore: (id: string) => request<Store>(`/api/stores/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  setDomains: (id: string, domains: string[]) =>
    request<Store>(`/api/stores/${encodeURIComponent(id)}/domains`, { method: 'PUT', body: JSON.stringify({ domains }) }),
  checkDomains: (id: string) => request<DomainCheck[]>(`/api/stores/${encodeURIComponent(id)}/domains/check`),
  listAudit: (limit = 200) => request<AuditEntry[]>(`/api/audit?limit=${limit}`),
  metricsSummary: () => request<MetricsSummary>('/api/metrics/summary'),
};
