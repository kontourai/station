import { createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import type { HttpBindings } from '@hono/node-server';
import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { receiverAdmission } from './admission.js';
import type { LiteRepository } from './lite-store.js';
import { DASHBOARD_HTML, DASHBOARD_JS } from './public-dashboard.js';

export function registerLiteRoutes(
  app: Hono<{
    Bindings: HttpBindings;
    Variables: { dailyClient: { day: string; hash: string } };
  }>,
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
    // Forwarded headers never select a key; only the daily HMAC reaches storage.
    const client = createHmac('sha256', salt)
      .update(
        networkKey(c.env?.incoming?.socket.remoteAddress ?? 'unavailable', 64),
      )
      .digest('hex');
    const count = clients.get(client) ?? 0;
    if (count >= 60) {
      c.header('Retry-After', '86400');
      return c.json({ error: 'lite_rate_limit' }, 429);
    }
    clients.delete(client);
    if (clients.size >= 10000) clients.delete(clients.keys().next().value!);
    clients.set(client, count + 1);
    c.set('dailyClient', {
      day,
      hash: createHmac('sha256', salt)
        .update(
          networkKey(
            c.env?.incoming?.socket.remoteAddress ?? 'unavailable',
            48,
          ),
        )
        .digest('hex'),
    });
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
    return c.json(
      await store.ingest(c.req.param('source'), body, c.get('dailyClient')),
      202,
    );
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
    if (!key) return c.json({ error: 'source_unauthorized' }, 401);
    c.header('Cache-Control', 'no-store');
    return c.json(await store.aggregates(c.req.param('publisher'), key));
  });
  const publicAdmission = receiverAdmission();
  let cachedDay = '';
  let cached:
    | Promise<Awaited<ReturnType<LiteRepository['publicAggregates']>>>
    | undefined;
  app.get('/v1/public/aggregates', async (c) => {
    c.header('X-Content-Type-Options', 'nosniff');
    if (c.req.url.includes('?'))
      return c.json({ error: 'filters_unsupported' }, 400);
    c.header('Cache-Control', 'no-store');
    const today = new Date().toISOString().slice(0, 10);
    if (cachedDay !== today) {
      cached = undefined;
      cachedDay = today;
    }
    let response = cached;
    if (!response) {
      const refused = await publicAdmission(c, async () => {
        const pending = store.publicAggregates().catch((error) => {
          if (cached === pending) cached = undefined;
          throw error;
        });
        response = cached = pending;
      });
      if (refused) return refused;
    }
    const result = await response!;
    // A receiver/database clock disagreement must not cache an unfinished day.
    if (result.finalizedBeforeDay !== today) {
      if (cached === response) cached = undefined;
      return c.json(result);
    }
    c.header(
      'Cache-Control',
      `public, max-age=${Math.max(0, Math.floor((Date.parse(today) + 86400000 - Date.now()) / 1000))}`,
    );
    return c.json(result);
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

function networkKey(address: string, prefix: 48 | 64): string {
  if (isIP(address) !== 6) return isIP(address) === 4 ? address : 'unavailable';
  const [left, right] = address.split('::');
  const words = (part: string) =>
    part
      ? part
          .split(':')
          .flatMap((word) =>
            word.includes('.')
              ? [
                  (
                    (Number(word.split('.')[0]) << 8) |
                    Number(word.split('.')[1])
                  ).toString(16),
                  (
                    (Number(word.split('.')[2]) << 8) |
                    Number(word.split('.')[3])
                  ).toString(16),
                ]
              : [word],
          )
      : [];
  const start = words(left),
    end = words(right ?? '');
  const full =
    right === undefined
      ? start
      : [...start, ...Array(8 - start.length - end.length).fill('0'), ...end];
  const numbers = full.map((word) => parseInt(word, 16));
  if (numbers.slice(0, 5).every((n) => n === 0) && numbers[5] === 65535)
    return [
      numbers[6] >> 8,
      numbers[6] & 255,
      numbers[7] >> 8,
      numbers[7] & 255,
    ].join('.');
  return `${numbers
    .slice(0, prefix / 16)
    .map((n) => n.toString(16))
    .join(':')}::/${prefix}`;
}
