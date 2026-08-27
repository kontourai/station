// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { AchievementsBadge } from './AchievementsBadge';

const { useAnalytics } = vi.hoisted(() => ({
  useAnalytics: vi.fn(),
}));

vi.mock('../../contexts/AnalyticsContext', () => ({ useAnalytics }));

describe('AchievementsBadge', () => {
  beforeEach(() => {
    useAnalytics.mockReset();
  });

  test('stays absent while achievements have not resolved', () => {
    useAnalytics.mockReturnValue({ achievements: undefined, loading: false });

    const { container } = render(<AchievementsBadge />);

    expect(container.childElementCount).toBe(0);
  });

  test('renders Cost Conscious as a lower-is-better goal with its message precondition', () => {
    useAnalytics.mockReturnValue({
      loading: false,
      achievements: [
        {
          id: 'cost-conscious',
          name: 'Cost Conscious',
          description: 'Keep average cost under $0.01/message',
          unlocked: false,
          progress: 0.008,
          threshold: 0.01,
          progressPercent: 50,
          lowerIsBetter: true,
          precondition: {
            label: 'Messages analyzed',
            current: 25,
            threshold: 50,
          },
        },
      ],
    });

    render(<AchievementsBadge />);

    expect(screen.getByText('Under budget: $0.0080 / $0.0100')).toBeTruthy();
    expect(screen.getByText('Messages analyzed')).toBeTruthy();
    expect(screen.getByText('25 / 50')).toBeTruthy();
    expect(
      (document.querySelector('.achievement-progress-fill') as HTMLElement)
        .style.width,
    ).toBe('50%');
  });
});
