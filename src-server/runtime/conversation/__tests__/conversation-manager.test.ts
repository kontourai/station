import { parseConversationStatsResponse } from '@kontourai/station-contracts/runtime';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { foldUsageEvents } from '@kontourai/station-shared/usage-fold';
import { describe, expect, test, vi } from 'vitest';
import { getConversationStats } from '../conversation-manager.js';

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function createConfigLoader(model?: string) {
  return {
    loadAgent: vi.fn().mockResolvedValue({ prompt: '', model }),
  } as any;
}

const appConfig = { defaultModel: 'anthropic.claude-3-haiku' } as any;

describe('getConversationStats — orchestration fallback (station#1299 slice 1)', () => {
  test('an orchestration-backed conversation with no memory-store adapter falls back to folded usage events', async () => {
    const readSessionUsage = vi.fn().mockReturnValue({
      inputTokens: 500,
      outputTokens: 200,
      totalTokens: 700,
      turns: 2,
      toolCalls: 3,
      lastModelId: 'claude-sonnet-4-5',
    });

    const data = await getConversationStats(
      'claude',
      'thread-1',
      new Map(),
      new Map(),
      new Map(),
      createConfigLoader(),
      appConfig,
      undefined,
      mockLogger,
      readSessionUsage,
    );

    expect(readSessionUsage).toHaveBeenCalledWith('thread-1');
    expect(data).toMatchObject({
      inputTokens: 500,
      outputTokens: 200,
      totalTokens: 700,
      turns: 2,
      toolCalls: 3,
      modelId: 'claude-sonnet-4-5',
    });
    // The aggregate reported no cost, so the view reports no cost. This
    // assertion used to read `estimatedCost: 0`, which is what reached the
    // modal as `$0.0000` (archive#3201).
    expect(data.estimatedCost).toBeUndefined();
    expect((data as any).measurement).toEqual({ source: 'engine-events' });
    expect((data as any).notFound).toBeUndefined();
  });

  test('an orchestration-backed conversation not found in the memory store falls back to folded usage events', async () => {
    const adapter = {
      getConversation: vi.fn().mockResolvedValue(null),
    };
    const readSessionUsage = vi.fn().mockReturnValue({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      turns: 1,
      toolCalls: 0,
    });

    const data = await getConversationStats(
      'default',
      'thread-2',
      new Map([['default', adapter as any]]),
      new Map(),
      new Map(),
      createConfigLoader('bedrock-model'),
      appConfig,
      undefined,
      mockLogger,
      readSessionUsage,
    );

    expect(data).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      turns: 1,
      toolCalls: 0,
      // No lastModelId on the aggregate — falls back to the agent's own model.
      modelId: 'bedrock-model',
    });
    expect((data as any).notFound).toBeUndefined();
  });

  test('falls back to the empty/notFound view when the fold has no usage signal', async () => {
    const adapter = {
      getConversation: vi.fn().mockResolvedValue(null),
    };
    const readSessionUsage = vi.fn().mockReturnValue({
      turns: 0,
      toolCalls: 0,
    });

    const data = await getConversationStats(
      'default',
      'thread-empty',
      new Map([['default', adapter as any]]),
      new Map(),
      new Map(),
      createConfigLoader('bedrock-model'),
      appConfig,
      undefined,
      mockLogger,
      readSessionUsage,
    );

    expect((data as any).notFound).toBe(true);
    expect(data.totalTokens).toBe(0);
  });

  test.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects malformed folded total %s instead of reporting a false zero',
    async (totalTokens) => {
      await expect(
        getConversationStats(
          'default',
          'thread-malformed',
          new Map(),
          new Map(),
          new Map(),
          createConfigLoader('bedrock-model'),
          appConfig,
          undefined,
          mockLogger,
          () => ({
            inputTokens: 1,
            outputTokens: 1,
            totalTokens,
            turns: 1,
            toolCalls: 0,
          }),
        ),
      ).rejects.toThrow('Conversation usage aggregate was invalid');
    },
  );

  test('a partially-reporting session keeps tokens and leaves cost unreported', async () => {
    const data = await getConversationStats(
      'claude',
      'thread-partial',
      new Map(),
      new Map(),
      new Map(),
      createConfigLoader(),
      appConfig,
      undefined,
      mockLogger,
      () => ({
        inputTokens: 900,
        outputTokens: 120,
        totalTokens: 1_020,
        turns: 2,
        toolCalls: 1,
        provider: 'codex',
      }),
    );

    expect(data.totalTokens).toBe(1_020);
    expect(data.estimatedCost).toBeUndefined();
    expect((data as any).measurement).toEqual({
      source: 'engine-events',
      provider: 'codex',
    });
  });

  test('a provider-reported cost is carried verbatim, not recomputed', async () => {
    const data = await getConversationStats(
      'claude',
      'thread-cost',
      new Map(),
      new Map(),
      new Map(),
      createConfigLoader(),
      appConfig,
      undefined,
      mockLogger,
      () => ({
        inputTokens: 900,
        outputTokens: 120,
        totalTokens: 1_020,
        turns: 2,
        toolCalls: 1,
        reportedCostUsd: 0.043_21,
        provider: 'claude',
      }),
    );

    expect(data.estimatedCost).toBe(0.043_21);
  });

  test('an engine that reports usage through its own channel yields activity with every measurement absent', async () => {
    // The ACP/OpenCode shape from archive#3201's screenshot: context
    // occupancy and nothing else. Every other figure must stay absent
    // rather than render as a measured zero.
    const data = await getConversationStats(
      'kiro',
      'thread-acp',
      new Map(),
      new Map(),
      new Map(),
      createConfigLoader('opencode-model'),
      appConfig,
      undefined,
      mockLogger,
      () => ({
        turns: 1,
        toolCalls: 0,
        contextTokens: 27_554,
        contextWindowTokens: 200_000,
        provider: 'acp',
      }),
    );

    expect(data.turns).toBe(1);
    expect((data as any).contextTokens).toBe(27_554);
    expect((data as any).contextWindowPercentage).toBeCloseTo(13.78, 2);
    expect(data.inputTokens).toBeUndefined();
    expect(data.outputTokens).toBeUndefined();
    expect(data.totalTokens).toBeUndefined();
    expect(data.estimatedCost).toBeUndefined();
    // Station's own prompt/tool estimates describe a prompt this engine
    // never sent — `MCP Tools: 1` was `Math.ceil(len('[]') / 4)`.
    expect((data as any).systemPromptTokens).toBeUndefined();
    expect((data as any).mcpServerTokens).toBeUndefined();
    expect((data as any).userMessageTokens).toBeUndefined();
    expect((data as any).assistantMessageTokens).toBeUndefined();
    expect((data as any).contextFilesTokens).toBeUndefined();
    expect((data as any).measurement).toEqual({
      source: 'engine-events',
      provider: 'acp',
    });
  });

  test('with no readSessionUsage reader at all, behaves exactly as before (empty/notFound)', async () => {
    const data = await getConversationStats(
      'default',
      'thread-3',
      new Map(),
      new Map(),
      new Map(),
      createConfigLoader('bedrock-model'),
      appConfig,
      undefined,
      mockLogger,
    );

    expect(data.totalTokens).toBe(0);
    expect(data.turns).toBe(0);
  });

  test('a legacy memory-store conversation with real stats is unaffected by the fallback', async () => {
    const adapter = {
      getConversation: vi.fn().mockResolvedValue({
        userId: 'agent:default',
        metadata: {
          stats: {
            inputTokens: 40,
            outputTokens: 20,
            totalTokens: 60,
            turns: 1,
            toolCalls: 0,
            estimatedCost: 0.01,
            tokenBreakdown: {
              userMessageTokens: 5,
              assistantMessageTokens: 20,
            },
          },
        },
      }),
      getMessages: vi.fn().mockResolvedValue([]),
    };
    const readSessionUsage = vi.fn();

    const data = await getConversationStats(
      'default',
      'c1',
      new Map([['default', adapter as any]]),
      new Map(),
      new Map(),
      createConfigLoader('bedrock-model'),
      appConfig,
      undefined,
      mockLogger,
      readSessionUsage,
    );

    expect(readSessionUsage).not.toHaveBeenCalled();
    expect(data).toMatchObject({
      inputTokens: 40,
      outputTokens: 20,
      totalTokens: 60,
      modelId: 'bedrock-model',
    });
  });

  test('resolveContextWindowTokens supplies the window for an engine-reported occupancy', async () => {
    const readSessionUsage = vi.fn().mockReturnValue({
      inputTokens: 100_000,
      outputTokens: 0,
      totalTokens: 100_000,
      // The engine reported how much of the window it filled but not how
      // large the window is; the inventory resolves that. Before this
      // change the percentage was computed from `totalTokens` — a sum
      // across turns of everything sent AND received, which is not context
      // occupancy at all (archive#1299's double-count).
      contextTokens: 100_000,
      turns: 1,
      toolCalls: 0,
      lastModelId: 'claude-opus-4-1',
    });
    const resolveContextWindowTokens = vi
      .fn()
      .mockImplementation(async (modelId: string) =>
        modelId === 'claude-opus-4-1' ? 1_000_000 : undefined,
      );

    const data = await getConversationStats(
      'claude',
      'thread-4',
      new Map(),
      new Map(),
      new Map(),
      createConfigLoader(),
      appConfig,
      undefined,
      mockLogger,
      readSessionUsage,
      resolveContextWindowTokens,
    );

    expect(resolveContextWindowTokens).toHaveBeenCalledWith('claude-opus-4-1');
    expect((data as any).contextWindowPercentage).toBe(10);
  });

  test('an engine that reported no context occupancy gets no percentage, not one built from token totals', async () => {
    const readSessionUsage = vi.fn().mockReturnValue({
      inputTokens: 100_000,
      outputTokens: 40_000,
      totalTokens: 140_000,
      turns: 4,
      toolCalls: 0,
      lastModelId: 'claude-opus-4-1',
    });

    const data = await getConversationStats(
      'claude',
      'thread-no-context',
      new Map(),
      new Map(),
      new Map(),
      createConfigLoader(),
      appConfig,
      undefined,
      mockLogger,
      readSessionUsage,
      async () => 1_000_000,
    );

    expect((data as any).contextTokens).toBeUndefined();
    expect((data as any).contextWindowPercentage).toBeUndefined();
  });

  test('uses a folded ACP context observation exactly for the stats percentage', async () => {
    const readSessionUsage = vi.fn().mockReturnValue({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextTokens: 0,
      contextWindowTokens: 200_000,
      turns: 0,
      toolCalls: 0,
    });

    const data = await getConversationStats(
      'acp-engine',
      'thread-acp',
      new Map(),
      new Map(),
      new Map(),
      createConfigLoader(),
      appConfig,
      undefined,
      mockLogger,
      readSessionUsage,
    );

    expect(data).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextTokens: 0,
      contextWindowPercentage: 0,
    });
  });
});

