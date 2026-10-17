import { createServer } from 'node:http';
import type { HttpBindings } from '@hono/node-server';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';
import { registerLiteRoutes } from '../lite-routes.js';
import { LiteRepository } from '../lite-store.js';
import { BrokerError } from '../store.js';

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
  const app = new Hono<{ Bindings: HttpBindings }>();
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
