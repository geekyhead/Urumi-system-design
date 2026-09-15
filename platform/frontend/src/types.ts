export type EngineType = 'woocommerce' | 'medusa';

export type StoreStatus = 'Provisioning' | 'Ready' | 'Failed' | 'Deleting';

export interface StoreUrls {
  storefront: string;
  admin: string;
  alternateStorefront: string | null;
  alternateAdmin: string | null;
}

export interface Store {
  id: string;
  name: string;
  engine: EngineType;
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

export interface PodHealth {
  name: string;
  component: string;
  phase: string;
  ready: boolean;
  restarts: number;
  waitingReason: string | null;
  message: string | null;
}

export interface StoreDetail extends Store {
  health: {
    helmRelease: boolean;
    pods: PodHealth[];
    seederJob: 'Pending' | 'Running' | 'Succeeded' | 'Failed' | 'Missing';
    seederMessage: string | null;
  };
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
  engines: Array<{ type: EngineType; displayName: string; available: boolean; description: string }>;
  catalogs: Array<{ type: string; label: string; description: string }>;
  baseDomain: string;
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
