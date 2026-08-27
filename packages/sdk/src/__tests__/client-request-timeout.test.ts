import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  authenticatedFetch,
  DEFAULT_CLIENT_REQUEST_TIMEOUT_MS,
  fetchSSE,
  getClientRequestTimeout,
  getJson,
  mutateJson,
  StationRequestTimeoutError,
  setClientCredentialResolver,
  setClientRequestTimeout,
} from '../client/http';

const URL_UNDER_TEST = 'https://station.example.test/api/agents';

function initOf(mock: ReturnType<typeof vi.fn>, call = 0): RequestInit {
  return (mock.mock.calls as unknown[][])[call]?.[1] as RequestInit;
}

/** A `fetch` that never settles until its signal aborts — a hung server. */
function hangingFetch() {
  return vi.fn(
    (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        if (signal.aborted) {
          reject(signal.reason ?? new Error('aborted'));
          return;
        }
        signal.addEventListener('abort', () => {
          reject(signal.reason ?? new Error('aborted'));
        });
      }),
  );
}

describe('client request deadlines', () => {
  afterEach(() => {
    setClientRequestTimeout(undefined);
    setClientCredentialResolver(undefined);
    vi.unstubAllGlobals();
  });

  it('is off until a host configures it, leaving requests unsignalled', async () => {
    expect(getClientRequestTimeout()).toBeUndefined();
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);

    await getJson(URL_UNDER_TEST);

    expect(initOf(fetchMock).signal).toBeUndefined();
  });

  it('preserves the single-argument fetch shape for a bare authenticatedFetch', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);

    await authenticatedFetch(URL_UNDER_TEST);

    expect(fetchMock).toHaveBeenCalledWith(URL_UNDER_TEST);
  });

  it('attaches a deadline signal to reads and writes once configured', async () => {
    setClientRequestTimeout(DEFAULT_CLIENT_REQUEST_TIMEOUT_MS);
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);

    await getJson(URL_UNDER_TEST);
    await mutateJson(URL_UNDER_TEST, 'POST', undefined, { a: 1 });
    await authenticatedFetch(URL_UNDER_TEST, { method: 'GET' });

    expect(initOf(fetchMock, 0).signal).toBeInstanceOf(AbortSignal);
    expect(initOf(fetchMock, 1).signal).toBeInstanceOf(AbortSignal);
    expect(initOf(fetchMock, 2).signal).toBeInstanceOf(AbortSignal);
  });

  it('raises a StationRequestTimeoutError when the server never answers', async () => {
    setClientRequestTimeout(20);
    vi.stubGlobal('fetch', hangingFetch());

    await expect(getJson(URL_UNDER_TEST)).rejects.toBeInstanceOf(
      StationRequestTimeoutError,
    );
  });

  it('reports the deadline that fired so the CLI can name it', async () => {
    setClientRequestTimeout(20);
    vi.stubGlobal('fetch', hangingFetch());

    const error = await getJson(URL_UNDER_TEST).catch((e: unknown) => e);

    expect(error).toMatchObject({
      name: 'StationRequestTimeoutError',
      timeoutMs: 20,
      url: URL_UNDER_TEST,
    });
  });

  it('classifies a write timeout apart from a read', async () => {
    setClientRequestTimeout(20);
    vi.stubGlobal('fetch', hangingFetch());

    const write = await mutateJson(URL_UNDER_TEST, 'POST', undefined, {
      a: 1,
    }).catch((e: unknown) => e);
    const read = await getJson(URL_UNDER_TEST).catch((e: unknown) => e);

    expect(write).toMatchObject({
      name: 'StationRequestTimeoutError',
      method: 'POST',
      mutation: true,
    });
    expect(read).toMatchObject({
      name: 'StationRequestTimeoutError',
      method: 'GET',
      mutation: false,
    });
  });

  it('lets a read-shaped POST say so, so its timeout claims no state change', async () => {
    setClientRequestTimeout(20);
    vi.stubGlobal('fetch', hangingFetch());

    const search = await mutateJson(
      URL_UNDER_TEST,
      'POST',
      { readOnly: true },
      { query: 'deploy runbook' },
    ).catch((e: unknown) => e);

    expect(search).toMatchObject({
      name: 'StationRequestTimeoutError',
      method: 'POST',
      mutation: false,
    });
    // The declaration is ours, not the server's — it must not reach the wire.
    const init = initOf(globalThis.fetch as ReturnType<typeof vi.fn>);
    expect((init as { readOnly?: unknown }).readOnly).toBeUndefined();
  });

  it('leaves method and mutation unset when nothing observed them', () => {
    // Exported from the published SDK: a two-argument construction has no
    // method to report, and must not be stamped with a default one.
    const error = new StationRequestTimeoutError(URL_UNDER_TEST, 30_000);

    expect(error.method).toBeUndefined();
    expect(error.mutation).toBeUndefined();
  });

  it('passes a caller abort through unchanged instead of calling it a timeout', async () => {
    setClientRequestTimeout(10_000);
    vi.stubGlobal('fetch', hangingFetch());
    const controller = new AbortController();
    const pending = authenticatedFetch(URL_UNDER_TEST, {
      signal: controller.signal,
    });
    controller.abort(new Error('user cancelled'));

    await expect(pending).rejects.not.toBeInstanceOf(
      StationRequestTimeoutError,
    );
  });

  it('honours an explicit per-call timeout over the configured default', async () => {
    setClientRequestTimeout(10_000);
    vi.stubGlobal('fetch', hangingFetch());

    const error = await getJson(URL_UNDER_TEST, { timeoutMs: 15 }).catch(
      (e: unknown) => e,
    );

    expect(error).toMatchObject({ timeoutMs: 15 });
  });

  it('opts a call out entirely with timeoutMs: null', async () => {
    setClientRequestTimeout(30_000);
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);

    await getJson(URL_UNDER_TEST, { timeoutMs: null });
    await authenticatedFetch(URL_UNDER_TEST, {
      method: 'POST',
      timeoutMs: null,
    });

    expect(initOf(fetchMock, 0).signal).toBeUndefined();
    expect(initOf(fetchMock, 1).signal).toBeUndefined();
  });

  it('treats a caller-supplied signal as the caller owning cancellation', async () => {
    setClientRequestTimeout(30_000);
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await getJson(URL_UNDER_TEST, { signal: controller.signal });

    expect(initOf(fetchMock).signal).toBe(controller.signal);
  });

  it('leaves an SSE stream deadline-free so a quiet stream is not torn down', async () => {
    setClientRequestTimeout(30_000);
    const fetchMock = vi.fn(
      async () =>
        new Response(new ReadableStream({ start: (c) => c.close() }), {
          headers: { 'Content-Type': 'text/event-stream' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const connection = fetchSSE(URL_UNDER_TEST, {
      onMessage: () => {},
      reconnect: false,
    });
    await connection.completed;

    const signal = initOf(fetchMock).signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    // The stream's own controller, not a timer: aborting the connection is
    // what ends it.
    expect(signal?.aborted).toBe(false);
    connection.close();
    expect(signal?.aborted).toBe(true);
  });

  it('clamps nonsense configuration back to "no deadline"', () => {
    setClientRequestTimeout(0);
    expect(getClientRequestTimeout()).toBeUndefined();
    setClientRequestTimeout(Number.NaN);
    expect(getClientRequestTimeout()).toBeUndefined();
    setClientRequestTimeout(-5);
    expect(getClientRequestTimeout()).toBeUndefined();
    setClientRequestTimeout(1_500);
    expect(getClientRequestTimeout()).toBe(1_500);
  });
});
