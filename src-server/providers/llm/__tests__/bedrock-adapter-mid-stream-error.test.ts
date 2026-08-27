import { describe, expect, test, vi } from 'vitest';
import { BedrockAdapter } from '../../adapters/bedrock-adapter.js';

// station#3586: this file proves the full path a mid-stream ai-sdk error
// part takes through a REAL `AiSdkLLMProvider` subclass's `createStream`
// (the producer this issue fixes) and a REAL `BedrockAdapter.sendTurn` (the
// consumer whose existing `chunk.type === 'error'` → `throw` path this issue
// makes reachable for the first time for a mid-generation failure) — not a
// synthetic `runtime.error`/`turn.completed` event constructed by hand.
//
// Before the fix: `createStream` consumed only `result.textStream`, whose
// transform (`node_modules/ai/dist/index.mjs`) enqueues ONLY `text-delta`
// parts — an `error` part is ENQUEUED, never thrown (`consumeStream`'s
// `onError` only fires when the reader itself throws), so it silently
// vanished. The loop ran out of text-delta parts, `result.finishReason`
// resolved to `'error'`, `mapAiSdkFinishReason`'s default arm mapped that to
// `'other'`, and `BedrockAdapter` published an ordinary `turn.completed` —
// verified end-to-end in the original issue report. After the fix,
// `createStream` consumes `result.fullStream` and forwards the `error` part
// as station's own `{ type: 'error' }` chunk, which `BedrockAdapter.
// sendTurn`'s loop (`bedrock-adapter.ts`) already throws on — reaching the
// adapter's catch block and `publishTurnFailure`, which emits
// `method: 'runtime.error'`, the only canonical event the session-lifecycle
// projector folds a session to 'failed' on.
const streamTextMock = vi.fn();

vi.mock('ai', () => ({
  streamText: (...args: unknown[]) => streamTextMock(...args),
}));

// `AiSdkLLMProvider` is imported at runtime via a dynamic `await import()`
// (mirroring `ai-sdk-llm-provider.test.ts`) so `vi.mock('ai', ...)` above
// applies before the module under test loads it.
const { AiSdkLLMProvider } = await import('../ai-sdk-llm-provider.js');

class TestLLMProvider extends AiSdkLLMProvider {
  readonly id = 'test-provider';
  readonly displayName = 'Test Provider';
  protected languageModel(): any {
    return {} as any;
  }
  async listModels() {
    return [];
  }
  async getPrerequisites() {
    return [];
  }
}

function fakeStreamTextResultWithMidStreamError(options: {
  text: string[];
  errorPart: unknown;
}) {
  const finishReason = Promise.resolve('error');
  finishReason.catch(() => {});
  return {
    fullStream: (async function* () {
      for (const value of options.text) {
        yield { type: 'text-delta', text: value };
      }
      yield { type: 'error', error: options.errorPart };
      // A real ai-sdk stream keeps enqueuing parts after `error`
      // (`stepFinishReason = 'error'`, `hasReceivedTerminalChunk = true`
      // skips the "no output" branch in `flush()`) — `finish-step`/`finish`
      // still follow. `createStream` must not reach them.
      yield {
        type: 'finish-step',
        finishReason: 'error',
        rawFinishReason: undefined,
        usage: {},
        providerMetadata: undefined,
        response: {},
      };
      yield {
        type: 'finish',
        finishReason: 'error',
        rawFinishReason: undefined,
        totalUsage: {},
      };
    })(),
    response: Promise.resolve({}),
    finishReason,
  };
}

async function collectEvents(
  adapter: BedrockAdapter,
  max = 10,
): Promise<Array<{ method?: string; [key: string]: unknown }>> {
  const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
  const events: Array<{ method?: string; [key: string]: unknown }> = [];
  for (let index = 0; index < max; index += 1) {
    const next = await iterator.next();
    if (next.done) break;
    events.push(
      next.value as unknown as { method?: string; [key: string]: unknown },
    );
    if (
      next.value?.method === 'turn.completed' ||
      next.value?.method === 'runtime.error'
    ) {
      break;
    }
  }
  return events;
}

describe('BedrockAdapter + a real AiSdkLLMProvider subclass: station#3586 mid-stream error', () => {
  test('a mid-stream ai-sdk error part publishes runtime.error, never turn.completed', async () => {
    streamTextMock.mockReturnValueOnce(
      fakeStreamTextResultWithMidStreamError({
        text: ['Partial ', 'output'],
        errorPart: new Error('provider stream failed mid-generation'),
      }),
    );
    const adapter = new BedrockAdapter(
      {},
      {
        llm: new TestLLMProvider({}) as any,
        modelCatalog: { resolveModelId: async (modelId: string) => modelId },
      },
    );

    await adapter.startSession({
      provider: 'bedrock',
      threadId: 'mid-stream-error',
      modelId: 'anthropic.claude',
    });
    // `BedrockAdapter.sendTurn` re-throws after publishing the failure event
    // (see `bedrock-adapter.ts`'s catch block: `publishTurnFailure(...)`
    // then `throw error;`) — the rejection itself is not this test's claim,
    // the PUBLISHED EVENT is, so just let it settle either way before
    // reading the event stream.
    await adapter
      .sendTurn({
        threadId: 'mid-stream-error',
        input: 'Inspect the repository',
      })
      .catch(() => {});

    const events = await collectEvents(adapter);
    const terminal = events.find(
      (event) =>
        event.method === 'turn.completed' || event.method === 'runtime.error',
    );

    expect(terminal).toBeDefined();
    expect(terminal?.method).toBe('runtime.error');
    expect(events.some((event) => event.method === 'turn.completed')).toBe(
      false,
    );
  });

  test('negative control: a stream with no error part still publishes turn.completed', async () => {
    const finishReason = Promise.resolve('stop');
    streamTextMock.mockReturnValueOnce({
      fullStream: (async function* () {
        yield { type: 'text-delta', text: 'All good' };
        yield {
          type: 'finish',
          finishReason: 'stop',
          rawFinishReason: undefined,
          totalUsage: {},
        };
      })(),
      response: Promise.resolve({}),
      finishReason,
    });
    const adapter = new BedrockAdapter(
      {},
      {
        llm: new TestLLMProvider({}) as any,
        modelCatalog: { resolveModelId: async (modelId: string) => modelId },
      },
    );

    await adapter.startSession({
      provider: 'bedrock',
      threadId: 'no-error',
      modelId: 'anthropic.claude',
    });
    await adapter.sendTurn({
      threadId: 'no-error',
      input: 'Inspect the repository',
    });

    const events = await collectEvents(adapter);
    const terminal = events.find(
      (event) =>
        event.method === 'turn.completed' || event.method === 'runtime.error',
    );
    expect(terminal?.method).toBe('turn.completed');
  });
});
