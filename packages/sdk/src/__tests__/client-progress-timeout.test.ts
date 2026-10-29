import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each([
  { name: 'progress timeout', options: { progressTimeoutMs: 30_000 } },
  { name: 'total deadline', options: { timeoutMs: 30_000 } },
])('$name Request cancellation', ({ options }) => {
  it('preserves the native first reason when a Request listener reentrantly aborts init', async () => {
    const caller = new AbortController();
    const explicit = new AbortController();
    const first = new Error('first');
    const second = new Error('second');
    const input = new Request(URL_UNDER_TEST, { signal: caller.signal });
    input.signal.addEventListener('abort', () => explicit.abort(second));
    const native = AbortSignal.any([input.signal, explicit.signal]);
    const callerListeners = [input.signal, explicit.signal].map((signal) =>
      vi.spyOn(signal, 'addEventListener'),
    );
    let sentSignal: AbortSignal | null | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        sentSignal = init?.signal;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              init?.signal?.addEventListener(
                'abort',
                () => controller.error(init.signal?.reason),
                { once: true },
              );
            },
          }),
        );
      }),
    );
    const response = await authenticatedFetch(input, {
      ...options,
      signal: explicit.signal,
    });
    const result = response.text().catch((error: unknown) => error);
    caller.abort(first);
    expect(native.reason).toBe(first);
    expect(await result).toBe(first);
    expect(sentSignal?.reason).toBe(first);
    for (const listener of callerListeners) {
      expect(listener).not.toHaveBeenCalled();
    }
  });

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

describe('iOS 16.4 signal composition without AbortSignal.any', () => {
  const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any')!;
  beforeEach(() => {
    Reflect.deleteProperty(AbortSignal, 'any');
  });
  afterEach(() => {
    Object.defineProperty(AbortSignal, 'any', descriptor);
    vi.restoreAllMocks();
  });

  describe.each([
    { name: 'progress timeout', options: { progressTimeoutMs: 20 } },
    { name: 'total deadline', options: { timeoutMs: 20 } },
  ])('$name', ({ options }) => {
    it('dispatches and enforces the deadline without caller signals', async () => {
      let sentSignal: AbortSignal | null | undefined;
      const fetchMock = vi.fn(
        async (_input: RequestInfo | URL, init?: RequestInit) => {
          sentSignal = init?.signal;
          return new Response(new ReadableStream<Uint8Array>());
        },
      );
      vi.stubGlobal('fetch', fetchMock);
      const response = await authenticatedFetch(URL_UNDER_TEST, options);
      expect(fetchMock).toHaveBeenCalledOnce();
      await expect(response.text()).rejects.toMatchObject({
        name: 'StationRequestTimeoutError',
      });
      expect(sentSignal?.aborted).toBe(true);
    });

    it.each(['request', 'init'] as const)(
      'cancels pending headers from the %s signal',
      async (source) => {
        const caller = new AbortController();
        const explicit = new AbortController();
        const reason = new Error('cancel headers');
        const fetchMock = vi.fn(
          (_input: RequestInfo | URL, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener(
                'abort',
                () => reject(init.signal?.reason),
                { once: true },
              );
            }),
        );
        vi.stubGlobal('fetch', fetchMock);
        const pending = authenticatedFetch(
          new Request(URL_UNDER_TEST, { signal: caller.signal }),
          {
            ...options,
            signal: explicit.signal,
          },
        );
        const result = pending.catch((error: unknown) => error);
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce(), {
          interval: 1,
        });
        (source === 'request' ? caller : explicit).abort(reason);
        expect(await result).toBe(reason);
      },
    );

    it.each([
      'success',
      'body error',
      'cancel',
      'request abort',
      'init abort',
      'headers error',
      'null body',
      'deadline',
    ] as const)(
      'dispatches and removes caller listeners after %s',
      async (outcome) => {
        const caller = new AbortController();
        const explicit = new AbortController();
        const input = new Request(URL_UNDER_TEST, { signal: caller.signal });
        const active = new Set<EventListenerOrEventListenerObject>();
        for (const signal of [input.signal, explicit.signal]) {
          const add = signal.addEventListener.bind(signal);
          const remove = signal.removeEventListener.bind(signal);
          vi.spyOn(signal, 'addEventListener').mockImplementation(
            (type, listener, opts) => {
              if (type === 'abort' && listener) active.add(listener);
              add(type, listener, opts);
            },
          );
          vi.spyOn(signal, 'removeEventListener').mockImplementation(
            (type, listener, opts) => {
              if (type === 'abort' && listener) active.delete(listener);
              remove(type, listener, opts);
            },
          );
        }
        const reason = new Error(outcome);
        let bodyController!: ReadableStreamDefaultController<Uint8Array>;
        let sentSignal: AbortSignal | null | undefined;
        const fetchMock = vi.fn(
          async (_input: RequestInfo | URL, init?: RequestInit) => {
            sentSignal = init?.signal;
            if (outcome === 'headers error') throw reason;
            if (outcome === 'null body')
              return new Response(null, { status: 204 });
            return new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  bodyController = controller;
                },
              }),
            );
          },
        );
        vi.stubGlobal('fetch', fetchMock);
        const pending = authenticatedFetch(input, {
          ...options,
          signal: explicit.signal,
        });
        if (outcome === 'headers error') {
          await expect(pending).rejects.toBe(reason);
        } else {
          const response = await pending;
          if (outcome === 'null body') {
            expect(response.body).toBeNull();
          } else if (outcome === 'cancel') {
            await response.body!.cancel(reason);
          } else {
            expect(active.size).toBe(2);
            const result = response.text();
            if (outcome === 'success') bodyController.close();
            else if (outcome === 'body error') bodyController.error(reason);
            else if (outcome !== 'deadline') {
              (outcome === 'request abort' ? caller : explicit).abort(reason);
              // The first abort reason survives a later abort from the other source.
              (outcome === 'request abort' ? explicit : caller).abort(
                new Error('later'),
              );
              expect(sentSignal?.reason).toBe(reason);
            }
            if (outcome === 'success') await expect(result).resolves.toBe('');
            else if (outcome === 'deadline')
              await expect(result).rejects.toMatchObject({
                name: 'StationRequestTimeoutError',
              });
            else await expect(result).rejects.toBe(reason);
          }
        }
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(active.size).toBe(0);
      },
    );

    it('keeps the first already-aborted input reason and removes earlier listeners', async () => {
      const caller = new AbortController();
      const explicit = new AbortController();
      const reason = new Error('already cancelled');
      explicit.abort(reason);
      const input = new Request(URL_UNDER_TEST, { signal: caller.signal });
      const add = vi.spyOn(input.signal, 'addEventListener');
      const remove = vi.spyOn(input.signal, 'removeEventListener');
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      await expect(
        authenticatedFetch(input, { ...options, signal: explicit.signal }),
      ).rejects.toBe(reason);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(remove.mock.calls).toEqual(
        add.mock.calls.map(([type, listener]) => [type, listener]),
      );
    });
  });
});
