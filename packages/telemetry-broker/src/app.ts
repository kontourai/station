import { createHash, timingSafeEqual } from 'node:crypto';
import type { HttpBindings } from '@hono/node-server';
import type { ProductTelemetryBatch } from '@kontourai/station-contracts/product-telemetry';
import {
  PRODUCT_TELEMETRY_DATA_INVENTORY_REVISION,
  parseProductTelemetryBatch,
  parseProductTelemetryProbeRequest,
} from '@kontourai/station-shared/product-telemetry';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { receiverAdmission } from './admission.js';
import { BrokerError } from './broker-error.js';
import { clientAddressPolicy } from './client-address.js';
import { registerLiteRoutes } from './lite-routes.js';
import { createPrivateUsageRoutes } from './private-usage-routes.js';
import { PrivateUsageError } from './private-usage-store.js';
import type { ProductRepository } from './store.js';

export function createProductBroker(
  store: ProductRepository,
  operatorKey: string,
  addresses = clientAddressPolicy(),
) {
  if (!/^sto_[A-Za-z0-9_-]{43}$/.test(operatorKey))
    throw new Error('A private product operator credential is required');
  const operatorHash = createHash('sha256').update(operatorKey).digest();
  const app = new Hono<{
    Bindings: HttpBindings;
    Variables: { dailyClient: { day: string; hash: string } };
  }>();
  const fullAdmission = receiverAdmission();
  const preAuthAdmission = receiverAdmission();
  const credentials = new Map<string, ReturnType<typeof receiverAdmission>>();
  const liteAdmission = receiverAdmission();
  const publicPageAdmission = receiverAdmission();
  const privateAdmission = receiverAdmission();
  app.use('*', async (c, next) => {
    if (
      addresses.isTrustedPeer(c.env?.incoming?.socket.remoteAddress ?? '') &&
      !(
        (c.req.method === 'POST' && /^\/v1\/lite\/[^/]+$/.test(c.req.path)) ||
        (c.req.method === 'GET' &&
          (c.req.path === '/v1/public/aggregates' ||
            c.req.path.startsWith('/public/') ||
            c.req.path === '/health/live'))
      )
    )
      return c.notFound();
    await next();
  });
  app.use('*', async (c, next) => {
    if (c.req.path === '/health/live' || c.req.path === '/v1/public/aggregates')
      return next();
    if (c.req.path.startsWith('/v1/private-usage/')) {
      return privateAdmission(c, async () => {
        const key = /^Bearer (stai_[A-Za-z0-9_-]{43})$/.exec(
          c.req.header('authorization') ?? '',
        )?.[1];
        if (!key) {
          c.res = c.json({ error: 'private_usage_unauthorized' }, 401);
          return;
        }
        const digest = `private:${createHash('sha256').update(key).digest('hex')}`;
        const admission = credentials.get(digest) ?? receiverAdmission();
        credentials.delete(digest);
        if (credentials.size >= 10000)
          credentials.delete(credentials.keys().next().value!);
        credentials.set(digest, admission);
        const result = await admission(c, next);
        if (result) c.res = result;
      });
    }
    if (
      (c.req.method === 'POST' &&
        ['/v1/product/events', '/v1/product/probes'].includes(c.req.path)) ||
      (c.req.method === 'GET' &&
        /^\/v1\/product\/receipts\/[^/]+$/.test(c.req.path))
    ) {
      const key = c.req.header('x-api-key') ?? '';
      // Cache lookup only. Unknown keys enter pre-auth admission before any DB work.
      if (!store.hasCredential(key))
        return preAuthAdmission(c, async () => {
          c.res = c.json({ error: 'source_unauthorized' }, 401);
        });
      const digest = createHash('sha256').update(key).digest('hex');
      const admission = credentials.get(digest) ?? receiverAdmission();
      credentials.delete(digest);
      if (credentials.size >= 10000)
        credentials.delete(credentials.keys().next().value!);
      credentials.set(digest, admission);
      return admission(c, async () => {
        await store.authenticate(key);
        await next();
      });
    }
    const publisherMatch =
      c.req.method === 'GET' &&
      /^\/v1\/publishers\/([^/]+)\/aggregates$/.exec(c.req.path);
    if (publisherMatch) {
      const key =
        /^Bearer (stq_[A-Za-z0-9_-]{43})$/.exec(
          c.req.header('authorization') ?? '',
        )?.[1] ?? '';
      let publisher: string;
      try {
        publisher = decodeURIComponent(publisherMatch[1]);
      } catch {
        return c.json({ error: 'invalid_publisher' }, 400);
      }
      if (!store.lite?.hasCredential(publisher, key))
        return preAuthAdmission(c, async () => {
          c.res = c.json({ error: 'source_unauthorized' }, 401);
        });
      const digest = createHash('sha256').update(key).digest('hex');
      const admission = credentials.get(digest) ?? receiverAdmission();
      credentials.delete(digest);
      if (credentials.size >= 10000)
        credentials.delete(credentials.keys().next().value!);
      credentials.set(digest, admission);
      return admission(c, next);
    }
    return (
      c.req.path.startsWith('/v1/lite/')
        ? liteAdmission
        : c.req.path.startsWith('/public/')
          ? publicPageAdmission
          : c.req.path.startsWith('/v1/operator/') &&
              c.req.header('authorization') === `Bearer ${operatorKey}`
            ? fullAdmission
            : preAuthAdmission
    )(c, next);
  });
  app.use('*', (c, next) =>
    bodyLimit({
      maxSize: c.req.path.startsWith('/v1/private-usage/')
        ? 2 * 1024 * 1024
        : 131_072,
      onError: (c) => c.json({ error: 'body_too_large' }, 413),
    })(c, next),
  );
  app.get('/health/live', (c) =>
    c.json({
      state: 'alive',
      scope: 'process',
      productProtocol: 1,
      inventoryRevision: PRODUCT_TELEMETRY_DATA_INVENTORY_REVISION,
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
  app.get('/v1/operator/diagnostics', (c) => c.json(addresses.diagnostics()));
  app.post('/v1/operator/private-usage-vaults', async (c) => {
    if (!store.privateUsage) return c.notFound();
    const body: unknown = await c.req.json().catch(() => null);
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).join(',') !== 'credentialHash' ||
      !('credentialHash' in body) ||
      typeof body.credentialHash !== 'string'
    )
      return c.json({ error: 'invalid_private_usage_vault' }, 400);
    return c.json(await store.privateUsage.provision(body.credentialHash), 201);
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
  app.get('/v1/operator/incidents', async (c) => {
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
      await store.incidents(
        new Date(from).toISOString(),
        new Date(to).toISOString(),
      ),
    );
  });
  app.post('/v1/product/probes', async (c) => {
    const key = c.req.header('x-api-key') ?? '';
    if (!/^stp_[A-Za-z0-9_-]{43}$/.test(key))
      return c.json({ error: 'source_unauthorized' }, 401);
    try {
      parseProductTelemetryProbeRequest(await c.req.json());
    } catch {
      return c.json({ error: 'invalid_product_probe' }, 400);
    }
    return c.json({ probe: await store.probe(key) });
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
  if (store.lite) registerLiteRoutes(app, store.lite, addresses);
  if (store.privateUsage)
    app.route(
      '/v1/private-usage',
      createPrivateUsageRoutes(store.privateUsage),
    );
  app.onError((error, c) => {
    if (error instanceof PrivateUsageError)
      return c.json(
        { error: error.message },
        error.code === 'invalid_commit'
          ? 400
          : error.code === 'conflict'
            ? 409
            : error.code === 'capacity'
              ? 507
              : 503,
      );
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
                : error.code === 'invalid_cursor' ||
                    error.code === 'invalid_source' ||
                    error.code === 'invalid_daily_ping'
                  ? 400
                  : 503;
      return c.json({ error: error.code }, status);
    }
    return c.json({ error: 'storage_unavailable' }, 503);
  });
  return app;
}
