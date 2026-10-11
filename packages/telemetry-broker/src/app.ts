import { createHash, timingSafeEqual } from 'node:crypto';
import type { ProductTelemetryBatch } from '@kontourai/station-contracts/product-telemetry';
import {
  parseProductTelemetryBatch,
  USAGE_TELEMETRY_INVENTORY_REVISION,
} from '@kontourai/station-shared/product-telemetry';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { BrokerError, type ProductRepository } from './store.js';

export function createProductBroker(
  store: ProductRepository,
  operatorKey: string,
) {
  if (!/^sto_[A-Za-z0-9_-]{43}$/.test(operatorKey))
    throw new Error('A private product operator credential is required');
  const operatorHash = createHash('sha256').update(operatorKey).digest();
  const app = new Hono();
  let active = 0;
  let tokens = 60;
  let replenishedAt = performance.now();
  app.use('*', async (c, next) => {
    if (c.req.method === 'GET' && c.req.path === '/health/live') return next();
    const now = performance.now();
    tokens = Math.min(60, tokens + (now - replenishedAt) / 1000);
    replenishedAt = now;
    if (tokens < 1) {
      c.header('Retry-After', '1');
      return c.json({ error: 'receiver_rate_limit' }, 429);
    }
    if (active >= 8) return c.json({ error: 'receiver_busy' }, 503);
    tokens--;
    active++;
    try {
      await next();
    } finally {
      active--;
    }
  });
  app.use(
    '*',
    bodyLimit({
      maxSize: 131_072,
      onError: (c) => c.json({ error: 'body_too_large' }, 413),
    }),
  );
  app.get('/health/live', (c) =>
    c.json({
      state: 'alive',
      scope: 'process',
      productProtocol: 1,
      inventoryRevision: USAGE_TELEMETRY_INVENTORY_REVISION,
    }),
  );
  app.use('/v1/operator/*', async (c, next) => {
    const key =
      /^Bearer (sto_[A-Za-z0-9_-]{43})$/.exec(
        c.req.header('authorization') ?? '',
      )?.[1] ?? '';
    if (
      !/^sto_[A-Za-z0-9_-]{43}$/.test(key) ||
      !timingSafeEqual(createHash('sha256').update(key).digest(), operatorHash)
    )
      return c.json({ error: 'operator_unauthorized' }, 401);
    await next();
  });
  app.get('/v1/operator/storage', async (c) => {
    await store.ready();
    return c.json({ state: 'ready', scope: 'postgres-schema-v1' });
  });
  app.post('/v1/operator/sources', async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      !('id' in body) ||
      !('label' in body) ||
      !('credentialHash' in body) ||
      typeof body.id !== 'string' ||
      typeof body.label !== 'string' ||
      typeof body.credentialHash !== 'string' ||
      Object.keys(body).some(
        (key) => !['id', 'label', 'credentialHash'].includes(key),
      )
    )
      return c.json({ error: 'invalid_source' }, 400);
    return c.json(
      {
        source: await store.createSource(
          body.id,
          body.label,
          body.credentialHash,
        ),
      },
      201,
    );
  });
  app.delete('/v1/operator/sources/:id', async (c) =>
    c.json({ revoked: await store.revokeSource(c.req.param('id')) }),
  );
  app.get('/v1/operator/trends', async (c) => {
    const from = c.req.query('from'),
      to = c.req.query('to');
    if (
      !from ||
      !to ||
      !Number.isFinite(Date.parse(from)) ||
      !Number.isFinite(Date.parse(to)) ||
      Date.parse(to) <= Date.parse(from) ||
      Date.parse(to) - Date.parse(from) > 365 * 86400000
    )
      return c.json({ error: 'invalid_window' }, 400);
    return c.json(
      await store.trends(
        new Date(from).toISOString(),
        new Date(to).toISOString(),
      ),
    );
  });
  app.post('/v1/product/events', async (c) => {
    const key = c.req.header('x-api-key') ?? '';
    if (!/^stp_[A-Za-z0-9_-]{43}$/.test(key))
      return c.json({ error: 'source_unauthorized' }, 401);
    let batch: ProductTelemetryBatch;
    try {
      batch = parseProductTelemetryBatch(await c.req.json());
    } catch {
      return c.json({ error: 'invalid_product_batch' }, 400);
    }
    return c.json({ receipt: await store.ingest(key, batch) }, 202);
  });
  app.get('/v1/product/receipts/:id', async (c) => {
    const key = c.req.header('x-api-key') ?? '';
    const receipt = await store.receipt(key, c.req.param('id'));
    return receipt
      ? c.json({ receipt })
      : c.json({ error: 'receipt_unavailable' }, 404);
  });
  app.onError((error, c) => {
    if (error instanceof BrokerError) {
      const status =
        error.code === 'source_unauthorized'
          ? 401
          : error.code === 'event_conflict' || error.code === 'source_conflict'
            ? 409
            : error.code === 'storage_limit'
              ? 507
              : error.code === 'query_limit'
                ? 422
                : error.code === 'invalid_source'
                  ? 400
                  : 503;
      return c.json({ error: error.code }, status);
    }
    return c.json({ error: 'storage_unavailable' }, 503);
  });
  return app;
}
