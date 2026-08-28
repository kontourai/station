/**
 * @vitest-environment jsdom
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const fetchSession = vi.fn();
const close = vi.fn();
const fetchEventStreamResumeCapability = vi.fn().mockResolvedValue(false);
const fetchSessionEventWindowCapability = vi.fn().mockResolvedValue(true);
const resetSessionEventWindowCapabilityCache = vi.fn();
const resetSessionEventWindowCapabilityRecovery = vi.fn();
const invalidateSessionEventWindowCapabilityCache = vi.fn();
const claimSessionEventWindowCapabilityRecovery = vi.fn<
  (apiBase: string, threadId: string) => boolean
>(() => true);
let streamOptions: {
  onOpen?: () => void;
  onError?: (error?: unknown) => void;
  onTerminal?: (error: unknown) => void;
  onRetry?: () => void;
  onMessage?: (event: any) => void;
};
const fetchSSE = vi.fn((_url: string, options: typeof streamOptions) => {
  streamOptions = options;
  void Promise.resolve().then(() => options.onOpen?.());
  return { close };
});

/**
 * Mirrors `@kontourai/station-sdk`'s own `StationHttpError` (`status` first,
 * message second) because the hook's terminal/transient split for a history
 * failure is an `instanceof` check against the module this file replaces —
 * a locally-declared error would never match it, and the terminal case would
 * silently test the transient path instead.
 */
const sdk = vi.hoisted(() => ({
  StationHttpError: class StationHttpError extends Error {
    readonly status: number;
    constructor(status: number, message?: string) {
      super(message ?? `HTTP ${status}`);
      this.name = 'StationHttpError';
      this.status = status;
    }
  },
}));

vi.mock('@kontourai/station-sdk', () => ({
  StationHttpError: sdk.StationHttpError,
  fetchOrchestrationSessionEventWindow: (...args: unknown[]) =>
    fetchSession(...args).then(
      (detail: { events: unknown[] } & Record<string, unknown>) => ({
        protocolVersion: 1,
        hasMore: false,
        watermark: 0,
        ...detail,
        events: detail.events.map((item: any, index: number) => ({
          sequence: index + 1,
// archive#3386: the wire item carries the read's own budget report
// beside the event. A fixture opts in by wrapping an event as
// `{ event, elided }`; a bare event stays unlabelled.
          ...(item && typeof item === 'object' && 'event' in item
            ? item
            : { event: item }),
        })),
      }),
    ),
  fetchEventStreamResumeCapability: (...args: unknown[]) =>
    fetchEventStreamResumeCapability(...args),
  fetchSessionEventWindowCapability: (...args: unknown[]) =>
    fetchSessionEventWindowCapability(...args),
  claimSessionEventWindowCapabilityRecovery: (...args: [string, string]) =>
    claimSessionEventWindowCapabilityRecovery(...args),
  resetSessionEventWindowCapabilityCache: () =>
    resetSessionEventWindowCapabilityCache(),
  resetSessionEventWindowCapabilityRecovery: (...args: [string, string]) =>
    resetSessionEventWindowCapabilityRecovery(...args),
  invalidateSessionEventWindowCapabilityCache: (...args: [string]) =>
    invalidateSessionEventWindowCapabilityCache(...args),
  SESSION_EVENT_WINDOW_CAPABILITY_RETRY_MS: 30_000,
  SESSION_EVENT_WINDOW_UNSUPPORTED_RETRY_MS: 60_000,
  fetchSSE: (...args: [string, typeof streamOptions]) => fetchSSE(...args),
}));

import {
  MAX_FEED_EVENTS,
  mergeSessionEvents,
  useSessionEventStream,
} from '../hooks/orchestration/useSessionEventStream';

function event(eventId: string, createdAt: string) {
  return {
    eventId,
    provider: 'codex' as const,
    threadId: 'task:1',
    createdAt,
    method: 'session.started' as const,
    sessionId: 'task:1',
  };
}

