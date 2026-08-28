/**
 * @vitest-environment jsdom
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TERMINAL_LINGER_MS } from '../views/home/home-lane-model';
import {
  buildHomeWorkItems,
  type HomeWorkItem,
} from '../views/home/home-view-model';
import { useHomeWorkLanes } from '../views/home/useHomeWorkLanes';

function item(over: Partial<HomeWorkItem> & { id: string }): HomeWorkItem {
  return {
    kind: 'chat',
    kindLabel: 'Direct chat',
    title: `${over.id} title`,
    projectLabel: 'p',
    agentLabel: 'a',
    modelLabel: 'm',
    updatedAt: 0,
    lifecycleLabel: 'Recent',
    ...over,
  };
}

const NOW = Date.parse('2026-07-28T15:00:00-06:00');

describe('useHomeWorkLanes', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('AC1: status churn across renders never reorders the active lane', () => {
    const a = item({ id: 'a', lifecycleLabel: 'Running', updatedAt: NOW });
    const b = item({ id: 'b', lifecycleLabel: 'Ready', updatedAt: NOW - 1 });
    const c = item({
      id: 'c',
      lifecycleLabel: 'Needs attention',
      updatedAt: NOW - 2,
    });

    const { result, rerender } = renderHook(
      ({ items }: { items: HomeWorkItem[] }) => useHomeWorkLanes(items),
      { initialProps: { items: [a, b, c] } },
    );
    expect(result.current.active.map((i) => i.id)).toEqual(['a', 'b', 'c']);

    rerender({
      items: [
        { ...b, lifecycleLabel: 'Running' },
        { ...c, lifecycleLabel: 'Ready' },
        { ...a, lifecycleLabel: 'Needs attention' },
      ],
    });
    expect(result.current.active.map((i) => i.id)).toEqual(['a', 'b', 'c']);

    rerender({
      items: [
        { ...c, lifecycleLabel: 'Running' },
        { ...a, lifecycleLabel: 'Ready' },
        { ...b, lifecycleLabel: 'Needs attention' },
      ],
    });
    expect(result.current.active.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('AC2: snooze/wake round-trip survives reload (a fresh hook instance reads the same localStorage)', () => {
    const a = item({ id: 'a', lifecycleLabel: 'Running', updatedAt: NOW });
    const first = renderHook(() => useHomeWorkLanes([a]));
    expect(first.result.current.active.map((i) => i.id)).toEqual(['a']);

    act(() => first.result.current.snooze('a', NOW + 60 * 60 * 1000));
    expect(first.result.current.snoozed.map((i) => i.id)).toEqual(['a']);
    expect(first.result.current.active).toEqual([]);

    // Simulate a reload: unmount and mount a brand new hook instance, which
    // must reconstruct state purely from localStorage.
    first.unmount();
    const reloaded = renderHook(() => useHomeWorkLanes([a]));
    expect(reloaded.result.current.snoozed.map((i) => i.id)).toEqual(['a']);
    expect(reloaded.result.current.active).toEqual([]);

    // Advance past the wake time and re-tick; the item returns to active
    // with a woke-from-snooze pill, and the wake also survives reload.
    act(() => {
      vi.advanceTimersByTime(61 * 60 * 1000);
    });
    reloaded.rerender();
    expect(reloaded.result.current.active.map((i) => i.id)).toEqual(['a']);
    expect(reloaded.result.current.isWoken('a')).toBe(true);

    reloaded.unmount();
    const afterWake = renderHook(() => useHomeWorkLanes([a]));
    expect(afterWake.result.current.snoozed).toEqual([]);
    expect(afterWake.result.current.active.map((i) => i.id)).toEqual(['a']);
  });

  it('AC2: an explicit wake() clears the snooze immediately and does not show a pill', () => {
    const a = item({ id: 'a', lifecycleLabel: 'Running', updatedAt: NOW });
    const { result } = renderHook(() => useHomeWorkLanes([a]));
    act(() => result.current.snooze('a', NOW + 60 * 60 * 1000));
    expect(result.current.snoozed.map((i) => i.id)).toEqual(['a']);

    act(() => result.current.wake('a'));
    expect(result.current.active.map((i) => i.id)).toEqual(['a']);
    expect(result.current.isWoken('a')).toBe(false);
  });

  it('AC3: a completed item appears in Recently finished for T minutes then settles', () => {
    const a = item({ id: 'a', lifecycleLabel: 'Completed', updatedAt: NOW });
    const { result, rerender } = renderHook(
      ({ items }: { items: HomeWorkItem[] }) => useHomeWorkLanes(items),
      { initialProps: { items: [a] } },
    );
    expect(result.current.active).toEqual([]);
    expect(result.current.recentlyFinished.map((i) => i.id)).toEqual(['a']);
    expect(result.current.settled).toEqual([]);

    act(() => {
      vi.advanceTimersByTime(TERMINAL_LINGER_MS - 1000);
    });
    rerender({ items: [a] });
    expect(result.current.active).toEqual([]);
    expect(result.current.recentlyFinished.map((i) => i.id)).toEqual(['a']);
    expect(result.current.settled).toEqual([]);

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    rerender({ items: [a] });
    expect(result.current.active).toEqual([]);
    expect(result.current.recentlyFinished).toEqual([]);
    expect(result.current.settled.map((i) => i.id)).toEqual(['a']);
  });

  it('AC3 (review fix): a persisted terminal-since anchor survives reload — a stale anchor lands the item directly in settled', () => {
    const a = item({ id: 'a', lifecycleLabel: 'Completed', updatedAt: NOW });
    const first = renderHook(() => useHomeWorkLanes([a]));
    expect(first.result.current.active).toEqual([]);
    expect(first.result.current.recentlyFinished.map((i) => i.id)).toEqual([
      'a',
    ]);
    expect(first.result.current.settled).toEqual([]);
    first.unmount();

    // Simulate time passing while the tab was closed/reloaded: advance past
    // the linger window, then mount a FRESH hook instance. Nothing in
    // memory carries over — only whatever terminal-since was persisted to
    // localStorage by the first instance's effect.
    act(() => {
      vi.advanceTimersByTime(TERMINAL_LINGER_MS + 60_000);
    });
    const reloaded = renderHook(() => useHomeWorkLanes([a]));
    expect(reloaded.result.current.active).toEqual([]);
    expect(reloaded.result.current.recentlyFinished).toEqual([]);
    expect(reloaded.result.current.settled.map((i) => i.id)).toEqual(['a']);
  });

  it('AC3: a historical failure with a fresh terminal store starts in Earlier', () => {
    const failed = item({
      id: 'failed',
      lifecycleLabel: 'Failed',
      updatedAt: NOW - TERMINAL_LINGER_MS - 60_000,
    });

    const { result } = renderHook(() => useHomeWorkLanes([failed]));

    expect(result.current.recentlyFinished).toEqual([]);
    expect(result.current.settled.map((entry) => entry.id)).toEqual(['failed']);
  });

  it('AC3: a pruned terminal anchor is reseeded from updatedAt, not reload time', () => {
    localStorage.setItem(
      'station.activity.terminalSince',
      JSON.stringify({ completed: NOW - TERMINAL_LINGER_MS - 6 * 60_000 }),
    );
    const completed = item({
      id: 'completed',
      lifecycleLabel: 'Completed',
      updatedAt: NOW - TERMINAL_LINGER_MS - 60_000,
    });

    const { result } = renderHook(() => useHomeWorkLanes([completed]));

    expect(result.current.recentlyFinished).toEqual([]);
    expect(result.current.settled.map((entry) => entry.id)).toEqual([
      'completed',
    ]);
  });
});

describe('AC1 regression: stable identity survives real-pipeline id promotions (review finding)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a chat promoted from a local session key to a server conversationId does not reorder the active lane', () => {
    // Both renders carry a second, unrelated session so the invariant under
    // test — the PROMOTED item's stable position — is distinguishable from
    // "only one item exists, order is trivially stable".
    const otherSession = {
      threadId: 'thread-other',
      provider: 'codex',
      status: 'ready',
      lifecycleState: 'running',
      hasActiveTurn: true,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
      isLoaded: true,
      isPersisted: true,
      answerability: { answerable: true },
      eventCount: 1,
    };

    const before = buildHomeWorkItems({
      chats: {
        'local-1': {
          title: 'Ship the release',
          agentSlug: 'agent',
          messages: [{ timestamp: NOW }],
        },
      } as any,
      sessions: [otherSession] as any,
      agents: [{ slug: 'agent', name: 'Agent' }] as any,
    });
    expect(before.map((i) => i.id)).toEqual(
      expect.arrayContaining(['local-1', 'thread-other']),
    );

    const { result, rerender } = renderHook(
      ({ items }: { items: HomeWorkItem[] }) => useHomeWorkLanes(items),
      { initialProps: { items: before } },
    );
    const stableIdsBefore = result.current.active.map((i) => i.stableId);
    expect(result.current.active.map((i) => i.id)).toEqual(
      expect.arrayContaining(['local-1', 'thread-other']),
    );

    // The server assigns a conversationId on the first message
    // (`useActiveChatSessionMessaging.ts`'s `assignConversationId`) — the
    // chat's HomeWorkItem.id flips to it.
    const after = buildHomeWorkItems({
      chats: {
        'local-1': {
          conversationId: 'conv-99',
          title: 'Ship the release',
          agentSlug: 'agent',
          messages: [{ timestamp: NOW + 1000 }],
        },
      } as any,
      sessions: [{ ...otherSession, updatedAt: '2026-01-02' }] as any,
      agents: [{ slug: 'agent', name: 'Agent' }] as any,
    });
    expect(after.map((i) => i.id)).toEqual(
      expect.arrayContaining(['conv-99', 'thread-other']),
    );
    expect(after.map((i) => i.id)).not.toContain('local-1');

    rerender({ items: after });
    // The raw id really did change...
    expect(result.current.active.map((i) => i.id)).toEqual(
      expect.arrayContaining(['conv-99', 'thread-other']),
    );
    //.but the stable id — and therefore the order — did not.
    expect(result.current.active.map((i) => i.stableId)).toEqual(
      stableIdsBefore,
    );
  });

  it('a persisted-task correlation forming does not reorder the active lane', () => {
    const otherSession = {
      threadId: 'thread-other',
      provider: 'codex',
      status: 'ready',
      lifecycleState: 'running',
      hasActiveTurn: true,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
      isLoaded: true,
      isPersisted: true,
      answerability: { answerable: true },
      eventCount: 1,
    };
    const correlatedSession = {
      threadId: 'thread-1',
      provider: 'codex',
      status: 'ready',
      lifecycleState: 'running',
      hasActiveTurn: true,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
      isLoaded: true,
      isPersisted: true,
      answerability: { answerable: true },
      eventCount: 1,
    };

    const before = buildHomeWorkItems({
      chats: {},
      sessions: [correlatedSession, otherSession] as any,
      agents: [],
    });
    expect(before.map((i) => i.id)).toEqual(
      expect.arrayContaining(['thread-1', 'thread-other']),
    );

    const { result, rerender } = renderHook(
      ({ items }: { items: HomeWorkItem[] }) => useHomeWorkLanes(items),
      { initialProps: { items: before } },
    );
    const stableIdsBefore = result.current.active.map((i) => i.stableId);

    // A durable Task is created correlated to `thread-1`
    // (`task.sessionId === session.threadId`) — mergeHomeWorkItems drops the
    // raw orchestration item and surfaces a task-keyed item instead.
    const after = buildHomeWorkItems({
      chats: {},
      sessions: [
        { ...correlatedSession, updatedAt: '2026-01-02' },
        { ...otherSession, updatedAt: '2026-01-02' },
      ] as any,
      tasks: [
        {
          id: 'task-42',
          projectId: 'p',
          title: 'Delegated review',
          status: 'in_progress',
          priority: 'normal',
          description: '',
          createdBy: 'user',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-02T00:00:00Z',
          sessionId: 'thread-1',
        },
      ] as any,
      agents: [],
    });
    expect(after.map((i) => i.id)).toEqual(
      expect.arrayContaining(['task-42', 'thread-other']),
    );
    expect(after.map((i) => i.id)).not.toContain('thread-1');

    rerender({ items: after });
    // The raw id really did change...
    expect(result.current.active.map((i) => i.id)).toEqual(
      expect.arrayContaining(['task-42', 'thread-other']),
    );
    //.but the stable id — and therefore the order — did not.
    expect(result.current.active.map((i) => i.stableId)).toEqual(
      stableIdsBefore,
    );
  });
});
