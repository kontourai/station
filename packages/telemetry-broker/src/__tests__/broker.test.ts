import { USAGE_TELEMETRY_INVENTORY_REVISION } from '@kontourai/station-shared/product-telemetry';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createProductBroker } from '../app.js';
import {
  BrokerError,
  type ProductCommit,
  type ProductRepository,
} from '../store.js';

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
  ingest: vi.fn<ProductRepository['ingest']>(),
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
});
const post = (body: unknown, key = sourceKey) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': key },
  body: JSON.stringify(body),
});
describe('product receiver HTTP admission and acknowledgement boundary', () => {
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
