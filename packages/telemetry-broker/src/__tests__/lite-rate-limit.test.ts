import { createServer } from 'node:http';
import type { HttpBindings } from '@hono/node-server';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';
import { BrokerError } from '../broker-error.js';
import { registerLiteRoutes } from '../lite-routes.js';
import { LiteRepository } from '../lite-store.js';
import { socketBindings } from './lite-fixture.js';

test('socket-IP admission ignores forwarded addresses and resets on the next UTC day', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-17T23:59:00Z'));
  let admitted = 0;
  const repository = new LiteRepository(
    async () => {
      admitted++;
      throw new BrokerError('source_unauthorized');
    },
    100,
    100,
  );
  const app = new Hono<{
    Bindings: HttpBindings;
    Variables: { dailyClient: { day: string; hash: string } };
  }>();
  registerLiteRoutes(app, repository);
  app.onError((_error, c) => c.json({ error: 'source_unauthorized' }, 401));
  const server = createServer(getRequestListener(app.fetch));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('fixture listener missing');
  const send = (forwarded: string) =>
    fetch(`http://127.0.0.1:${address.port}/v1/lite/unknown`, {
      method: 'POST',
      headers: { 'x-forwarded-for': forwarded },
      body: '{}',
    });
  try {
    for (let i = 0; i < 60; i++) {
      const response = await send(`198.51.100.${i}`);
      expect(response.status).toBe(401);
      await response.arrayBuffer();
    }
    const refused = await send('203.0.113.99');
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: 'lite_rate_limit' });
    expect(admitted).toBe(60);
    vi.setSystemTime(new Date('2026-10-18T00:00:00Z'));
    const next = await send('203.0.113.99');
    expect(next.status).toBe(401);
    await next.arrayBuffer();
    expect(admitted).toBe(61);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.useRealTimers();
  }
});

test('IPv6 /64 aliases share a daily budget; adjacent /64s and IPv4 addresses remain independent', async () => {
  const store = new LiteRepository(
    async () => {
      throw new BrokerError('source_unauthorized');
    },
    100,
    100,
  );
  const app = new Hono<{
    Bindings: HttpBindings;
    Variables: { dailyClient: { day: string; hash: string } };
  }>();
  registerLiteRoutes(app, store);
  app.onError((_error, c) => c.json({ error: 'source_unauthorized' }, 401));
  const send = (address: string) =>
    app.request(
      '/v1/lite/unknown',
      { method: 'POST', body: '{}' },
      socketBindings(address),
    );
  for (let i = 0; i < 60; i++)
    expect((await send(`2001:db8:1:2::${(i + 1).toString(16)}`)).status).toBe(
      401,
    );
  expect((await send('2001:0db8:0001:0002:1234::1')).status).toBe(429);
  expect((await send('2001:db8:1:3::1')).status).toBe(401);
  for (let i = 0; i < 60; i++)
    expect((await send('192.0.2.1')).status).toBe(401);
  expect((await send('::ffff:c000:201')).status).toBe(429);
  expect((await send('::ffff:192.0.2.1')).status).toBe(429);
  expect((await send('192.0.2.2')).status).toBe(401);
});

test('a full client map evicts oldest entries and continues accepting new clients', async () => {
  const store = new LiteRepository(
    async () => {
      throw new BrokerError('source_unauthorized');
    },
    100,
    100,
  );
  const app = new Hono<{
    Bindings: HttpBindings;
    Variables: { dailyClient: { day: string; hash: string } };
  }>();
  registerLiteRoutes(app, store);
  app.onError((_error, c) => c.json({ error: 'source_unauthorized' }, 401));
  const send = (i: number) =>
    app.request(
      '/v1/lite/unknown',
      { method: 'POST', body: '{}' },
      socketBindings(`2001:db8:${i.toString(16)}::1`),
    );
  for (let i = 0; i < 10001; i++) expect((await send(i)).status).toBe(401);
  expect((await send(0)).status).toBe(401);
});
