// @vitest-environment jsdom
import {
  notifyCredentialChanged,
  setClientCredentialResolver,
} from '@kontourai/station-sdk';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * station#2301 — the stream must come back.
 *
 * Unlike `ensureOrchestrationEventStream.test.ts`, the SDK here is REAL: the
 * abort, the terminal park and the credential wake all run through
 * `fetchSSE` itself, and "a new connection" means a new request reached
 * `fetch`. Asserting that a registry entry disappeared is not enough — the
 * defect was that nothing ever connected again.
 *
 * Every test uses its own apiBase and counts only its own requests: the
 * module's recovery listeners are document-wide, so streams from earlier
 * tests stay registered and may react to a later test's events.
 */

const applyOrchestrationSnapshot = vi.fn();
vi.mock('../snapshotHandlers', () => ({
  applyOrchestrationSnapshot: (...args: unknown[]) =>
    applyOrchestrationSnapshot(...args),
}));
const settleSemanticDeliveryBuffer = vi.fn();
vi.mock('../eventHandlers', () => ({
  handleOrchestrationEvent: vi.fn(),
  settleSemanticDeliveryBuffer: (...args: unknown[]) =>
    settleSemanticDeliveryBuffer(...args),
}));

import {
  ensureOrchestrationEventStream,
  notifyOrchestrationAuthorityChanged,
} from '../ensureOrchestrationEventStream';
import { getStreamConnectionState } from '../streamConnectionState';

const encoder = new TextEncoder();

/**
 * A response that delivers `body` and then stays open until its request is
 * aborted — a healthy, idle stream.
 */
function openSseResponse(body: string, signal?: AbortSignal | null): Response {
  let sent = false;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (!sent) {
          sent = true;
          if (body) controller.enqueue(encoder.encode(body));
          return;
        }
        return new Promise<void>((resolve) => {
          signal?.addEventListener(
            'abort',
            () => {
              controller.error(new Error('aborted'));
              resolve();
            },
            { once: true },
          );
        });
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

const SNAPSHOT =
  'id: 5\nevent: orchestration:snapshot\ndata: {"sessions":[]}\n\n';

let fetchMock: ReturnType<typeof vi.fn>;
function requestsTo(apiBase: string) {
  return fetchMock.mock.calls.filter(([input]) =>
    String(input instanceof Request ? input.url : input).startsWith(apiBase),
  );
}

type ScriptedFailure = 'unauthorized' | 'network';
/**
 * Scripts the first responses for ONE apiBase; everything else, and every
 * later request, gets an open stream. Per-URL on purpose: earlier tests'
 * streams stay registered, and a credential-change wake resumes every parked
 * stream on the origin — a shared `mockImplementationOnce` queue would be
 * consumed by whichever woke first (this is how an injection once went
 * uncaught).
 */
function script(apiBase: string, steps: ScriptedFailure[] | 'always-401') {
  const queue = steps === 'always-401' ? [] : [...steps];
  fetchMock.mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith(apiBase)) {
        if (steps === 'always-401') return new Response('', { status: 401 });
        const next = queue.shift();
        if (next === 'unauthorized') return new Response('', { status: 401 });
        if (next === 'network') throw new TypeError('network down');
      }
      return openSseResponse(SNAPSHOT, init?.signal);
    },
  );
}

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

function pagehide(persisted: boolean) {
  window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted }));
}

beforeEach(() => {
  applyOrchestrationSnapshot.mockClear();
  fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
    openSseResponse(SNAPSHOT, init?.signal),
  );
  vi.stubGlobal('fetch', fetchMock);
  setClientCredentialResolver(() => ({
    origin: 'http://recovery.test',
    credential: 'test-credential',
  }));
});