describe('useSessionEventStream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
// archive#3522: `clearAllMocks` clears call history but leaves queued
// `mockResolvedValueOnce`/`mockRejectedValueOnce`/`mockImplementationOnce`
// values in place — only `mockReset` drains that queue. A test that
// fails before draining its own queue leaks the leftover value into the
// next test's first `fetchSession` call, which then returns the wrong
// payload, fails for an unrelated reason, and leaves ITS OWN queue
// undrained — cascading through the rest of the file. Measured with one
// genuine injected defect: pre-fix the whole file goes red around it,
// post-fix exactly ONE test fails, with identical failure text both
// times. (Absolute counts are deliberately not quoted here — they moved
 // within hours of being measured when archive#3553 added `fetchSession` call
// sites, and the argument rests on the one-versus-many shape, not the
// numbers.)
//
// `fetchSession` gets this explicitly rather than switching the whole
// `beforeEach` to `vi.resetAllMocks`, which was tried and measured
// BROKEN: on a clean tree with no injected defect, `resetAllMocks`
// reds most of the file. The reason: `fetchEventStreamResumeCapability`
// attaches its default (`.mockResolvedValue(false)`) AFTER construction
// (`vi.fn.mockResolvedValue(false)`, not `vi.fn(impl)`) and has no
// re-establishment line anywhere in this file — `mockReset` restores a
// mock only to whatever implementation was passed to `vi.fn` at
// construction, which for this one is nothing, so `resetAllMocks`
// silently strips its default to "no implementation" before every test
// runs, test #1 included (this `beforeEach` runs before the first test
// too, not just "after the first" — measured, and the 36 failures include
// it). `claimSessionEventWindowCapabilityRecovery` and `fetchSSE`, by
// contrast, DO pass their implementation at construction
// (`vi.fn( => true)`, `vi.fn((_url, options) => {...})`), so
// `mockReset` restores them correctly regardless; and
// `fetchSessionEventWindowCapability` shares
// `fetchEventStreamResumeCapability`'s after-construction shape but is
// separately defended by its own re-establishment line two lines below
// (`fetchSessionEventWindowCapability.mockResolvedValue(true)`), which
// would survive a `resetAllMocks` fine.
//
// `fetchSession` DOES carry persistent (non-Once) defaults set by four
// tests below (`fetchSession.mockRejectedValue(...)` /
// `.mockResolvedValue(...)`, not `Once` — search this file for those
// exact calls) — the fix is not "fetchSession has no persistent default
// to lose", it is that `mockReset` clearing those defaults is
// CORRECT: `vi.clearAllMocks` alone never touched them, so a leftover
// `mockRejectedValue(...)` from one test was silently the default
// `fetchSession` behaviour for the rest of the file whenever nothing
// queued a fresher `Once` value ahead of it — `mockReset` clears that
 // too, closing a second latent leak alongside the one archive#3522 named.
//
// `fetchSession` carries the overwhelming majority of this file's
// once-queue call sites. The remainder are 13 across four other mocks
// (`fetchSessionEventWindowCapability` 7,
// `fetchEventStreamResumeCapability` 3,
// `claimSessionEventWindowCapabilityRecovery` 2, `fetchSSE` 1), and none
// of them can cascade. Nine are queued alone. Of those, the
// `fetchEventStreamResumeCapability` and `fetchSSE` sites are consumed
// synchronously at mount — both calls sit at the effect body's top level
// and are issued unconditionally before the test body's assertions run —
// so nothing can leave them undrained. The two
// `claimSessionEventWindowCapabilityRecovery` sites are NOT mount-time:
// they are reached only via `scheduleCapabilityRecovery`, which runs when
// the capability probe resolves non-`true`, a path the test's own fixture
// has to create. They are safe for the other reason below instead — a
// residue there is `true`, identical to what `beforeEach` re-establishes. `fetchSessionEventWindowCapability`'s two `[x, true]`
// chains (4 of the 13 sites, two values queued per chain) are the only
// ones where a SECOND value waits on a later action (a re-probe or a
// remount) — the only place an early failure COULD leave something
// undrained — and in both cases that residue is `true`, identical to
// what this `beforeEach` re-establishes below, so it is currently
// indistinguishable from a fresh mount even when it leaks. None of the
 // 13 can currently cascade the way archive#3522 describes, but that is a
// property of today's fixtures, not a guarantee: a leaked once-value
// always beats this `beforeEach`'s re-establishment (the leftover queue
// entry is consumed before the freshly-set default ever applies), so if
// either of those two chains
// ever queues a second value other than `true`, it will cascade the same
// way `fetchSession` did. This mirrors the targeted `mockReset` the
 // archive#3445 test below already used by hand for the same reason.
    fetchSession.mockReset();
    claimSessionEventWindowCapabilityRecovery.mockReturnValue(true);
    fetchSessionEventWindowCapability.mockResolvedValue(true);
    streamOptions = {};
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('hydrates persisted events and recovers frames missed before reconnect', async () => {
    fetchSession
      .mockResolvedValueOnce({
        session: {},
        events: [event('evt-1', '2026-07-18T00:00:01.000Z')],
      })
      .mockResolvedValueOnce({
        session: {},
        events: [
          event('evt-1', '2026-07-18T00:00:01.000Z'),
          event('evt-2', '2026-07-18T00:00:02.000Z'),
        ],
      });

    const { result } = renderHook(() =>
      useSessionEventStream('http://station.test', 'task:1'),
    );

    await waitFor(() => expect(result.current.events).toHaveLength(1));
    act(() => streamOptions.onOpen?.());
    await waitFor(() => expect(result.current.events).toHaveLength(2));

    expect(result.current.connected).toBe(true);
    expect(fetchSession).toHaveBeenNthCalledWith(
      2,
      'task:1',
      'http://station.test',
      { turnLimit: 10 },
    );
  });

/**
* archive#3458 fix-round : `onOpen` firing only for a response
* the transport actually consumes means a live stream stuck retrying a
* 5xx/network failure never sets `streamOpened` — and hydration used to be
* gated on exactly that flag, so a session opened while Station sits
* behind a proxy returning 502/503/504 rendered an EMPTY FEED with
 * `connected: false` and no error: the persisted transcript archive#3378 built
* this path to survive a live-stream blip never loaded at all.
*
* Hydration's real dependency is not "the live stream opened" — it is "the
* host has answered at least one request", which a successful capability
* probe establishes on its own, entirely independent of the live stream's
* state. This drives the hook through the case with NO Response ever on
* the live stream (a network-level failure — `onOpen` cannot fire and
* `onError` fires with something other than a `StationHttpError`) and
* proves hydration still starts once the capability probe succeeds.
*/
  test('station#3458 fix-round: hydration starts from a successful capability probe even when the live stream never gets an HTTP response', async () => {
    fetchSession.mockResolvedValueOnce({
      session: {},
      events: [event('evt-1', '2026-07-18T00:00:01.000Z')],
    });
// Override the default mock so `onOpen` is NOT auto-fired for this one
// render — the live stream endpoint fails at the network level, so
// `fetchSSE` would only ever call `onError`, never `onOpen`.
    fetchSSE.mockImplementationOnce(
      (_url: string, options: typeof streamOptions) => {
        streamOptions = options;
        return { close };
      },
    );

    const { result, unmount } = renderHook(() =>
      useSessionEventStream('http://station.test', 'task:1'),
    );

    try {
// The live stream fails at the network level — this mock never calls
// `onOpen` for this render, only `onError`, with something that is not
// a `StationHttpError` (no Response ever arrived). `connected` is set
// ONLY inside `onOpen`, so it staying `false` for the whole test is the
// proof that path never ran.
      act(() => streamOptions.onError?.(new TypeError('Failed to fetch')));

// Hydration still completes: the capability probe (a separate REST
// call to the same host, resolved by
// `fetchSessionEventWindowCapability`'s own default
// `mockResolvedValue(true)`) succeeding is independent evidence the
// host answered, and is enough on its own.
      await waitFor(() => expect(result.current.events).toHaveLength(1));
      expect(fetchSession).toHaveBeenCalledTimes(1);
      expect(result.current.connected).toBe(false);
    } finally {
// Unmount explicitly: unlike most tests in this file, a REGRESSION
// here (hydration never starting) leaves this hook's effect live and
// its `waitFor` real-timeout pending for the file's remaining
// duration — every other test here settles quickly and its leftover
// mount goes idle, but this one specifically drives the case where it
// might not.
      unmount();
    }
  });

  test('station#1092: skips the reconnect refetch once the host advertises eventStreamResume, but keeps the initial-mount fetch', async () => {
    fetchEventStreamResumeCapability.mockResolvedValueOnce(true);
    fetchSession.mockResolvedValueOnce({
      session: {},
      events: [event('evt-1', '2026-07-18T00:00:01.000Z')],
    });

    const { result } = renderHook(() =>
      useSessionEventStream('http://station.test', 'task:1'),
    );

    await waitFor(() => expect(result.current.events).toHaveLength(1));
// The capability check resolves asynchronously; give it a tick to settle
// before the reconnect fires.
    await act(async () => {
      await Promise.resolve();
    });
    act(() => streamOptions.onOpen?.());
    await waitFor(() => expect(result.current.connected).toBe(true));

// Initial-mount fetch (archive#1092 design: "keep the initial-mount
// fetch") still happened once — but the reconnect's onOpen did NOT
// trigger a second one, because the server's Last-Event-ID replay makes
// it redundant.
    expect(fetchSession).toHaveBeenCalledTimes(1);
  });

  test('station#1092 AC3: drops a live frame whose sequence id is at or behind the last one applied', async () => {
    fetchSession.mockResolvedValueOnce({ session: {}, events: [] });

    const { result } = renderHook(() =>
      useSessionEventStream('http://station.test', 'task:1'),
    );
    await waitFor(() => expect(streamOptions.onMessage).toBeTruthy());

    act(() => {
      streamOptions.onMessage?.({
        event: 'orchestration:event',
        id: '5',
        data: JSON.stringify({
          event: event('evt-a', '2026-07-18T00:00:01.000Z'),
        }),
      });
    });
    await waitFor(() => expect(result.current.events).toHaveLength(1));

// A replayed/overlapping duplicate at the same (or an older) sequence
// must not be re-applied.
    act(() => {
      streamOptions.onMessage?.({
        event: 'orchestration:event',
        id: '5',
        data: JSON.stringify({
          event: event('evt-a', '2026-07-18T00:00:01.000Z'),
        }),
      });
      streamOptions.onMessage?.({
        event: 'orchestration:event',
        id: '4',
        data: JSON.stringify({
          event: event('evt-stale', '2026-07-18T00:00:00.500Z'),
        }),
      });
    });
// A tick for any (incorrect) state update to land before asserting it
// did not happen.
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.events).toHaveLength(1);

// A genuinely new sequence still applies.
    act(() => {
      streamOptions.onMessage?.({
        event: 'orchestration:event',
        id: '6',
        data: JSON.stringify({
          event: event('evt-b', '2026-07-18T00:00:02.000Z'),
        }),
      });
    });
    await waitFor(() => expect(result.current.events).toHaveLength(2));
  });

  test('station#1092 review fix (HIGH, defense in depth): a snapshot frame on this thread-scoped stream triggers a refetch instead of being silently discarded', async () => {
// Resume-capable host: onOpen alone would normally SKIP the refetch
// (the "skip the reconnect refetch" test above). A genuine per-thread
// gap>threshold (or any other reason the server fell back to snapshot)
// still needs to recover via the snapshot frame itself, since nothing
// else will ever redeliver those missed events once Last-Event-ID has
// advanced past them.
    fetchEventStreamResumeCapability.mockResolvedValueOnce(true);
    fetchSession
      .mockResolvedValueOnce({
        session: {},
        events: [event('evt-1', '2026-07-18T00:00:01.000Z')],
      })
      .mockResolvedValueOnce({
        session: {},
        events: [
          event('evt-1', '2026-07-18T00:00:01.000Z'),
          event('evt-missed', '2026-07-18T00:00:02.000Z'),
        ],
      });

    const { result } = renderHook(() =>
      useSessionEventStream('http://station.test', 'task:1'),
    );
    await waitFor(() => expect(result.current.events).toHaveLength(1));

    act(() => {
      streamOptions.onMessage?.({
        event: 'orchestration:snapshot',
        id: '42',
        data: JSON.stringify({ sessions: [] }),
      });
    });

    await waitFor(() => expect(result.current.events).toHaveLength(2));
    expect(result.current.events.map((item) => item.eventId)).toContain(
      'evt-missed',
    );
    expect(fetchSession).toHaveBeenCalledTimes(2);
  });

  test('deduplicates replayed live events and keeps chronological order', () => {
    expect(
      mergeSessionEvents(
        [event('evt-2', '2026-07-18T00:00:02.000Z')],
        [
          event('evt-1', '2026-07-18T00:00:01.000Z'),
          event('evt-2', '2026-07-18T00:00:02.000Z'),
        ],
      ).map((item) => item.eventId),
    ).toEqual(['evt-1', 'evt-2']);
  });

  test('retains more than 200 explicitly loaded events when a live frame arrives', () => {
    const loaded = Array.from({ length: 240 }, (_, index) => {
      const common = {
        ...event(
          `loaded-${index}`,
          `2026-07-18T00:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`,
        ),
        turnId: `turn-${Math.floor(index / 12)}`,
      };
      return index % 12 === 0
        ? {
            ...common,
            method: 'turn.started' as const,
            prompt: `prompt-${index}`,
          }
        : {
            ...common,
            method: 'content.text-delta' as const,
            itemId: `item-${index}`,
            delta: 'x',
          };
    });
    const preserved = new Set(loaded.map((item) => item.eventId!));
    const live = {
      ...event('live-1', '2026-07-18T01:00:00.000Z'),
      turnId: 'turn-live',
      method: 'turn.started' as const,
      prompt: 'new turn',
    };

    const merged = mergeSessionEvents(loaded, [live], preserved);

    expect(merged).toHaveLength(241);
    expect(merged[0]?.eventId).toBe('loaded-0');
    expect(merged.at(-1)?.eventId).toBe('live-1');
    expect(
      merged.filter((item) => item.method === 'turn.started'),
    ).toHaveLength(21);
  });

  test('bounds one 1000-event live turn while retaining its projection anchor', () => {
    const liveTurn = [
      {
        ...event('fanout-start', '2026-07-18T00:00:00.000Z'),
        method: 'turn.started' as const,
        turnId: 'fanout-turn',
        prompt: 'large turn',
      },
      ...Array.from({ length: 999 }, (_, index) => ({
        ...event(
          `fanout-${index}`,
          new Date(
            Date.parse('2026-07-18T00:00:00.000Z') + index + 1,
          ).toISOString(),
        ),
        method: 'content.text-delta' as const,
        turnId: 'fanout-turn',
        itemId: 'fanout-text',
        delta: 'x',
      })),
    ];

    const bounded = mergeSessionEvents([], liveTurn);

    expect(bounded).toHaveLength(MAX_FEED_EVENTS);
    expect(bounded[0]?.method).toBe('turn.started');
    expect(bounded[0]?.eventId).toBe('fanout-start');
    expect(bounded.at(-1)?.eventId).toBe('fanout-998');
  });

  test('the hook retains a >200-event persisted page after an actual live frame', async () => {
    const loaded = Array.from({ length: 240 }, (_, index) => ({
      ...event(
        `persisted-${index}`,
        `2026-07-18T00:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`,
      ),
      turnId: `turn-${Math.floor(index / 12)}`,
    }));
    fetchSession.mockResolvedValueOnce({
      session: {},
      watermark: 240,
      events: loaded,
    });
    const { result } = renderHook(() =>
      useSessionEventStream('http://station.test', 'task:1'),
    );
    await waitFor(() => expect(result.current.events).toHaveLength(240));

    act(() => {
      streamOptions.onMessage?.({
        event: 'orchestration:event',
        id: '241',
        data: JSON.stringify({
          event: {
            ...event('live-241', '2026-07-18T01:00:00.000Z'),
            turnId: 'turn-live',
          },
        }),
      });
    });

    await waitFor(() => expect(result.current.events).toHaveLength(241));
    expect(result.current.events[0]?.eventId).toBe('persisted-0');
    expect(result.current.events.at(-1)?.eventId).toBe('live-241');
  });

  test('loads a cursor page once, prepends it in order, and stops at the terminal page', async () => {
    fetchSession
      .mockResolvedValueOnce({
        session: {},
        watermark: 8,
        hasMore: true,
        nextCursor: 'older-turns',
        events: [event('evt-newer', '2026-07-18T00:00:02.000Z')],
      })
      .mockResolvedValueOnce({
        session: {},
        watermark: 8,
        hasMore: false,
        events: [event('evt-older', '2026-07-18T00:00:01.000Z')],
      });

    const { result } = renderHook(() =>
      useSessionEventStream('http://station.test', 'task:1'),
    );
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    await act(async () => {
      await result.current.loadOlder();
    });

    expect(result.current.events.map((item) => item.eventId)).toEqual([
      'evt-older',
      'evt-newer',
    ]);
    expect(result.current.hasMore).toBe(false);
    expect(fetchSession).toHaveBeenNthCalledWith(
      2,
      'task:1',
      'http://station.test',
      { cursor: 'older-turns', turnLimit: 20 },
    );

    await act(async () => {
      await result.current.loadOlder();
    });
    expect(fetchSession).toHaveBeenCalledTimes(2);
  });

  test('replaces all loaded rows after a snapshot gap without deriving upgrade-required from error prose', async () => {
    fetchEventStreamResumeCapability.mockResolvedValueOnce(true);
    fetchSession
      .mockResolvedValueOnce({
        session: {},
        watermark: 3,
        events: [event('evt-old', '2026-07-18T00:00:01.000Z')],
      })
      .mockResolvedValueOnce({
        session: {},
        watermark: 9,
        events: [event('evt-current', '2026-07-18T00:00:09.000Z')],
      });

    const { result } = renderHook(() =>
      useSessionEventStream('http://station.test', 'task:1'),
    );
    await waitFor(() =>
      expect(result.current.events[0]?.eventId).toBe('evt-old'),
    );

    act(() => {
      streamOptions.onMessage?.({
        event: 'orchestration:snapshot',
        id: '9',
        data: JSON.stringify({}),
      });
    });
    await waitFor(() =>
      expect(result.current.events.map((item) => item.eventId)).toEqual([
        'evt-current',
      ]),
    );

    fetchSession.mockRejectedValueOnce(
      new Error('404 session window requires an upgrade'),
    );
    act(() => {
      streamOptions.onMessage?.({
        event: 'orchestration:snapshot',
        id: '10',
        data: JSON.stringify({}),
      });
    });
    await waitFor(() =>
      expect(result.current.error?.message).toMatch(/upgrade/),
    );
    expect(result.current.upgradeRequired).toBe(false);
    expect(result.current.error?.message).toMatch(/upgrade/);
  });

  test('parks an older page ahead of the live watermark and merges it after the matching event', async () => {
    fetchSession
      .mockResolvedValueOnce({
        session: {},
        watermark: 5,
        hasMore: true,
        nextCursor: 'older-turns',
        events: [event('evt-current', '2026-07-18T00:00:02.000Z')],
      })
      .mockResolvedValueOnce({
        session: {},
        watermark: 8,
        hasMore: false,
        events: [event('evt-older', '2026-07-18T00:00:01.000Z')],
      });
    const { result } = renderHook(() =>
      useSessionEventStream('http://station.test', 'task:1'),
    );
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    await act(async () => {
      await result.current.loadOlder();
    });
    expect(result.current.events.map((item) => item.eventId)).toEqual([
      'evt-current',
    ]);

    act(() => {
      streamOptions.onMessage?.({
        event: 'orchestration:event',
        id: '8',
        data: JSON.stringify({
          event: event('evt-live', '2026-07-18T00:00:03.000Z'),
        }),
      });
    });
    await waitFor(() =>
      expect(result.current.events.map((item) => item.eventId)).toEqual([
        'evt-older',
        'evt-current',
        'evt-live',
      ]),
    );
  });

  test('drops an older page that resolves after snapshot replacement', async () => {
    let resolveOlder: ((page: Record<string, unknown>) => void) | undefined;
    fetchSession
      .mockResolvedValueOnce({
        session: {},
        watermark: 5,
        hasMore: true,
        nextCursor: 'older-turns',
        events: [event('evt-current', '2026-07-18T00:00:02.000Z')],
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOlder = resolve;
          }),
      )
      .mockResolvedValueOnce({
        session: {},
        watermark: 9,
        hasMore: false,
        events: [event('evt-replacement', '2026-07-18T00:00:09.000Z')],
      });
    const { result } = renderHook(() =>
      useSessionEventStream('http://station.test', 'task:1'),
    );
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    const older = result.current.loadOlder();
    act(() => {
      streamOptions.onMessage?.({
        event: 'orchestration:snapshot',
        id: '9',
        data: JSON.stringify({}),
      });
    });
    await waitFor(() =>
      expect(result.current.events.map((item) => item.eventId)).toEqual([
        'evt-replacement',
      ]),
    );
    resolveOlder?.({
      session: {},
      watermark: 5,
      hasMore: false,
      events: [event('evt-stale', '2026-07-18T00:00:01.000Z')],
    });
    await act(async () => {
      await older;
    });
    expect(result.current.events.map((item) => item.eventId)).toEqual([
      'evt-replacement',
    ]);
  });

  test('discards an older page behind the loaded watermark and replaces it from a fresh window', async () => {
    fetchSession
      .mockResolvedValueOnce({
        session: {},
        watermark: 8,
        hasMore: true,
        nextCursor: 'older-turns',
        events: [event('evt-current', '2026-07-18T00:00:02.000Z')],
      })
      .mockResolvedValueOnce({
        session: {},
        watermark: 7,
        hasMore: false,
        events: [event('evt-removed', '2026-07-18T00:00:01.000Z')],
      })
      .mockResolvedValueOnce({
        session: {},
        watermark: 9,
        hasMore: false,
        events: [event('evt-reconciled', '2026-07-18T00:00:09.000Z')],
      });
    const { result } = renderHook(() =>
      useSessionEventStream('http://station.test', 'task:1'),
    );
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    await act(async () => {
      await result.current.loadOlder();
    });
    await waitFor(() =>
      expect(result.current.events.map((item) => item.eventId)).toEqual([
        'evt-reconciled',
      ]),
    );
    expect(fetchSession).toHaveBeenCalledTimes(3);
  });

  test('subscribes before hydration and retains a frame buffered during the snapshot request', async () => {
    let resolveWindow: ((page: Record<string, unknown>) => void) | undefined;
    fetchSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveWindow = resolve;
        }),
    );
    const { result } = renderHook(() =>
      useSessionEventStream('http://station.test', 'task:1'),
    );
    await waitFor(() => expect(streamOptions.onMessage).toBeTruthy());
    await waitFor(() => expect(fetchSession).toHaveBeenCalledTimes(1));

    act(() => {
      streamOptions.onMessage?.({
        event: 'orchestration:event',
        id: '9',
        data: JSON.stringify({
          event: event('evt-buffered', '2026-07-18T00:00:09.000Z'),
        }),
      });
    });
    resolveWindow?.({
      session: {},
      watermark: 5,
      hasMore: false,
      events: [event('evt-snapshot', '2026-07-18T00:00:05.000Z')],
    });

    await waitFor(() =>
      expect(result.current.events.map((item) => item.eventId)).toEqual([
        'evt-snapshot',
        'evt-buffered',
      ]),
    );
  });

  test('closes the stream and exposes upgrade-required when capability negotiation fails', async () => {
    fetchSessionEventWindowCapability.mockResolvedValueOnce(false);
    const { result } = renderHook(() =>
      useSessionEventStream('http://station.test', 'task:1'),
    );

    await waitFor(() => expect(result.current.upgradeRequired).toBe(true));
    expect(close).toHaveBeenCalled();
    expect(fetchSession).not.toHaveBeenCalled();
  });

  test('closes the stream and exposes a transport failure without an upgrade claim when capability negotiation is undetermined', async () => {
    fetchSessionEventWindowCapability.mockResolvedValueOnce(undefined);
    const { result } = renderHook(() =>
      useSessionEventStream('http://station.test', 'task:1'),
    );

    await waitFor(() =>
      expect(result.current.error?.message).toBe(
        'Session history transport failed.',
      ),
    );
    expect(result.current.upgradeRequired).toBe(false);
    expect(close).toHaveBeenCalled();
    expect(fetchSession).not.toHaveBeenCalled();
  });

  test('re-probes a closed mounted stream after cooldown and reopens it when capable', async () => {
    vi.useFakeTimers();
    fetchSessionEventWindowCapability
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(true);
    fetchSession.mockResolvedValueOnce({ session: {}, events: [] });

    const { result } = renderHook(() =>
      useSessionEventStream('http://station.test', 'task:1'),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.error?.message).toBe(
      'Session history transport failed.',
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchSessionEventWindowCapability).toHaveBeenCalledTimes(2);
    expect(fetchSession).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeUndefined();
    expect(fetchSSE).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
  });

  test('a same-host remount re-negotiates after a transient unsupported capability result', async () => {
    fetchSessionEventWindowCapability
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    fetchSession.mockResolvedValueOnce({ session: {}, events: [] });
    const first = renderHook(() =>
      useSessionEventStream('http://station.test', 'task:1'),
    );
    await waitFor(() => expect(close).toHaveBeenCalled());
    first.unmount();

    renderHook(() => useSessionEventStream('http://station.test', 'task:1'));
    await waitFor(() => expect(fetchSession).toHaveBeenCalledTimes(1));
    expect(fetchSessionEventWindowCapability).toHaveBeenCalledTimes(2);
    expect(resetSessionEventWindowCapabilityCache).not.toHaveBeenCalled();
  });

  test('does not restore an exhausted recovery budget when the session remounts', async () => {
    vi.useFakeTimers();
    fetchSessionEventWindowCapability.mockResolvedValue(false);
    const recoveryClaims = new Map<string, number>();
    claimSessionEventWindowCapabilityRecovery.mockImplementation(
      (apiBase, threadId) => {
        const key = `${apiBase}\u0000${threadId}`;
        const attempts = recoveryClaims.get(key) ?? 0;
        if (attempts >= 3) return false;
        recoveryClaims.set(key, attempts + 1);
        return true;
      },
    );
    const first = renderHook(() =>
      useSessionEventStream('http://station.test', 'task:1'),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180_000);
    });
    expect(fetchSessionEventWindowCapability).toHaveBeenCalledTimes(4);
    first.unmount();

    renderHook(() => useSessionEventStream('http://station.test', 'task:1'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180_000);
    });
    expect(fetchSessionEventWindowCapability).toHaveBeenCalledTimes(5);
  });

  test('cancels every overlapping capability recovery timer on unmount', async () => {
    vi.useFakeTimers();
    fetchSessionEventWindowCapability.mockResolvedValue(false);
    const mounted = renderHook(() =>
      useSessionEventStream('http://station.test', 'task:1'),
    );
    await act(async () => {
      await Promise.resolve();
    });
    act(() => streamOptions.onError?.());
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchSessionEventWindowCapability).toHaveBeenCalledTimes(2);
    mounted.unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchSessionEventWindowCapability).toHaveBeenCalledTimes(2);
  });

