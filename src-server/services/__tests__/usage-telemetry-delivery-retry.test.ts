/**
 * #4994: a receiver's permanent refusal drops the batch instead of blocking
 * the queue forever; retryable failures back off (honouring Retry-After), and
 * a repeated identical failure warns once. Exercised at the service seam with
 * a fake transport.
 */
import type { AppConfig } from '@kontourai/station-contracts/config';
import type { ProductTelemetryBatch } from '@kontourai/station-contracts/product-telemetry';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import {
  usageTelemetryBatches,
  usageTelemetrySuppressedWarnings,
} from '../../telemetry/metrics.js';
import { FULL_TELEMETRY_ACKNOWLEDGEMENT_REVISION } from '../usage-telemetry-inventory.js';
import { UsageTelemetryService } from '../usage-telemetry-service.js';

const makeTempDir = trackTempDirs();
const ENDPOINT = 'https://ingest.test/v1/product/events';
const START = Date.parse('2026-11-15T12:00:00.000Z');

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function configuredApp(): AppConfig {
  return {
    defaultModel: 'configured-model',
    invokeModel: 'configured-model',
    structureModel: 'configured-model',
    telemetryEnabled: true,
  };
}

function accepted(init?: RequestInit): Response {
  const batch = JSON.parse(String(init?.body)) as ProductTelemetryBatch;
  return Response.json(
    {
      receipt: {
        protocol: 'station-product-commit/v1',
        receiptId: '11111111-2222-4333-8444-555555555555',
        sourceId: '22222222-2222-4333-8444-555555555555',
        eventIds: batch.events.map((event) => event.event_id),
        inserted: batch.events.length,
        alreadyPresent: 0,
        storedAt: '2026-11-15T12:00:00.000Z',
      },
    },
    { status: 202 },
  );
}

type Answer =
  | { status: number; body?: string; headers?: Record<string, string> }
  | 'network'
  | 'accept';

/** A fake transport answering each request with the next scripted answer. */
function transport(...answers: Answer[]) {
  const sent: ProductTelemetryBatch[] = [];
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as ProductTelemetryBatch);
    const answer = answers.shift() ?? 'accept';
    if (answer === 'network') throw new TypeError('fetch failed');
    if (answer === 'accept') return accepted(init);
    return new Response(answer.body ?? null, {
      status: answer.status,
      headers: answer.headers,
    });
  });
  return { fetch, sent };
}

async function subject(fetch: typeof globalThis.fetch) {
  const logger = { warn: vi.fn(), debug: vi.fn() };
  const service = new UsageTelemetryService({
    homeDir: makeTempDir('station-telemetry-retry-'),
    appConfig: configuredApp(),
    version: '1.2.3',
    logger,
    env: {
      STATION_STDOUT_HANDSHAKE: '1',
      STATION_PRODUCT_TELEMETRY_ENDPOINT: ENDPOINT,
    },
    fetch,
    setInterval: vi.fn() as unknown as typeof setInterval,
  });
  await service.acknowledgeDisclosure(FULL_TELEMETRY_ACKNOWLEDGEMENT_REVISION);
  const track = () =>
    service.track('engine_turn', { engine: 'codex', outcome: 'completed' });
  const at = (ms: number) => vi.setSystemTime(START + ms);
  return { service, logger, track, at };
}

function clock() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
}

