/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

const box = vi.hoisted(() => ({
  apiBase: 'https://monitoring-hydration.example.test',
}));
const fetchHistorical = vi.hoisted(() => vi.fn());
const sse = vi.hoisted(() => ({
  onMessage: undefined as ((event: { data: string }) => void) | undefined,
}));
const fetchSSE = vi.hoisted(() =>
  vi.fn(
    (_url: string, options?: { onMessage?: (e: { data: string }) => void }) => {
      sse.onMessage = options?.onMessage;
      return { close: vi.fn() };
    },
  ),
);

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: box.apiBase }),
}));
vi.mock('@kontourai/station-sdk', () => ({
  fetchMonitoringEvents: fetchHistorical,
  fetchSSE,
  useMonitoringStatsQuery: () => ({ data: undefined }),
}));

import { useMonitoring } from '../contexts/MonitoringContext';

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {children}
    </QueryClientProvider>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function settleable<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const event = (name: string) => [
  {
    timestamp: name,
    'timestamp.ms': 0,
    'trace.id': name,
    'gen_ai.operation.name': name,
    'span.kind': 'event' as const,
  },
];

describe('MonitoringContext historical hydration', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  test('newer remount hydration wins when an older request resolves last', async () => {
    const first = deferred<unknown[]>();
    const second = deferred<unknown[]>();
    fetchHistorical
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    box.apiBase = 'https://monitoring-remount.example.test';

    const initial = renderHook(() => useMonitoring(), { wrapper });
    await waitFor(() => expect(fetchHistorical).toHaveBeenCalledTimes(1));
    initial.unmount();
    const remounted = renderHook(() => useMonitoring(), { wrapper });
    await waitFor(() => expect(fetchHistorical).toHaveBeenCalledTimes(2));
    expect(fetchHistorical.mock.calls[0][2].aborted).toBe(true);

    await act(async () => second.resolve(event('newer remount')));
    await waitFor(() =>
      expect(remounted.result.current.events[0]?.timestamp).toBe(
        'newer remount',
      ),
    );
    await act(async () => first.resolve(event('older remount')));
    expect(remounted.result.current.events[0]?.timestamp).toBe('newer remount');
  });

  /*
   * Review MEDIUM-3: Retry used to re-derive the live default (`now - 5m`) at
   * click time, so a hydration of 11:55–12:00 that failed and was retried at
   * 12:08 asked for 12:03–12:08 and skipped the failed window forever. The
   * recorded bounds are re-asked instead; the END may widen to now, the START
   * never advances.
   *
   * Real timers on purpose: RTL's `waitFor` does not detect vitest's fake
   * timers and hangs. The discriminating claim is EQUALITY of the two start
   * bounds — pre-fix the retry's start is `Date.now() - 5m` recomputed after
   * the delay below, so it is strictly later by that delay.
   */
  const elapse = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  test('retry re-asks the window that failed, widening the end but never the start', async () => {
    fetchHistorical.mockRejectedValue(new Error('event log unreadable'));
    box.apiBase = 'https://monitoring-retry-window.example.test';

    const mounted = renderHook(() => useMonitoring(), { wrapper });
    await waitFor(() => expect(mounted.result.current.readError).toBeTruthy());
    const failedCall = fetchHistorical.mock.calls.at(-1)!;
    const failedStart = failedCall[0] as Date;
    const failedEnd = failedCall[1] as Date;

    await elapse(40);

    fetchHistorical.mockResolvedValue(event('after retry'));
    const before = fetchHistorical.mock.calls.length;
    act(() => mounted.result.current.retryRead());
    await waitFor(() =>
      expect(fetchHistorical.mock.calls.length).toBeGreaterThan(before),
    );

    const retryCall = fetchHistorical.mock.calls.at(-1)!;
    const retryStart = retryCall[0] as Date;
    const retryEnd = retryCall[1] as Date;
    // The failed interval is re-asked, not skipped.
    expect(retryStart.getTime()).toBe(failedStart.getTime());
    // ...and the end widened through the elapsed time rather than staying put.
    expect(retryEnd.getTime()).toBeGreaterThan(failedEnd.getTime());

    await waitFor(() => expect(mounted.result.current.readError).toBeNull());
  });

  test('a retry after a SUCCESSFUL read refreshes the current window, not a stale one', async () => {
    fetchHistorical.mockResolvedValue(event('first'));
    box.apiBase = 'https://monitoring-retry-fresh.example.test';

    const mounted = renderHook(() => useMonitoring(), { wrapper });
    await waitFor(() =>
      expect(mounted.result.current.events[0]?.timestamp).toBe('first'),
    );
    const firstStart = fetchHistorical.mock.calls.at(-1)![0] as Date;

    await elapse(40);

    const before = fetchHistorical.mock.calls.length;
    act(() => mounted.result.current.retryRead());
    await waitFor(() =>
      expect(fetchHistorical.mock.calls.length).toBeGreaterThan(before),
    );

    // No failure was recorded, so this is an ordinary refresh and the live
    // window moves with the clock.
    const refreshStart = fetchHistorical.mock.calls.at(-1)![0] as Date;
    expect(refreshStart.getTime()).toBeGreaterThan(firstStart.getTime());
  });

  /*
   * Review MEDIUM-4: a successful hydration ASSIGNED its snapshot over the
   * shared list, so an event the live stream had already shown the operator
   * disappeared the moment a lagging disk snapshot came back — and with an
   * empty snapshot the view then drew "No events yet" over it.
   */
  test('a lagging hydration snapshot does not erase an event the live stream delivered', async () => {
    fetchHistorical.mockRejectedValueOnce(new Error('event log unreadable'));
    box.apiBase = 'https://monitoring-sse-merge.example.test';

    const mounted = renderHook(() => useMonitoring(), { wrapper });
    await waitFor(() => expect(mounted.result.current.readError).toBeTruthy());
    expect(sse.onMessage).toBeTypeOf('function');

    // The live stream delivers an event while the failure is on screen.
    act(() =>
      sse.onMessage?.({ data: JSON.stringify(event('live arrival')[0]) }),
    );
    await waitFor(() =>
      expect(mounted.result.current.events.at(-1)?.timestamp).toBe(
        'live arrival',
      ),
    );

    // Retry succeeds, but disk persistence lags and returns nothing.
    fetchHistorical.mockResolvedValue([]);
    act(() => mounted.result.current.retryRead());
    await waitFor(() => expect(mounted.result.current.readError).toBeNull());

    // The live event survives, so the view cannot claim there are none.
    expect(mounted.result.current.events.map((e) => e.timestamp)).toEqual([
      'live arrival',
    ]);
  });

  /*
   * Delta review MEDIUM-2, end to end: two tool events emitted in the same
   * millisecond on the same trace. Under the four-field identity they
   * collided, so a snapshot carrying only the first confirmed BOTH and the
   * second vanished.
   */
  test('a same-millisecond sibling is not confirmed away by the first event', async () => {
    fetchHistorical.mockResolvedValueOnce([]);
    box.apiBase = 'https://monitoring-same-ms.example.test';

    const sameMs = (callId: string, tool: string) => ({
      timestamp: '2026-08-21T10:00:00.000Z',
      'timestamp.ms': 1_787_000_000_000,
      'trace.id': 'trace-same-ms',
      'gen_ai.operation.name': 'execute_tool',
      'span.kind': 'end' as const,
      'gen_ai.tool.name': tool,
      'gen_ai.tool.call.id': callId,
    });
    const first = sameMs('call-1', 'read_file');
    const second = sameMs('call-2', 'write_file');

    const mounted = renderHook(() => useMonitoring(), { wrapper });
    await waitFor(() => expect(fetchHistorical).toHaveBeenCalled());
    act(() => sse.onMessage?.({ data: JSON.stringify(first) }));
    act(() => sse.onMessage?.({ data: JSON.stringify(second) }));
    await waitFor(() => expect(mounted.result.current.events).toHaveLength(2));

    // Persistence has caught up with the FIRST event only.
    fetchHistorical.mockResolvedValue([first]);
    act(() => mounted.result.current.retryRead());
    await waitFor(() =>
      expect(fetchHistorical.mock.calls.length).toBeGreaterThan(1),
    );
    await waitFor(() => expect(mounted.result.current.events).toHaveLength(2));

    const toolCallIds = mounted.result.current.events.map(
      (entry) => entry['gen_ai.tool.call.id'],
    );
    expect(toolCallIds).toContain('call-1');
    expect(toolCallIds).toContain('call-2');
  });

  /*
   * Delta review MEDIUM-4: hydration returns oldest-first, SSE arrivals were
   * prepended newest-first, and the merge concatenated them unchanged — so
   * 10:00/10:01 from history plus 10:03 then 10:02 from the stream rendered
   * as 10:03, 10:02, 10:00, 10:01, and rows jumped again once a later
   * snapshot confirmed them.
   */
  test('the reconciled list is chronological however the events arrived', async () => {
    const at = (name: string, iso: string) => ({
      timestamp: name,
      'timestamp.ms': Date.parse(iso),
      'trace.id': name,
      'gen_ai.operation.name': 'invoke_agent',
      'span.kind': 'event' as const,
    });
    fetchHistorical.mockResolvedValueOnce([]);
    box.apiBase = 'https://monitoring-order.example.test';

    const mounted = renderHook(() => useMonitoring(), { wrapper });
    await waitFor(() => expect(fetchHistorical).toHaveBeenCalled());

    // The stream delivers 10:03 BEFORE 10:02 (a late-arriving row).
    act(() =>
      sse.onMessage?.({
        data: JSON.stringify(at('10:03', '2026-08-21T10:03:00.000Z')),
      }),
    );
    act(() =>
      sse.onMessage?.({
        data: JSON.stringify(at('10:02', '2026-08-21T10:02:00.000Z')),
      }),
    );
    await waitFor(() => expect(mounted.result.current.events).toHaveLength(2));

    // History catches up with the two older rows, oldest-first as the route
    // returns them.
    fetchHistorical.mockResolvedValue([
      at('10:00', '2026-08-21T10:00:00.000Z'),
      at('10:01', '2026-08-21T10:01:00.000Z'),
    ]);
    act(() => mounted.result.current.retryRead());
    await waitFor(() => expect(mounted.result.current.events).toHaveLength(4));

    expect(
      mounted.result.current.events.map((entry) => entry.timestamp),
    ).toEqual(['10:00', '10:01', '10:02', '10:03']);
  });

  /*
   * Delta review MEDIUM-3: the route returns rows oldest-first, so
   * `slice(0, 1000)` kept the OLDEST thousand and silently dropped the newest
   * of a 1,500-row day.
   */
  /*
   * Delta2 review MEDIUM-4: identity is derived by canonicalizing the whole
   * event, and hydration used to do that for EVERY returned row before the
   * cap ran — including the rows it was about to throw away — on the UI
   * thread. These two tests count the work by giving each row a getter that
   * fires when its payload is read.
   */
  function countingRow(
    name: string,
    timeMs: number,
    counter: { reads: number },
  ) {
    const row: Record<string, unknown> = {
      timestamp: name,
      'timestamp.ms': timeMs,
      'trace.id': name,
      'gen_ai.operation.name': 'execute_tool',
      'span.kind': 'end',
    };
    Object.defineProperty(row, 'gen_ai.tool.call.result', {
      enumerable: true,
      get() {
        counter.reads += 1;
        return { payload: name };
      },
    });
    return row;
  }

  test('rows that cannot survive the cap are never canonicalized', async () => {
    const counter = { reads: 0 };
    const base = Date.parse('2026-08-21T00:00:00.000Z');
    const many = Array.from({ length: 1500 }, (_, index) =>
      countingRow(`row-${index}`, base + index * 1000, counter),
    );
    fetchHistorical.mockResolvedValueOnce([]);
    box.apiBase = 'https://monitoring-cap-cost.example.test';

    const mounted = renderHook(() => useMonitoring(), { wrapper });
    await waitFor(() => expect(fetchHistorical).toHaveBeenCalled());
    // One unconfirmed arrival, so reconciliation really runs.
    act(() =>
      sse.onMessage?.({
        data: JSON.stringify({
          timestamp: 'live',
          'timestamp.ms': base + 2_000_000,
          'trace.id': 'live',
          'gen_ai.operation.name': 'invoke_agent',
          'span.kind': 'event',
        }),
      }),
    );
    await waitFor(() => expect(mounted.result.current.events).toHaveLength(1));

    counter.reads = 0;
    fetchHistorical.mockResolvedValue(many);
    act(() => mounted.result.current.retryRead());
    await waitFor(() =>
      expect(mounted.result.current.events).toHaveLength(1000),
    );

    // 1,500 rows came back; only the 1,000 that survive the cap may be
    // canonicalized, and each of those exactly once (the identity cache).
    expect(counter.reads).toBeLessThanOrEqual(1000);
    expect(counter.reads).toBeGreaterThan(0);
  });

  test('a hydration with nothing to reconcile canonicalizes nothing', async () => {
    const counter = { reads: 0 };
    const base = Date.parse('2026-08-21T00:00:00.000Z');
    fetchHistorical.mockResolvedValue(
      Array.from({ length: 5 }, (_, index) =>
        countingRow(`row-${index}`, base + index * 1000, counter),
      ),
    );
    box.apiBase = 'https://monitoring-no-reconcile.example.test';

    const mounted = renderHook(() => useMonitoring(), { wrapper });
    await waitFor(() => expect(mounted.result.current.events).toHaveLength(5));

    // No live arrival is awaiting confirmation, so there is nothing to
    // reconcile and no identity to compute.
    expect(counter.reads).toBe(0);
  });

  test('an over-cap snapshot keeps the most recent events, not the oldest', async () => {
    const base = Date.parse('2026-08-21T00:00:00.000Z');
    const many = Array.from({ length: 1500 }, (_, index) => ({
      timestamp: `row-${index}`,
      'timestamp.ms': base + index * 1000,
      'trace.id': `row-${index}`,
      'gen_ai.operation.name': 'invoke_agent',
      'span.kind': 'event' as const,
    }));
    fetchHistorical.mockResolvedValue(many);
    box.apiBase = 'https://monitoring-cap.example.test';

    const mounted = renderHook(() => useMonitoring(), { wrapper });
    await waitFor(() =>
      expect(mounted.result.current.events).toHaveLength(1000),
    );

    const kept = mounted.result.current.events.map((entry) => entry.timestamp);
    expect(kept.at(0)).toBe('row-500');
    expect(kept.at(-1)).toBe('row-1499');
    expect(kept).not.toContain('row-0');
  });

  test('a snapshot that DOES contain the live event keeps exactly one copy', async () => {
    fetchHistorical.mockResolvedValueOnce([]);
    box.apiBase = 'https://monitoring-sse-converge.example.test';

    const mounted = renderHook(() => useMonitoring(), { wrapper });
    await waitFor(() => expect(fetchHistorical).toHaveBeenCalled());
    const live = event('converging')[0];
    act(() => sse.onMessage?.({ data: JSON.stringify(live) }));
    await waitFor(() =>
      expect(mounted.result.current.events.at(-1)?.timestamp).toBe(
        'converging',
      ),
    );

    // The next snapshot has caught up and carries the same event.
    fetchHistorical.mockResolvedValue([live]);
    act(() => mounted.result.current.retryRead());
    await waitFor(() =>
      expect(fetchHistorical.mock.calls.length).toBeGreaterThan(1),
    );
    await waitFor(() => expect(mounted.result.current.events).toHaveLength(1));
    expect(mounted.result.current.events[0]?.timestamp).toBe('converging');
  });

  /*
   * Review verification gap: the generation/abort guards were only exercised
   * for two successes racing. A late-settling SUPERSEDED read must not
   * disturb the outcome of the read that replaced it, in either direction —
   * that is what keeps a stale failure from painting an error over live data,
   * and a stale success from clearing an error the operator is looking at.
   *
   * Each test forces a notification (one SSE arrival) after the late settle
   * before asserting. Without it these tests cannot see the defect at all: a
   * superseded read never reaches the `notify()` in its own `finally`, so a
   * poisoned `readError` sits in the store invisible to React until the next
   * notification — which in production is the very next live event. The first
   * version of these tests asserted that stale React snapshot and passed
   * against deliberately removed guards.
   */
  test('an older failure settling after a newer success leaves no error behind', async () => {
    const older = settleable<unknown[]>();
    const newer = settleable<unknown[]>();
    fetchHistorical
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    box.apiBase = 'https://monitoring-late-failure.example.test';

    const mounted = renderHook(() => useMonitoring(), { wrapper });
    await waitFor(() => expect(fetchHistorical).toHaveBeenCalledTimes(1));
    act(() => mounted.result.current.setDateRange('today'));
    await waitFor(() => expect(fetchHistorical).toHaveBeenCalledTimes(2));

    await act(async () => newer.resolve(event('newer success')));
    await waitFor(() =>
      expect(mounted.result.current.events[0]?.timestamp).toBe('newer success'),
    );

    await act(async () => {
      older.reject(new Error('older read failed late'));
      await older.promise.catch(() => undefined);
    });
    // The next live event is what flushes the store to the view.
    act(() => sse.onMessage?.({ data: JSON.stringify(event('flush a')[0]) }));
    await waitFor(() =>
      // Arrivals land at the END now — the list is chronological.
      expect(mounted.result.current.events.at(-1)?.timestamp).toBe('flush a'),
    );

    expect(mounted.result.current.readError).toBeNull();
    expect(
      mounted.result.current.events.map((entry) => entry.timestamp),
    ).toContain('newer success');
  });

  test('an older success settling after a newer failure does not clear the error', async () => {
    const older = settleable<unknown[]>();
    const newer = settleable<unknown[]>();
    fetchHistorical
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    box.apiBase = 'https://monitoring-late-success.example.test';

    const mounted = renderHook(() => useMonitoring(), { wrapper });
    await waitFor(() => expect(fetchHistorical).toHaveBeenCalledTimes(1));
    act(() => mounted.result.current.setDateRange('today'));
    await waitFor(() => expect(fetchHistorical).toHaveBeenCalledTimes(2));

    await act(async () => {
      newer.reject(new Error('newer read failed'));
      await newer.promise.catch(() => undefined);
    });
    await waitFor(() => expect(mounted.result.current.readError).toBeTruthy());

    await act(async () => older.resolve(event('older success')));
    act(() => sse.onMessage?.({ data: JSON.stringify(event('flush b')[0]) }));
    await waitFor(() =>
      // Arrivals land at the END now — the list is chronological.
      expect(mounted.result.current.events.at(-1)?.timestamp).toBe('flush b'),
    );

    expect(mounted.result.current.readError).toBeTruthy();
    expect(
      mounted.result.current.events.map((entry) => entry.timestamp),
    ).not.toContain('older success');
  });

  test('newer historical range hydration wins over an older live-mode hydration', async () => {
    const live = deferred<unknown[]>();
    const historical = deferred<unknown[]>();
    fetchHistorical
      .mockReturnValueOnce(live.promise)
      .mockReturnValueOnce(historical.promise);
    box.apiBase = 'https://monitoring-mode-switch.example.test';

    const mounted = renderHook(() => useMonitoring(), { wrapper });
    await waitFor(() => expect(fetchHistorical).toHaveBeenCalledTimes(1));
    act(() => mounted.result.current.setDateRange('today'));
    await waitFor(() => expect(fetchHistorical).toHaveBeenCalledTimes(2));
    expect(fetchHistorical.mock.calls[0][2].aborted).toBe(true);

    await act(async () => historical.resolve(event('newer historical')));
    await waitFor(() =>
      expect(mounted.result.current.events[0]?.timestamp).toBe(
        'newer historical',
      ),
    );
    await act(async () => live.resolve(event('older live')));
    expect(mounted.result.current.events[0]?.timestamp).toBe(
      'newer historical',
    );
  });
});
