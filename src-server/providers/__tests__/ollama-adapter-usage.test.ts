import { describe, expect, test, vi } from 'vitest';
import { OllamaAdapter } from '../adapters/ollama-adapter.js';

/**
 * station#4197: Ollama engine sessions used to silently discard reported
 * usage — the shared producer never populated `LLMStreamChunk.usage` and
 * this adapter never published `token-usage.updated`. These tests drive the
 * REAL `sendTurn` path with a stubbed provider (the same `llm` seam every
 * other ollama-adapter test injects) and assert on the published canonical
 * events.
 */

async function runTurn(finishChunk: Record<string, unknown>): Promise<{
  events: Array<Record<string, unknown>>;
  turnId: string;
}> {
  const llm = {
    listModelCatalog: vi.fn(async () => ({
      source: 'live',
      models: [{ id: 'model-a', name: 'Model A' }],
    })),
    createStream: vi.fn(async function* () {
      yield { type: 'text-delta' as const, content: 'answer' };
      yield { type: 'finish' as const, ...finishChunk };
    }),
  };
  const adapter = new OllamaAdapter('http://ollama.test', { llm: llm as any });
  const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
  await adapter.startSession({
    provider: 'ollama',
    threadId: 'usage-thread',
    modelId: 'model-a',
  });
  const turn = await adapter.sendTurn({
    threadId: 'usage-thread',
    input: 'measure me',
  });

  const events: Array<Record<string, unknown>> = [];
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

describe('OllamaAdapter token-usage.updated emission (station#4197)', () => {
  test('a finish chunk with reported usage publishes the exact figures, tagged to the turn', async () => {
    const { events, turnId } = await runTurn({
      finishReason: 'stop',
      usage: {
        // For the OpenAI-compatible wire the normalized figures ARE the
        // wire `prompt_tokens`/`completion_tokens` verbatim.
        inputTokens: 512,
        outputTokens: 128,
        totalTokens: 640,
        // The SDK coerces an unreported `cached_tokens` to 0 — the wire
        // object below carries no `prompt_tokens_details`, so no cache
        // claim may be published.
        cacheReadTokens: 0,
        raw: { prompt_tokens: 512, completion_tokens: 128, total_tokens: 640 },
      },
    });
    const usageEvents = events.filter(
      (event) => event.method === 'token-usage.updated',
    );
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({
      provider: 'ollama',
      threadId: 'usage-thread',
      turnId,
      promptTokens: 512,
      completionTokens: 128,
    });
    expect('cacheReadTokens' in usageEvents[0]).toBe(false);
    expect('cacheWriteTokens' in usageEvents[0]).toBe(false);
    // No totalTokens claim: the fold derives prompt + completion itself.
    expect('totalTokens' in usageEvents[0]).toBe(false);
    const usageIndex = events.findIndex(
      (event) => event.method === 'token-usage.updated',
    );
    const completedIndex = events.findIndex(
      (event) => event.method === 'turn.completed',
    );
    expect(usageIndex).toBeGreaterThanOrEqual(0);
    expect(completedIndex).toBeGreaterThan(usageIndex);
  });

  test('a wire-reported cached_tokens IS published as cacheReadTokens', async () => {
    const { events } = await runTurn({
      finishReason: 'stop',
      usage: {
        inputTokens: 512,
        outputTokens: 128,
        cacheReadTokens: 200,
        raw: {
          prompt_tokens: 512,
          completion_tokens: 128,
          prompt_tokens_details: { cached_tokens: 200 },
        },
      },
    });
    const usageEvent = events.find(
      (event) => event.method === 'token-usage.updated',
    ) as Record<string, unknown>;
    expect(usageEvent).toMatchObject({
      promptTokens: 512,
      completionTokens: 128,
      cacheReadTokens: 200,
    });
  });

  test('an SDK-coerced zero for an absent wire prompt_tokens is NOT published as a measurement', async () => {
    // The openai-compatible SDK coerces `prompt_tokens ?? 0`: a schema-valid
    // wire usage carrying only completion_tokens normalizes to
    // inputTokens: 0, which is an SDK invention, not an engine report
    // (review MEDIUM, station#4197).
    const { events } = await runTurn({
      finishReason: 'stop',
      usage: {
        inputTokens: 0,
        outputTokens: 40,
        raw: { completion_tokens: 40 },
      },
    });
    const usageEvents = events.filter(
      (event) => event.method === 'token-usage.updated',
    );
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({ completionTokens: 40 });
    expect('promptTokens' in usageEvents[0]).toBe(false);
  });

  test("an explicit wire null — the schema's other spelling of absence — is not a measurement either", async () => {
    // `prompt_tokens: null` parses (schema is nullish) and the SDK coerces
    // it to 0 exactly like a missing key (delta-review MEDIUM, #4197).
    const { events } = await runTurn({
      finishReason: 'stop',
      usage: {
        inputTokens: 0,
        outputTokens: 40,
        raw: { prompt_tokens: null, completion_tokens: 40 },
      },
    });
    const usageEvents = events.filter(
      (event) => event.method === 'token-usage.updated',
    );
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({ completionTokens: 40 });
    expect('promptTokens' in usageEvents[0]).toBe(false);
  });

  test('a finish chunk with NO usage publishes NO token-usage.updated — absence is not an event of zeros', async () => {
    const { events } = await runTurn({ finishReason: 'stop' });
    expect(
      events.filter((event) => event.method === 'token-usage.updated'),
    ).toHaveLength(0);
    expect(
      events.filter((event) => event.method === 'turn.completed'),
    ).toHaveLength(1);
  });
});
