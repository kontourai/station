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

  test('paints the meter fill and its rest tint through theme rungs, never a pigment (#2140)', () => {
    // The fill used to be a hex from `getContextWindowColor`, and the rest
    // tint an `rgba(var(--accent-primary-rgb, 0, 102, 204), …)` whose token
    // is defined in no theme -- so every render painted the blue fallback
    // beside a teal/green brand. What is pinned is that both NAME a rung;
    // `theme-rung-contrast.test.ts` measures what the rung resolves to.
    const { container } = render(
      <ContextPercentage
        {...props}
        liveUsage={{ contextTokens: 120_000, contextWindowTokens: 200_000 }}
      />,
    );
    const button = container.querySelector(
      'button.context-indicator',
    ) as HTMLElement;
    expect(button.style.background).toBe('var(--accent-subtle)');
    const fill = [...container.querySelectorAll('div')].find(
      (node) => (node as HTMLElement).style.width === '60%',
    ) as HTMLElement;
    expect(fill, 'the 60% meter fill').toBeTruthy();
    expect(fill.style.background).toBe('var(--meter-mid)');
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
