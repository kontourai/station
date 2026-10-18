import { createHash } from 'node:crypto';
import { PGlite, type PGliteInterface } from '@electric-sql/pglite';
import type { ProductTelemetryCommitReceipt as ProductCommit } from '@kontourai/station-contracts/product-telemetry';
import { USAGE_TELEMETRY_INVENTORY_REVISION } from '@kontourai/station-shared/product-telemetry';
import type { QueryResultRow } from 'pg';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createProductBroker } from '../app.js';
import { BrokerError } from '../broker-error.js';
import {
  assertLiteSchema,
  LiteRepository,
  migrateLite,
} from '../lite-store.js';
import type { ProductRepository } from '../store.js';
import { dailyPing, socketBindings } from './lite-fixture.js';

const operatorKey = `sto_${'a'.repeat(43)}`;
const sourceKey = `stp_${'b'.repeat(43)}`;
const batch = () => ({
  schema_version: 1,
  inventory_revision: USAGE_TELEMETRY_INVENTORY_REVISION,
  distinct_id: 'a'.repeat(64),
  events: [
    {
      event_id: '11111111-2222-4333-8444-555555555555',
      event: 'engine_turn',
      occurred_at: '2026-10-10T12:00:00.000Z',
      observed_at: '2026-10-10T12:00:01.000Z',
      build: { version: '1.2.3', platform: 'linux', arch: 'x64' },
      properties: { engine: 'codex', outcome: 'completed' },
    },
  ],
});
const commit: ProductCommit = {
  protocol: 'station-product-commit/v1',
  receiptId: '11111111-2222-4333-8444-555555555555',
  sourceId: '22222222-2222-4333-8444-555555555555',
  eventIds: ['11111111-2222-4333-8444-555555555555'],
  inserted: 1,
  alreadyPresent: 0,
  storedAt: '2026-10-10T12:00:02.000Z',
};
const store = {
  authenticate: vi.fn<ProductRepository['authenticate']>(),
  ingest: vi.fn<ProductRepository['ingest']>(),
  probe: vi.fn<ProductRepository['probe']>(),
  createSource: vi.fn<ProductRepository['createSource']>(),
  revokeSource: vi.fn<ProductRepository['revokeSource']>(),
  receipt: vi.fn<ProductRepository['receipt']>(),
  trends: vi.fn<ProductRepository['trends']>(),
  ready: vi.fn<ProductRepository['ready']>(),
};
beforeEach(() => {
  vi.resetAllMocks();
  store.ingest.mockResolvedValue(commit);
  store.ready.mockResolvedValue();
  store.probe.mockResolvedValue({
    protocol: 'station-product-probe/v1',
    sourceId: commit.sourceId,
    inventoryRevision: USAGE_TELEMETRY_INVENTORY_REVISION,
    checkedAt: '2026-10-10T12:00:02.000Z',
    storage: 'postgres-schema-v1',
  });
});
const post = (body: unknown, key = sourceKey) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': key },
  body: JSON.stringify(body),
});
describe('product receiver HTTP admission and acknowledgement boundary', () => {
  test('the explicit probe queries source-scoped storage without ingesting observations', async () => {
    const response = await createProductBroker(store, operatorKey).request(
      '/v1/product/probes',
      post({
        protocol: 'station-product-probe/v1',
        inventoryRevision: USAGE_TELEMETRY_INVENTORY_REVISION,
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      probe: {
        protocol: 'station-product-probe/v1',
        sourceId: commit.sourceId,
        inventoryRevision: USAGE_TELEMETRY_INVENTORY_REVISION,
        checkedAt: '2026-10-10T12:00:02.000Z',
        storage: 'postgres-schema-v1',
      },
    });
    expect(store.probe).toHaveBeenCalledExactlyOnceWith(sourceKey);
    expect(store.ingest).not.toHaveBeenCalled();
    expect(store.receipt).not.toHaveBeenCalled();
  });
  test.each([
    {
      protocol: 'station-product-probe/v2',
      inventoryRevision: USAGE_TELEMETRY_INVENTORY_REVISION,
    },
    { protocol: 'station-product-probe/v1', inventoryRevision: 'stale' },
    {
      protocol: 'station-product-probe/v1',
      inventoryRevision: USAGE_TELEMETRY_INVENTORY_REVISION,
      prompt: 'private-content',
    },
  ])(
    'invalid probes never reach storage or echo their content',
    async (body) => {
      const response = await createProductBroker(store, operatorKey).request(
        '/v1/product/probes',
        post(body),
      );
      expect(response.status).toBe(400);
      expect(store.probe).not.toHaveBeenCalled();
      expect(await response.text()).not.toContain('private-content');
    },
  );
  test('revoked source and incompatible storage probes fail without ingesting observations', async () => {
    for (const [code, status] of [
      ['source_unauthorized', 401],
      ['schema_incompatible', 503],
    ] as const) {
      store.probe.mockRejectedValueOnce(new BrokerError(code));
      const response = await createProductBroker(store, operatorKey).request(
        '/v1/product/probes',
        post({
          protocol: 'station-product-probe/v1',
          inventoryRevision: USAGE_TELEMETRY_INVENTORY_REVISION,
        }),
      );
      expect(response.status).toBe(status);
      expect(store.ingest).not.toHaveBeenCalled();
    }
  });
  test('source and operator credentials do not cross their namespaces', async () => {
    const app = createProductBroker(store, operatorKey);
    expect(
      (
        await app.request('/v1/operator/trends?from=2026-10-01&to=2026-10-11', {
          headers: { authorization: `Bearer ${sourceKey}` },
        })
      ).status,
    ).toBe(401);
    expect(
      (await app.request('/v1/product/events', post(batch(), operatorKey)))
        .status,
    ).toBe(401);
    expect(store.trends).not.toHaveBeenCalled();
    expect(store.ingest).not.toHaveBeenCalled();
  });
  test.each([
    ['legacy', () => ({ distinct_id: 'a'.repeat(64), events: batch().events })],
    ['unsupported', () => ({ ...batch(), schema_version: 2 })],
    ['content', () => ({ ...batch(), prompt: 'private-secret-prompt' })],
    [
      'too many events',
      () => ({ ...batch(), events: Array(21).fill(batch().events[0]) }),
    ],
    [
      'invalid time',
      () => {
        const b = batch();
        b.events[0].occurred_at = 'not-time';
        return b;
      },
    ],
  ])(
    'rejects %s before repository effects and never echoes rejected content',
    async (_name, body) => {
      const response = await createProductBroker(store, operatorKey).request(
        '/v1/product/events',
        post(body()),
      );
      expect(response.status).toBe(400);
      expect(store.ingest).not.toHaveBeenCalled();
      expect(await response.text()).not.toContain('private-secret-prompt');
    },
  );
  test('oversized streaming bodies stop before parsing or repository effects', async () => {
    const body = JSON.stringify({ ...batch(), padding: 'x'.repeat(131073) });
    const response = await createProductBroker(store, operatorKey).request(
      '/v1/product/events',
      { method: 'POST', headers: { 'x-api-key': sourceKey }, body },
    );
    expect(response.status).toBe(413);
    expect(store.ingest).not.toHaveBeenCalled();
  });
  test('acknowledgement waits for the repository commit boundary', async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let commitTransaction!: (value: ProductCommit) => void;
    const durable = new Promise<ProductCommit>((resolve) => {
      commitTransaction = resolve;
    });
    store.ingest.mockImplementation(async () => {
      entered();
      return durable;
    });
    let answered = false;
    const pending = Promise.resolve(
      createProductBroker(store, operatorKey).request(
        '/v1/product/events',
        post(batch()),
      ),
    ).then((response) => {
      answered = true;
      return response;
    });
    await started;
    expect(answered).toBe(false);
    commitTransaction(commit);
    const response = await pending;
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ receipt: commit });
  });
  test.each([
    ['source_unauthorized', 401],
    ['event_conflict', 409],
    ['storage_limit', 507],
    ['storage_not_durable', 503],
  ] as const)(
    'preserves %s as a failure without a receipt',
    async (code, status) => {
      store.ingest.mockRejectedValue(new BrokerError(code));
      const response = await createProductBroker(store, operatorKey).request(
        '/v1/product/events',
        post(batch()),
      );
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: code });
    },
  );
  test('a live process is separate from authorized storage readiness', async () => {
    const app = createProductBroker(store, operatorKey);
    expect(await (await app.request('/health/live')).json()).toMatchObject({
      state: 'alive',
      scope: 'process',
    });
    expect(store.ready).not.toHaveBeenCalled();
    store.ready.mockRejectedValue(
      new Error('private-database-host-and-secret'),
    );
    const response = await app.request('/v1/operator/storage', {
      headers: { authorization: `Bearer ${operatorKey}` },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'storage_unavailable' });
  });
});

