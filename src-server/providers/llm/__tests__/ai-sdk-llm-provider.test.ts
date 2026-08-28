import { describe, expect, test, vi } from 'vitest';

// archive#3545 review FIX 4: the earlier version of this file mocked
// `streamText` to return NO `finishReason` property at all, and titled
// itself as proving the finish chunk "carries no finishReason key when the
// ai-sdk response has no usable modelId" — modelId has nothing to do with
// it, and worse, a mock that never exposes `finishReason` cannot prove
// anything about whether `createStream` reads it: implementing the real
// propagation fix left that version green regardless. A real ai-sdk
// `StreamTextResult` always exposes `finishReason: Promise<FinishReason>`
// (see the installed `ai` package's type — 'stop' | 'length' |
// 'content-filter' | 'tool-calls' | 'error' | 'other') once the stream
// settles, so the mock here does too. This file now proves the actual
// property: `AiSdkLLMProvider.createStream` awaits that promise and maps
// ai-sdk's vocabulary onto station's own.
const streamTextMock = vi.fn();

vi.mock('ai', () => ({
  streamText: (...args: unknown[]) => streamTextMock(...args),
}));

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

function fakeStreamTextResult(options: {
  text?: string[];
  finishReason: Promise<unknown>;
  /**
   * archive#3586: when set, the mocked `fullStream` enqueues this as a
   * mid-stream `{ type: 'error' }` PART (ai-sdk's real shape, verified
   * against `node_modules/ai/dist/index.mjs` — the stream ENQUEUES an error
   * part rather than rejecting/throwing) immediately after the text parts,
   * followed by the same `finish-step`/`finish` parts a real settled-but-
   * errored ai-sdk stream still emits (`stepFinishReason = 'error'`,
   * `hasReceivedTerminalChunk = true` skips the "no output" branch in
   * `flush()`). Proves `createStream` does not merely happen to stop early
   * because the mock stream ends after the error — it must actively `return`
   * rather than keep draining a stream that still has more parts.
   */
  errorPart?: unknown;
  /**
   * archive#4197: the `result.usage` promise (`LanguageModelUsage`). When
   * omitted the mocked result simply has no `usage` property — the same
   * absence the producer must translate into a finish chunk with NO
   * `usage` key at all (not `{}`, not zeros).
   */
  usage?: Promise<unknown>;
}) {
  // Node/vitest flag a promise as an unhandled rejection if nothing attaches
  // a handler before the microtask queue drains, independent of whether a
  // LATER `await` of the same promise (inside `createStream`, several
  // microtask hops away in this file's rejection cases) also observes it.
  // Attaching a no-op `.catch` here marks the promise "handled" for that
  // detector without consuming the rejection for any other awaiter — each
  // `await`/`.then` of the same promise independently replays its outcome.
  options.finishReason.catch(() => {});
  options.usage?.catch(() => {});
  return {
    // archive#3586: `fullStream` yields the raw `TextStreamPart` union, not
    // plain strings — `text-delta` carries its text on `.text`, matching
    // `node_modules/ai/dist/index.d.ts`'s `TextStreamPart<TOOLS>` shape.
    // `createStream` now consumes THIS getter, not `textStream`.
    fullStream: (async function* () {
      for (const value of options.text ?? ['hello']) {
        yield { type: 'text-delta', text: value };
      }
      if (options.errorPart !== undefined) {
        yield { type: 'error', error: options.errorPart };
        // A real ai-sdk stream keeps going after enqueuing an `error` part
        // (see this file's docblock above) — `finish-step`/`finish` still
        // follow. `createStream` must not reach them.
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
      }
    })(),
    response: Promise.resolve({}),
    finishReason: options.finishReason,
    ...(options.usage !== undefined ? { usage: options.usage } : {}),
  };
}

async function collectChunks(
  // `AiSdkLLMProvider` is imported at runtime via a dynamic `await import()`
  // (so `vi.mock('ai', ...)` above applies before the module under test
  // loads it) -- that binding is value-only in type-space, so it cannot be
  // used as a type annotation here (TS2749). `TestLLMProvider`, a plain
  // `class` declaration, has a normal type regardless of what its base
  // class binding is.
  provider: TestLLMProvider,
): Promise<Array<{ type: string; finishReason?: string; error?: string }>> {
  const chunks: Array<{ type: string; finishReason?: string; error?: string }> =
    [];
  for await (const chunk of provider.createStream({
    model: 'irrelevant',
    messages: [{ role: 'user', content: 'hi' }],
  })) {
    chunks.push(
      chunk as { type: string; finishReason?: string; error?: string },
    );
  }
  return chunks;
}

