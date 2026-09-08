/**
 * @vitest-environment jsdom
 *
 * A live SSE burst used to cost one full-window `mergeSessionEvents` (dedupe,
 * sort, bounded trim) and one React state update PER FRAME. The stream now
 * buffers arriving frames and folds the batch once per animation frame.
 *
 * Two properties, because either alone would be worthless: the burst produces
 * one publication, AND the feed it publishes is byte-for-byte what applying
 * the frames one at a time would have produced. A batch that is fast and
 * wrong is a regression.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const fetchSession = vi.fn();
const close = vi.fn();
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
  mergeSessionEvents,
  useSessionEventStream,
} from '../hooks/orchestration/useSessionEventStream';

function event(index: number): OrchestrationEvent {
  return {
    eventId: `evt-${String(index).padStart(3, '0')}`,
    provider: 'codex',
    threadId: 'task:1',
    // Deliberately NOT monotonic with arrival: `mergeSessionEvents` orders by
    // `createdAt`, so a batch that merely concatenated in arrival order would
    // diverge from the sequential fold here.
    createdAt: `2026-07-18T00:00:${String((index * 7) % 60).padStart(2, '0')}.${String(
      index,
    ).padStart(3, '0')}Z`,
    method: 'session.started',
    sessionId: 'task:1',
  } as OrchestrationEvent;
}

const BURST = Array.from({ length: 50 }, (_, index) => event(index));

/** What applying the burst one frame at a time produces. */
function sequentialFold(): OrchestrationEvent[] {
  let feed: OrchestrationEvent[] = [];
  for (const next of BURST) {
    feed = mergeSessionEvents(feed, [next], new Set());
  }
  return feed;
}

describe('useSessionEventStream frame coalescing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchSession.mockReset();
    fetchSession.mockResolvedValue({ session: {}, events: [] });
  });

  test('a burst of fifty frames publishes once, with the sequential result', async () => {
    const published: OrchestrationEvent[][] = [];
    const { result } = renderHook(() => {
      const stream = useSessionEventStream('http://station.test', 'task:1');
      if (published[published.length - 1] !== stream.events) {
        published.push(stream.events);
      }
      return stream;
    });

    await waitFor(() => expect(fetchSSE).toHaveBeenCalled());
    await waitFor(() => expect(streamOptions.onMessage).toBeTruthy());
    // Let hydration settle so its own publication is not counted below.
    await act(async () => {
      await Promise.resolve();
    });
    const publishedBeforeBurst = published.length;

    // Each frame is delivered and its queue turn drained on its own, so
    // React cannot batch the burst into one render for free — that batching
    // is what would otherwise make an uncoalesced stream look coalesced. The
    // whole burst still lands well inside one animation frame.
    for (const [index, next] of BURST.entries()) {
      await act(async () => {
        streamOptions.onMessage?.({
          event: 'orchestration:event',
          id: String(index + 1),
          data: JSON.stringify({ event: next }),
        });
        await Promise.resolve();
      });
    }

    await waitFor(() =>
      expect(result.current.events).toHaveLength(BURST.length),
    );

    expect(published.length - publishedBeforeBurst).toBe(1);
    expect(result.current.events.map((item) => item.eventId)).toEqual(
      sequentialFold().map((item) => item.eventId),
    );
  });
});
