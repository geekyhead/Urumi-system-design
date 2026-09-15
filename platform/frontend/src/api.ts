import type { AuditEntry, CatalogPreview, CreateStoreRequest, PlatformInfo, Store, StoreDetail } from './types';

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the orchestrator API');
  }
  const text = await response.text();
  const body: unknown = text ? safeJson(text) : null;
  if (!response.ok) {
    const err = (body ?? {}) as { error?: string; message?: string };
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
  platform: () => request<PlatformInfo>('/api/platform'),
  previewCatalog: (body: Omit<CreateStoreRequest, 'engine' | 'idempotencyKey'>, signal?: AbortSignal) =>
    request<CatalogPreview>('/api/catalogs/preview', { method: 'POST', body: JSON.stringify(body), signal }),
  listStores: () => request<Store[]>('/api/stores'),
  getStore: (id: string) => request<StoreDetail>(`/api/stores/${encodeURIComponent(id)}`),
  createStore: (body: CreateStoreRequest) =>
    request<Store>('/api/stores', { method: 'POST', body: JSON.stringify(body) }),
  deleteStore: (id: string) => request<Store>(`/api/stores/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  listAudit: (limit = 200) => request<AuditEntry[]>(`/api/audit?limit=${limit}`),
};
