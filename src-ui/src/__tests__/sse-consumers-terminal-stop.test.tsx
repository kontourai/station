/**
 * @vitest-environment jsdom
 *
 * archive#1094 (closing the SSE half of 's hot-loop-on-401 fix):
 * table-driven proof that every one of the five browser SSE consumers listed
 * in `authenticated-stream-inventory.test.ts`'s `PROTECTED_STREAM_CONSUMERS`
 * stops hammering its endpoint after a 401 — none of them override the
 * shared `fetchSSE` transport's terminal-stop behavior with something that
 * would defeat it (a bespoke reconnect-on-error loop, a `maxRetries`
 * override that only applies post-classification, etc). The actual
 * transient/terminal decision is proven exhaustively at the transport level
 * in `packages/sdk/src/__tests__/fetch-sse.test.ts`; this file proves each
 * production call site inherits it.
 */
import {
  PUBLIC_HANDSHAKE_SCHEMA_VERSION,
  PUBLIC_STATION_HANDSHAKE_PATH,
  REMOTE_AUTH_PROTOCOL_VERSION,
  STATION_COMPAT_MIN_CLIENT_PROTOCOL,
  STATION_COMPAT_PROTOCOL_VERSION,
} from '@kontourai/station-contracts/environment-security';
import { _setApiBase } from '@kontourai/station-sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const box = vi.hoisted(() => ({
  apiBase: 'https://sse-case-unset.example.test',
}));

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: box.apiBase }),
// The real hook returns undefined when no credential evidence exists —
// exactly this jsdom environment's state (main gained the export at
// module level; a mock without it fails the whole file at import).
  useHostRequestAuthorityScope: () => undefined,
}));
vi.mock('../contexts/ToastContext', () => ({
  toastStore: { show: vi.fn() },
  useToast: () => ({ showToast: vi.fn() }),
}));
vi.mock('../contexts/NavigationContext', () => ({
  navigationStore: { navigate: vi.fn() },
  useNavigation: () => ({ navigate: vi.fn() }),
}));

import { useMonitoring } from '../contexts/MonitoringContext';
import { ensureOrchestrationEventStream } from '../hooks/orchestration/ensureOrchestrationEventStream';
import { useSessionEventStream } from '../hooks/orchestration/useSessionEventStream';
import { useSchedulerEvents } from '../hooks/useScheduler';
import { useServerEvents } from '../hooks/useServerEvents';

/** A handshake that answers the session-event-window capability probe `true`. */
const CAPABLE_HANDSHAKE = {
  schemaVersion: PUBLIC_HANDSHAKE_SCHEMA_VERSION,
  environmentId: 'sse-backoff-fixture',
  authentication: {
    scheme: 'bearer',
    protocolVersion: REMOTE_AUTH_PROTOCOL_VERSION,
  },
  transports: {
    http: REMOTE_AUTH_PROTOCOL_VERSION,
    sse: REMOTE_AUTH_PROTOCOL_VERSION,
    websocket: REMOTE_AUTH_PROTOCOL_VERSION,
  },
  compatibility: {
    serverVersion: '0.4.1',
    protocolVersion: STATION_COMPAT_PROTOCOL_VERSION,
    minClientProtocol: STATION_COMPAT_MIN_CLIENT_PROTOCOL,
  },
  capabilities: { sessionEventWindow: true },
};

function queryWrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false, gcTime: 0 } },
        })
      }
    >
      {children}
    </QueryClientProvider>
  );
}

/**
 * Mounts one consumer against a global `fetch` that always answers 401, then
 * proves the number of attempts against `streamPathSubstring` stays flat
 * (the strong form: an attempt COUNT assertion, not just a state flag) over
 * a generous span of advanced fake-timer time — long enough to prove a dead
 * retry ladder, not just a slow one.
 */
async function expectNoHammeringAfter401(
  streamPathSubstring: string,
  mount: () => void,
  nonStreamRequestBudget = 3,
): Promise<void> {
  vi.useFakeTimers();
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response('', { status: 401 }),
  );
  vi.stubGlobal('fetch', fetchMock);
