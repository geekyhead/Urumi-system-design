import type { FastifyInstance, FastifyRequest } from 'fastify';
import { isCatalogType, type CustomProductInput } from '../catalogs.js';
import type { AuditLog } from '../services/audit.js';
import type { StoreManager } from '../services/storeManager.js';
import { ENGINE_TYPES, HttpError, type EngineType } from '../types.js';

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

function actorOf(request: FastifyRequest): string {
  const header = request.headers['x-actor'];
  const actor = Array.isArray(header) ? header[0] : header;
  return actor && /^[\w.@-]{1,64}$/.test(actor) ? `${actor} (${request.ip})` : request.ip;
}

function assertCatalog(fields: CatalogFields): void {
  if (fields.catalog && !isCatalogType(fields.catalog)) {
    throw new HttpError(400, 'UNKNOWN_CATALOG', `Unknown store type "${fields.catalog}"`);
  }
}

export interface StoreRoutesOptions {
  stores: StoreManager;
  audit: AuditLog;
  mutationRateLimitPerMinute: number;
}

export async function storeRoutes(app: FastifyInstance, opts: StoreRoutesOptions): Promise<void> {
  const { stores, audit } = opts;
  const mutationRateLimit = { rateLimit: { max: opts.mutationRateLimitPerMinute, timeWindow: '1 minute' } };

  app.get('/api/platform', async () => stores.platformInfo());

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

  app.get('/api/stores', async () => stores.list());

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
        actor: actorOf(request),
      });
      return reply.code(created ? 202 : 200).send(store);
    },
  );

  app.get<{ Params: { id: string } }>('/api/stores/:id', { schema: { params: storeIdParams } }, async (request) =>
    stores.get(request.params.id),
  );

  app.delete<{ Params: { id: string } }>(
    '/api/stores/:id',
    { config: mutationRateLimit, schema: { params: storeIdParams } },
    async (request, reply) => {
      const store = await stores.delete(request.params.id, actorOf(request));
      return reply.code(202).send(store);
    },
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
    async (request) => audit.list({ limit: request.query.limit, storeId: request.query.storeId }),
  );
}
