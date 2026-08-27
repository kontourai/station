import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { describe, expect, test, vi } from 'vitest';
import { BedrockAdapter } from '../adapters/bedrock-adapter.js';

vi.mock('../../telemetry/metrics.js', () => ({
  adapterSessionStartDuration: { record: vi.fn() },
  providerOps: { add: vi.fn() },
}));

async function collect(
  iterator: AsyncIterator<CanonicalRuntimeEvent>,
  count: number,
) {
  const events: CanonicalRuntimeEvent[] = [];
  for (let index = 0; index < count; index++) {
    const next = await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timed out')), 1_000),
      ),
    ]);
    if (!next.done) events.push(next.value);
  }
  return events;
}

// #903: `session.configured` is the only event that carries a model into the
// read model and the persisted session row, and Bedrock published it just once
// at session start — so a per-turn model change lived in adapter memory alone
// and a rehydrated session reported the model it started with.
describe('BedrockAdapter turn-time model restatement (#903)', () => {
  const modelCatalog = { resolveModelId: async (id: string) => id };

  test('restates session.configured when a turn changes the model, carrying cwd', async () => {
    const adapter = new BedrockAdapter({}, { modelCatalog });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      provider: 'bedrock',
      threadId: 'thread-restate',
      modelId: 'model-a',
      cwd: '/work/station',
    });
    // The turn's streaming needs a configured Bedrock runtime, which this
    // test deliberately does not supply — the restatement is published before
    // that, so the failure downstream is irrelevant here.
    await adapter
      .sendTurn({
        threadId: 'thread-restate',
        input: 'use the other model',
        modelId: 'model-b',
        metadata: {
          modelLaunchPlan: {
            kind: 'station-resolved',
            modelConnectionId: 'bedrock-runtime',
            modelId: 'model-b',
            evidence: 'catalog-pending',
          },
        },
      })
      .catch(() => undefined);

    const events = await collect(iterator, 3);
    const configured = events.filter(
      (event) => event.method === 'session.configured',
    ) as Array<CanonicalRuntimeEvent & { model?: string; cwd?: string }>;

    expect(configured).toHaveLength(2);
    expect(configured[0].model).toBe('model-a');
    expect(configured[1].model).toBe('model-b');
    // `buildAgentRunSummary` reads cwd off the LATEST session.configured with
    // no fallback, so the restatement has to carry it forward.
    expect(configured[1].cwd).toBe('/work/station');
    expect((configured[0] as any).metadata?.modelSelectionReceipt).toEqual({
      requestedModel: 'model-a',
      appliedModel: 'model-a',
    });
    expect((configured[1] as any).metadata?.modelSelectionReceipt).toEqual({
      requestedModel: 'model-b',
      appliedModel: 'model-b',
    });
    expect((configured[1] as any).metadata?.modelLaunchPlan).toEqual({
      kind: 'station-resolved',
      modelConnectionId: 'bedrock-runtime',
      modelId: 'model-b',
      evidence: 'catalog-accepted',
    });
  });

  test('does not restate when the turn keeps the session model', async () => {
    const adapter = new BedrockAdapter({}, { modelCatalog });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      provider: 'bedrock',
      threadId: 'thread-same',
      modelId: 'model-a',
      cwd: '/work/station',
    });
    await adapter
      .sendTurn({
        threadId: 'thread-same',
        input: 'same model',
        modelId: 'model-a',
      })
      .catch(() => undefined);

    const events = await collect(iterator, 3);
    expect(
      events.filter((event) => event.method === 'session.configured'),
    ).toHaveLength(1);
  });
});

// station#3442: a genuine stream failure (not a user cancellation) must
// publish `runtime.error`, the one canonical event the session-lifecycle
// projector folds to 'failed' — a `turn.completed` here (this branch's prior,
// unconditional behavior) is indistinguishable from an ordinary empty
// completion and silently folds the session to 'completed'.
describe('BedrockAdapter turn failure signalling (#3442)', () => {
  const modelCatalog = { resolveModelId: async (id: string) => id };

  test('a genuine stream failure publishes runtime.error, not turn.completed', async () => {
    const llm = {
      createStream: async function* () {
        yield { type: 'text-delta' as const, content: 'partial' };
        throw new Error('Bedrock stream failed');
      },
    };
    const adapter = new BedrockAdapter({}, { modelCatalog, llm: llm as any });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      provider: 'bedrock',
      threadId: 'thread-stream-failure',
      modelId: 'model-a',
    });

    await expect(
      adapter.sendTurn({ threadId: 'thread-stream-failure', input: 'hi' }),
    ).rejects.toThrow('Bedrock stream failed');

    const events: CanonicalRuntimeEvent[] = [];
    let terminal: CanonicalRuntimeEvent | undefined;
    for (let index = 0; index < 10 && !terminal; index += 1) {
      const next = await Promise.race([
        iterator.next(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timed out')), 1_000),
        ),
      ]);
      if (next.done) break;
      events.push(next.value);
      if (
        next.value.method === 'turn.completed' ||
        next.value.method === 'runtime.error'
      ) {
        terminal = next.value;
      }
    }
    expect(
      events.filter(
        (event) =>
          event.method === 'turn.completed' || event.method === 'runtime.error',
      ),
    ).toHaveLength(1);
    expect(terminal).toMatchObject({
      method: 'runtime.error',
      severity: 'error',
      message: 'Bedrock stream failed',
    });
  });
});
