import * as k8s from '@kubernetes/client-node';
import { errorMessage } from '../util.js';
import { isApiError } from './k8s.js';

/**
 * Lease times are MicroTime: the API server only parses RFC 3339 with exactly
 * six fractional digits, while Date#toISOString emits three. The client
 * serialises Date values with toISOString, so emit microsecond precision.
 */
class MicroTime extends Date {
  override toISOString(): string {
    return super.toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');
  }
}

function micro(value: Date | string | undefined): MicroTime | undefined {
  return value === undefined ? undefined : new MicroTime(value);
}

/**
 * Kubernetes Lease based leader election. Every API replica serves HTTP
 * traffic, but only the lease holder runs the reconciler, installs and
 * teardowns, so replicas never race on the same store.
 */
export class LeaderElector {
  private readonly api: k8s.CoordinationV1Api;
  private leader = false;
  private holder: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastRenew = 0;

  constructor(
    private readonly namespace: string,
    private readonly leaseName: string,
    readonly identity: string,
    private readonly leaseSeconds: number,
    private readonly log: (msg: string, extra?: Record<string, unknown>) => void,
  ) {
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    this.api = kc.makeApiClient(k8s.CoordinationV1Api);
  }

  get isLeader(): boolean {
    return this.leader;
  }

  get currentHolder(): string | null {
    return this.holder;
  }

  start(): void {
    const tick = () => void this.tick();
    tick();
    this.timer = setInterval(tick, Math.max(1000, Math.floor((this.leaseSeconds * 1000) / 3)));
  }

  /** Gives the lease up on shutdown so another replica takes over immediately. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (!this.leader) return;
    try {
      const lease = await this.read();
      if (lease?.spec?.holderIdentity === this.identity) {
        await this.write({ ...lease, spec: { ...lease.spec, holderIdentity: undefined, renewTime: undefined } }, false);
      }
    } catch (err) {
      this.log('leader: failed to release lease', { err: errorMessage(err) });
    }
    this.setState(false, null);
  }

  private async tick(): Promise<void> {
    const now = new Date();
    try {
      const lease = await this.read();

      if (!lease) {
        await this.write(
          {
            metadata: { name: this.leaseName, namespace: this.namespace },
            spec: {
              holderIdentity: this.identity,
              leaseDurationSeconds: this.leaseSeconds,
              acquireTime: now,
              renewTime: now,
              leaseTransitions: 0,
            },
          },
          true,
        );
        this.lastRenew = Date.now();
        this.setState(true, this.identity);
        return;
      }

      const spec = lease.spec ?? {};
      const renewedAt = spec.renewTime ? new Date(spec.renewTime).getTime() : 0;
      const duration = (spec.leaseDurationSeconds ?? this.leaseSeconds) * 1000;
      const expired = !spec.holderIdentity || Date.now() > renewedAt + duration;

      if (spec.holderIdentity === this.identity || expired) {
        const takeover = spec.holderIdentity !== this.identity;
        const renewed: k8s.V1LeaseSpec = {
          ...spec,
          holderIdentity: this.identity,
          leaseDurationSeconds: this.leaseSeconds,
          renewTime: now,
          ...(takeover ? { acquireTime: now, leaseTransitions: (spec.leaseTransitions ?? 0) + 1 } : {}),
        };
        // replace carries resourceVersion, so two replicas taking over at once conflict (409) and only one wins.
        await this.write({ ...lease, spec: renewed }, false);
        this.lastRenew = Date.now();
        this.setState(true, this.identity);
      } else {
        this.setState(false, spec.holderIdentity ?? null);
      }
    } catch (err) {
      if (isApiError(err, 409)) {
        this.setState(false, this.holder);
        return;
      }
      this.log('leader: lease update failed', { err: errorMessage(err) });
      // Stop acting as leader once our own lease could have expired.
      if (this.leader && Date.now() > this.lastRenew + this.leaseSeconds * 1000) {
        this.setState(false, null);
      }
    }
  }

  private async read(): Promise<k8s.V1Lease | null> {
    try {
      return await this.api.readNamespacedLease({ name: this.leaseName, namespace: this.namespace });
    } catch (err) {
      if (isApiError(err, 404)) return null;
      throw err;
    }
  }

  /** Every lease write goes through here so all MicroTime fields are serialised correctly. */
  private write(lease: k8s.V1Lease, create: boolean): Promise<k8s.V1Lease> {
    const spec = lease.spec ?? {};
    const body: k8s.V1Lease = {
      ...lease,
      spec: { ...spec, acquireTime: micro(spec.acquireTime), renewTime: micro(spec.renewTime) },
    };
    return create
      ? this.api.createNamespacedLease({ namespace: this.namespace, body })
      : this.api.replaceNamespacedLease({ name: this.leaseName, namespace: this.namespace, body });
  }

  private setState(leader: boolean, holder: string | null): void {
    if (leader !== this.leader) {
      this.log(leader ? 'leader: acquired lease' : 'leader: lost lease', { identity: this.identity, holder });
    }
    this.leader = leader;
    this.holder = holder;
  }
}
