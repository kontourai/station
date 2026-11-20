// @vitest-environment jsdom

/**
 * Inbox rows warm the reopen transcript cache after a short dwell. Entered
 * through the real `InboxRow`, the caller whose pointer and focus events
 * start the read, with only the window fetch stubbed at the SDK boundary.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const fetchConversationWindow = vi.fn();

vi.mock(
  '@kontourai/station-sdk',
  async (importOriginal: () => Promise<Record<string, unknown>>) => ({
    ...(await importOriginal()),
    fetchOrchestrationConversationEventWindow: (...args: unknown[]) =>
      fetchConversationWindow(...args),
    fetchSessionEventWindowCapability: async () => true,
    useOrchestrationSessionsQuery: vi.fn(() => ({ data: [] })),
  }),
);

import { InboxRow } from '../components/chat-dock/ChatDockInboxRows';
import {
  clearTranscriptWindowCache,
  readTranscriptWindow,
  transcriptWindowCacheKey,
} from '../hooks/orchestration/transcriptWindowCache';
import {
  TRANSCRIPT_PREFETCH_DWELL_MS,
  TranscriptPrefetchTargetProvider,
} from '../hooks/orchestration/useTranscriptWindowPrefetch';
import type { HomeWorkItem } from '../views/home/home-view-model';

const NAMESPACE = 'v1|env=a|principal=human:a|grant=operator';
const API_BASE = 'http://station.test';
const NOW = Date.parse('2026-11-01T12:00:00Z');

function item(conversationId: string): HomeWorkItem {
  return {
    id: conversationId,
    conversationId,
    kind: 'orchestration',
    kindLabel: 'Session',
    title: `Row ${conversationId}`,
    projectLabel: 'No project',
    agentLabel: 'Codex',
    modelLabel: 'Model',
    updatedAt: NOW - 60_000,
    lifecycleLabel: 'Idle',
    orchestrationThreadId: conversationId,
  } as unknown as HomeWorkItem;
}

function renderRows(ids: string[]) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <TranscriptPrefetchTargetProvider
        value={{ apiBase: API_BASE, namespace: NAMESPACE }}
      >
        {ids.map((id) => (
          <InboxRow
            key={id}
            item={item(id)}
            isCurrent={false}
            isSnoozed={false}
            isOpenChat={false}
            now={NOW}
            onActivate={vi.fn()}
            hoverCard={false}
          />
        ))}
      </TranscriptPrefetchTargetProvider>
    </QueryClientProvider>,
  );
}

const rows = () => screen.getAllByTestId('inbox-row');
const cacheKey = (conversationId: string) =>
  transcriptWindowCacheKey({
    namespace: NAMESPACE,
    apiBase: API_BASE,
    conversationId,
  });

function windowPage(conversationId: string) {
  return {
    protocolVersion: 1,
    watermark: 1,
    hasMore: false,
    events: [
      {
        sequence: 1,
        event: {
          eventId: `${conversationId}-start`,
          method: 'turn.started',
          provider: 'codex',
          threadId: conversationId,
          turnId: 'turn-1',
          prompt: 'prefetched question',
          createdAt: '2026-11-01T11:00:00.000Z',
        },
      },
    ],
  };
}

describe('inbox row transcript prefetch', () => {
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; signal: AbortSignal }
  >();
  beforeEach(() => {
    vi.useFakeTimers();
    pending.clear();
    fetchConversationWindow.mockReset();
    fetchConversationWindow.mockImplementation(
      (id: string, _apiBase: string, _input: unknown, options) =>
        new Promise((resolve, reject) => {
          const signal = (options as { signal: AbortSignal }).signal;
          pending.set(id, { resolve, signal });
          signal.addEventListener('abort', () => reject(signal.reason));
        }),
    );
  });
  afterEach(async () => {
    // Settle whatever is still in flight so the next test starts clear.
    for (const [id, request] of pending) request.resolve(windowPage(id));
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    vi.useRealTimers();
    clearTranscriptWindowCache();
  });

  test('a dwell reads the window once into the cache; a short pass reads nothing', async () => {
    renderRows(['conv-a']);
    const [row] = rows();
    fireEvent.pointerEnter(row!, { pointerType: 'mouse' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TRANSCRIPT_PREFETCH_DWELL_MS - 1);
    });
    fireEvent.pointerLeave(row!);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TRANSCRIPT_PREFETCH_DWELL_MS);
    });
    expect(fetchConversationWindow).not.toHaveBeenCalled();

    fireEvent.pointerEnter(row!, { pointerType: 'mouse' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TRANSCRIPT_PREFETCH_DWELL_MS);
    });
    // Hovering again while the read is in flight does not start another.
    fireEvent.pointerLeave(row!);
    fireEvent.focusIn(row!);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TRANSCRIPT_PREFETCH_DWELL_MS);
    });
    expect(fetchConversationWindow).toHaveBeenCalledOnce();
    expect(fetchConversationWindow.mock.calls[0]?.[0]).toBe('conv-a');

    await act(async () => pending.get('conv-a')!.resolve(windowPage('conv-a')));
    expect(readTranscriptWindow(cacheKey('conv-a'))?.events).toHaveLength(1);
    // Fresh in the cache: a later dwell does not read it again.
    fireEvent.pointerEnter(row!, { pointerType: 'mouse' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TRANSCRIPT_PREFETCH_DWELL_MS);
    });
    expect(fetchConversationWindow).toHaveBeenCalledOnce();
  });

  test('a newer row supersedes and cancels the read in flight', async () => {
    renderRows(['conv-a', 'conv-b']);
    const [rowA, rowB] = rows();
    fireEvent.pointerEnter(rowA!, { pointerType: 'mouse' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TRANSCRIPT_PREFETCH_DWELL_MS);
    });
    fireEvent.pointerLeave(rowA!);
    fireEvent.pointerEnter(rowB!, { pointerType: 'mouse' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TRANSCRIPT_PREFETCH_DWELL_MS);
    });
    expect(fetchConversationWindow.mock.calls.map((call) => call[0])).toEqual([
      'conv-a',
      'conv-b',
    ]);
    expect(pending.get('conv-a')!.signal.aborted).toBe(true);
    expect(pending.get('conv-b')!.signal.aborted).toBe(false);
    await act(async () => pending.get('conv-b')!.resolve(windowPage('conv-b')));
    expect(readTranscriptWindow(cacheKey('conv-a'))).toBeUndefined();
    expect(readTranscriptWindow(cacheKey('conv-b'))).toBeDefined();
  });

  test('a browser asked to save data never prefetches', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      connection: { saveData: true },
    });
    try {
      renderRows(['conv-a']);
      fireEvent.pointerEnter(rows()[0]!, { pointerType: 'mouse' });
      fireEvent.focusIn(rows()[0]!);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TRANSCRIPT_PREFETCH_DWELL_MS * 2);
      });
      expect(fetchConversationWindow).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('a touch pointer never prefetches', async () => {
    renderRows(['conv-a']);
    fireEvent.pointerEnter(rows()[0]!, { pointerType: 'touch' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TRANSCRIPT_PREFETCH_DWELL_MS * 2);
    });
    expect(fetchConversationWindow).not.toHaveBeenCalled();
  });
});