// Matched on BOTH the stream's own URL substring and the
// `Accept: text/event-stream` header `fetchSSE` always sets — some
// consumers (MonitoringContext) also issue a plain REST GET at the exact
// same path (with a query string) to hydrate history, which must not be
// conflated with the live-stream attempt count this asserts on.
  const matchingAttempts = () =>
    fetchMock.mock.calls.filter(([input, init]) => {
      if (!String(input).includes(streamPathSubstring)) return false;
      return new Headers(init?.headers).get('Accept') === 'text/event-stream';
    });

  act(() => mount());

  await act(async () => {
    await vi.waitFor(() => expect(matchingAttempts().length).toBe(1));
  });
  const requestsBeforeWait = fetchMock.mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120_000);
  });
  expect(matchingAttempts().length).toBe(1);
 // archive#3378: the `Accept` filter above cannot see a REST hot-loop
// BY CONSTRUCTION — it excludes every non-stream request a consumer makes,
// which is exactly where a history-window poll would live. A consumer that
// stopped hammering its stream while hammering an endpoint beside it would
// have satisfied this helper completely. Bound everything the consumer sends
// to this origin, not just the frames: the only legitimate growth here is
// `useSessionEventStream`'s capability re-probe, whose own budget
// (`MAX_AUTOMATIC_CAPABILITY_RECOVERIES`) is 3.
  const requestsDuringWait = fetchMock.mock.calls.length - requestsBeforeWait;
  expect(requestsDuringWait).toBeLessThanOrEqual(nonStreamRequestBudget);
}

interface ConsumerCase {
  name: string;
  streamPathSubstring: string;
  origin: string;
  mount: (apiBase: string) => void;
/**
* Non-stream requests this consumer may still send in the 120s after a 401.
* Default 3 — `useSessionEventStream`'s capability re-probe budget
* (`MAX_AUTOMATIC_CAPABILITY_RECOVERIES`), the only legitimate source. A
* case that raises it is declaring a REST loop the SSE terminal stop does
* not reach, and must say why.
*/
  nonStreamRequestBudget?: number;
}

const CASES: ConsumerCase[] = [
  {
    name: 'useServerEvents (useServerEvents.ts) — /events',
    streamPathSubstring: '/events',
    origin: 'https://sse-case-server-events.example.test',
    mount: () => {
      renderHook(() => useServerEvents(), { wrapper: queryWrapper });
    },
  },
  {
    name: 'useSessionEventStream (orchestration/useSessionEventStream.ts) — /api/orchestration/events?threadId=',
    streamPathSubstring: '/api/orchestration/events?threadId=',
    origin: 'https://sse-case-session-stream.example.test',
    mount: (apiBase) => {
      renderHook(() => useSessionEventStream(apiBase, 'thread-1'));
    },
  },
  {
    name: 'ensureOrchestrationEventStream (orchestration/ensureOrchestrationEventStream.ts) — /api/orchestration/events',
    streamPathSubstring: '/api/orchestration/events',
    origin: 'https://sse-case-orchestration-stream.example.test',
    mount: (apiBase) => {
      ensureOrchestrationEventStream(apiBase);
    },
  },
  {
    name: 'useSchedulerEvents (useScheduler.ts) — /scheduler/events',
    streamPathSubstring: '/scheduler/events',
    origin: 'https://sse-case-scheduler.example.test',
    mount: () => {
      renderHook(() => useSchedulerEvents(), { wrapper: queryWrapper });
    },
  },
  {
    name: 'useMonitoring (MonitoringContext.tsx) — /monitoring/events',
    streamPathSubstring: '/monitoring/events',
    origin: 'https://sse-case-monitoring.example.test',
    mount: (apiBase) => {
      _setApiBase(apiBase);
      renderHook(() => useMonitoring(), { wrapper: queryWrapper });
    },
// archive#3436: the REST stats poll beside the SSE stream now derives
// its own terminal stop from the same `isTerminalConnectionStatus`
// vocabulary (`resolveMonitoringStatsRefetchInterval`), so this case no
// longer needs a widened budget — the default (the capability re-probe's
// own ceiling) covers it like every other consumer.
  },
];