describe('usage telemetry delivery failures (#4994)', () => {
  test('a 400 drops the batch with its sanitized reason and the next batch sends', async () => {
    clock();
    const hash = 'a'.repeat(64);
    const { fetch, sent } = transport({
      status: 400,
      body: JSON.stringify({
        error: 'invalid_product_batch',
        message: `distinct_id ${hash} rejected; key stp_${'x'.repeat(43)}`,
        events: [{ event: 'engine_turn' }],
      }),
    });
    const { service, track } = await subject(fetch);
    try {
      await track();
      await service.flush();
      expect(service.bufferedCount, 'a 400 left the batch queued').toBe(0);
      const status = await service.deliveryStatus();
      expect(status).toMatchObject({
        phase: 'failed',
        queued: 0,
        counts: { rejected: 1, failedAttempts: 1, acknowledged: 0 },
        lastFailure: { code: 'http_refused', httpStatus: 400 },
      });
      const detail = status.lastFailure?.detail ?? '';
      expect(detail).toMatch(/^invalid_product_batch: distinct_id \[id\]/);
      expect(detail.length).toBeLessThanOrEqual(200);
      expect(detail).not.toContain(hash);
      expect(detail).not.toContain('x'.repeat(43));
      expect(detail).not.toContain('engine_turn');
      expect(await service.outbox('operator')).toContainEqual(
        expect.objectContaining({
          outcome: 'dropped',
          reason: 'rejected',
          payload: { event: 'telemetry_dropped', count: 1 },
        }),
      );

      // The receiver answered, so the next batch is not deferred.
      await track();
      await service.flush();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(sent[1].events.map((event) => event.event_id)).not.toContain(
        sent[0].events[0].event_id,
      );
      expect(await service.deliveryStatus()).toMatchObject({
        phase: 'acknowledged',
        queued: 0,
        counts: { acknowledged: 1 },
      });
    } finally {
      await service.shutdown();
    }
  });

  test.each([
    [401, 'dropped'],
    [404, 'dropped'],
    [413, 'dropped'],
    [422, 'dropped'],
    [408, 'retained'],
    [429, 'retained'],
    [500, 'retained'],
    [503, 'retained'],
  ] as const)('HTTP %i leaves the batch %s', async (status, expected) => {
    clock();
    const { fetch } = transport({ status });
    const { service, track } = await subject(fetch);
    try {
      await track();
      await service.flush();
      expect(service.bufferedCount).toBe(expected === 'dropped' ? 0 : 1);
    } finally {
      await service.shutdown();
    }
  });

  test('a 503 with Retry-After defers the retry until the server asked', async () => {
    clock();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { fetch } = transport({
      status: 503,
      headers: { 'retry-after': '120' },
    });
    const { service, logger, track, at } = await subject(fetch);
    try {
      await track();
      await service.flush();
      expect(service.bufferedCount).toBe(1);
      expect(logger.warn).toHaveBeenCalledWith(
        'Usage telemetry batch failed; retry scheduled.',
        expect.objectContaining({ retryInMs: 120_000, publisher: 'operator' }),
      );
      // Past the exponential backoff alone (5s here) but before Retry-After.
      at(60_000);
      await service.flush();
      expect(fetch, 'retried before Retry-After elapsed').toHaveBeenCalledTimes(
        1,
      );
      at(120_000);
      await service.flush();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(service.bufferedCount).toBe(0);
    } finally {
      await service.shutdown();
    }
  });

  test('a network error backs off exponentially, gates batch-full flushes, then succeeds', async () => {
    clock();
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const { fetch } = transport('network', 'network', 'network');
    const { service, logger, track, at } = await subject(fetch);
    const retryDelays = () =>
      [...logger.warn.mock.calls, ...logger.debug.mock.calls]
        .map(([, context]) => (context as { retryInMs?: number }).retryInMs)
        .filter((delay) => delay !== undefined);
    try {
      await track();
      await service.flush();
      expect(service.bufferedCount).toBe(1);
      // A batch-full flush during the backoff sends nothing: this was the
      // path that resent a refused batch every few seconds.
      for (let index = 0; index < 19; index++) await track();
      await service.flush();
      expect(fetch).toHaveBeenCalledTimes(1);
      at(10_000);
      await service.flush();
      at(10_000 + 20_000);
      await service.flush();
      expect(retryDelays()).toEqual([10_000, 20_000, 40_000]);
      at(10_000 + 20_000 + 39_999);
      await service.flush();
      expect(fetch).toHaveBeenCalledTimes(3);
      at(10_000 + 20_000 + 40_000);
      await service.flush();
      expect(fetch).toHaveBeenCalledTimes(4);
      expect(await service.deliveryStatus()).toMatchObject({
        phase: 'acknowledged',
        queued: 0,
        counts: { acknowledged: 20, failedAttempts: 3 },
      });
    } finally {
      await service.shutdown();
    }
  });

  test('repeated identical failures warn once until the failure changes or delivery succeeds', async () => {
    clock();
    const { fetch } = transport(
      { status: 400 },
      { status: 400 },
      { status: 400 },
      { status: 503 },
      'accept',
      { status: 400 },
    );
    const { service, logger, track, at } = await subject(fetch);
    const warned = () =>
      logger.warn.mock.calls
        .filter(([message]) =>
          String(message).startsWith('Usage telemetry batch'),
        )
        .map(([message, context]) => [
          message,
          (context as { error: string }).error,
        ]);
    try {
      for (let index = 0; index < 3; index++) {
        await track();
        await service.flush();
      }
      expect(warned()).toEqual([
        ['Usage telemetry batch rejected; dropped.', 'http_refused: HTTP 400'],
      ]);
      expect(logger.debug).toHaveBeenCalledTimes(2);
      await track();
      await service.flush();
      at(60 * 60_000);
      await service.flush();
      await track();
      await service.flush();
      expect(warned()).toEqual([
        ['Usage telemetry batch rejected; dropped.', 'http_refused: HTTP 400'],
        [
          'Usage telemetry batch failed; retry scheduled.',
          'http_refused: HTTP 503',
        ],
        ['Usage telemetry batch rejected; dropped.', 'http_refused: HTTP 400'],
      ]);
      expect(fetch).toHaveBeenCalledTimes(6);
    } finally {
      await service.shutdown();
    }
  });

  test('batch outcomes and suppressed warnings are counted with bounded attributes', async () => {
    clock();
    const batches = vi.spyOn(usageTelemetryBatches, 'add');
    const suppressed = vi.spyOn(usageTelemetrySuppressedWarnings, 'add');
    const { fetch } = transport(
      { status: 400 },
      { status: 400 },
      { status: 503 },
      'accept',
    );
    const { service, track, at } = await subject(fetch);
    try {
      await track();
      await service.flush();
      await track();
      await service.flush();
      await track();
      await service.flush();
      at(60 * 60_000);
      await service.flush();
      // Without an SDK every instrument is one shared no-op, so each spy sees
      // every add; select by each instrument's own attribute shape.
      const calls = (spy: typeof batches) =>
        spy.mock.calls.map(
          ([value, attributes]) =>
            [value, attributes ?? {}] as [number, Record<string, unknown>],
        );
      expect(
        calls(batches).filter(([, attributes]) => 'status_class' in attributes),
      ).toEqual([
        [
          1,
          {
            publisher: 'operator',
            outcome: 'rejected',
            code: 'http_refused',
            status_class: '4xx',
          },
        ],
        [
          1,
          {
            publisher: 'operator',
            outcome: 'rejected',
            code: 'http_refused',
            status_class: '4xx',
          },
        ],
        [
          1,
          {
            publisher: 'operator',
            outcome: 'retry_scheduled',
            code: 'http_refused',
            status_class: '5xx',
          },
        ],
        [
          1,
          {
            publisher: 'operator',
            outcome: 'acknowledged',
            status_class: '2xx',
          },
        ],
      ]);
      expect(
        calls(suppressed).filter(
          ([, attributes]) =>
            !('outcome' in attributes) && 'code' in attributes,
        ),
      ).toEqual([[1, { publisher: 'operator', code: 'http_refused' }]]);
    } finally {
      await service.shutdown();
    }
  });
});
