import type { FastifyInstance, FastifyRequest } from 'fastify';
import { isCatalogType, type CustomProductInput } from '../catalogs.js';
import type { AuditLog } from '../services/audit.js';
import type { AuthUser } from '../services/auth.js';
import type { PlatformMetrics } from '../services/metrics.js';
import type { StoreManager } from '../services/storeManager.js';
import { ENGINE_TYPES, HttpError, type AuditEntry, type EngineType } from '../types.js';

interface CatalogFields {
  catalog?: string;
  sells?: string;
  products?: CustomProductInput[];
}

interface CreateStoreBody extends CatalogFields {
  name: string;
  engine: EngineType;
  idempotencyKey?: string;
}

const storeIdParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', pattern: '^[a-z0-9]{3,20}$' } },
} as const;

const catalogProperties = {
  catalog: { type: 'string', pattern: '^[a-z]{2,20}$', default: 'auto' },
  sells: { type: 'string', maxLength: 200 },
  products: {
    type: 'array',
    maxItems: 24,
    items: {
      type: 'object',
      required: ['name', 'price'],
      additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 2, maxLength: 80 },
        price: { type: 'number', exclusiveMinimum: 0, maximum: 1000000 },
        category: { type: 'string', maxLength: 40 },
      },
    },
  },
} as const;

/** The onRequest hook guarantees a user on every /api route. */
function userOf(request: FastifyRequest): AuthUser {
  if (!request.user) throw new HttpError(401, 'UNAUTHORIZED', 'A valid API token is required');
  return request.user;
}

function actorOf(request: FastifyRequest): string {
  return `${userOf(request).name} (${request.ip})`;
}

function assertCatalog(fields: CatalogFields): void {
  if (fields.catalog && !isCatalogType(fields.catalog)) {
    throw new HttpError(400, 'UNKNOWN_CATALOG', `Unknown store type "${fields.catalog}"`);
  }
}

export interface StoreRoutesOptions {
  stores: StoreManager;
  audit: AuditLog;
  metrics: PlatformMetrics;
  mutationRateLimitPerMinute: number;
}

export async function storeRoutes(app: FastifyInstance, opts: StoreRoutesOptions): Promise<void> {
  const { stores, audit, metrics } = opts;
  const mutationRateLimit = { rateLimit: { max: opts.mutationRateLimitPerMinute, timeWindow: '1 minute' } };

  app.get('/api/me', async (request) => {
    const user = userOf(request);
    const owned = (await stores.list(user)).filter((s) => s.owner === user.name && s.status !== 'Deleting').length;
    return { user, quota: { used: owned, max: user.maxStores } };
  });

  app.get('/api/platform', async (request) => stores.platformInfo(userOf(request)));

  // Aggregated platform numbers for the dashboard (no tenant data).
  app.get('/api/metrics/summary', async () => metrics.summary());

  app.post<{ Body: CatalogFields & { name?: string } }>(
    '/api/catalogs/preview',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { name: { type: 'string', maxLength: 40 }, ...catalogProperties },
        },
      },
    },
    async (request) => {
      assertCatalog(request.body);
      const { name = '', catalog = 'auto', sells, products } = request.body;
      return stores.previewCatalog(name, { type: catalog, sells, products });
    },
  );

  app.get('/api/stores', async (request) => stores.list(userOf(request)));

  app.post<{ Body: CreateStoreBody }>(
    '/api/stores',
    {
      config: mutationRateLimit,
      schema: {
        body: {
          type: 'object',
          required: ['name', 'engine'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 3, maxLength: 40, pattern: '^[A-Za-z0-9][A-Za-z0-9 _.&\'-]*$' },
            engine: { type: 'string', enum: [...ENGINE_TYPES] },
            idempotencyKey: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9_.:-]+$' },
            ...catalogProperties,
          },
        },
      },
    },
    async (request, reply) => {
      assertCatalog(request.body);
      const headerKey = request.headers['idempotency-key'];
      const idempotencyKey = request.body.idempotencyKey ?? (typeof headerKey === 'string' ? headerKey : undefined);
      const { store, created } = await stores.create({
        name: request.body.name.trim(),
        engine: request.body.engine,
        catalog: request.body.catalog,
        sells: request.body.sells?.trim() || undefined,
        products: request.body.products,
        idempotencyKey,
        owner: userOf(request),
        actor: actorOf(request),
      });
      return reply.code(created ? 202 : 200).send(store);
    },
  );

  app.get<{ Params: { id: string } }>('/api/stores/:id', { schema: { params: storeIdParams } }, async (request) =>
    stores.get(request.params.id, userOf(request)),
  );

  app.delete<{ Params: { id: string } }>(
    '/api/stores/:id',
    { config: mutationRateLimit, schema: { params: storeIdParams } },
    async (request, reply) => {
      const store = await stores.delete(request.params.id, actorOf(request), userOf(request));
      return reply.code(202).send(store);
    },
  );

  app.put<{ Params: { id: string }; Body: { domains: string[] } }>(
    '/api/stores/:id/domains',
    {
      config: mutationRateLimit,
      schema: {
        params: storeIdParams,
        body: {
          type: 'object',
          required: ['domains'],
          additionalProperties: false,
          properties: { domains: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 253 } } },
        },
      },
    },
    async (request) => stores.setDomains(request.params.id, request.body.domains, actorOf(request), userOf(request)),
  );

  app.get<{ Params: { id: string } }>(
    '/api/stores/:id/domains/check',
    { schema: { params: storeIdParams } },
    async (request) => stores.checkDomains(request.params.id, userOf(request)),
  );

  app.get<{ Querystring: { limit?: number; storeId?: string } }>(
    '/api/audit',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
            storeId: { type: 'string', pattern: '^[a-z0-9]{3,20}$' },
          },
        },
      },
    },
    async (request): Promise<AuditEntry[]> => {
      const user = userOf(request);
      const { limit, storeId } = request.query;
      if (user.role === 'admin') return audit.list({ limit, storeId });
      // Users only see events for their own stores and their own actions.
      const own = new Set((await stores.list(user)).map((s) => s.id));
      if (storeId && !own.has(storeId)) return [];
      const entries = await audit.list({ limit: 1000, storeId });
      return entries
        .filter((e) => (e.storeId && own.has(e.storeId)) || e.actor.startsWith(`${user.name} (`))
        .slice(0, limit ?? 100);
    },
  );
}
