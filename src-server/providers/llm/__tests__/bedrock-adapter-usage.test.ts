import { describe, expect, test, vi } from 'vitest';
import { BedrockAdapter } from '../../adapters/bedrock-adapter.js';

vi.mock('../bedrock.js', () => ({
  checkBedrockCredentials: vi.fn(),
}));

/**
 * station#4197: Bedrock engine sessions used to silently discard reported
 * usage — `AiSdkLLMProvider.createStream` never populated
 * `LLMStreamChunk.usage`, and this adapter never published
 * `token-usage.updated`, so the UI claimed "engine did not report" for an
 * engine that did. These tests drive the REAL `sendTurn` path with a
 * stubbed provider stream (the same seam every other bedrock-adapter test
 * injects) and assert on the published canonical events.
 */

async function runTurn(finishChunk: Record<string, unknown>): Promise<{
  events: Array<Record<string, unknown>>;
  turnId: string;
}> {
  const createStream = vi.fn(async function* () {
    yield { type: 'text-delta' as const, content: 'answer' };
    yield { type: 'finish' as const, ...finishChunk };
  });
  const adapter = new BedrockAdapter(
    {},
    {
      modelCatalog: { resolveModelId: async (modelId: string) => modelId },
      llm: { createStream } as any,
    },
  );
  const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
  await adapter.startSession({
    provider: 'bedrock',
    threadId: 'usage-thread',
    modelId: 'anthropic.claude',
  });
  const turn = await adapter.sendTurn({
    threadId: 'usage-thread',
    input: 'measure me',
  });

  const events: Array<Record<string, unknown>> = [];
  // The full happy-path event count is bounded; drain with a quiet-window
  // race so a REGRESSION that appends an extra event is still observed.
  for (let index = 0; index < 12; index += 1) {
    const next = await Promise.race([
      iterator.next().then((r) => ({ done: false as const, value: r.value })),
      new Promise<{ done: true }>((resolve) =>
        setTimeout(() => resolve({ done: true }), 150),
      ),
    ]);
    if (next.done) break;
    events.push(next.value as Record<string, unknown>);
  }
  return { events, turnId: turn.turnId };
}

