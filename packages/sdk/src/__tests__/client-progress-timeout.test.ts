import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  authenticatedFetch,
  setClientCredentialResolver,
  setClientRequestTimeout,
} from '../client/http';

const URL_UNDER_TEST = 'https://station.example.test/api/agents';

afterEach(() => {
  setClientCredentialResolver(undefined);
  setClientRequestTimeout(undefined);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe.each([
  { name: 'progress timeout', options: { progressTimeoutMs: 30_000 } },
  { name: 'total deadline', options: { timeoutMs: 30_000 } },
])('$name Request cancellation', ({ options }) => {
  it('rejects an already-aborted Request before dispatch', async () => {
    const caller = new AbortController();
    const reason = new Error('already unmounted');
    caller.abort(reason);
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      authenticatedFetch(
        new Request(URL_UNDER_TEST, { signal: caller.signal }),
        options,
      ),
    ).rejects.toBe(reason);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { source: 'request', withInit: false },
    { source: 'request', withInit: true },
    { source: 'init', withInit: true },
  ])(
    'settles the body reader on $source cancellation (init signal: $withInit)',
    async ({ source, withInit }) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      let sentSignal: AbortSignal | null | undefined;
      let bodyController!: ReadableStreamDefaultController<Uint8Array>;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          sentSignal =
            init?.signal ??
            (input instanceof Request ? input.signal : undefined);
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                bodyController = controller;
                sentSignal?.addEventListener(
                  'abort',
                  () => controller.error(sentSignal?.reason),
                  { once: true },
                );
              },
            }),
          );
        }),
      );
      const caller = new AbortController();
      const explicit = new AbortController();
      const response = await authenticatedFetch(
        new Request(URL_UNDER_TEST, { signal: caller.signal }),
        { ...options, ...(withInit ? { signal: explicit.signal } : {}) },
      );
      let settled: unknown;
      const result = response
        .text()
        .catch((error: unknown) => error)
        .then((value) => {
          settled = value;
          return value;
        });
      const reason = new Error('unmounted');
      (source === 'request' ? caller : explicit).abort(reason);
      await vi.advanceTimersByTimeAsync(0);
      try {
        expect(settled).toBe(reason);
        expect(sentSignal?.aborted).toBe(true);
      } finally {
        // Also settle the diagnostic run if cancellation was lost by a mutation.
        if (!sentSignal?.aborted) bodyController.error(reason);
        await result;
      }
    },
  );
});

it('caps a continuously progressing response at five minutes and cancels its reader', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  let bodyController!: ReadableStreamDefaultController<Uint8Array>;
  let sentSignal: AbortSignal | null | undefined;
  const cancel = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentSignal = init?.signal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            bodyController = controller;
          },
          cancel,
        }),
      );
    }),
  );
  const response = await authenticatedFetch(URL_UNDER_TEST, {
    progressTimeoutMs: 30_000,
  });
  let settled: unknown;
  const result = response
    .text()
    .catch((error: unknown) => error)
    .then((value) => {
      settled = value;
      return value;
    });
  for (let chunk = 0; chunk < 10; chunk++) {
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBeUndefined();
    bodyController.enqueue(new Uint8Array([65]));
    await vi.advanceTimersByTimeAsync(0);
  }
  await vi.advanceTimersByTimeAsync(10);
  try {
    expect(settled).toMatchObject({
      name: 'StationRequestTimeoutError',
      timeoutMs: 300_000,
      mutation: false,
    });
    expect(sentSignal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    if (!sentSignal?.aborted) bodyController.close();
    await result;
  }
});