describe('getConversationStats — cache-honest stats wire (station#4196)', () => {
  let n = 0;
  const ev = (over: Record<string, unknown>): CanonicalRuntimeEvent =>
    ({
      eventId: `e${n++}`,
      threadId: 'thread-cache',
      createdAt: '2026-08-25T00:00:00.000Z',
      ...over,
    }) as unknown as CanonicalRuntimeEvent;

  /**
   * The archive#4048 audit's 212x known-answer fixture, folded by the REAL
   * `foldUsageEvents`: cold-cache 3-turn Claude session, input 30/45/60,
   * cache_creation 9000/400/700, cache_read 0/9000/9400. Honest prompt-side
   * tokens are 135 + 10,100 + 18,400 = 28,635; the pre-fix wire carried 135
   * and no cache fields at all.
   */
  const coldCacheClaudeEvents = () => [
    ev({
      method: 'token-usage.updated',
      provider: 'claude',
      promptTokens: 30,
      completionTokens: 100,
      totalTokens: 130,
      cacheWriteTokens: 9000,
      cacheReadTokens: 0,
    }),
    ev({ method: 'turn.completed', provider: 'claude', turnId: 'turn-1' }),
    ev({
      method: 'token-usage.updated',
      provider: 'claude',
      promptTokens: 45,
      completionTokens: 200,
      totalTokens: 245,
      cacheWriteTokens: 400,
      cacheReadTokens: 9000,
    }),
    ev({ method: 'turn.completed', provider: 'claude', turnId: 'turn-2' }),
    ev({
      method: 'token-usage.updated',
      provider: 'claude',
      promptTokens: 60,
      completionTokens: 300,
      totalTokens: 360,
      cacheWriteTokens: 700,
      cacheReadTokens: 9400,
    }),
    ev({ method: 'turn.completed', provider: 'claude', turnId: 'turn-3' }),
  ];

  test('the wire carries the folded cache fields beside the uncached input (212x fixture)', async () => {
    const readSessionUsage = vi
      .fn()
      .mockImplementation(() => foldUsageEvents(coldCacheClaudeEvents()));

    const data = await getConversationStats(
      'claude',
      'thread-cache',
      new Map(),
      new Map(),
      new Map(),
      createConfigLoader(),
      appConfig,
      undefined,
      mockLogger,
      readSessionUsage,
    );

    expect(data).toMatchObject({
      inputTokens: 135,
      outputTokens: 600,
      totalTokens: 735,
      cacheReadTokens: 18_400,
      cacheWriteTokens: 10_100,
      turns: 3,
    });
    // The shared wire validator must accept the new fields, and must keep
    // carrying them: a response that parses but drops cache would silently
    // re-open the 212x hole one layer down.
    const parsed = parseConversationStatsResponse(
      JSON.parse(JSON.stringify(data)),
    );
    expect(parsed).toBeDefined();
    expect(parsed).toMatchObject({
      inputTokens: 135,
      cacheReadTokens: 18_400,
      cacheWriteTokens: 10_100,
    });
  });

  test('an absent-cache session keeps the wire fields absent — never invented zeros', async () => {
    const readSessionUsage = vi.fn().mockImplementation(() =>
      foldUsageEvents([
        ev({
          method: 'token-usage.updated',
          provider: 'codex',
          promptTokens: 500,
          completionTokens: 200,
          totalTokens: 700,
        }),
        ev({ method: 'turn.completed', provider: 'codex', turnId: 'turn-1' }),
      ]),
    );

    const data = await getConversationStats(
      'codex',
      'thread-nocache',
      new Map(),
      new Map(),
      new Map(),
      createConfigLoader(),
      appConfig,
      undefined,
      mockLogger,
      readSessionUsage,
    );

    // The same escape hatch the existing tests use for `measurement`: the
    // inferred return union includes the empty view, which has no cache
    // fields at the type level.
    expect((data as any).cacheReadTokens).toBeUndefined();
    expect((data as any).cacheWriteTokens).toBeUndefined();
    // Over the actual JSON wire the keys vanish entirely — absent, not 0.
    const overWire = JSON.parse(JSON.stringify(data));
    expect('cacheReadTokens' in overWire).toBe(false);
    expect('cacheWriteTokens' in overWire).toBe(false);
    expect(parseConversationStatsResponse(overWire)).toBeDefined();
  });

  test('a broken (negative) cache figure is rejected like any other broken token figure', async () => {
    const readSessionUsage = vi.fn().mockReturnValue({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      cacheReadTokens: -3,
      turns: 1,
      toolCalls: 0,
    });

    await expect(
      getConversationStats(
        'claude',
        'thread-broken',
        new Map(),
        new Map(),
        new Map(),
        createConfigLoader(),
        appConfig,
        undefined,
        mockLogger,
        readSessionUsage,
      ),
    ).rejects.toThrow('Conversation usage aggregate was invalid');
  });
});