afterEach(() => {
  setClientCredentialResolver(undefined);
  settleSemanticDeliveryBuffer.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/**
 * Moves the monotonic clock the parked-retry floor reads, without faking the
 * timers the streams run on.
 */
function advanceClock(ms: number) {
  const now = performance.now() + ms;
  vi.spyOn(performance, 'now').mockReturnValue(now);
}

describe('ensureOrchestrationEventStream recovery (station#2301)', () => {
  test('switching A to B to A refreshes A with its retained cursor', async () => {
    const a = 'http://recovery.test/authority-a';
    const b = 'http://recovery.test/authority-b';
    ensureOrchestrationEventStream(a);
    ensureOrchestrationEventStream(b);
    await settle();
    notifyOrchestrationAuthorityChanged(b);
    await settle();
    notifyOrchestrationAuthorityChanged(a);
    await settle();
    expect(requestsTo(a)).toHaveLength(2);
    expect(requestsTo(b)).toHaveLength(2);
    const resumedA = requestsTo(a)[1]?.[1] as RequestInit | undefined;
    expect(new Headers(resumedA?.headers).get('Last-Event-ID')).toBe('5');
  });
  test('a stream ended by a non-persisted pagehide is replaced by the next ensure', async () => {
    const apiBase = 'http://recovery.test/pagehide';
    ensureOrchestrationEventStream(apiBase);
    await settle();
    expect(requestsTo(apiBase)).toHaveLength(1);

    pagehide(false);
    await settle();

    ensureOrchestrationEventStream(apiBase);
    await settle();
    expect(requestsTo(apiBase)).toHaveLength(2);
    const second = requestsTo(apiBase)[1]?.[1] as RequestInit | undefined;
    expect(new Headers(second?.headers).get('Last-Event-ID')).toBe('5');
  });

  test('an ensure in the same tick as the abort already replaces the stream', async () => {
    const apiBase = 'http://recovery.test/same-tick';
    ensureOrchestrationEventStream(apiBase);
    await settle();

    // No await between them: the dead connection's loop has not wound down
    // yet, so only its abort signal can tell the registry it is gone.
    pagehide(false);
    ensureOrchestrationEventStream(apiBase);
    await settle();
    expect(requestsTo(apiBase)).toHaveLength(2);
  });

  test('a live stream still dedups: a second ensure opens nothing', async () => {
    const apiBase = 'http://recovery.test/live';
    ensureOrchestrationEventStream(apiBase);
    await settle();
    ensureOrchestrationEventStream(apiBase);
    await settle();
    expect(requestsTo(apiBase)).toHaveLength(1);
  });

  test('the page becoming visible again re-ensures an ended stream with no remount', async () => {
    const apiBase = 'http://recovery.test/visible';
    ensureOrchestrationEventStream(apiBase);
    await settle();
    pagehide(false);
    await settle();
    expect(requestsTo(apiBase)).toHaveLength(1);

    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(requestsTo(apiBase)).toHaveLength(2);
  });

  test('a stream stopped by a 401 is re-armed by a credential change, as the SAME stream', async () => {
    const apiBase = 'http://recovery.test/terminal';
    script(apiBase, ['unauthorized']);
    ensureOrchestrationEventStream(apiBase);
    await settle();
    expect(requestsTo(apiBase)).toHaveLength(1);

    notifyCredentialChanged('http://recovery.test');
    await settle();
    expect(requestsTo(apiBase)).toHaveLength(2);

    // It resumed in place: a later ensure finds it live and opens nothing.
    ensureOrchestrationEventStream(apiBase);
    await settle();
    expect(requestsTo(apiBase)).toHaveLength(2);
  });

  test("a replacement stream's first snapshot is a reconnect fallback, so what the dead one missed is caught up", async () => {
    const apiBase = 'http://recovery.test/catch-up';
    ensureOrchestrationEventStream(apiBase);
    await settle();
    expect(applyOrchestrationSnapshot).toHaveBeenLastCalledWith(
      { sessions: [] },
      expect.objectContaining({ apiBase, isReconnectFallback: false }),
    );

    pagehide(false);
    await settle();
    ensureOrchestrationEventStream(apiBase);
    await settle();

    expect(requestsTo(apiBase)).toHaveLength(2);
    expect(applyOrchestrationSnapshot).toHaveBeenLastCalledWith(
      { sessions: [] },
      expect.objectContaining({ apiBase, isReconnectFallback: true }),
    );
  });

  test.each([
    ['focus', () => window.dispatchEvent(new Event('focus'))],
    ['online', () => window.dispatchEvent(new Event('online'))],
    ['pageshow', () => window.dispatchEvent(new Event('pageshow'))],
  ])('a %s signal re-ensures an ended stream', async (name, signal) => {
    const apiBase = `http://recovery.test/signal-${name}`;
    ensureOrchestrationEventStream(apiBase);
    await settle();
    pagehide(false);
    await settle();

    signal();
    await settle();
    expect(requestsTo(apiBase)).toHaveLength(2);
  });

  test('a hidden page is not re-ensured by a visibilitychange', async () => {
    const apiBase = 'http://recovery.test/hidden';
    ensureOrchestrationEventStream(apiBase);
    await settle();
    pagehide(false);
    await settle();

    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(requestsTo(apiBase)).toHaveLength(1);
  });

  test('returning after a long hidden period restarts the live stream with its cursor', async () => {
    const apiBase = 'http://recovery.test/long-hidden';
    const hidden = vi.spyOn(document, 'hidden', 'get');
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000);
    hidden.mockReturnValue(false);
    ensureOrchestrationEventStream(apiBase);
    await settle();
    hidden.mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    now.mockReturnValue(1_031_000);
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(requestsTo(apiBase)).toHaveLength(2);
    const second = requestsTo(apiBase)[1]?.[1] as RequestInit | undefined;
    expect(new Headers(second?.headers).get('Last-Event-ID')).toBe('5');
  });

  test('recovery signals retry a parked (401) stream at most once per floor interval', async () => {
    const apiBase = 'http://recovery.test/parked-floor';
    script(apiBase, 'always-401');
    ensureOrchestrationEventStream(apiBase);
    await settle();
    expect(requestsTo(apiBase)).toHaveLength(1);

    // A burst of window switches right after the refusal: no new request.
    for (let i = 0; i < 5; i++) window.dispatchEvent(new Event('focus'));
    await settle();
    expect(requestsTo(apiBase)).toHaveLength(1);

    // Past the floor: exactly one retry, however many signals arrive.
    advanceClock(30_001);
    for (let i = 0; i < 5; i++) window.dispatchEvent(new Event('focus'));
    await settle();
    expect(requestsTo(apiBase)).toHaveLength(2);
  });

  test('a stream resumed from its park is no longer treated as parked', async () => {
    const apiBase = 'http://recovery.test/unpark';
    script(apiBase, ['unauthorized', 'network']);
    ensureOrchestrationEventStream(apiBase);
    await settle();

    // Woken; its next attempt fails transiently and waits out a 2s backoff.
    notifyCredentialChanged('http://recovery.test');
    await settle();
    expect(requestsTo(apiBase)).toHaveLength(2);

    // A stale `parked` flag would call retry() here and cut that backoff
    // short. Unparked, the ensure leaves the transport's own schedule alone.
    advanceClock(30_001);
    ensureOrchestrationEventStream(apiBase);
    await settle();
    expect(requestsTo(apiBase)).toHaveLength(2);
  });

  test('a stream whose loop ends without an abort is replaced too', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const apiBase = 'http://recovery.test/rejected-loop';
    script(apiBase, ['network']);
    // The UI's onError throwing inside the SDK's catch rejects the loop
    // without ever aborting the connection. Scoped to this apiBase, like the
    // fetch script, so another test's stream cannot consume the throw.
    let thrown = false;
    settleSemanticDeliveryBuffer.mockImplementation((base: unknown) => {
      if (base === apiBase && !thrown) {
        thrown = true;
        throw new Error('handler failure');
      }
    });
    ensureOrchestrationEventStream(apiBase);
    await settle();
    expect(requestsTo(apiBase)).toHaveLength(1);
    // ...and the dock stops claiming a live feed, loudly.
    expect(getStreamConnectionState(apiBase).phase).toBe('interrupted');
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('event stream ended unexpectedly'),
      expect.any(Error),
    );

    ensureOrchestrationEventStream(apiBase);
    await settle();
    expect(requestsTo(apiBase)).toHaveLength(2);
  });

  test('a recovery signal inside the floor is deferred to its end, not dropped', async () => {
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'performance',
        'Date',
      ],
    });
    try {
      const apiBase = 'http://recovery.test/parked-deferred';
      script(apiBase, 'always-401');
      ensureOrchestrationEventStream(apiBase);
      await vi.advanceTimersByTimeAsync(0);
      expect(requestsTo(apiBase)).toHaveLength(1);

      // The user comes back 20s after the refusal: too soon to ask again...
      await vi.advanceTimersByTimeAsync(20_000);
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(0);
      expect(requestsTo(apiBase)).toHaveLength(1);

      // ...but the signal is kept: one retry when the floor ends.
      await vi.advanceTimersByTimeAsync(10_001);
      expect(requestsTo(apiBase)).toHaveLength(2);

      // And only one: with no further signal the parked stream stays quiet.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(requestsTo(apiBase)).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
