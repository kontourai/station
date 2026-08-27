import { ReadableStream } from 'node:stream/web';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { OllamaAdapter } from '../adapters/ollama-adapter.js';

// Ollama is now driven through the shared ai-sdk OpenAI-compatible model, so the
// adapter talks to `<baseUrl>/v1/chat/completions` with SSE framing instead of
// the legacy native `<baseUrl>/api/chat` NDJSON endpoint.
function sseStreamFromContent(
  parts: string[],
  options: { model?: string } = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      parts.forEach((content, i) => {
        const payload = {
          ...(options.model ? { model: options.model } : {}),
          choices: [
            {
              delta: { content },
              ...(i === parts.length - 1 ? { finish_reason: 'stop' } : {}),
            },
          ],
        };
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
        );
      });
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

/**
 * Drains an event iterator until `quietMs` passes with no new event (bounded
 * by `maxEvents` as a safety cap). A fixed-count read of "however many
 * events the happy path publishes" cannot see a REGRESSION that appends an
 * extra event afterward — reading exactly N leaves the (N+1)th unread and
 * silently un-asserted. This reads until the stream actually goes quiet.
 */
async function drainEvents(
  iterator: AsyncIterator<unknown>,
  {
    quietMs = 200,
    maxEvents = 20,
  }: { quietMs?: number; maxEvents?: number } = {},
): Promise<unknown[]> {
  const events: unknown[] = [];
  for (let i = 0; i < maxEvents; i += 1) {
    const result = await Promise.race([
      iterator
        .next()
        .then((r) => ({ timedOut: false as const, value: r.value })),
      new Promise<{ timedOut: true }>((resolve) =>
        setTimeout(() => resolve({ timedOut: true }), quietMs),
      ),
    ]);
    if (result.timedOut) break;
    events.push(result.value);
  }
  return events;
}