/**
 * archive#1848: the transient counterpart of the 401 case above. A 503 (or any
 * network failure) is correctly retried forever — the defect was the SHAPE of
 * that retry. Three of these five consumers configured
 * `maxRetryDelayMs === retryDelayMs`, which is not a backoff ladder but a
 * fixed-interval poll: a server that is down, restarting, or overloaded kept
 * receiving ~30, ~20 and ~12 requests per minute per open client, forever,
 * with the flat rate itself making recovery harder.
 *
 * The assertion is an attempt COUNT over a fixed span, because that is the
 * quantity the incident measured (175 requests in four minutes). The upper
 * bound below is what a geometric ladder produces in 120s; a flat poll at any
 * of the pre-fix intervals produces 25-61 and fails it. The lower bound keeps
 * the test from passing vacuously if a consumer ever stopped retrying
 * transient failures altogether.
 */
async function expectBoundedRetriesWhileFailing(
  streamPathSubstring: string,
  mount: () => void,
): Promise<void> {
  vi.useFakeTimers();
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response('', { status: 503 }),
  );
  vi.stubGlobal('fetch', fetchMock);

  const matchingAttempts = () =>
    fetchMock.mock.calls.filter(([input, init]) => {
      if (!String(input).includes(streamPathSubstring)) return false;
      return new Headers(init?.headers).get('Accept') === 'text/event-stream';
    });

  act(() => mount());

  await act(async () => {
    await vi.waitFor(() => expect(matchingAttempts().length).toBe(1));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120_000);
  });

  const attempts = matchingAttempts().length;
  expect(attempts).toBeGreaterThanOrEqual(4);
  expect(attempts).toBeLessThanOrEqual(12);
}

/**
 * `useSessionEventStream` is deliberately absent from the ladder table below,
 * because its reconnect is governed by a different mechanism.
 *
 * Precisely: its `onError` does NOT close the stream — it calls
* `negotiateWindow`, which re-probes the session-event-window capability and
 * closes the stream only when that probe comes back not-capable, scheduling
 * recovery at `SESSION_EVENT_WINDOW_CAPABILITY_RETRY_MS` (30s) /
 * `SESSION_EVENT_WINDOW_UNSUPPORTED_RETRY_MS` (60s). So which mechanism bounds
 * this consumer depends on whether the capability probe is also failing, and
 * both branches are pinned below rather than assumed:
*  - capability probe ALSO failing (everything 503): the stream is closed and
*    recovery runs on the capability cadence.
*  - capability probe HEALTHY, stream failing: nothing closes the stream, so
*    it rides `fetchSSE`'s ladder like every other consumer.
 */
const LADDER_CASES = CASES.filter(
  (streamCase) => !streamCase.streamPathSubstring.includes('?threadId='),
);

