import { describe, expect, test, vi } from 'vitest';
import {
  formatRelativeFuture,
  formatRelativePast,
  getHourlyBarStyle,
  getInsightsUsageView,
  summarizeFeedbackRatings,
} from '../components/monitoring/insightsDashboardUtils';

describe('insightsDashboardUtils', () => {
  test('getInsightsUsageView sorts top tools and agents while deriving max values', () => {
    expect(
      getInsightsUsageView({
        hourlyActivity: [0, 4, 2],
        toolUsage: {
          low: { calls: 1, errors: 0 },
          high: { calls: 4, errors: 1 },
        },
        agentUsage: {
          alpha: { chats: 1, tokens: 20 },
          beta: { chats: 3, tokens: 50 },
        },
      }),
    ).toEqual(
      expect.objectContaining({
        maxHourly: 4,
        maxToolCalls: 4,
        topTools: [
          ['high', { calls: 4, errors: 1 }],
          ['low', { calls: 1, errors: 0 }],
        ],
        agents: [
          ['beta', { chats: 3, tokens: 50 }],
          ['alpha', { chats: 1, tokens: 20 }],
        ],
      }),
    );
  });

  test('getHourlyBarStyle keeps empty bars visible and scales active bars', () => {
    expect(getHourlyBarStyle(0, 10)).toEqual({ height: '2%', opacity: 0.2 });
    expect(getHourlyBarStyle(5, 10)).toEqual({ height: '50%', opacity: 0.75 });
  });

  test('summarizeFeedbackRatings counts liked, disliked, pending, and no-reason ratings', () => {
    expect(
      summarizeFeedbackRatings([
        { id: '1', rating: 'thumbs_up', analyzedAt: '2026-01-01T00:00:00Z' },
        { id: '2', rating: 'thumbs_down', reason: 'bad' },
        { id: '3', rating: 'thumbs_down' },
      ]),
    ).toEqual({ liked: 1, disliked: 2, pending: 2, noReason: 2 });
  });

  test('relative formatters handle near and distant timestamps', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));

    expect(formatRelativePast('2026-01-01T11:50:00Z')).toBe('10 min ago');
    expect(formatRelativeFuture('2026-01-01T13:30:00Z')).toBe('in 2 hr');

    vi.useRealTimers();
  });
});
