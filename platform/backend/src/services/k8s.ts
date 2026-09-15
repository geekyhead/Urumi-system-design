import * as k8s from '@kubernetes/client-node';

export const LABEL_MANAGED = 'platform.io/managed';
export const LABEL_STORE_ID = 'platform.io/store-id';
export const LABEL_ENGINE = 'platform.io/engine';
export const LABEL_OWNER = 'platform.io/owner';
export const ANNOTATION_CUSTOM_DOMAINS = 'platform.io/custom-domains';
export const ANNOTATION_NAME = 'platform.io/store-name';
export const ANNOTATION_STATUS = 'platform.io/status';
export const ANNOTATION_REASON = 'platform.io/reason';
export const ANNOTATION_CREATED_AT = 'platform.io/created-at';
export const ANNOTATION_READY_AT = 'platform.io/ready-at';
export const ANNOTATION_IDEMPOTENCY = 'platform.io/idempotency-key-sha256';
export const ANNOTATION_CATALOG = 'platform.io/catalog';
export const ANNOTATION_CATALOG_SPEC = 'platform.io/catalog-spec';
export const ANNOTATION_ACCENT_COLOR = 'platform.io/accent-color';

export const STORE_NAMESPACE_PREFIX = 'store-';

export function namespaceFor(storeId: string): string {
  return `${STORE_NAMESPACE_PREFIX}${storeId}`;
}

export function isApiError(err: unknown, code: number): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === code
  );
}

export interface NamespaceSnapshot {
  pods: k8s.V1Pod[];
  jobs: k8s.V1Job[];
  helmReleasePresent: boolean;
}

/** Thin wrapper around the Kubernetes API with the calls the orchestrator needs. */
export class KubernetesClient {
  private readonly core: k8s.CoreV1Api;
  private readonly batch: k8s.BatchV1Api;
  private readonly rbac: k8s.RbacAuthorizationV1Api;
  private inflightNamespaceList: Promise<k8s.V1Namespace[]> | null = null;

  constructor(kubeConfig?: k8s.KubeConfig) {
    const kc = kubeConfig ?? new k8s.KubeConfig();
    if (!kubeConfig) kc.loadFromDefault();
    this.core = kc.makeApiClient(k8s.CoreV1Api);
    this.batch = kc.makeApiClient(k8s.BatchV1Api);
    this.rbac = kc.makeApiClient(k8s.RbacAuthorizationV1Api);
  }

  /**
   * Lists store namespaces. Callers that overlap (the dashboard fetches stores
   * and platform info together, the reconciler runs alongside) share one request.
   */
  listStoreNamespaces(): Promise<k8s.V1Namespace[]> {
    this.inflightNamespaceList ??= this.core
      .listNamespace({ labelSelector: `${LABEL_MANAGED}=true` })
      .then((list) => list.items)
      .finally(() => {
        this.inflightNamespaceList = null;
      });
    return this.inflightNamespaceList;
  }

  async getNamespace(name: string): Promise<k8s.V1Namespace | null> {
    try {
      return await this.core.readNamespace({ name });
    } catch (err) {
      if (isApiError(err, 404)) return null;
      throw err;
    }
  }

  async createNamespace(body: k8s.V1Namespace): Promise<k8s.V1Namespace> {
    return this.core.createNamespace({ body });
  }

  /** JSON merge patch of namespace annotations; a null value removes the key. */
  async patchNamespaceAnnotations(name: string, annotations: Record<string, string | null>): Promise<k8s.V1Namespace> {
    return this.core.patchNamespace(
      { name, body: { metadata: { annotations } } },
      k8s.setHeaderOptions('Content-Type', k8s.PatchStrategy.MergePatch),
    );
  }

  async deleteNamespace(name: string): Promise<void> {
    try {
      await this.core.deleteNamespace({ name, propagationPolicy: 'Foreground' });
    } catch (err) {
      if (!isApiError(err, 404)) throw err;
    }
  }

  /**
   * Grants the orchestrator ServiceAccount the tenant ClusterRole inside a single
   * store namespace. The orchestrator holds no cluster-wide rights on workloads.
   */
  async ensureTenantRoleBinding(namespace: string, clusterRole: string, saNamespace: string, saName: string): Promise<void> {
    const name = 'store-platform-orchestrator';
    const body: k8s.V1RoleBinding = {
      metadata: { name, namespace, labels: { [LABEL_MANAGED]: 'true' } },
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: clusterRole },
      subjects: [{ kind: 'ServiceAccount', name: saName, namespace: saNamespace }],
    };
    try {
      await this.rbac.createNamespacedRoleBinding({ namespace, body });
    } catch (err) {
      if (!isApiError(err, 409)) throw err;
    }
  }

  async snapshot(namespace: string, releaseName: string): Promise<NamespaceSnapshot> {
    const [pods, jobs, helmSecrets] = await Promise.all([
      this.core.listNamespacedPod({ namespace }),
      this.batch.listNamespacedJob({ namespace }),
      this.core.listNamespacedSecret({ namespace, labelSelector: `owner=helm,name=${releaseName}` }),
    ]);
    return { pods: pods.items, jobs: jobs.items, helmReleasePresent: helmSecrets.items.length > 0 };
  }

  async ping(): Promise<boolean> {
    try {
      await this.core.listNamespace({ labelSelector: `${LABEL_MANAGED}=true`, limit: 1 });
      return true;
    } catch {
      return false;
    }
  }
}