describe('getConversationStats — bedrock reported usage renders as reported (station#4197)', () => {
  let n4197 = 0;
  const ev4197 = (over: Record<string, unknown>): CanonicalRuntimeEvent =>
    ({
      eventId: `b${n4197++}`,
      threadId: 'thread-bedrock',
      createdAt: '2026-08-25T00:00:00.000Z',
      ...over,
    }) as unknown as CanonicalRuntimeEvent;

  /**
   * The event shapes the Bedrock adapter now actually publishes
   * (archive#4197's `bedrockReportedUsage`): per-turn wire figures, cache
   * fields only when the Converse wire carried them, no totalTokens.
   * Before this fix the adapter published NOTHING here, the fold had no
   * usage signal, and the modal told the user the engine "did not report
   * token counts" — for an engine that reported them on every turn.
   */
  const bedrockSessionEvents = () => [
    ev4197({
      method: 'token-usage.updated',
      provider: 'bedrock',
      turnId: 'turn-1',
      promptTokens: 30,
      completionTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 9000,
    }),
    ev4197({ method: 'turn.completed', provider: 'bedrock', turnId: 'turn-1' }),
    ev4197({
      method: 'token-usage.updated',
      provider: 'bedrock',
      turnId: 'turn-2',
      promptTokens: 45,
      completionTokens: 200,
      cacheReadTokens: 9000,
      cacheWriteTokens: 400,
    }),
    ev4197({ method: 'turn.completed', provider: 'bedrock', turnId: 'turn-2' }),
  ];

  test('a bedrock session with reported usage is no longer described as unreported', async () => {
    const { conversationStatsMeasurementView, unreportedMeasurementClasses } =
      await import('@kontourai/station-shared/usage-measurement');
    const readSessionUsage = vi
      .fn()
      .mockImplementation(() => foldUsageEvents(bedrockSessionEvents()));

    const data = await getConversationStats(
      'bedrock-agent',
      'thread-bedrock',
      new Map(),
      new Map(),
      new Map(),
      createConfigLoader(),
      appConfig,
      undefined,
      mockLogger,
      readSessionUsage,
    );

    // The real stats path carries the folded figures and names the engine.
    expect(data).toMatchObject({
      inputTokens: 75,
      outputTokens: 300,
      totalTokens: 375,
      cacheReadTokens: 9000,
      cacheWriteTokens: 9400,
      turns: 2,
    });
    expect((data as any).measurement).toEqual({
      source: 'engine-events',
      provider: 'bedrock',
    });

    // The wire validator keeps the fields, and the SAME derivation the UI
    // uses (`unreportedMeasurementClasses` behind
    // `describeUnreportedMeasurements`) no longer lists token counts as
    // unreported — the absence-direction lie this issue closes. Cost and
    // context remain honestly unreported: Bedrock's stream reports neither.
    const parsed = parseConversationStatsResponse(
      JSON.parse(JSON.stringify(data)),
    );
    expect(parsed).toBeDefined();
    const view = conversationStatsMeasurementView(parsed as any);
    const classes = unreportedMeasurementClasses(view);
    expect(classes).not.toContain('token counts');
    expect(classes).toEqual(['cost', 'context usage']);
  });
});