describe('OllamaAdapter', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('declares only the built-in default route as local', () => {
    expect(new OllamaAdapter().metadata.modelExecution?.locality).toBe('local');
    expect(
      new OllamaAdapter('http://remote.example').metadata.modelExecution
        ?.locality,
    ).toBe('unknown');
  });

  // station#1430 review, H-2: `resolveModelId` (startSession, and the
  // model-switch path on send) only ever reads `match.id` from the catalog
  // — it must not pay for, or be stalled by, the `/api/show` capability
  // enrichment `OllamaLLMProvider.listModelCatalog` does for the inventory
  // path. This is the fault-injection-shaped pin: if `resolveModelId` ever
  // regressed to calling `listModelCatalog()` without
  // `skipCapabilityEnrichment: true`, this goes red.
  test('resolving a model id on session start performs zero /api/show calls', async () => {
    const fetchMock = vi.fn<
      (...args: Parameters<typeof fetch>) => Promise<any>
    >(async (input) => {
      const url = String(input);
      if (url.endsWith('/api/tags')) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => JSON.stringify({ models: [{ name: 'llama3.2' }] }),
        };
      }
      if (url.endsWith('/api/show')) {
        throw new Error(
          'resolveModelId must not call /api/show — it never reads capabilities.',
        );
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        body: sseStreamFromContent(['hi']),
      };
    });
    global.fetch = fetchMock as any;

    const adapter = new OllamaAdapter('http://ollama.test');
    await adapter.startSession({
      provider: 'ollama',
      threadId: 'thread-zero-call',
      modelId: 'llama3.2',
    });

    expect(
      fetchMock.mock.calls.some((call) =>
        String(call[0]).endsWith('/api/show'),
      ),
    ).toBe(false);
  });

  test('propagates prerequisite cancellation to the Ollama health request', async () => {
    let observedSignal: AbortSignal | undefined;
    global.fetch = vi.fn((_input, init) => {
      observedSignal = init?.signal ?? undefined;
      return new Promise((_, reject) => {
        observedSignal?.addEventListener(
          'abort',
          () => reject(observedSignal?.reason),
          { once: true },
        );
      });
    }) as any;
    const controller = new AbortController();
    const adapter = new OllamaAdapter('http://ollama.test');

    const prerequisites = adapter.getPrerequisites({
      signal: controller.signal,
    });
    controller.abort(new Error('health cancelled'));

    await expect(prerequisites).rejects.toThrow('health cancelled');
    expect(observedSignal).toBe(controller.signal);
  });

  test('reports a bounded Ollama catalog as truncated', async () => {
    const body = JSON.stringify({
      models: [{ name: 'model-a' }, { name: 'model-b' }],
    });
    global.fetch = vi.fn(async () => ({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => body,
    })) as any;
    const adapter = new OllamaAdapter('http://ollama.test');

    await expect(
      adapter.listModelCatalog?.({ maxEntries: 1 }),
    ).resolves.toEqual({
      models: [{ id: 'model-a', name: 'model-a', originalId: 'model-a' }],
      truncated: true,
    });
  });

  test('streams basic chat through Ollama and records multi-turn history', async () => {
    const fetchMock = vi.fn<
      (...args: Parameters<typeof fetch>) => Promise<any>
    >(async (input) =>
      String(input).endsWith('/api/tags')
        ? {
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            text: async () =>
              JSON.stringify({ models: [{ name: 'llama3.2' }] }),
          }
        : {
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'text/event-stream' }),
            body: sseStreamFromContent(['hello', ' there']),
          },
    );
    global.fetch = fetchMock as any;

    const adapter = new OllamaAdapter('http://ollama.test');
    await adapter.startSession({
      provider: 'ollama',
      threadId: 'thread-1',
      modelId: 'llama3.2',
      modelOptions: { systemPrompt: 'You are concise.' },
    });
    const result = await adapter.sendTurn({
      threadId: 'thread-1',
      input: 'Say hi',
    });

    expect(result.threadId).toBe('thread-1');
    // ai-sdk OpenAI-compatible model hits the /v1 chat-completions endpoint.
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'http://ollama.test/v1/chat/completions',
    );
    const requestBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(requestBody).toMatchObject({
      model: 'llama3.2',
      stream: true,
      messages: [
        { role: 'system', content: 'You are concise.' },
        { role: 'user', content: 'Say hi' },
      ],
    });

    await adapter.sendTurn({
      threadId: 'thread-1',
      input: 'Again',
    });
    const secondRequestBody = JSON.parse(
      String(fetchMock.mock.calls[2]?.[1]?.body),
    );
    expect(secondRequestBody.messages).toEqual([
      { role: 'system', content: 'You are concise.' },
      { role: 'user', content: 'Say hi' },
      { role: 'assistant', content: 'hello there' },
      { role: 'user', content: 'Again' },
    ]);
  });

  test('rejects a model-less session without inventing a default', async () => {
    global.fetch = vi.fn() as any;
    const adapter = new OllamaAdapter('http://ollama.test');

    await expect(
      adapter.startSession({ provider: 'ollama', threadId: 'model-less' }),
    ).rejects.toThrow('requires a launchable model selector');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('rejects a selector absent from the configured Ollama server', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ models: [{ name: 'model-a' }] }),
    })) as any;
    const adapter = new OllamaAdapter('http://ollama.test');

    await expect(
      adapter.startSession({
        provider: 'ollama',
        threadId: 'unknown-model',
        modelId: 'model-b',
      }),
    ).rejects.toThrow("selector 'model-b' is not available");
    await expect(adapter.hasSession('unknown-model')).resolves.toBe(false);
  });

  test('aborts active Ollama provider work when a turn is interrupted', async () => {
    let streamSignal: AbortSignal | undefined;
    const llm = {
      listModelCatalog: vi.fn(async () => ({
        source: 'live',
        models: [{ id: 'model-a', name: 'Model A' }],
      })),
      createStream: vi.fn(async function* (options: { signal?: AbortSignal }) {
        streamSignal = options.signal;
        await new Promise<never>((_, reject) => {
          options.signal?.addEventListener(
            'abort',
            () => reject(options.signal?.reason),
            { once: true },
          );
        });
      }),
    };
    const adapter = new OllamaAdapter('http://ollama.test', {
      llm: llm as any,
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
    await adapter.startSession({
      provider: 'ollama',
      threadId: 'interrupt-turn',
      modelId: 'model-a',
    });

    const pending = adapter.sendTurn({
      threadId: 'interrupt-turn',
      input: 'Run',
    });
    await vi.waitFor(() => expect(streamSignal).toBeDefined());
    await adapter.interruptTurn('interrupt-turn');

    expect(streamSignal?.aborted).toBe(true);
    await expect(pending).rejects.toThrow('Turn interrupted');
    const events = [];
    for (let index = 0; index < 5; index += 1) {
      events.push((await iterator.next()).value);
    }
    expect(
      events.filter(
        (event) =>
          event?.method === 'turn.aborted' ||
          event?.method === 'turn.completed',
      ),
    ).toHaveLength(1);
  });

  // station#3442 review finding, re-verified against this tree: the
  // `sendTurn` catch handler's `if (controller.signal.aborted)` arm (the
  // one that would publish `turn.completed`/`finishReason:'cancelled'`)
  // had zero coverage. Tracing it further: `interruptTurn`/`stopSession`
  // both mutate `activeTurns` (delete/overwrite) SYNCHRONOUSLY, in the same
  // tick as the `controller.abort()` call that triggers it — so by the time
  // the aborted stream's rejection unwinds through the catch handler on a
  // later microtask, `this.isCurrentTurn(...)` is already false and the
  // WHOLE guarded block (both the cancelled arm and the runtime.error arm)
  // is skipped. Confirmed empirically (a diagnostic probe reading events
  // with a bounded per-event timeout observed exactly 5 events for an
  // interrupted turn — session.started, session.configured,
  // session.state-changed, turn.started, turn.aborted — and then nothing;
  // no turn.completed, no runtime.error, ever arrives). So today the
  // `finishReason:'cancelled'` sub-arm is unreachable via any public API on
  // this adapter, not merely untested — reported separately as an
  // out-of-scope finding. What IS reachable, and what actually matters for
  // the "mirror image of #3442" regression risk (a user Stop wrongly
  // recording the session `failed`), is the adapter's real observable
  // contract: interrupting a turn publishes exactly one terminal-shaped
  // event (`turn.aborted`) and NEVER a `runtime.error`. That is what this
  // test pins.
  test('station#3442: interrupting a turn publishes turn.aborted and never leaks a runtime.error (or a turn.completed)', async () => {
    let streamSignal: AbortSignal | undefined;
    const llm = {
      listModelCatalog: vi.fn(async () => ({
        source: 'live',
        models: [{ id: 'model-a', name: 'Model A' }],
      })),
      createStream: vi.fn(async function* (options: { signal?: AbortSignal }) {
        streamSignal = options.signal;
        await new Promise<never>((_, reject) => {
          options.signal?.addEventListener(
            'abort',
            () => reject(options.signal?.reason),
            { once: true },
          );
        });
      }),
    };
    const adapter = new OllamaAdapter('http://ollama.test', {
      llm: llm as any,
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
    await adapter.startSession({
      provider: 'ollama',
      threadId: 'cancel-turn',
      modelId: 'model-a',
    });
    const pending = adapter.sendTurn({
      threadId: 'cancel-turn',
      input: 'Run',
    });
    await vi.waitFor(() => expect(streamSignal).toBeDefined());
    await adapter.interruptTurn('cancel-turn');
    await expect(pending).rejects.toThrow('Turn interrupted');

    const events: any[] = await drainEvents(iterator);
    expect(events.length).toBeGreaterThanOrEqual(5);
    expect(
      events.filter(
        (event) =>
          event?.method === 'turn.completed' ||
          event?.method === 'runtime.error',
      ),
    ).toEqual([]);
    expect(events.filter((event) => event?.method === 'turn.aborted')).toEqual([
      expect.objectContaining({ method: 'turn.aborted' }),
    ]);
  });

  // station#3466 site pin: `stopSession` (`.abort()` then `activeTurns.
  // delete`) mutates `activeTurns` synchronously, in the same tick as the
  // abort that races this stream's rejection. stopSession publishes no
  // per-turn event at all, so the discriminating count here is ZERO -- any
  // turn.completed/turn.aborted/runtime.error can only come from the catch
  // handler's now-deleted `if (controller.signal.aborted)` arm (or its
  // sibling publishTurnFailure) wrongly firing because a future reorder let
  // the stream's rejection win the race against the delete.
  test('aborts active Ollama provider work before stopping a session', async () => {
    let streamSignal: AbortSignal | undefined;
    const llm = {
      listModelCatalog: vi.fn(async () => ({
        source: 'live',
        models: [{ id: 'model-a', name: 'Model A' }],
      })),
      createStream: vi.fn(async function* (options: { signal?: AbortSignal }) {
        streamSignal = options.signal;
        await new Promise<never>((_, reject) => {
          options.signal?.addEventListener(
            'abort',
            () => reject(options.signal?.reason),
            { once: true },
          );
        });
      }),
    };
    const adapter = new OllamaAdapter('http://ollama.test', {
      llm: llm as any,
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
    await adapter.startSession({
      provider: 'ollama',
      threadId: 'stop-turn',
      modelId: 'model-a',
    });

    const pending = adapter.sendTurn({
      threadId: 'stop-turn',
      input: 'Run',
    });
    await vi.waitFor(() => expect(streamSignal).toBeDefined());
    await adapter.stopSession('stop-turn');

    expect(streamSignal?.aborted).toBe(true);
    await expect(pending).rejects.toThrow('Session stopped');

    const events: any[] = await drainEvents(iterator);
    expect(
      events.filter(
        (event) =>
          event?.method === 'turn.aborted' ||
          event?.method === 'turn.completed' ||
          event?.method === 'runtime.error',
      ),
    ).toEqual([]);
  });

  test('keeps a newer turn active when a superseded stream settles', async () => {
    const controls: Array<{ resolve(): void }> = [];
    const llm = {
      listModelCatalog: vi.fn(async () => ({
        source: 'live',
        models: [{ id: 'model-a', name: 'Model A' }],
      })),
      createStream: vi.fn(async function* (options: { signal?: AbortSignal }) {
        await new Promise<void>((resolve, reject) => {
          controls.push({ resolve });
          options.signal?.addEventListener(
            'abort',
            () => reject(options.signal?.reason),
            { once: true },
          );
        });
        yield { type: 'text-delta' as const, content: 'current' };
      }),
    };
    const adapter = new OllamaAdapter('http://ollama.test', {
      llm: llm as any,
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
    await adapter.startSession({
      provider: 'ollama',
      threadId: 'overlap',
      modelId: 'model-a',
    });

    const first = adapter.sendTurn({ threadId: 'overlap', input: 'first' });
    const firstFailure = expect(first).rejects.toThrow('Superseded');
    await vi.waitFor(() => expect(controls).toHaveLength(1));
    const second = adapter.sendTurn({ threadId: 'overlap', input: 'second' });
    await vi.waitFor(() => expect(controls).toHaveLength(2));
    const events = [];
    for (let index = 0; index < 7; index += 1) {
      events.push(await iterator.next());
    }
    const turnIds = events
      .map((result) => result.value)
      .filter((event) => event.method === 'turn.started')
      .map((event) => event.turnId);
    expect(
      events
        .map((result) => result.value)
        .filter(
          (event) =>
            event.method === 'turn.aborted' && event.turnId === turnIds[0],
        ),
    ).toEqual([expect.objectContaining({ reason: 'superseded' })]);
    // station#3466 site pin: `sendTurn`'s supersede branch aborts the first
    // turn's controller and THEN, still synchronously (no await between),
    // overwrites `activeTurns` with the second turn -- the abort listener
    // above races that overwrite as tightly as this mock can arrange. If a
    // future reorder ever separated the abort from the overwrite with an
    // await, the first turn's own stream rejection could win the race and
    // its catch handler's (now-deleted) `if (controller.signal.aborted)` arm
    // would publish a duplicate `turn.completed` alongside the explicit
    // supersede `turn.aborted` asserted above.
    expect(
      events
        .map((result) => result.value)
        .filter(
          (event) =>
            event.turnId === turnIds[0] &&
            (event.method === 'turn.completed' ||
              event.method === 'runtime.error'),
        ),
    ).toEqual([]);

    await firstFailure;
    expect((await adapter.listSessions())[0]?.status).toBe('running');
    await expect(adapter.interruptTurn('overlap', turnIds[0])).resolves.toEqual(
      expect.objectContaining({
        outcome: 'target-mismatch',
        activeTurnId: turnIds[1],
      }),
    );

    controls[1]!.resolve();
    await expect(second).resolves.toMatchObject({ threadId: 'overlap' });
    expect((await adapter.listSessions())[0]?.status).toBe('ready');
  });

  // #796: a per-turn model override changes what actually runs, but only
  // `session.configured` carries a model into the read model and the
  // persisted session row — without republishing it the stored model
  // silently disagrees with what ran once the session is rehydrated.
  test('republishes session.configured when a turn overrides the session model (#796)', async () => {
    const fetchMock = vi.fn<
      (...args: Parameters<typeof fetch>) => Promise<any>
    >(async (input) =>
      String(input).endsWith('/api/tags')
        ? {
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            text: async () =>
              JSON.stringify({
                models: [{ name: 'llama3.2' }, { name: 'qwen3:1.7b' }],
              }),
          }
        : {
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'text/event-stream' }),
            body: sseStreamFromContent(['hi']),
          },
    );
    global.fetch = fetchMock as any;

    const adapter = new OllamaAdapter('http://ollama.test');
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
    const seen: string[] = [];
    const models: Array<string | undefined> = [];
    const modelReceipts: unknown[] = [];
    const modelPlans: unknown[] = [];
    const cwds: Array<string | undefined> = [];
    const collect = (async () => {
      for (let index = 0; index < 4; index++) {
        const next = await iterator.next();
        if (next.done) return;
        seen.push(next.value.method);
        if (next.value.method === 'session.configured') {
          models.push((next.value as { model?: string }).model);
          modelReceipts.push(
            (next.value as { metadata?: Record<string, unknown> }).metadata
              ?.modelSelectionReceipt,
          );
          modelPlans.push(
            (next.value as { metadata?: Record<string, unknown> }).metadata
              ?.modelLaunchPlan,
          );
          cwds.push((next.value as { cwd?: string }).cwd);
        }
      }
    })();

    await adapter.startSession({
      provider: 'ollama',
      threadId: 'thread-override',
      modelId: 'llama3.2',
      cwd: '/work/station',
    });
    await adapter.sendTurn({
      threadId: 'thread-override',
      input: 'Say hi',
      modelId: 'qwen3:1.7b',
      metadata: {
        modelLaunchPlan: {
          kind: 'station-resolved',
          modelConnectionId: 'ollama-runtime',
          modelId: 'qwen3:1.7b',
          evidence: 'catalog-pending',
        },
      },
    });
    await collect;

    expect(models).toEqual(['llama3.2', 'qwen3:1.7b']);
    expect(
      seen.filter((method) => method === 'session.configured'),
    ).toHaveLength(2);
    // Consumers read `cwd` off the LATEST session.configured with no
    // fallback (`buildAgentRunSummary`), so a restatement that drops it
    // erases the session's working directory from that turn onward.
    expect(cwds).toEqual(['/work/station', '/work/station']);
    expect(modelReceipts).toEqual([
      { requestedModel: 'llama3.2', appliedModel: 'llama3.2' },
      { requestedModel: 'qwen3:1.7b', appliedModel: 'qwen3:1.7b' },
    ]);
    expect(modelPlans).toEqual([
      undefined,
      {
        kind: 'station-resolved',
        modelConnectionId: 'ollama-runtime',
        modelId: 'qwen3:1.7b',
        evidence: 'catalog-accepted',
      },
    ]);
  });

  test('does not republish session.configured when a turn keeps the session model (#796)', async () => {
    const fetchMock = vi.fn<
      (...args: Parameters<typeof fetch>) => Promise<any>
    >(async (input) =>
      String(input).endsWith('/api/tags')
        ? {
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            text: async () =>
              JSON.stringify({ models: [{ name: 'llama3.2' }] }),
          }
        : {
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'text/event-stream' }),
            body: sseStreamFromContent(['hi']),
          },
    );
    global.fetch = fetchMock as any;

    const adapter = new OllamaAdapter('http://ollama.test');
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
    const seen: string[] = [];
    const collect = (async () => {
      for (let index = 0; index < 3; index++) {
        const next = await iterator.next();
        if (next.done) return;
        seen.push(next.value.method);
      }
    })();

    await adapter.startSession({
      provider: 'ollama',
      threadId: 'thread-same',
      modelId: 'llama3.2',
    });
    await adapter.sendTurn({ threadId: 'thread-same', input: 'Say hi' });
    await collect;

    expect(
      seen.filter((method) => method === 'session.configured'),
    ).toHaveLength(1);
  });
});

describe('station#1182: runtime-reported model', () => {
  test("end-to-end through the real ai-sdk OpenAI-compatible plumbing: the SSE response body's own `model` field reaches turn.completed as reportedModel", async () => {
    const fetchMock = vi.fn<
      (...args: Parameters<typeof fetch>) => Promise<any>
    >(async (input) =>
      String(input).endsWith('/api/tags')
        ? {
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            text: async () =>
              JSON.stringify({ models: [{ name: 'llama3.2' }] }),
          }
        : {
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'text/event-stream' }),
            // Ollama's own server-reported model — genuinely distinct from
            // the bare 'llama3.2' tag Station requested.
            body: sseStreamFromContent(['hi'], {
              model: 'llama3.2:8b-instruct-q4_0',
            }),
          },
    );
    global.fetch = fetchMock as any;

    const adapter = new OllamaAdapter('http://ollama.test');
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      provider: 'ollama',
      threadId: 'thread-e2e-reported',
      modelId: 'llama3.2',
    });
    await adapter.sendTurn({
      threadId: 'thread-e2e-reported',
      input: 'Say hi',
    });

    let completed: any;
    for (let index = 0; index < 8; index += 1) {
      const next = await iterator.next();
      if (next.value?.method === 'turn.completed') {
        completed = next.value;
        break;
      }
    }
    expect(completed).toBeDefined();
    expect(completed.metadata).toEqual({
      reportedModel: 'llama3.2:8b-instruct-q4_0',
    });
  });

  test('a finish chunk carrying reportedModel is published on turn.completed metadata', async () => {
    const llm = {
      listModelCatalog: vi.fn(async () => ({
        source: 'live',
        models: [{ id: 'model-a', name: 'Model A' }],
      })),
      createStream: vi.fn(async function* () {
        yield { type: 'text-delta', content: 'hi' };
        // Genuinely reported by Ollama's own response body (see
        // ai-sdk-llm-provider.ts) — distinct from the requested 'model-a'.
        yield { type: 'finish', reportedModel: 'model-a:latest-resolved' };
      }),
    };
    const adapter = new OllamaAdapter('http://ollama.test', {
      llm: llm as any,
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      provider: 'ollama',
      threadId: 'thread-reported',
      modelId: 'model-a',
    });
    await adapter.sendTurn({ threadId: 'thread-reported', input: 'hi' });

    let completed: any;
    for (let index = 0; index < 8; index += 1) {
      const next = await iterator.next();
      if (next.value?.method === 'turn.completed') {
        completed = next.value;
        break;
      }
    }
    expect(completed).toBeDefined();
    expect(completed.metadata).toEqual({
      reportedModel: 'model-a:latest-resolved',
    });
  });

  test('a finish chunk with no reportedModel publishes turn.completed with no metadata', async () => {
    const llm = {
      listModelCatalog: vi.fn(async () => ({
        source: 'live',
        models: [{ id: 'model-a', name: 'Model A' }],
      })),
      createStream: vi.fn(async function* () {
        yield { type: 'text-delta', content: 'hi' };
        yield { type: 'finish' };
      }),
    };
    const adapter = new OllamaAdapter('http://ollama.test', {
      llm: llm as any,
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      provider: 'ollama',
      threadId: 'thread-unreported',
      modelId: 'model-a',
    });
    await adapter.sendTurn({ threadId: 'thread-unreported', input: 'hi' });

    let completed: any;
    for (let index = 0; index < 8; index += 1) {
      const next = await iterator.next();
      if (next.value?.method === 'turn.completed') {
        completed = next.value;
        break;
      }
    }
    expect(completed).toBeDefined();
    expect(completed.metadata).toBeUndefined();
  });

  // station#3442: a genuine stream failure (not a user cancellation) must
  // publish `runtime.error`, the one canonical event the session-lifecycle
  // projector folds to 'failed' — a `turn.completed` here (this branch's
  // prior, unconditional behavior) is indistinguishable from an ordinary
  // empty completion and silently folds the session to 'completed'.
  test('a genuine stream failure publishes runtime.error, not turn.completed', async () => {
    const llm = {
      listModelCatalog: vi.fn(async () => ({
        source: 'live',
        models: [{ id: 'model-a', name: 'Model A' }],
      })),
      createStream: vi.fn(async function* () {
        yield { type: 'text-delta', content: 'partial' };
        throw new Error('Ollama connection reset mid-turn');
      }),
    };
    const adapter = new OllamaAdapter('http://ollama.test', {
      llm: llm as any,
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      provider: 'ollama',
      threadId: 'thread-stream-failure',
      modelId: 'model-a',
    });

    await expect(
      adapter.sendTurn({ threadId: 'thread-stream-failure', input: 'hi' }),
    ).rejects.toThrow('Ollama connection reset mid-turn');

    const events: any[] = [];
    let terminal: any;
    for (let index = 0; index < 10 && !terminal; index += 1) {
      const next = (await iterator.next()).value;
      events.push(next);
      if (
        next?.method === 'turn.completed' ||
        next?.method === 'runtime.error'
      ) {
        terminal = next;
      }
    }
    expect(
      events.filter(
        (event) =>
          event?.method === 'turn.completed' ||
          event?.method === 'runtime.error',
      ),
    ).toHaveLength(1);
    expect(terminal).toMatchObject({
      method: 'runtime.error',
      severity: 'error',
      message: 'Ollama connection reset mid-turn',
    });
  });
});

