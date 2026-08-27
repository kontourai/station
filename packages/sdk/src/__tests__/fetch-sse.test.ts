import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchSSE,
  notifyCredentialChanged,
  setClientCredentialResolver,
} from '../client/http';

const CREDENTIAL = 'sse-test-credential-not-for-production';

/**
 * A connection that delivers `body`, stays open for `openMs` of (fake) time,
 * and only then dies — the shape a genuinely healthy stream has, as opposed to
 * one that is merely accepted. `pull` returning a promise is what holds the
 * body open, so the transport observes real elapsed uptime.
 */
function healthySseResponse(body: string, openMs: number): Response {
  const bytes = new TextEncoder().encode(body);
  let sent = false;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(bytes);
          return;
        }
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            controller.error(new Error('connection dropped after healthy run'));
            resolve();
          }, openMs);
        });
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

function sseResponse(body: string): Response {
  return new Response(body, {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function failingSseResponse(body = ''): Response {
  const bytes = new TextEncoder().encode(body);
  let sent = false;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (!sent && bytes.length > 0) {
          sent = true;
          controller.enqueue(bytes);
          return;
        }
        controller.error(new Error('simulated stream read failure'));
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

function pagehideTarget() {
  const listeners = new Map<
    string,
    Set<(event?: { persisted?: boolean }) => void>
  >();
  const target = {
    addEventListener(type: string, listener: () => void) {
      const byType = listeners.get(type) ?? new Set();
      byType.add(listener);
      listeners.set(type, byType);
    },
    removeEventListener(type: string, listener: () => void) {
      const byType = listeners.get(type);
      if (!byType) return;
      byType.delete(listener);
      if (byType.size === 0) listeners.delete(type);
    },
  };
  return {
    target,
    pagehide(persisted: boolean) {
      for (const listener of listeners.get('pagehide') ?? []) {
        listener({ persisted });
      }
    },
  };
}

function pendingFetchThatRejectsOnAbort(onAbort: () => void) {
  return vi.fn(
    async (_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            onAbort();
            reject(new Error('request aborted'));
          },
          { once: true },
        );
      }),
  );
}

describe('fetchSSE', () => {
  afterEach(() => {
    setClientCredentialResolver(undefined);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('settles a pending request only when its parent signal aborts', async () => {
    const requestAborted = vi.fn();
    const fetchMock = pendingFetchThatRejectsOnAbort(requestAborted);
    vi.stubGlobal('fetch', fetchMock);
    const parent = new AbortController();

    const stream = fetchSSE('https://station.example.test/events', {
      signal: parent.signal,
      onMessage: () => undefined,
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    let settled = false;
    void stream.completed.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    parent.abort();
    await stream.completed;

    expect(requestAborted).toHaveBeenCalledOnce();
    expect(stream.signal.aborted).toBe(true);
  });

  it('aborts a browser-owned stream on a non-persisted pagehide', async () => {
    const page = pagehideTarget();
    const requestAborted = vi.fn();
    const fetchMock = pendingFetchThatRejectsOnAbort(requestAborted);
    vi.stubGlobal('window', page.target);
    vi.stubGlobal('fetch', fetchMock);

    const stream = fetchSSE('https://station.example.test/events', {
      onMessage: () => undefined,
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    page.pagehide(false);
    await stream.completed;

    expect(requestAborted).toHaveBeenCalledOnce();
    expect(stream.signal.aborted).toBe(true);
  });

  it('keeps a browser-owned stream active for BFCache pagehide until closed', async () => {
    const page = pagehideTarget();
    const requestAborted = vi.fn();
    const fetchMock = pendingFetchThatRejectsOnAbort(requestAborted);
    vi.stubGlobal('window', page.target);
    vi.stubGlobal('fetch', fetchMock);

    const stream = fetchSSE('https://station.example.test/events', {
      onMessage: () => undefined,
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    page.pagehide(true);
    await Promise.resolve();
    expect(stream.signal.aborted).toBe(false);
    expect(requestAborted).not.toHaveBeenCalled();

    stream.close();
    await stream.completed;
    expect(requestAborted).toHaveBeenCalledOnce();
  });

  it('removes its pagehide listener after a naturally completed non-reconnecting stream', async () => {
    const page = pagehideTarget();
    vi.stubGlobal('window', page.target);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseResponse('data: done\n\n')),
    );

    const stream = fetchSSE('https://station.example.test/events', {
      reconnect: false,
      onMessage: () => undefined,
    });
    await stream.completed;

    page.pagehide(false);
    expect(stream.signal.aborted).toBe(false);
  });

  it('consumes a streamed response from the host-owned transport', async () => {
    const transport = vi.fn(async () =>
      sseResponse('event: native\ndata: brokered\n\n'),
    );
    const browserFetch = vi.fn(async () => sseResponse('data: leaked\n\n'));
    vi.stubGlobal('fetch', browserFetch);
    setClientCredentialResolver(() => ({
      origin: 'https://station.example.test',
      transport,
    }));
    const messages: Array<{ data: string; event: string }> = [];

    const stream = fetchSSE('https://station.example.test/events', {
      reconnect: false,
      onMessage: (message) => messages.push(message),
    });
    await stream.completed;

    expect(messages).toEqual([{ data: 'brokered', event: 'native' }]);
    expect(transport).toHaveBeenCalledOnce();
    expect(browserFetch).not.toHaveBeenCalled();
  });

  it('parses event names, ids, multiline data, and comments', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse(
          ': heartbeat\r\nid: event-1\r\nevent: station:update\r\ndata: first\r\ndata: second\r\n\r\n',
        ),
      ),
    );
    const messages: Array<{ data: string; event: string; id?: string }> = [];

    const stream = fetchSSE('https://station.example.test/events', {
      authentication: 'required',
      credential: CREDENTIAL,
      credentialOrigin: 'https://station.example.test',
      reconnect: false,
      onMessage: (message) => messages.push(message),
    });
    await stream.completed;

    expect(messages).toEqual([
      { data: 'first\nsecond', event: 'station:update', id: 'event-1' },
    ]);
  });

  it('reconnects with Last-Event-ID and supports deterministic abort', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        failingSseResponse(
          'id: event-7\ndata: first\n\nid: event-8\ndata: partial',
        ),
      )
      .mockImplementationOnce(
        async () => new Promise<Response>(() => undefined),
      );
    vi.stubGlobal('fetch', fetchMock);

    const stream = fetchSSE('https://station.example.test/events', {
      authentication: 'required',
      credential: CREDENTIAL,
      credentialOrigin: 'https://station.example.test',
      retryDelayMs: 10,
      onMessage: () => undefined,
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(10);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const reconnectInit = (fetchMock.mock.calls as unknown[][])[1]?.[1] as
      | RequestInit
      | undefined;
    expect(new Headers(reconnectInit?.headers).get('Last-Event-ID')).toBe(
      'event-7',
    );
    expect(new Headers(reconnectInit?.headers).get('Authorization')).toBe(
      `Bearer ${CREDENTIAL}`,
    );

    stream.close();
    expect(stream.signal.aborted).toBe(true);
  });

  it('exhausts capped retries for repeated post-open stream errors', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const fetchMock = vi.fn(async () => failingSseResponse());
    vi.stubGlobal('fetch', fetchMock);

    const stream = fetchSSE('https://station.example.test/events', {
      maxRetries: 2,
      retryDelayMs: 1,
      maxRetryDelayMs: 1,
      onError,
      onMessage: () => undefined,
    });
    await vi.runAllTimersAsync();
    await stream.completed;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledTimes(3);
  });

  it('resets the consecutive failure budget after a meaningful event', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(failingSseResponse())
      .mockResolvedValueOnce(
        failingSseResponse('id: stable-1\ndata: meaningful\n\n'),
      )
      .mockResolvedValue(failingSseResponse());
    vi.stubGlobal('fetch', fetchMock);

    const stream = fetchSSE('https://station.example.test/events', {
      maxRetries: 2,
      retryDelayMs: 1,
      maxRetryDelayMs: 1,
      retryResetAfterMessages: 1,
      onMessage: () => undefined,
    });
    await vi.runAllTimersAsync();
    await stream.completed;

    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  describe('station#1848: the backoff ladder climbs, and a healthy attempt restarts it', () => {
    /**
     * Drives `fetchSSE` with fake timers and returns the gaps between
     * consecutive connection attempts, read off the (mocked) clock inside the
     * fetch stub itself rather than off the driver loop — so the numbers are
     * the delays the transport actually waited, not an artifact of how this
     * test advanced time.
     */
    async function delaysBetweenAttempts(
      responder: (attempt: number) => Response,
      options: { retryDelayMs: number; maxRetryDelayMs: number },
      attempts: number,
    ): Promise<{ delays: number[]; close: () => void }> {
      const attemptedAt: number[] = [];
      const fetchMock = vi.fn(async () => {
        attemptedAt.push(Date.now());
        return responder(attemptedAt.length);
      });
      vi.stubGlobal('fetch', fetchMock);

      const stream = fetchSSE('https://station.example.test/events', {
        ...options,
        onMessage: () => undefined,
      });
      let advanced = 0;
      while (attemptedAt.length < attempts && advanced < 400_000) {
        await vi.advanceTimersByTimeAsync(50);
        advanced += 50;
      }
      const delays = attemptedAt
        .slice(1)
        .map((at, index) => at - (attemptedAt[index] as number));
      return { delays, close: () => stream.close() };
    }

    /**
     * The connect burst `/api/orchestration/events` sends before it can ever
     * stall: a snapshot (or replay) and an unconditional caught-up marker.
     * Every accepted connection delivers these, in milliseconds, whether or
     * not the connection then survives — which is precisely why "did this
     * attempt deliver frames?" cannot mean "was this attempt healthy?".
     */
    const CONNECT_BURST =
      'event: orchestration:snapshot\ndata: {"sessions":[]}\nid: 0\n\n' +
      'event: orchestration:caughtUp\ndata: {}\nid: 0\n\n';

    it('doubles the delay while every attempt keeps failing', async () => {
      vi.useFakeTimers();

      const { delays, close } = await delaysBetweenAttempts(
        () => new Response('', { status: 503 }),
        { retryDelayMs: 2000, maxRetryDelayMs: 30_000 },
        5,
      );
      close();

      // Pinning the ladder shape, not just "it grew": a fixed-interval poll
      // (maxRetryDelayMs === retryDelayMs, which is what every browser
      // consumer used to configure) reads as [2000, 2000, 2000, 2000] here.
      expect(delays).toEqual([2000, 4000, 8000, 16_000]);
    });

    it('restarts the ladder after a connection that STAYED OPEN, not merely one that delivered frames', async () => {
      vi.useFakeTimers();
      // Three failures climb the ladder to 8000ms. The fourth attempt is a
      // genuinely healthy connection: it delivers the burst AND stays open
      // 35s (past the 30s `healthyConnectionMs` default) before dying. The
      // fifth attempt's own wait must then be back at the 2000ms floor.
      //
      // The gaps are attempt-to-attempt, so the FOURTH entry is the
      // discriminating one: 35s of uptime plus the wait that followed it.
      // 37000 means the ladder restarted at the 2000ms floor; without the
      // restart the same run reads [2000, 4000, 8000, 51000, 30000] — 35s
      // plus the 16000 the ladder had climbed to.
      const { delays, close } = await delaysBetweenAttempts(
        (attempt) =>
          attempt === 4
            ? healthySseResponse(CONNECT_BURST, 35_000)
            : new Response('', { status: 503 }),
        { retryDelayMs: 2000, maxRetryDelayMs: 30_000 },
        6,
      );
      close();

      expect(delays).toEqual([2000, 4000, 8000, 37_000, 4000]);
    });

    it('keeps climbing when every attempt is accepted, bursts, then dies', async () => {
      vi.useFakeTimers();

      // A proxy idle-close, a server restarting mid-stream, or a supervisor
      // kill all look like this from the client: 200, the connect burst, then
      // the body dies. It is the class the incident's 200-status log lines
      // cannot rule out, and each open replays the snapshot — which is
      // station#1848's duplication mechanism. Counting delivered frames alone
      // would read this as healthy and flatten the ladder to [2000, 2000, ...].
      const { delays, close } = await delaysBetweenAttempts(
        () => failingSseResponse(CONNECT_BURST),
        { retryDelayMs: 2000, maxRetryDelayMs: 30_000 },
        5,
      );
      close();

      expect(delays).toEqual([2000, 4000, 8000, 16_000]);
    });

    it('an explicit retry() cuts a transient backoff short', async () => {
      vi.useFakeTimers();
      const attemptedAt: number[] = [];
      const fetchMock = vi.fn(async () => {
        attemptedAt.push(Date.now());
        return new Response('', { status: 503 });
      });
      vi.stubGlobal('fetch', fetchMock);

      const stream = fetchSSE('https://station.example.test/events', {
        retryDelayMs: 2000,
        maxRetryDelayMs: 30_000,
        onMessage: () => undefined,
      });
      // Climb into a long wait (the 4th attempt is followed by a 16s delay).
      let advanced = 0;
      while (attemptedAt.length < 4 && advanced < 60_000) {
        await vi.advanceTimersByTimeAsync(50);
        advanced += 50;
      }
      const before = attemptedAt.length;

      // Before this, `wake` was published only by the terminal (401/403) gate,
      // so `retry()` was documented as a no-op mid-backoff — which is exactly
      // when a host knows something changed (a server just came back).
      stream.retry();
      await vi.advanceTimersByTimeAsync(50);
      stream.close();

      expect(attemptedAt.length).toBe(before + 1);
    });

    it('waits at least as long as a 429 Retry-After asks', async () => {
      vi.useFakeTimers();

      const { delays, close } = await delaysBetweenAttempts(
        () =>
          new Response('', { status: 429, headers: { 'Retry-After': '20' } }),
        { retryDelayMs: 2000, maxRetryDelayMs: 30_000 },
        4,
      );
      close();

      // Retrying inside the window the limiter named is what sustains a 429
      // storm: every early attempt is another failure holding the limiter
      // tripped. Without this the ladder would read [2000, 4000, 8000].
      expect(delays).toEqual([20_000, 30_000, 30_000]);
    });

    it('clamps an absurd Retry-After to the configured ceiling', async () => {
      vi.useFakeTimers();

      const { delays, close } = await delaysBetweenAttempts(
        () =>
          new Response('', {
            status: 429,
            headers: { 'Retry-After': '86400' },
          }),
        { retryDelayMs: 2000, maxRetryDelayMs: 30_000 },
        3,
      );
      close();

      expect(delays).toEqual([30_000, 30_000]);
    });

    it.each([
      // `Number()` would read these as 16 seconds, 1000 seconds and 0 — a
      // malformed header silently becoming a confident, wrong wait.
      ['hexadecimal', '0x10'],
      ['exponent notation', '1e3'],
      ['empty', ''],
      ['whitespace', '   '],
      ['signed', '+30'],
    ])(
      'ignores a %s Retry-After instead of coercing it to a wait',
      async (_label, header) => {
        vi.useFakeTimers();

        const { delays, close } = await delaysBetweenAttempts(
          () =>
            new Response('', {
              status: 429,
              headers: { 'Retry-After': header },
            }),
          { retryDelayMs: 2000, maxRetryDelayMs: 30_000 },
          4,
        );
        close();

        expect(delays).toEqual([2000, 4000, 8000]);
      },
    );

    it('ignores an unparseable Retry-After rather than stalling the ladder', async () => {
      vi.useFakeTimers();

      const { delays, close } = await delaysBetweenAttempts(
        () =>
          new Response('', {
            status: 429,
            // The HTTP-date form, deliberately not honored — it would depend
            // on this client's clock agreeing with the server's.
            headers: { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' },
          }),
        { retryDelayMs: 2000, maxRetryDelayMs: 30_000 },
        4,
      );
      close();

      expect(delays).toEqual([2000, 4000, 8000]);
    });
  });

  describe('station#1094: terminal (401/403) failures stop retrying', () => {
    it('stops retrying after a 401 — the attempt count stays flat over advanced time', async () => {
      vi.useFakeTimers();
      const fetchMock = vi.fn(async () => new Response('', { status: 401 }));
      vi.stubGlobal('fetch', fetchMock);
      const onError = vi.fn();
      const onTerminal = vi.fn();

      const stream = fetchSSE('https://station.example.test/events', {
        retryDelayMs: 10,
        maxRetryDelayMs: 10,
        onError,
        onTerminal,
        onMessage: () => undefined,
      });

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      // Strong form: advance well past what would be dozens of retries on a
      // 10ms ladder, and assert the attempt count never moves — not just
      // that a "blocked" flag got set.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onTerminal).toHaveBeenCalledTimes(1);
      expect(onTerminal.mock.calls[0][0]).toBeInstanceOf(Error);

      stream.close();
    });

    /**
     * station#3458: `onOpen` had fired for EVERY response `fetchSSE`
     * received, including a 401 — before `consumeSseResponse` classified it
     * as a rejection and threw. A caller reading `onOpen` as "the stream is
     * working" (as `useSessionEventStream` does) briefly asserted a healthy
     * connection during a credential rejection. `onOpen` must fire only for
     * a response the transport actually consumes.
     */
    it('does not fire onOpen for a rejected (401) response', async () => {
      vi.useFakeTimers();
      const fetchMock = vi.fn(async () => new Response('', { status: 401 }));
      vi.stubGlobal('fetch', fetchMock);
      const onOpen = vi.fn();
      const onError = vi.fn();

      const stream = fetchSSE('https://station.example.test/events', {
        retryDelayMs: 10,
        maxRetryDelayMs: 10,
        onOpen,
        onError,
        onMessage: () => undefined,
      });

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
      expect(onOpen).not.toHaveBeenCalled();

      stream.close();
    });

    it('classifies 403 as terminal too and stays flat over advanced time', async () => {
      vi.useFakeTimers();
      const fetchMock = vi.fn(async () => new Response('', { status: 403 }));
      vi.stubGlobal('fetch', fetchMock);
      const onTerminal = vi.fn();

      const stream = fetchSSE('https://station.example.test/events', {
        retryDelayMs: 5,
        maxRetryDelayMs: 5,
        onTerminal,
        onMessage: () => undefined,
      });

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(onTerminal).toHaveBeenCalledTimes(1);

      stream.close();
    });

    it('a 500 (transient) still retries with bounded backoff, unchanged from before', async () => {
      vi.useFakeTimers();
      const onError = vi.fn();
      const onTerminal = vi.fn();
      const fetchMock = vi.fn(async () => new Response('', { status: 500 }));
      vi.stubGlobal('fetch', fetchMock);

      const stream = fetchSSE('https://station.example.test/events', {
        maxRetries: 2,
        retryDelayMs: 1,
        maxRetryDelayMs: 1,
        onError,
        onTerminal,
        onMessage: () => undefined,
      });
      await vi.runAllTimersAsync();
      await stream.completed;

      // 1 initial attempt + 2 retries, exactly mirroring the pre-existing
      // "exhausts capped retries" behavior above — station#1094 must not
      // regress the transient path.
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(onError).toHaveBeenCalledTimes(3);
      expect(onTerminal).not.toHaveBeenCalled();
    });

    it('a plain network error (no HTTP status) stays transient and keeps retrying', async () => {
      vi.useFakeTimers();
      const onTerminal = vi.fn();
      const fetchMock = vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      });
      vi.stubGlobal('fetch', fetchMock);

      const stream = fetchSSE('https://station.example.test/events', {
        maxRetries: 2,
        retryDelayMs: 1,
        maxRetryDelayMs: 1,
        onTerminal,
        onMessage: () => undefined,
      });
      await vi.runAllTimersAsync();
      await stream.completed;

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(onTerminal).not.toHaveBeenCalled();
    });

    it('resumes via connection.retry() after a terminal stop', async () => {
      vi.useFakeTimers();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response('', { status: 401 }))
        .mockResolvedValueOnce(sseResponse('id: r-1\ndata: hello\n\n'))
        .mockImplementationOnce(
          async () => new Promise<Response>(() => undefined),
        );
      vi.stubGlobal('fetch', fetchMock);
      const messages: string[] = [];

      const stream = fetchSSE('https://station.example.test/events', {
        retryDelayMs: 10,
        onMessage: (message) => messages.push(message.data),
      });

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchMock).toHaveBeenCalledTimes(1); // still blocked, not hammering

      stream.retry();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(messages).toEqual(['hello']));

      stream.close();
    });

    /**
     * station#3437 review (HIGH-2): `onOpen` was the ONLY signal a caller
     * had to know the terminal stop had ended, but the retried attempt can
     * fail transiently — including with an HTTP-status failure (a 500).
     * `onRetry` must fire at the wake itself, independent of whether the
     * resumed attempt then succeeds or fails transiently, so a caller that
     * clears its "stopped" state on `onRetry` (not just `onOpen`) does not
     * stay stuck through a failure that is not a rejection.
     *
     * station#3458 changed `onOpen` itself: it now fires only for a response
     * the transport actually consumes (`response.ok`), never for a rejected
     * one — so a 401/403/500 no longer fires `onOpen` at all, and this test
     * asserts that too.
     */
    it('fires onRetry at the wake, even when the resumed attempt only fails transiently (not another terminal status)', async () => {
      vi.useFakeTimers();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response('', { status: 401 }))
        .mockResolvedValueOnce(new Response('', { status: 500 }))
        .mockImplementationOnce(
          async () => new Promise<Response>(() => undefined),
        );
      vi.stubGlobal('fetch', fetchMock);
      const onTerminal = vi.fn();
      const onRetry = vi.fn();
      const onError = vi.fn();
      const onOpen = vi.fn();

      const stream = fetchSSE('https://station.example.test/events', {
        retryDelayMs: 10,
        maxRetryDelayMs: 10,
        onTerminal,
        onRetry,
        onError,
        onOpen,
        onMessage: () => undefined,
      });

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      // The initial 401 fires BOTH onError (unconditional) and onTerminal
      // (station#1094) for the same failure. It is rejected (`!response.ok`)
      // so `onOpen` (station#3458) does NOT fire for it.
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onTerminal).toHaveBeenCalledTimes(1);
      expect(onOpen).not.toHaveBeenCalled();
      expect(onRetry).not.toHaveBeenCalled();

      stream.retry();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      // The wake fires onRetry BEFORE the second attempt is even issued —
      // it does not wait to see whether that attempt succeeds.
      expect(onRetry).toHaveBeenCalledTimes(1);

      // The second attempt (500) is transient: onError fires again, onTerminal
      // does NOT fire again, and nothing un-does the onRetry signal already
      // sent — this is the exact case the fix targets. It is also rejected,
      // so onOpen still does not fire. A caller that only clears its
      // "stopped" state in `onOpen` would stay stuck here without the
      // `onRetry` fix, since a rejected response never opens.
      await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
      expect(onTerminal).toHaveBeenCalledTimes(1);
      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onOpen).not.toHaveBeenCalled();

      stream.close();
    });

    /**
     * station#3437 review round 2 (LOW-2): `onRetry` must fire at the wake
     * itself even for a resumed attempt that fails at the NETWORK level (no
     * `Response` ever arrives, so `onOpen` — station#3458 — cannot fire
     * either way). This is the fixture that exercises that case, as opposed
     * to the HTTP-status 500 above.
     */
    it('fires onRetry (and not onOpen) when the resumed attempt fails at the network level, not with an HTTP status', async () => {
      vi.useFakeTimers();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response('', { status: 401 }))
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockImplementationOnce(
          async () => new Promise<Response>(() => undefined),
        );
      vi.stubGlobal('fetch', fetchMock);
      const onTerminal = vi.fn();
      const onRetry = vi.fn();
      const onError = vi.fn();
      const onOpen = vi.fn();

      const stream = fetchSSE('https://station.example.test/events', {
        retryDelayMs: 10,
        maxRetryDelayMs: 10,
        onTerminal,
        onRetry,
        onError,
        onOpen,
        onMessage: () => undefined,
      });

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(onTerminal).toHaveBeenCalledTimes(1);
      // The initial 401 is a rejected `Response` (station#3458): onOpen
      // does not fire for it.
      expect(onOpen).not.toHaveBeenCalled();

      stream.retry();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      expect(onRetry).toHaveBeenCalledTimes(1);

      // The resumed attempt rejects before any `Response` exists: onError
      // fires, onOpen still does not fire.
      await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
      expect(onTerminal).toHaveBeenCalledTimes(1);
      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onOpen).not.toHaveBeenCalled();

      stream.close();
    });

    it('retry() is a harmless no-op when the stream is not currently blocked', async () => {
      vi.useFakeTimers();
      const fetchMock = vi.fn(
        async () => new Promise<Response>(() => undefined),
      );
      vi.stubGlobal('fetch', fetchMock);

      const stream = fetchSSE('https://station.example.test/events', {
        onMessage: () => undefined,
      });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      expect(() => stream.retry()).not.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      stream.close();
    });

    it('resumes via the shared notifyCredentialChanged() signal after a terminal stop', async () => {
      vi.useFakeTimers();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response('', { status: 401 }))
        .mockImplementationOnce(
          async () => new Promise<Response>(() => undefined),
        );
      vi.stubGlobal('fetch', fetchMock);

      const stream = fetchSSE('https://station.example.test/events', {
        retryDelayMs: 10,
        onMessage: () => undefined,
      });

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      notifyCredentialChanged('https://station.example.test');
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

      stream.close();
    });

    it('notifyCredentialChanged() accepts a full request URL, normalizing to its origin', async () => {
      vi.useFakeTimers();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response('', { status: 401 }))
        .mockImplementationOnce(
          async () => new Promise<Response>(() => undefined),
        );
      vi.stubGlobal('fetch', fetchMock);

      const stream = fetchSSE('https://station.example.test/events', {
        retryDelayMs: 10,
        onMessage: () => undefined,
      });

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      // A full URL on the same origin (not just a bare origin string) must
      // still resolve to the same registry key.
      notifyCredentialChanged('https://station.example.test/some/other/path');
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

      stream.close();
    });

    it('notifyCredentialChanged() wakes every blocked stream on the SAME origin at once', async () => {
      vi.useFakeTimers();
      const fetchMockA = vi
        .fn()
        .mockResolvedValueOnce(new Response('', { status: 401 }))
        .mockImplementationOnce(
          async () => new Promise<Response>(() => undefined),
        );
      const fetchMockB = vi
        .fn()
        .mockResolvedValueOnce(new Response('', { status: 401 }))
        .mockImplementationOnce(
          async () => new Promise<Response>(() => undefined),
        );
      const dispatch = vi.fn(
        async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const url = input.toString();
          return url.includes('/stream-a')
            ? fetchMockA(input, init)
            : fetchMockB(input, init);
        },
      );
      vi.stubGlobal('fetch', dispatch);

      const streamA = fetchSSE('https://station.example.test/stream-a', {
        retryDelayMs: 10,
        onMessage: () => undefined,
      });
      const streamB = fetchSSE('https://station.example.test/stream-b', {
        retryDelayMs: 10,
        onMessage: () => undefined,
      });

      await vi.waitFor(() => expect(fetchMockA).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(fetchMockB).toHaveBeenCalledTimes(1));

      notifyCredentialChanged('https://station.example.test');

      await vi.waitFor(() => expect(fetchMockA).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(fetchMockB).toHaveBeenCalledTimes(2));

      streamA.close();
      streamB.close();
    });

    it('station#1094 review (HIGH): notifyCredentialChanged() does NOT wake a blocked stream on a DIFFERENT origin', async () => {
      vi.useFakeTimers();
      const fetchMockHome = vi
        .fn()
        .mockResolvedValueOnce(new Response('', { status: 401 }))
        .mockImplementationOnce(
          async () => new Promise<Response>(() => undefined),
        );
      const fetchMockOther = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response('', { status: 401 }),
      );
      const dispatch = vi.fn(
        async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const url = input.toString();
          return url.startsWith('https://home.example.test')
            ? fetchMockHome(input, init)
            : fetchMockOther(input, init);
        },
      );
      vi.stubGlobal('fetch', dispatch);

      // Two DIFFERENT origins/connections — as happens when switching
      // between saved Stations, or in tests that reuse this module without
      // resetting it. A credential fix for one must never resume a stream
      // blocked against the other (station#1094 review, HIGH): an unscoped
      // process-global wake would reconnect every blocked stream in the tab
      // regardless of which connection's credential actually changed.
      const homeStream = fetchSSE('https://home.example.test/events', {
        retryDelayMs: 10,
        onMessage: () => undefined,
      });
      const otherStream = fetchSSE('https://other.example.test/events', {
        retryDelayMs: 10,
        onMessage: () => undefined,
      });

      await vi.waitFor(() => expect(fetchMockHome).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(fetchMockOther).toHaveBeenCalledTimes(1));

      notifyCredentialChanged('https://other.example.test');
      // A generous span of advanced time — if scoping were broken, `home`
      // would reconnect well within this window.
      await vi.advanceTimersByTimeAsync(60_000);

      expect(fetchMockHome).toHaveBeenCalledTimes(1);
      // `other`'s stream stays blocked too (401 again on the mock), but it
      // DID get woken and re-attempt — proving the notify reached the
      // correct origin, not that nothing happened at all.
      expect(fetchMockOther.mock.calls.length).toBeGreaterThanOrEqual(2);

      homeStream.close();
      otherStream.close();
    });
  });

  it('cancels a pending response reader on abort', async () => {
    const cancelled = vi.fn();
    const response = new Response(
      new ReadableStream({
        pull: () => new Promise<void>(() => undefined),
        cancel: cancelled,
      }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response),
    );
    let resolveOpened: (() => void) | undefined;
    const opened = new Promise<void>((resolve) => {
      resolveOpened = resolve;
    });
    const stream = fetchSSE('https://station.example.test/events', {
      onOpen: () => resolveOpened?.(),
      onMessage: () => undefined,
    });
    await opened;
    await Promise.resolve();

    stream.close();
    await stream.completed;

    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('restarts the current attempt, preserves Last-Event-ID, coalesces, and close wins', async () => {
    let active = 0;
    let maxActive = 0;
    const cancelled = vi.fn();
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const attempt = fetchMock.mock.calls.length;
      active += 1;
      maxActive = Math.max(maxActive, active);
      let sent = false;
      let releasePull: (() => void) | undefined;
      let streamController: ReadableStreamDefaultController<Uint8Array>;
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        active -= 1;
        cancelled();
      };
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        },
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(
              new TextEncoder().encode(
                attempt === 1
                  ? 'id: event-1\ndata: first\n\n'
                  : 'data: next\n\n',
              ),
            );
            return;
          }
          return new Promise<void>((resolve) => {
            releasePull = resolve;
          });
        },
        cancel() {
          releasePull?.();
          settle();
        },
      });
      init?.signal?.addEventListener(
        'abort',
        () => {
          settle();
          streamController.error(new DOMException('Aborted', 'AbortError'));
        },
        { once: true },
      );
      return new Response(body, {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const onMessage = vi.fn();
    const stream = fetchSSE('https://station.example.test/events', {
      authentication: 'required',
      credential: CREDENTIAL,
      credentialOrigin: 'https://station.example.test',
      onMessage,
    });
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(1));
    stream.restart();
    stream.restart();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(
      new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('Last-Event-ID'),
    ).toBe('event-1');
    stream.restart();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(maxActive).toBe(1);
    stream.close();
    stream.restart();
    await stream.completed;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(cancelled).toHaveBeenCalledTimes(3);
  });
});
