// @vitest-environment jsdom

/**
 * The stats panel had two refresh triggers over one endpoint: an effect that
 * refetched when the transcript's message count moved, and a two-second
 * interval that refetched regardless. The message count is what actually
 * moves these numbers, so it is the trigger that survived.
 */

import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ConversationStats } from './ConversationStats';

const refetch = vi.fn();

vi.mock('../../contexts/StatsContext', () => ({
  useStats: () => ({ stats: null, error: null, refetch, loading: false }),
}));

vi.mock('./ConversationStatsModal', () => ({
  ConversationStatsModal: () => null,
}));

function renderStats(messageCount: number) {
  return render(
    <ConversationStats
      agentSlug="codex"
      conversationId="conversation-1"
      apiBase="http://station.test"
      isVisible
      onToggle={() => {}}
      messageCount={messageCount}
    />,
  );
}

describe('ConversationStats refresh triggers', () => {
  beforeEach(() => {
    refetch.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('registers no polling timer while the panel is open', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    renderStats(3);
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  test('still refreshes when the transcript gains a message', () => {
    const view = renderStats(3);
    expect(refetch).toHaveBeenCalledTimes(1);

    view.rerender(
      <ConversationStats
        agentSlug="codex"
        conversationId="conversation-1"
        apiBase="http://station.test"
        isVisible
        onToggle={() => {}}
        messageCount={4}
      />,
    );

    expect(refetch).toHaveBeenCalledTimes(2);
  });
});
