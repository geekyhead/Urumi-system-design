import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { config } from './config.js';
import { EngineRegistry } from './engines/index.js';
import { storeRoutes } from './routes/stores.js';
import { AuditLog } from './services/audit.js';
import { HelmClient } from './services/helm.js';
import { KubernetesClient } from './services/k8s.js';
import { StoreManager } from './services/storeManager.js';
import { HttpError } from './types.js';

async function main(): Promise<void> {
  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: true,
    bodyLimit: 16 * 1024,
  });

  const audit = new AuditLog(config.auditDbPath, config.auditRetention, (msg) => app.log.warn(msg));
  const k8s = new KubernetesClient();
  const helm = new HelmClient(config.helmBinary);
  const engines = new EngineRegistry(config);
  const stores = new StoreManager(config, k8s, helm, engines, audit, app.log);

  if (config.corsOrigin) {
    await app.register(cors, { origin: config.corsOrigin.split(',').map((o) => o.trim()) });
  }
  await app.register(rateLimit, { global: false });

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
    kubernetesReachable: stores.isKubernetesReachable,
    auditPersistent: audit.persistent,
  }));

  app.get('/readyz', async (_request, reply) => {
    const reachable = await k8s.ping();
    return reply.code(reachable ? 200 : 503).send({ status: reachable ? 'ready' : 'kubernetes-unreachable' });
  });

  await app.register(storeRoutes, {
    stores,
    audit,
    mutationRateLimitPerMinute: config.mutationRateLimitPerMinute,
  });

  try {
    app.log.info({ helm: await helm.version() }, 'helm available');
  } catch (err) {
    app.log.error({ err }, 'helm binary not usable; provisioning will fail');
  }

  stores.start();
  await app.listen({ host: config.host, port: config.port });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await stores.stop();
    audit.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