describe('bounded receiver admission', () => {
  test('rejects excess concurrent work without entering storage and releases slots after settlement', async () => {
    let settle: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      settle = resolve;
    });
    store.ready.mockImplementation(() => pending);
    const app = createProductBroker(store, operatorKey);
    const init = { headers: { authorization: `Bearer ${operatorKey}` } };
    const inFlight = Array.from({ length: 8 }, () =>
      app.request('/v1/operator/storage', init),
    );
    const busyRequest = app.request('/v1/operator/storage', init);
    await Promise.resolve();
    settle?.();
    const busy = await busyRequest;
    expect(busy.status).toBe(503);
    expect(await busy.json()).toEqual({ error: 'receiver_busy' });
    expect(store.ready).toHaveBeenCalledTimes(8);
    const responses = await Promise.all(inFlight);
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect((await app.request('/v1/operator/storage', init)).status).toBe(200);
  });

  test('bounds unauthenticated request floods before storage while preserving process liveness', async () => {
    const app = createProductBroker(store, operatorKey);
    for (let i = 0; i < 60; i++)
      expect(
        (await app.request('/v1/product/events', post(batch(), 'invalid')))
          .status,
      ).toBe(401);
    const limited = await app.request('/v1/product/events', post(batch()));
    expect(limited.status).toBe(202);
    expect(store.ingest).toHaveBeenCalledOnce();
    expect((await app.request('/health/live')).status).toBe(200);
  });
});