async function collectFinishChunk(
  provider: TestLLMProvider,
): Promise<{ type: string; finishReason?: string } | undefined> {
  const chunks = await collectChunks(provider);
  return chunks.find((chunk) => chunk.type === 'finish');
}

describe('AiSdkLLMProvider.createStream: station#3545 finishReason propagation', () => {
  test('a natural stop propagates as "stop"', async () => {
    streamTextMock.mockReturnValueOnce(
      fakeStreamTextResult({ finishReason: Promise.resolve('stop') }),
    );
    const finishChunk = await collectFinishChunk(new TestLLMProvider({}));
    expect(finishChunk).toMatchObject({
      type: 'finish',
      finishReason: 'stop',
    });
  });

  test('a tool-calls stop propagates as "tool-calls"', async () => {
    streamTextMock.mockReturnValueOnce(
      fakeStreamTextResult({ finishReason: Promise.resolve('tool-calls') }),
    );
    const finishChunk = await collectFinishChunk(new TestLLMProvider({}));
    expect(finishChunk).toMatchObject({
      type: 'finish',
      finishReason: 'tool-calls',
    });
  });

  // archive#3545 review HIGH: this is the exact case the original,
  // one-layer-up fix (absence collapsing to `'stop'` at the Bedrock adapter)
  // got wrong — because `createStream` never read `result.finishReason` at
  // all, a real token-ceiling truncation was indistinguishable from an
  // absent value and would ALSO have reported `'stop'`. A truncation is not
  // a natural completion; it must publish `'max-tokens'`.
  test('a token-ceiling truncation ("length") propagates as "max-tokens", not "stop"', async () => {
    streamTextMock.mockReturnValueOnce(
      fakeStreamTextResult({ finishReason: Promise.resolve('length') }),
    );
    const finishChunk = await collectFinishChunk(new TestLLMProvider({}));
    expect(finishChunk).toMatchObject({
      type: 'finish',
      finishReason: 'max-tokens',
    });
  });

  test('a content-filter stop propagates as "other", not "stop"', async () => {
    streamTextMock.mockReturnValueOnce(
      fakeStreamTextResult({
        finishReason: Promise.resolve('content-filter'),
      }),
    );
    const finishChunk = await collectFinishChunk(new TestLLMProvider({}));
    expect(finishChunk).toMatchObject({
      type: 'finish',
      finishReason: 'other',
    });
  });

  // archive#3545: if ai-sdk's own `finishReason` promise rejects (e.g. an
  // abort tore the stream down before it settled), the finish chunk must
  // carry no `finishReason` key at all — absence, not a guessed vocabulary
  // member, and specifically not `'stop'`.
  test('a rejected finishReason promise leaves the finish chunk without a finishReason key', async () => {
    streamTextMock.mockReturnValueOnce(
      fakeStreamTextResult({
        finishReason: Promise.reject(new Error('boom')),
      }),
    );
    const finishChunk = await collectFinishChunk(new TestLLMProvider({}));
    expect(finishChunk).toBeDefined();
    expect(Object.hasOwn(finishChunk as object, 'finishReason')).toBe(false);
  });
});

