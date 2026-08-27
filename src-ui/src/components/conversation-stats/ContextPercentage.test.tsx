/** @vitest-environment jsdom */

import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  refetch: vi.fn(),
  stats: { contextWindowPercentage: 25 } as {
    contextWindowPercentage?: number;
  },
}));

vi.mock('../../contexts/StatsContext', () => ({
  useStats: () => ({ stats: harness.stats, refetch: harness.refetch }),
}));

vi.mock('../../contexts/ConversationsContext', () => ({
  useConversationStatus: () => ({ status: 'idle' }),
}));

import { ContextPercentage } from './ContextPercentage';

const props = {
  agentSlug: 'acp-engine',
  conversationId: 'thread-1',
  apiBase: 'http://localhost:3242',
};

describe('ContextPercentage live ACP usage', () => {
  beforeEach(() => {
    harness.refetch.mockReset();
    harness.stats = { contextWindowPercentage: 25 };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test('uses a valid live context observation over stale refetched stats', () => {
    render(
      <ContextPercentage
        {...props}
        liveUsage={{ contextTokens: 100_000, contextWindowTokens: 200_000 }}
      />,
    );

    expect(screen.getByText('(50.0%)')).toBeTruthy();
  });

  test('renders an exact zero-used observation as 0%', () => {
    render(
      <ContextPercentage
        {...props}
        liveUsage={{ contextTokens: 0, contextWindowTokens: 200_000 }}
      />,
    );

    expect(screen.getByText('(0.0%)')).toBeTruthy();
  });

  test('falls back to refetched stats when the live pair is invalid', () => {
    render(
      <ContextPercentage
        {...props}
        liveUsage={{ contextTokens: 100, contextWindowTokens: 0 }}
      />,
    );

    expect(screen.getByText('(25.0%)')).toBeTruthy();
  });

  test.each([undefined, Number.NaN, -1])(
    'omits unknown or malformed refetched percentage %s',
    (contextWindowPercentage) => {
      harness.stats = { contextWindowPercentage };
      const { container } = render(<ContextPercentage {...props} />);
      expect(container.innerHTML).toBe('');
    },
  );

  test('continues to refetch when the message count changes', () => {
    const view = render(<ContextPercentage {...props} messageCount={0} />);
    expect(harness.refetch).not.toHaveBeenCalled();

    view.rerender(<ContextPercentage {...props} messageCount={1} />);
    expect(harness.refetch).toHaveBeenCalledTimes(1);
  });
});
