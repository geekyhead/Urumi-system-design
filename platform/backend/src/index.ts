import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { config } from './config.js';
import { EngineRegistry } from './engines/index.js';
import { storeRoutes } from './routes/stores.js';
import { createAuditLog } from './services/audit.js';
import { Authenticator, type AuthUser } from './services/auth.js';
import { HelmClient } from './services/helm.js';
import { KubernetesClient } from './services/k8s.js';
import { LeaderElector } from './services/leader.js';
import { PlatformMetrics } from './services/metrics.js';
import { StoreManager } from './services/storeManager.js';
import { HttpError } from './types.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
  }
}

async function main(): Promise<void> {
  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: true,
    bodyLimit: 16 * 1024,
  });

  const warn = (msg: string) => app.log.warn(msg);
  const audit = createAuditLog(
    { backend: config.auditBackend, sqlitePath: config.auditDbPath, retention: config.auditRetention },
    warn,
  );
  await audit.init();

  const auth = new Authenticator(config.authEnabled, config.authUsersFile, config.maxStores);
  const k8s = new KubernetesClient();
  let metrics: PlatformMetrics | null = null;
  const helm = new HelmClient(config.helmBinary, undefined, (operation, result, seconds) =>
    metrics?.observeHelm(operation, result, seconds),
  );
  const engines = new EngineRegistry(config);
  const stores = new StoreManager(config, k8s, helm, engines, audit, app.log);

  const leader = config.leaderElection
    ? new LeaderElector(config.platformNamespace, config.leaseName, config.podName, config.leaseSeconds, (msg, extra) =>
        app.log.info(extra ?? {}, msg),
      )
    : null;
  if (leader) stores.setLeader(leader);

  metrics = new PlatformMetrics({
    stores: () => stores.lastKnownStores,
    audit,
    maxStores: config.maxStores,
    instance: config.podName,
    isLeader: () => stores.isLeader,
  });
  stores.setMetrics(metrics);
  const platformMetrics = metrics;

  app.log.info(
    {
      instance: config.podName,
      audit: audit.backend,
      auth: auth.enabled ? `${auth.userCount} users` : 'disabled',
      leaderElection: Boolean(leader),
    },
    'orchestrator configuration',
  );

  if (config.corsOrigin) {
    await app.register(cors, { origin: config.corsOrigin.split(',').map((o) => o.trim()) });
  }

  // Authentication runs before the rate limiter so limits are keyed per user.
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    const user = auth.authenticate(request.headers.authorization);
    if (!user) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'A valid API token is required' });
    }
    request.user = user;
  });

  await app.register(rateLimit, {
    global: false,
    keyGenerator: (request) => (request.user ? `user:${request.user.name}` : `ip:${request.ip}`),
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    }
    const err = error as { validation?: unknown; statusCode?: number; message: string };
    if (err.validation) {
      return reply.code(400).send({ error: 'VALIDATION_FAILED', message: err.message });
    }
    if (err.statusCode === 429) {
      return reply.code(429).send({ error: 'RATE_LIMITED', message: err.message });
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send({ error: 'INTERNAL_ERROR', message: 'Internal server error' });
  });

  app.get('/healthz', async () => ({
    status: 'ok',
    instance: config.podName,
    leader: stores.isLeader,
    kubernetesReachable: stores.isKubernetesReachable,
    audit: audit.backend,
  }));

  // Prometheus scrape endpoint. Served on the pod port only: the Ingress routes
  // /api and /healthz, so /metrics is not reachable from outside the cluster.
  app.get('/metrics', { logLevel: 'warn' }, async (_request, reply) => {
    const { contentType, body } = await platformMetrics.render();
    return reply.header('Content-Type', contentType).send(body);
  });

  app.get('/readyz', async (_request, reply) => {
    const reachable = await k8s.ping();
    return reply.code(reachable ? 200 : 503).send({ status: reachable ? 'ready' : 'kubernetes-unreachable' });
  });

  await app.register(storeRoutes, {
    stores,
    audit,
    metrics: platformMetrics,
    mutationRateLimitPerMinute: config.mutationRateLimitPerMinute,
  });

  try {
    app.log.info({ helm: await helm.version() }, 'helm available');
  } catch (err) {
    app.log.error({ err }, 'helm binary not usable; provisioning will fail');
  }

  leader?.start();
  stores.start();
  await app.listen({ host: config.host, port: config.port });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await stores.stop();
    await leader?.stop();
    await audit.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
