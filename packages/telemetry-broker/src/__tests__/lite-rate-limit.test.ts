import { createServer } from 'node:http';
import type { HttpBindings } from '@hono/node-server';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';
import { BrokerError } from '../broker-error.js';
import { clientAddressPolicy } from '../client-address.js';
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
      headers: { 'x-forwarded-for': forwarded, 'cf-connecting-ip': forwarded },
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

test.each([
  ['untrusted IPv4', '192.0.2.9', '192.0.2.10/32', false],
  ['trusted IPv4', '192.0.2.9', '192.0.2.0/24', true],
  ['trusted mapped IPv4', '::ffff:192.0.2.9', '192.0.2.9/32', true],
  ['trusted IPv6', '2001:db8:1::9', '2001:db8:1::/48', true],
  ['untrusted IPv6', '2001:db8:2::9', '2001:db8:1::/48', false],
])('CF header admission: %s', async (_label, peer, cidrs, trusts) => {
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
  const addresses = clientAddressPolicy(cidrs);
  registerLiteRoutes(app, store, addresses);
  app.onError((_error, c) => c.json({ error: 'source_unauthorized' }, 401));
  const send = (value?: string) =>
    app.request(
      '/v1/lite/unknown',
      {
        method: 'POST',
        body: '{}',
        headers: value === undefined ? {} : { 'cf-connecting-ip': value },
      },
      socketBindings(peer),
    );
  for (let i = 0; i < 60; i++)
    expect((await send('198.51.100.1')).status).toBe(401);
  expect((await send('198.51.100.1')).status).toBe(429);
  expect((await send('198.51.100.2')).status).toBe(trusts ? 401 : 429);
  if (trusts) {
    // Missing and malformed headers all consume the socket peer's budget.
    for (const value of [
      undefined,
      '',
      '198.51.100.3, 198.51.100.4',
      '198.51.100.3:80',
      '[2001:db8::1]:80',
      'garbage',
      'fe80::1%eth0',
    ])
      expect((await send(value)).status).toBe(401);
    for (let i = 0; i < 53; i++) expect((await send()).status).toBe(401);
    expect((await send('198.51.100.5:443')).status).toBe(429);
    expect(addresses.diagnostics()).toEqual({ invalidClientIpHeaders: 7 });
  } else expect(addresses.diagnostics()).toEqual({ invalidClientIpHeaders: 0 });
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