describe('station#1848: every protected SSE consumer backs off while the endpoint keeps failing', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(LADDER_CASES)(
    '$name',
    async ({ streamPathSubstring, origin, mount }) => {
// A distinct origin per describe: `ensureOrchestrationEventStream` holds
// a module-level single-flight map keyed by `apiBase`, so reusing the
 // archive#1094 origin here would make whichever block runs second a no-op.
      const laddered = origin.replace('https://', 'https://backoff-');
      box.apiBase = laddered;
      await expectBoundedRetriesWhileFailing(streamPathSubstring, () =>
        mount(laddered),
      );
    },
  );

  it('station#1848: an online event cuts a transient backoff short instead of sitting it out', async () => {
    vi.useFakeTimers();
    const origin = 'https://backoff-online-wake.example.test';
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response('', { status: 503 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    box.apiBase = origin;

    const attempts = () =>
      fetchMock.mock.calls.filter(
        ([input, init]) =>
          String(input).includes('/api/orchestration/events') &&
          new Headers(init?.headers).get('Accept') === 'text/event-stream',
      );

    act(() => {
      ensureOrchestrationEventStream(origin);
    });
    await act(async () => {
      await vi.waitFor(() => expect(attempts().length).toBe(1));
    });
// Climb to the ceiling, so the stream is now inside a 30s wait — the
// window in which a `station upgrade` restart used to leave a live feed
// frozen beside freshly refetched react-query lists.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    const beforeWake = attempts().length;

// Direction 1 — an online event BEFORE one base interval has elapsed is
// ignored. Stated precisely: the floor means a flapping adapter or a user
// switching tabs can at worst restore the BASE interval, and only while it
// keeps emitting signals — that is the pre-fix flat rate, not better than
// it. It is not a regression either, because the ladder's own value keeps
// doubling underneath, so the wait is already long once the signals stop.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(attempts().length).toBe(beforeWake);

// Direction 2 — past the floor, the same event reconnects immediately
// rather than sitting out the rest of a 30s wait.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    expect(attempts().length).toBe(beforeWake);

    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(50);
    });

    expect(attempts().length).toBe(beforeWake + 1);
  });

  it('station#1848: a visibilitychange while the tab is hidden does not wake the backoff', async () => {
    vi.useFakeTimers();
    const origin = 'https://backoff-hidden-tab.example.test';
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response('', { status: 503 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    box.apiBase = origin;

    const attempts = () =>
      fetchMock.mock.calls.filter(
        ([input, init]) =>
          String(input).includes('/api/orchestration/events') &&
          new Headers(init?.headers).get('Accept') === 'text/event-stream',
      );

    act(() => {
      ensureOrchestrationEventStream(origin);
    });
    await act(async () => {
      await vi.waitFor(() => expect(attempts().length).toBe(1));
    });
// Climb to the ceiling, then move past the base-interval floor so the
// ONLY thing separating the two dispatches below is `document.hidden`.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
      await vi.advanceTimersByTimeAsync(2_500);
    });
    const beforeWake = attempts().length;

// `visibilitychange` fires on the tab LEAVING as well as returning, so
// without the hidden guard a backgrounded tab reconnects on its way out —
// the wake that is least likely to find a recovered server, and the one a
// user is not there to benefit from.
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(attempts().length).toBe(beforeWake);

// The same event once the tab is visible again does wake it.
    hidden.mockReturnValue(false);
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(attempts().length).toBe(beforeWake + 1);
    hidden.mockRestore();
  });

  it('useSessionEventStream rides the ladder when the history window fails under a healthy capability probe', async () => {
    vi.useFakeTimers();
    const origin = 'https://backoff-session-capable.example.test';
// The variant the other fixture cannot express: the capability probe
// SUCCEEDS. This assertion is the inverse of the one it replaced.
//
// It used to pin a defect (archive#3378): with the probe healthy,
// `onOpen` (which fires even for a 503 response) starts hydration, the
// bounded history window fetch also fails, and `recoverPersistedEvents`'s
// catch called `authenticatedStream.close` — so the consumer STOPPED at
// two attempts, and no timer, wake or reconnect ever brought the session's
// live feed back. Bounded, but by a teardown, not by backoff, and a blip
// in ONE endpoint was enough to trigger it.
//
// A transient history failure no longer tears the stream down, so this
// consumer now backs off on `fetchSSE`'s shared ladder like every other
// one in the table above, and retries the history read on its own.
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) => {
        if (String(input).includes(PUBLIC_STATION_HANDSHAKE_PATH)) {
          return new Response(JSON.stringify(CAPABLE_HANDSHAKE), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('', { status: 503 });
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    box.apiBase = origin;

    const streamAttempts = () =>
      fetchMock.mock.calls.filter(
        ([input, init]) =>
          String(input).includes('/api/orchestration/events?threadId=') &&
          new Headers(init?.headers).get('Accept') === 'text/event-stream',
      );
    const windowAttempts = () =>
      fetchMock.mock.calls.filter(([input]) =>
        String(input).includes('/event-window'),
      );

    act(() => {
      renderHook(() => useSessionEventStream(origin, 'thread-capable'));
    });
    await act(async () => {
      await vi.waitFor(() => expect(streamAttempts().length).toBe(1));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });

// The history window was attempted MORE THAN ONCE — the single fact the
// pre-fix code could not produce, and the one the user-visible contract
// rests on: a session whose history read blipped gets another chance
// without a remount. `>= 2` rather than an exact count because two
// independent schedules drive it (this hook's own history backoff, and a
// fresh hydration on each reconnect the ladder below performs).
    expect(windowAttempts().length).toBeGreaterThanOrEqual(2);
// The same bounds `expectBoundedRetriesWhileFailing` holds every other
// consumer to. The lower bound is what fails if the teardown ever comes
// back (it read exactly 2); the upper bound is what fails if this
// consumer's own retry ever escaped into a flat poll.
    const streams = streamAttempts().length;
    expect(streams).toBeGreaterThanOrEqual(4);
    expect(streams).toBeLessThanOrEqual(12);
  });

  it('useSessionEventStream stops the history ladder on a 401 whose body is not JSON', async () => {
    vi.useFakeTimers();
    const origin = 'https://backoff-session-nonjson-401.example.test';
// archive#3378. `unwrapOrchestrationResponse` reached its
// `StationHttpError` throw only after `response.json` SUCCEEDED, so a
// 401 with a non-JSON body — what a reverse proxy, tunnel or access
// gateway in front of Station returns — surfaced as a bare `Error` and
// classified transient. The history ladder then polled an endpoint that
// can never clear, forever: the archive#1094 hot-loop class, reintroduced
// on a REST endpoint by the very fix that stopped the permanent freeze.
//
// The capability probe answers healthy so the window fetch actually runs;
// that is the only configuration in which the defect is reachable.
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) => {
        if (String(input).includes(PUBLIC_STATION_HANDSHAKE_PATH)) {
          return new Response(JSON.stringify(CAPABLE_HANDSHAKE), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (String(input).includes('/event-window')) {
          return new Response('<html>401 Unauthorized</html>', {
            status: 401,
            headers: { 'Content-Type': 'text/html' },
          });
        }
        return new Response('', { status: 503 });
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    box.apiBase = origin;

    const windowAttempts = () =>
      fetchMock.mock.calls.filter(([input]) =>
        String(input).includes('/event-window'),
      );

    act(() => {
      renderHook(() => useSessionEventStream(origin, 'thread-nonjson-401'));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });

// Exact, not a ceiling. A transient classification produces the geometric
// ladder's ~9 attempts over this span; a terminal one produces the single
// attempt that discovered the credential failure.
    expect(windowAttempts().length).toBe(1);
  });

  it('useSessionEventStream recovers through capability re-negotiation, not the retry ladder', async () => {
    vi.useFakeTimers();
    const origin = 'https://backoff-session-stream.example.test';
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response('', { status: 503 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    box.apiBase = origin;

    const streamAttempts = () =>
      fetchMock.mock.calls.filter(
        ([input, init]) =>
          String(input).includes('/api/orchestration/events?threadId=') &&
          new Headers(init?.headers).get('Accept') === 'text/event-stream',
      );

    act(() => {
      renderHook(() => useSessionEventStream(origin, 'thread-1'));
    });
    await act(async () => {
      await vi.waitFor(() => expect(streamAttempts().length).toBe(1));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });

// Bounded by the 30s/60s capability recovery cadence, not by a ladder —
// an unbounded value here would mean this consumer had grown its own
// reconnect loop and escaped the shared transport's accounting.
    expect(streamAttempts().length).toBeLessThanOrEqual(6);
  });
});

describe('station#1094: every protected SSE consumer stops hammering after a 401', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(CASES)(
    '$name',
    async ({ streamPathSubstring, origin, mount, nonStreamRequestBudget }) => {
      box.apiBase = origin;
      await expectNoHammeringAfter401(
        streamPathSubstring,
        () => mount(origin),
        nonStreamRequestBudget,
      );
    },
  );

  it('MonitoringContext connects with its first subscriber, closes with its last, and reconnects on resubscribe', async () => {
    const origin = 'https://sse-lifecycle-monitoring.example.test';
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Promise<Response>(() => undefined),
    );
    vi.stubGlobal('fetch', fetchMock);
    box.apiBase = origin;
    _setApiBase(origin);

    const streamAttempts = () =>
      fetchMock.mock.calls.filter(
        ([input, init]) =>
          String(input).includes('/monitoring/events') &&
          new Headers(init?.headers).get('Accept') === 'text/event-stream',
      );

    const first = renderHook(() => useMonitoring(), { wrapper: queryWrapper });
    await vi.waitFor(() => expect(streamAttempts()).toHaveLength(1));
    const firstSignal = streamAttempts()[0][1]?.signal as AbortSignal;
    expect(firstSignal.aborted).toBe(false);

    const second = renderHook(() => useMonitoring(), { wrapper: queryWrapper });
    await vi.waitFor(() => expect(streamAttempts()).toHaveLength(1));
    first.unmount();
    expect(firstSignal.aborted).toBe(false);

    second.unmount();
    expect(firstSignal.aborted).toBe(true);

    const resubscribed = renderHook(() => useMonitoring(), {
      wrapper: queryWrapper,
    });
    await vi.waitFor(() => expect(streamAttempts()).toHaveLength(2));
    resubscribed.unmount();
  });
});