// archive#3586: `textStream`'s transform (`node_modules/ai/dist/index.mjs`)
// enqueues ONLY `text-delta` parts, so a mid-stream `error` part — ai-sdk's
// real shape for a settled-but-failed generation, verified against the
// installed package: `consumeStream`'s `onError` only fires when the READER
// throws, never when the stream enqueues an `error` part — used to vanish
// entirely. The loop just ran out of text-delta parts, and the post-loop
// code awaited `result.finishReason` (already resolved to `'error'`),
// mapped it to `'other'` via `mapAiSdkFinishReason`'s default arm, and
// yielded an ordinary `finish` chunk: an errored generation, published as a
// completion. `createStream` now consumes `result.fullStream` and forwards
// an `error` part as station's own `{ type: 'error' }` chunk.
describe('AiSdkLLMProvider.createStream: station#3586 mid-stream error parts', () => {
  test('a mid-stream error part becomes a station error chunk, not a finish chunk', async () => {
    streamTextMock.mockReturnValueOnce(
      fakeStreamTextResult({
        text: ['partial '],
        finishReason: Promise.resolve('error'),
        errorPart: new Error('provider stream failed mid-generation'),
      }),
    );
    const chunks = await collectChunks(new TestLLMProvider({}));

    expect(chunks).toContainEqual({
      type: 'text-delta',
      content: 'partial ',
    });
    const errorChunk = chunks.find((chunk) => chunk.type === 'error');
    expect(errorChunk).toMatchObject({
      type: 'error',
      error: expect.stringContaining('provider stream failed mid-generation'),
    });

    // The discriminating half of this test: the mock stream still has a
    // `finish-step` and a `finish` part queued up after the injected `error`
    // part (see `fakeStreamTextResult`'s docblock) — a generator that merely
    // ran out of parts would pass the assertion above by accident. Asserting
    // NO `finish` chunk was ever yielded proves `createStream` actively
    // stops (`return`s) at the error part rather than draining the rest of
    // the stream and also publishing a completion for it.
    expect(chunks.some((chunk) => chunk.type === 'finish')).toBe(false);
  });

  test('a stream with no error part still publishes an ordinary finish chunk (negative control)', async () => {
    streamTextMock.mockReturnValueOnce(
      fakeStreamTextResult({
        text: ['all good'],
        finishReason: Promise.resolve('stop'),
      }),
    );
    const chunks = await collectChunks(new TestLLMProvider({}));
    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(false);
    expect(chunks).toContainEqual(
      expect.objectContaining({ type: 'finish', finishReason: 'stop' }),
    );
  });

  // archive#3586 review "Recommended, and I want it": a REQUEST-TIME
  // failure (e.g. a 401 from the provider's own `doStream`, before any
  // `text-delta` part ever arrives) is a distinct, larger population from a
  // mid-stream failure — every text-generating turn from every
  // `AiSdkLLMProvider` subclass (Bedrock, Anthropic, Google, OpenAI-compat,
  // Ollama) can fail this way, not only ones that got as far as producing
  // some output. Before this change: `textStream` yielded nothing (no
  // text-delta parts exist to forward), the loop ran out immediately, and
  // the post-loop code built an ordinary `finish` chunk with no
  // `finishReason`/`reportedModel` — `turn.completed`, published for a
  // request that produced zero output and never even started generating.
  //
  // archive#3587 review NIT-A: against real `ai@6.0.235`, a request-time
  // failure actually produces `start | error` and the stream then CLOSES —
  // no `finish-step`/`finish` parts follow. This fixture does not model that
  // exact shape: it has no `start` part at all (it never emits one, in any
  // fixture in this file), and reuses `fakeStreamTextResult`'s `errorPart`
  // option, whose `error → finish-step → finish` tail is the MID-STREAM
  // shape, not the request-time one. That is stricter than the real
  // request-time case, not a misrepresentation of it — this fixture still
  // proves the discriminating claim below (no `finish` chunk follows the
  // error) against a stream that has MORE opportunity to leak one than a
  // real request-time failure would, so the assertion is not weakened by
  // the inaccuracy. `fullStream` still exposes the `error` part regardless
  // of which shape produced it, so the SAME branch that fixes mid-stream
  // failures fixes this one too — no separate code path, just a broader
  // population reaching the one this test pins.
  test('a request-time failure with NO text-delta at all still becomes a station error chunk, not an empty finish', async () => {
    streamTextMock.mockReturnValueOnce(
      fakeStreamTextResult({
        text: [],
        finishReason: Promise.resolve('error'),
        errorPart: new Error('401 Unauthorized'),
      }),
    );
    const chunks = await collectChunks(new TestLLMProvider({}));

    expect(chunks.some((chunk) => chunk.type === 'text-delta')).toBe(false);
    const errorChunk = chunks.find((chunk) => chunk.type === 'error');
    expect(errorChunk).toMatchObject({
      type: 'error',
      error: expect.stringContaining('401 Unauthorized'),
    });
    // The same discriminating claim as the mid-stream case: no `finish`
    // chunk — an empty, request-time-failed generation must not also
    // publish a completion.
    expect(chunks.some((chunk) => chunk.type === 'finish')).toBe(false);
  });
});

// archive#3598: `createStream` used to pass `maxTokens` to `streamText`, but
// `ai@6.0.235`'s `CallSettings` field is `maxOutputTokens` — `maxTokens` does
// not exist on that interface, so the fleet's declared output ceiling was
// silently dropped for every ai-sdk-backed provider. This asserts the value
// actually reaches the object handed to `streamText` (the mocked call site
// stands in for "the model"), not merely that the call did not throw.
// `temperature` is the control, exactly as in the issue's own probe:
// correctly-named settings already arrive, so a regression here is
// specifically a field-name mismatch and not a general plumbing failure.
describe('AiSdkLLMProvider.createStream: station#3598 maxTokens -> maxOutputTokens', () => {
  test('a passed maxTokens ceiling reaches streamText as maxOutputTokens, alongside temperature', async () => {
    streamTextMock.mockReturnValueOnce(
      fakeStreamTextResult({ finishReason: Promise.resolve('stop') }),
    );
    const provider = new TestLLMProvider({});
    const chunks: unknown[] = [];
    for await (const chunk of provider.createStream({
      model: 'irrelevant',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.5,
      maxTokens: 42,
    })) {
      chunks.push(chunk);
    }

    // `streamTextMock` is a module-level mock shared by every test in this
    // file (no per-test reset), so its call count accumulates across the
    // suite — assert on the LAST call this test made, not on a total count.
    const calledWith = streamTextMock.mock.calls.at(-1)?.[0] as Record<
      string,
      unknown
    >;
    expect(calledWith.maxOutputTokens).toBe(42);
    expect(calledWith.temperature).toBe(0.5);
    // The defect's exact shape: the wrong key must not also be present.
    expect(calledWith).not.toHaveProperty('maxTokens');
  });
});