test('anonymous lite and public traffic cannot spend authenticated ingest admission; cached reads perform no storage work', async () => {
  const lite = new LiteRepository(
    async () => {
      throw new BrokerError('source_unauthorized');
    },
    100,
    100,
  );
  const reads = vi.spyOn(lite, 'publicAggregates').mockResolvedValue({
    finalizedBeforeDay: new Date().toISOString().slice(0, 10),
    scope: 'daily-per-dimension-marginals',
    publisher: 'kontour',
    minimumDistinctDailyClients: 10,
    privacyUnit: 'daily-salted-IPv4-or-IPv6-/48',
    dayBasis: 'UTC-receiver-arrival',
    deliveryCoverage: 'unknown',
    days: [],
  });
  const app = createProductBroker({ ...store, lite }, operatorKey);
  for (let i = 0; i < 60; i++)
    expect((await app.request('/v1/lite/unknown', post({}))).status).toBe(401);
  expect((await app.request('/v1/lite/unknown', post({}))).status).toBe(429);
  for (let i = 0; i < 80; i++) {
    const response = await app.request('/v1/public/aggregates');
    expect(response.status).toBe(200);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  }
  expect(reads).toHaveBeenCalledTimes(1);
  expect((await app.request('/v1/product/events', post(batch()))).status).toBe(
    202,
  );
  expect(store.ingest).toHaveBeenCalledExactlyOnceWith(
    sourceKey,
    expect.any(Object),
  );
});

test('public cache shares pending reads, retries failures, and refreshes at UTC midnight', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-17T23:59:00Z'));
  const lite = new LiteRepository(
    async () => {
      throw new BrokerError('source_unauthorized');
    },
    100,
    100,
  );
  let refuse!: (reason: Error) => void;
  const pending = new Promise<
    Awaited<ReturnType<LiteRepository['publicAggregates']>>
  >((_, reject) => {
    refuse = reject;
  });
  const reads = vi
    .spyOn(lite, 'publicAggregates')
    .mockReturnValueOnce(pending)
    .mockResolvedValue({
      finalizedBeforeDay: new Date().toISOString().slice(0, 10),
      scope: 'daily-per-dimension-marginals',
      publisher: 'kontour',
      minimumDistinctDailyClients: 10,
      privacyUnit: 'daily-salted-IPv4-or-IPv6-/48',
      dayBasis: 'UTC-receiver-arrival',
      deliveryCoverage: 'unknown',
      days: [],
    });
  const app = createProductBroker({ ...store, lite }, operatorKey);
  try {
    const first = app.request('/v1/public/aggregates'),
      second = app.request('/v1/public/aggregates');
    await vi.waitFor(() => expect(reads).toHaveBeenCalledTimes(1));
    refuse(new Error('fixture database unavailable'));
    for (const response of await Promise.all([first, second])) {
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect((await app.request('/v1/public/aggregates')).status).toBe(200);
    expect(reads).toHaveBeenCalledTimes(2);
    vi.setSystemTime(new Date('2026-10-18T00:00:00Z'));
    expect((await app.request('/v1/public/aggregates')).status).toBe(200);
    expect(reads).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
  }
});

