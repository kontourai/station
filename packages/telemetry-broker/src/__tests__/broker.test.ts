import type { ProductTelemetryCommitReceipt as ProductCommit } from '@kontourai/station-contracts/product-telemetry';
import {
  FULL_TELEMETRY_ACKNOWLEDGEMENT_REVISION,
  PRODUCT_TELEMETRY_DATA_INVENTORY_REVISION,
} from '@kontourai/station-shared/product-telemetry';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createProductBroker } from '../app.js';
import { BrokerError } from '../broker-error.js';
import { clientAddressPolicy } from '../client-address.js';
import { LiteRepository } from '../lite-store.js';
import type { ProductRepository } from '../store.js';
import { socketBindings } from './lite-fixture.js';

const operatorKey = `sto_${'a'.repeat(43)}`;
const sourceKey = `stp_${'b'.repeat(43)}`;
const batch = () => ({
  schema_version: 1,
  inventory_revision: PRODUCT_TELEMETRY_DATA_INVENTORY_REVISION,
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
  hasCredential: vi.fn<ProductRepository['hasCredential']>(),
  authenticate: vi.fn<ProductRepository['authenticate']>(),
  ingest: vi.fn<ProductRepository['ingest']>(),
  probe: vi.fn<ProductRepository['probe']>(),
  createSource: vi.fn<ProductRepository['createSource']>(),
  revokeSource: vi.fn<ProductRepository['revokeSource']>(),
  receipt: vi.fn<ProductRepository['receipt']>(),
  trends: vi.fn<ProductRepository['trends']>(),
  incidents: vi.fn(),
  ready: vi.fn<ProductRepository['ready']>(),
};
beforeEach(() => {
  vi.resetAllMocks();
  store.hasCredential.mockImplementation(
    (key) => key === sourceKey || key === `stp_${'c'.repeat(43)}`,
  );
  store.ingest.mockResolvedValue(commit);
  store.ready.mockResolvedValue();
  store.probe.mockResolvedValue({
    protocol: 'station-product-probe/v1',
    sourceId: commit.sourceId,
    inventoryRevision: PRODUCT_TELEMETRY_DATA_INVENTORY_REVISION,
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
        inventoryRevision: PRODUCT_TELEMETRY_DATA_INVENTORY_REVISION,
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      probe: {
        protocol: 'station-product-probe/v1',
        sourceId: commit.sourceId,
        inventoryRevision: PRODUCT_TELEMETRY_DATA_INVENTORY_REVISION,
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
      inventoryRevision: PRODUCT_TELEMETRY_DATA_INVENTORY_REVISION,
    },
    { protocol: 'station-product-probe/v1', inventoryRevision: 'stale' },
    {
      protocol: 'station-product-probe/v1',
      inventoryRevision: PRODUCT_TELEMETRY_DATA_INVENTORY_REVISION,
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
          inventoryRevision: PRODUCT_TELEMETRY_DATA_INVENTORY_REVISION,
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
    databaseDay: new Date().toISOString().slice(0, 10),
    scope: 'weekly-fixed-domain-marginals',
    publisher: 'kontour',
    epsilonPerCount: 1 / 280,
    epsilonPerAddedPing: 1 / 7,
    maximumPublicCoordinatesPerWeek: 0,
    maximumNetworkWeekEpsilon: 0,
    nextCursor: null,
    privacyUnit: 'distinct-daily-network-key-per-value',
    countUnit: 'network-days',
    weekBasis: 'ISO-8601-UTC-receiver-arrival',
    deliveryCoverage: 'unknown',
    cells: [],
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
      databaseDay: new Date().toISOString().slice(0, 10),
      scope: 'weekly-fixed-domain-marginals',
      publisher: 'kontour',
      epsilonPerCount: 1 / 280,
      epsilonPerAddedPing: 1 / 7,
      maximumPublicCoordinatesPerWeek: 0,
      maximumNetworkWeekEpsilon: 0,
      nextCursor: null,
      privacyUnit: 'distinct-daily-network-key-per-value',
      countUnit: 'network-days',
      weekBasis: 'ISO-8601-UTC-receiver-arrival',
      deliveryCoverage: 'unknown',
      cells: [],
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
    scope: 'weekly-fixed-domain-marginals',
    publisher: 'kontour',
    epsilonPerCount: 1 / 280,
    epsilonPerAddedPing: 1 / 7,
    maximumPublicCoordinatesPerWeek: 0,
    maximumNetworkWeekEpsilon: 0,
    nextCursor: null,
    privacyUnit: 'distinct-daily-network-key-per-value',
    countUnit: 'network-days',
    weekBasis: 'ISO-8601-UTC-receiver-arrival',
    deliveryCoverage: 'unknown',
    cells: [],
  };
  const reads = vi
    .spyOn(lite, 'publicAggregates')
    .mockResolvedValueOnce({ ...result, databaseDay: '2000-01-01' })
    .mockResolvedValue({
      ...result,
      databaseDay: new Date().toISOString().slice(0, 10),
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

test('wording-only acknowledgement revision does not alter broker wire admission', async () => {
  const app = createProductBroker(store, operatorKey);
  const accepted = await app.request('/v1/product/events', post(batch()));
  expect(accepted.status).toBe(202);
  expect(
    (await (await app.request('/health/live')).json()).inventoryRevision,
  ).toBe(PRODUCT_TELEMETRY_DATA_INVENTORY_REVISION);
  expect(FULL_TELEMETRY_ACKNOWLEDGEMENT_REVISION).not.toBe(
    PRODUCT_TELEMETRY_DATA_INVENTORY_REVISION,
  );
  expect(
    (
      await app.request(
        '/v1/product/events',
        post({
          ...batch(),
          inventory_revision: FULL_TELEMETRY_ACKNOWLEDGEMENT_REVISION,
        }),
      )
    ).status,
  ).toBe(400);
  expect(store.ingest).toHaveBeenCalledTimes(1);
});

test('trusted tunnel peers receive 404 for private routes even with valid credentials; direct peers retain access', async () => {
  store.receipt.mockResolvedValue(commit);
  const app = createProductBroker(
    store,
    operatorKey,
    clientAddressPolicy('192.0.2.2/32'),
  );
  const routes: [string, RequestInit, number][] = [
    [
      '/v1/operator/storage',
      { headers: { authorization: `Bearer ${operatorKey}` } },
      200,
    ],
    [
      '/v1/operator/diagnostics',
      { headers: { authorization: `Bearer ${operatorKey}` } },
      200,
    ],
    ['/v1/product/events', post(batch()), 202],
    [
      '/v1/product/probes',
      post({
        protocol: 'station-product-probe/v1',
        inventoryRevision: PRODUCT_TELEMETRY_DATA_INVENTORY_REVISION,
      }),
      200,
    ],
    [
      '/v1/product/receipts/11111111-2222-4333-8444-555555555555',
      { headers: { 'x-api-key': sourceKey } },
      200,
    ],
  ];
  for (const [path, init, directStatus] of routes) {
    expect(
      (await app.request(path, init, socketBindings('192.0.2.2'))).status,
      path,
    ).toBe(404);
    expect(
      (await app.request(path, init, socketBindings('100.64.0.1'))).status,
      path,
    ).toBe(directStatus);
  }
  for (const path of ['/health/live', '/v1/public/aggregates', '/public/'])
    expect(
      (await app.request(path, { method: 'POST' }, socketBindings('192.0.2.2')))
        .status,
    ).toBe(404);
  expect(
    (await app.request('/health/live', undefined, socketBindings('192.0.2.2')))
      .status,
  ).toBe(200);
  // Hono normally routes HEAD through GET. The tunnel boundary permits GET only.
  expect(
    (
      await app.request(
        '/health/live',
        { method: 'HEAD' },
        socketBindings('192.0.2.2'),
      )
    ).status,
  ).toBe(404);
});