// station#3596, folded into station#3586's own change on review (HIGH-1):
// the "a genuine stream failure publishes runtime.error" test above (inside
// `describe('station#1182: runtime-reported model')`, where this test used
// to live too — station#3587 review NIT-B moved it out, since it has nothing
// to do with reported-model metadata) throws a JS exception from the mock
// generator — the long-standing failure shape. This proves the DISTINCT,
// newly-reachable shape station#3586 introduces: `AiSdkLLMProvider.
// createStream` now translates a mid-stream (or request-time) ai-sdk
// failure into a YIELDED `{ type: 'error' }` CHUNK rather than a thrown
// exception — see `ai-sdk-llm-provider.ts`'s docblock. Before this test
// existed, `OllamaAdapter.sendTurn`'s loop checked only `text-delta` and
// `finish`, so this exact chunk was silently dropped: the loop ran out of
// chunks, exited normally, and the adapter published an ordinary
// `turn.completed` with `finishReason: 'stop'` (`publishCompletion`'s
// default, since no `finish` chunk ever arrived to populate it) for a
// FAILED generation — and `'stop'` has clear authority in
// `runtime-auth-health-monitor.ts`, so the failed turn would have cleared
// its own recorded auth failure. Mirrors `bedrock-adapter.ts`'s equivalent
// chunk-based error test.
describe('station#3596 (folded into station#3586): OllamaAdapter surfaces a yielded error chunk as runtime.error', () => {
  test('a mid-stream error CHUNK (not a thrown exception) publishes runtime.error, not turn.completed', async () => {
    const llm = {
      listModelCatalog: vi.fn(async () => ({
        source: 'live',
        models: [{ id: 'model-a', name: 'Model A' }],
      })),
      createStream: vi.fn(async function* () {
        yield { type: 'text-delta', content: 'Partial ' };
        yield { type: 'error', error: 'provider stream failed mid-generation' };
      }),
    };
    const adapter = new OllamaAdapter('http://ollama.test', {
      llm: llm as any,
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      provider: 'ollama',
      threadId: 'thread-error-chunk',
      modelId: 'model-a',
    });

    await expect(
      adapter.sendTurn({ threadId: 'thread-error-chunk', input: 'hi' }),
    ).rejects.toThrow('provider stream failed mid-generation');

    const events: any[] = [];
    let terminal: any;
    for (let index = 0; index < 10 && !terminal; index += 1) {
      const next = (await iterator.next()).value;
      events.push(next);
      if (
        next?.method === 'turn.completed' ||
        next?.method === 'runtime.error'
      ) {
        terminal = next;
      }
    }
    expect(
      events.filter(
        (event) =>
          event?.method === 'turn.completed' ||
          event?.method === 'runtime.error',
      ),
    ).toHaveLength(1);
    expect(terminal).toMatchObject({
      method: 'runtime.error',
      severity: 'error',
      message: 'provider stream failed mid-generation',
    });
  });
});