test.each([1, 10])(
  'secondary suppression protects the complement with %i minority pings, including sets and publisher reads',
  async (minorityPings) => {
    const db = new PGlite();
    const sqlClient = (
      connection: Pick<PGliteInterface, 'query' | 'exec'>,
    ) => ({
      async query<Row extends QueryResultRow = QueryResultRow>(
        text: string,
        values?: unknown[],
      ) {
        if (text.includes(';')) {
          await connection.exec(text);
          return { rows: [], rowCount: 0 };
        }
        const result = await connection.query<Row>(text, values);
        return { rows: result.rows, rowCount: result.affectedRows ?? 0 };
      },
    });
    const client = sqlClient(db);
    const lite = new LiteRepository(
      (operation) => db.transaction((tx) => operation(sqlClient(tx))),
      1000,
      1_073_741_824,
    );
    try {
      await db.exec(
        'CREATE SCHEMA station_telemetry; CREATE TABLE station_telemetry.migrations(version integer PRIMARY KEY,digest text NOT NULL)',
      );
      await migrateLite(client);
      await migrateLite(client);
      await db.transaction((tx) => assertLiteSchema(sqlClient(tx)));
      await lite.createSource({
        id: 'kontour-stable',
        publisher: 'kontour',
        channel: 'stable',
        registryIds: ['public.plugin'],
        releaseVersions: ['1.2.3'],
      });
      await lite.createSource({
        id: 'publisher-stable',
        publisher: 'publisher:example',
        channel: 'stable',
        registryIds: ['public.plugin'],
        releaseVersions: ['1.2.3'],
      });
      const publisherKey = `stq_${'q'.repeat(43)}`;
      await lite.setPublisherKey(
        'publisher:example',
        createHash('sha256').update(publisherKey).digest('hex'),
      );
      await expect(
        lite.ingest('kontour-stable', dailyPing(), {
          day: '2000-01-01',
          hash: 'a'.repeat(64),
        }),
      ).rejects.toMatchObject({ code: 'storage_busy' });
      expect(
        (await db.query('SELECT pings FROM station_telemetry.lite_capacity'))
          .rows,
      ).toEqual([{ pings: 0 }]);
      const app = createProductBroker({ ...store, lite }, operatorKey);
      const send = (
        address: string,
        platform: 'linux' | 'darwin',
        count: number,
        source = 'kontour-stable',
      ) =>
        app.request(
          `/v1/lite/${source}`,
          post({
            ...dailyPing(),
            platform,
            safe_mode_entered: count,
            public_plugins_enabled:
              platform === 'darwin' ? [] : ['public.plugin'],
            surfaces_today: platform === 'darwin' ? ['cli'] : ['web', 'cli'],
          }),
          socketBindings(address),
        );
      // Common marginals reach k despite each observation having a different counter.
      for (let i = 0; i < 10; i++)
        expect(
          (await send(`198.51.100.${i + 1}`, 'linux', 100 + i)).status,
        ).toBe(202);
      // Reviewer's padding probe: one victim plus nine pings from one attacker network.
      expect((await send('203.0.113.1', 'darwin', 0)).status).toBe(202);
      for (let i = 1; i < minorityPings; i++)
        expect((await send('203.0.113.2', 'darwin', 0)).status).toBe(202);
      for (let i = 0; i < 9; i++)
        expect(
          (await send(`192.0.2.${i + 1}`, 'darwin', 1, 'publisher-stable'))
            .status,
        ).toBe(202);
      await lite.createSource({
        id: 'ipv6',
        publisher: 'publisher:ipv6',
        channel: 'stable',
        registryIds: ['public.plugin'],
        releaseVersions: ['1.2.3'],
      });
      // One /56 can supply many rate-limit /64s but only one contributor /48.
      for (let i = 0; i < 10; i++)
        expect(
          (
            await send(
              `2001:db8:1234:${i.toString(16)}::1`,
              'darwin',
              1,
              'ipv6',
            )
          ).status,
        ).toBe(202);
      // Time travel only the fixture database, then use the production finalizer.
      await db.exec(
        `UPDATE station_telemetry.lite_marginals SET day=day-1,publishable=true; UPDATE station_telemetry.lite_clients SET day=day-1; UPDATE station_telemetry.lite_pings SET received_at=received_at-interval '1 day'`,
      );
      expect((await lite.aggregates('kontour')).days).toEqual([]);
      // First public read finalizes yesterday before caching; no hourly sweep has run.
      expect((await app.request('/v1/public/aggregates')).status).toBe(200);
      expect(
        (await db.query('SELECT * FROM station_telemetry.lite_clients')).rows,
      ).toHaveLength(0);
      expect((await lite.aggregates('publisher:ipv6')).days).toEqual([]);
      const result = await lite.aggregates('kontour');
      expect(result.days).toHaveLength(1);
      expect(result.days[0].distributions.platform).toBeUndefined();
      expect(
        result.days[0].distributions.public_plugins_enabled,
      ).toBeUndefined();
      expect(result.days[0].distributions.surfaces_today).toEqual({
        cli: 10 + minorityPings,
        web: 10,
      });
      expect(result.days[0].distributions.safe_mode_entered).toBeUndefined();
      expect(result.days[0].distributions.first_active_this_week).toEqual({
        true: 10 + minorityPings,
      });
      expect(result.days[0]).not.toHaveProperty('representedPings');
      expect(
        (await (await app.request('/v1/public/aggregates')).json()).days,
      ).toEqual(result.days);
      expect(
        (
          await db.query(
            'SELECT client_hash,contributions FROM station_telemetry.lite_pings WHERE client_hash IS NOT NULL OR contributions IS NOT NULL',
          )
        ).rows,
      ).toEqual([]);
      expect(
        (await lite.aggregates('publisher:example', publisherKey)).days,
      ).toEqual([]);
      await expect(
        lite.aggregates('kontour', publisherKey),
      ).rejects.toMatchObject({ code: 'source_unauthorized' });
    } finally {
      await db.close();
    }
  },
);

