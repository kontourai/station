// @vitest-environment jsdom

/**
 * The stats panel had two refresh mechanisms over one endpoint: an effect that
 * refetched when the transcript's message count moved, and a two-second
 * `setInterval` that called `refetch()` beside it.
 *
 * Both triggers are still wanted — the server writes conversation stats from a
 * turn-end hook several awaits after the transcript row the client counts, so
 * the message-count refresh can land before the write and leave the previous
 * turn's tokens on screen — but the poll belongs to the query, where it is
 * inert while the panel is closed and paused while the tab is hidden.
 *
 * The real `useStats` runs here (the mock is one layer lower, at the SDK
 * query) so the assertion covers what the component passes AND what the
 * context forwards, rather than a stand-in for both.
 */

import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ConversationStats } from './ConversationStats';

const refetch = vi.fn();
const statsQueryConfig = vi.hoisted(() => [] as unknown[]);

vi.mock('@kontourai/station-sdk', () => ({
  useStatsQuery: (
    _agentSlug: string | undefined,
    _conversationId: string | undefined,
    config?: unknown,
  ) => {
    statsQueryConfig.push(config);
    return { data: undefined, error: null, refetch, isLoading: false };
  },
}));

vi.mock('./ConversationStatsModal', () => ({
  ConversationStatsModal: () => null,
}));

function statsPanel(messageCount: number, isVisible = true) {
  return (
    <ConversationStats
      agentSlug="codex"
      conversationId="conversation-1"
      apiBase="http://station.test"
      isVisible={isVisible}
      onToggle={() => {}}
      messageCount={messageCount}
    />
  );
}

describe('ConversationStats refresh triggers', () => {
  beforeEach(() => {
    refetch.mockClear();
    statsQueryConfig.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('polls through the query, and registers no timer of its own', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    render(statsPanel(3));

    expect(statsQueryConfig.length).toBeGreaterThan(0);
    expect(statsQueryConfig[0]).toMatchObject({
      enabled: true,
      refetchInterval: 2000,
    });
    // The cadence is the query's, not a second scheduler beside it.
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  test('leaves the read disabled while the panel is closed', () => {
    render(statsPanel(3, false));

    expect(statsQueryConfig[0]).toMatchObject({
      enabled: false,
      refetchInterval: 2000,
    });
  });

  test('still refreshes when the transcript gains a message', () => {
    const view = render(statsPanel(3));
    expect(refetch).toHaveBeenCalledTimes(1);

    view.rerender(statsPanel(4));

    expect(refetch).toHaveBeenCalledTimes(2);
  });
});