// station#3588: `AiSdkLLMProvider.createStream` (which `OllamaLLMProvider`
// inherits unmodified) has propagated a real `finishReason` on its finish
// chunk since station#3545, but `OllamaAdapter.sendTurn`'s loop never read
// `chunk.finishReason` at all — only `chunk.reportedModel`. `publishCompletion`
// defaulted `options.finishReason ?? 'stop'` with no caller ever supplying
// one, so a generation truncated at the token ceiling still published
// `finishReason: 'stop'` — a positive claim of natural completion for a
// response that was cut off.
describe('station#3588: Ollama finishReason propagation', () => {
  test('a truncated (token-ceiling) generation publishes turn.completed with finishReason "max-tokens", not "stop"', async () => {
    const llm = {
      listModelCatalog: vi.fn(async () => ({
        source: 'live',
        models: [{ id: 'model-a', name: 'Model A' }],
      })),
      createStream: vi.fn(async function* () {
        yield { type: 'text-delta', content: 'Truncated output' };
        yield { type: 'finish', finishReason: 'max-tokens' };
      }),
    };
    const adapter = new OllamaAdapter('http://ollama.test', {
      llm: llm as any,
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      provider: 'ollama',
      threadId: 'thread-truncated',
      modelId: 'model-a',
    });
    await adapter.sendTurn({ threadId: 'thread-truncated', input: 'hi' });

    let completed: any;
    for (let index = 0; index < 8; index += 1) {
      const next = await iterator.next();
      if (next.value?.method === 'turn.completed') {
        completed = next.value;
        break;
      }
    }
    expect(completed).toBeDefined();
    expect(completed.finishReason).toBe('max-tokens');
  });

  test('an ordinary completion still publishes finishReason "stop" (producer-supplied, not just the default)', async () => {
    const llm = {
      listModelCatalog: vi.fn(async () => ({
        source: 'live',
        models: [{ id: 'model-a', name: 'Model A' }],
      })),
      createStream: vi.fn(async function* () {
        yield { type: 'text-delta', content: 'Completed output' };
        yield { type: 'finish', finishReason: 'stop' };
      }),
    };
    const adapter = new OllamaAdapter('http://ollama.test', {
      llm: llm as any,
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      provider: 'ollama',
      threadId: 'thread-ordinary',
      modelId: 'model-a',
    });
    await adapter.sendTurn({ threadId: 'thread-ordinary', input: 'hi' });

    let completed: any;
    for (let index = 0; index < 8; index += 1) {
      const next = await iterator.next();
      if (next.value?.method === 'turn.completed') {
        completed = next.value;
        break;
      }
    }
    expect(completed).toBeDefined();
    expect(completed.finishReason).toBe('stop');
  });

  test('a finish chunk with no finishReason key (the genuinely-absent fallback) still publishes "stop"', async () => {
    const llm = {
      listModelCatalog: vi.fn(async () => ({
        source: 'live',
        models: [{ id: 'model-a', name: 'Model A' }],
      })),
      createStream: vi.fn(async function* () {
        yield { type: 'text-delta', content: 'Completed output' };
        yield { type: 'finish' };
      }),
    };
    const adapter = new OllamaAdapter('http://ollama.test', {
      llm: llm as any,
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      provider: 'ollama',
      threadId: 'thread-absent',
      modelId: 'model-a',
    });
    await adapter.sendTurn({ threadId: 'thread-absent', input: 'hi' });

    let completed: any;
    for (let index = 0; index < 8; index += 1) {
      const next = await iterator.next();
      if (next.value?.method === 'turn.completed') {
        completed = next.value;
        break;
      }
    }
    expect(completed).toBeDefined();
    expect(completed.finishReason).toBe('stop');
  });

  // station#3587 review MEDIUM-2: `normalizeOllamaFinishReason`'s whole
  // purpose is narrowing an unrecognized string to `undefined` rather than
  // guessing a vocabulary member — nothing exercised its `default` arm.
  // Reachable in production: `LLMStreamChunk.finishReason` is a bare
  // `string | undefined` and `llm` is constructor-injected, so a future
  // ai-sdk value `mapAiSdkFinishReason` doesn't yet recognize (or a
  // hand-injected `llm` dependency, mirroring `bedrock-adapter.test.ts`'s
  // own boundary-guard tests) can supply any string. Without the narrowing,
  // an unrecognized value would publish outside station's canonical
  // `finishReason` union — e.g. `'content-filter'` reaching
  // `runtime-auth-health-monitor.ts` and throwing
  // `RuntimeAuthHealthEventDiagnostic` on every such turn, the exact
  // malformed-diagnostic harm station#3587 exists to stop causing for
  // WELL-FORMED input.
  test('a finish chunk with an unrecognized finishReason string publishes "stop", not the unrecognized value', async () => {
    const llm = {
      listModelCatalog: vi.fn(async () => ({
        source: 'live',
        models: [{ id: 'model-a', name: 'Model A' }],
      })),
      createStream: vi.fn(async function* () {
        yield { type: 'text-delta', content: 'Completed output' };
        yield { type: 'finish', finishReason: 'weird-value' };
      }),
    };
    const adapter = new OllamaAdapter('http://ollama.test', {
      llm: llm as any,
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      provider: 'ollama',
      threadId: 'thread-unrecognized',
      modelId: 'model-a',
    });
    await adapter.sendTurn({ threadId: 'thread-unrecognized', input: 'hi' });

    let completed: any;
    for (let index = 0; index < 8; index += 1) {
      const next = await iterator.next();
      if (next.value?.method === 'turn.completed') {
        completed = next.value;
        break;
      }
    }
    expect(completed).toBeDefined();
    expect(completed.finishReason).toBe('stop');
  });
});
