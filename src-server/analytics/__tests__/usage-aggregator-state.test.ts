import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  ACHIEVEMENTS,
  applyMessageToUsageStats,
  checkAchievement,
  computeStreakStats,
  createEmptyUsageStats,
  getAchievementProgress,
  getCostConsciousProgressPercent,
} from '../usage-aggregator-state.js';

describe('applyMessageToUsageStats', () => {
  test('updates lifetime, model, agent, and daily buckets', () => {
    const stats = createEmptyUsageStats();

    applyMessageToUsageStats(
      stats,
      {
        metadata: {
          model: 'claude-sonnet',
          timestamp: '2026-04-11T10:00:00.000Z',
          usage: { inputTokens: 10, outputTokens: 20, estimatedCost: 0.5 },
        },
      },
      'agent-a',
    );

    expect(stats).toMatchObject({
      lifetime: {
        totalMessages: 1,
        totalConversations: 0,
        totalInputTokens: 10,
        totalOutputTokens: 20,
        totalCost: 0.5,
        uniqueAgents: ['agent-a'],
        firstMessageDate: '2026-04-11',
        lastMessageDate: '2026-04-11',
      },
      byModel: {
        'claude-sonnet': {
          messages: 1,
          inputTokens: 10,
          outputTokens: 20,
          cost: 0.5,
          cacheProviderAttribution: 'indeterminate',
        },
      },
      byAgent: {
        'agent-a': {
          conversations: 0,
          messages: 1,
          cost: 0.5,
        },
      },
      byDate: {
        '2026-04-11': {
          messages: 1,
          cost: 0.5,
          inputTokens: 10,
          outputTokens: 20,
          byAgent: { 'agent-a': 1 },
        },
      },
    });
  });
});

describe('computeStreakStats', () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    vi.useRealTimers();
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  function streakFor(now: string, activeDays: readonly string[]) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(now));
    const stats = createEmptyUsageStats();
    for (const day of activeDays) {
      stats.byDate[day] = {
        messages: 1,
        cost: 0,
        inputTokens: 0,
        outputTokens: 0,
        byAgent: {},
      };
    }
    computeStreakStats(stats);
    return stats.lifetime;
  }

  test('counts every consecutive active day ending today', () => {
    const lifetime = streakFor('2026-04-11T12:00:00.000Z', [
      '2026-04-09',
      '2026-04-10',
      '2026-04-11',
    ]);
    expect(lifetime.daysActive).toBe(3);
    expect(lifetime.streak).toBe(3);
  });

  test('a gap day ends the streak', () => {
    const lifetime = streakFor('2026-04-11T12:00:00.000Z', [
      '2026-04-09',
      '2026-04-11',
    ]);
    expect(lifetime.daysActive).toBe(2);
    expect(lifetime.streak).toBe(1);
  });

  test('a streak survives a daylight-saving change in the local time zone', () => {
    // Usage days are UTC dates. Stepping back by local calendar days moved
    // the UTC instant across the date line when Chicago left DST, skipping
    // 2026-11-01.
    process.env.TZ = 'America/Chicago';
    expect(new Date('2026-11-02T00:00:00.000Z').getTimezoneOffset()).toBe(360);
    expect(new Date('2026-10-31T00:00:00.000Z').getTimezoneOffset()).toBe(300);
    const lifetime = streakFor('2026-11-02T12:00:00.000Z', [
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
    ]);
    expect(lifetime.streak).toBe(3);
  });
});

describe('achievement helpers', () => {
  test('achievements follow message and model counts', () => {
    const stats = createEmptyUsageStats();
    stats.lifetime.totalMessages = 120;
    stats.byModel.a = {
      messages: 100,
      inputTokens: 1,
      outputTokens: 1,
      cost: 0.2,
    };
    stats.byModel.b = {
      messages: 20,
      inputTokens: 1,
      outputTokens: 1,
      cost: 0.2,
    };
    stats.byModel.c = {
      messages: 1,
      inputTokens: 1,
      outputTokens: 1,
      cost: 0.2,
    };
    stats.byModel.d = {
      messages: 1,
      inputTokens: 1,
      outputTokens: 1,
      cost: 0.2,
    };
    stats.byModel.e = {
      messages: 1,
      inputTokens: 1,
      outputTokens: 1,
      cost: 0.2,
    };
    stats.lifetime.totalCost = 0.5;

    expect(checkAchievement(ACHIEVEMENTS[1], stats)).toBe(true);
    expect(checkAchievement(ACHIEVEMENTS[3], stats)).toBe(true);
    expect(getAchievementProgress(ACHIEVEMENTS[1], stats)).toBe(100);
  });

  test('fills Cost Conscious progress only when its message and cost requirements are met', () => {
    const stats = createEmptyUsageStats();
    stats.lifetime.totalMessages = 25;
    stats.lifetime.totalCost = 0.125;
    expect(getCostConsciousProgressPercent(stats)).toBe(50);

    stats.lifetime.totalMessages = 50;
    stats.lifetime.totalCost = 0.25;
    expect(getCostConsciousProgressPercent(stats)).toBe(100);

    stats.lifetime.totalCost = 1;
    expect(getCostConsciousProgressPercent(stats)).toBe(50);
  });
});
