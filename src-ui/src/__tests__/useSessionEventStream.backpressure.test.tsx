/**
 * @vitest-environment jsdom
 *
 * The lifetime of the coalescing buffer: what bounds it, when it drains, and
 * what happens to it when the feed it belongs to goes away.
 *
 * The coalescing buffer defers a publish, and a deferred publish can be
 * deferred for a long time: a browser suspends animation frames for a hidden
 * document, so a live turn arriving into a background tab would hold every
 * frame it received, with full payloads, until someone looked at the tab. The
 * pre-hydration buffer in the same file has always trimmed at
 * `MAX_FEED_EVENTS` for exactly this reason; this one now does too, and a
 * hidden document publishes on a timer rather than on a frame that will not
 * come.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const fetchSession = vi.fn();
const close = vi.fn();
let streamOptions: {
  onOpen?: () => void;
  onError?: (error?: unknown) => void;
  onTerminal?: (error: unknown) => void;
  onRetry?: () => void;
  onMessage?: (event: unknown) => void;
};
const fetchSSE = vi.fn((_url: string, options: typeof streamOptions) => {
  streamOptions = options;
  void Promise.resolve().then(() => options.onOpen?.());
  return { close };
});

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
        events: detail.events.map((item: unknown, index: number) => ({
          sequence: index + 1,
          event: item,
        })),
      }),
    ),
  fetchEventStreamResumeCapability: () => Promise.resolve(false),
  fetchSessionEventWindowCapability: () => Promise.resolve(true),
  claimSessionEventWindowCapabilityRecovery: () => true,
  resetSessionEventWindowCapabilityCache: () => {},
  resetSessionEventWindowCapabilityRecovery: () => {},
  invalidateSessionEventWindowCapabilityCache: () => {},
  SESSION_EVENT_WINDOW_CAPABILITY_RETRY_MS: 30_000,
  SESSION_EVENT_WINDOW_UNSUPPORTED_RETRY_MS: 60_000,
  fetchSSE: (...args: [string, typeof streamOptions]) => fetchSSE(...args),
}));

import type { OrchestrationEvent } from '../hooks/orchestration/types';
import {
  MAX_FEED_EVENTS,
  mergeSessionEvents,
  useSessionEventStream,
} from '../hooks/orchestration/useSessionEventStream';

function event(index: number): OrchestrationEvent {
  return {
    eventId: `evt-${String(index).padStart(4, '0')}`,
    provider: 'codex',
    threadId: 'task:1',
    createdAt: `2026-07-18T00:00:${String((index * 7) % 60).padStart(2, '0')}.${String(
      index % 1000,
    ).padStart(3, '0')}Z`,
    method: 'session.started',
    sessionId: 'task:1',
  } as OrchestrationEvent;
}

function sequentialFold(events: OrchestrationEvent[]): OrchestrationEvent[] {
  let feed: OrchestrationEvent[] = [];
  for (const next of events) {
    feed = mergeSessionEvents(feed, [next], new Set());
  }
  return feed;
}

/** A frame scheduler that records instead of running. */
function manualFrames() {
  const scheduled = new Map<number, FrameRequestCallback>();
  const cancelled: number[] = [];
  let nextHandle = 1;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const handle = nextHandle++;
    scheduled.set(handle, callback);
    return handle;
  });
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
    cancelled.push(handle);
    scheduled.delete(handle);
  });
  return {
    scheduled,
    cancelled,
    requested: () => nextHandle - 1,
    async runAll() {
      const pending = [...scheduled.values()];
      scheduled.clear();
      await act(async () => {
        for (const callback of pending) callback(0);
        await Promise.resolve();
      });
    },
  };
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
}

async function deliver(events: OrchestrationEvent[]) {
  for (const [index, next] of events.entries()) {
    await act(async () => {
      (streamOptions.onMessage as ((frame: unknown) => void) | undefined)?.({
        event: 'orchestration:event',
        id: String(index + 1),
        data: JSON.stringify({ event: next }),
      });
      await Promise.resolve();
    });
  }
}

async function mountStream(threadId = 'task:1') {
  const view = renderHook(
    ({ id }: { id: string }) =>
      useSessionEventStream('http://station.test', id),
    { initialProps: { id: threadId } },
  );
  await waitFor(() => expect(fetchSSE).toHaveBeenCalled());
  await waitFor(() => expect(streamOptions.onMessage).toBeTruthy());
  await act(async () => {
    await Promise.resolve();
  });
  return view;
}

