import { cacheInclusivePromptTokens } from '@kontourai/station-shared/usage-fold';
import { describe, expect, test } from 'vitest';
import {
  ACHIEVEMENTS,
  applyEnrichmentUsageToUsageStats,
  applyMessageToUsageStats,
  applyOrchestrationUsageToUsageStats,
  checkAchievement,
  computeStreakStats,
  createEmptyUsageStats,
  getAchievementProgress,
  getCostConsciousProgressPercent,
  mergeRescannedUsageStats,
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

    expect(stats).toEqual({
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

describe('applyEnrichmentUsageToUsageStats', () => {
  test('conserves one persisted message while applying its enriched usage', () => {
    const timestamp = '2026-04-11T10:00:00.000Z';
    const firstWrite = { metadata: { timestamp } };
    const enriched = {
      metadata: {
        timestamp,
        model: 'claude-sonnet',
        usage: { inputTokens: 10, outputTokens: 20, estimatedCost: 0.5 },
      },
    };
    const incrementalThenEnriched = createEmptyUsageStats();
    const singleEnrichedWrite = createEmptyUsageStats();

    applyMessageToUsageStats(incrementalThenEnriched, firstWrite, 'agent-a');
    applyEnrichmentUsageToUsageStats(
      incrementalThenEnriched,
      enriched,
      'agent-a',
    );
    applyMessageToUsageStats(singleEnrichedWrite, enriched, 'agent-a');

    expect(incrementalThenEnriched).toEqual(singleEnrichedWrite);
    expect(incrementalThenEnriched).toMatchObject({
      lifetime: {
        totalMessages: 1,
        totalInputTokens: 10,
        totalOutputTokens: 20,
        totalCost: 0.5,
      },
      byDate: {
        '2026-04-11': {
          messages: 1,
          inputTokens: 10,
          outputTokens: 20,
          cost: 0.5,
          byAgent: { 'agent-a': 1 },
        },
      },
      byModel: {
        'claude-sonnet': {
          messages: 1,
          inputTokens: 10,
          outputTokens: 20,
          cost: 0.5,
        },
      },
      byAgent: { 'agent-a': { messages: 1, cost: 0.5 } },
    });
  });

  test('leaves a first write without enrichment counted with zero usage', () => {
    const stats = createEmptyUsageStats();
    applyMessageToUsageStats(
      stats,
      { metadata: { timestamp: '2026-04-11T10:00:00.000Z' } },
      'agent-a',
    );

    expect(stats).toMatchObject({
      lifetime: {
        totalMessages: 1,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCost: 0,
      },
      byDate: {
        '2026-04-11': {
          messages: 1,
          inputTokens: 0,
          outputTokens: 0,
          cost: 0,
        },
      },
    });
  });

  test('does not add a second model message when the first write had its model', () => {
    const stats = createEmptyUsageStats();
    const timestamp = '2026-04-11T10:00:00.000Z';
    applyMessageToUsageStats(
      stats,
      { metadata: { timestamp, model: 'claude-sonnet' } },
      'agent-a',
    );
    applyEnrichmentUsageToUsageStats(
      stats,
      {
        metadata: {
          timestamp,
          model: 'claude-sonnet',
          usage: { inputTokens: 10, outputTokens: 20, estimatedCost: 0.5 },
        },
      },
      'agent-a',
      '',
      'claude-sonnet',
    );

    expect(stats.byModel['claude-sonnet']).toEqual({
      messages: 1,
      inputTokens: 10,
      outputTokens: 20,
      cost: 0.5,
      cacheProviderAttribution: 'indeterminate',
    });
  });
});

describe('mergeRescannedUsageStats', () => {
  test('cache counters merge by max when both exist, survive when one does, and stay absent when neither does (station#4196)', () => {
    const withCache = (read?: number, write?: number) => {
      const stats = createEmptyUsageStats();
      if (read !== undefined) stats.lifetime.totalCacheReadTokens = read;
      if (write !== undefined) stats.lifetime.totalCacheWriteTokens = write;
      return stats;
    };

    const both = mergeRescannedUsageStats(withCache(100, 5), withCache(80, 9));
    expect(both.lifetime.totalCacheReadTokens).toBe(100);
    expect(both.lifetime.totalCacheWriteTokens).toBe(9);

    const oneSided = mergeRescannedUsageStats(withCache(), withCache(42));
    expect(oneSided.lifetime.totalCacheReadTokens).toBe(42);

    const neither = mergeRescannedUsageStats(withCache(), withCache());
    expect(neither.lifetime.totalCacheReadTokens).toBeUndefined();
    expect(neither.lifetime.totalCacheWriteTokens).toBeUndefined();
  });

  test('does not adopt a single-provider declaration over a legacy model input bucket', () => {
    const existing = createEmptyUsageStats();
    existing.byModel['shared-model'] = {
      messages: 1,
      inputTokens: 10,
      outputTokens: 2,
      cost: 0,
    };
    const rescanned = createEmptyUsageStats();
    rescanned.byModel['shared-model'] = {
      messages: 1,
      inputTokens: 135,
      outputTokens: 600,
      cost: 0,
      cacheReadTokens: 18_400,
      cacheWriteTokens: 10_100,
      cacheProvider: 'claude',
      cacheInclusivity: 'disjoint',
      cacheProviderAttribution: 'single',
    };

    const merged = mergeRescannedUsageStats(existing, rescanned);
    const model = merged.byModel['shared-model'];
    expect(model).toMatchObject({
      inputTokens: 135,
      cacheReadTokens: 18_400,
      cacheWriteTokens: 10_100,
      cacheProviderAttribution: 'indeterminate',
    });
    expect(model.cacheProvider).toBeUndefined();
    expect(model.cacheInclusivity).toBeUndefined();
  });

  test('keeps max lifetime totals and preserves incremental-only byDate data', () => {
    const existing = createEmptyUsageStats();
    existing.lifetime.totalMessages = 5;
    existing.lifetime.uniqueAgents = ['agent-a'];
    existing.byDate = {
      '2026-04-10': {
        messages: 5,
        cost: 1,
        inputTokens: 1,
        outputTokens: 1,
        byAgent: { 'agent-a': 5 },
      },
    };

    const rescanned = createEmptyUsageStats();
    rescanned.lifetime.totalMessages = 3;
    rescanned.lifetime.totalConversations = 2;
    rescanned.lifetime.uniqueAgents = ['agent-b'];
    rescanned.byAgent['agent-b'] = { conversations: 2, messages: 3, cost: 0.2 };
    rescanned.byDate = {
      '2026-04-11': {
        messages: 3,
        cost: 0.2,
        inputTokens: 2,
        outputTokens: 3,
        byAgent: { 'agent-b': 3 },
      },
    };

    const merged = mergeRescannedUsageStats(existing, rescanned);

    expect(merged.lifetime.totalMessages).toBe(5);
    expect(merged.lifetime.totalConversations).toBe(2);
    expect(merged.lifetime.uniqueAgents.sort()).toEqual(['agent-a', 'agent-b']);
    expect(merged.byDate).toEqual({
      ...existing.byDate,
      ...rescanned.byDate,
    });
  });
});

describe('achievement helpers', () => {
  test('compute streak stats and achievement progress', () => {
    const stats = createEmptyUsageStats();
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0];
    stats.byDate[today] = {
      messages: 1,
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
      byAgent: {},
    };
    stats.byDate[yesterday] = {
      messages: 1,
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
      byAgent: {},
    };
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

    computeStreakStats(stats);

    expect(stats.lifetime.daysActive).toBe(2);
    expect(stats.lifetime.streak).toBeGreaterThanOrEqual(1);
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

describe('applyOrchestrationUsageToUsageStats (station#3245)', () => {
  const fold = (over: Record<string, unknown> = {}) => ({
    threadId: 'thread-1',
    conversationId: 'conv-1',
    agentSlug: 'claude',
    usage: { turns: 2, toolCalls: 3, inputTokens: 10, ...over },
  });

  test('writes no date buckets, because a session fold has no per-day resolution', () => {
    // Charging a multi-day session's whole usage to one calendar day would
    // invent a distribution nothing measured, so `byDate`, `firstMessageDate`
    // and `lastMessageDate` are deliberately left to the memory substrate
    // until archive#3093 builds a date-capable one.
    const stats = createEmptyUsageStats();
    applyOrchestrationUsageToUsageStats(stats, [fold()], new Set());
    expect(stats.byDate).toEqual({});
    expect(stats.lifetime.firstMessageDate).toBeUndefined();
    expect(stats.lifetime.lastMessageDate).toBeUndefined();
    // ...while the totals it CAN answer are written.
    expect(stats.lifetime.totalMessages).toBe(2);
    expect(stats.lifetime.totalInputTokens).toBe(10);
  });

  test('an unattributed session rolls up rather than inventing an agent name', () => {
    const stats = createEmptyUsageStats();
    const { agentSlug: _drop, ...unattributed } = fold();
    applyOrchestrationUsageToUsageStats(
      stats,
      [unattributed as ReturnType<typeof fold>],
      new Set(),
    );
    expect(stats.lifetime.uniqueAgents).toEqual(['(unnamed)']);
    expect(stats.byAgent['(unnamed)']).toMatchObject({
      conversations: 1,
      messages: 2,
    });
  });

  test('cache tokens accumulate as SEPARATE counters and never move totalInputTokens (station#4196)', () => {
    const stats = createEmptyUsageStats();
    applyOrchestrationUsageToUsageStats(
      stats,
      [
        {
          ...fold({ cacheReadTokens: 18_400, cacheWriteTokens: 10_100 }),
          conversationId: 'conv-cache-1',
          threadId: 't-cache-1',
        },
        {
          ...fold({ inputTokens: 25, cacheReadTokens: 600 }),
          conversationId: 'conv-cache-2',
          threadId: 't-cache-2',
        },
      ],
      new Set(),
    );

    // Input stays exactly the sum of reported input figures — whether a
    // provider's input already contains its cache figures is a per-provider
    // declaration that is unresolved for some, so blending cache into this
    // counter could double-count invisibly.
    expect(stats.lifetime.totalInputTokens).toBe(35);
    expect(stats.lifetime.totalCacheReadTokens).toBe(19_000);
    expect(stats.lifetime.totalCacheWriteTokens).toBe(10_100);
  });

  test('carries the 212x cache facts and declared provider semantics into each model bucket', () => {
    const stats = createEmptyUsageStats();
    applyOrchestrationUsageToUsageStats(
      stats,
      [
        {
          ...fold({
            turns: 3,
            inputTokens: 135,
            outputTokens: 600,
            cacheReadTokens: 18_400,
            cacheWriteTokens: 10_100,
            lastModelId: 'claude-opus',
            provider: 'claude',
          }),
          conversationId: 'conv-212x',
          threadId: 't-212x',
        },
        {
          ...fold({
            inputTokens: 3_000,
            cacheReadTokens: 900,
            lastModelId: 'codex',
            provider: 'codex',
          }),
          conversationId: 'conv-unverified',
          threadId: 't-unverified',
        },
      ],
      new Set(),
    );

    const claude = stats.byModel['claude-opus'];
    expect(claude).toMatchObject({
      messages: 3,
      inputTokens: 135,
      outputTokens: 600,
      cacheReadTokens: 18_400,
      cacheWriteTokens: 10_100,
      cacheProvider: 'claude',
      cacheInclusivity: 'disjoint',
      cacheProviderAttribution: 'single',
    });
    // This is the audit's known answer, now through the analytics model
    // fold: do not leave a presenter only the cache-exclusive 135.
    expect(cacheInclusivePromptTokens(claude.cacheProvider, claude)).toBe(
      28_635,
    );

    const codex = stats.byModel.codex;
    expect(codex).toMatchObject({
      inputTokens: 3_000,
      cacheReadTokens: 900,
      cacheProvider: 'codex',
      cacheInclusivity: 'unverified',
    });
    expect(
      cacheInclusivePromptTokens(codex.cacheProvider, codex),
    ).toBeUndefined();
  });

  test('keeps a model cache field absent distinct from a provider-reported zero', () => {
    const stats = createEmptyUsageStats();
    applyOrchestrationUsageToUsageStats(
      stats,
      [
        {
          ...fold({
            lastModelId: 'claude-zero',
            provider: 'claude',
            cacheReadTokens: 0,
          }),
          conversationId: 'conv-zero',
          threadId: 't-zero',
        },
        {
          ...fold({ lastModelId: 'claude-absent', provider: 'claude' }),
          conversationId: 'conv-absent',
          threadId: 't-absent',
        },
      ],
      new Set(),
    );

    expect(stats.byModel['claude-zero'].cacheReadTokens).toBe(0);
    expect(stats.byModel['claude-zero'].cacheWriteTokens).toBeUndefined();
    expect(stats.byModel['claude-absent'].cacheReadTokens).toBeUndefined();
    expect(stats.byModel['claude-absent'].cacheWriteTokens).toBeUndefined();
  });

  test('keeps an unattributed message and enrichment bucket indeterminate when Claude later reports cache', () => {
    const stats = createEmptyUsageStats();
    const timestamp = '2026-08-25T00:00:00.000Z';
    applyMessageToUsageStats(
      stats,
      {
        metadata: {
          model: 'shared-model',
          timestamp,
          usage: { inputTokens: 10, outputTokens: 2 },
        },
      },
      'agent-a',
    );
    applyEnrichmentUsageToUsageStats(
      stats,
      {
        metadata: {
          model: 'shared-model',
          timestamp,
          usage: { inputTokens: 5, outputTokens: 1 },
        },
      },
      'agent-a',
      '',
      'shared-model',
    );
    applyOrchestrationUsageToUsageStats(
      stats,
      [
        {
          ...fold({
            inputTokens: 135,
            cacheReadTokens: 18_400,
            cacheWriteTokens: 10_100,
            lastModelId: 'shared-model',
            provider: 'claude',
          }),
          conversationId: 'conv-late-claude',
          threadId: 't-late-claude',
        },
      ],
      new Set(),
    );

    const model = stats.byModel['shared-model'];
    expect(model).toMatchObject({
      inputTokens: 150,
      cacheReadTokens: 18_400,
      cacheWriteTokens: 10_100,
      cacheProviderAttribution: 'indeterminate',
    });
    expect(model.cacheProvider).toBeUndefined();
    expect(model.cacheInclusivity).toBeUndefined();
    expect(
      cacheInclusivePromptTokens(model.cacheProvider, model),
    ).toBeUndefined();
  });

  test('keeps one model indeterminate when Claude and Codex report its prompt/cache figures', () => {
    const stats = createEmptyUsageStats();
    applyOrchestrationUsageToUsageStats(
      stats,
      [
        {
          ...fold({
            inputTokens: 135,
            cacheReadTokens: 18_400,
            lastModelId: 'shared-model',
            provider: 'claude',
          }),
          conversationId: 'conv-claude',
          threadId: 't-claude',
        },
        {
          ...fold({
            inputTokens: 3_000,
            cacheReadTokens: 900,
            lastModelId: 'shared-model',
            provider: 'codex',
          }),
          conversationId: 'conv-codex',
          threadId: 't-codex',
        },
      ],
      new Set(),
    );

    const model = stats.byModel['shared-model'];
    expect(model.cacheReadTokens).toBe(19_300);
    expect(model.cacheProviderAttribution).toBe('indeterminate');
    expect(model.cacheProvider).toBeUndefined();
    expect(
      cacheInclusivePromptTokens(model.cacheProvider, model),
    ).toBeUndefined();
  });

  test('cache counters stay ABSENT when no session ever reported a cache figure', () => {
    const stats = createEmptyUsageStats();
    applyOrchestrationUsageToUsageStats(stats, [fold()], new Set());
    // Absent is not zero (archive#3201): a counter nothing reported must
    // not exist, or a panel would render "0 cache tokens" as a measurement.
    expect(stats.lifetime.totalCacheReadTokens).toBeUndefined();
    expect(stats.lifetime.totalCacheWriteTokens).toBeUndefined();
    expect(
      'totalCacheReadTokens' in JSON.parse(JSON.stringify(stats.lifetime)),
    ).toBe(false);
  });

  test('the exclusion set is consulted per session, not once for the batch', () => {
    // A weaker guard ("skip the whole pass if any id overlaps", or a check
    // that runs before the loop) would either drop real sessions or let a
    // duplicate through. Both cases must hold in ONE call.
    const stats = createEmptyUsageStats();
    const coverage = applyOrchestrationUsageToUsageStats(
      stats,
      [
        { ...fold(), conversationId: 'seen', threadId: 't-seen' },
        { ...fold(), conversationId: 'new', threadId: 't-new' },
      ],
      new Set(['seen']),
    );
    expect(coverage.sessions).toBe(1);
    expect(stats.lifetime.totalConversations).toBe(1);
    expect(stats.lifetime.totalMessages).toBe(2);
  });
});