/**
* archive#3378. This block replaces the pin that used to live here
* ('closes and clears a failed hydration instead of buffering later
* frames'): a transient `/event-window` failure closed the live stream and
* nothing ever reopened it, so a blip in one endpoint took the session's
* live feed down until the component remounted. The stream stays up now,
* the buffered frame is kept, and the history read retries on its own
* ladder — only a credential failure still stops.
*/
  test('keeps the live stream and retries a transient hydration failure', async () => {
    vi.useFakeTimers();
    let rejectWindow: ((cause: Error) => void) | undefined;
    fetchSession
// Deferred rather than pre-rejected so a frame can be delivered while
// the history request is still IN FLIGHT. That ordering is what makes
// the buffer-retention claim below testable: a frame dispatched after
// the failure was never at risk from the pre-fix
// `bufferedLive.splice(0)`, which ran at the moment of the failure.
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectWindow = reject;
          }),
      )
      .mockResolvedValueOnce({
        session: {},
        watermark: 0,
        hasMore: false,
        events: [event('evt-recovered', '2026-07-18T00:00:01.000Z')],
      });
    const { result } = renderHook(() =>
      useSessionEventStream('http://station.test', 'task:1'),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => {
      streamOptions.onMessage?.({
        event: 'orchestration:event',
        id: '9',
        data: JSON.stringify({
          event: event('evt-inflight', '2026-07-18T00:00:09.000Z'),
        }),
      });
    });

    await act(async () => {
      rejectWindow?.(new Error('window unavailable'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.error?.message).toBe('window unavailable');
// Derived from the pending retry, not asserted beside it: this is what
// separates "history is late" from "history stopped".
    expect(result.current.historyRetrying).toBe(true);
    expect(close).not.toHaveBeenCalled();

// And a frame that arrives after the failure, while the retry is pending,
// keeps buffering against the still-open stream.
    act(() => {
      streamOptions.onMessage?.({
        event: 'orchestration:event',
        id: '12',
        data: JSON.stringify({
          event: event('evt-after-error', '2026-07-18T00:00:12.000Z'),
        }),
      });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(fetchSession).toHaveBeenCalledTimes(2);
    expect(result.current.events.map((item) => item.eventId)).toEqual([
      'evt-recovered',
      'evt-inflight',
      'evt-after-error',
    ]);
    expect(result.current.error).toBeUndefined();
    expect(result.current.historyRetrying).toBe(false);
// archive#3426: a hydration that recovered after a transient failure was
// never stopped for good — nothing here should have flipped the flag.
    expect(result.current.historyStoppedTerminal).toBe(false);
  });

  test('backs the history retry off geometrically instead of polling flat', async () => {
    vi.useFakeTimers();
    fetchSession.mockRejectedValue(new Error('window unavailable'));
    const { result } = renderHook(() =>
      useSessionEventStream('http://station.test', 'task:1'),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchSession).toHaveBeenCalledTimes(1);
// archive#3426: a transient (non-401/403) failure keeps retrying — this
// is the "retrying" state, not "stopped for good".
    expect(result.current.historyStoppedTerminal).toBe(false);

// 1s, 2s, 4s, 8s, 16s: five retries inside 31s. A flat poll at the base
// interval would have run 31, and a dead ladder — the pre-fix behavior —
// would still read 1.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(fetchSession).toHaveBeenCalledTimes(6);

// The ceiling is the capability path's own re-probe cadence: from here
// the next 120s buys exactly four more attempts, not forty.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(fetchSession).toHaveBeenCalledTimes(10);
  });

  test('stops on a credential failure instead of retrying a window that cannot clear', async () => {
    vi.useFakeTimers();
    fetchSession.mockRejectedValue(
      new sdk.StationHttpError(401, 'Unauthorized'),
    );
    const { result } = renderHook(() =>
      useSessionEventStream('http://station.test', 'task:1'),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.error?.message).toBe('Unauthorized');
    expect(result.current.historyRetrying).toBe(false);
// archive#3426: this is the "stopped for good" story, not "coming back"
// `historyRetrying === false` alone cannot tell those apart (it also
// reads false before anything has ever failed).
    expect(result.current.historyStoppedTerminal).toBe(true);
    expect(close).toHaveBeenCalled();

    act(() => {
      streamOptions.onMessage?.({
        event: 'orchestration:event',
        id: '12',
        data: JSON.stringify({
          event: event('evt-after-error', '2026-07-18T00:00:12.000Z'),
        }),
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(fetchSession).toHaveBeenCalledTimes(1);
    expect(result.current.events).toEqual([]);
  });

/**
* archive#3445: a history retry timer scheduled by an EARLIER transient
* failure is not cancelled by a LATER terminal (401/403) failure on a
* different, independently-triggered hydration attempt (here, a snapshot
* frame forcing a second `recoverPersistedEvents` call while the first
* attempt's retry is still pending). Pre-fix, the stale timer fired
* anyway, re-ran the request, succeeded, and silently cleared
* `historyStoppedTerminal`/`error` — the worst state available: a
* live-looking session (`connected` never touched) with its SSE stream
* already `close`d and nothing left to reopen it. The fix cancels the
* pending timer from the terminal branch, so it never fires and the
* terminal state survives.
*/
  test('station#3445: a history retry scheduled before a terminal failure does not survive it', async () => {
    vi.useFakeTimers();
    fetchSession
// Attempt 1 (initial-mount hydration): transient failure, schedules a
// retry ~1000ms (HISTORY_RETRY_BASE_MS) out.
      .mockRejectedValueOnce(new Error('window unavailable'))
// Attempt 2 (forced by the snapshot frame below, independent of the
// scheduled retry): terminal.
      .mockRejectedValueOnce(new sdk.StationHttpError(401, 'Unauthorized'))
// Attempt 3 would only run if the stale retry from attempt 1 survives
// the terminal outcome and fires anyway — it must never be called.
      .mockResolvedValueOnce({
        session: {},
        watermark: 0,
        hasMore: false,
        events: [event('evt-should-not-arrive', '2026-07-18T00:00:03.000Z')],
      });

    const { result } = renderHook(() =>
      useSessionEventStream('http://station.test', 'task:1'),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchSession).toHaveBeenCalledTimes(1);
    expect(result.current.historyRetrying).toBe(true);
    expect(result.current.historyStoppedTerminal).toBe(false);

// Force a second, independent hydration attempt (the snapshot path)
// while attempt 1's retry timer is still pending. This one is terminal.
    act(() => {
      streamOptions.onMessage?.({
        event: 'orchestration:snapshot',
        id: '50',
        data: JSON.stringify({ sessions: [] }),
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(fetchSession).toHaveBeenCalledTimes(2);
    expect(result.current.historyStoppedTerminal).toBe(true);
    expect(result.current.historyRetrying).toBe(false);
    expect(close).toHaveBeenCalled();

// Advance well past attempt 1's retry delay (1000ms, doubling from
// there). Pre-fix, the stale timer fired here: a third fetchSession
// call, a success, and historyStoppedTerminal/error silently cleared.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(fetchSession).toHaveBeenCalledTimes(2);
    expect(result.current.historyStoppedTerminal).toBe(true);
    expect(result.current.historyRetrying).toBe(false);
    expect(result.current.error).toBeInstanceOf(Error);

// The queued "attempt 3" response is deliberately never consumed (that
// is the assertion above) — `vi.clearAllMocks` in `beforeEach` clears
// call history but not a mock's queued `mockResolvedValueOnce`/
// `mockRejectedValueOnce` values, so drain it explicitly or it leaks
// into the next test's first `fetchSession` call.
    fetchSession.mockReset();
  });

/**
 * archive#3518: the sibling of archive#3445. There, a retry's TIMER survived a
* terminal because the timer was still pending and never cancelled. Here
* the retry's timer has already fired — its callback already cleared
* `historyRetryTimer`/`historyRetryScheduled` before calling
* `recoverPersistedEvents` — so `cancelHistoryRetry` (a no-op on an
* already-cleared timer) cannot reach it at all. The call itself is a live
* promise, independent of a LATER, different call that establishes the
* terminal outcome in the meantime. Pre-fix, this promise resolving
* successfully silently cleared `historyStoppedTerminal` and `error`
* (`epoch.current` does not help: only the success path bumps it, and this
* call's own success path is exactly what is being suppressed), leaving
* `connected: true` with the SSE stream already `close`d and nothing
* left to reopen it — the worst state available.
*/
  test('station#3518: a retry already in flight when a terminal is established must not clear it on success', async () => {
    vi.useFakeTimers();
    let resolveRetryAttempt: ((value: unknown) => void) | undefined;
    fetchSession
// Attempt A (initial-mount hydration): transient failure, schedules a
// retry ~1000ms (HISTORY_RETRY_BASE_MS) out.
      .mockRejectedValueOnce(new Error('window unavailable'))
// Attempt B: the retry timer's own call. Held open so it resolves
// AFTER attempt C below has already established the terminal outcome
// the exact race the issue describes.
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRetryAttempt = resolve;
          }),
      )
// Attempt C (forced by the snapshot frame below, independent of B's
// still-pending retry): terminal.
      .mockRejectedValueOnce(new sdk.StationHttpError(401, 'Unauthorized'));

    const { result } = renderHook(() =>
      useSessionEventStream('http://station.test', 'task:1'),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchSession).toHaveBeenCalledTimes(1);
    expect(result.current.historyRetrying).toBe(true);

// The retry timer fires: attempt B starts and is held open by the
// controlled promise above — `historyRetryTimer` is now `undefined`
// (the timer callback cleared it before calling `recoverPersistedEvents`
// see `scheduleHistoryRetry`), so `cancelHistoryRetry` below has
// nothing left to cancel.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(fetchSession).toHaveBeenCalledTimes(2);
    expect(resolveRetryAttempt).toBeTruthy();

// A snapshot frame forces attempt C, independent of B's still-pending
// retry, and it is terminal.
    act(() => {
      streamOptions.onMessage?.({
        event: 'orchestration:snapshot',
        id: '50',
        data: JSON.stringify({ sessions: [] }),
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchSession).toHaveBeenCalledTimes(3);
    expect(result.current.historyStoppedTerminal).toBe(true);
    expect(result.current.error?.message).toBe('Unauthorized');
    expect(close).toHaveBeenCalled();

// Attempt B — started before the terminal, still in flight — now
// resolves successfully.
    await act(async () => {
      resolveRetryAttempt?.({
        session: {},
        watermark: 0,
        hasMore: false,
        events: [event('evt-should-not-clear', '2026-07-18T00:00:03.000Z')],
      });
      await vi.advanceTimersByTimeAsync(0);
    });

// The terminal signal and the error it explains must survive B's
// success. `connected` stays `true` here — set earlier by this stream's
// own `onOpen`, unrelated to the history window — which is exactly why
// `historyStoppedTerminal`/`error` surviving matters: they are the only
// signals that tell an otherwise live-looking session its feed is dead.
    expect(result.current.historyStoppedTerminal).toBe(true);
    expect(result.current.error?.message).toBe('Unauthorized');
    expect(result.current.connected).toBe(true);
    expect(result.current.historyRetrying).toBe(false);
// B's payload was never applied — the stale success bailed before
// reaching `apply`.
    expect(result.current.events).toEqual([]);
  });

/**
* archive#3518, the symmetric direction: a transient (non-terminal)
* rejection that is still in flight when a DIFFERENT, later call
* establishes the terminal outcome must not re-arm polling once it
* finally lands. Nothing in effect scope could prevent this before the
* fix, because `historyStoppedTerminal` is React state — the async
* continuation resuming after the terminal has no synchronous way to read
* it.
*
* Fix round: the same stale window also let the late rejection overwrite
* the honest terminal `error` message with its own transient one — the UI
* would then show "stopped for good" annotated with a network blip instead
* of the credential rejection that actually stopped it. This pins that the
* terminal's `'Unauthorized'` message survives the late rejection too.
*/
  test('station#3518: a late non-terminal rejection after a terminal must not re-arm the retry', async () => {
    vi.useFakeTimers();
    let rejectInitialAttempt: ((reason: unknown) => void) | undefined;
    fetchSession
// Attempt A (initial-mount hydration): held open. Rejects LATE, after
// attempt C below has already established the terminal outcome.
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectInitialAttempt = reject;
          }),
      )
// Attempt C (forced by the snapshot frame below, independent of A's
// still-pending attempt): terminal.
      .mockRejectedValueOnce(new sdk.StationHttpError(401, 'Unauthorized'));

    const { result } = renderHook(() =>
      useSessionEventStream('http://station.test', 'task:1'),
    );

// Attempt A (initial hydration) starts and is held open.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchSession).toHaveBeenCalledTimes(1);
    expect(rejectInitialAttempt).toBeTruthy();
    expect(result.current.historyRetrying).toBe(false);

// A snapshot frame forces attempt C, independent of A's still-pending
// attempt, and it is terminal.
    act(() => {
      streamOptions.onMessage?.({
        event: 'orchestration:snapshot',
        id: '50',
        data: JSON.stringify({ sessions: [] }),
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchSession).toHaveBeenCalledTimes(2);
    expect(result.current.historyStoppedTerminal).toBe(true);
    expect(result.current.error?.message).toBe('Unauthorized');

// Attempt A finally rejects — non-terminally — AFTER the terminal was
// already established. Pre-fix, this called `scheduleHistoryRetry`
// unconditionally, re-arming polling over a session already stopped for
// good, AND overwrote the honest terminal error with this transient
// message.
    await act(async () => {
      rejectInitialAttempt?.(new Error('window unavailable'));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.historyRetrying).toBe(false);
    expect(result.current.historyStoppedTerminal).toBe(true);
// Fix round: the credential-rejection message must survive the late
// transient rejection, not be overwritten by it.
    expect(result.current.error?.message).toBe('Unauthorized');

// Advance well past the retry base delay (1000ms): if a retry HAD been
// scheduled, this fires it and calls fetchSession a third time.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(fetchSession).toHaveBeenCalledTimes(2);
  });

/**
* archive#3518: `recoverPersistedEvents`'s success path checks
* `epoch.current` TWICE — once right after the `await`, once inside the
* `queue.current.then` callback it goes on to enqueue. The first check is
 * provably redundant against the two tests above (: dropping
* either check alone still passes both, because in both tests the terminal
* branch — which does not touch `queue.current` at all — has already run by
* the time EITHER checkpoint gets its turn). This test constructs the one
* window where they diverge: a terminal landing strictly BETWEEN this call
* reaching its first checkpoint and its queued callback's own turn. The
* first checkpoint passes (nothing has bumped `epoch.current` yet); only
* the second one, evaluated one microtask-queue turn later, observes the
* bump and bails — proving the queued checkpoint is what actually closes
* this window, not the early one.
*
* Construction: resolve the call under test, then reject the terminal call,
* synchronously back to back. Both go through the same mock transform hop
* (`fetchSession(...).then(...)` in this file's `fetchOrchestrationSessionEventWindow`
* mock), so both take the same number of microtask ticks to reach their
* respective `await` continuations — but the call under test's ENQUEUE onto
* `queue.current` (which schedules its own queued callback as a NEW,
* later-turn microtask) only happens once its first checkpoint has already
* run, by which point the terminal call's continuation is already ahead of
* it in the microtask queue. This is deterministic microtask-queue FIFO
* ordering, not a timing-dependent race.
*/
  test('station#3518 fix round: a terminal landing while the queue drains still blocks the queued success', async () => {
    let resolveInitial: ((value: unknown) => void) | undefined;
    let rejectSnapshot: ((reason: unknown) => void) | undefined;
    fetchSession
// Attempt B (initial hydration): held open.
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveInitial = resolve;
          }),
      )
// Attempt C (forced by a snapshot frame, independent of B): held open,
// rejected with a terminal cause once both are in flight.
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectSnapshot = reject;
          }),
      );

    const { result } = renderHook(() =>
      useSessionEventStream('http://station.test', 'task:1'),
    );

// Let the mount settle: onOpen fires, capability negotiation resolves,
// and attempt B (initial hydration) starts.
    await waitFor(() => expect(resolveInitial).toBeTruthy());
    expect(fetchSession).toHaveBeenCalledTimes(1);

// A snapshot frame forces attempt C, independent of B's still-pending
// attempt.
    act(() => {
      streamOptions.onMessage?.({
        event: 'orchestration:snapshot',
        id: '50',
        data: JSON.stringify({ sessions: [] }),
      });
    });
    await waitFor(() => expect(rejectSnapshot).toBeTruthy());
    expect(fetchSession).toHaveBeenCalledTimes(2);

// Resolve B, then reject C — in that synchronous order. See the docblock
// above for why this reliably lands the terminal bump strictly between
// B's two checkpoints rather than before both or after both.
    await act(async () => {
      resolveInitial?.({
        session: {},
        watermark: 0,
        hasMore: false,
        events: [event('evt-should-not-clear', '2026-07-18T00:00:03.000Z')],
      });
      rejectSnapshot?.(new sdk.StationHttpError(401, 'Unauthorized'));
// Real macrotask boundary: guarantees every already-queued microtask
// (both promise chains, fully) has drained before we assert.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(result.current.historyStoppedTerminal).toBe(true);
    expect(result.current.error?.message).toBe('Unauthorized');
// B's payload was never applied — the queued checkpoint bailed before
// reaching `apply`.
    expect(result.current.events).toEqual([]);
  });

/**
* archive#3437: an uncaught injection. Removing
* `setHistoryStoppedTerminal(false)` from the hydration-success path was
* caught by NOTHING — the nearest assertion (above, "stops on a credential
* failure...") only ever proves the flag reaches `true`, never that a
* LATER successful hydration clears a flag that was already `true`. This
* is the live production path: a genuinely stopped history can still be
* recovered by an explicit refetch (e.g. the snapshot-frame path), and the
* flag must not keep claiming "stopped for good" once it has.
*/
  test('clears historyStoppedTerminal once a hydration that follows a credential-rejection stop actually succeeds', async () => {
    fetchSession.mockRejectedValueOnce(
      new sdk.StationHttpError(401, 'Unauthorized'),
    );
    const { result } = renderHook(() =>
      useSessionEventStream('http://station.test', 'task:1'),
    );
    await waitFor(() =>
      expect(result.current.historyStoppedTerminal).toBe(true),
    );

    fetchSession.mockResolvedValueOnce({
      session: {},
      watermark: 0,
      hasMore: false,
      events: [event('evt-recovered', '2026-07-18T00:00:01.000Z')],
    });
    act(() => {
      streamOptions.onMessage?.({
        event: 'orchestration:snapshot',
        id: '99',
        data: JSON.stringify({ sessions: [] }),
      });
    });

    await waitFor(() =>
      expect(result.current.events.map((item) => item.eventId)).toEqual([
        'evt-recovered',
      ]),
    );
    expect(result.current.historyStoppedTerminal).toBe(false);
  });

/**
* archive#3426. `AttachedSessionDetail`'s "retrying automatically" copy
* folded three mechanisms with different behaviours into one `disconnected`
* flag; this block proves the three new signals it now derives from are
* each written by exactly the code path that owns them, mirroring how
* `historyRetrying`/`historyStoppedTerminal` are proven above.
*/
  test("marks the live stream stopped for good on fetchSSE's own terminal classification, and clears it on the next open", async () => {
    const { result } = renderHook(() =>
      useSessionEventStream('http://station.test', 'task:1'),
    );
    await waitFor(() => expect(result.current.connected).toBe(true));
    expect(result.current.liveStreamStoppedTerminal).toBe(false);

// fetchSSE fires both callbacks for the same terminal failure (its own
// contract) — onTerminal is the additive signal this reads.
    act(() => {
      streamOptions.onError?.();
      streamOptions.onTerminal?.(new Error('401'));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.connected).toBe(false);
    expect(result.current.liveStreamStoppedTerminal).toBe(true);

// A later reconnect (fetchSSE's own `retry`, or a credential fix waking
// it) must not leave this reading a rejection that already cleared.
    act(() => streamOptions.onOpen?.());
    expect(result.current.liveStreamStoppedTerminal).toBe(false);
  });

/**
* archive#3437: `onOpen` was the ONLY clearing path, but
* the transport's terminal state ends at the wake (`onRetry`), not at a
* successful open. A resumed attempt that fails with a NETWORK-level
* failure (no `Response` ever arrives — a rejected `fetch`, DNS failure,
* timeout) only fires `onError` — never `onOpen` — so before this fix the
* flag stayed stuck `true` through a failure that is not a credential
* rejection, and `AttachedSessionDetail` kept rendering "Station stopped
* reconnecting — it rejected this session's credentials" while the
* transport was actively retrying and the current failure was not a
* rejection. (An HTTP-status failure such as a 500 still fires `onOpen`;
* this hook-level test drives the callback sequence directly rather than
* through the real transport — see `fetch-sse.test.ts` for the transport
* proof that a network-level failure genuinely produces this sequence.)
*/
  test("clears the live-stream-stopped flag on the transport's own retry wake, even before any open succeeds", async () => {
    const { result } = renderHook(() =>
      useSessionEventStream('http://station.test', 'task:1'),
    );
    await waitFor(() => expect(result.current.connected).toBe(true));

    act(() => {
      streamOptions.onError?.();
      streamOptions.onTerminal?.(new Error('401'));
    });
    expect(result.current.liveStreamStoppedTerminal).toBe(true);

// The transport wakes and starts retrying, but the very next attempt
// fails only TRANSIENTLY — onError fires, onOpen never does.
    act(() => {
      streamOptions.onRetry?.();
      streamOptions.onError?.();
    });

    expect(result.current.liveStreamStoppedTerminal).toBe(false);
  });

  test('marks the capability re-probe exhausted only once its automatic budget is spent on a genuinely undetermined result', async () => {
    vi.useFakeTimers();
    fetchSessionEventWindowCapability.mockResolvedValue(undefined);
    const recoveryClaims = new Map<string, number>();
    claimSessionEventWindowCapabilityRecovery.mockImplementation(
      (apiBase, threadId) => {
        const key = `${apiBase}\u0000${threadId}`;
        const attempts = recoveryClaims.get(key) ?? 0;
        if (attempts >= 3) return false;
        recoveryClaims.set(key, attempts + 1);
        return true;
      },
    );
    const { result } = renderHook(() =>
      useSessionEventStream('http://station.test', 'task:1'),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.capabilityRecoveryExhausted).toBe(false);

// The undetermined cadence (SESSION_EVENT_WINDOW_CAPABILITY_RETRY_MS,
// 30s) times three retries spends the whole budget.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(fetchSessionEventWindowCapability).toHaveBeenCalledTimes(4);
    expect(result.current.capabilityRecoveryExhausted).toBe(true);
// Not a credential rejection: an undetermined probe result never claims
// an update is needed, and exhausting its budget does not invent one.
    expect(result.current.upgradeRequired).toBe(false);
  });

  test('an exhausted capability budget for a definitively unsupported host stays the "needs an update" story, not a new one', async () => {
    vi.useFakeTimers();
    fetchSessionEventWindowCapability.mockResolvedValue(false);
    claimSessionEventWindowCapabilityRecovery.mockImplementation(() => false);
    const { result } = renderHook(() =>
      useSessionEventStream('http://station.test', 'task:1'),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.upgradeRequired).toBe(true);
// A definitive "not supported" answer is not the same fact as "three
// probes could not tell" — the recoverable flag must stay unset so
// `AttachedSessionDetail` keeps rendering the update story it already
// names correctly, not a second, contradictory one.
    expect(result.current.capabilityRecoveryExhausted).toBe(false);
  });

  test('retryCapabilityRecovery resets the budget, clears the exhausted flag, and re-probes immediately', async () => {
    vi.useFakeTimers();
    fetchSessionEventWindowCapability.mockResolvedValue(undefined);
    claimSessionEventWindowCapabilityRecovery
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    const { result } = renderHook(() =>
      useSessionEventStream('http://station.test', 'task:1'),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(result.current.capabilityRecoveryExhausted).toBe(true);
    const callsBeforeRetry =
      fetchSessionEventWindowCapability.mock.calls.length;

    act(() => result.current.retryCapabilityRecovery());

    expect(resetSessionEventWindowCapabilityRecovery).toHaveBeenCalledWith(
      'http://station.test',
      'task:1',
    );
// archive#3437: the budget reset above is not enough on
// its own — the CACHE must be invalidated too, or the immediately-prior
// (just-resolved) probe's cached settlement satisfies the "re-probe"
// below with zero real requests. This mock can't observe that on its
// own (it always increments regardless of caching); the invalidator
// call is the direct proof, and `sessionEventWindowCapability.test.ts`
// proves the cache-level behavior against the real module.
    expect(invalidateSessionEventWindowCapabilityCache).toHaveBeenCalledWith(
      'http://station.test',
    );
    expect(result.current.capabilityRecoveryExhausted).toBe(false);
    expect(fetchSessionEventWindowCapability.mock.calls.length).toBeGreaterThan(
      callsBeforeRetry,
    );
  });

/**
* archive#3437: two synchronous manual-retry calls (a
* double-click, or two racing callers) must not each start their own
* probe. Before the in-flight guard, both calls invalidated the cache and
* called `negotiateWindow` independently — two parallel chains that each
* separately consume a recovery-budget slot on resolution, exhausting the
* ladder after one round instead of three.
*/
  test('retryCapabilityRecovery called twice synchronously starts only one probe, not two parallel chains', async () => {
    vi.useFakeTimers();
    fetchSessionEventWindowCapability.mockResolvedValue(undefined);
    claimSessionEventWindowCapabilityRecovery
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    const { result } = renderHook(() =>
      useSessionEventStream('http://station.test', 'task:1'),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(result.current.capabilityRecoveryExhausted).toBe(true);
    const callsBeforeRetry =
      fetchSessionEventWindowCapability.mock.calls.length;

    act(() => {
      result.current.retryCapabilityRecovery();
      result.current.retryCapabilityRecovery();
    });

// Only ONE new probe issued for the two synchronous calls.
    expect(fetchSessionEventWindowCapability.mock.calls.length).toBe(
      callsBeforeRetry + 1,
    );
    expect(invalidateSessionEventWindowCapabilityCache).toHaveBeenCalledTimes(
      1,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
// 2 calls got the budget to "exhausted" above (the initial negotiate +
// the 30s automatic retry); the single probe from the two synchronous
// manual retries above claims exactly ONE more (3 total) — not two more
// (4), which is what two parallel chains would have consumed.
    expect(claimSessionEventWindowCapabilityRecovery).toHaveBeenCalledTimes(3);
  });

/**
* archive#3437 2. in-flight guard was
* previously consulted ONLY at the manual-retry entry point —
* `negotiateWindow` has three other entries (`onError`, the automatic
* re-probe timer, and the effect's own start) that could race each
* other unguarded. This proves the guard now covers `onError` racing the
* effect's own initial probe: a dropped SSE connection arriving while
* that first probe is still in flight (the ordinary case where a
* connection is refused faster than the probe's own 5s handshake
* timeout) must fold into the ALREADY-RUNNING probe rather than start a
* second one and claim a second automatic-recovery budget slot for what
* is, from the caller's perspective, one recovery round.
*/
  test('onError racing the still in-flight initial probe issues only one request and claims only one recovery slot', async () => {
    let resolveProbe: ((value: boolean | undefined) => void) | undefined;
    fetchSessionEventWindowCapability.mockImplementation(
      () =>
        new Promise<boolean | undefined>((resolve) => {
          resolveProbe = resolve;
        }),
    );
    const recoveryClaims = new Map<string, number>();
    claimSessionEventWindowCapabilityRecovery.mockImplementation(
      (apiBase, threadId) => {
        const key = `${apiBase}\u0000${threadId}`;
        const attempts = recoveryClaims.get(key) ?? 0;
        recoveryClaims.set(key, attempts + 1);
        return true;
      },
    );

    renderHook(() => useSessionEventStream('http://station.test', 'task:1'));

// The effect's own start already issued ONE probe; it is still
// unresolved (we control `resolveProbe` above).
    await waitFor(() =>
      expect(fetchSessionEventWindowCapability).toHaveBeenCalledTimes(1),
    );

// A dropped SSE connection while that probe is still in flight.
    act(() => {
      streamOptions.onError?.();
    });
    await act(async () => {
      await Promise.resolve();
    });
// Still ONE call: onError's negotiateWindow folded into the probe
// already running rather than starting a second one.
    expect(fetchSessionEventWindowCapability).toHaveBeenCalledTimes(1);

// Resolve the single in-flight probe as genuinely undetermined, which
// schedules an automatic recovery — assert that claimed exactly ONE
// budget slot, not two.
    await act(async () => {
      resolveProbe?.(undefined);
      await Promise.resolve();
    });
    expect(claimSessionEventWindowCapabilityRecovery).toHaveBeenCalledTimes(1);
  });

/**
* archive#3437 3. The in-flight guard's entire
* no-starvation argument (comment above `negotiateWindow`) rests on "every
* caller is asking the same host/session the same question" — which is
* only true because `capabilityProbeInFlight` is declared fresh inside
* EACH run of the effect (per thread/session), not shared module-wide.
* Nothing pinned that scoping: a `threadId` change starting its own,
* independent probe rather than folding into the previous thread's
* still-pending one is the property this test proves.
*/
  test("a threadId change starts its own probe instead of folding into the previous thread's in-flight one", async () => {
    const resolvers: Array<(value: boolean | undefined) => void> = [];
    fetchSessionEventWindowCapability.mockImplementation(
      () =>
        new Promise<boolean | undefined>((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const { rerender } = renderHook(
      ({ threadId }: { threadId: string }) =>
        useSessionEventStream('http://station.test', threadId),
      { initialProps: { threadId: 'task:1' } },
    );

// The effect's own start already issued task:1's probe; it is still
// unresolved (we control each `resolve` above).
    await waitFor(() =>
      expect(fetchSessionEventWindowCapability).toHaveBeenCalledTimes(1),
    );

// Switch to a different session WHILE task:1's probe is still pending.
    act(() => {
      rerender({ threadId: 'task:2' });
    });

// A per-effect guard issues task:2's own probe; a guard hoisted to
// module scope would see the (stale) flag still `true` from task:1 and
// fold this into it, leaving task:2 with no probe of its own.
    await waitFor(() =>
      expect(fetchSessionEventWindowCapability).toHaveBeenCalledTimes(2),
    );

// Drain both probes so nothing leaks into a later test.
    for (const resolve of resolvers.splice(0)) resolve(true);
    await act(async () => {
      await Promise.resolve();
    });
  });

/**
* archive#3386. Both readers in this hook unwrapped
* `item.event` and discarded the envelope, so the chat dock disclosed what
* a bounded read withheld while this hook's consumer rendered the identical
* amputated turn in silence — one read, two consumers, one of them lying by
* omission.
*/
  test('carries the read budget report from the hydration page', async () => {
    fetchSession.mockResolvedValueOnce({
      session: {},
      watermark: 0,
      hasMore: false,
      events: [
        {
          event: event('evt-cut', '2026-07-18T00:00:01.000Z'),
          elided: 'byte_limit',
        },
        event('evt-whole', '2026-07-18T00:00:02.000Z'),
      ],
    });
    const { result } = renderHook(() =>
      useSessionEventStream('http://station.test', 'task:1'),
    );

    await waitFor(() => expect(result.current.events).toHaveLength(2));
    expect(result.current.elidedHistory).toEqual({
      total: 1,
      byteLimit: 1,
      outputLimit: 0,
    });
  });

  test('carries the read budget report from an older page too', async () => {
    fetchSession
      .mockResolvedValueOnce({
        session: {},
        watermark: 0,
        hasMore: true,
        nextCursor: 'older',
        events: [event('evt-current', '2026-07-18T00:00:05.000Z')],
      })
      .mockResolvedValueOnce({
        session: {},
        watermark: 0,
        hasMore: false,
        events: [
          {
            event: event('evt-older-cut', '2026-07-18T00:00:01.000Z'),
            elided: 'output_limit',
          },
        ],
      });
    const { result } = renderHook(() =>
      useSessionEventStream('http://station.test', 'task:1'),
    );
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    expect(result.current.elidedHistory.total).toBe(0);

    await act(async () => {
      await result.current.loadOlder();
    });

    await waitFor(() =>
      expect(result.current.elidedHistory).toEqual({
        total: 1,
        byteLimit: 0,
        outputLimit: 1,
      }),
    );
  });

  test('carries the read budget report when a parked older page is released', async () => {
// The third recording site, and the one no fixture reached: an older page
// that arrives AHEAD of the live watermark is parked and merged later,
// from `onMessage` rather than from `loadOlder`'s own continuation.
    fetchSession
      .mockResolvedValueOnce({
        session: {},
        watermark: 5,
        hasMore: true,
        nextCursor: 'older-turns',
        events: [event('evt-current', '2026-07-18T00:00:02.000Z')],
      })
      .mockResolvedValueOnce({
        session: {},
        watermark: 8,
        hasMore: false,
        events: [
          {
            event: event('evt-older-cut', '2026-07-18T00:00:01.000Z'),
            elided: 'byte_limit',
          },
        ],
      });
    const { result } = renderHook(() =>
      useSessionEventStream('http://station.test', 'task:1'),
    );
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    await act(async () => {
      await result.current.loadOlder();
    });
// Parked, not merged: the page's watermark is ahead of what has been
// applied, so nothing about it has reached the feed yet.
    expect(result.current.elidedHistory.total).toBe(0);
    expect(result.current.events.map((item) => item.eventId)).not.toContain(
      'evt-older-cut',
    );

    act(() => {
      streamOptions.onMessage?.({
        event: 'orchestration:event',
        id: '8',
        data: JSON.stringify({
          event: event('evt-live', '2026-07-18T00:00:08.000Z'),
        }),
      });
    });

    await waitFor(() =>
      expect(result.current.events.map((item) => item.eventId)).toContain(
        'evt-older-cut',
      ),
    );
    expect(result.current.elidedHistory).toEqual({
      total: 1,
      byteLimit: 1,
      outputLimit: 0,
    });
  });

  test('stops counting an elided event once a re-hydration drops it', async () => {
// The decrement. A count that only ever climbs would keep telling the
// reader that content is missing from a feed that no longer contains the
// event it was missing from.
    fetchSession
      .mockResolvedValueOnce({
        session: {},
        watermark: 0,
        hasMore: false,
        events: [
          {
            event: event('evt-cut', '2026-07-18T00:00:01.000Z'),
            elided: 'byte_limit',
          },
        ],
      })
      .mockResolvedValueOnce({
        session: {},
        watermark: 0,
        hasMore: false,
        events: [event('evt-fresh', '2026-07-18T00:00:09.000Z')],
      });
    const { result } = renderHook(() =>
      useSessionEventStream('http://station.test', 'task:1'),
    );
    await waitFor(() => expect(result.current.elidedHistory.total).toBe(1));

// A snapshot frame is the server saying "replay did not happen", which
// re-runs the window read; the previous page's events leave the feed.
    act(() => {
      streamOptions.onMessage?.({
        event: 'orchestration:snapshot',
        id: '10',
        data: JSON.stringify({}),
      });
    });

    await waitFor(() =>
      expect(result.current.events.map((item) => item.eventId)).toEqual([
        'evt-fresh',
      ]),
    );
    expect(result.current.elidedHistory).toEqual({
      total: 0,
      byteLimit: 0,
      outputLimit: 0,
    });
  });

  test('says nothing about a window the read returned whole', async () => {
    fetchSession.mockResolvedValueOnce({
      session: {},
      watermark: 0,
      hasMore: false,
      events: [event('evt-whole', '2026-07-18T00:00:01.000Z')],
    });
    const { result } = renderHook(() =>
      useSessionEventStream('http://station.test', 'task:1'),
    );

    await waitFor(() => expect(result.current.events).toHaveLength(1));
    expect(result.current.elidedHistory).toEqual({
      total: 0,
      byteLimit: 0,
      outputLimit: 0,
    });
  });

/**
* archive#3378. The unhydrated buffer's cap was documented as
* costing nothing because `mergeSessionEvents` trims to the same bound
* anyway. It does not: that merge ALSO reaches back past its own cut to
* rescue the `turn.started` anchoring the retained window's first turn, so a
* blind splice deleted a frame the merge would have kept and the turn
* arrived with no beginning.
*/
  test('keeps the turn.started the retained window is anchored to when it trims the buffer', async () => {
    let resolveWindow: ((page: Record<string, unknown>) => void) | undefined;
    fetchSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveWindow = resolve;
        }),
    );
    const { result } = renderHook(() =>
      useSessionEventStream('http://station.test', 'task:1'),
    );
    await waitFor(() => expect(streamOptions.onMessage).toBeTruthy());

// One turn boundary, then enough frames of the SAME turn to push the
// boundary past the cap. Under a blind splice `evt-turn-start` is dropped
// here and can never be recovered; the merge's anchor lookup then finds
// nothing to prepend.
    const frames = [
      {
        eventId: 'evt-turn-start',
        provider: 'codex' as const,
        threadId: 'task:1',
        createdAt: '2026-07-18T00:00:00.000Z',
        method: 'turn.started' as const,
        turnId: 'turn-a',
      },
      ...Array.from({ length: MAX_FEED_EVENTS + 5 }, (_unused, index) => ({
        eventId: `evt-live-${index}`,
        provider: 'codex' as const,
        threadId: 'task:1',
        createdAt: `2026-07-18T00:01:${String(index % 60).padStart(2, '0')}.${String(index).padStart(3, '0')}Z`,
        method: 'session.started' as const,
        turnId: 'turn-a',
      })),
    ];
    act(() => {
      frames.forEach((frame, index) => {
        streamOptions.onMessage?.({
          event: 'orchestration:event',
          id: String(index + 1),
          data: JSON.stringify({ event: frame }),
        });
      });
    });

    resolveWindow?.({
      session: {},
      watermark: 0,
      hasMore: false,
      events: [],
    });

    await waitFor(() =>
      expect(result.current.events.length).toBeGreaterThan(0),
    );
    expect(
      result.current.events.some((item) => item.eventId === 'evt-turn-start'),
    ).toBe(true);
  });

/**
 * archive#3378 ( d). Review asked for a `setUpgradeRequired(false)`
* beside the hydration-success `setError(undefined)`; adding one and
* injecting against it came back GREEN, because the setter is unreachable —
* the only path that raises the claim also stops the capability, and every
* exit from that state restarts the effect, whose reset clears it first.
* So this pins the OUTCOME against the mechanism that really performs it
* (deleting the reset's `setUpgradeRequired(false)` reds this test), rather
* than a redundant line that would have read as the fix while never running.
*/
  test('does not leave a stale upgrade claim over a history that then loaded', async () => {
    vi.useFakeTimers();
    fetchSessionEventWindowCapability
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    fetchSession.mockResolvedValue({
      session: {},
      watermark: 0,
      hasMore: false,
      events: [event('evt-recovered', '2026-07-18T00:00:01.000Z')],
    });

    const { result } = renderHook(() =>
      useSessionEventStream('http://station.test', 'task:1'),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.upgradeRequired).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(result.current.events.map((item) => item.eventId)).toEqual([
      'evt-recovered',
    ]);
    expect(result.current.upgradeRequired).toBe(false);
    expect(result.current.error).toBeUndefined();
  });

  test('does not retry a history failure after the session unmounts', async () => {
    vi.useFakeTimers();
    fetchSession.mockRejectedValue(new Error('window unavailable'));
    const mounted = renderHook(() =>
      useSessionEventStream('http://station.test', 'task:1'),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchSession).toHaveBeenCalledTimes(1);
    mounted.unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(fetchSession).toHaveBeenCalledTimes(1);
  });
});
