/** @vitest-environment jsdom */
import { fetchOrchestrationSessions } from '@kontourai/station-sdk';
import {
  DEFAULT_CLIENT_REQUEST_TIMEOUT_MS,
  getClientRequestTimeout,
} from '@kontourai/station-sdk/client';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, expect, test, vi } from 'vitest';
import {
  ensureOrchestrationEventStream,
  resetSessionReadModelRefreshForTests,
} from '../hooks/orchestration/ensureOrchestrationEventStream';
import { stationQueryDefaults } from '../lib/queryDefaults';

const frame =
  'event: orchestration:session-projection-updated\ndata: {"threadId":"probe"}\n\n';
let sequence = 0;
const cleanups: (() => void)[] = [];

type TransportMode =
  | 'healthy'
  | 'body-stall'
  | 'headers-stall'
  | 'slow'
  | 'repeat-stall';

function setup(mode: TransportMode, productionRetries = false) {
  resetSessionReadModelRefreshForTests();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  // jsdom's native AbortSignal.timeout does not use Vitest's clock.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(
      () => controller.abort(new DOMException('Timed out', 'TimeoutError')),
      ms,
    );
    return controller.signal;
  });
  const origin = `https://read-model-deadline-${++sequence}.example.test`;
  let push!: (frame: string) => void;
  const sse = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        push = (value) => controller.enqueue(new TextEncoder().encode(value));
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
  let started = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${origin}/api/orchestration/events`) return sse;
      if (url !== `${origin}/api/orchestration/sessions/read-model`)
        throw new Error(`Unexpected request: ${url}`);
      const read = ++started;
      if (mode === 'headers-stall' && read === 2) {
        // Deliberately non-cooperative: the SDK must settle even if abort is ignored.
        return new Promise<Response>(() => {});
      }
      if (
        (mode === 'body-stall' && read === 2) ||
        (mode === 'repeat-stall' && read > 1)
      ) {
        return new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              await new Promise((resolve) => setTimeout(resolve, 5_000));
              controller.enqueue(
                new TextEncoder().encode('{"success":true,"data":['),
              );
            },
          }),
          {
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      if (mode === 'slow' && read === 1) {
        const bytes = new TextEncoder().encode(
          JSON.stringify({
            success: true,
            data: [{ threadId: 'slow-read', title: 'x'.repeat(1_000_000) }],
          }),
        );
        let offset = 0;
        return new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              await new Promise((resolve) => setTimeout(resolve, 1_000));
              const chunk = bytes.subarray(offset, offset + 25_001);
              offset += chunk.byteLength;
              controller.enqueue(chunk);
              if (offset === bytes.byteLength) controller.close();
            },
          }),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      return Response.json({
        success: true,
        data: [{ threadId: `read-${read}` }],
      });
    }),
  );
  const client = new QueryClient({
    defaultOptions: {
      queries: productionRetries ? stationQueryDefaults() : { retry: false },
    },
  });
  const results: unknown[] = [];
  const observer = new QueryObserver(client, {
    queryKey: ['orchestration-sessions'],
    queryFn: () => fetchOrchestrationSessions(origin),
    staleTime: Infinity,
  });
  const stop = observer.subscribe((result) => {
    if (result.error) results.push(result.error);
  });
  const release = ensureOrchestrationEventStream(origin, client);
  cleanups.push(() => {
    release();
    stop();
    client.clear();
    window.dispatchEvent(
      Object.assign(new Event('pagehide'), { persisted: false }),
    );
  });
  return {
    push,
    client,
    observer,
    release,
    results,
    origin,
    started: () => started,
  };
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  resetSessionReadModelRefreshForTests();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test.each(['body-stall', 'headers-stall'] as const)(
  '%s settles and dispatches the owed refresh through the SDK',
  async (mode) => {
    const p = setup(mode);
    const progressAt = mode === 'body-stall' ? 5_000 : 0;
    expect(getClientRequestTimeout()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(3_000);
    p.push(frame);
    await vi.advanceTimersByTimeAsync(100);
    p.push(frame);
    await vi.advanceTimersByTimeAsync(
      DEFAULT_CLIENT_REQUEST_TIMEOUT_MS + progressAt - 101,
    );
    expect(p.started()).toBe(2);
    await vi.advanceTimersByTimeAsync(2);
    expect(p.started()).toBe(3);
    expect(p.results).toContainEqual(
      expect.objectContaining({
        name: 'StationRequestTimeoutError',
        timeoutMs: DEFAULT_CLIENT_REQUEST_TIMEOUT_MS,
        method: 'GET',
        mutation: false,
      }),
    );
    expect(p.observer.getCurrentResult().data?.[0].threadId).toBe('read-1');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(p.observer.getCurrentResult().data?.[0].threadId).toBe('read-3');
    expect(p.client.isFetching({ queryKey: ['orchestration-sessions'] })).toBe(
      0,
    );
  },
);

test('a progressing megabyte session list lands after 40 seconds despite projection events and production retries', async () => {
  const p = setup('slow', true);
  for (let second = 0; second < 41; second++) {
    p.push(frame);
    await vi.advanceTimersByTimeAsync(1_000);
    if (second < 39) expect(p.started()).toBe(1);
  }
  expect(p.client.getQueryData(['orchestration-sessions'])).toEqual([
    expect.objectContaining({
      threadId: 'slow-read',
      title: 'x'.repeat(1_000_000),
    }),
  ]);
  expect(p.observer.getCurrentResult().data?.[0].threadId).toBe('slow-read');
  expect(p.results).toEqual([]);
  await vi.advanceTimersByTimeAsync(3_000);
  expect(p.observer.getCurrentResult().data?.[0].threadId).toBe('read-2');
});

test('repeated idle timeouts with production retries keep the last-known session list visible', async () => {
  const p = setup('repeat-stall', true);
  await vi.advanceTimersByTimeAsync(3_000);
  for (let second = 0; second < 180; second++) {
    p.push(frame);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(p.client.getQueryData(['orchestration-sessions'])).toEqual([
      expect.objectContaining({ threadId: 'read-1' }),
    ]);
    expect(p.observer.getCurrentResult().data?.[0].threadId).toBe('read-1');
  }
  expect(p.started()).toBeGreaterThanOrEqual(5);
  expect(p.started()).toBeLessThanOrEqual(7);
  expect(p.results).toContainEqual(
    expect.objectContaining({
      name: 'StationRequestTimeoutError',
      method: 'GET',
      mutation: false,
    }),
  );
});

test('only the last registration release clears the pending settle subscription', async () => {
  const p = setup('body-stall');
  await vi.advanceTimersByTimeAsync(3_000);
  const cache = p.client.getQueryCache();
  const subscribe = cache.subscribe.bind(cache);
  let activeSubscriptions = 0;
  vi.spyOn(cache, 'subscribe').mockImplementation((listener) => {
    activeSubscriptions++;
    const stop = subscribe(listener);
    return () => {
      activeSubscriptions--;
      stop();
    };
  });
  const releaseOther = ensureOrchestrationEventStream(p.origin, p.client);
  p.push(frame);
  await vi.advanceTimersByTimeAsync(100);
  p.push(frame);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(activeSubscriptions).toBe(1);
  p.release();
  expect(activeSubscriptions).toBe(1);
  releaseOther();
  expect(activeSubscriptions).toBe(0);
  await vi.advanceTimersByTimeAsync(DEFAULT_CLIENT_REQUEST_TIMEOUT_MS + 3_000);
  expect(p.started()).toBe(2);
});

test('the last registration release clears the deferred refresh timer', async () => {
  const p = setup('healthy');
  await vi.advanceTimersByTimeAsync(3_000);
  p.push(frame);
  await vi.advanceTimersByTimeAsync(100);
  p.push(frame);
  await vi.advanceTimersByTimeAsync(100);
  const before = vi.getTimerCount();
  p.release();
  expect(vi.getTimerCount()).toBe(before - 1);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(p.started()).toBe(2);
});
