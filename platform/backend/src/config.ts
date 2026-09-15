import os from 'node:os';
import path from 'node:path';

function str(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new Error(`Environment variable ${name} must be a non-negative integer, got "${raw}"`);
  }
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

const chartsDir = str('CHARTS_DIR', path.resolve(process.cwd(), '../../charts'));
const valuesProfile = str('STORE_VALUES_PROFILE', 'local');
if (!['local', 'prod'].includes(valuesProfile)) {
  throw new Error(`STORE_VALUES_PROFILE must be "local" or "prod", got "${valuesProfile}"`);
}

export const config = {
  host: str('HOST', '0.0.0.0'),
  port: int('PORT', 8080),
  logLevel: str('LOG_LEVEL', 'info'),

  /** Namespace and ServiceAccount the orchestrator runs as (used for per-store RoleBindings). */
  platformNamespace: str('POD_NAMESPACE', 'store-platform'),
  serviceAccountName: str('SERVICE_ACCOUNT_NAME', 'store-platform-api'),
  /** ClusterRole granted to the orchestrator inside each store namespace only. */
  tenantClusterRole: str('TENANT_CLUSTER_ROLE', 'store-platform-tenant-manager'),

  storeChartPath: path.join(chartsDir, 'store'),
  storeValuesFile: path.join(chartsDir, 'store', `values-${valuesProfile}.yaml`),
  valuesProfile,
  baseDomain: str('STORE_BASE_DOMAIN', valuesProfile === 'prod' ? 'stores.example.com' : '127.0.0.1.nip.io'),
  tls: bool('STORE_TLS', valuesProfile === 'prod'),
  /** Extra domains every store also answers on, e.g. "localhost" for store-<id>.localhost. */
  storeAliasDomains: str('STORE_ALIAS_DOMAINS', '')
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean),

  maxStores: int('MAX_STORES', 10),
  maxConcurrentProvisions: Math.max(1, int('MAX_CONCURRENT_PROVISIONS', 3)),
  provisionTimeoutSeconds: int('PROVISION_TIMEOUT_SECONDS', 300),
  deleteTimeoutSeconds: int('DELETE_TIMEOUT_SECONDS', 300),
  reconcileIntervalMs: int('RECONCILE_INTERVAL_MS', 5000),
  helmTimeout: str('HELM_TIMEOUT', '5m'),
  helmBinary: str('HELM_BINARY', 'helm'),

  /** "sqlite" (single replica) or "postgres" (shared by many replicas, uses PG* env vars). */
  auditBackend: str('AUDIT_BACKEND', 'sqlite'),
  auditDbPath: str('AUDIT_DB_PATH', path.resolve(process.cwd(), 'audit.db')),
  auditRetention: int('AUDIT_RETENTION', 5000),

  mutationRateLimitPerMinute: int('MUTATION_RATE_LIMIT_PER_MINUTE', 30),

  /** Bearer-token auth; users, roles, quotas and tokens come from a Secret-mounted JSON file. */
  authEnabled: bool('AUTH_ENABLED', false),
  authUsersFile: str('AUTH_USERS_FILE', '/etc/platform-auth/users.json'),

  /** Identity for leader election and logs; the Downward API sets it in the cluster. */
  podName: str('POD_NAME', os.hostname()),
  leaderElection: bool('LEADER_ELECTION', false),
  leaseName: str('LEASE_NAME', 'store-platform-reconciler'),
  leaseSeconds: int('LEASE_SECONDS', 15),

  /** Where customers point custom domains (A record, or CNAME to the hostname). */
  publicIngressAddress: str('PUBLIC_INGRESS_ADDRESS', '127.0.0.1'),
  publicIngressHostname: str('PUBLIC_INGRESS_HOSTNAME', ''),
  maxCustomDomains: int('MAX_CUSTOM_DOMAINS', 3),
  corsOrigin: str('CORS_ORIGIN', ''),
} as const;

export type Config = typeof config;
