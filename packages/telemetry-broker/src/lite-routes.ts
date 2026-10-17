import { createHmac, randomBytes } from 'node:crypto';
import type { HttpBindings } from '@hono/node-server';
import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { LiteRepository } from './lite-store.js';
import { DASHBOARD_HTML, DASHBOARD_JS } from './public-dashboard.js';

export function registerLiteRoutes(
  app: Hono<{ Bindings: HttpBindings }>,
  store: LiteRepository,
) {
  let day = '';
  let salt = randomBytes(32);
  const clients = new Map<string, number>();
  app.use('/v1/lite/*', async (c, next) => {
    const today = new Date().toISOString().slice(0, 10);
    if (day !== today) {
      day = today;
      salt = randomBytes(32);
      clients.clear();
    }
    // Never trust forwarded headers. Only this daily HMAC enters process memory.
    const client = createHmac('sha256', salt)
      .update(c.env?.incoming?.socket.remoteAddress ?? 'unavailable')
      .digest('hex');
    const count = clients.get(client) ?? 0;
    if (count >= 60 || (!clients.has(client) && clients.size >= 10000)) {
      c.header('Retry-After', '86400');
      return c.json({ error: 'lite_rate_limit' }, 429);
    }
    clients.set(client, count + 1);
    await next();
  });
  app.use(
    '/v1/lite/*',
    bodyLimit({
      maxSize: 16384,
      onError: (c) => c.json({ error: 'body_too_large' }, 413),
    }),
  );
  app.post('/v1/lite/:source', async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    return c.json(await store.ingest(c.req.param('source'), body), 202);
  });
  app.post('/v1/operator/lite/sources', async (c) => {
    await store.createSource(await c.req.json().catch(() => null));
    return c.json({ created: true }, 201);
  });
  app.delete('/v1/operator/lite/sources/:source', async (c) =>
    c.json({ revoked: await store.revokeSource(c.req.param('source')) }),
  );
  app.post('/v1/operator/lite/publishers', async (c) => {
    const value: unknown = await c.req.json().catch(() => null);
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).length !== 2 ||
      !('publisher' in value) ||
      !('credentialHash' in value)
    )
      return c.json({ error: 'invalid_source' }, 400);
    await store.setPublisherKey(value.publisher, value.credentialHash);
    return c.json({ configured: true }, 201);
  });
  app.delete('/v1/operator/lite/publishers/:publisher', async (c) => {
    await store.revokePublisherKey(c.req.param('publisher'));
    return c.json({ revoked: true });
  });
  app.get('/v1/publishers/:publisher/aggregates', async (c) => {
    if (c.req.url.includes('?'))
      return c.json({ error: 'filters_unsupported' }, 400);
    const key =
      /^Bearer (stq_[A-Za-z0-9_-]{43})$/.exec(
        c.req.header('authorization') ?? '',
      )?.[1] ?? '';
    c.header('Cache-Control', 'no-store');
    return c.json(await store.aggregates(c.req.param('publisher'), key));
  });
  app.get('/v1/public/aggregates', async (c) => {
    if (c.req.url.includes('?'))
      return c.json({ error: 'filters_unsupported' }, 400);
    c.header('Cache-Control', 'no-store');
    return c.json(await store.aggregates('kontour'));
  });
  app.use('/public/*', async (c, next) => {
    c.header(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Content-Type-Options', 'nosniff');
    await next();
  });
  app.get('/public/', (c) => c.html(DASHBOARD_HTML));
  app.get('/public/dashboard.js', (c) =>
    c.body(DASHBOARD_JS, 200, {
      'Content-Type': 'text/javascript; charset=utf-8',
    }),
  );
}