async function switchThread(
  view: { rerender: (props: { id: string }) => void },
  id: string,
) {
  const streamsBefore = fetchSSE.mock.calls.length;
  await act(async () => {
    view.rerender({ id });
    await Promise.resolve();
  });
  await waitFor(() =>
    expect(fetchSSE.mock.calls.length).toBeGreaterThan(streamsBefore),
  );
  await waitFor(() => expect(streamOptions.onMessage).toBeTruthy());
  await act(async () => {
    await Promise.resolve();
  });
}

describe('useSessionEventStream buffer backpressure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchSession.mockReset();
    fetchSession.mockResolvedValue({ session: {}, events: [] });
    setVisibility('visible');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    setVisibility('visible');
  });

  test('a publish that never runs cannot let the buffer grow past the feed cap', async () => {
    const frames = manualFrames();
    const view = await mountStream();

    const burst = Array.from({ length: 500 }, (_, index) => event(index));
    await deliver(burst);

    // Nothing has published: the only scheduled frame callbacks are the ones
    // this harness is holding.
    expect(view.result.current.events).toHaveLength(0);
    // Each fold at the cap cancels the pending frame and the next queued event
    // schedules a fresh one, so the schedule/cancel counts ARE the fold count.
    // 500 frames crosses a 200-event cap twice.
    expect(frames.cancelled).toHaveLength(2);
    expect(frames.requested()).toBe(3);

    await frames.runAll();

    await waitFor(() =>
      expect(view.result.current.events).toHaveLength(MAX_FEED_EVENTS),
    );
    expect(view.result.current.events.map((item) => item.eventId)).toEqual(
      sequentialFold(burst).map((item) => item.eventId),
    );

    view.unmount();
  });

  test('a pending frame is cancelled on unmount and never publishes', async () => {
    const frames = manualFrames();
    const view = await mountStream();

    await deliver([event(1)]);
    expect(frames.requested()).toBe(1);
    expect(frames.scheduled.size).toBe(1);

    view.unmount();

    // The scheduled callback is gone, not merely orphaned: nothing can call
    // `setEvents` on a hook that no longer exists.
    expect(frames.cancelled).toEqual([1]);
    expect(frames.scheduled.size).toBe(0);
  });

  /**
   * Two distinct leaks, two tests: the buffer is cleared at effect start, and
   * so is the window every merge builds on. Clearing only the React state left
   * the ref carrying the previous thread's events into the next merge.
   */
  test('frames already folded into the window do not reach the next thread', async () => {
    const frames = manualFrames();
    const view = await mountStream('task:1');

    await deliver([event(11), event(12)]);
    await frames.runAll();
    await waitFor(() => expect(view.result.current.events).toHaveLength(2));

    await switchThread(view, 'task:2');
    await deliver([event(21)]);
    await frames.runAll();

    await waitFor(() => expect(view.result.current.events).toHaveLength(1));
    expect(view.result.current.events.map((item) => item.eventId)).toEqual([
      'evt-0021',
    ]);

    view.unmount();
  });

  test('frames still buffered when the thread changes do not reach it either', async () => {
    const frames = manualFrames();
    const view = await mountStream('task:1');

    await deliver([event(11), event(12)]);
    // Held, unpublished, by this harness.
    expect(view.result.current.events).toHaveLength(0);
    expect(frames.scheduled.size).toBe(1);

    await switchThread(view, 'task:2');
    await deliver([event(21)]);
    await frames.runAll();

    await waitFor(() => expect(view.result.current.events).toHaveLength(1));
    expect(view.result.current.events.map((item) => item.eventId)).toEqual([
      'evt-0021',
    ]);

    view.unmount();
  });

  test('a hidden document publishes on a timer rather than a frame that will not come', async () => {
    setVisibility('hidden');
    // Fake timers first: vitest fakes `requestAnimationFrame` too, so a stub
    // installed before them would be replaced and the assertion below would
    // read zero whether or not the hidden path was taken.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const frames = manualFrames();

    const view = await mountStream();
    await deliver([event(1), event(2)]);

    // The scheduler never asked for a frame: a hidden document would not have
    // been given one.
    expect(frames.requested()).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(view.result.current.events.map((item) => item.eventId)).toEqual([
      'evt-0001',
      'evt-0002',
    ]);

    view.unmount();
  });
});