test.each(['404', 'bad-key', 'publisher'])(
  'anonymous %s traffic cannot exhaust authenticated per-credential admission',
  async (traffic) => {
    const transaction = vi.fn(async () => {
      throw new BrokerError('source_unauthorized');
    });
    const lite = new LiteRepository(transaction, 100, 100);
    store.authenticate.mockImplementation(async (key) => {
      if (key !== sourceKey && key !== `stp_${'c'.repeat(43)}`)
        throw new BrokerError('source_unauthorized');
    });
    const app = createProductBroker({ ...store, lite }, operatorKey);
    for (let i = 0; i < 61; i++) {
      const response = await (traffic === '404'
        ? app.request('/unknown')
        : traffic === 'bad-key'
          ? app.request(
              '/v1/product/events',
              post(batch(), `stp_${'z'.repeat(43)}`),
            )
          : app.request('/v1/publishers/kontour/aggregates'));
      expect(response.status).toBe(
        i < 60 ? (traffic === '404' ? 404 : 401) : 429,
      );
    }
    expect(transaction).not.toHaveBeenCalled();
    for (let i = 0; i < 60; i++)
      expect(
        (await app.request('/v1/product/events', post(batch()))).status,
      ).toBe(202);
    expect(
      (await app.request('/v1/product/events', post(batch()))).status,
    ).toBe(429);
    expect(
      (
        await app.request(
          '/v1/product/events',
          post(batch(), `stp_${'c'.repeat(43)}`),
        )
      ).status,
    ).toBe(202);
  },
);

test('public reads do not cache a database cutoff behind the receiver day', async () => {
  const lite = new LiteRepository(
    async () => {
      throw new BrokerError('source_unauthorized');
    },
    100,
    100,
  );
  const result = {
    scope: 'daily-per-dimension-marginals',
    publisher: 'kontour',
    minimumDistinctDailyClients: 10,
    privacyUnit: 'daily-salted-IPv4-or-IPv6-/48',
    dayBasis: 'UTC-receiver-arrival',
    deliveryCoverage: 'unknown',
    days: [],
  };
  const reads = vi
    .spyOn(lite, 'publicAggregates')
    .mockResolvedValueOnce({ ...result, finalizedBeforeDay: '2000-01-01' })
    .mockResolvedValue({
      ...result,
      finalizedBeforeDay: new Date().toISOString().slice(0, 10),
    });
  const app = createProductBroker({ ...store, lite }, operatorKey);
  expect(
    (await app.request('/v1/public/aggregates')).headers.get('cache-control'),
  ).toBe('no-store');
  expect(
    (await app.request('/v1/public/aggregates')).headers.get('cache-control'),
  ).toMatch(/^public/);
  expect((await app.request('/v1/public/aggregates')).status).toBe(200);
  expect(reads).toHaveBeenCalledTimes(2);
});