describe('AiSdkLLMProvider.createStream: station#4197 finish-chunk usage population', () => {
  /**
   * The full `LanguageModelUsage` shape as the installed `ai` package
   * (6.0.235) resolves it for a Bedrock call with prompt caching active:
   * flat totals plus `inputTokenDetails` and the provider-wire `raw`.
   */
  const bedrockShapedUsage = () => ({
    inputTokens: 9130,
    inputTokenDetails: {
      noCacheTokens: 30,
      cacheReadTokens: 9000,
      cacheWriteTokens: 100,
    },
    outputTokens: 250,
    outputTokenDetails: { textTokens: 250, reasoningTokens: undefined },
    totalTokens: 9380,
    raw: {
      inputTokens: 30,
      outputTokens: 250,
      totalTokens: 280,
      cacheReadInputTokens: 9000,
      cacheWriteInputTokens: 100,
    },
  });

  async function finishChunkOf(
    usage?: Promise<unknown>,
  ): Promise<Record<string, unknown> | undefined> {
    streamTextMock.mockReturnValueOnce(
      fakeStreamTextResult({
        finishReason: Promise.resolve('stop'),
        ...(usage !== undefined ? { usage } : {}),
      }),
    );
    const chunks = await collectChunks(new TestLLMProvider({}));
    return chunks.find((chunk) => chunk.type === 'finish') as
      | Record<string, unknown>
      | undefined;
  }

  test('reported figures reach the finish chunk verbatim, raw included', async () => {
    const finish = await finishChunkOf(Promise.resolve(bedrockShapedUsage()));
    expect(finish?.usage).toEqual({
      inputTokens: 9130,
      outputTokens: 250,
      totalTokens: 9380,
      cacheReadTokens: 9000,
      cacheWriteTokens: 100,
      raw: {
        inputTokens: 30,
        outputTokens: 250,
        totalTokens: 280,
        cacheReadInputTokens: 9000,
        cacheWriteInputTokens: 100,
      },
    });
  });

  test('a result with no usage property leaves the finish chunk without a usage key — not {} and not zeros', async () => {
    const finish = await finishChunkOf(undefined);
    expect(finish).toBeDefined();
    expect(finish && 'usage' in finish).toBe(false);
  });

  test('a usage promise resolving to an all-undefined shape (ai-sdk null usage) also yields no usage key', async () => {
    // `createNullLanguageModelUsage()` in the installed `ai` package: every
    // field `undefined`, `raw: undefined`.
    const finish = await finishChunkOf(
      Promise.resolve({
        inputTokens: undefined,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokens: undefined,
        outputTokenDetails: {
          textTokens: undefined,
          reasoningTokens: undefined,
        },
        totalTokens: undefined,
        raw: undefined,
      }),
    );
    expect(finish).toBeDefined();
    expect(finish && 'usage' in finish).toBe(false);
  });

  test('a rejected usage promise degrades to an absent usage key, never a thrown error', async () => {
    const finish = await finishChunkOf(
      Promise.reject(new Error('usage never settled')),
    );
    expect(finish).toBeDefined();
    expect(finish && 'usage' in finish).toBe(false);
  });

  test('NaN and negative figures are dropped per-field, never coerced to 0', async () => {
    const finish = await finishChunkOf(
      Promise.resolve({
        inputTokens: Number.NaN,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: -5,
          cacheWriteTokens: 40,
        },
        outputTokens: 200,
        outputTokenDetails: { textTokens: 200, reasoningTokens: undefined },
        totalTokens: -1,
        raw: { inputTokens: -7 },
      }),
    );
    expect(finish?.usage).toEqual({
      outputTokens: 200,
      cacheWriteTokens: 40,
      raw: { inputTokens: -7 },
    });
    const usage = finish?.usage as Record<string, unknown>;
    expect('inputTokens' in usage).toBe(false);
    expect('cacheReadTokens' in usage).toBe(false);
    expect('totalTokens' in usage).toBe(false);
  });
});
