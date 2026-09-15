/** Store ids are lowercase alphanumeric; used by request schemas and the store chart. */
export const STORE_ID_PATTERN = '^[a-z0-9]{3,20}$';

export const ENGINE_TYPES = ['woocommerce', 'medusa'] as const;
export type EngineType = (typeof ENGINE_TYPES)[number];

export type StoreStatus = 'Provisioning' | 'Ready' | 'Failed' | 'Deleting';

export interface StoreUrls {
  storefront: string;
  admin: string;
  /** Same store on an alias domain such as *.localhost, for browsers that block nip.io. */
  alternateStorefront: string | null;
  alternateAdmin: string | null;
  /** Customer domains attached to the store. */
  custom: string[];
}

export interface StoreRecord {
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

export type SeederJobState = 'Pending' | 'Running' | 'Succeeded' | 'Failed' | 'Missing';

export interface PodHealth {
  name: string;
  component: string;
  phase: string;
  ready: boolean;
  restarts: number;
  waitingReason: string | null;
  message: string | null;
}

export interface StoreHealth {
  helmRelease: boolean;
  pods: PodHealth[];
  seederJob: SeederJobState;
  seederMessage: string | null;
}

export interface StoreDetail extends StoreRecord {
  products: Array<{ name: string; category: string; price: string }>;
  health: StoreHealth;
}

export type AuditAction =
  | 'STORE_CREATE_REQUESTED'
  | 'STORE_CREATE_REPLAYED'
  | 'STORE_CREATE_REJECTED'
  | 'STORE_PROVISIONING_STARTED'
  | 'STORE_PROVISIONING_RESUMED'
  | 'STORE_READY'
  | 'STORE_FAILED'
  | 'STORE_RECOVERED'
  | 'STORE_DELETE_REQUESTED'
  | 'STORE_DELETED'
  | 'STORE_DELETE_FAILED'
  | 'STORE_DOMAINS_UPDATED';

export interface AuditEntry {
  id: number;
  timestamp: string;
  action: AuditAction;
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
  user: { name: string; role: 'admin' | 'user'; maxStores: number };
  authEnabled: boolean;
  orchestrator: { instance: string; leader: string | null; leaderElection: boolean; auditBackend: string };
  ingress: { address: string; hostname: string | null };
  engines: Array<{ type: EngineType; displayName: string; available: boolean; description: string }>;
  catalogs: Array<{ type: string; label: string; description: string }>;
  baseDomain: string;
}

export interface StoreOutcomes {
  created: number;
  ready: number;
  failed: number;
  deleted: number;
  rejected: number;
}

export interface MetricsSummary {
  stores: { total: number; byStatus: Record<string, number>; max: number };
  lifetime: StoreOutcomes;
  provisioning: {
    samples: number;
    averageSeconds: number | null;
    p50Seconds: number | null;
    p95Seconds: number | null;
    lastSeconds: number | null;
  };
}

export interface DomainCheck {
  domain: string;
  ok: boolean;
  resolvesTo: string[];
  expected: string;
  error: string | null;
}

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
