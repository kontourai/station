import { describe, expect, test, vi } from 'vitest';
import { expectCanonicalSessionLifecycle } from '../../__tests__/adapter-contract-test-utils.js';
import { BedrockAdapter } from '../../adapters/bedrock-adapter.js';
import { checkBedrockCredentials } from '../bedrock.js';

vi.mock('../bedrock.js', () => ({
  checkBedrockCredentials: vi.fn(),
}));

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

describe('BedrockAdapter', () => {
  test('starts sessions, sends turns, and emits canonical runtime events', async () => {
    const resolveModelId = vi.fn(
      async (modelId: string) => `resolved:${modelId}`,
    );
    const adapter = new BedrockAdapter(
      {
        sendTurn: async () => ({
          outputText: 'Completed output',
        }),
      },
      { modelCatalog: { resolveModelId } },
    );
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    const session = await adapter.startSession({
      provider: 'bedrock',
      threadId: 'thread-1',
      cwd: '/tmp/project',
      modelId: 'anthropic.claude',
    });
    const turn = await adapter.sendTurn({
      threadId: session.threadId,
      input: 'Inspect the repo',
    });

    expect(turn.threadId).toBe('thread-1');
    expect(resolveModelId).toHaveBeenCalledWith('anthropic.claude');
    expect(await adapter.hasSession('thread-1')).toBe(true);

    const events = [];
    for (let index = 0; index < 6; index += 1) {
      events.push((await iterator.next()).value);
    }
    const methods = events.map((event) => event.method);

    expectCanonicalSessionLifecycle(methods);
    expect(methods).toEqual([
      'session.started',
      'session.configured',
      'session.state-changed',
      'turn.started',
      'content.text-delta',
      'turn.completed',
    ]);
    expect(events[1]).toMatchObject({
      method: 'session.configured',
      model: 'resolved:anthropic.claude',
    });
  });

  test('resolves approval requests and tears down sessions', async () => {
    const adapter = new BedrockAdapter(
      {},
      { modelCatalog: { resolveModelId: async (modelId) => modelId } },
    );
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      provider: 'bedrock',
      threadId: 'thread-2',
      modelId: 'anthropic.claude',
    });
    await iterator.next();
    await iterator.next();

    await adapter.respondToRequest('thread-2', 'req-1', 'accept');
    await adapter.stopSession('thread-2');

    const requestResolved = await iterator.next();
    const sessionExited = await iterator.next();

    expect(requestResolved.value).toMatchObject({
      method: 'request.resolved',
      requestId: 'req-1',
      status: 'approved',
    });
    expect(sessionExited.value).toMatchObject({
      method: 'session.exited',
      sessionId: 'thread-2',
    });
    expect(await adapter.hasSession('thread-2')).toBe(false);
  });

  test('rejects sendTurn for an unknown session', async () => {
    const adapter = new BedrockAdapter();

    await expect(
      adapter.sendTurn({
        threadId: 'missing-thread',
        input: 'Inspect the repo',
      }),
    ).rejects.toThrow(/missing session/i);
  });

  test('does not invent a default Bedrock selector for a model-less session', async () => {
    const adapter = new BedrockAdapter();
    await expect(
      adapter.startSession({
        provider: 'bedrock',
        threadId: 'model-less',
      }),
    ).rejects.toThrow('evidence-backed model selector');
    await expect(adapter.hasSession('model-less')).resolves.toBe(false);
  });

  test('uses the configured catalog selector with the configured LLM', async () => {
    const resolveModelId = vi
      .fn()
      .mockResolvedValue('eu.anthropic.claude-profile');
    // archive#3545 review round 2: `AiSdkLLMProvider.createStream` (which
    // `BedrockLLMProvider` inherits unmodified) now awaits ai-sdk's own
    // `result.finishReason` and maps it onto station's vocabulary — so
    // `{ type: 'finish', finishReason: 'stop' }` IS the faithful shape for an
    // ordinary successful turn again (see ai-sdk-llm-provider.test.ts's
    // "a natural stop propagates as 'stop'"). A bare `{ type: 'finish' }`
    // with no key is now the EDGE case (the producer's own finishReason
    // promise rejected or resolved a non-string) — see the test just below.
    const createStream = vi.fn(async function* () {
      yield { type: 'text-delta' as const, content: 'Completed output' };
      yield { type: 'finish' as const, finishReason: 'stop' as const };
    });
    const adapter = new BedrockAdapter(
      {},
      {
        modelCatalog: { resolveModelId },
        llm: { createStream } as any,
      },
    );
    await adapter.startSession({
      provider: 'bedrock',
      threadId: 'configured-bedrock',
      modelId: 'anthropic.claude',
    });

    await adapter.sendTurn({
      threadId: 'configured-bedrock',
      input: 'Inspect the repository',
    });

    expect(resolveModelId).toHaveBeenCalledWith('anthropic.claude');
    expect(createStream).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'eu.anthropic.claude-profile' }),
    );
    await expect(adapter.listSessions()).resolves.toEqual([
      expect.objectContaining({
        threadId: 'configured-bedrock',
        model: 'eu.anthropic.claude-profile',
        status: 'ready',
      }),
    ]);
  });

  // archive#3545 review round 2: this used to be titled "the real producer
  // shape" — it is now the FALLBACK case instead: a bare `{ type: 'finish' }`
  // with no `finishReason` key is what `AiSdkLLMProvider.createStream`
  // yields only when ai-sdk's own `finishReason` promise rejects or resolves
  // something that isn't a string (see ai-sdk-llm-provider.test.ts's
  // rejection test). `normalizeFinishReason` still preserves that absence as
  // `undefined` rather than guessing a vocabulary member, and `sendTurn`'s
  // `finishReason ?? 'stop'` still assumes success because the stream loop
  // completed without throwing or being aborted.
  test('station#3545: a finish chunk with no finishReason key (the producer-could-not-determine-one fallback) publishes turn.completed with finishReason "stop"', async () => {
    const createStream = vi.fn(async function* () {
      yield { type: 'text-delta' as const, content: 'Completed output' };
      yield { type: 'finish' as const };
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
      threadId: 'real-finish-shape',
      modelId: 'anthropic.claude',
    });
    await adapter.sendTurn({
      threadId: 'real-finish-shape',
      input: 'Inspect the repository',
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
    expect(completed.finishReason).toBe('stop');
  });

  // archive#3545 review round 2 HIGH: the producer tests prove
  // `AiSdkLLMProvider.createStream` EMITS a mapped `finishReason`; the fleet
  // test proves `FleetInferenceService` READS it. Nothing proved the
  // consumer this issue is actually about — `BedrockAdapter.sendTurn` — PASSES
  // IT THROUGH. It didn't: `normalizeFinishReason(chunk.finishReason)` could
  // be silently changed to `normalizeFinishReason(undefined)` and every
  // Bedrock test in the repo stayed green. These two tests close that gap
  // directly: a recognized vocabulary member the producer supplies must
  // survive unchanged onto the published `turn.completed`.
  test('station#3545 review round 2: a producer-supplied "max-tokens" finishReason is published unchanged, not overwritten with "stop"', async () => {
    const createStream = vi.fn(async function* () {
      yield { type: 'text-delta' as const, content: 'Truncated output' };
      yield { type: 'finish' as const, finishReason: 'max-tokens' as const };
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
      threadId: 'truncated-finish-shape',
      modelId: 'anthropic.claude',
    });
    await adapter.sendTurn({
      threadId: 'truncated-finish-shape',
      input: 'Inspect the repository',
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
    expect(completed.finishReason).toBe('max-tokens');
  });

  test('station#3545 review round 2: a producer-supplied "stop" finishReason is published unchanged', async () => {
    const createStream = vi.fn(async function* () {
      yield { type: 'text-delta' as const, content: 'Completed output' };
      yield { type: 'finish' as const, finishReason: 'stop' as const };
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
      threadId: 'stop-finish-shape',
      modelId: 'anthropic.claude',
    });
    await adapter.sendTurn({
      threadId: 'stop-finish-shape',
      input: 'Inspect the repository',
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
    expect(completed.finishReason).toBe('stop');
  });

  test('station#1182: a finish chunk carrying reportedModel (e.g. if ai-sdk ever wired one up) is NOT surfaced on turn.completed — Bedrock has no genuine runtime-confirmed signal, only its own request echoed back', async () => {
    const resolveModelId = vi
      .fn()
      .mockResolvedValue('eu.anthropic.claude-profile');
    const createStream = vi.fn(async function* () {
      yield { type: 'text-delta' as const, content: 'Completed output' };
      // Even if this were populated (it isn't today — see
      // bedrock-adapter.ts's doc comment and @ai-sdk/amazon-bedrock's
      // `doStream`, which sets `response.modelId` to the REQUEST's own
      // model id), the adapter must not treat it as observed. `finishReason`
      // is orthogonal to this test's claim (`reportedModel` suppression), so
      // it carries the ordinary `'stop'` shape (archive#3545 review round 2:
      // `reportedModel` present with no `finishReason` at all would be an
      // unusual combination — ai-sdk's `response` and `finishReason`
      // promises resolving/rejecting independently — not the norm this
      // fixture should imply).
      yield {
        type: 'finish' as const,
        finishReason: 'stop' as const,
        reportedModel: 'eu.anthropic.claude-profile',
      };
    });
    const adapter = new BedrockAdapter(
      {},
      {
        modelCatalog: { resolveModelId },
        llm: { createStream } as any,
      },
    );
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      provider: 'bedrock',
      threadId: 'no-reported-model',
      modelId: 'anthropic.claude',
    });
    await adapter.sendTurn({
      threadId: 'no-reported-model',
      input: 'Inspect the repository',
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
    expect(completed.metadata).toBeUndefined();
  });

  test('surfaces Bedrock credential prerequisites for runtime readiness', async () => {
    vi.mocked(checkBedrockCredentials).mockResolvedValue(false);
    const adapter = new BedrockAdapter();

    expect(adapter.metadata).toMatchObject({
      displayName: 'Amazon Bedrock',
      runtimeId: 'bedrock-runtime',
    });

    await expect(adapter.getPrerequisites?.()).resolves.toEqual([
      expect.objectContaining({
        id: 'bedrock-credentials',
        name: 'Bedrock Credentials',
        status: 'missing',
        category: 'required',
      }),
    ]);
  });

  test('preserves Bedrock catalog truncation metadata', async () => {
    const adapter = new BedrockAdapter(
      {},
      {
        llm: {
          listModelCatalog: vi.fn().mockResolvedValue({
            source: 'live',
            models: [{ id: 'profile-a', name: 'Profile A' }],
            truncated: true,
          }),
        } as any,
      },
    );

    await expect(
      adapter.listModelCatalog?.({ maxEntries: 1 }),
    ).resolves.toEqual({
      models: [{ id: 'profile-a', name: 'Profile A', originalId: 'profile-a' }],
      truncated: true,
    });
  });

  test('does not project an unavailable Bedrock catalog as fresh and empty', async () => {
    const adapter = new BedrockAdapter(
      {},
      {
        llm: {
          listModelCatalog: vi.fn().mockResolvedValue({
            source: 'unavailable',
            models: [],
          }),
        } as any,
      },
    );

    await expect(adapter.listModelCatalog?.()).rejects.toThrow(
      'Bedrock model catalog is unavailable',
    );
  });

  test('aborts active Bedrock provider work on interrupt and stop', async () => {
    const signals: AbortSignal[] = [];
    const createStream = vi.fn(async function* (options: {
      signal?: AbortSignal;
    }) {
      if (options.signal) signals.push(options.signal);
      await new Promise<never>((_, reject) => {
        options.signal?.addEventListener(
          'abort',
          () => reject(options.signal?.reason),
          { once: true },
        );
      });
    });
    const adapter = new BedrockAdapter(
      {},
      {
        modelCatalog: { resolveModelId: async (modelId) => modelId },
        llm: { createStream } as any,
      },
    );
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
    for (const [index, threadId] of ['interrupt-turn', 'stop-turn'].entries()) {
      await adapter.startSession({
        provider: 'bedrock',
        threadId,
        modelId: 'model-a',
      });
      const pending = adapter.sendTurn({ threadId, input: 'Run' });
      await vi.waitFor(() => expect(signals).toHaveLength(index + 1));
      if (threadId === 'interrupt-turn') {
        await adapter.interruptTurn(threadId);
        await expect(pending).rejects.toThrow('Turn interrupted');
      } else {
        await adapter.stopSession(threadId);
        await expect(pending).rejects.toThrow('Session stopped');
      }
    }

    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    const events = [];
    for (let index = 0; index < 10; index += 1) {
      events.push((await iterator.next()).value);
    }
    // archive#3466 site pins: `interruptTurn` (`activeTurns.delete` then
    // `.abort()`) and `stopSession` (`.abort()` then `activeTurns.delete`)
    // both mutate `activeTurns` synchronously, in the same tick as the
    // abort that races this stream's rejection. If a future reorder ever
    // let that rejection win the race, the catch handler's `isCurrentTurn`
    // check would read true again and publish an extra `turn.completed`
    // (cancelled) or `runtime.error` alongside — these counts catch that.
    const interruptTerminals = events.filter(
      (event) =>
        event?.threadId === 'interrupt-turn' &&
        (event.method === 'turn.aborted' ||
          event.method === 'turn.completed' ||
          event.method === 'runtime.error'),
    );
    expect(interruptTerminals).toHaveLength(1);
    // stopSession, unlike interruptTurn, publishes no explicit turn-level
    // event at all -- so the discriminating count for this site is ZERO,
    // not one: any turn.completed/turn.aborted/runtime.error here can only
    // come from the catch handler's now-deleted `if (controller.signal.
    // aborted)` arm (or its sibling publishTurnFailure) wrongly firing.
    const stopTerminals = events.filter(
      (event) =>
        event?.threadId === 'stop-turn' &&
        (event.method === 'turn.aborted' ||
          event.method === 'turn.completed' ||
          event.method === 'runtime.error'),
    );
    expect(stopTerminals).toHaveLength(0);
  });

  // archive#3442 review finding, re-verified against this tree: the
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
  // the "mirror image of archive#3442" regression risk (a user Stop wrongly
  // recording the session `failed`), is the adapter's real observable
  // contract: interrupting a turn publishes exactly one terminal-shaped
  // event (`turn.aborted`) and NEVER a `runtime.error`. That is what this
  // test pins.
  test('station#3442: interrupting a turn publishes turn.aborted and never leaks a runtime.error (or a turn.completed)', async () => {
    let streamSignal: AbortSignal | undefined;
    const createStream = vi.fn(async function* (options: {
      signal?: AbortSignal;
    }) {
      streamSignal = options.signal;
      await new Promise<never>((_, reject) => {
        options.signal?.addEventListener(
          'abort',
          () => reject(options.signal?.reason),
          { once: true },
        );
      });
    });
    const adapter = new BedrockAdapter(
      {},
      {
        modelCatalog: { resolveModelId: async (modelId) => modelId },
        llm: { createStream } as any,
      },
    );
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
    await adapter.startSession({
      provider: 'bedrock',
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

  // archive#3466: the third abort site. `sendTurn`'s supersede branch calls
  // `superseded.controller.abort(...)` and THEN, still synchronously (no
  // await between), overwrites `activeTurns` with the new turn — the same
  // same-tick shape `interruptTurn`/`stopSession` have (proven above via the
  // "aborts active... interrupt and stop" counts) applied to the third site.
  // This races the superseded turn's own stream rejection against that
  // overwrite as tightly as a mock can arrange (an abort-event listener
  // attached before the supersede fires), the same way the interrupt/stop
  // tests race theirs. If a future reorder ever separated the abort from the
  // overwrite with an await, the superseded turn's rejection could win the
  // race and the catch handler's (now-deleted) `if (controller.signal.
  // aborted)` arm would publish a duplicate `turn.completed`.
  test('station#3466: superseding a turn races the abort against the activeTurns overwrite — no duplicate terminal event for the superseded turn', async () => {
    const signals: AbortSignal[] = [];
    const createStream = vi.fn(async function* (options: {
      signal?: AbortSignal;
    }) {
      if (options.signal) signals.push(options.signal);
      await new Promise<never>((_, reject) => {
        options.signal?.addEventListener(
          'abort',
          () => reject(options.signal?.reason),
          { once: true },
        );
      });
    });
    const adapter = new BedrockAdapter(
      {},
      {
        modelCatalog: { resolveModelId: async (modelId) => modelId },
        llm: { createStream } as any,
      },
    );
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
    await adapter.startSession({
      provider: 'bedrock',
      threadId: 'supersede-race',
      modelId: 'model-a',
    });

    const first = adapter.sendTurn({
      threadId: 'supersede-race',
      input: 'first',
    });
    const firstFailure = expect(first).rejects.toThrow('Superseded');
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    const second = adapter.sendTurn({
      threadId: 'supersede-race',
      input: 'second',
    });
    await firstFailure;
    // Let second's own stream actually attach before tearing it down --
    // otherwise stopSession's abort() below could fire before createStream
    // registers its listener and this mock's promise would hang forever.
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    await adapter.stopSession('supersede-race');
    await second.catch(() => undefined);

    const events: any[] = await drainEvents(iterator);
    const firstTurnId = events.find(
      (event: any) => event?.method === 'turn.started',
    )?.turnId;
    expect(firstTurnId).toBeDefined();
    expect(
      events.filter(
        (event: any) =>
          event?.turnId === firstTurnId &&
          (event.method === 'turn.completed' ||
            event.method === 'runtime.error'),
      ),
    ).toEqual([]);
    expect(
      events.filter(
        (event: any) =>
          event?.turnId === firstTurnId && event.method === 'turn.aborted',
      ),
    ).toEqual([expect.objectContaining({ reason: 'superseded' })]);
  });

  test('keeps a newer turn active when a superseded callback settles', async () => {
    const resolvers: Array<(value: { outputText: string }) => void> = [];
    const adapter = new BedrockAdapter(
      {
        sendTurn: vi.fn(
          () =>
            new Promise<{ outputText: string }>((resolve) => {
              resolvers.push(resolve);
            }),
        ),
      },
      { modelCatalog: { resolveModelId: async (modelId) => modelId } },
    );
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
    await adapter.startSession({
      provider: 'bedrock',
      threadId: 'overlap',
      modelId: 'model-a',
    });

    const first = adapter.sendTurn({ threadId: 'overlap', input: 'first' });
    const firstFailure = expect(first).rejects.toThrow('Superseded');
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    const second = adapter.sendTurn({ threadId: 'overlap', input: 'second' });
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
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

    resolvers[0]!({ outputText: 'stale' });
    await firstFailure;
    expect((await adapter.listSessions())[0]?.status).toBe('running');
    await expect(adapter.interruptTurn('overlap', turnIds[0])).resolves.toEqual(
      expect.objectContaining({
        outcome: 'target-mismatch',
        activeTurnId: turnIds[1],
      }),
    );

    resolvers[1]!({ outputText: 'current' });
    await expect(second).resolves.toMatchObject({ threadId: 'overlap' });
    expect((await adapter.listSessions())[0]?.status).toBe('ready');
  });
});