describe('BedrockAdapter token-usage.updated emission (station#4197)', () => {
  test('a finish chunk with reported usage publishes the wire figures verbatim, tagged to the turn', async () => {
    const { events, turnId } = await runTurn({
      finishReason: 'stop',
      usage: {
        // ai-sdk normalized figures — cache-INCLUSIVE input by SDK
        // construction; the event must carry the WIRE figures instead.
        inputTokens: 9130,
        outputTokens: 250,
        totalTokens: 9380,
        cacheReadTokens: 9000,
        cacheWriteTokens: 100,
        // NOTE: the STREAMING metadata usage schema in the installed
        // @ai-sdk/amazon-bedrock carries NO totalTokens (only the
        // non-streaming response schema does) — fixtures model the live
        // streamed shape.
        raw: {
          inputTokens: 30,
          outputTokens: 250,
          cacheReadInputTokens: 9000,
          cacheWriteInputTokens: 100,
        },
      },
    });
    const usageEvents = events.filter(
      (event) => event.method === 'token-usage.updated',
    );
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({
      provider: 'bedrock',
      threadId: 'usage-thread',
      turnId,
      // The engine's own cache-EXCLUSIVE prompt figure (wire `inputTokens`),
      // backing the `'disjoint'` declaration in
      // `PROVIDER_PROMPT_CACHE_INCLUSIVITY` — NOT the SDK's inclusive 9130.
      promptTokens: 30,
      completionTokens: 250,
      cacheReadTokens: 9000,
      cacheWriteTokens: 100,
    });
    // No totalTokens claim: the wire total's cache inclusivity is not
    // stated by the installed SDK, and `'disjoint'` requires any published
    // total to exclude cache — the fold derives prompt + completion itself.
    expect('totalTokens' in usageEvents[0]).toBe(false);
    // Ordering: the usage event precedes the turn's completion event.
    const usageIndex = events.findIndex(
      (event) => event.method === 'token-usage.updated',
    );
    const completedIndex = events.findIndex(
      (event) => event.method === 'turn.completed',
    );
    expect(usageIndex).toBeGreaterThanOrEqual(0);
    expect(completedIndex).toBeGreaterThan(usageIndex);
  });

  test('SDK-coerced cache zeros with no wire field publish NO cache claim; a wire-reported 0 IS published', async () => {
    // Wire object with no cache fields at all (a model without prompt
    // caching): the SDK normalizes cacheRead/cacheWrite to 0 — an invented
    // measurement the event must not carry.
    const noCache = await runTurn({
      finishReason: 'stop',
      usage: {
        inputTokens: 30,
        outputTokens: 250,
        totalTokens: 280,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        raw: { inputTokens: 30, outputTokens: 250 },
      },
    });
    const noCacheEvent = noCache.events.find(
      (event) => event.method === 'token-usage.updated',
    ) as Record<string, unknown>;
    expect(noCacheEvent).toMatchObject({
      promptTokens: 30,
      completionTokens: 250,
    });
    expect('cacheReadTokens' in noCacheEvent).toBe(false);
    expect('cacheWriteTokens' in noCacheEvent).toBe(false);

    // Cold cache with caching ACTIVE: the wire genuinely reports
    // `cacheReadInputTokens: 0` — a reported zero, kept as one.
    const coldCache = await runTurn({
      finishReason: 'stop',
      usage: {
        inputTokens: 9030,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 9000,
        raw: {
          inputTokens: 30,
          outputTokens: 100,
          totalTokens: 130,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 9000,
        },
      },
    });
    const coldCacheEvent = coldCache.events.find(
      (event) => event.method === 'token-usage.updated',
    ) as Record<string, unknown>;
    expect(coldCacheEvent).toMatchObject({
      promptTokens: 30,
      completionTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 9000,
    });
  });

  test('a finish chunk with NO usage publishes NO token-usage.updated — absence is not an event of zeros', async () => {
    const { events } = await runTurn({ finishReason: 'stop' });
    expect(
      events.filter((event) => event.method === 'token-usage.updated'),
    ).toHaveLength(0);
    // The turn itself still completed normally.
    expect(
      events.filter((event) => event.method === 'turn.completed'),
    ).toHaveLength(1);
  });

  test('a broken wire prompt figure ships the degraded prompt ALONE — cache fields never ride beside a cache-inclusive fallback', async () => {
    // Wire inputTokens broken (-3) while cache fields stay usable: the
    // fallback prompt figure is the SDK's cache-INCLUSIVE total, so cache
    // fields on the same event would be counted twice by every 'disjoint'
    // consumer (cacheInclusivePromptTokens). The event must carry the
    // degraded figure with NO cache claim (review MEDIUM, station#4197).
    const { events } = await runTurn({
      finishReason: 'stop',
      usage: {
        inputTokens: 9097,
        outputTokens: 250,
        cacheReadTokens: 9000,
        cacheWriteTokens: 100,
        raw: {
          inputTokens: -3,
          outputTokens: 250,
          cacheReadInputTokens: 9000,
          cacheWriteInputTokens: 100,
        },
      },
    });
    const usageEvents = events.filter(
      (event) => event.method === 'token-usage.updated',
    );
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({
      promptTokens: 9097,
      completionTokens: 250,
    });
    expect('cacheReadTokens' in usageEvents[0]).toBe(false);
    expect('cacheWriteTokens' in usageEvents[0]).toBe(false);
  });

  test('broken wire figures are dropped per-field, never coerced', async () => {
    const { events } = await runTurn({
      finishReason: 'stop',
      usage: {
        outputTokens: 40,
        raw: {
          inputTokens: -3,
          outputTokens: 40,
          cacheReadInputTokens: Number.NaN,
        },
      },
    });
    const usageEvent = events.find(
      (event) => event.method === 'token-usage.updated',
    ) as Record<string, unknown>;
    expect(usageEvent).toMatchObject({ completionTokens: 40 });
    expect('promptTokens' in usageEvent).toBe(false);
    expect('cacheReadTokens' in usageEvent).toBe(false);
  });
});
