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

const frame =
  'event: orchestration:session-projection-updated\ndata: {"threadId":"probe"}\n\n';
let sequence = 0;
const cleanups: (() => void)[] = [];

function setup(stallSecond: boolean) {
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
      if (stallSecond && read === 2) {
        // A transport returns headers but never completes or aborts its body.
        return new Response(new ReadableStream({ start() {} }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      return Response.json({
        success: true,
        data: [{ threadId: `read-${read}` }],
      });
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
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

test('a stalled SDK response body settles at its deadline and dispatches the owed refresh', async () => {
  const p = setup(true);
  expect(getClientRequestTimeout()).toBeUndefined();
  await vi.advanceTimersByTimeAsync(3_000);
  p.push(frame);
  await vi.advanceTimersByTimeAsync(100);
  p.push(frame);
  await vi.advanceTimersByTimeAsync(DEFAULT_CLIENT_REQUEST_TIMEOUT_MS - 101);
  expect(p.started()).toBe(2);
  await vi.advanceTimersByTimeAsync(2);
  expect(p.started()).toBe(3);
  expect(p.results).toContainEqual(
    expect.objectContaining({
      name: 'StationRequestTimeoutError',
      timeoutMs: DEFAULT_CLIENT_REQUEST_TIMEOUT_MS,
    }),
  );
  await vi.advanceTimersByTimeAsync(3_000);
  expect(p.observer.getCurrentResult().data?.[0].threadId).toBe('read-3');
  expect(p.client.isFetching({ queryKey: ['orchestration-sessions'] })).toBe(0);
});

test('only the last registration release clears the pending settle subscription', async () => {
  const p = setup(true);
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
  const p = setup(false);
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
