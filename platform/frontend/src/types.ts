export type EngineType = 'woocommerce' | 'medusa';

export type StoreStatus = 'Provisioning' | 'Ready' | 'Failed' | 'Deleting';

export interface StoreUrls {
  storefront: string;
  admin: string;
  alternateStorefront: string | null;
  alternateAdmin: string | null;
  custom: string[];
}

export interface AuthUser {
  name: string;
  role: 'admin' | 'user';
  maxStores: number;
}

export interface Me {
  user: AuthUser;
}

export interface DomainCheck {
  domain: string;
  ok: boolean;
  resolvesTo: string[];
  expected: string;
  error: string | null;
}

export interface Store {
  id: string;
  name: string;
  engine: EngineType;
  owner: string | null;
  customDomains: string[];
  catalog: string;
  catalogLabel: string;
  productCount: number;
  accentColor: string;
  namespace: string;
  status: StoreStatus;
  reason: string | null;
  createdAt: string;
  readyAt: string | null;
  urls: StoreUrls;
}

export interface AuditEntry {
  id: number;
  timestamp: string;
  action: string;
  storeId: string | null;
  actor: string;
  message: string;
  details: Record<string, unknown>;
}

export interface PlatformInfo {
  status: 'ok' | 'degraded';
  kubernetesReachable: boolean;
  lastReconcileAt: string | null;
  quota: { used: number; max: number };
  userQuota: { used: number; max: number };
  user: AuthUser;
  authEnabled: boolean;
  orchestrator: { instance: string; leader: string | null; leaderElection: boolean; auditBackend: string };
  ingress: { address: string; hostname: string | null };
  engines: Array<{ type: EngineType; displayName: string; available: boolean; description: string }>;
  catalogs: Array<{ type: string; label: string; description: string }>;
  baseDomain: string;
}

export interface MetricsSummary {
  stores: { total: number; byStatus: Record<string, number>; max: number };
  lifetime: { created: number; ready: number; failed: number; deleted: number; rejected: number };
  provisioning: {
    samples: number;
    averageSeconds: number | null;
    p50Seconds: number | null;
    p95Seconds: number | null;
    lastSeconds: number | null;
  };
}

export interface CustomProduct {
  name: string;
  price: number;
  category?: string;
}

export interface CatalogPreview {
  type: string;
  label: string;
  tagline: string;
  hero: string;
  products: Array<{ name: string; category: string; price: string }>;
}

export interface CreateStoreRequest {
  name: string;
  engine: EngineType;
  catalog: string;
  sells?: string;
  products?: CustomProduct[];
  idempotencyKey: string;
}
